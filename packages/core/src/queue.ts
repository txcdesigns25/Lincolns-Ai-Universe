import type { Db, Queryable } from "./db.js";
import { withTx } from "./db.js";
import { audit } from "./audit.js";

export interface EnqueueOptions {
  agentId: string;
  type: string;
  title: string;
  payload?: Record<string, unknown>;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
  parentTaskId?: string;
  createdBy?: string;
}

export interface TaskRow {
  id: string; agent_id: string; type: string; title: string; payload: any; status: string;
  priority: number; attempts: number; max_attempts: number; idempotency_key: string | null;
  created_by: string; parent_task_id: string | null; result: any; last_error: string | null;
}

/** Enqueue a task. Duplicate idempotency keys return the existing task (no duplicate work). */
export async function enqueue(q: Queryable, o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  const res = await q.query(
    `INSERT INTO tasks (agent_id, type, title, payload, priority, run_at, max_attempts, idempotency_key, parent_task_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [o.agentId, o.type, o.title, JSON.stringify(o.payload ?? {}), o.priority ?? 5, o.runAt ?? new Date(),
     o.maxAttempts ?? 3, o.idempotencyKey ?? null, o.parentTaskId ?? null, o.createdBy ?? "system"],
  );
  if (res.rows[0]) return { id: res.rows[0].id, created: true };
  const ex = await q.query(`SELECT id FROM tasks WHERE idempotency_key = $1`, [o.idempotencyKey]);
  return { id: ex.rows[0].id, created: false };
}

/**
 * Atomically claim the next runnable task with a lease. Uses
 * FOR UPDATE SKIP LOCKED so any number of workers can poll safely.
 * Tasks for paused agents are skipped (they stay queued until resumed).
 */
export async function claimNext(db: Db, workerId: string, leaseSeconds = 300): Promise<TaskRow | null> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.id FROM tasks t JOIN agents a ON a.id = t.agent_id
        WHERE t.status = 'queued' AND t.run_at <= now() AND a.status = 'active'
        ORDER BY t.priority ASC, t.run_at ASC
        LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    );
    if (!rows[0]) return null;
    const upd = await tx.query(
      `UPDATE tasks SET status = 'running', attempts = attempts + 1, locked_by = $2,
              locked_until = now() + ($3 || ' seconds')::interval, started_at = COALESCE(started_at, now())
        WHERE id = $1 RETURNING *`,
      [rows[0].id, workerId, String(leaseSeconds)],
    );
    await tx.query(`UPDATE agents SET current_task_id = $2, last_heartbeat = now() WHERE id = $1`, [upd.rows[0].agent_id, rows[0].id]);
    return upd.rows[0] as TaskRow;
  });
}

export async function completeTask(db: Db, taskId: string, workerId: string, result: unknown) {
  await withTx(db, async (tx) => {
    const r = await tx.query(
      `UPDATE tasks SET status = 'succeeded', result = $3, finished_at = now(), locked_by = NULL, locked_until = NULL
        WHERE id = $1 AND locked_by = $2 RETURNING agent_id`, [taskId, workerId, JSON.stringify(result ?? {})]);
    if (r.rows[0]) await tx.query(`UPDATE agents SET current_task_id = NULL WHERE id = $1 AND current_task_id = $2`, [r.rows[0].agent_id, taskId]);
  });
}

export async function parkForApproval(db: Db, taskId: string, workerId: string, approvalId: string) {
  await db.query(
    `UPDATE tasks SET status = 'waiting_approval', locked_by = NULL, locked_until = NULL,
            result = jsonb_build_object('waiting_on_approval', $3::text)
      WHERE id = $1 AND locked_by = $2`, [taskId, workerId, approvalId]);
}

/**
 * Record a failure. Retryable errors go back to the queue with exponential
 * backoff until max_attempts, then to 'dead' (dead-letter) for a human.
 */
export async function failTask(db: Db, taskId: string, workerId: string, error: string, opts: { retryable: boolean; retryAfterMs?: number }) {
  await withTx(db, async (tx) => {
    const t = (await tx.query(`SELECT * FROM tasks WHERE id = $1 AND locked_by = $2 FOR UPDATE`, [taskId, workerId])).rows[0];
    if (!t) return;
    const canRetry = opts.retryable && t.attempts < t.max_attempts;
    const backoffMs = opts.retryAfterMs ?? Math.min(60_000 * 2 ** (t.attempts - 1), 60 * 60_000);
    await tx.query(
      `UPDATE tasks SET status = $2, last_error = $3, locked_by = NULL, locked_until = NULL,
              run_at = CASE WHEN $2 = 'queued' THEN now() + ($4 || ' milliseconds')::interval ELSE run_at END,
              finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END
        WHERE id = $1`,
      [taskId, canRetry ? "queued" : opts.retryable ? "dead" : "failed", error.slice(0, 4000), String(backoffMs)],
    );
    await tx.query(`UPDATE agents SET current_task_id = NULL WHERE id = $1 AND current_task_id = $2`, [t.agent_id, taskId]);
    await audit(tx, { actor: workerId, agentId: t.agent_id, action: "task.fail", outcome: "error",
      details: { error: error.slice(0, 500), attempt: t.attempts, willRetry: canRetry }, taskId });
  });
}

/** Return tasks whose worker died (lease expired) to the queue. */
export async function recoverExpiredLeases(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE tasks SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            locked_by = NULL, locked_until = NULL,
            last_error = COALESCE(last_error, '') || ' [lease expired: worker crashed or hung]'
      WHERE status = 'running' AND locked_until < now() RETURNING id`);
  return r.rowCount ?? 0;
}

export async function extendLease(db: Db, taskId: string, workerId: string, leaseSeconds = 300) {
  await db.query(`UPDATE tasks SET locked_until = now() + ($3 || ' seconds')::interval WHERE id = $1 AND locked_by = $2`,
    [taskId, workerId, String(leaseSeconds)]);
}

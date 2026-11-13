import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { enqueue } from "./queue.js";

/**
 * Turn due schedules into tasks. Each firing is keyed by schedule + time slot,
 * so overlapping workers or restarts cannot enqueue the same run twice.
 * If the machine was off, a schedule fires ONCE on wake-up (missed slots are
 * not replayed) and its next run is computed from now.
 */
export async function tickScheduler(db: Db): Promise<number> {
  return withTx(db, async (tx) => {
    const due = (await tx.query(
      `SELECT s.* FROM schedules s JOIN agents a ON a.id = s.agent_id
        WHERE s.enabled AND s.next_run_at <= now() AND a.status = 'active'
        FOR UPDATE OF s SKIP LOCKED`)).rows;
    for (const s of due) {
      const slot = new Date(s.next_run_at).toISOString();
      await enqueue(tx, { agentId: s.agent_id, type: s.task_type, title: s.title, payload: s.payload,
        priority: s.task_type === "health_check" ? 1 : 6, idempotencyKey: `sched:${s.id}:${slot}`, createdBy: "scheduler" });
      await tx.query(`UPDATE schedules SET last_enqueued_at = now(),
                        next_run_at = GREATEST(next_run_at + (interval_minutes || ' minutes')::interval, now() + interval '1 minute')
                      WHERE id = $1`, [s.id]);
    }
    return due.length;
  });
}

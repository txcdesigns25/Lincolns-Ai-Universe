import type { Queryable } from "./db.js";

export type AuditOutcome = "allowed" | "denied" | "error" | "info";

export async function audit(
  q: Queryable,
  e: { actor: string; agentId?: string | null; action: string; outcome: AuditOutcome; details?: unknown; taskId?: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (actor, agent_id, action, outcome, details, task_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.actor, e.agentId ?? null, e.action, e.outcome, JSON.stringify(e.details ?? {}), e.taskId ?? null],
  );
}

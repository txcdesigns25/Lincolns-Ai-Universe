import type { Db, Queryable } from "./db.js";
import { withTx } from "./db.js";
import { audit } from "./audit.js";
import { PolicyDenied } from "./errors.js";
import { getAction } from "./policy.js";
import { assertAgentMayAct } from "./controls.js";
import { enqueue } from "./queue.js";

export interface ApprovalRequest {
  agentId: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  amountCents?: number;
  taskId?: string;
  idempotencyKey?: string;
}

export async function requestApproval(q: Queryable, req: ApprovalRequest): Promise<{ id: string; created: boolean }> {
  const spec = getAction(req.action);
  const level = spec.level === 1 ? 2 : spec.level;
  const ins = await q.query(
    `INSERT INTO approvals (agent_id, task_id, action, level, summary, details, amount_cents, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [req.agentId, req.taskId ?? null, req.action, level, req.summary, JSON.stringify(req.details ?? {}),
     req.amountCents ?? null, req.idempotencyKey ?? null],
  );
  if (ins.rows[0]) {
    await audit(q, { actor: req.agentId, agentId: req.agentId, action: "approval.request", outcome: "info",
      details: { action: req.action, summary: req.summary, id: ins.rows[0].id }, taskId: req.taskId });
    return { id: ins.rows[0].id, created: true };
  }
  const existing = await q.query(`SELECT id FROM approvals WHERE idempotency_key = $1`, [req.idempotencyKey]);
  return { id: existing.rows[0].id, created: false };
}

/** Only the human owner may decide. Agents (including the CEO) never reach this. */
export async function decideApproval(db: Db, id: string, decision: "approved" | "rejected", by: string, note?: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can decide approvals");
  return withTx(db, async (tx) => {
    const a = (await tx.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a) throw new Error("Approval not found");
    if (a.status !== "pending") throw new PolicyDenied("not_pending", `Approval is already ${a.status}`);
    if (new Date(a.expires_at) < new Date()) {
      await tx.query(`UPDATE approvals SET status = 'expired' WHERE id = $1`, [id]);
      throw new PolicyDenied("expired", "Approval expired");
    }
    await tx.query(`UPDATE approvals SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1`,
      [id, decision, by, note ?? null]);
    if (a.details?.draft_id) {
      await tx.query(`UPDATE drafts SET status = $2, updated_at = now() WHERE id = $1`,
        [a.details.draft_id, decision === "approved" ? "approved" : "rejected"]);
    }
    // Approved actions are executed by deterministic code, never by the LLM.
    if (decision === "approved") {
      await enqueue(tx, { agentId: a.agent_id, type: "execute_action", title: `Execute approved: ${a.summary}`.slice(0, 200),
        payload: { action: a.action, approval_id: id, draft_id: a.details?.draft_id ?? null }, priority: 2,
        idempotencyKey: `execute:${id}`, createdBy: "owner" });
    }
    // Resume a task that was parked waiting on this decision.
    if (a.task_id) {
      await tx.query(`UPDATE tasks SET status = 'queued', run_at = now() WHERE id = $1 AND status = 'waiting_approval'`, [a.task_id]);
    }
    await audit(tx, { actor: by, agentId: a.agent_id, action: `approval.${decision}`, outcome: "info",
      details: { id, action: a.action, note }, taskId: a.task_id });
    return { ...a, status: decision };
  });
}

/**
 * The gate for executing any classified action.
 *  - L1: allowed if the agent may act.
 *  - L2: allowed only with a standing preauthorization row.
 *  - L3: allowed only with an approved, unexecuted approval for this exact action;
 *        the approval is consumed (marked executed) atomically.
 * External actions additionally require the agent to be in live mode.
 */
export async function authorizeAction(db: Db, p: { agentId: string; action: string; approvalId?: string; taskId?: string; sandbox?: boolean }) {
  const spec = getAction(p.action);
  return withTx(db, async (tx) => {
    try {
      // sandbox=true means the caller will only use a simulated adapter, so live mode is not required.
      await assertAgentMayAct(tx, p.agentId, { external: spec.external && !p.sandbox });
      // Level 2 runs if the owner pre-authorized the action for this agent, OR
      // approved this specific request (a one-off approval is at least as strong).
      let needsApproval = spec.level === 3;
      if (spec.level === 2) {
        const perm = await tx.query(`SELECT 1 FROM agent_permissions WHERE agent_id = $1 AND action = $2`, [p.agentId, p.action]);
        if (!perm.rowCount) {
          if (!p.approvalId) throw new PolicyDenied("not_preauthorized", `${p.action} is not preauthorized for ${p.agentId}`);
          needsApproval = true;
        }
      }
      if (needsApproval) {
        if (!p.approvalId) throw new PolicyDenied("approval_required", `${p.action} requires human approval`);
        const a = (await tx.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [p.approvalId])).rows[0];
        if (!a || a.agent_id !== p.agentId || a.action !== p.action)
          throw new PolicyDenied("approval_mismatch", "Approval does not match this agent/action");
        if (a.status === "executed") throw new PolicyDenied("approval_consumed", "Approval was already used");
        if (a.status !== "approved") throw new PolicyDenied("approval_not_approved", `Approval is ${a.status}`);
        await tx.query(`UPDATE approvals SET status = 'executed', executed_at = now() WHERE id = $1`, [p.approvalId]);
      }
      await audit(tx, { actor: p.agentId, agentId: p.agentId, action: `action.${p.action}`, outcome: "allowed",
        details: { level: spec.level, approvalId: p.approvalId, sandbox: !!p.sandbox }, taskId: p.taskId });
    } catch (err) {
      if (err instanceof PolicyDenied) {
        await audit(db, { actor: p.agentId, agentId: p.agentId, action: `action.${p.action}`, outcome: "denied",
          details: { code: err.code, message: err.message }, taskId: p.taskId });
      }
      throw err;
    }
  });
}

export async function grantPermission(db: Db, agentId: string, action: string, by: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can grant permissions");
  if (getAction(action).level !== 2) throw new PolicyDenied("not_level2", "Only Level 2 actions can be preauthorized");
  await db.query(`INSERT INTO agent_permissions (agent_id, action, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [agentId, action, by]);
  await audit(db, { actor: by, agentId, action: "permission.grant", outcome: "info", details: { action } });
}

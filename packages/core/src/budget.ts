import type { Db, Tx, Queryable } from "./db.js";
import { withTx } from "./db.js";
import { audit } from "./audit.js";
import { PolicyDenied } from "./errors.js";

export type SpendCategory = "ai_api" | "software" | "advertising" | "hosting" | "other";

export interface BudgetLimits {
  starting_budget: number;
  daily_limit: number;
  weekly_limit: number;
  monthly_limit: number;
  per_transaction_limit: number;
  ai_monthly_limit: number;
  ads_monthly_limit: number;
}

const LEDGER_TYPE: Record<SpendCategory, string> = {
  ai_api: "ai_api", software: "software", advertising: "advertising", hosting: "hosting", other: "other_expense",
};

/**
 * Committed spend in a window = settled amounts + still-reserved amounts.
 * Reservations count so concurrent requests cannot jointly exceed a limit.
 */
async function committedSince(q: Queryable, agentId: string, since: string, category?: SpendCategory) {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_cents ELSE amount_cents END), 0) AS total
       FROM spend_authorizations
      WHERE agent_id = $1 AND status IN ('reserved','settled')
        AND created_at >= ${since}
        ${category ? "AND category = $2" : ""}`,
    category ? [agentId, category] : [agentId],
  );
  return Number(rows[0].total);
}

export async function globalMonthSpend(q: Queryable): Promise<number> {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_cents ELSE amount_cents END), 0) AS total
       FROM spend_authorizations WHERE status IN ('reserved','settled') AND created_at >= date_trunc('month', now())`);
  return Number(rows[0].total);
}

/** Owner-only: change the cap across all agents. */
export async function setGlobalMonthlyLimit(db: Db, cents: number, by: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can change the global limit");
  if (!Number.isInteger(cents) || cents < 0) throw new PolicyDenied("invalid_limit", "Limit must be non-negative cents");
  await db.query(`UPDATE system_controls SET global_monthly_limit = $1, updated_at = now() WHERE id`, [cents]);
  await audit(db, { actor: by, action: "budget.global_update", outcome: "info", details: { cents } });
}

export async function getSpendSummary(q: Queryable, agentId: string) {
  const [day, week, month, lifetime, aiMonth, adsMonth] = await Promise.all([
    committedSince(q, agentId, "date_trunc('day', now())"),
    committedSince(q, agentId, "date_trunc('week', now())"),
    committedSince(q, agentId, "date_trunc('month', now())"),
    committedSince(q, agentId, "'-infinity'::timestamptz"),
    committedSince(q, agentId, "date_trunc('month', now())", "ai_api"),
    committedSince(q, agentId, "date_trunc('month', now())", "advertising"),
  ]);
  return { day, week, month, lifetime, aiMonth, adsMonth };
}

export interface AuthorizeRequest {
  agentId: string;
  category: SpendCategory;
  amountCents: number;
  reason: string;
  idempotencyKey?: string;
  taskId?: string;
  approvalId?: string;
}

/**
 * The single gate every outgoing cost passes through. Enforced in the database
 * transaction with a row lock on the agent's budget, never in a prompt.
 * Returns the reservation id. Throws PolicyDenied (and records a 'denied' row).
 */
export async function authorizeSpend(db: Db, req: AuthorizeRequest): Promise<string> {
  if (!Number.isInteger(req.amountCents) || req.amountCents <= 0)
    throw new PolicyDenied("invalid_amount", "Amount must be a positive integer number of cents");

  const outcome = await withTx(db, async (tx) => {
    if (req.idempotencyKey) {
      const existing = await tx.query(
        `SELECT id, status, denial_reason FROM spend_authorizations WHERE idempotency_key = $1`,
        [req.idempotencyKey],
      );
      if (existing.rows[0]) {
        const r = existing.rows[0];
        if (r.status === "denied") return { denied: r.denial_reason as string };
        return { id: r.id as string };
      }
    }

    // Lock the global controls row first (serializes spend across ALL agents so
    // the global cap holds under concurrency), then the agent's budget row.
    const controls = (await tx.query(`SELECT emergency_stop, global_monthly_limit FROM system_controls WHERE id FOR UPDATE`)).rows[0];
    const b = await tx.query(`SELECT * FROM agent_budgets WHERE agent_id = $1 FOR UPDATE`, [req.agentId]);
    const limits = b.rows[0] as BudgetLimits | undefined;

    const deny = async (code: string, msg: string) => {
      await tx.query(
        `INSERT INTO spend_authorizations (agent_id, category, amount_cents, status, reason, denial_reason, idempotency_key, task_id)
         VALUES ($1,$2,$3,'denied',$4,$5,$6,$7)`,
        [req.agentId, req.category, req.amountCents, req.reason, `${code}: ${msg}`, req.idempotencyKey ?? null, req.taskId ?? null],
      );
      await audit(tx, { actor: req.agentId, agentId: req.agentId, action: "spend.authorize", outcome: "denied",
        details: { code, msg, amount: req.amountCents, category: req.category, reason: req.reason }, taskId: req.taskId });
      return { denied: `${code}: ${msg}` };
    };

    if (controls.emergency_stop) return deny("emergency_stop", "Emergency stop is engaged");
    const agent = (await tx.query(`SELECT status FROM agents WHERE id = $1`, [req.agentId])).rows[0];
    if (!agent) return deny("unknown_agent", "Agent does not exist");
    if (agent.status !== "active") return deny("agent_not_active", `Agent is ${agent.status}`);
    if (!limits) return deny("no_budget", "No budget configured");

    // Non-AI spend always needs a human approval attached (Level 3).
    if (req.category !== "ai_api" && !req.approvalId)
      return deny("approval_required", "Non-AI spending requires an approved request");
    if (req.approvalId) {
      const a = (await tx.query(
        `SELECT status, agent_id, amount_cents FROM approvals WHERE id = $1 FOR UPDATE`, [req.approvalId])).rows[0];
      if (!a || a.status !== "approved" || a.agent_id !== req.agentId)
        return deny("approval_invalid", "Approval missing, not approved, or for another agent");
      if (a.amount_cents != null && req.amountCents > a.amount_cents)
        return deny("approval_exceeded", "Amount exceeds the approved amount");
    }

    if (req.amountCents > limits.per_transaction_limit)
      return deny("per_transaction_limit", `${req.amountCents} > ${limits.per_transaction_limit}`);

    const s = await getSpendSummary(tx, req.agentId);
    const checks: [string, number, number][] = [
      ["daily_limit", s.day, limits.daily_limit],
      ["weekly_limit", s.week, limits.weekly_limit],
      ["monthly_limit", s.month, limits.monthly_limit],
      ["starting_budget", s.lifetime, limits.starting_budget],
    ];
    if (req.category === "ai_api") checks.push(["ai_monthly_limit", s.aiMonth, limits.ai_monthly_limit]);
    if (req.category === "advertising") checks.push(["ads_monthly_limit", s.adsMonth, limits.ads_monthly_limit]);
    checks.push(["global_monthly_limit", await globalMonthSpend(tx), controls.global_monthly_limit]);
    for (const [name, used, limit] of checks) {
      if (used + req.amountCents > limit) return deny(name, `would reach ${used + req.amountCents} of ${limit}`);
    }

    const ins = await tx.query(
      `INSERT INTO spend_authorizations (agent_id, category, amount_cents, status, reason, idempotency_key, task_id, approval_id)
       VALUES ($1,$2,$3,'reserved',$4,$5,$6,$7) RETURNING id`,
      [req.agentId, req.category, req.amountCents, req.reason, req.idempotencyKey ?? null, req.taskId ?? null, req.approvalId ?? null],
    );
    await audit(tx, { actor: req.agentId, agentId: req.agentId, action: "spend.authorize", outcome: "allowed",
      details: { amount: req.amountCents, category: req.category, reason: req.reason, id: ins.rows[0].id }, taskId: req.taskId });
    return { id: ins.rows[0].id as string };
  });

  if (outcome.denied !== undefined) throw new PolicyDenied(outcome.denied.split(":")[0], outcome.denied);
  return outcome.id as string;
}

/**
 * Settle a reservation with the actual cost (<= reserved) and write the
 * matching ledger expense. Idempotent: settling twice is a no-op.
 */
export async function settleSpend(db: Db, authorizationId: string, actualCents: number, meta: { source: string; description?: string; sandbox?: boolean; externalRef?: string } ) {
  return withTx(db, async (tx) => {
    const r = (await tx.query(`SELECT * FROM spend_authorizations WHERE id = $1 FOR UPDATE`, [authorizationId])).rows[0];
    if (!r) throw new Error(`Unknown authorization ${authorizationId}`);
    if (r.status === "settled") return r;
    if (r.status !== "reserved") throw new PolicyDenied("not_reserved", `Authorization is ${r.status}`);
    // Never settle more than was authorized. Overage is capped and flagged.
    const amount = Math.max(0, Math.min(Math.round(actualCents), r.amount_cents));
    if (actualCents > r.amount_cents)
      await audit(tx, { actor: "system", agentId: r.agent_id, action: "spend.overage", outcome: "error",
        details: { authorized: r.amount_cents, actual: actualCents, id: authorizationId } });
    await tx.query(`UPDATE spend_authorizations SET status = 'settled', settled_cents = $2, settled_at = now() WHERE id = $1`,
      [authorizationId, amount]);
    if (amount > 0) {
      await tx.query(
        `INSERT INTO ledger_entries (agent_id, entry_type, amount_cents, source, external_ref, verified, sandbox, description, idempotency_key, spend_authorization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.agent_id, LEDGER_TYPE[r.category as SpendCategory], -amount, meta.source, meta.externalRef ?? null,
         meta.source !== "estimate", meta.sandbox ?? false, meta.description ?? r.reason, `settle:${authorizationId}`, authorizationId],
      );
    }
    return { ...r, status: "settled", settled_cents: amount };
  });
}

export async function releaseSpend(q: Queryable, authorizationId: string) {
  await q.query(`UPDATE spend_authorizations SET status = 'released', settled_at = now()
                 WHERE id = $1 AND status = 'reserved'`, [authorizationId]);
}

/** Owner-only path to change limits. Agents have no tool that reaches this. */
export async function setBudget(db: Db, agentId: string, limits: Partial<BudgetLimits>, by: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can change budgets");
  const keys = Object.keys(limits).filter((k) =>
    ["starting_budget","daily_limit","weekly_limit","monthly_limit","per_transaction_limit","ai_monthly_limit","ads_monthly_limit"].includes(k)) as (keyof BudgetLimits)[];
  for (const k of keys) {
    const v = limits[k]!;
    if (!Number.isInteger(v) || v < 0) throw new PolicyDenied("invalid_limit", `${k} must be a non-negative integer (cents)`);
  }
  await withTx(db, async (tx) => {
    await tx.query(`INSERT INTO agent_budgets (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`, [agentId]);
    for (const k of keys) await tx.query(`UPDATE agent_budgets SET ${k} = $2, updated_at = now(), updated_by = $3 WHERE agent_id = $1`, [agentId, limits[k], by]);
    await audit(tx, { actor: by, agentId, action: "budget.update", outcome: "info", details: limits });
  });
}

export type { Tx };

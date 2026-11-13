import type { Queryable } from "./db.js";

export type LedgerType = "revenue" | "refund" | "processing_fee" | "ai_api" | "software" | "advertising" | "hosting" | "other_expense";

/**
 * Record income-side entries (revenue, refunds, fees) that come from a payment
 * provider. Idempotent on (source, external_ref, entry_type) so webhook
 * redeliveries never double-count.
 */
export async function recordProviderEntry(q: Queryable, e: {
  agentId: string; type: "revenue" | "refund" | "processing_fee"; amountCents: number; source: "stripe" | "shopify" | "sandbox" | "manual";
  externalRef: string; customerId?: string; description?: string; occurredAt?: Date;
}): Promise<{ inserted: boolean }> {
  const signed = e.type === "revenue" ? Math.abs(e.amountCents) : -Math.abs(e.amountCents);
  const verified = e.source === "stripe" || e.source === "shopify";
  const r = await q.query(
    `INSERT INTO ledger_entries (agent_id, entry_type, amount_cents, source, external_ref, verified, sandbox, customer_id, description, occurred_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING RETURNING id`,
    [e.agentId, e.type, signed, e.source, e.externalRef, verified, e.source === "sandbox", e.customerId ?? null,
     e.description ?? null, e.occurredAt ?? new Date(), `${e.source}:${e.type}:${e.externalRef}`],
  );
  return { inserted: (r.rowCount ?? 0) > 0 };
}

export interface Financials {
  grossRevenue: number; refunds: number; fees: number; aiCosts: number; software: number;
  advertising: number; hosting: number; other: number; totalExpenses: number; netProfit: number; roi: number | null;
}

/**
 * Financials from the ledger. By default only verified, non-sandbox entries
 * count, so invented or test revenue can never appear as real.
 */
export async function getFinancials(q: Queryable, opts: { agentId?: string; since?: Date; includeSandbox?: boolean } = {}): Promise<Financials> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.agentId) { params.push(opts.agentId); where.push(`agent_id = $${params.length}`); }
  if (opts.since) { params.push(opts.since); where.push(`occurred_at >= $${params.length}`); }
  if (!opts.includeSandbox) where.push(`sandbox = FALSE AND (verified = TRUE OR entry_type <> 'revenue')`);
  const { rows } = await q.query(
    `SELECT entry_type, COALESCE(SUM(amount_cents),0) AS total FROM ledger_entries
      ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY entry_type`, params);
  const t = (k: string) => Math.abs(Number(rows.find((r) => r.entry_type === k)?.total ?? 0));
  const grossRevenue = t("revenue");
  const refunds = t("refund"), fees = t("processing_fee"), aiCosts = t("ai_api"), software = t("software");
  const advertising = t("advertising"), hosting = t("hosting"), other = t("other_expense");
  const totalExpenses = refunds + fees + aiCosts + software + advertising + hosting + other;
  const netProfit = grossRevenue - totalExpenses;
  const costBase = totalExpenses - refunds;
  return { grossRevenue, refunds, fees, aiCosts, software, advertising, hosting, other, totalExpenses, netProfit,
    roi: costBase > 0 ? netProfit / costBase : null };
}

export async function getDailySeries(q: Queryable, days = 30, includeSandbox = false) {
  const { rows } = await q.query(
    `WITH d AS (SELECT generate_series(date_trunc('day', now()) - ($1 - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(CASE WHEN l.entry_type = 'revenue' THEN l.amount_cents END), 0) AS revenue,
            COALESCE(-SUM(CASE WHEN l.entry_type <> 'revenue' THEN l.amount_cents END), 0) AS expenses
       FROM d LEFT JOIN ledger_entries l ON date_trunc('day', l.occurred_at) = d.day
            ${includeSandbox ? "" : "AND l.sandbox = FALSE AND (l.verified OR l.entry_type <> 'revenue')"}
      GROUP BY d.day ORDER BY d.day`, [days]);
  return rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), expenses: Number(r.expenses), profit: Number(r.revenue) - Number(r.expenses) }));
}

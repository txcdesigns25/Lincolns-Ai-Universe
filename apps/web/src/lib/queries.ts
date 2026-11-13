import "server-only";
import { getFinancials, getDailySeries, getSpendSummary, globalMonthSpend } from "@universe/core";
import { db } from "./db";

export async function agentsWithStats(since?: Date) {
  const agents = (await db().query(
    `SELECT a.*, b.*, CASE WHEN c.per_agent_limits_enabled THEN b.daily_limit ELSE c.global_monthly_limit END AS daily_limit, CASE WHEN c.per_agent_limits_enabled THEN b.weekly_limit ELSE c.global_monthly_limit END AS weekly_limit, CASE WHEN c.per_agent_limits_enabled THEN b.monthly_limit ELSE c.global_monthly_limit END AS monthly_limit, CASE WHEN c.per_agent_limits_enabled THEN b.ai_monthly_limit ELSE c.global_monthly_limit END AS ai_monthly_limit, CASE WHEN c.per_agent_limits_enabled THEN b.starting_budget ELSE c.global_monthly_limit END AS starting_budget, c.per_agent_limits_enabled, t.title AS current_task_title FROM agents a
       LEFT JOIN agent_budgets b ON b.agent_id = a.id
       CROSS JOIN system_controls c
       LEFT JOIN tasks t ON t.id = a.current_task_id ORDER BY a.code`)).rows;
  return Promise.all(agents.map(async (a) => ({
    ...a,
    fin: await getFinancials(db(), { agentId: a.id, since }),
    spend: await getSpendSummary(db(), a.id),
  })));
}

export async function overview(range: "day" | "week" | "month") {
  const since = new Date(Date.now() - ({ day: 1, week: 7, month: 30 }[range]) * 86400_000);
  const [agents, total, series, counts, controls, monthSpend] = await Promise.all([
    agentsWithStats(since),
    getFinancials(db(), { since }),
    getDailySeries(db(), range === "month" ? 30 : range === "week" ? 7 : 2),
    db().query(`SELECT
        (SELECT count(*)::int FROM agents WHERE status = 'active') AS active_agents,
        (SELECT count(*)::int FROM tasks WHERE status = 'succeeded' AND finished_at >= $1) AS completed_tasks,
        (SELECT count(*)::int FROM approvals WHERE status = 'pending') AS pending_approvals,
        (SELECT count(*)::int FROM customers WHERE NOT sandbox AND status IN ('active')) AS customers,
        (SELECT count(*)::int FROM customers WHERE NOT sandbox) AS contacts`, [since]),
    db().query(`SELECT * FROM system_controls WHERE id`),
    globalMonthSpend(db()),
  ]);
  return { agents, total, series, counts: counts.rows[0], controls: controls.rows[0], monthSpend };
}

import { db } from "@/lib/db";
import { Card, PageHeader, Button } from "@/components/ui";
import { Meter } from "@/components/charts";
import { BudgetForm } from "@/components/budget-form";
import { agentsWithStats } from "@/lib/queries";
import { globalMonthSpend, globalDaySpend } from "@universe/core";
import { updateGlobalLimit, togglePerAgentLimits } from "../../actions";

export default async function Budgets() {
  const [agents, controls, month, day] = await Promise.all([
    agentsWithStats(),
    db().query(`SELECT global_monthly_limit, global_daily_limit, per_agent_limits_enabled FROM system_controls WHERE id`).then((r) => r.rows[0]),
    globalMonthSpend(db()), globalDaySpend(db()),
  ]);
  const daily = controls.global_daily_limit as number | null;
  return (
    <>
      <PageHeader title="Budgets" subtitle="One shared monthly budget for all agents, enforced by the backend before every expense. Real-money purchases, ads and contracts always need your approval." />
      <Card title="Shared monthly budget (all agents)">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <Meter used={month} limit={controls.global_monthly_limit} />
            {daily != null && <Meter used={day} limit={daily} />}
            <p className="text-xs text-muted">This month{daily != null ? " · today (daily AI limit)" : ""}</p>
          </div>
          <form action={updateGlobalLimit} className="flex items-end gap-2">
            <label className="text-xs text-muted">Monthly limit (USD)
              <input name="global_monthly_limit" type="number" min="0" step="0.01" defaultValue={(controls.global_monthly_limit / 100).toFixed(2)} className="mt-1 block w-32 tabular" /></label>
            <label className="text-xs text-muted">Daily AI limit (blank = none)
              <input name="global_daily_limit" type="number" min="0" step="0.01" defaultValue={daily != null ? (daily / 100).toFixed(2) : ""} className="mt-1 block w-28 tabular" /></label>
            <Button tone="primary">Save</Button>
          </form>
        </div>
      </Card>
      <Card title="Per-agent limits" className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">{controls.per_agent_limits_enabled
            ? "On: each agent is also held to its own limits below."
            : "Off: agents share the monthly budget with no individual limits."}</p>
          <form action={togglePerAgentLimits}>
            <input type="hidden" name="enabled" value={controls.per_agent_limits_enabled ? "false" : "true"} />
            <Button>{controls.per_agent_limits_enabled ? "Turn off per-agent limits" : "Turn on per-agent limits"}</Button>
          </form>
        </div>
      </Card>
      {controls.per_agent_limits_enabled && (
        <div className="mt-4 space-y-4">
          {agents.map((a) => (
            <Card key={a.id} title={`${a.code} · ${a.name}`} action={<Meter used={a.spend.month} limit={a.monthly_limit} />}>
              <BudgetForm agentId={a.id} b={a} compact />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

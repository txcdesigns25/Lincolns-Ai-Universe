import { db } from "@/lib/db";
import { Card, PageHeader, Button } from "@/components/ui";
import { Meter } from "@/components/charts";
import { BudgetForm } from "@/components/budget-form";
import { agentsWithStats } from "@/lib/queries";
import { globalMonthSpend } from "@universe/core";
import { updateGlobalLimit } from "../../actions";

export default async function Budgets() {
  const [agents, controls, month] = await Promise.all([
    agentsWithStats(), db().query(`SELECT global_monthly_limit FROM system_controls WHERE id`).then((r) => r.rows[0]), globalMonthSpend(db()),
  ]);
  return (
    <>
      <PageHeader title="Budgets" subtitle="Limits are enforced by the backend before every expense. Agents and the CEO cannot change them; the CEO can only recommend." />
      <Card title="Global cap (all agents combined)">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Meter used={month} limit={controls.global_monthly_limit} />
          <form action={updateGlobalLimit} className="flex items-end gap-2">
            <label className="text-xs text-muted">Monthly limit (USD)
              <input name="global_monthly_limit" type="number" min="0" step="0.01" defaultValue={(controls.global_monthly_limit / 100).toFixed(2)} className="mt-1 block w-32 tabular" /></label>
            <Button tone="primary">Save</Button>
          </form>
        </div>
      </Card>
      <div className="mt-4 space-y-4">
        {agents.map((a) => (
          <Card key={a.id} title={`${a.code} · ${a.name}`} action={<Meter used={a.spend.month} limit={a.monthly_limit} />}>
            <BudgetForm agentId={a.id} b={a} compact />
          </Card>
        ))}
      </div>
    </>
  );
}

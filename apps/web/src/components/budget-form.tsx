import { updateBudget } from "@/app/actions";
import { Button } from "./ui";

const FIELDS = [
  ["starting_budget", "Starting (lifetime) budget"], ["daily_limit", "Daily limit"], ["weekly_limit", "Weekly limit"],
  ["monthly_limit", "Monthly limit"], ["per_transaction_limit", "Per-transaction limit"], ["ai_monthly_limit", "Max AI API / month"],
  ["ads_monthly_limit", "Max advertising / month"],
] as const;

export function BudgetForm({ agentId, b, compact }: { agentId: string; b: Record<string, number>; compact?: boolean }) {
  return (
    <form action={updateBudget} className={`grid gap-3 ${compact ? "grid-cols-2 md:grid-cols-4 xl:grid-cols-8" : "grid-cols-2"}`}>
      <input type="hidden" name="agent_id" value={agentId} />
      {FIELDS.map(([k, label]) => (
        <label key={k} className="text-xs text-muted">{label}
          <input name={k} type="number" min="0" step="0.01" defaultValue={(b[k] / 100).toFixed(2)} className="mt-1 w-full tabular" />
        </label>
      ))}
      <div className="flex items-end"><Button tone="primary" type="submit">Save</Button></div>
    </form>
  );
}

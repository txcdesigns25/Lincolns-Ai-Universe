import { db } from "@/lib/db";
import { Card, PageHeader, Table, Money, Stat } from "@/components/ui";
import { getFinancials } from "@universe/core";
import { ago, usd } from "@/lib/format";

export default async function Expenses() {
  const [f, rows] = await Promise.all([
    getFinancials(db()),
    db().query(`SELECT l.*, a.name FROM ledger_entries l JOIN agents a ON a.id = l.agent_id
                 WHERE entry_type NOT IN ('revenue') ORDER BY occurred_at DESC LIMIT 150`).then((r) => r.rows),
  ]);
  return (
    <>
      <PageHeader title="Expenses" subtitle="Every agent expense is reserved against its budget before it happens, then settled at the actual cost." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="AI API" value={usd(f.aiCosts)} /><Stat label="Software" value={usd(f.software)} />
        <Stat label="Advertising" value={usd(f.advertising)} /><Stat label="Fees, refunds, other" value={usd(f.fees + f.refunds + f.hosting + f.other)} />
      </div>
      <Card title="Expense ledger" className="mt-4">
        <Table empty="No expenses yet." head={["When", "Business", "Category", "Amount", "Description"]}
          rows={rows.map((r) => [<span key="w" className="text-muted">{ago(r.occurred_at)}</span>, r.name, r.entry_type, <Money key="a" cents={r.amount_cents} sign />, <span key="d" className="text-xs text-muted">{r.description}</span>])} />
      </Card>
    </>
  );
}

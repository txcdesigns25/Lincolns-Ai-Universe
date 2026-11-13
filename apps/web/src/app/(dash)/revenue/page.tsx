import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Money } from "@/components/ui";
import { HBars } from "@/components/charts";
import { agentsWithStats } from "@/lib/queries";
import { ago } from "@/lib/format";

export default async function Revenue() {
  const [agents, rows] = await Promise.all([
    agentsWithStats(),
    db().query(`SELECT l.*, a.name FROM ledger_entries l JOIN agents a ON a.id = l.agent_id
                 WHERE entry_type IN ('revenue','refund','processing_fee') ORDER BY occurred_at DESC LIMIT 100`).then((r) => r.rows),
  ]);
  return (
    <>
      <PageHeader title="Revenue" subtitle="Revenue is counted only when it comes from a connected payment provider. Sandbox and manual entries are shown but excluded from totals." />
      <Card title="Verified net revenue by business (after refunds and fees)">
        <HBars rows={agents.filter((a) => a.kind === "business").map((a) => ({ label: a.name, value: a.fin.grossRevenue - a.fin.refunds - a.fin.fees }))} />
      </Card>
      <Card title="Income ledger" className="mt-4">
        <Table empty="No revenue recorded yet. Nothing here is invented: rows appear only from payment provider events." head={["When", "Business", "Type", "Amount", "Source", "Ref", "Counts?"]}
          rows={rows.map((r) => [<span key="w" className="text-muted">{ago(r.occurred_at)}</span>, r.name, r.entry_type, <Money key="a" cents={r.amount_cents} sign />, r.source,
            <code key="r" className="text-xs">{r.external_ref}</code>, r.sandbox || (!r.verified && r.entry_type === "revenue") ? <Badge key="c" tone="paused">excluded</Badge> : <Badge key="c" tone="active">verified</Badge>])} />
      </Card>
    </>
  );
}

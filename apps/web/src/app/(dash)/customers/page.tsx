import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge } from "@/components/ui";
import { ago } from "@/lib/format";

export default async function Customers() {
  const rows = (await db().query(`SELECT c.*, a.name AS agent_name FROM customers c JOIN agents a ON a.id = c.owner_agent_id ORDER BY c.created_at DESC LIMIT 200`)).rows;
  return (
    <>
      <PageHeader title="Customers" subtitle="Each customer belongs to one business. Other agents see a customer only through a share you approve." />
      <Card>
        <Table empty="No customers or leads yet. Leads arrive from landing pages via the lead form endpoint." head={["Name", "Company", "Email", "Business", "Status", "Source", "Added"]}
          rows={rows.map((c) => [c.name, c.company ?? "-", c.email ?? "-", c.agent_name, <span key="s" className="flex gap-1"><Badge>{c.status}</Badge>{c.sandbox && <Badge tone="x">test</Badge>}</span>, c.source ?? "-", <span key="w" className="text-muted">{ago(c.created_at)}</span>])} />
      </Card>
    </>
  );
}

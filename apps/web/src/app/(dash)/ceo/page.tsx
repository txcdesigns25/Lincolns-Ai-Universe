import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Button, Money } from "@/components/ui";
import { ago, usd } from "@/lib/format";
import { runAgentNow, decide } from "../../actions";

export default async function Ceo() {
  const q = db();
  const [reports, tasks, recs, assigned] = await Promise.all([
    q.query(`SELECT title, body, created_at FROM drafts WHERE agent_id = 'ceo' AND draft_type = 'report' ORDER BY created_at DESC LIMIT 5`).then((r) => r.rows),
    q.query(`SELECT title, type, status, result, cost_cents, created_at FROM tasks WHERE agent_id = 'ceo' AND type <> 'health_check' ORDER BY created_at DESC LIMIT 10`).then((r) => r.rows),
    q.query(`SELECT * FROM approvals WHERE agent_id = 'ceo' ORDER BY created_at DESC LIMIT 10`).then((r) => r.rows),
    q.query(`SELECT agent_id, title, status, created_at FROM tasks WHERE created_by = 'ceo' ORDER BY created_at DESC LIMIT 15`).then((r) => r.rows),
  ]);
  return (
    <>
      <PageHeader title="Universe CEO" subtitle="Monitors all businesses and recommends. It cannot change limits, grant permissions, or approve anything.">
        <form action={runAgentNow}><input type="hidden" name="agent_id" value="ceo" /><Button tone="primary">Produce summary now</Button></form>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Latest performance reports" className="lg:col-span-2">
          {reports.length ? reports.map((r, i) => (
            <details key={i} open={i === 0} className="border-b border-line py-3 last:border-0">
              <summary className="cursor-pointer text-sm font-medium">{r.title} <span className="text-xs text-muted">· {ago(r.created_at)}</span></summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-muted">{r.body}</pre>
            </details>
          )) : <p className="text-sm text-faint">No reports yet. The CEO writes a daily summary and a weekly evaluation.</p>}
        </Card>
        <Card title="Budget recommendations">
          <Table empty="No recommendations." head={["Recommendation", "Status"]} rows={recs.map((a) => [
            <div key="r"><div className="text-sm">{a.summary}</div><div className="text-xs text-muted">{a.details?.rationale}</div>
              {a.status === "pending" && <div className="mt-2 flex gap-2">
                <form action={decide}><input type="hidden" name="approval_id" value={a.id} /><input type="hidden" name="decision" value="approved" /><Button tone="good">Approve</Button></form>
                <form action={decide}><input type="hidden" name="approval_id" value={a.id} /><input type="hidden" name="decision" value="rejected" /><Button tone="danger">Reject</Button></form>
              </div>}</div>, <Badge key="s">{a.status}</Badge>])} />
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="CEO runs"><Table head={["Run", "Status", "Cost", "When"]} rows={tasks.map((t) => [<span key="t" title={t.result?.summary}>{t.title}</span>, <Badge key="s">{t.status}</Badge>, <Money key="c" cents={t.cost_cents} />, <span key="w" className="text-muted">{ago(t.created_at)}</span>])} /></Card>
        <Card title="Tasks assigned to agents"><Table head={["Agent", "Task", "Status", "When"]} rows={assigned.map((t) => [t.agent_id, t.title, <Badge key="s">{t.status}</Badge>, <span key="w" className="text-muted">{ago(t.created_at)}</span>])} /></Card>
      </div>
    </>
  );
}

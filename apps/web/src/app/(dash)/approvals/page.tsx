import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Button } from "@/components/ui";
import { ago, usd } from "@/lib/format";
import { decide } from "../../actions";
import { ACTIONS } from "@universe/core";

export default async function Approvals() {
  const q = db();
  const [pending, history] = await Promise.all([
    q.query(`SELECT ap.*, a.name, d.title AS draft_title, d.body AS draft_body, d.draft_type FROM approvals ap
               JOIN agents a ON a.id = ap.agent_id LEFT JOIN drafts d ON d.id = (ap.details->>'draft_id')::uuid
              WHERE ap.status = 'pending' ORDER BY ap.created_at`).then((r) => r.rows),
    q.query(`SELECT ap.*, a.name FROM approvals ap JOIN agents a ON a.id = ap.agent_id WHERE ap.status <> 'pending' ORDER BY ap.created_at DESC LIMIT 50`).then((r) => r.rows),
  ]);
  return (
    <>
      <PageHeader title="Approvals" subtitle="Level 3 actions wait here. Approving queues the action for execution by deterministic code; agents never execute it themselves." />
      <div className="space-y-3">
        {pending.length === 0 && <Card><p className="text-center text-sm text-faint">Nothing waiting for you.</p></Card>}
        {pending.map((a) => (
          <Card key={a.id} title={a.summary} action={<span className="text-xs text-muted">{a.name} · {ago(a.created_at)}</span>}>
            <div className="flex flex-wrap gap-2 text-xs"><Badge>{`Level ${a.level}`}</Badge><code>{a.action}</code><span className="text-muted">{ACTIONS[a.action]?.description}</span>
              {a.amount_cents && <span className="text-warn">Amount: {usd(a.amount_cents)}</span>}</div>
            {a.draft_body && (
              <details className="mt-3 rounded-lg border border-line bg-panel-2 p-3" open>
                <summary className="cursor-pointer text-sm font-medium">{a.draft_type}: {a.draft_title}</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-sans text-sm text-muted">{a.draft_body}</pre>
              </details>
            )}
            {a.details?.justification && <p className="mt-2 text-sm text-muted">Why: {a.details.justification}</p>}
            {!a.draft_body && <pre className="mt-2 overflow-auto text-xs text-muted">{JSON.stringify(a.details, null, 2)}</pre>}
            <form action={decide} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="approval_id" value={a.id} />
              <input name="note" placeholder="Note (optional)" className="min-w-48 flex-1" />
              <Button tone="good" name="decision" value="approved">Approve</Button>
              <Button tone="danger" name="decision" value="rejected">Reject</Button>
            </form>
          </Card>
        ))}
      </div>
      <Card title="History" className="mt-6">
        <Table head={["Request", "Agent", "Action", "Status", "Decided"]} rows={history.map((a) => [a.summary, a.name, <code key="c" className="text-xs">{a.action}</code>, <Badge key="s">{a.status}</Badge>, <span key="w" className="text-muted">{ago(a.decided_at ?? a.created_at)}</span>])} />
      </Card>
    </>
  );
}

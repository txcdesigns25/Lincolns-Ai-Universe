import Link from "next/link";
import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Button, Money } from "@/components/ui";
import { ago } from "@/lib/format";
import { retryTask } from "../../actions";

const STATUSES = ["all", "queued", "running", "waiting_approval", "succeeded", "failed", "dead"];

export default async function Tasks({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const status = (await searchParams).status;
  const rows = (await db().query(
    `SELECT t.*, a.name FROM tasks t JOIN agents a ON a.id = t.agent_id ${status ? "WHERE t.status = $1" : ""}
      ORDER BY t.created_at DESC LIMIT 200`, status ? [status] : [])).rows;
  return (
    <>
      <PageHeader title="Tasks" subtitle="Durable queue. Tasks survive restarts; crashed work is recovered automatically and retried with backoff.">
        {STATUSES.map((s) => (
          <Link key={s} href={s === "all" ? "/tasks" : `/tasks?status=${s}`} className={`rounded-lg border px-3 py-1.5 text-sm ${(status ?? "all") === s ? "border-accent/50 bg-accent/15 text-accent" : "border-line text-muted"}`}>{s.replace("_", " ")}</Link>
        ))}
      </PageHeader>
      <Card>
        <Table head={["Task", "Agent", "Status", "Attempts", "Cost", "Created", "Result / error", ""]} rows={rows.map((t) => [
          <div key="t"><div>{t.title}</div><div className="text-xs text-faint">{t.type} · by {t.created_by}</div></div>, t.name, <Badge key="s">{t.status}</Badge>,
          `${t.attempts}/${t.max_attempts}`, <Money key="c" cents={t.cost_cents} />, <span key="w" className="text-muted">{ago(t.created_at)}</span>,
          <span key="r" className={`line-clamp-2 text-xs ${t.last_error && t.status !== "succeeded" ? "text-bad" : "text-muted"}`}>{t.status === "succeeded" ? (t.result?.summary ?? t.result?.detail ?? "") : (t.last_error ?? "")}</span>,
          ["dead", "failed"].includes(t.status) ? <form key="b" action={retryTask}><input type="hidden" name="task_id" value={t.id} /><Button>Retry</Button></form> : null])} />
      </Card>
    </>
  );
}

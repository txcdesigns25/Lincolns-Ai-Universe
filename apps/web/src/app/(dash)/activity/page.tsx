import Link from "next/link";
import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge } from "@/components/ui";
import { ago } from "@/lib/format";

export default async function Activity({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const outcome = (await searchParams).outcome;
  const rows = (await db().query(
    `SELECT * FROM audit_log ${outcome ? "WHERE outcome = $1" : ""} ORDER BY id DESC LIMIT 200`, outcome ? [outcome] : [])).rows;
  return (
    <>
      <PageHeader title="Activity Feed" subtitle="Append-only audit log of every important action, allowed or denied.">
        {["all", "allowed", "denied", "error", "info"].map((o) => (
          <Link key={o} href={o === "all" ? "/activity" : `/activity?outcome=${o}`} className={`rounded-lg border px-3 py-1.5 text-sm ${(outcome ?? "all") === o ? "border-accent/50 bg-accent/15 text-accent" : "border-line text-muted"}`}>{o}</Link>
        ))}
      </PageHeader>
      <Card>
        <Table head={["When", "Actor", "Agent", "Action", "Outcome", "Details"]} rows={rows.map((r) => [
          <span key="w" className="whitespace-nowrap text-muted">{ago(r.created_at)}</span>, <span key="a" className="text-xs">{r.actor}</span>, r.agent_id ?? "-",
          <code key="c" className="text-xs">{r.action}</code>, <Badge key="o">{r.outcome}</Badge>, <code key="d" className="line-clamp-2 text-xs text-muted">{JSON.stringify(r.details).slice(0, 200)}</code>])} />
      </Card>
    </>
  );
}

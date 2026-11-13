import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Button } from "@/components/ui";
import { ago, usd, pct } from "@/lib/format";
import { decideVersion } from "../../actions";

export default async function Memory() {
  const q = db();
  const [memories, experiments, versions] = await Promise.all([
    q.query(`SELECT m.*, a.name FROM memories m JOIN agents a ON a.id = m.agent_id ORDER BY m.created_at DESC LIMIT 60`).then((r) => r.rows),
    q.query(`SELECT e.*, a.name FROM experiments e JOIN agents a ON a.id = e.agent_id ORDER BY e.created_at DESC LIMIT 40`).then((r) => r.rows),
    q.query(`SELECT v.*, a.name FROM agent_config_versions v JOIN agents a ON a.id = v.agent_id ORDER BY v.created_at DESC LIMIT 40`).then((r) => r.rows),
  ]);
  return (
    <>
      <PageHeader title="Memory & Learning" subtitle="Observations, hypotheses and verified results are kept separate. A result counts as verified only with evidence from the database." />
      <Card title="Strategy versions (reversible)">
        <Table empty="No strategy versions yet." head={["Agent", "Version", "Rationale", "Status", "When", ""]} rows={versions.map((v) => [
          v.name, `v${v.version}`, <div key="r" className="max-w-md"><div className="line-clamp-2 text-sm">{v.rationale}</div>
            <details className="text-xs text-muted"><summary className="cursor-pointer">Strategy text</summary><pre className="whitespace-pre-wrap">{v.strategy_prompt}</pre></details></div>,
          <Badge key="s">{v.status}</Badge>, <span key="w" className="text-muted">{ago(v.created_at)}</span>,
          <span key="b" className="flex gap-2">
            {v.status === "proposed" && <>
              <form action={decideVersion}><input type="hidden" name="version_id" value={v.id} /><Button tone="good">Activate</Button></form>
              <form action={decideVersion}><input type="hidden" name="version_id" value={v.id} /><input type="hidden" name="decision" value="reject" /><Button tone="danger">Reject</Button></form></>}
            {["superseded", "rolled_back"].includes(v.status) && <form action={decideVersion}><input type="hidden" name="version_id" value={v.id} /><Button>Roll back to this</Button></form>}
          </span>])} />
      </Card>
      <Card title="Experiments" className="mt-4">
        <Table empty="No experiments yet." head={["Agent", "Hypothesis", "Metric", "Results", "Status", "Lessons"]} rows={experiments.map((e) => [
          e.name, <span key="h" className="text-sm">{e.hypothesis}</span>, <span key="m" className="text-xs text-muted">{e.metric} (min n={e.min_sample_size})</span>,
          <div key="r" className="text-xs">{Object.entries(e.results ?? {}).map(([k, v]: any) => <div key={k}>{k}: {v.conversions}/{v.trials} ({v.trials ? pct(v.conversions / v.trials) : "n/a"})</div>)}</div>,
          <div key="s"><Badge>{e.status}</Badge>{e.winner && <div className="mt-1 text-xs text-good">winner {e.winner}</div>}</div>,
          <span key="l" className="line-clamp-3 text-xs text-muted">{e.lessons ?? e.conclusion ?? ""}{e.cost_cents ? ` · cost ${usd(e.cost_cents)}` : ""}</span>])} />
      </Card>
      <Card title="Memories" className="mt-4">
        <Table head={["Agent", "Kind", "Memory", "Confidence", "When"]} rows={memories.map((m) => [
          m.name, <Badge key="k" tone={m.kind === "verified_result" ? "active" : m.kind === "mistake" ? "error" : "x"}>{m.kind.replace("_", " ")}</Badge>,
          <div key="m"><div>{m.title}</div><div className="line-clamp-2 text-xs text-muted">{m.content}</div></div>, m.confidence != null ? pct(Number(m.confidence)) : "-",
          <span key="w" className="text-muted">{ago(m.created_at)}</span>])} />
      </Card>
    </>
  );
}

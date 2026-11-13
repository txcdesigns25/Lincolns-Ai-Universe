import Link from "next/link";
import { PageHeader, Badge, Money, Button } from "@/components/ui";
import { Meter } from "@/components/charts";
import { agentsWithStats } from "@/lib/queries";
import { setAllAgents } from "../../actions";
import { AGENT_BY_ID } from "@universe/core";

export default async function Agents() {
  const agents = await agentsWithStats();
  return (
    <>
      <PageHeader title="All Agents" subtitle="Each agent has its own ledger, budget, memory, queue, and permissions.">
        <form action={setAllAgents}><input type="hidden" name="status" value="paused" /><Button tone="danger">Pause all</Button></form>
        <form action={setAllAgents}><input type="hidden" name="status" value="active" /><Button tone="good">Resume all</Button></form>
      </PageHeader>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {agents.map((a) => (
          <Link key={a.id} href={`/agents/${a.id}`} className="rise group rounded-xl border border-line bg-panel p-4 transition-colors hover:border-accent/40">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs text-faint">{a.code}</div>
                <div className="font-medium group-hover:text-accent">{a.name}</div>
              </div>
              <div className="flex flex-col items-end gap-1"><Badge>{a.status}</Badge>{a.live_mode && <Badge tone="error">live</Badge>}</div>
            </div>
            <p className="mt-2 line-clamp-2 text-xs text-muted">{AGENT_BY_ID[a.id]?.mission}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div><div className="text-[11px] text-faint">Net profit</div><Money cents={a.fin.netProfit} sign /></div>
              <div><div className="text-[11px] text-faint">Revenue</div><Money cents={a.fin.grossRevenue} /></div>
            </div>
            <div className="mt-3"><Meter used={a.spend.month} limit={a.monthly_limit} /></div>
            <div className="mt-2 truncate text-xs text-muted">{a.current_task_title ? `Working: ${a.current_task_title}` : "Idle"}</div>
          </Link>
        ))}
      </div>
    </>
  );
}

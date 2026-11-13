import Link from "next/link";
import { Card, PageHeader, Stat, Table, Badge, Money } from "@/components/ui";
import { FinanceChart, HBars, Meter } from "@/components/charts";
import { overview } from "@/lib/queries";
import { usd, num, ago } from "@/lib/format";

export default async function Overview({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const r = (await searchParams).range;
  const range = r === "day" || r === "week" ? r : "month";
  const d = await overview(range);
  const available = Math.max(0, d.controls.global_monthly_limit - d.monthSpend);
  const business = d.agents.filter((a) => a.kind === "business");
  return (
    <>
      <PageHeader title="Overview" subtitle="Only verified, non-sandbox ledger entries count as revenue. Sandbox and unverified data is excluded.">
        {(["day", "week", "month"] as const).map((k) => (
          <Link key={k} href={`/?range=${k}`} className={`rounded-lg border px-3 py-1.5 text-sm ${range === k ? "border-accent/50 bg-accent/15 text-accent" : "border-line text-muted hover:text-ink"}`}>
            {k === "day" ? "24h" : k === "week" ? "7 days" : "30 days"}
          </Link>
        ))}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Verified revenue" value={usd(d.total.grossRevenue)} />
        <Stat label="Total expenses" value={usd(d.total.totalExpenses)} />
        <Stat label="Net profit" value={usd(d.total.netProfit)} tone={d.total.netProfit > 0 ? "good" : d.total.netProfit < 0 ? "bad" : undefined} />
        <Stat label="Available budget" value={usd(available)} hint={`of ${usd(d.controls.global_monthly_limit)} this month`} tone={available < d.controls.global_monthly_limit * 0.2 ? "warn" : undefined} />
        <Stat label="Active agents" value={`${d.counts.active_agents} / 8`} />
        <Stat label="Completed tasks" value={num(d.counts.completed_tasks)} />
        <Stat label="Pending approvals" value={num(d.counts.pending_approvals)} tone={d.counts.pending_approvals ? "warn" : undefined} />
        <Stat label="Paying customers" value={num(d.counts.customers)} hint={`${num(d.counts.contacts)} contacts and leads`} />
      </div>

      <Card title="Financial performance" className="mt-4"><FinanceChart data={d.series.map((s) => ({ ...s, label: s.day.slice(5) }))} /></Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Revenue by business"><HBars rows={business.map((a) => ({ label: a.name, value: a.fin.grossRevenue }))} /></Card>
        <Card title="Profit by business"><HBars rows={business.map((a) => ({ label: a.name, value: a.fin.netProfit }))} /></Card>
        <Card title="Agent operating costs (AI)"><HBars rows={d.agents.map((a) => ({ label: a.name, value: -a.fin.aiCosts }))} /></Card>
      </div>

      <Card title="Businesses" className="mt-4">
        <Table head={["Agent", "Status", "Revenue", "Expenses", "Net profit", "Month spend", "Current task"]}
          rows={d.agents.map((a) => [
            <Link key="n" href={`/agents/${a.id}`} className="font-medium hover:text-accent">{a.code} · {a.name}</Link>,
            <span key="s" className="flex gap-1"><Badge>{a.status}</Badge>{a.live_mode ? <Badge tone="error">live</Badge> : <Badge tone="x">sandbox</Badge>}</span>,
            <Money key="r" cents={a.fin.grossRevenue} />, <Money key="e" cents={a.fin.totalExpenses} />, <Money key="p" cents={a.fin.netProfit} sign />,
            <Meter key="m" used={a.spend.month} limit={a.monthly_limit} />,
            <span key="t" className="text-muted">{a.current_task_title ?? `idle · ${ago(a.last_heartbeat)}`}</span>,
          ])} />
      </Card>
    </>
  );
}

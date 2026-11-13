import { notFound } from "next/navigation";
import { AGENT_BY_ID, ACTIONS, getFinancials, getSpendSummary, getActiveConfig, listCustomersForAgent } from "@universe/core";
import { db } from "@/lib/db";
import { Card, PageHeader, Stat, Table, Badge, Button, Money } from "@/components/ui";
import { Meter } from "@/components/charts";
import { usd, ago } from "@/lib/format";
import { setAgentStatus, runAgentNow, setLiveMode, togglePermission, decide } from "../../../actions";
import { BudgetForm } from "@/components/budget-form";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const def = AGENT_BY_ID[id];
  if (!def) notFound();
  const q = db();
  const [agent, budget, fin, spend, cfg, tasks, upcoming, decisions, learning, approvals, errors, perms, customers] = await Promise.all([
    q.query(`SELECT a.*, t.title AS current_task_title FROM agents a LEFT JOIN tasks t ON t.id = a.current_task_id WHERE a.id = $1`, [id]).then((r) => r.rows[0]),
    q.query(`SELECT * FROM agent_budgets WHERE agent_id = $1`, [id]).then((r) => r.rows[0]),
    getFinancials(q, { agentId: id }),
    getSpendSummary(q, id),
    getActiveConfig(q, id),
    q.query(`SELECT * FROM tasks WHERE agent_id = $1 AND status NOT IN ('queued') ORDER BY created_at DESC LIMIT 15`, [id]).then((r) => r.rows),
    q.query(`(SELECT title, run_at, type FROM tasks WHERE agent_id = $1 AND status = 'queued' ORDER BY run_at LIMIT 5)
             UNION ALL (SELECT title, next_run_at, task_type FROM schedules WHERE agent_id = $1 AND enabled ORDER BY next_run_at)`, [id]).then((r) => r.rows),
    q.query(`SELECT tool, input, is_error, created_at FROM tool_calls WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 12`, [id]).then((r) => r.rows),
    q.query(`SELECT kind, title, content, created_at FROM memories WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]).then((r) => r.rows),
    q.query(`SELECT * FROM approvals WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at DESC`, [id]).then((r) => r.rows),
    q.query(`SELECT title, last_error, finished_at FROM tasks WHERE agent_id = $1 AND status IN ('failed','dead') ORDER BY finished_at DESC LIMIT 10`, [id]).then((r) => r.rows),
    q.query(`SELECT action FROM agent_permissions WHERE agent_id = $1`, [id]).then((r) => new Set(r.rows.map((x) => x.action))),
    listCustomersForAgent(q, id),
  ]);
  const level2 = Object.entries(ACTIONS).filter(([, s]) => s.level === 2);

  return (
    <>
      <PageHeader title={`${def.code} · ${def.name}`} subtitle={def.mission}>
        <form action={setAgentStatus}><input type="hidden" name="agent_id" value={id} />
          <input type="hidden" name="status" value={agent.status === "active" ? "paused" : "active"} />
          <Button tone={agent.status === "active" ? "danger" : "good"}>{agent.status === "active" ? "Pause" : "Resume"}</Button></form>
        <form action={runAgentNow}><input type="hidden" name="agent_id" value={id} /><Button tone="primary">Run cycle now</Button></form>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Status" value={<Badge>{agent.status}</Badge>} hint={agent.live_mode ? "LIVE: external actions enabled" : "Sandbox: external actions simulated"} />
        <Stat label="Revenue" value={usd(fin.grossRevenue)} />
        <Stat label="Expenses" value={usd(fin.totalExpenses)} />
        <Stat label="Net profit" value={usd(fin.netProfit)} tone={fin.netProfit > 0 ? "good" : fin.netProfit < 0 ? "bad" : undefined} />
        <Stat label="Available budget" value={usd(Math.max(0, budget.monthly_limit - spend.month))} hint="this month" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Current task" className="lg:col-span-2">
          <p className="text-sm">{agent.current_task_title ?? "Idle"}</p>
          <p className="mt-1 text-xs text-muted">Last active {ago(agent.last_heartbeat)}</p>
          <h3 className="mt-4 mb-2 text-xs uppercase tracking-wider text-faint">Upcoming</h3>
          <ul className="space-y-1 text-sm">{upcoming.map((u, i) => <li key={i} className="flex justify-between gap-2"><span>{u.title}</span><span className="text-muted">{ago(u.run_at)}</span></li>)}</ul>
        </Card>
        <Card title="Spend vs limits">
          <dl className="space-y-3 text-sm">
            {[["Today", spend.day, budget.daily_limit], ["This week", spend.week, budget.weekly_limit], ["This month", spend.month, budget.monthly_limit], ["AI this month", spend.aiMonth, budget.ai_monthly_limit], ["Lifetime", spend.lifetime, budget.starting_budget]].map(([l, u, m]) => (
              <div key={l as string} className="flex items-center justify-between gap-3"><dt className="text-muted">{l}</dt><dd><Meter used={u as number} limit={m as number} /></dd></div>
            ))}
          </dl>
        </Card>
      </div>

      {approvals.length > 0 && (
        <Card title="Pending approvals" className="mt-4">
          <Table head={["Request", "Action", "Amount", ""]} rows={approvals.map((a) => [a.summary, <code key="c" className="text-xs">{a.action}</code>, a.amount_cents ? usd(a.amount_cents) : "-",
            <span key="b" className="flex gap-2">
              <form action={decide}><input type="hidden" name="approval_id" value={a.id} /><input type="hidden" name="decision" value="approved" /><Button tone="good">Approve</Button></form>
              <form action={decide}><input type="hidden" name="approval_id" value={a.id} /><input type="hidden" name="decision" value="rejected" /><Button tone="danger">Reject</Button></form>
            </span>])} />
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Task history">
          <Table head={["Task", "Status", "Cost", "When"]} rows={tasks.map((t) => [
            <span key="t" title={t.result?.summary ?? ""}>{t.title}</span>, <Badge key="s">{t.status}</Badge>, <Money key="c" cents={t.cost_cents} />, <span key="w" className="text-muted">{ago(t.created_at)}</span>])} />
        </Card>
        <Card title="Recent decisions (tool calls)">
          <Table head={["Tool", "Input", "When"]} rows={decisions.map((d) => [
            <span key="t" className={d.is_error ? "text-bad" : ""}>{d.tool}</span>,
            <code key="i" className="line-clamp-2 text-xs text-muted">{JSON.stringify(d.input).slice(0, 160)}</code>, <span key="w" className="text-muted">{ago(d.created_at)}</span>])} />
        </Card>
        <Card title="Learning history">
          <Table head={["Kind", "Memory", "When"]} rows={learning.map((m) => [<Badge key="k">{m.kind}</Badge>,
            <div key="m"><div>{m.title}</div><div className="line-clamp-2 text-xs text-muted">{m.content}</div></div>, <span key="w" className="text-muted">{ago(m.created_at)}</span>])} />
        </Card>
        <Card title="Error log">
          <Table empty="No errors." head={["Task", "Error", "When"]} rows={errors.map((e) => [e.title, <code key="e" className="line-clamp-3 text-xs text-bad">{e.last_error}</code>, <span key="w" className="text-muted">{ago(e.finished_at)}</span>])} />
        </Card>
        <Card title="Customers">
          <Table empty="No customers yet." head={["Name", "Company", "Status"]} rows={customers.map((c: any) => [c.name, c.company ?? "-", <Badge key="s">{c.status}</Badge>])} />
        </Card>
        <Card title="Active strategy">
          {cfg ? <><p className="text-xs text-muted">Version {cfg.version} · activated {ago(cfg.activated_at)}</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{cfg.strategy_prompt || "(empty)"}</pre></>
            : <p className="text-sm text-muted">No strategy version yet. The agent proposes one from evidence.</p>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Configure budget (USD)"><BudgetForm agentId={id} b={budget} /></Card>
        <Card title="Permissions">
          <p className="mb-3 text-xs text-muted">Level 2 actions run automatically only when you pre-authorize them here. Level 3 actions always need individual approval.</p>
          <ul className="space-y-2 text-sm">
            {level2.map(([action, spec]) => (
              <li key={action} className="flex items-center justify-between gap-3">
                <span><code className="text-xs">{action}</code><span className="block text-xs text-muted">{spec.description}</span></span>
                <form action={togglePermission}><input type="hidden" name="agent_id" value={id} /><input type="hidden" name="action" value={action} />
                  <input type="hidden" name="grant" value={perms.has(action) ? "false" : "true"} />
                  <Button tone={perms.has(action) ? "good" : "default"}>{perms.has(action) ? "Allowed" : "Not allowed"}</Button></form>
              </li>
            ))}
          </ul>
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-sm font-medium">Live mode</h3>
            <p className="mt-1 text-xs text-muted">Off: approved external actions are simulated. On: approved actions use real integrations (when credentials exist).</p>
            <form action={setLiveMode} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="agent_id" value={id} /><input type="hidden" name="live" value={agent.live_mode ? "false" : "true"} />
              {!agent.live_mode && <input name="confirm" placeholder="Type LIVE" className="w-28" />}
              <Button tone={agent.live_mode ? "default" : "danger"}>{agent.live_mode ? "Switch to sandbox" : "Enable live mode"}</Button>
            </form>
          </div>
        </Card>
      </div>
    </>
  );
}

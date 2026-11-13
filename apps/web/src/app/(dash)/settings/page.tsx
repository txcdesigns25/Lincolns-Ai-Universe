import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Button } from "@/components/ui";
import { ago } from "@/lib/format";
import { integrationStatus } from "@universe/core";
import { emergencyStop, emergencyRelease, ackNotification } from "../../actions";

export default async function Settings() {
  const q = db();
  const [controls, workers, notes, wc] = await Promise.all([
    q.query(`SELECT * FROM system_controls WHERE id`).then((r) => r.rows[0]),
    q.query(`SELECT * FROM workers ORDER BY last_heartbeat DESC LIMIT 5`).then((r) => r.rows),
    q.query(`SELECT * FROM notifications ORDER BY acknowledged, created_at DESC LIMIT 50`).then((r) => r.rows),
    q.query(`SELECT value FROM kv_store WHERE key = 'worker_config'`).then((r) => r.rows[0]?.value ?? {}),
  ]);
  // Worker-side settings are reported by the worker itself (it is a separate service).
  const llm = wc.llm === "anthropic" ? `Claude · ${wc.model} (routine)${wc.modelImportant ? ` · ${wc.modelImportant} (important)` : ""}` : wc.llm === "mock" ? "Mock (free, sandbox output)" : "Unknown (worker has not started)";
  const env = [
    ["Claude API (worker)", wc.llm === "anthropic", "ANTHROPIC_API_KEY"],
    ["Telegram bot (worker)", !!wc.telegram, "TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID"],
    ["Shopify, separate store only (worker)", !!wc.shopify, "SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN"],
    ["Notification webhook (worker)", !!wc.notifyWebhook, "NOTIFY_WEBHOOK_URL"],
    ["Stripe webhooks (web)", !!process.env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET"],
  ] as const;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Emergency stop">
          <p className="text-sm text-muted">Immediately blocks all new agent spending and external actions. Work already in flight finishes and its real costs are still recorded.</p>
          {controls.emergency_stop ? (
            <form action={emergencyRelease} className="mt-3"><p className="mb-2 text-sm text-bad">Engaged {ago(controls.stopped_at)}: {controls.stop_reason}</p><Button tone="good">Release emergency stop</Button></form>
          ) : (
            <form action={emergencyStop} className="mt-3 flex flex-wrap gap-2"><input name="reason" placeholder="Reason" className="flex-1" /><Button tone="danger">Engage emergency stop</Button></form>
          )}
        </Card>
        <Card title="System">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Reasoning model</dt><dd>{llm}</dd></div>
            {workers.map((w) => <div key={w.id} className="flex justify-between"><dt className="text-muted">{w.id}</dt><dd>heartbeat {ago(w.last_heartbeat)} · {w.tasks_done} tasks</dd></div>)}
            {!workers.length && <p className="text-warn">No worker has ever run. Start it with <code>pnpm worker</code>.</p>}
          </dl>
        </Card>
        <Card title="Integrations">
          <Table head={["Integration", "Configured", "Env vars"]} rows={env.map(([n, ok, v]) => [n, <Badge key="b" tone={ok ? "active" : "x"}>{ok ? "yes" : "no"}</Badge>, <code key="c" className="text-xs text-muted">{v}</code>])} />
          <h3 className="mt-4 mb-2 text-xs uppercase tracking-wider text-faint">External actions</h3>
          <Table head={["Action", "Live integration"]} rows={integrationStatus().map((i) => [<code key="a" className="text-xs">{i.action}</code>, (i.action === "listing.publish" && wc.shopify) ? <Badge key="b" tone="active">available</Badge> : <span key="b" className="text-xs text-muted">sandbox / manual</span>])} />
        </Card>
        <Card title="Notifications" className="scroll-mt-4" >
          <div id="notifications" />
          <Table empty="No notifications." head={["", "Notification", "When", ""]} rows={notes.map((n) => [<Badge key="s">{n.severity}</Badge>,
            <div key="t" className={n.acknowledged ? "opacity-50" : ""}><div>{n.title}</div><div className="text-xs text-muted">{n.body}</div></div>, <span key="w" className="text-muted">{ago(n.created_at)}</span>,
            !n.acknowledged ? <form key="a" action={ackNotification}><input type="hidden" name="id" value={n.id} /><Button>Dismiss</Button></form> : null])} />
        </Card>
      </div>
    </>
  );
}

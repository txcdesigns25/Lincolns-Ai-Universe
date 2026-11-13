import type { Queryable } from "./db.js";
import { notifyOwnerTelegram } from "./telegram.js";

/**
 * Store a notification (deduplicated) and push it to NOTIFY_WEBHOOK_URL if set
 * (works with Slack/Discord-style incoming webhooks).
 */
export async function notify(q: Queryable, n: { severity: "info" | "warning" | "critical"; agentId?: string; title: string; body?: string; dedupeKey?: string }) {
  const r = await q.query(
    `INSERT INTO notifications (severity, agent_id, title, body, dedupe_key) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.severity, n.agentId ?? null, n.title, n.body ?? "", n.dedupeKey ?? null]);
  if (!r.rowCount) return;
  if (n.severity !== "info") await notifyOwnerTelegram(`AI Universe ${n.severity}: ${n.title}${n.body ? `\n${n.body}` : ""}`).catch(() => {});
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[AI Universe ${n.severity}] ${n.title}${n.body ? `\n${n.body}` : ""}`, content: `[AI Universe ${n.severity}] ${n.title}` }) });
    await q.query(`UPDATE notifications SET delivered = TRUE WHERE id = $1`, [r.rows[0].id]);
  } catch { /* delivery is best-effort; it stays visible in the dashboard */ }
}

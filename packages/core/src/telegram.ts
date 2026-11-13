/**
 * Telegram remote control. Uses long polling (no public URL needed), runs
 * inside the worker, and only obeys the owner's numeric Telegram user id.
 *
 * Deliberately limited: Telegram can pause/resume, stop everything, ask agents
 * questions, and approve LOW-RISK requests. Money-related approvals, budget
 * changes, live mode, and releasing the emergency stop are dashboard-only, so
 * a lost or hijacked phone cannot unlock spending.
 */
import type { Db, Queryable } from "./db.js";
import { AGENTS, AGENT_BY_ID } from "./agents.js";
import { decideApproval } from "./approvals.js";
import { engageEmergencyStop } from "./controls.js";
import { enqueue } from "./queue.js";
import { audit } from "./audit.js";
import { getFinancials, } from "./ledger.js";
import { globalMonthSpend } from "./budget.js";

export const DASHBOARD_ONLY_ACTIONS = new Set(["budget.change", "purchase.new", "ads.launch", "contract.enter", "refund.significant", "permissions.change", "deploy.production", "data.access_sensitive"]);

const ALIASES: Record<string, string> = {
  ceo: "ceo", store: "digital_store", a01: "digital_store", shop: "digital_store", web: "web_agency", a02: "web_agency", website: "web_agency",
  content: "content_agency", a03: "content_agency", seo: "seo_agency", a04: "seo_agency", support: "support_agency", a05: "support_agency",
  marketing: "marketing_agency", a06: "marketing_agency", automation: "automation_agency", a07: "automation_agency",
};
export function resolveAgent(word?: string): string | null {
  if (!word) return null;
  const w = word.toLowerCase().replace(/^@/, "");
  return ALIASES[w] ?? (AGENT_BY_ID[w] ? w : null);
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
export type Send = (chatId: number, text: string) => Promise<void>;

const HELP = `AI Universe commands:
/status – money, agents, approvals
Plain text goes to the CEO. Reply (swipe left) to any agent's message to keep chatting with that agent.
/ask <agent> <message> – start a chat with a specific agent
/pause <agent|all>   /resume <agent|all>
/approvals – list pending requests
/approve <id>   /reject <id>  (money/legal approvals: dashboard only)
/activity – what the agents did recently
/updates on|off – short message each time an agent finishes work
/boost <agent> on|off – use the stronger model for an important project
/stop <reason> – emergency stop (release it from the dashboard)
Agents: ceo, store, web, content, seo, support, marketing, automation`;

export async function handleTelegramUpdate(db: Db, update: any, send: Send, ownerId = process.env.TELEGRAM_OWNER_ID?.trim()) {
  const msg = update?.message;
  if (!msg?.text || !msg.from) return;
  const chatId: number = msg.chat.id;
  if (!ownerId || String(msg.from.id) !== String(ownerId) || msg.chat.type !== "private") {
    await audit(db, { actor: `telegram:${msg.from.id}`, action: "telegram.message", outcome: "denied", details: { reason: "not owner" } });
    // Tell the sender their id so a mistyped TELEGRAM_OWNER_ID is easy to fix. Grants nothing.
    if (msg.chat.type === "private")
      await send(chatId, `Not authorized. Your Telegram user id is ${msg.from.id}. If this is your bot, set TELEGRAM_OWNER_ID=${msg.from.id} on the worker.`);
    return;
  }
  const text: string = msg.text.trim();
  // Replying to one of the bot's messages continues the chat with the agent that sent it.
  const repliedTo = msg.reply_to_message?.message_id;
  if (repliedTo && !text.startsWith("/")) {
    const orig = (await db.query(`SELECT agent_id FROM telegram_messages WHERE chat_id = $1 AND message_id = $2`, [chatId, repliedTo])).rows[0];
    const agentId = orig?.agent_id ?? null;
    if (agentId) return askAgent(db, agentId, text, chatId, send, { inReplyTo: String(msg.reply_to_message?.text ?? "").slice(0, 1500) });
  }
  const [cmdRaw, ...rest] = text.split(/\s+/);
  // Accept commands with or without the slash ("status" works like "/status").
  const BARE = new Set(["status", "help", "start", "agents", "approvals", "pause", "resume", "approve", "reject", "stop", "ask", "boost", "activity", "updates", "commands"]);
  const first = cmdRaw.toLowerCase().replace(/^\//, "").split("@")[0];
  const cmd = cmdRaw.startsWith("/") || BARE.has(first) ? (first === "commands" ? "help" : first) : "";
  const arg = rest.join(" ");
  await audit(db, { actor: "owner:telegram", action: `telegram.${cmd || "text"}`, outcome: "info", details: { text: text.slice(0, 200) } });

  switch (cmd) {
    case "start": case "help": return send(chatId, HELP);
    case "status": return send(chatId, await statusText(db));
    case "agents": return send(chatId, await statusText(db));
    case "pause": case "resume": {
      const status = cmd === "pause" ? "paused" : "active";
      if (rest[0]?.toLowerCase() === "all") {
        await db.query(`UPDATE agents SET status = $1, updated_at = now() WHERE status IN ('active','paused')`, [status]);
        return send(chatId, `All agents ${status}.`);
      }
      const id = resolveAgent(rest[0]);
      if (!id) return send(chatId, `Which agent? e.g. /${cmd} seo`);
      await db.query(`UPDATE agents SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
      return send(chatId, `${AGENT_BY_ID[id].name} ${status}.`);
    }
    case "boost": {
      const id = resolveAgent(rest[0]);
      const on = rest[1]?.toLowerCase();
      if (!id || (on !== "on" && on !== "off")) return send(chatId, "Usage: /boost store on   (or off). Boosted agents use the stronger model, still within all budget caps.");
      await db.query(`UPDATE agents SET boost = $2, updated_at = now() WHERE id = $1`, [id, on === "on"]);
      await audit(db, { actor: "owner:telegram", agentId: id, action: `agent.boost.${on}`, outcome: "info" });
      return send(chatId, `${AGENT_BY_ID[id].name}: boost ${on}. ${on === "on" ? "It now uses the stronger model." : "Back to the cheap model."}`);
    }
    case "activity": case "log": return send(chatId, await activityText(db));
    case "updates": {
      const v = rest[0]?.toLowerCase();
      if (v !== "on" && v !== "off") return send(chatId, `Agent updates are ${(await updatesOn(db)) ? "on" : "off"}. Send /updates on or /updates off. Approvals, blockers, errors and the daily CEO summary always come through.`);
      await db.query(`INSERT INTO kv_store (key, value) VALUES ('telegram_updates', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(v)]);
      return send(chatId, v === "on" ? "Agent updates on. You'll get a short line each time an agent finishes work." : "Agent updates off. You'll still get approvals, blockers, errors and the daily CEO summary.");
    }
    case "approvals": {
      const rows = (await db.query(`SELECT id, agent_id, action, summary, amount_cents FROM approvals WHERE status = 'pending' ORDER BY created_at LIMIT 15`)).rows;
      if (!rows.length) return send(chatId, "No pending approvals.");
      return send(chatId, rows.map((r) => `${r.id.slice(0, 8)} · ${AGENT_BY_ID[r.agent_id]?.code} · ${r.summary}${r.amount_cents ? ` (${money(r.amount_cents)})` : ""}${DASHBOARD_ONLY_ACTIONS.has(r.action) ? " [dashboard only]" : ""}`).join("\n"));
    }
    case "approve": case "reject": {
      const prefix = (rest[0] ?? "").toLowerCase();
      if (prefix.length < 6) return send(chatId, `Use the id from /approvals, e.g. /${cmd} 1a2b3c4d`);
      const rows = (await db.query(`SELECT id, action, summary FROM approvals WHERE status = 'pending' AND id::text LIKE $1`, [`${prefix}%`])).rows;
      if (rows.length !== 1) return send(chatId, rows.length ? "That id matches more than one request; use more characters." : "No pending request with that id.");
      const a = rows[0];
      if (cmd === "approve" && DASHBOARD_ONLY_ACTIONS.has(a.action))
        return send(chatId, `"${a.summary}" involves money or legal commitments. For safety, approve it in the dashboard.`);
      await decideApproval(db, a.id, cmd === "approve" ? "approved" : "rejected", "owner", "via Telegram");
      return send(chatId, `${cmd === "approve" ? "Approved" : "Rejected"}: ${a.summary}`);
    }
    case "stop": {
      await engageEmergencyStop(db, "owner", arg || "Engaged from Telegram");
      return send(chatId, "Emergency stop engaged. All agent spending and external actions are blocked. Release it from the dashboard Settings page.");
    }
    case "release": return send(chatId, "For safety, release the emergency stop from the dashboard Settings page.");
    case "budget": case "limit": case "limits": return send(chatId, "Budgets can only be changed in the dashboard.");
    case "ask": {
      const id = resolveAgent(rest[0]);
      if (!id) return send(chatId, "Usage: /ask seo find three keyword ideas for plumbers");
      return askAgent(db, id, rest.slice(1).join(" "), chatId, send);
    }
    case "": {
      const maybe = resolveAgent(rest.length ? cmdRaw.replace(/[,:]$/, "") : undefined);
      if (maybe) return askAgent(db, maybe, arg, chatId, send);
      return askAgent(db, "ceo", text, chatId, send);
    }
    default: return send(chatId, HELP);
  }
}

/** Recent Telegram conversation between the owner and one agent, oldest first. */
export async function chatHistory(db: Db, agentId: string, chatId: number, limit = agentId === "ceo" ? 20 : 8) {
  const rows = (await db.query(
    `SELECT direction, text FROM telegram_messages WHERE agent_id = $1 AND chat_id = $2 AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC LIMIT $3`, [agentId, chatId, limit])).rows.reverse();
  return rows.map((r) => `${r.direction === "in" ? "Owner" : "You"}: ${r.text.slice(0, 600)}`);
}

async function askAgent(db: Db, agentId: string, message: string, chatId: number, send: Send, ctx: { inReplyTo?: string } = {}) {
  if (message.length < 2) return send(chatId, "What should the agent do?");
  const status = (await db.query(`SELECT status FROM agents WHERE id = $1`, [agentId])).rows[0]?.status;
  const history = await chatHistory(db, agentId, chatId);
  await db.query(`INSERT INTO telegram_messages (chat_id, agent_id, direction, text) VALUES ($1,$2,'in',$3)`, [chatId, agentId, message.slice(0, 4000)]);
  await enqueue(db, { agentId, type: "directive", title: `Owner chat: ${message.slice(0, 80)}`,
    payload: {
      instructions: message, from: "owner via Telegram", reply_to_telegram_chat: chatId,
      chat_mode: "This is a live two-way chat with the owner on Telegram. Your final message is sent to them as your reply: answer directly and briefly, like a text message. Do any work they ask for with your tools first. If you need something from them, ask one clear question at the end; their reply comes back to you.",
      ...(history.length ? { conversation_so_far: history } : {}),
      ...(ctx.inReplyTo ? { replying_to_your_message: ctx.inReplyTo } : {}),
    }, priority: 1, createdBy: "owner" });
  await sendTyping(chatId);
  const short = Object.entries(ALIASES).find(([, v]) => v === agentId)?.[0] ?? agentId;
  if (status !== "active")
    return send(chatId, `Queued for ${AGENT_BY_ID[agentId].name}, but it's ${status}, so it won't answer yet.\nSend "/resume ${short}" to let it work (it uses AI budget), or "/resume all" for every agent. Your message will run as soon as it's resumed.`);
  // Direct chat: no "on it" message. The typing indicator shows, then the agent's reply arrives.
  if (agentId === "ceo" || history.length || ctx.inReplyTo) return;
  return send(chatId, `${AGENT_BY_ID[agentId].name} is on it. Reply to its answer to keep chatting.`);
}

export async function updatesOn(db: Db): Promise<boolean> {
  const v = (await db.query(`SELECT value FROM kv_store WHERE key = 'telegram_updates'`)).rows[0]?.value;
  return v !== "off";
}

const shortName = (id: string) => Object.entries(ALIASES).find(([, v]) => v === id)?.[0] ?? id;
const clip = (t: string, n: number) => { const x = (t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };

/** Recent work across agents: finished, failed, waiting tasks from the last 24 hours. */
export async function activityText(db: Db) {
  const rows = (await db.query(
    `SELECT agent_id, title, status, cost_cents, result->>'summary' AS summary, last_error, COALESCE(finished_at, created_at) AS at
       FROM tasks WHERE type <> 'health_check' AND COALESCE(finished_at, created_at) > now() - interval '24 hours'
        AND status IN ('succeeded','failed','dead','waiting_approval','running')
      ORDER BY at DESC LIMIT 12`)).rows;
  if (!rows.length) return "No agent activity in the last 24 hours. Agents only work when resumed (/resume all).";
  const icon: Record<string, string> = { succeeded: "✅", failed: "⚠️", dead: "❌", waiting_approval: "⏳", running: "🔄" };
  const ago = (d: Date) => { const m = Math.round((Date.now() - +new Date(d)) / 60000); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };
  return "Last 24 hours:\n\n" + rows.map((r) => {
    const detail = r.status === "succeeded" ? clip(r.summary ?? "", 140) : r.status === "waiting_approval" ? "waiting for your approval" : r.status === "running" ? "working now" : clip((r.last_error ?? "").split("\n")[0], 100);
    return `${icon[r.status] ?? "•"} ${shortName(r.agent_id)} · ${clip(r.title, 60)} (${ago(r.at)} ago${r.cost_cents ? `, ${money(r.cost_cents)}` : ""})${detail ? `\n   ${detail}` : ""}`;
  }).join("\n");
}

/** Push approval requests the owner has not been told about yet, with buttons where Telegram may decide. */
export async function pushPendingApprovals(db: Db, sendButtons: (chatId: number, text: string, buttons: { text: string; callback_data: string }[][]) => Promise<unknown> = telegramSendButtons): Promise<number> {
  if (!telegramConfigured()) return 0;
  const rows = (await db.query(
    `UPDATE approvals SET notified_at = now() WHERE id IN (
       SELECT id FROM approvals WHERE status = 'pending' AND notified_at IS NULL ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
     RETURNING id, agent_id, action, summary, amount_cents, details`)).rows;
  const owner = Number(process.env.TELEGRAM_OWNER_ID);
  for (const r of rows) {
    const dashOnly = DASHBOARD_ONLY_ACTIONS.has(r.action);
    const why = r.details?.reason ?? r.details?.justification ?? r.details?.expected_benefit;
    const text = `⏳ ${AGENT_BY_ID[r.agent_id]?.name ?? r.agent_id} is asking for approval\n\n${r.summary}${r.amount_cents ? `\nAmount: ${money(r.amount_cents)}` : ""}${why ? `\nWhy: ${clip(String(why), 300)}` : ""}\n\n${dashOnly ? "This involves money or legal commitments, so approve it in the dashboard (Approvals). You can reject it here." : "Tap to decide."}`;
    const buttons = dashOnly ? [[{ text: "Reject", callback_data: `rj:${r.id}` }]] : [[{ text: "✅ Approve", callback_data: `ap:${r.id}` }, { text: "Reject", callback_data: `rj:${r.id}` }]];
    if (sendButtons === telegramSendButtons) await sendFromAgent(db, owner, r.agent_id, text, { buttons, label: false });
    else await sendButtons(owner, text, buttons).catch(() => {});
  }
  return rows.length;
}

/** A tapped Approve/Reject button. Same rules as /approve and /reject. Returns the text to show. */
export async function handleTelegramCallback(db: Db, cq: any, ownerId = process.env.TELEGRAM_OWNER_ID?.trim()): Promise<string> {
  if (!ownerId || String(cq?.from?.id) !== String(ownerId)) {
    await audit(db, { actor: `telegram:${cq?.from?.id}`, action: "telegram.callback", outcome: "denied", details: { reason: "not owner" } });
    return "Not authorized.";
  }
  const [kind, id] = String(cq.data ?? "").split(":");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "") || (kind !== "ap" && kind !== "rj")) return "Unknown button.";
  const a = (await db.query(`SELECT id, action, summary, status FROM approvals WHERE id = $1`, [id])).rows[0];
  if (!a) return "That request no longer exists.";
  if (a.status !== "pending") return `Already ${a.status}: ${a.summary}`;
  if (kind === "ap" && DASHBOARD_ONLY_ACTIONS.has(a.action)) return `"${a.summary}" involves money or legal commitments. Approve it in the dashboard.`;
  await audit(db, { actor: "owner:telegram", action: `telegram.button.${kind}`, outcome: "info", details: { approval_id: id } });
  await decideApproval(db, id, kind === "ap" ? "approved" : "rejected", "owner", "via Telegram button");
  return `${kind === "ap" ? "✅ Approved" : "Rejected"}: ${a.summary}`;
}

/**
 * After a task finishes: the CEO's daily summary always goes to the owner;
 * other scheduled agent work sends a one-line update unless /updates off.
 * Owner requests are answered separately (reply_to_telegram_chat).
 */
export async function pushTaskUpdate(db: Db, task: { agent_id: string; type: string; title: string; created_by: string; payload?: any; id?: string }, result: any,
  send: Send = (c, t) => sendFromAgent(db, c, task.agent_id, t, { taskId: task.id, label: false }).then(() => {})) {
  if (!telegramConfigured() || task.payload?.reply_to_telegram_chat || task.type === "health_check" || task.type === "execute_action" || task.type === "owner_check_in") return;
  const owner = Number(process.env.TELEGRAM_OWNER_ID);
  const summary = String(result?.summary ?? "").trim();
  if (task.agent_id === "ceo" && task.type === "daily_summary") return send(owner, `📋 Daily summary from the CEO\n\n${clip(summary || "No summary produced.", 3500)}`);
  if (task.created_by === "owner" || !(await updatesOn(db))) return;
  return send(owner, `✅ ${AGENT_BY_ID[task.agent_id]?.name ?? task.agent_id} finished: ${clip(task.title, 60)}${result?.cost_cents ? ` (${money(result.cost_cents)})` : ""}${summary ? `\n${clip(summary, 300)}` : ""}`);
}

async function statusText(db: Db) {
  const [controls, month, fin, agents, pending] = await Promise.all([
    db.query(`SELECT * FROM system_controls WHERE id`).then((r) => r.rows[0]),
    globalMonthSpend(db),
    getFinancials(db),
    db.query(`SELECT a.id, a.code, a.name, a.status, t.title FROM agents a LEFT JOIN tasks t ON t.id = a.current_task_id ORDER BY a.code`).then((r) => r.rows),
    db.query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'`).then((r) => r.rows[0].n),
  ]);
  return [
    controls.emergency_stop ? "EMERGENCY STOP ENGAGED" : null,
    `Verified revenue ${money(fin.grossRevenue)} · expenses ${money(fin.totalExpenses)} · profit ${money(fin.netProfit)}`,
    `Agent spend this month ${money(month)} of ${money(controls.global_monthly_limit)}`,
    `Pending approvals: ${pending}`,
    "",
    ...agents.map((a) => `${a.code} ${a.name}: ${a.status}${a.title ? ` · ${a.title}` : ""}`),
  ].filter((l) => l !== null).join("\n");
}

// ───── Transport ─────

export function telegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_ID);
}

export const telegramSend: Send = async (chatId, text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
};

export async function telegramSendButtons(chatId: number, text: string, buttons: { text: string; callback_data: string }[][]): Promise<number | null> {
  return rawSend(chatId, text, { inline_keyboard: buttons });
}

/** Low-level send. Returns Telegram's message_id so replies can be routed. Replaceable in tests. */
const defaultRawSend = async (chatId: number, text: string, replyMarkup?: unknown): Promise<number | null> => {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
  });
  const j: any = await r.json().catch(() => null);
  return j?.result?.message_id ?? null;
};
export let rawSend = defaultRawSend;
export function setTelegramTransport(fn: typeof rawSend) { rawSend = fn; }

/** Show "typing…" in the chat while the agent works. Best effort. */
export async function sendTyping(chatId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || rawSend !== defaultRawSend) return;
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }) }).catch(() => {});
}

/**
 * Send a message on behalf of an agent: labeled with the agent's name and
 * remembered, so replying to it in Telegram goes back to that agent.
 */
export async function sendFromAgent(db: Queryable, chatId: number, agentId: string | null, text: string,
  opts: { taskId?: string | null; buttons?: { text: string; callback_data: string }[][]; label?: boolean } = {}) {
  const name = agentId ? AGENT_BY_ID[agentId]?.name ?? agentId : null;
  const body = name && opts.label !== false ? `${name}:\n${text}` : text;
  const messageId = await rawSend(chatId, body, opts.buttons ? { inline_keyboard: opts.buttons } : undefined).catch(() => null);
  await db.query(`INSERT INTO telegram_messages (chat_id, message_id, agent_id, task_id, direction, text) VALUES ($1,$2,$3,$4,'out',$5)
                     ON CONFLICT DO NOTHING`, [chatId, messageId, agentId, opts.taskId ?? null, text.slice(0, 4000)]).catch(() => {});
  return messageId;
}

async function tgCall(method: string, body: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function notifyOwnerTelegram(text: string, ctx?: { db: Queryable; agentId?: string | null }) {
  if (!telegramConfigured()) return;
  const owner = Number(process.env.TELEGRAM_OWNER_ID);
  if (ctx?.db) { await sendFromAgent(ctx.db, owner, ctx.agentId ?? null, text, { label: false }); return; }
  await telegramSend(owner, text);
}

/**
 * Called once at worker start: verifies the token, removes any webhook (a set
 * webhook makes getUpdates fail), and returns the bot's username for the logs.
 */
export async function initTelegram(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN!.trim();
  const me: any = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
  if (!me.ok) throw new Error(`Telegram token rejected: ${me.description} (check TELEGRAM_BOT_TOKEN on the worker)`);
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  if (!/^\d+$/.test(String(process.env.TELEGRAM_OWNER_ID ?? "").trim()))
    throw new Error("TELEGRAM_OWNER_ID must be your numeric user id (from @userinfobot), not a username");
  return me.result.username;
}

/** One long-poll round. Offset is stored in Postgres so restarts don't replay commands. */
export async function pollTelegramOnce(db: Db, timeoutSec = 25) {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const offset = (await db.query(`SELECT value FROM kv_store WHERE key = 'telegram_offset'`)).rows[0]?.value ?? 0;
  const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getUpdates?timeout=${timeoutSec}&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`);
  const json: any = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description}`);
  for (const u of json.result) {
    await db.query(`INSERT INTO kv_store (key, value) VALUES ('telegram_offset', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(u.update_id + 1)]);
    if (u.callback_query) {
      const cq = u.callback_query;
      let reply: string;
      try { reply = await handleTelegramCallback(db, cq); } catch (e: any) { reply = `Error: ${e.message}`; }
      await tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: reply.slice(0, 190) }).catch(() => {});
      if (cq.message && String(cq.from?.id) === String(process.env.TELEGRAM_OWNER_ID?.trim()))
        await tgCall("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `${cq.message.text ?? ""}\n\n${reply}`.slice(0, 4000) }).catch(() => {});
      continue;
    }
    try { await handleTelegramUpdate(db, u, telegramSend); }
    catch (e: any) { await telegramSend(u.message?.chat?.id, `Error: ${e.message}`).catch(() => {}); }
  }
  return json.result.length as number;
}



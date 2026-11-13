import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  handleTelegramUpdate, handleTelegramCallback, pushPendingApprovals, pushTaskUpdate, activityText, requestApproval,
  enqueue, type Db,
} from "../src/index.js";
import { executeTool } from "../src/tools/index.js";
import { freshDb } from "./helpers.js";

let db: Db;
const OWNER = "4242";
const sent: string[] = [];
const send = async (_: number, t: string) => { sent.push(t); };
const msg = (text: string) => ({ message: { text, from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: "private" } } });

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "test"; process.env.TELEGRAM_OWNER_ID = OWNER;
  db = await freshDb(); await db.query(`UPDATE schedules SET enabled = FALSE`);
});
afterAll(async () => { delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_OWNER_ID; await db.end(); });

describe("Telegram push updates", () => {
  it("pushes each new approval request once, with buttons only where Telegram may approve", async () => {
    const low = await requestApproval(db, { agentId: "content_agency", action: "content.publish_approved", summary: "Publish post A", idempotencyKey: "u1" });
    const money = await requestApproval(db, { agentId: "digital_store", action: "purchase.new", summary: "Buy a theme", amountCents: 500, idempotencyKey: "u2" });
    const pushes: { text: string; buttons: any }[] = [];
    const sb = async (_c: number, text: string, buttons: any) => { pushes.push({ text, buttons }); };
    expect(await pushPendingApprovals(db, sb)).toBe(2);
    expect(await pushPendingApprovals(db, sb)).toBe(0);       // not repeated
    const lowPush = pushes.find((p) => p.text.includes("Publish post A"))!;
    expect(lowPush.buttons[0].map((b: any) => b.callback_data)).toEqual([`ap:${low.id}`, `rj:${low.id}`]);
    const moneyPush = pushes.find((p) => p.text.includes("Buy a theme"))!;
    expect(moneyPush.buttons[0].map((b: any) => b.callback_data)).toEqual([`rj:${money.id}`]);
    expect(moneyPush.text).toMatch(/dashboard/);
  });

  it("buttons decide approvals for the owner only, and never money approvals", async () => {
    const a = (await db.query(`SELECT id FROM approvals WHERE idempotency_key = 'u1'`)).rows[0].id;
    const m = (await db.query(`SELECT id FROM approvals WHERE idempotency_key = 'u2'`)).rows[0].id;
    expect(await handleTelegramCallback(db, { from: { id: 999 }, data: `ap:${a}` }, OWNER)).toBe("Not authorized.");
    expect(await handleTelegramCallback(db, { from: { id: 4242 }, data: `ap:${m}` }, OWNER)).toMatch(/dashboard/);
    expect((await db.query(`SELECT status FROM approvals WHERE id = $1`, [m])).rows[0].status).toBe("pending");
    expect(await handleTelegramCallback(db, { from: { id: 4242 }, data: `ap:${a}` }, OWNER)).toMatch(/Approved/);
    expect(await handleTelegramCallback(db, { from: { id: 4242 }, data: `ap:${a}` }, OWNER)).toMatch(/Already approved/);
    expect(await handleTelegramCallback(db, { from: { id: 4242 }, data: `rj:${m}` }, OWNER)).toMatch(/Rejected/);
  });

  it("sends the CEO daily summary always, and agent updates unless turned off", async () => {
    sent.length = 0;
    await pushTaskUpdate(db, { agent_id: "ceo", type: "daily_summary", title: "Daily", created_by: "scheduler" }, { summary: "All quiet." }, send);
    await pushTaskUpdate(db, { agent_id: "seo_agency", type: "growth_cycle", title: "Growth cycle", created_by: "scheduler" }, { summary: "Found 3 keywords", cost_cents: 1 }, send);
    expect(sent[0]).toMatch(/Daily summary from the CEO[\s\S]*All quiet/);
    expect(sent[1]).toMatch(/SEO.*finished: Growth cycle[\s\S]*Found 3 keywords/);
    await handleTelegramUpdate(db, msg("/updates off"), send, OWNER);
    sent.length = 0;
    await pushTaskUpdate(db, { agent_id: "seo_agency", type: "growth_cycle", title: "Growth cycle", created_by: "scheduler" }, { summary: "x" }, send);
    await pushTaskUpdate(db, { agent_id: "ceo", type: "daily_summary", title: "Daily", created_by: "scheduler" }, { summary: "Still sent." }, send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Still sent/);
    await handleTelegramUpdate(db, msg("updates on"), send, OWNER);
  });

  it("/activity lists recent agent work", async () => {
    await enqueue(db, { agentId: "web_agency", type: "directive", title: "Audit landing page" });
    await db.query(`UPDATE tasks SET status = 'succeeded', finished_at = now(), result = '{"summary":"Fixed two headlines"}' WHERE title = 'Audit landing page'`);
    const text = await activityText(db);
    expect(text).toMatch(/web · Audit landing page[\s\S]*Fixed two headlines/);
    sent.length = 0;
    await handleTelegramUpdate(db, msg("activity"), send, OWNER);
    expect(sent[0]).toMatch(/Last 24 hours/);
  });

  it("agents can tell the owner they are blocked, at most twice a day", async () => {
    const ctx = { db, agentId: "digital_store", taskId: null as any };
    const tools = ["tell_owner_blocked"];
    const input = { need: "Access to a separate Shopify dev store", why: "Needed to create the first product" };
    await executeTool(ctx as any, tools, "tell_owner_blocked", input);
    await executeTool(ctx as any, tools, "tell_owner_blocked", { ...input, need: "A product photo for the listing" });
    await expect(executeTool(ctx as any, tools, "tell_owner_blocked", input)).rejects.toMatchObject({ code: "owner_notify_limit" });
    const n = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE 'blocked:digital_store:%'`)).rows[0].n;
    expect(n).toBe(2);
  });
});

describe("two-way Telegram chat", () => {
  it("labels agent messages, and replying to one continues the chat with that agent", async () => {
    const { setTelegramTransport, sendFromAgent, rawSend } = await import("../src/telegram.js");
    const out: { id: number; text: string }[] = [];
    const orig = rawSend;
    setTelegramTransport(async (_c, text) => { out.push({ id: 1000 + out.length, text }); return 1000 + out.length - 1; });
    try {
      const mid = await sendFromAgent(db, 4242, "digital_store", "Which niche should I avoid?");
      expect(out[0].text).toMatch(/^Digital Product Store:\nWhich niche/);
      // Owner replies (Telegram reply) without naming the agent.
      await handleTelegramUpdate(db, { message: { text: "Avoid anything with cars", from: { id: 4242 }, chat: { id: 4242, type: "private" },
        reply_to_message: { message_id: mid, text: out[0].text } } }, send, OWNER);
      const t = (await db.query(`SELECT agent_id, payload FROM tasks WHERE title LIKE 'Owner chat: Avoid anything%'`)).rows[0];
      expect(t.agent_id).toBe("digital_store");
      expect(t.payload.replying_to_your_message).toMatch(/Which niche/);
      expect(t.payload.conversation_so_far.at(-1)).toBe("You: Which niche should I avoid?");
      expect(t.payload.reply_to_telegram_chat).toBe(4242);
      // Plain text without a reply still goes to the CEO.
      await handleTelegramUpdate(db, msg("how are we doing"), send, OWNER);
      expect((await db.query(`SELECT agent_id FROM tasks WHERE title = 'Owner chat: how are we doing'`)).rows[0].agent_id).toBe("ceo");
    } finally { setTelegramTransport(orig); }
  });

  it("an agent's 'needs you' alert can be answered by replying to it", async () => {
    const { setTelegramTransport, rawSend } = await import("../src/telegram.js");
    const orig = rawSend; let n = 5000;
    setTelegramTransport(async () => n++);
    try {
      const { notify } = await import("../src/notify.js");
      await notify(db, { severity: "warning", agentId: "seo_agency", title: "SEO Agency needs you: Search Console access", dedupeKey: "chat-test" });
      const row = (await db.query(`SELECT message_id, agent_id FROM telegram_messages WHERE agent_id = 'seo_agency' ORDER BY id DESC LIMIT 1`)).rows[0];
      await handleTelegramUpdate(db, { message: { text: "Added you as a user", from: { id: 4242 }, chat: { id: 4242, type: "private" },
        reply_to_message: { message_id: Number(row.message_id), text: "x" } } }, send, OWNER);
      expect((await db.query(`SELECT agent_id FROM tasks WHERE title = 'Owner chat: Added you as a user'`)).rows[0].agent_id).toBe("seo_agency");
    } finally { setTelegramTransport(orig); }
  });
});

describe("direct chat with the CEO", () => {
  it("plain text goes straight to the CEO with no 'on it' message", async () => {
    sent.length = 0;
    await handleTelegramUpdate(db, msg("what should we focus on this week"), send, OWNER);
    expect(sent).toHaveLength(0);
    const t = (await db.query(`SELECT agent_id, priority FROM tasks WHERE title = 'Owner chat: what should we focus on this week'`)).rows[0];
    expect(t).toEqual({ agent_id: "ceo", priority: 1 });
  });

  it("the CEO can message the owner first, at most 6 times a day, and replies continue the chat", async () => {
    const { setTelegramTransport, rawSend } = await import("../src/telegram.js");
    const orig = rawSend; let n = 9000; const texts: string[] = [];
    setTelegramTransport(async (_c, t) => { texts.push(t); return n++; });
    try {
      const ctx = { db, agentId: "ceo", taskId: null as any };
      for (let i = 0; i < 6; i++) await executeTool(ctx as any, ["message_owner"], "message_owner", { text: `Update number ${i}: store got first sale?` });
      await expect(executeTool(ctx as any, ["message_owner"], "message_owner", { text: "One more thing" })).rejects.toMatchObject({ code: "owner_message_limit" });
      expect(texts[0]).toMatch(/^Universe CEO:\nUpdate number 0/);
      await handleTelegramUpdate(db, { message: { text: "Great, keep going", from: { id: 4242 }, chat: { id: 4242, type: "private" },
        reply_to_message: { message_id: 9000, text: texts[0] } } }, send, OWNER);
      const t = (await db.query(`SELECT agent_id, payload FROM tasks WHERE title = 'Owner chat: Great, keep going'`)).rows[0];
      expect(t.agent_id).toBe("ceo");
      expect(t.payload.conversation_so_far.join("\n")).toMatch(/Update number 5/);
    } finally { setTelegramTransport(orig); }
  });
});

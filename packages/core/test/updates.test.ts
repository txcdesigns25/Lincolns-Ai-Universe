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

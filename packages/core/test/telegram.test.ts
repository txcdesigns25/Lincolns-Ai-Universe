import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handleTelegramUpdate, requestApproval, resolveAgent, type Db } from "../src/index.js";
import { freshDb } from "./helpers.js";

let db: Db;
const OWNER = "4242";
const sent: string[] = [];
const send = async (_: number, t: string) => { sent.push(t); };
const msg = (text: string, from = OWNER, type = "private") => ({ message: { text, from: { id: Number(from) }, chat: { id: Number(from), type } } });
const last = () => sent[sent.length - 1];

beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe("telegram remote control", () => {
  it("ignores everyone except the owner, and group chats", async () => {
    await handleTelegramUpdate(db, msg("/pause all", "999"), send, OWNER);
    await handleTelegramUpdate(db, msg("/pause all", OWNER, "group"), send, OWNER);
    expect(sent).toHaveLength(1);                 // stranger told their id, nothing else
    expect(sent[0]).toMatch(/Not authorized. Your Telegram user id is 999/);
    sent.length = 0;
    expect((await db.query(`SELECT count(*)::int AS n FROM agents WHERE status = 'paused'`)).rows[0].n).toBe(0);
  });
  it("pauses and resumes agents", async () => {
    await handleTelegramUpdate(db, msg("/pause seo"), send, OWNER);
    expect((await db.query(`SELECT status FROM agents WHERE id = 'seo_agency'`)).rows[0].status).toBe("paused");
    await handleTelegramUpdate(db, msg("/resume seo"), send, OWNER);
    expect((await db.query(`SELECT status FROM agents WHERE id = 'seo_agency'`)).rows[0].status).toBe("active");
  });
  it("routes plain text to the CEO and '/ask' to a named agent as tasks", async () => {
    await handleTelegramUpdate(db, msg("How are we doing this week?"), send, OWNER);
    await handleTelegramUpdate(db, msg("/ask store draft a budget planner listing"), send, OWNER);
    const t = (await db.query(`SELECT agent_id, payload FROM tasks WHERE type = 'directive' ORDER BY created_at`)).rows;
    expect(t.map((r) => r.agent_id)).toEqual(["ceo", "digital_store"]);
    expect(t[1].payload.reply_to_telegram_chat).toBe(Number(OWNER));
  });
  it("never approves money/legal requests from Telegram", async () => {
    const { id } = await requestApproval(db, { agentId: "marketing_agency", action: "ads.launch", summary: "Launch ads", amountCents: 1000 });
    await handleTelegramUpdate(db, msg(`/approve ${id.slice(0, 8)}`), send, OWNER);
    expect(last()).toMatch(/dashboard/);
    expect((await db.query(`SELECT status FROM approvals WHERE id = $1`, [id])).rows[0].status).toBe("pending");
  });
  it("can approve low-risk requests like publishing a draft", async () => {
    const { id } = await requestApproval(db, { agentId: "content_agency", action: "content.publish_approved", summary: "Post script" });
    await handleTelegramUpdate(db, msg(`/approve ${id.slice(0, 8)}`), send, OWNER);
    expect((await db.query(`SELECT status FROM approvals WHERE id = $1`, [id])).rows[0].status).toBe("approved");
  });
  it("can engage, but not release, the emergency stop; budgets are dashboard-only", async () => {
    await handleTelegramUpdate(db, msg("/stop away for the weekend"), send, OWNER);
    expect((await db.query(`SELECT emergency_stop FROM system_controls`)).rows[0].emergency_stop).toBe(true);
    await handleTelegramUpdate(db, msg("/release"), send, OWNER);
    expect((await db.query(`SELECT emergency_stop FROM system_controls`)).rows[0].emergency_stop).toBe(true);
    await handleTelegramUpdate(db, msg("/budget seo 500"), send, OWNER);
    expect(last()).toMatch(/dashboard/);
  });
  it("treats bare command words as commands and explains paused agents", async () => {
    await handleTelegramUpdate(db, msg("status"), send, OWNER);
    expect(last()).toMatch(/Pending approvals/);
    await db.query(`UPDATE agents SET status = 'paused' WHERE id = 'ceo'`);
    await handleTelegramUpdate(db, msg("what should we do first?"), send, OWNER);
    expect(last()).toMatch(/\/resume ceo/);
  });
  it("resolves agent aliases", () => {
    expect(resolveAgent("a04")).toBe("seo_agency");
    expect(resolveAgent("@store")).toBe("digital_store");
    expect(resolveAgent("nope")).toBeNull();
  });
});

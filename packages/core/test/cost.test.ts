import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  authorizeSpend, releaseStaleReservations, toolUse, enqueue, claimNext, runTask, tickScheduler, tierForTask, tiersFromEnv, handleTelegramUpdate, type Db, type LlmRequest,
} from "../src/index.js";
import { freshDb, setLimits } from "./helpers.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); await db.query(`UPDATE schedules SET enabled = FALSE`); });
afterAll(async () => { await db.end(); });

const big = { starting_budget: 1_000_000, daily_limit: 1_000_000, weekly_limit: 1_000_000, monthly_limit: 1_000_000, per_transaction_limit: 1_000_000, ai_monthly_limit: 1_000_000 };

async function drain() { await db.query(`UPDATE tasks SET status = 'cancelled' WHERE status IN ('queued','running')`); }

describe("cheap by default", () => {
  it("defaults to Haiku for routine work and Sonnet for important work, never Opus", () => {
    const t = tiersFromEnv({});
    expect(t.routine).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(t.important).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(tiersFromEnv({ CLAUDE_MODEL: "claude-sonnet-5-5", CLAUDE_MODEL_IMPORTANT: "claude-opus-5-5" }).important.model).toBe("claude-opus-5-5");
  });

  it("seeds conservative per-agent limits and a $1.50/day global AI cap", async () => {
    const b = (await db.query(`SELECT daily_limit, monthly_limit FROM agent_budgets WHERE agent_id = 'seo_agency'`)).rows[0];
    expect(b).toEqual({ daily_limit: 25, monthly_limit: 300 });
    expect((await db.query(`SELECT global_daily_limit FROM system_controls`)).rows[0].global_daily_limit).toBe(150);
  });

  it("staggers first runs so agents do not all fire at once", async () => {
    const r = (await db.query(`SELECT count(DISTINCT next_run_at)::int AS n, count(*)::int AS total,
      count(*) FILTER (WHERE next_run_at <= now())::int AS due FROM schedules WHERE task_type <> 'health_check'`)).rows[0];
    expect(r.n).toBe(r.total);
    expect(r.due).toBe(0);
  });

  it("enforces the global daily AI cap across agents", async () => {
    await setLimits(db, "seo_agency", big); await setLimits(db, "web_agency", big);
    await authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 100, reason: "a" });
    await expect(authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 51, reason: "b" }))
      .rejects.toMatchObject({ code: "global_daily_limit" });
    expect(await authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 50, reason: "c" })).toBeTruthy();
    await db.query(`DELETE FROM spend_authorizations WHERE status = 'reserved'`);
  });

  it("runs scheduled agent cycles one at a time", async () => {
    await db.query(`UPDATE schedules SET enabled = TRUE, next_run_at = now() - interval '1 hour' WHERE task_type = 'growth_cycle'`);
    await tickScheduler(db); await tickScheduler(db);
    const q = (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE created_by = 'scheduler' AND status = 'queued'`)).rows[0].n;
    expect(q).toBe(1);
    await drain();
    await tickScheduler(db);
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE created_by = 'scheduler' AND status = 'queued'`)).rows[0].n).toBe(1);
    await db.query(`UPDATE schedules SET enabled = FALSE`); await drain();
  });
});

describe("escalation to the stronger model", () => {
  const fakeLlm = () => {
    const calls: LlmRequest[] = [];
    return { calls, llm: {
      provider: "anthropic" as const, model: "claude-haiku-5-5", maxTokens: 1000,
      tierConfig: (t: "routine" | "important") => ({ model: t === "important" ? "claude-sonnet-5-5" : "claude-haiku-5-5", maxTokens: 1000, effort: "low" as const }),
      create: async (req: LlmRequest) => { calls.push(req); return { content: [{ type: "text", text: "ok", citations: null }] as any, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 }, model: req.tier === "important" ? "claude-sonnet-5-5" : "claude-haiku-5-5" }; },
    } };
  };

  it("routine tasks use the cheap model; agents cannot escalate themselves", async () => {
    await setLimits(db, "digital_store", big);
    const { llm, calls } = fakeLlm();
    await enqueue(db, { agentId: "digital_store", type: "directive", title: "ceo says important", payload: { important: true, from: "ceo" }, createdBy: "ceo" });
    const task = (await claimNext(db, "w"))!;
    const r: any = await runTask({ db, llm, workerId: "w" }, task);
    expect(calls[0].tier).toBe("routine");
    expect(r.model).toBe("claude-haiku-5-5");
  });

  it("owner boost, owner-flagged tasks and inbound leads use the stronger model", async () => {
    await db.query(`UPDATE agents SET boost = TRUE WHERE id = 'digital_store'`);
    await enqueue(db, { agentId: "digital_store", type: "growth_cycle", title: "boosted" });
    expect(await tierForTask(db, (await claimNext(db, "w"))!)).toBe("important");
    await db.query(`UPDATE agents SET boost = FALSE WHERE id = 'digital_store'`);
    await enqueue(db, { agentId: "digital_store", type: "directive", title: "owner flag", payload: { important: true }, createdBy: "owner" });
    expect(await tierForTask(db, (await claimNext(db, "w"))!)).toBe("important");
    await enqueue(db, { agentId: "digital_store", type: "inbound_lead", title: "lead" });
    expect(await tierForTask(db, (await claimNext(db, "w"))!)).toBe("important");
    await drain();
  });

  it("Telegram /boost toggles an agent", async () => {
    const sent: string[] = [];
    const msg = (text: string) => ({ message: { text, from: { id: 42 }, chat: { id: 42, type: "private" } } });
    await handleTelegramUpdate(db, msg("/boost store on"), async (_c, t) => { sent.push(t); }, "42");
    expect((await db.query(`SELECT boost FROM agents WHERE id = 'digital_store'`)).rows[0].boost).toBe(true);
    await handleTelegramUpdate(db, msg("boost store off"), async (_c, t) => { sent.push(t); }, "42");
    expect((await db.query(`SELECT boost FROM agents WHERE id = 'digital_store'`)).rows[0].boost).toBe(false);
  });
});

describe("accurate small charges", () => {
  it("does not round every cheap call up to a whole cent", async () => {
    await setLimits(db, "seo_agency", big);
    let i = 0;
    const llm = {
      provider: "anthropic" as const, model: "claude-haiku-5-5", maxTokens: 1000,
      tierConfig: () => ({ model: "claude-haiku-5-5", maxTokens: 1000, effort: "low" as const }),
      // 5 turns at 20k in / 2k out on Haiku = 0.3 cents each, 1.5 cents total
      create: async () => (++i < 5
        ? { content: [toolUse("search_memory", { query: "x" })] as any, stop_reason: "tool_use", usage: { input_tokens: 20_000, output_tokens: 2_000 }, model: "claude-haiku-5-5" }
        : { content: [{ type: "text", text: "ok", citations: null }] as any, stop_reason: "end_turn", usage: { input_tokens: 20_000, output_tokens: 2_000 }, model: "claude-haiku-5-5" }),
    };
    await enqueue(db, { agentId: "seo_agency", type: "directive", title: "frac" });
    const task = (await claimNext(db, "w"))!;
    await runTask({ db, llm, workerId: "w" }, task);
    const total = (await db.query(`SELECT COALESCE(SUM(settled_cents),0)::int AS c FROM spend_authorizations WHERE task_id = $1`, [task.id])).rows[0].c;
    expect(total).toBe(2); // 1.5 rounded up once, not 5 x 1
  });

  it("releases AI reservations left behind by a killed worker", async () => {
    await setLimits(db, "web_agency", big);
    const id = await authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 20, reason: "orphan" });
    await db.query(`UPDATE spend_authorizations SET created_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    expect(await releaseStaleReservations(db)).toBe(1);
    expect((await db.query(`SELECT status FROM spend_authorizations WHERE id = $1`, [id])).rows[0].status).toBe("released");
  });
});

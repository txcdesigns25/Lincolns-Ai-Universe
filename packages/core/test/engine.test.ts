import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  enqueue, claimNext, completeTask, failTask, recoverExpiredLeases, runTask, MockLlm, toolUse, text, tickScheduler,
  RetryableError, decideApproval, engageEmergencyStop, releaseEmergencyStop, type Db,
} from "../src/index.js";
import { freshDb, setLimits } from "./helpers.js";

let db: Db;
const big = { starting_budget: 1_000_000, daily_limit: 1_000_000, weekly_limit: 1_000_000, monthly_limit: 1_000_000, per_transaction_limit: 1_000_000, ai_monthly_limit: 1_000_000 };
beforeAll(async () => {
  db = await freshDb();
  await db.query(`UPDATE schedules SET enabled = FALSE`);      // keep the queue deterministic
  for (const a of ["digital_store", "web_agency", "seo_agency", "ceo"]) await setLimits(db, a, big);
});
afterAll(async () => { await db.end(); });

async function drain() { await db.query(`UPDATE tasks SET status = 'cancelled' WHERE status IN ('queued','running')`); }

describe("durable task queue", () => {
  it("duplicate enqueue with the same idempotency key creates one task", async () => {
    const a = await enqueue(db, { agentId: "digital_store", type: "directive", title: "x", idempotencyKey: "same" });
    const b = await enqueue(db, { agentId: "digital_store", type: "directive", title: "x", idempotencyKey: "same" });
    expect(a.id).toBe(b.id);
    expect(b.created).toBe(false);
    await drain();
  });

  it("two workers never claim the same task", async () => {
    for (let i = 0; i < 5; i++) await enqueue(db, { agentId: "digital_store", type: "directive", title: `t${i}` });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimNext(db, `w${i}`)));
    const ids = claims.filter(Boolean).map((t) => t!.id);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
    await drain();
  });

  it("retryable failures back off and retry, then dead-letter", async () => {
    const { id } = await enqueue(db, { agentId: "digital_store", type: "directive", title: "flaky", maxAttempts: 2 });
    let t = await claimNext(db, "w1");
    await failTask(db, id, "w1", "boom", { retryable: true, retryAfterMs: 0 });
    let row = (await db.query(`SELECT status, attempts FROM tasks WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    t = await claimNext(db, "w1");
    expect(t!.id).toBe(id);
    await failTask(db, id, "w1", "boom", { retryable: true, retryAfterMs: 0 });
    row = (await db.query(`SELECT status FROM tasks WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe("dead");
  });

  it("recovers tasks from a crashed worker (expired lease) and they persist", async () => {
    const { id } = await enqueue(db, { agentId: "digital_store", type: "directive", title: "crash" });
    await claimNext(db, "dying-worker", 1);
    await db.query(`UPDATE tasks SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await recoverExpiredLeases(db)).toBeGreaterThanOrEqual(1);
    const t = await claimNext(db, "healthy-worker");
    expect(t!.id).toBe(id);
    await completeTask(db, id, "healthy-worker", { ok: true });
    // A completion from the dead worker is ignored (lease no longer theirs).
    await completeTask(db, id, "dying-worker", { stale: true });
    const row = (await db.query(`SELECT status, result FROM tasks WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "succeeded", result: { ok: true } });
  });

  it("paused agents' tasks are not claimed; other agents keep working", async () => {
    await db.query(`UPDATE agents SET status = 'paused' WHERE id = 'web_agency'`);
    await enqueue(db, { agentId: "web_agency", type: "directive", title: "paused work" });
    const other = await enqueue(db, { agentId: "seo_agency", type: "directive", title: "other work" });
    const t = await claimNext(db, "w");
    expect(t!.id).toBe(other.id);
    expect(await claimNext(db, "w")).toBeNull();
    await db.query(`UPDATE agents SET status = 'active' WHERE id = 'web_agency'`);
    await drain();
  });

  it("scheduler enqueues each slot exactly once and fires once after downtime", async () => {
    await db.query(`UPDATE schedules SET enabled = TRUE, next_run_at = now() - interval '5 days' WHERE id = 'a01-growth-cycle'`);
    await Promise.all([tickScheduler(db), tickScheduler(db), tickScheduler(db)]);
    const n = (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE type = 'growth_cycle' AND agent_id = 'digital_store'`)).rows[0].n;
    expect(n).toBe(1);
    const next = (await db.query(`SELECT next_run_at > now() AS future FROM schedules WHERE id = 'a01-growth-cycle'`)).rows[0];
    expect(next.future).toBe(true);
    await db.query(`UPDATE schedules SET enabled = FALSE`);
    await drain();
  });
});

describe("agent engine with mocked Claude", () => {
  it("runs a tool loop, journals tools, records memory and drafts", async () => {
    const llm = new MockLlm((req, i) => i === 0
      ? { content: [toolUse("record_memory", { kind: "observation", title: "Planner demand", content: "Seen demand for planners" }),
                    toolUse("create_draft", { draft_type: "product_listing", title: "Weekly Planner", body: "A printable planner." })], stop_reason: "tool_use" }
      : { content: [text("Created a listing draft.")], stop_reason: "end_turn" });
    const { id } = await enqueue(db, { agentId: "digital_store", type: "growth_cycle", title: "cycle" });
    const task = (await claimNext(db, "w"))!;
    expect(task.id).toBe(id);
    const result: any = await runTask({ db, llm, workerId: "w" }, task);
    expect(result.summary).toContain("listing draft");
    expect(result.tool_calls.every((c: any) => c.ok)).toBe(true);
    expect(llm.calls[0].tools.map((t) => t.name)).not.toContain("assign_task"); // CEO-only tool hidden
    const drafts = (await db.query(`SELECT * FROM drafts WHERE task_id = $1`, [id])).rows;
    expect(drafts).toHaveLength(1);
    // Retrying the same task does not duplicate side effects.
    const llm2 = new MockLlm((req, i) => i === 0
      ? { content: [toolUse("create_draft", { draft_type: "product_listing", title: "Weekly Planner", body: "A printable planner." })], stop_reason: "tool_use" }
      : { content: [text("ok")], stop_reason: "end_turn" });
    await runTask({ db, llm: llm2, workerId: "w" }, task);
    expect((await db.query(`SELECT count(*)::int AS n FROM drafts WHERE task_id = $1`, [id])).rows[0].n).toBe(1);
    await completeTask(db, id, "w", result);
  });

  it("an agent calling a tool it does not have gets an error result, not access", async () => {
    const llm = new MockLlm((req, i) => i === 0
      ? { content: [toolUse("assign_task", { agent_id: "seo_agency", title: "hack", instructions: "do something sneaky" })], stop_reason: "tool_use" }
      : { content: [text("ok")], stop_reason: "end_turn" });
    await enqueue(db, { agentId: "web_agency", type: "directive", title: "try escalate" });
    const task = (await claimNext(db, "w"))!;
    const result: any = await runTask({ db, llm, workerId: "w" }, task);
    expect(result.tool_calls[0]).toMatchObject({ tool: "assign_task", ok: false });
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE title = 'hack'`)).rows[0].n).toBe(0);
    await completeTask(db, task.id, "w", result);
  });

  it("submitting a listing creates an approval; nothing publishes until the owner approves", async () => {
    const draft = (await db.query(`SELECT id FROM drafts WHERE draft_type = 'product_listing' LIMIT 1`)).rows[0];
    const llm = new MockLlm((req, i) => i === 0
      ? { content: [toolUse("submit_draft", { draft_id: draft.id, justification: "Strong demand signal for planners" })], stop_reason: "tool_use" }
      : { content: [text("submitted")], stop_reason: "end_turn" });
    await enqueue(db, { agentId: "digital_store", type: "directive", title: "submit" });
    const task = (await claimNext(db, "w"))!;
    await runTask({ db, llm, workerId: "w" }, task);
    await completeTask(db, task.id, "w", {});
    const appr = (await db.query(`SELECT * FROM approvals WHERE details->>'draft_id' = $1`, [draft.id])).rows[0];
    expect(appr).toMatchObject({ status: "pending", action: "listing.publish" });
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE type = 'execute_action'`)).rows[0].n).toBe(0);

    await decideApproval(db, appr.id, "approved", "owner");
    const exec = (await claimNext(db, "w"))!;
    expect(exec.type).toBe("execute_action");
    const res: any = await runTask({ db, llm: new MockLlm(), workerId: "w" }, exec);
    expect(res.sandbox).toBe(true);   // agent is in sandbox mode: simulated publish only
    await completeTask(db, exec.id, "w", res);
    const d = (await db.query(`SELECT status, sandbox_publish FROM drafts WHERE id = $1`, [draft.id])).rows[0];
    expect(d).toMatchObject({ status: "published", sandbox_publish: true });
    // Re-running the executor is idempotent.
    const again: any = await runTask({ db, llm: new MockLlm(), workerId: "w" }, exec);
    expect(again.already_published).toBeTruthy();
  });

  it("LLM outages surface as retryable and release the budget reservation", async () => {
    const llm = { provider: "anthropic" as const, model: "claude-opus-5-5", maxTokens: 1000, create: async () => { throw new RetryableError("503"); } };
    await enqueue(db, { agentId: "seo_agency", type: "directive", title: "outage" });
    const task = (await claimNext(db, "w"))!;
    await expect(runTask({ db, llm, workerId: "w" }, task)).rejects.toBeInstanceOf(RetryableError);
    const open = (await db.query(`SELECT count(*)::int AS n FROM spend_authorizations WHERE task_id = $1 AND status = 'reserved'`, [task.id])).rows[0].n;
    expect(open).toBe(0);
    await failTask(db, task.id, "w", "503", { retryable: true });
    expect((await db.query(`SELECT status FROM tasks WHERE id = $1`, [task.id])).rows[0].status).toBe("queued");
    await drain();
  });

  it("real-model costs are reserved up front and settled into the ledger", async () => {
    const llm = { provider: "anthropic" as const, model: "claude-opus-5-5", maxTokens: 1000,
      create: async () => ({ content: [text("done")] as any, stop_reason: "end_turn", usage: { input_tokens: 2_000, output_tokens: 800 }, model: "claude-opus-5-5" }) };
    await enqueue(db, { agentId: "seo_agency", type: "directive", title: "costed" });
    const task = (await claimNext(db, "w"))!;
    const r: any = await runTask({ db, llm, workerId: "w" }, task);
    // 2k in * $4/M + 800 out * $20/M = $0.024 => 2.4 cents, rounded up to 3
    expect(r.cost_cents).toBe(3);
    const l = (await db.query(`SELECT amount_cents, entry_type FROM ledger_entries WHERE description LIKE $1`, [`%${task.id}%`])).rows;
    expect(l).toEqual([{ amount_cents: -3, entry_type: "ai_api" }]);
    await completeTask(db, task.id, "w", r);
  });

  it("emergency stop halts agent tasks before any model call", async () => {
    const llm = new MockLlm();
    await enqueue(db, { agentId: "seo_agency", type: "directive", title: "stopped" });
    const task = (await claimNext(db, "w"))!;
    await engageEmergencyStop(db, "owner", "test");
    await expect(runTask({ db, llm, workerId: "w" }, task)).rejects.toMatchObject({ code: "emergency_stop" });
    expect(llm.calls.length).toBe(0);
    await releaseEmergencyStop(db, "owner");
    await drain();
  });
});

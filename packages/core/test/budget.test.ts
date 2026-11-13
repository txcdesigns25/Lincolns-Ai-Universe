import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { authorizeSpend, settleSpend, setBudget, engageEmergencyStop, releaseEmergencyStop, getFinancials, PolicyDenied, requestApproval, decideApproval, setGlobalMonthlyLimit, type Db } from "../src/index.js";
import { freshDb, setLimits } from "./helpers.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => {
  await db.query(`DELETE FROM spend_authorizations WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.spend_authorization_id = spend_authorizations.id)`);
  await releaseEmergencyStop(db, "owner");
  await setGlobalMonthlyLimit(db, 5000, "owner");
  await db.query(`UPDATE system_controls SET global_daily_limit = 1000000`); // tested separately in cost.test.ts
  await db.query(`UPDATE agents SET status = 'active'`);
});

const big = { starting_budget: 1_000_000, daily_limit: 1_000_000, weekly_limit: 1_000_000, monthly_limit: 1_000_000, per_transaction_limit: 1_000_000, ai_monthly_limit: 1_000_000, ads_monthly_limit: 1_000_000 };

describe("spending limits are enforced by the backend", () => {
  it("denies spending over the per-transaction limit", async () => {
    await setLimits(db, "web_agency", { ...big, per_transaction_limit: 50 });
    await expect(authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 51, reason: "t" }))
      .rejects.toMatchObject({ code: "per_transaction_limit" });
    expect(await authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 50, reason: "t" })).toBeTruthy();
  });

  it("denies spending over the daily limit, counting reservations", async () => {
    await setLimits(db, "seo_agency", { ...big, daily_limit: 100 });
    await authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 60, reason: "a" });
    await expect(authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 41, reason: "b" }))
      .rejects.toMatchObject({ code: "daily_limit" });
  });

  it("holds limits under concurrency (no race past the limit)", async () => {
    await setLimits(db, "content_agency", { ...big, daily_limit: 100 });
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      authorizeSpend(db, { agentId: "content_agency", category: "ai_api", amountCents: 10, reason: `c${i}` })));
    expect(attempts.filter((a) => a.status === "fulfilled").length).toBe(10);
  });

  it("enforces the AI monthly sub-limit", async () => {
    await setLimits(db, "support_agency", { ...big, ai_monthly_limit: 30 });
    await authorizeSpend(db, { agentId: "support_agency", category: "ai_api", amountCents: 30, reason: "x" });
    await expect(authorizeSpend(db, { agentId: "support_agency", category: "ai_api", amountCents: 1, reason: "y" }))
      .rejects.toMatchObject({ code: "ai_monthly_limit" });
  });

  it("enforces the global $50/month cap across all agents", async () => {
    for (const a of ["web_agency", "seo_agency", "content_agency"]) await setLimits(db, a, big);
    await setGlobalMonthlyLimit(db, 100, "owner");
    await authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 60, reason: "g1" });
    await authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 40, reason: "g2" });
    await expect(authorizeSpend(db, { agentId: "content_agency", category: "ai_api", amountCents: 1, reason: "g3" }))
      .rejects.toMatchObject({ code: "global_monthly_limit" });
  });

  it("requires an approval for any non-AI spending, and caps it at the approved amount", async () => {
    await setLimits(db, "marketing_agency", big);
    await expect(authorizeSpend(db, { agentId: "marketing_agency", category: "advertising", amountCents: 500, reason: "ads" }))
      .rejects.toMatchObject({ code: "approval_required" });
    const { id } = await requestApproval(db, { agentId: "marketing_agency", action: "ads.launch", summary: "Run ads", amountCents: 300 });
    await expect(authorizeSpend(db, { agentId: "marketing_agency", category: "advertising", amountCents: 300, reason: "ads", approvalId: id }))
      .rejects.toMatchObject({ code: "approval_invalid" }); // still pending
    await decideApproval(db, id, "approved", "owner");
    await expect(authorizeSpend(db, { agentId: "marketing_agency", category: "advertising", amountCents: 301, reason: "ads", approvalId: id }))
      .rejects.toMatchObject({ code: "approval_exceeded" });
    expect(await authorizeSpend(db, { agentId: "marketing_agency", category: "advertising", amountCents: 300, reason: "ads", approvalId: id })).toBeTruthy();
  });

  it("agents cannot change their own limits", async () => {
    await expect(setBudget(db, "digital_store", { daily_limit: 999999 }, "digital_store")).rejects.toBeInstanceOf(PolicyDenied);
    await expect(setBudget(db, "digital_store", { daily_limit: 999999 }, "ceo")).rejects.toBeInstanceOf(PolicyDenied);
    await expect(setGlobalMonthlyLimit(db, 999999, "ceo")).rejects.toBeInstanceOf(PolicyDenied);
  });

  it("emergency stop blocks all new spending immediately", async () => {
    await setLimits(db, "automation_agency", big);
    await engageEmergencyStop(db, "owner", "test");
    await expect(authorizeSpend(db, { agentId: "automation_agency", category: "ai_api", amountCents: 1, reason: "z" }))
      .rejects.toMatchObject({ code: "emergency_stop" });
    await releaseEmergencyStop(db, "owner");
    expect(await authorizeSpend(db, { agentId: "automation_agency", category: "ai_api", amountCents: 1, reason: "z" })).toBeTruthy();
  });

  it("paused agents cannot spend", async () => {
    await setLimits(db, "web_agency", big);
    await db.query(`UPDATE agents SET status = 'paused' WHERE id = 'web_agency'`);
    await expect(authorizeSpend(db, { agentId: "web_agency", category: "ai_api", amountCents: 1, reason: "p" }))
      .rejects.toMatchObject({ code: "agent_not_active" });
  });

  it("duplicate authorizations with the same idempotency key do not double-reserve", async () => {
    await setLimits(db, "seo_agency", { ...big, daily_limit: 15 });
    const a = await authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 10, reason: "i", idempotencyKey: "dup-1" });
    const b = await authorizeSpend(db, { agentId: "seo_agency", category: "ai_api", amountCents: 10, reason: "i", idempotencyKey: "dup-1" });
    expect(a).toBe(b);
  });

  it("settling is idempotent, capped at the reservation, and writes exactly one ledger row", async () => {
    await setLimits(db, "digital_store", big);
    const id = await authorizeSpend(db, { agentId: "digital_store", category: "ai_api", amountCents: 20, reason: "s" });
    await settleSpend(db, id, 35, { source: "anthropic_usage" });
    await settleSpend(db, id, 35, { source: "anthropic_usage" });
    const rows = (await db.query(`SELECT amount_cents FROM ledger_entries WHERE spend_authorization_id = $1`, [id])).rows;
    expect(rows).toEqual([{ amount_cents: -20 }]);
    const f = await getFinancials(db, { agentId: "digital_store" });
    expect(f.aiCosts).toBeGreaterThanOrEqual(20);
  });
});

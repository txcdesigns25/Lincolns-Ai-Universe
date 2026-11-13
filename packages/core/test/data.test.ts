import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  recordMemory, evaluateExperiment, sendAgentMessage, getCustomerForAgent, recordProviderEntry, getFinancials,
  proposeConfigVersion, activateConfigVersion, getActiveConfig, grantPermission, storeInboundEvent, processInboundEvents,
  verifyStripeSignature, isBlockedStore, PolicyDenied, type Db,
} from "../src/index.js";
import { createHmac } from "node:crypto";
import { freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe("memory and learning", () => {
  it("observations and hypotheses need no evidence", async () => {
    await expect(recordMemory(db, { agentId: "seo_agency", kind: "hypothesis", title: "Long-form wins", content: "Maybe" })).resolves.toBeTruthy();
  });
  it("verified results are rejected without real evidence", async () => {
    await expect(recordMemory(db, { agentId: "seo_agency", kind: "verified_result", title: "A beats B", content: "Trust me" }))
      .rejects.toMatchObject({ code: "no_evidence" });
    await expect(recordMemory(db, { agentId: "seo_agency", kind: "verified_result", title: "A beats B", content: "x",
      evidence: [{ type: "ledger_entry", ref: "00000000-0000-0000-0000-000000000000" }] })).rejects.toMatchObject({ code: "evidence_not_found" });
  });
  it("the database itself rejects a verified result with no evidence", async () => {
    await expect(db.query(`INSERT INTO memories (agent_id, kind, title, content) VALUES ('seo_agency','verified_result','x','y')`)).rejects.toThrow();
  });
  it("experiments need sample size and significance before a winner is declared", () => {
    expect(evaluateExperiment({ A: { trials: 20, conversions: 5 }, B: { trials: 20, conversions: 1 } }, 100).decided).toBe(false);
    expect(evaluateExperiment({ A: { trials: 500, conversions: 26 }, B: { trials: 500, conversions: 25 } }, 100).decided).toBe(false);
    const v = evaluateExperiment({ A: { trials: 1000, conversions: 80 }, B: { trials: 1000, conversions: 40 } }, 100);
    expect(v).toMatchObject({ decided: true, winner: "A" });
  });
});

describe("customer data isolation", () => {
  it("agents cannot read or reference other agents' customers", async () => {
    const c = (await db.query(`INSERT INTO customers (owner_agent_id, name, email) VALUES ('web_agency','Acme','a@acme.test') RETURNING id`)).rows[0];
    await expect(getCustomerForAgent(db, "seo_agency", c.id)).rejects.toMatchObject({ code: "customer_access_denied" });
    await expect(getCustomerForAgent(db, "web_agency", c.id)).resolves.toMatchObject({ name: "Acme" });
    await expect(sendAgentMessage(db, { from: "seo_agency", to: "web_agency", kind: "info", subject: "hi", body: {}, customerId: c.id }))
      .rejects.toMatchObject({ code: "customer_access_denied" });
    // Owner can hand off; recipient still can't read the record without a share.
    await sendAgentMessage(db, { from: "web_agency", to: "seo_agency", kind: "handoff", subject: "SEO for Acme", body: { scope: "audit" }, customerId: c.id });
    await expect(getCustomerForAgent(db, "seo_agency", c.id)).rejects.toBeInstanceOf(PolicyDenied);
    await db.query(`INSERT INTO customer_shares (customer_id, agent_id) VALUES ($1, 'seo_agency')`, [c.id]);
    await expect(getCustomerForAgent(db, "seo_agency", c.id)).resolves.toBeTruthy();
  });
});

describe("financial reporting", () => {
  it("only verified, non-sandbox revenue is reported; duplicates are ignored", async () => {
    await recordProviderEntry(db, { agentId: "digital_store", type: "revenue", amountCents: 1500, source: "shopify", externalRef: "order-1" });
    await recordProviderEntry(db, { agentId: "digital_store", type: "revenue", amountCents: 1500, source: "shopify", externalRef: "order-1" }); // webhook redelivery
    await recordProviderEntry(db, { agentId: "digital_store", type: "processing_fee", amountCents: 74, source: "shopify", externalRef: "order-1" });
    await recordProviderEntry(db, { agentId: "digital_store", type: "refund", amountCents: 500, source: "shopify", externalRef: "refund-1" });
    await recordProviderEntry(db, { agentId: "digital_store", type: "revenue", amountCents: 99999, source: "sandbox", externalRef: "test-1" });
    await recordProviderEntry(db, { agentId: "digital_store", type: "revenue", amountCents: 88888, source: "manual", externalRef: "claimed-1" });
    const f = await getFinancials(db, { agentId: "digital_store" });
    expect(f.grossRevenue).toBe(1500);
    expect(f.refunds).toBe(500);
    expect(f.fees).toBe(74);
    expect(f.netProfit).toBe(1500 - 500 - 74);
  });
  it("the ledger is append-only", async () => {
    await expect(db.query(`UPDATE ledger_entries SET amount_cents = 1000000`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
  });
});

describe("versioned, reversible strategy changes", () => {
  it("proposals wait for the owner unless preauthorized; rollback restores the previous version", async () => {
    const v1 = await proposeConfigVersion(db, { agentId: "content_agency", proposedBy: "owner", strategy_prompt: "v1", rationale: "Initial strategy set by owner" });
    expect(v1.status).toBe("active");
    const v2 = await proposeConfigVersion(db, { agentId: "content_agency", proposedBy: "content_agency", strategy_prompt: "v2", rationale: "Hooks under 2s convert better per data" });
    expect(v2.status).toBe("proposed");
    expect((await getActiveConfig(db, "content_agency")).strategy_prompt).toBe("v1");
    await grantPermission(db, "content_agency", "strategy.self_update", "owner");
    const v3 = await proposeConfigVersion(db, { agentId: "content_agency", proposedBy: "content_agency", strategy_prompt: "v3", cycle_interval_minutes: 720, rationale: "Evidence supports daily twice cadence" });
    expect(v3.status).toBe("active");
    expect((await db.query(`SELECT interval_minutes FROM schedules WHERE id = 'a03-growth-cycle'`)).rows[0].interval_minutes).toBe(720);
    await activateConfigVersion(db, v1.version_id, "owner");
    expect((await getActiveConfig(db, "content_agency")).strategy_prompt).toBe("v1");
    await expect(activateConfigVersion(db, v3.version_id, "content_agency")).rejects.toMatchObject({ code: "owner_only" });
  });
});

describe("event-driven inputs", () => {
  it("landing-page leads become customers and a high-priority task, once", async () => {
    await storeInboundEvent(db, { source: "landing_form", externalId: "form-1", agentId: "automation_agency", payload: { name: "Jo", email: "jo@x.test", message: "Need CRM automation", sandbox: true } });
    const dup = await storeInboundEvent(db, { source: "landing_form", externalId: "form-1", agentId: "automation_agency", payload: {} });
    expect(dup.duplicate).toBe(true);
    await processInboundEvents(db);
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE type = 'inbound_lead'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT owner_agent_id FROM customers WHERE email = 'jo@x.test'`)).rows[0].owner_agent_id).toBe("automation_agency");
  });
  it("verifies Stripe signatures", () => {
    const body = '{"id":"evt_1"}', secret = "whsec_test", t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret)).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)}`, secret)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t - 10000},v1=${sig}`, secret)).toBe(false);
  });
});

describe("Shopify store guard", () => {
  it("never allows writing to the TXC Designs store", () => {
    expect(isBlockedStore({ name: "TXC Designs" })).toBe(true);
    expect(isBlockedStore({ primaryHost: "txcdesigns.com" })).toBe(true);
    expect(isBlockedStore({ myshopifyDomain: "txc-designs.myshopify.com" })).toBe(true);
    expect(isBlockedStore({ name: "AI Universe Dev Store", myshopifyDomain: "ai-universe-dev.myshopify.com" })).toBe(false);
  });
});

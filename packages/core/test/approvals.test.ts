import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authorizeAction, requestApproval, decideApproval, grantPermission, PolicyDenied, type Db } from "../src/index.js";
import { freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe("approval system", () => {
  it("Level 1 actions run without approval", async () => {
    await expect(authorizeAction(db, { agentId: "seo_agency", action: "draft.create" })).resolves.toBeUndefined();
  });

  it("Level 2 actions need a standing preauthorization", async () => {
    await expect(authorizeAction(db, { agentId: "seo_agency", action: "experiment.run_low_risk" })).rejects.toMatchObject({ code: "not_preauthorized" });
    await grantPermission(db, "seo_agency", "experiment.run_low_risk", "owner");
    await expect(authorizeAction(db, { agentId: "seo_agency", action: "experiment.run_low_risk" })).resolves.toBeUndefined();
  });

  it("only the owner can grant preauthorizations, and never for Level 3", async () => {
    await expect(grantPermission(db, "ceo", "experiment.run_low_risk", "ceo")).rejects.toBeInstanceOf(PolicyDenied);
    await expect(grantPermission(db, "seo_agency", "ads.launch", "owner")).rejects.toMatchObject({ code: "not_level2" });
  });

  it("Level 3 actions cannot run without an approved approval", async () => {
    await expect(authorizeAction(db, { agentId: "web_agency", action: "contract.enter", sandbox: true })).rejects.toMatchObject({ code: "approval_required" });
    const { id } = await requestApproval(db, { agentId: "web_agency", action: "contract.enter", summary: "Sign client" });
    await expect(authorizeAction(db, { agentId: "web_agency", action: "contract.enter", approvalId: id, sandbox: true })).rejects.toMatchObject({ code: "approval_not_approved" });
  });

  it("agents (including the CEO) cannot approve requests", async () => {
    const { id } = await requestApproval(db, { agentId: "web_agency", action: "contract.enter", summary: "Sign client 2" });
    await expect(decideApproval(db, id, "approved", "ceo")).rejects.toMatchObject({ code: "owner_only" });
    await expect(decideApproval(db, id, "approved", "web_agency")).rejects.toMatchObject({ code: "owner_only" });
  });

  it("an approval is single-use and bound to its agent and action", async () => {
    const { id } = await requestApproval(db, { agentId: "web_agency", action: "contract.enter", summary: "Sign client 3" });
    await decideApproval(db, id, "approved", "owner");
    await expect(authorizeAction(db, { agentId: "seo_agency", action: "contract.enter", approvalId: id, sandbox: true })).rejects.toMatchObject({ code: "approval_mismatch" });
    await expect(authorizeAction(db, { agentId: "web_agency", action: "refund.significant", approvalId: id, sandbox: true })).rejects.toMatchObject({ code: "approval_mismatch" });
    await authorizeAction(db, { agentId: "web_agency", action: "contract.enter", approvalId: id, sandbox: true });
    await expect(authorizeAction(db, { agentId: "web_agency", action: "contract.enter", approvalId: id, sandbox: true })).rejects.toMatchObject({ code: "approval_consumed" });
  });

  it("external actions require live mode unless executed in sandbox", async () => {
    const { id } = await requestApproval(db, { agentId: "digital_store", action: "listing.publish", summary: "Publish" });
    await decideApproval(db, id, "approved", "owner");
    await expect(authorizeAction(db, { agentId: "digital_store", action: "listing.publish", approvalId: id })).rejects.toMatchObject({ code: "sandbox_only" });
  });

  it("unknown actions fail safe as Level 3", async () => {
    await expect(authorizeAction(db, { agentId: "digital_store", action: "something.new", sandbox: true })).rejects.toMatchObject({ code: "approval_required" });
  });

  it("denials are written to the audit log", async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'denied'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

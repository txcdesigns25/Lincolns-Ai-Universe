import type { Queryable, Db } from "./db.js";
import { withTx } from "./db.js";
import { audit } from "./audit.js";
import { PolicyDenied } from "./errors.js";

export async function isEmergencyStopped(q: Queryable): Promise<boolean> {
  const { rows } = await q.query(`SELECT emergency_stop FROM system_controls WHERE id`);
  return rows[0]?.emergency_stop === true;
}

export async function getControls(q: Queryable) {
  const { rows } = await q.query(`SELECT * FROM system_controls WHERE id`);
  return rows[0];
}

/** Owner-only. Immediately blocks all new spend authorizations and external actions. */
export async function engageEmergencyStop(db: Db, by: string, reason: string) {
  await withTx(db, async (tx) => {
    await tx.query(
      `UPDATE system_controls SET emergency_stop = TRUE, stop_reason = $2, stopped_by = $1,
              stopped_at = now(), updated_at = now() WHERE id`,
      [by, reason],
    );
    // Outstanding reservations are left in place on purpose: a call already in
    // flight has really cost money and must still be settled into the ledger.
    // No *new* reservation can be created while the stop is engaged.
    await audit(tx, { actor: by, action: "emergency_stop.engage", outcome: "info", details: { reason } });
  });
}

export async function releaseEmergencyStop(db: Db, by: string) {
  await withTx(db, async (tx) => {
    await tx.query(
      `UPDATE system_controls SET emergency_stop = FALSE, stop_reason = NULL, updated_at = now() WHERE id`,
    );
    await audit(tx, { actor: by, action: "emergency_stop.release", outcome: "info" });
  });
}

/** Throws unless the system is running and the agent is active. */
export async function assertAgentMayAct(q: Queryable, agentId: string, opts: { external?: boolean } = {}) {
  if (await isEmergencyStopped(q)) throw new PolicyDenied("emergency_stop", "Emergency stop is engaged");
  const { rows } = await q.query(`SELECT status, live_mode FROM agents WHERE id = $1`, [agentId]);
  const agent = rows[0];
  if (!agent) throw new PolicyDenied("unknown_agent", `Unknown agent ${agentId}`);
  if (agent.status !== "active") throw new PolicyDenied("agent_not_active", `Agent ${agentId} is ${agent.status}`);
  if (opts.external && !agent.live_mode)
    throw new PolicyDenied("sandbox_only", `Agent ${agentId} is in sandbox mode; external actions are disabled`);
}

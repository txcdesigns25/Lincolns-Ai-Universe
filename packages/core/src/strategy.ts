import type { Db, Queryable } from "./db.js";
import { withTx } from "./db.js";
import { audit } from "./audit.js";
import { PolicyDenied } from "./errors.js";

/**
 * Versioned, reversible self-improvement of an agent's strategy prompt,
 * playbook, and growth-cycle cadence. Agents propose; a version activates
 * automatically only if the owner pre-authorized `strategy.self_update` for
 * that agent, otherwise it waits for the owner. Any version can be rolled back.
 */
export async function getActiveConfig(q: Queryable, agentId: string) {
  const { rows } = await q.query(`SELECT * FROM agent_config_versions WHERE agent_id = $1 AND status = 'active'`, [agentId]);
  return rows[0] ?? null;
}

export async function proposeConfigVersion(db: Db, p: {
  agentId: string; proposedBy: string; strategy_prompt?: string; playbook?: Record<string, unknown>;
  cycle_interval_minutes?: number; rationale: string; evidence?: unknown[];
}) {
  return withTx(db, async (tx) => {
    await tx.query(`SELECT 1 FROM agents WHERE id = $1 FOR UPDATE`, [p.agentId]);
    const cur = await getActiveConfig(tx, p.agentId);
    const next = (await tx.query(`SELECT COALESCE(MAX(version),0)+1 AS v FROM agent_config_versions WHERE agent_id = $1`, [p.agentId])).rows[0].v;
    const ins = await tx.query(
      `INSERT INTO agent_config_versions (agent_id, version, strategy_prompt, playbook, cycle_interval_minutes, rationale, evidence, proposed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [p.agentId, next, p.strategy_prompt ?? cur?.strategy_prompt ?? "", JSON.stringify(p.playbook ?? cur?.playbook ?? {}),
       p.cycle_interval_minutes ?? cur?.cycle_interval_minutes ?? 1440, p.rationale, JSON.stringify(p.evidence ?? []), p.proposedBy]);
    const id = ins.rows[0].id as string;
    const preauth = p.proposedBy === "owner" || (await tx.query(
      `SELECT 1 FROM agent_permissions WHERE agent_id = $1 AND action = 'strategy.self_update'`, [p.agentId])).rowCount;
    if (preauth) {
      await activate(tx, p.agentId, id, p.proposedBy === "owner" ? "owner" : `${p.agentId}:preauthorized`);
      return { version_id: id, version: next, status: "active" };
    }
    await audit(tx, { actor: p.proposedBy, agentId: p.agentId, action: "strategy.propose", outcome: "info", details: { version: next, rationale: p.rationale } });
    return { version_id: id, version: next, status: "proposed", note: "Awaiting owner review in the dashboard." };
  });
}

async function activate(q: Queryable, agentId: string, versionId: string, by: string) {
  await q.query(`UPDATE agent_config_versions SET status = 'superseded' WHERE agent_id = $1 AND status = 'active'`, [agentId]);
  const v = (await q.query(`UPDATE agent_config_versions SET status = 'active', activated_by = $2, activated_at = now()
                             WHERE id = $1 RETURNING *`, [versionId, by])).rows[0];
  await q.query(`UPDATE schedules SET interval_minutes = $2 WHERE agent_id = $1 AND task_type = 'growth_cycle'`, [agentId, v.cycle_interval_minutes]);
  await audit(q, { actor: by, agentId, action: "strategy.activate", outcome: "info", details: { version: v.version } });
}

/** Owner decision on a proposed version, or rollback to any earlier version. */
export async function activateConfigVersion(db: Db, versionId: string, by: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can activate or roll back versions");
  return withTx(db, async (tx) => {
    const v = (await tx.query(`SELECT * FROM agent_config_versions WHERE id = $1 FOR UPDATE`, [versionId])).rows[0];
    if (!v) throw new Error("Version not found");
    const wasRollback = v.status !== "proposed";
    if (wasRollback) await tx.query(`UPDATE agent_config_versions SET status = 'rolled_back' WHERE agent_id = $1 AND status = 'active'`, [v.agent_id]);
    await activate(tx, v.agent_id, versionId, by);
    return { agent_id: v.agent_id, version: v.version, rollback: wasRollback };
  });
}

export async function rejectConfigVersion(db: Db, versionId: string, by: string) {
  if (by !== "owner") throw new PolicyDenied("owner_only", "Only the owner can reject versions");
  await db.query(`UPDATE agent_config_versions SET status = 'rejected' WHERE id = $1 AND status = 'proposed'`, [versionId]);
}

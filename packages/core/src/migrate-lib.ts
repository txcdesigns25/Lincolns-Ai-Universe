import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

export async function migrate(db: Db, log = console.log) {
  // Advisory lock: web and worker may both start and migrate at the same moment.
  const lock = await db.connect();
  await lock.query(`SELECT pg_advisory_lock(727274)`);
  try { await migrateLocked(db, log); } finally { await lock.query(`SELECT pg_advisory_unlock(727274)`); lock.release(); }
}

async function migrateLocked(db: Db, log: (m: string) => void) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/CREATE TABLE schema_migrations[\s\S]*?\);/, "");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
      await client.query("COMMIT");
      log(`applied ${f}`);
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }
}

/**
 * Idempotent seed: CEO + 7 agents (paused, sandbox mode), conservative
 * default budgets, schedules, and the hourly health check.
 */
export async function seed(db: Db) {
  const { AGENTS } = await import("./agents.js");
  let slot = 0;
  for (const a of AGENTS) {
    await db.query(
      `INSERT INTO agents (id, code, name, kind, mission) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, mission = EXCLUDED.mission, code = EXCLUDED.code`,
      [a.id, a.code, a.name, a.kind, a.mission]);
    // Defaults (cents). The binding constraint is the GLOBAL $50/month cap
    // across all agents (system_controls.global_monthly_limit = 5000).
    // Per agent: $25 lifetime, $0.25/day, $1/week, $3/month, $0.50 per transaction, $3/month AI, $0 ads.
    // Plus a global $1.50/day cap (system_controls.global_daily_limit).
    await db.query(
      `INSERT INTO agent_budgets (agent_id, starting_budget, daily_limit, weekly_limit, monthly_limit, per_transaction_limit, ai_monthly_limit, ads_monthly_limit)
       VALUES ($1, 2500, 25, 100, 300, 50, 300, 0) ON CONFLICT DO NOTHING`, [a.id]);
    // Stagger first runs: daily work 90 minutes apart across agents, weekly reviews a week out.
    for (const s of a.schedules) {
      slot++;
      const offsetMin = slot * 90 + (s.intervalMinutes >= 10080 ? 10080 : 0);
      await db.query(
        `INSERT INTO schedules (id, agent_id, task_type, title, interval_minutes, next_run_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval) ON CONFLICT (id) DO NOTHING`,
        [s.id, a.id, s.taskType, s.title, s.intervalMinutes, String(offsetMin)]);
    }
  }
  // One-time grant (owner decision, 2026-11-13): the Digital Product Store may
  // brand and list on its designated store without per-item approval. Done once
  // so that if the owner revokes it later, a redeploy does not re-grant it.
  const granted = await db.query(`INSERT INTO kv_store (key, value) VALUES ('seed_store_publish_grant', '{"granted":true}') ON CONFLICT (key) DO NOTHING RETURNING key`);
  if (granted.rowCount) {
    await db.query(`INSERT INTO agent_permissions (agent_id, action, granted_by) VALUES ('digital_store', 'store.publish_owned', 'owner') ON CONFLICT DO NOTHING`);
  }
  await db.query(
    `INSERT INTO schedules (id, agent_id, task_type, title, interval_minutes) VALUES ('system-health', 'ceo', 'health_check', 'System health check', 60)
     ON CONFLICT (id) DO NOTHING`);
}

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
  for (const a of AGENTS) {
    await db.query(
      `INSERT INTO agents (id, code, name, kind, mission) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, mission = EXCLUDED.mission, code = EXCLUDED.code`,
      [a.id, a.code, a.name, a.kind, a.mission]);
    // Defaults (cents). The binding constraint is the GLOBAL $50/month cap
    // across all agents (system_controls.global_monthly_limit = 5000).
    // Per agent: $25 lifetime, $1/day, $3/week, $6/month, $0.50 per transaction, $6/month AI, $0 ads.
    await db.query(
      `INSERT INTO agent_budgets (agent_id, starting_budget, daily_limit, weekly_limit, monthly_limit, per_transaction_limit, ai_monthly_limit, ads_monthly_limit)
       VALUES ($1, 2500, 100, 300, 600, 50, 600, 0) ON CONFLICT DO NOTHING`, [a.id]);
    for (const s of a.schedules) {
      await db.query(
        `INSERT INTO schedules (id, agent_id, task_type, title, interval_minutes, next_run_at)
         VALUES ($1,$2,$3,$4,$5, now()) ON CONFLICT (id) DO NOTHING`, [s.id, a.id, s.taskType, s.title, s.intervalMinutes]);
    }
  }
  await db.query(
    `INSERT INTO schedules (id, agent_id, task_type, title, interval_minutes) VALUES ('system-health', 'ceo', 'health_check', 'System health check', 60)
     ON CONFLICT (id) DO NOTHING`);
}

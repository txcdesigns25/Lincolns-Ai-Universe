import { createDb, migrate, seed, type Db } from "../src/index.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://universe:universe@localhost:5432/universe_test";

/** Fresh schema for each test file: drop everything, migrate, seed, activate agents. */
export async function freshDb(): Promise<Db> {
  const db = createDb(TEST_DB_URL);
  await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate(db, () => {});
  await seed(db);
  await db.query(`UPDATE agents SET status = 'active'`);
  return db;
}

/** Generous limits so tests target one limit at a time. */
export async function setLimits(db: Db, agentId: string, l: Record<string, number>) {
  const sets = Object.entries(l).map(([k], i) => `${k} = $${i + 2}`).join(", ");
  await db.query(`UPDATE agent_budgets SET ${sets} WHERE agent_id = $1`, [agentId, ...Object.values(l)]);
}

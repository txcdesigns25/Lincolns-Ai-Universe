import pg from "pg";

// BIGINT -> JS number. Cents fit comfortably below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getDb(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  }
  return pool;
}

export function createDb(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function closeDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

export async function withTx<T>(db: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

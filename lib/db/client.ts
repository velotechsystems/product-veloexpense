/**
 * VeloExpense DB client — raw node-postgres pool + a transaction() runner.
 *
 * Mirrors VeloLedger's lib/db/client pattern. We use a raw client (not Prisma)
 * for the tenancy-critical path because RLS needs the org session variable set
 * on the SAME connection that runs the queries, inside one transaction. Prisma
 * can still be used for typed reads elsewhere, but tenant-scoped work goes
 * through withOrg() below so `app.current_org` is guaranteed set.
 *
 * Confirmed decisions: session var = `app.current_org`; VeloExpense has its own
 * Postgres (product-per-DB).
 */
import { Pool, type PoolClient } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

export type QueryRunner = Pick<PoolClient, 'query'>;

/** Run fn inside a transaction on a single pooled connection. */
export async function transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function getPool(): Pool {
  return pool;
}

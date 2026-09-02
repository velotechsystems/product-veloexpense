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
import { Pool, types, type PoolClient } from 'pg';

/**
 * VX4-7 part 1b — A CALENDAR DATE IS A STRING, NOT AN INSTANT.
 *
 * node-postgres parses a `date` column into a JS Date at SERVER-LOCAL MIDNIGHT.
 * That is the wrong shape for the thing being stored, and it is wrong in a way
 * that changes with where the process runs. Measured, against one stored
 * `2026-03-04`:
 *
 *   TZ=UTC                -> 2026-03-04T00:00:00Z
 *   TZ=America/Toronto    -> 2026-03-04T05:00:00Z
 *   TZ=Europe/Paris       -> 2026-03-03T23:00:00Z   <- already the 3rd
 *   TZ=Australia/Sydney   -> 2026-03-03T13:00:00Z   <- already the 3rd
 *
 * So `txn_date.toISOString().slice(0, 10)` — which is what `formatDate` did at
 * twenty call sites — renders the PREVIOUS DAY for every deploy east of UTC.
 * Nobody has seen it because this container runs UTC and the dev Mac runs
 * Toronto, both west. A European region would have shifted every expense date
 * in the product by a day, silently, and the symptom would have arrived months
 * later as "the totals are wrong".
 *
 * Formatting in UTC — which is upstream's own remedy, applied at four sites with
 * a comment at each — does NOT fix it. It is the same bug from the other side:
 * correct for a west-of-UTC server, wrong for an east-of-UTC one.
 *
 * ── THE FIX IS TO REFUSE THE CONVERSION, NOT TO CORRECT IT ──────────────────
 *
 * `1082` is `date`. Returning the raw `'YYYY-MM-DD'` text means a calendar date
 * carries no timezone at all, so no timezone can move it. The bug stops being
 * handled and becomes unrepresentable — 0023's rule about the second writer,
 * applied to a type instead of a column: "a permissive column plus a normalising
 * writer means the SECOND writer decides the format, and there is always a
 * second writer."
 *
 * This also makes the whole codebase agree with `lib/budgets`, which already
 * selects `starts_on::text` and types the field `string`. VX4-5 hit this and
 * solved it in one module; those casts are now belt-and-braces rather than the
 * only thing standing between us and a day-shift.
 *
 * WHAT IS NOT AFFECTED: comparisons in SQL (`starts_on <= $3::date`), which
 * Postgres evaluates. And comparisons in JS still work, because ISO `YYYY-MM-DD`
 * sorts lexicographically exactly as it sorts chronologically — `periodCovering`
 * in `lib/budgets/service.ts` has been relying on precisely that.
 *
 * `timestamptz` (1184) is deliberately LEFT ALONE. It really is an instant, a
 * Date is the right shape for it, and `lib/i18n/format.ts` renders it in the
 * reader's zone.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

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

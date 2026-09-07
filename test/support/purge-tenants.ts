/**
 * Delete whole tenants, for the two suites that CREATE them.
 *
 * ── WHY THIS IS NOT A ONE-LINE DELETE ──────────────────────────────────────
 *
 * `DELETE FROM organization WHERE …` fails on `app_user_organization_id_fkey`,
 * and deleting the children first fails on `audit_entry`, which is append-only
 * enforced by a TRIGGER rather than a convention. Every tenant has a genesis
 * audit row (`ORGANIZATION_CREATED`), so **no tenant can be deleted by an
 * ordinary caller at all.**
 *
 * `app.audit_purge = 'on'` is the hatch the trigger's own message names for a
 * retention purge, and removing a tenant entirely is a legitimate use of it:
 * this deletes history, it does not edit it. It is set transaction-locally, so
 * it dies with the statement batch.
 *
 * ── AND WHY THE TABLE LIST COMES FROM THE CATALOGUE ────────────────────────
 *
 * A hardcoded list rots the moment a migration adds a tenant table, and it rots
 * SILENTLY — as a cleanup that leaves rows behind, which then surface as a
 * different suite failing. So the tables are read from `information_schema`, and
 * the passes-with-savepoints loop handles children that reference each other
 * without needing a dependency order.
 *
 * ── WHY BOTH SUITES SHARE IT ───────────────────────────────────────────────
 *
 * `test/export-archive.db.test.ts` and `e2e/platform-provision.spec.ts` are the
 * only two places in the project that create tenants, and both need this. The
 * first version had a copy in each, which is two copies of a list that has to
 * stay right — the exact failure this file's own reasoning warns about.
 */
import type { Pool } from 'pg';

export interface PurgeScope {
  /** Matched against `organization.slug` with LIKE, e.g. `'xexp-%'`. */
  slugLike?: string;
  /** Matched against `organization.account_id`. */
  accountIds?: string[];
}

/** How many times the child-deletion loop retries tables that failed. */
const PASSES = 6;

/**
 * Delete every organization matching `scope`, and everything belonging to it.
 *
 * `admin` must be a pool with rights to set `app.audit_purge` — the ADMIN
 * connection every db suite already uses.
 */
export async function purgeTenants(admin: Pool, scope: PurgeScope): Promise<void> {
  if (!scope.slugLike && (scope.accountIds ?? []).length === 0) {
    // A scope that matches everything would delete the seed, and the symptom
    // would be five other suites failing on missing fixtures.
    throw new Error('purgeTenants: refusing an empty scope');
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.slugLike) {
    params.push(scope.slugLike);
    where.push(`slug LIKE $${params.length}`);
  }
  if ((scope.accountIds ?? []).length > 0) {
    params.push(scope.accountIds);
    where.push(`account_id = ANY($${params.length}::uuid[])`);
  }
  const orgFilter = where.join(' OR ');

  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.audit_purge', 'on', true)");

    const tables = await client.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'organization_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );
    let pending = tables.rows.map((r) => r.table_name);

    for (let pass = 0; pass < PASSES && pending.length > 0; pass += 1) {
      const failed: string[] = [];
      for (const table of pending) {
        await client.query('SAVEPOINT purge_child');
        try {
          await client.query(
            `DELETE FROM "${table}" WHERE organization_id IN (
               SELECT id FROM organization WHERE ${orgFilter})`,
            params,
          );
          await client.query('RELEASE SAVEPOINT purge_child');
        } catch {
          // A child of a child. Roll back just this statement and try again on
          // the next pass, once whatever referenced it is gone.
          await client.query('ROLLBACK TO SAVEPOINT purge_child');
          failed.push(table);
        }
      }
      pending = failed;
    }

    if (pending.length > 0) {
      throw new Error(`purgeTenants could not empty: ${pending.join(', ')}`);
    }

    await client.query(`DELETE FROM organization WHERE ${orgFilter}`, params);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

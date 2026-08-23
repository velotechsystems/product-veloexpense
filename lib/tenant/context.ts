/**
 * Tenant context — the ONLY sanctioned way to run tenant-scoped queries.
 *
 * Opens a transaction, sets `app.current_org` LOCAL to that transaction (so it
 * cannot leak across pooled connections), then runs the caller's work. Every
 * entry point — Next.js request/tRPC, BullMQ worker, MCP tool dispatch — must
 * wrap tenant work in withOrg().
 *
 * Forgetting to set the variable is safe-by-default: RLS policies use
 * current_setting('app.current_org', true) which returns NULL when unset, so
 * unset context sees ZERO rows (a loud, safe failure — never a cross-tenant leak).
 */
import { transaction, type QueryRunner } from '@/lib/db/client';

const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withOrg<T>(orgId: string, fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  if (!ORG_UUID.test(orgId)) throw new Error('withOrg: invalid organization id');
  return transaction(async (tx) => {
    // set_config(key, value, is_local=true) === SET LOCAL, scoped to this txn.
    await tx.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    return fn(tx);
  });
}

/**
 * Service-role escape hatch — NO org filter. Use ONLY for migrations,
 * cross-tenant admin, and platform analytics. Never in a tenant request path.
 */
export async function withoutOrg<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  return transaction(fn);
}

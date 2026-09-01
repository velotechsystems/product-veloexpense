/**
 * Tenant context — the ONLY sanctioned way to run tenant-scoped queries.
 *
 * Opens a transaction, sets `app.current_org` LOCAL to that transaction (so it
 * cannot leak across pooled connections), then runs the caller's work. Every
 * entry point — Next.js request/tRPC, BullMQ worker, MCP tool dispatch — must
 * wrap tenant work in withOrg().
 *
 * Forgetting to set the variable is safe-by-default: every RLS policy body reads
 * NULLIF(current_setting('app.current_org', true), '')::uuid, which is NULL when
 * there is no tenant, so unset context sees ZERO rows (a loud, safe failure —
 * never a cross-tenant leak).
 *
 * THE `NULLIF` IS LOAD-BEARING, and this comment used to omit it and claim the
 * bare `current_setting` returned NULL. It does not, past the first call:
 * `set_config(k, v, is_local => true)` leaves the GUC DEFINED AS THE EMPTY STRING
 * when the transaction ends, not undefined. So a pooled connection reads NULL only
 * until it has served one withOrg(), and `''` for the rest of its life — and a
 * bare `''::uuid` raises `22P02 invalid input syntax for type uuid: ""` instead of
 * evaluating to NULL. The policies are written correctly; several application-side
 * copies of the same expression are not (see PE-9 in docs/porting/GAP-AUDIT.md).
 * Anything comparing against `app.current_org` in SQL must go through the NULLIF.
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
 *
 * NOTE WHAT THIS DOES NOT DO, because the name invites the wrong assumption: it
 * does NOT see across tenants. It still connects as `veloapp`, which is subject
 * to FORCE RLS, so with `app.current_org` unset every policy body reads
 * `organization_id = NULL` and returns NULL — and an unset context therefore
 * sees ZERO rows on every tenant table. That is the guarantee described above,
 * and `test/rls-isolation.test.ts` asserts it. `withoutOrg` is only useful for
 * tables that have no tenant column at all (`organization` itself) or through a
 * connection that bypasses RLS (the ADMIN url, tests and migrations only).
 *
 * For a genuine cross-tenant read from the application, see `withPlatformRead`.
 */
export async function withoutOrg<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  return transaction(fn);
}

/**
 * VX2-8 — a READ-ONLY, cross-tenant look at the two tables that grant it.
 *
 * Some work genuinely has no tenant to be in. A delivery poller has to find work
 * in ANY organization, and an approve-link click arrives with a bare token and no
 * session at all, so neither knows which organization to set before reading.
 * `withoutOrg` cannot help them (see above): under FORCE RLS an unset context
 * sees nothing.
 *
 * So `0012` gives `notification_delivery` and `action_token` a second policy
 * gated on `app.platform_task`, in the same spirit as `0010`'s single
 * `app.audit_purge` hatch. FOUR things keep this from being a hole, and all four
 * matter:
 *
 *   1. ONLY TWO TABLES HAVE THE POLICY. This flag does nothing anywhere else in
 *      the schema — it is not a master key, and adding it to a third table is a
 *      migration somebody has to write and review.
 *   2. `FOR SELECT` ONLY. Every write still needs a real `app.current_org`, so a
 *      platform task can FIND a row and never change one.
 *   3. THE POLICY BODIES ARE NARROWED. The poller sees only due work; the token
 *      handler sees only unconsumed, unexpired tokens. An expired token is not
 *      hidden by an `if` — it is a row that is not there.
 *   4. TRANSACTION-LOCAL, like `withOrg`, so it cannot outlive the work or leak
 *      onto a pooled connection.
 *
 * THE RULE FOR CALLERS, and it is the reason the above adds up to safe: take
 * NOTHING from a row you found this way except its `organization_id`, then do the
 * real work inside `withOrg(that id)`. Two callers exist. Keep it that way.
 */
export async function withPlatformRead<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.query("SELECT set_config('app.platform_task', 'on', true)");
    return fn(tx);
  });
}

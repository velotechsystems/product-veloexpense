/**
 * The Prisma client for specs that read or seed THROUGH `@expenseos/db` from the Playwright
 * process — and the one place that says, in words, what is missing when they cannot.
 *
 * ─── WHY A HELPER FOR A ONE-LINE IMPORT ──────────────────────────────────────────────────
 *
 * `@expenseos/db` builds its client on first use from `process.env.DATABASE_URL`, and when
 * that is unset it throws a bare `DATABASE_URL is not set` from `packages/db/src/client.ts`.
 * Read in a Playwright report that message points at the SERVER — which is running, has the
 * variable, and answered every page the spec loaded — and not at the runner, which is the
 * process that actually lacks it. The nightly workflow exports `DATABASE_URL` at the job
 * level (`.github/workflows/e2e-nightly.yml`), so CI never sees this; a local invocation
 * that only wrapped the SERVER in `env-cmd -f .env.test` sees it 27 times in one run, each
 * one filed under the spec that happened to import first.
 *
 * So every spec that used to `await import('@expenseos/db')` inline goes through here, and a
 * missing variable fails before the import with the fix in the message. When the variable IS
 * set nothing changes: the import is the same lazy import, for the same reason — a top-level
 * import would pull the client into Playwright's config load.
 *
 * ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────────────────
 *
 * It does not read `.env.test`, and it does not check that an ambient `DATABASE_URL` agrees
 * with it. `e2e/support/authPageFixtures.ts` does both, because its fixtures write
 * hash-chained audit rows that cannot be cleaned up and a mispointed run must stop before
 * the first insert. The callers here seed rows they delete again, or only read, and the
 * nightly deliberately points them at a database `.env.test` never names. Keeping this
 * helper to the one check it exists for is what lets both conventions stand.
 */

/*
 * VeloExpense: a `pg` pool on the ADMIN url (RLS bypassed), as `e2e/helpers.ts` and the other
 * specs read the database — not a Prisma client. Two reasons. VeloExpense's `db`
 * (lib/db/prisma.ts) is tenant-scoped and refuses outside a tenant, which a spec is not; and
 * VeloExpense's generated client is ESM-only (`import.meta`), which Playwright's CommonJS
 * spec loader cannot import. So a spec ported from ExpenseOS states its reads in SQL, each
 * marked where it replaces a Prisma call. One pool per process, made on first use.
 */
let pool: TestDb | null = null;

/** The `db` export of `@expenseos/db`, typed without importing the module at load time.
 *  VeloExpense: a `pg` pool. */
export type TestDb = import('pg').Pool;

/**
 * Fail with the fix in the message if `DATABASE_URL` is not in THIS process.
 *
 * `caller` names the spec or helper, so a report that lists the same message under several
 * files still says which one tripped it first.
 */
export function assertDatabaseUrl(caller: string): void {
  // VeloExpense: the admin url, as `e2e/helpers.ts`'s pools take it.
  if (process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL) return;
  throw new Error(
    `${caller}: DATABASE_URL must be exported to the Playwright process for specs that seed ` +
      'or read through @expenseos/db — the server having it is not enough. CI exports it at ' +
      'the job level (see .github/workflows/e2e-nightly.yml); locally, export the value ' +
      '.env.test carries, or run Playwright itself through `env-cmd -f .env.test`.',
  );
}

/** The Prisma client, imported lazily once `DATABASE_URL` is known to be present.
 *  VeloExpense: the `pg` pool (see above). */
export async function testDb(caller: string): Promise<TestDb> {
  assertDatabaseUrl(caller);
  if (pool) return pool;
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  return pool;
}

/** VeloExpense: close the pool, for a spec's `afterAll`. */
export async function closeTestDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

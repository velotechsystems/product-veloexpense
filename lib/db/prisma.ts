/**
 * Prisma for ported ExpenseOS code — tenant-scoped, and unusable unscoped.
 *
 * ── WHY PRISMA AT ALL (decided 7 Oct) ───────────────────────────────────────
 *
 * VeloExpense ports ExpenseOS's code, and ExpenseOS's routers and services are
 * written against a Prisma client named `db`. Rewriting every query in `pg` would
 * turn a port back into a rebuild. So ported code imports `db` from here and runs
 * close to verbatim; VeloExpense's own code keeps using `lib/db/client.ts`. Both
 * share ONE `pg` pool and ONE role, `veloapp`.
 *
 * ── WHERE ISOLATION LIVES: POSTGRES, NOT THIS FILE ──────────────────────────
 *
 *   · `veloapp` is not a superuser and every tenant table is FORCE ROW LEVEL
 *     SECURITY, so the `tenant_isolation` policy applies to every Prisma query.
 *   · `withTenantDb(orgId, fn)` opens a transaction whose FIRST statement is
 *     `set_config('app.current_org', orgId, true)` — transaction-local, so the
 *     scope ends with the transaction and cannot ride a pooled connection into
 *     the next request.
 *   · Writes: every `organization_id` defaults to that scope (migration 0044), so
 *     ExpenseOS's `create` calls need no organization. Unscoped -> NULL -> NOT
 *     NULL refuses. Another organization named explicitly -> WITH CHECK refuses.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────
 *
 * `db` is a proxy over the CURRENT tenant transaction (AsyncLocalStorage). Used
 * outside `withTenantDb` it throws — it never falls back to an unscoped client.
 * The base client is not exported; `scripts/check-prisma-scope.mjs` fails CI if
 * anything else constructs a `PrismaClient` or uses `$queryRawUnsafe` /
 * `$executeRawUnsafe`.
 *
 * ── ExpenseOS's `db.$transaction(…)` ────────────────────────────────────────
 *
 * Ported code opens its own transactions. Inside a tenant scope there already IS
 * one, so `db.$transaction(fn)` runs `fn` on it (a nested transaction would need
 * its own `set_config` and would not see the outer one's writes), and the array
 * form awaits its operations in order on the same transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@/lib/generated/prisma/client';
import { getPool } from '@/lib/db/client';

const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantDb = Prisma.TransactionClient;

interface Scope {
  orgId: string;
  tx: TenantDb;
  /** Work to run once this scope's transaction has COMMITTED (`afterCommit`). */
  afterCommit: Array<() => Promise<void>>;
}

const scope = new AsyncLocalStorage<Scope>();

let base: PrismaClient | undefined;
function baseClient(): PrismaClient {
  base ??= new PrismaClient({ adapter: new PrismaPg(getPool()) });
  return base;
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/**
 * Run `fn` with `db` scoped to one organization, in one transaction.
 * Nested calls for the SAME organization reuse the open transaction; a nested
 * call for a different organization is refused rather than silently switched.
 */
export async function withTenantDb<T>(
  orgId: string,
  fn: (tx: TenantDb) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (!ORG_UUID.test(orgId)) throw new TenantScopeError('withTenantDb: invalid organization id');
  const current = scope.getStore();
  if (current) {
    if (current.orgId !== orgId) {
      throw new TenantScopeError('withTenantDb: already scoped to a different organization');
    }
    return fn(current.tx);
  }
  const afterCommitQueue: Array<() => Promise<void>> = [];
  const result = await baseClient().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      // The Prisma driver adapter reads a timestamptz's text without honouring its UTC
      // offset, so every DateTime it returns is off by the SESSION's offset unless that
      // offset is zero — found on a database whose TimeZone is America/Toronto, where
      // `createdAt` came back four hours early. RDS defaults to UTC, which is why nothing
      // in production showed it; it is set here, transaction-local, so it cannot depend
      // on that. The `pg` pool's own sessions (lib/db/client.ts) are untouched.
      // test/prisma-tenancy.db.test.ts pins it.
      await tx.$executeRaw`SELECT set_config('TimeZone', 'UTC', true)`;
      return scope.run({ orgId, tx, afterCommit: afterCommitQueue }, () => fn(tx));
    },
    { timeout: options.timeoutMs ?? 30_000, maxWait: 10_000 },
  );
  // Committed. A rolled-back scope throws above, so nothing queued by it ever runs.
  for (const job of afterCommitQueue) {
    await job().catch((err) =>
      console.warn(`[db] after-commit work failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return result;
}

/**
 * VeloExpense (w3-02a): run `fn` once the current tenant transaction has COMMITTED — or now,
 * when there is no transaction to wait for (statement at a time, or no scope at all).
 *
 * For handing work to another process that will read what this transaction wrote. A
 * request runs whole inside one transaction (the tRPC `tenant` middleware), so a job
 * enqueued in the middle of it can start before the rows it is about can be seen — a
 * receipt job that finds no receipt and does nothing. ExpenseOS's web app has no request
 * transaction, so its enqueue after a write is already after the commit; this keeps that
 * order here. A rolled-back transaction runs none of its queued work. `fn`'s failure is
 * logged, never thrown at the caller whose transaction has already committed.
 */
export function afterCommit(fn: () => Promise<void>): Promise<void> {
  const current = scope.getStore();
  if (current) {
    current.afterCommit.push(fn);
    return Promise.resolve();
  }
  return fn().catch((err) =>
    console.warn(`[db] after-commit work failed: ${err instanceof Error ? err.message : String(err)}`),
  );
}

/**
 * VeloExpense (w3-02a): run `fn` with `db` scoped to one organization, ONE STATEMENT AT A
 * TIME — each call through `db` is its own `withTenantDb` transaction, committed when it
 * returns.
 *
 * For the worker. A request is short and runs whole inside `withTenantDb`; a receipt job
 * is not: it writes the reading's status (SCANNING, EXTRACTING) and then waits up to a
 * minute on the model. Inside one transaction those status writes would be invisible
 * until the job ended — the screen would never see a reading in flight, and `submit`,
 * which refuses while one is (`reportExtractionProgress`), would not hold the report — and
 * the transaction would sit open across a network call. ExpenseOS's worker gets the same
 * statement-at-a-time behaviour from its global Prisma client; here every statement still
 * runs under the tenant's RLS scope, as `veloapp`.
 *
 * Inside it, `db.$transaction(fn)` opens ONE real tenant transaction for `fn` (and `db` in
 * `fn` uses it), which is what ported code means by it. The array form is refused: its
 * operations would already have run, one by one, before it could group them.
 */
export async function withTenantStatements<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (!ORG_UUID.test(orgId)) throw new TenantScopeError('withTenantStatements: invalid organization id');
  if (scope.getStore() || statements.getStore()) {
    throw new TenantScopeError('withTenantStatements: already inside a tenant scope');
  }
  return statements.run({ orgId }, fn);
}

const statements = new AsyncLocalStorage<{ orgId: string }>();

/**
 * f63: is this code inside a real tenant TRANSACTION (as opposed to statement-at-a-time, or no
 * scope at all)? For tests and assertions that a long wait — a model call — holds no
 * transaction open.
 */
export function inTenantTransaction(): boolean {
  return scope.getStore() !== undefined;
}

/**
 * f63: `withTenantStatements`, for a caller that may already be scoped to the same tenant —
 * a tRPC procedure reached through the assistant's tool executor, which already runs
 * statement-at-a-time (app/api/assistant/chat, app/api/mcp).
 *
 *   · no scope: statement-at-a-time for `orgId`;
 *   · already statement-at-a-time for `orgId`: as it is;
 *   · already inside a tenant TRANSACTION for `orgId`: inside it. A transaction cannot be left
 *     part-way, so code that asked for statements runs on it — correct, only not short. Only
 *     tests and nested callers reach this.
 *
 * Another organization's scope refuses, as `withTenantDb` does.
 */
export async function withTenantStatementsHere<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (!ORG_UUID.test(orgId)) throw new TenantScopeError('withTenantStatementsHere: invalid organization id');
  const current = scope.getStore()?.orgId ?? statements.getStore()?.orgId;
  if (current === undefined) return withTenantStatements(orgId, fn);
  if (current !== orgId) {
    throw new TenantScopeError('withTenantStatementsHere: already scoped to a different organization');
  }
  return fn();
}

/** The organization the current scope belongs to, or null outside one. */
export function currentTenantId(): string | null {
  return scope.getStore()?.orgId ?? statements.getStore()?.orgId ?? null;
}

/** `db`'s property under `withTenantStatements`: each call is its own tenant transaction. */
function statementProperty(orgId: string, prop: string | symbol): unknown {
  if (prop === '$transaction') {
    return (arg: unknown) => {
      if (typeof arg !== 'function') {
        throw new TenantScopeError(
          'db.$transaction([...]) is not supported statement-at-a-time (lib/db/prisma.ts withTenantStatements)',
        );
      }
      return withTenantDb(orgId, (tx) => (arg as (t: TenantDb) => Promise<unknown>)(tx));
    };
  }
  if (prop === '$connect' || prop === '$disconnect') return async () => {};
  if (typeof prop === 'string' && prop.startsWith('$')) {
    // $queryRaw / $executeRaw and the rest of the client's own methods.
    return (...args: unknown[]) =>
      withTenantDb(orgId, (tx) =>
        ((tx as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[prop] as (
          ...a: unknown[]
        ) => Promise<unknown>).apply(tx, args),
      );
  }
  // A model delegate (`db.receipt`): every method runs in its own tenant transaction.
  return new Proxy(
    {},
    {
      get(_t, method) {
        if (method === 'then') return undefined;
        return (...args: unknown[]) =>
          withTenantDb(orgId, (tx) => {
            const delegate = (tx as unknown as Record<string | symbol, Record<string | symbol, unknown>>)[prop];
            return (delegate[method] as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
          });
      },
    },
  );
}

function scoped(): Scope {
  const s = scope.getStore();
  if (!s) {
    throw new TenantScopeError(
      'db used outside withTenantDb: ported code must run inside a tenant scope (lib/db/prisma.ts)',
    );
  }
  return s;
}

async function runInOrder(ops: readonly PromiseLike<unknown>[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const op of ops) out.push(await op);
  return out;
}

/**
 * ExpenseOS's `db`. Every property resolves against the current tenant
 * transaction at call time.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const perStatement = scope.getStore() ? null : statements.getStore();
    if (perStatement) return statementProperty(perStatement.orgId, prop);
    const { tx } = scoped();
    if (prop === '$transaction') {
      return (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (t: TenantDb) => Promise<unknown>)(tx)
          : runInOrder(arg as PromiseLike<unknown>[]);
    }
    if (prop === '$connect' || prop === '$disconnect') return async () => {};
    const value = (tx as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(tx) : value;
  },
});

export { Prisma };

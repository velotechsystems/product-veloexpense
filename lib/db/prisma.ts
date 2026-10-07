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
  return baseClient().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
      return scope.run({ orgId, tx }, () => fn(tx));
    },
    { timeout: options.timeoutMs ?? 30_000, maxWait: 10_000 },
  );
}

/** The organization the current scope belongs to, or null outside one. */
export function currentTenantId(): string | null {
  return scope.getStore()?.orgId ?? null;
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

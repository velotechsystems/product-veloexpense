/**
 * VeloExpense: the harness ported router suites run on, in place of ExpenseOS's
 * `@expenseos/db/test-client`.
 *
 * ExpenseOS's database-backed router suites run against its seeded, single-tenant
 * database with a plain Prisma client, so a test reads `db.expense.findUnique(…)` and calls
 * `caller.updateExpense(…)` directly. VeloExpense has no query outside a tenant: every
 * statement runs inside `withTenantDb`, under RLS. This harness keeps the ported test
 * bodies verbatim by putting the tenant scope UNDER them:
 *
 *   · `db` — every model call (`db.expense.findUnique(…)`) and `db.$transaction(fn)` runs in
 *     its own tenant transaction, as the app role;
 *   · `makeCaller(perms, userId)` — every procedure call runs in its own tenant transaction,
 *     exactly as the request middleware would run it, with ExpenseOS's injected context
 *     (`makeContext`) for the permissions;
 *   · the tenant, its people and its fixtures are this suite's own, created on a database
 *     the suite truncates first (as every VeloExpense db suite does), with storage in
 *     memory and `storage.delete` and `storage.presignUpload` spied on;
 *   · `lastAudit(entityType, entityId)` reads VeloExpense's `audit_entry` (ExpenseOS:
 *     `db.audit`).
 */
import { Pool } from 'pg';
import { vi } from 'vitest';
import { makeContext } from './trpcCaller';

export interface HarnessPerson {
  id: string;
  email: string;
}

export interface TenantHarness {
  orgId: string;
  /** The founder (ADMIN) first, then the people asked for, in order. */
  people: HarnessPerson[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ported suites read rows untyped (`db: any`).
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above.
  makeCaller: (perms: readonly string[], userId: string, router?: unknown) => any;
  /** The superuser pool, for fixtures RLS or the Prisma view cannot write. */
  admin: Pool;
  /**
   * The suite's in-memory storage: `delete` and `presignUpload` spied on, and `memory` itself
   * for putting an object where a test needs one to exist (`receiptCreate` reads the object
   * back before it records a receipt, d29).
   */
  storage: {
    delete: ReturnType<typeof vi.fn>;
    presignUpload: ReturnType<typeof vi.fn>;
    memory: import('@/lib/storage').MemoryStorage;
  };
  lastAudit: (
    entityType: string,
    entityId: string,
  ) => Promise<{ action: string; details: unknown } | null>;
  end: () => Promise<void>;
}

/** Run every function reached through `target` inside `run`. Two levels: model → method. */
function scoped<T extends object>(target: T, run: <R>(fn: () => Promise<R>) => Promise<R>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      const value = (t as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') return scopedFn(value as (...a: unknown[]) => unknown, t, run);
      if (value && typeof value === 'object') return scoped(value as object, run);
      return value;
    },
  }) as T;
}

/**
 * A procedure — or a NESTED ROUTER, which tRPC's caller also hands back as a callable proxy
 * (`caller.mileageRate.create`). Calling it runs in the tenant scope; reading a property off
 * it goes one level down, scoped the same way. w2-10: the first suite to call a nested
 * router through the harness.
 */
function scopedFn(
  fn: (...a: unknown[]) => unknown,
  self: unknown,
  run: <R>(fn: () => Promise<R>) => Promise<R>,
): unknown {
  return new Proxy(fn, {
    apply: (_f, _this, args) => run(async () => Reflect.apply(fn, self, args)),
    get(f, prop) {
      if (prop === 'then') return undefined;
      const value = (f as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') return scopedFn(value as (...a: unknown[]) => unknown, f, run);
      if (value && typeof value === 'object') return scoped(value as object, run);
      return value;
    },
  });
}

export async function createTenantHarness(opts: {
  slug: string;
  name: string;
  /** People besides the founder. */
  people?: Array<{ email: string; name: string; role?: string }>;
}): Promise<TenantHarness> {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');

  const { createOrganization } = await import('@/lib/onboarding/provision');
  const { db: tenantDb, withTenantDb } = await import('@/lib/db/prisma');
  const { MemoryStorage, setStorage } = await import('@/lib/storage');
  const { createCallerFactory } = await import('@/server/trpc');
  const { expensesRouter } = await import('@/server/routers/expenses');

  const founderEmail = `founder@${opts.slug}.test`;
  const orgId = (
    await createOrganization({ name: opts.name, slug: opts.slug, adminEmail: founderEmail, adminName: 'Founder' })
  ).organizationId;
  const founder = (
    await admin.query(`SELECT id FROM app_user WHERE organization_id = $1 AND email = $2`, [orgId, founderEmail])
  ).rows[0].id as string;
  const people: HarnessPerson[] = [{ id: founder, email: founderEmail }];
  for (const p of opts.people ?? []) {
    const id = (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, p.email, p.name, p.role ?? 'EMPLOYEE'],
      )
    ).rows[0].id as string;
    people.push({ id, email: p.email });
  }

  const memory = new MemoryStorage();
  const remove = memory.delete.bind(memory);
  const presign = memory.presignUpload.bind(memory);
  const storage = {
    delete: vi.fn((key: string) => remove(key)),
    presignUpload: vi.fn((...args: Parameters<typeof presign>) => presign(...args)),
    memory,
  };
  setStorage(Object.assign(memory, { delete: storage.delete, presignUpload: storage.presignUpload }) as never);

  const run = <R>(fn: () => Promise<R>) => withTenantDb(orgId, () => fn());
  const db = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === '$transaction') {
        return (fn: (tx: unknown) => Promise<unknown>) => withTenantDb(orgId, (tx) => fn(tx));
      }
      if (prop === 'then') return undefined;
      // A model delegate, resolved inside the scope on each call.
      return new Proxy(
        {},
        {
          get(_m, method) {
            return (...args: unknown[]) =>
              run(async () => {
                const delegate = (tenantDb as unknown as Record<string | symbol, Record<string | symbol, unknown>>)[prop];
                return (delegate[method] as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
              });
          },
        },
      );
    },
  });

  const emailOf = new Map(people.map((p) => [p.id, p.email]));
  /** A caller on `router` (ExpenseOS's expenses router unless another is named). */
  const makeCaller = (perms: readonly string[], userId: string, router: unknown = expensesRouter) =>
    scoped(
      createCallerFactory(router as typeof expensesRouter)(
        makeContext({
          db: tenantDb,
          userId,
          permissions: perms,
          email: emailOf.get(userId) ?? `${userId}@nowhere.test`,
        }),
      ) as object,
      run,
    );

  const lastAudit = async (entityType: string, entityId: string) =>
    ((
      await admin.query(
        `SELECT action, details FROM audit_entry WHERE entity_type = $1 AND entity_id = $2 ORDER BY sequence DESC LIMIT 1`,
        [entityType, entityId],
      )
    ).rows[0] as { action: string; details: unknown } | undefined) ?? null;

  return { orgId, people, db, makeCaller, admin, storage, lastAudit, end: () => admin.end() };
}

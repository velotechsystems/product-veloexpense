/**
 * Wave 0 — ExpenseOS's tRPC, running in a multi-tenant app (decided 7 Oct).
 *
 * ExpenseOS has one company per deployment, so its tRPC context never had to answer
 * "which tenant?". VeloExpense's `tenant` middleware (server/trpc.ts) does, and this suite
 * is what it promises, through real procedures against a real database:
 *
 *   · a procedure's `ctx.db` sees only the caller's organization;
 *   · `ctx.session.user.id` is the caller's `app_user.id`, which ported routers write;
 *   · the role comes from the DATABASE, mapped to ExpenseOS's system roles;
 *   · a deactivated account, a non-member, or a host naming another tenant is refused;
 *   · a procedure that fails rolls back everything it wrote;
 *   · no session means no tenant: `protectedProcedure` refuses and `db` cannot be used.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { TRPCError } from '@trpc/server';
import { permissions as P } from '@expenseos/rbac';

const host = vi.hoisted(() => ({ slug: null as string | null }));
// next-auth's runtime cannot load under vitest; the context is passed in directly below.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => host.slug }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { createCallerFactory, protectedProcedure, router, withPermission } = await import(
  '@/server/trpc'
);
const { db } = await import('@/lib/db/prisma');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let adminId: string;
let employeeId: string;

const testRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.session.user.id,
    roleLabel: ctx.session.user.roleLabel,
    canListCategories: ctx.rbac.permissions.includes(P.admin.expenseCategory.list),
  })),
  categories: protectedProcedure.query(({ ctx }) =>
    ctx.db.expenseCategory.findMany({ select: { organizationId: true } }),
  ),
  writeThenFail: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.expenseCategory.create({ data: { code: 'ROLLED_BACK', label: { en: 'Rolled back' } } });
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Refused after writing.' });
  }),
  adminOnly: withPermission(P.admin.role.create).query(() => 'ok'),
});

const call = (email: string | null, organizationId: string) =>
  createCallerFactory(testRouter)({
    session: null,
    db,
    rbac: null,
    caller: email ? { email, organizationId } : null,
  });

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha', slug: 'alpha-trpc', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta', slug: 'beta-trpc', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  adminId = (await admin.query("SELECT id FROM app_user WHERE email = 'boss@alpha.test'")).rows[0].id;
  employeeId = (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role)
       VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE') RETURNING id`,
      [A],
    )
  ).rows[0].id;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role, deleted_at)
     VALUES ($1, 'gone@alpha.test', 'Gone', 'EMPLOYEE', now())`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('who is asking', () => {
  it("is the caller's app_user row, with the role read from the database", async () => {
    const me = await call('BOSS@alpha.test', A).whoami();
    expect(me.id).toBe(adminId);
    expect(me.roleLabel).toBe('System Administrator');
    expect(me.canListCategories).toBe(true);
  });

  it('maps EMPLOYEE to ExpenseOS Employee, which cannot manage categories', async () => {
    const me = await call('emp@alpha.test', A).whoami();
    expect(me.id).toBe(employeeId);
    expect(me.roleLabel).toBe('Employee');
    expect(me.canListCategories).toBe(false);
  });

  it('follows a demotion on the next request, whatever the session token says', async () => {
    await admin.query("UPDATE app_user SET role = 'EMPLOYEE' WHERE id = $1", [adminId]);
    try {
      expect((await call('boss@alpha.test', A).whoami()).canListCategories).toBe(false);
    } finally {
      await admin.query("UPDATE app_user SET role = 'ADMIN' WHERE id = $1", [adminId]);
    }
  });

  it('withPermission refuses a role without the permission', async () => {
    expect(await codeOf(call('emp@alpha.test', A).adminOnly())).toBe('FORBIDDEN');
    expect(await codeOf(call('boss@alpha.test', A).adminOnly())).toBe('OK');
  });
});

describe('refusals', () => {
  it('a deactivated account', async () => {
    expect(await codeOf(call('gone@alpha.test', A).whoami())).toBe('FORBIDDEN');
  });

  it('somebody who is not a member of the organization the session names', async () => {
    expect(await codeOf(call('boss@beta.test', A).whoami())).toBe('FORBIDDEN');
  });

  it('a host that names another tenant', async () => {
    host.slug = 'beta-trpc';
    try {
      expect(await codeOf(call('boss@alpha.test', A).whoami())).toBe('FORBIDDEN');
    } finally {
      host.slug = null;
    }
  });

  it('the host that matches is fine', async () => {
    host.slug = 'alpha-trpc';
    try {
      expect(await codeOf(call('boss@alpha.test', A).whoami())).toBe('OK');
    } finally {
      host.slug = null;
    }
  });

  it('no session: protectedProcedure answers UNAUTHORIZED', async () => {
    expect(await codeOf(call(null, A).whoami())).toBe('UNAUTHORIZED');
  });
});

describe('the tenant transaction', () => {
  it("ctx.db sees only the caller's organization", async () => {
    const rows = await call('boss@alpha.test', A).categories();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.organizationId))).toEqual(new Set([A]));
    const [{ n }] = (await admin.query('SELECT count(*)::int AS n FROM expense_category WHERE organization_id = $1', [B]))
      .rows;
    expect(n).toBeGreaterThan(0);
  });

  it('a procedure that fails rolls back what it wrote', async () => {
    expect(await codeOf(call('boss@alpha.test', A).writeThenFail())).toBe('PRECONDITION_FAILED');
    const [{ n }] = (await admin.query("SELECT count(*)::int AS n FROM expense_category WHERE code = 'ROLLED_BACK'"))
      .rows;
    expect(n).toBe(0);
  });
});

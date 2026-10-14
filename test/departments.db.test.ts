/**
 * Wave 1 — ExpenseOS's department router (its admin-lookup factory with a parent and a
 * cycle guard), ported, against a real database.
 *
 * `server/routers/adminLookup.test.ts` covers the hierarchy guard with a stub `db`. This
 * proves it against Postgres, and what only Postgres can:
 *
 *   · the parent round-trips as ExpenseOS's `parentId` on VeloExpense's
 *     `parent_department_id`, and can be cleared;
 *   · a department cannot be its own parent (router and table), and a parent that would
 *     close a loop is refused, walking real rows;
 *   · VeloExpense: another tenant's department is refused as a parent as BAD_REQUEST
 *     (RLS hides it; without the check the composite FK would refuse it as a 500);
 *   · External IDs, audit rows under the registry's names, and a chain that verifies;
 *   · tenancy and permissions.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { TRPCError } from '@trpc/server';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { createCallerFactory } = await import('@/server/trpc');
const { appRouter } = await import('@/server/routers/_app');
const { db } = await import('@/lib/db/prisma');
const { withOrg } = await import('@/lib/tenant/context');
const { verifyChain } = await import('@/lib/audit/verify');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

/** The factory's create/update input types leave out per-entity fields (ExpenseOS's own
 *  callers cast for the same reason); the router validates and takes them. */
type LooseLookup = {
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (input: { id: string; patch: Record<string, unknown> }) => Promise<unknown>;
};
const depts = (c: ReturnType<typeof as>) => c.departments as unknown as LooseLookup;

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

type Row = { id: string; label: unknown; parentId: string | null; externalIds: unknown };

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha D', slug: 'alpha-d', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta D', slug: 'beta-d', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'emp@alpha.test', 'Emp', '019e3000-0000-7000-8000-000000000004')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('the parent', () => {
  it('round-trips, clears, and is audited into a chain that verifies', async () => {
    const c = as('boss@alpha.test', A);
    const ga = (await depts(c).create({ label: { en: 'General & Admin' }, externalIds: { ledger: 'D-1' } })) as Row;
    const fin = (await depts(c).create({ label: { en: 'Finance' }, parentId: ga.id })) as Row;
    expect(fin.parentId).toBe(ga.id);
    expect(ga.externalIds).toEqual({ ledger: 'D-1' });
    expect(
      (await admin.query('SELECT parent_department_id FROM department WHERE id = $1', [fin.id])).rows[0]
        .parent_department_id,
    ).toBe(ga.id);

    const detached = (await depts(c).update({ id: fin.id, patch: { parentId: null } })) as Row;
    expect(detached.parentId).toBeNull();

    const audit = (
      await admin.query(`SELECT action, entity_type FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [fin.id])
    ).rows;
    // ExpenseOS's factory derives the type from "Department".
    expect(audit).toEqual([
      { action: 'DEPARTMENT_CREATED', entity_type: 'Department' },
      { action: 'DEPARTMENT_UPDATED', entity_type: 'Department' },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('refuses a department as its own parent; the table refuses it too', async () => {
    const c = as('boss@alpha.test', A);
    const d = (await depts(c).create({ label: { en: 'Self' } })) as Row;
    expect(await codeOf(depts(c).update({ id: d.id, patch: { parentId: d.id } }))).toBe('BAD_REQUEST');
    await expect(
      admin.query('UPDATE department SET parent_department_id = id WHERE id = $1', [d.id]),
    ).rejects.toThrow(/department_not_own_parent/);
  });

  it('refuses a parent that would close a loop, walking the real rows', async () => {
    const c = as('boss@alpha.test', A);
    const top = (await depts(c).create({ label: { en: 'Top' } })) as Row;
    const mid = (await depts(c).create({ label: { en: 'Mid' }, parentId: top.id })) as Row;
    const leaf = (await depts(c).create({ label: { en: 'Leaf' }, parentId: mid.id })) as Row;
    // Top under Leaf would make Top → Leaf → Mid → Top.
    expect(await codeOf(depts(c).update({ id: top.id, patch: { parentId: leaf.id } }))).toBe('BAD_REQUEST');
    expect(
      (await admin.query('SELECT parent_department_id FROM department WHERE id = $1', [top.id])).rows[0]
        .parent_department_id,
    ).toBeNull();
  });

  it('VeloExpense: refuses another tenant’s department as a parent, as BAD_REQUEST', async () => {
    const beta = (await depts(as('boss@beta.test', B)).create({ label: { en: 'Beta Ops' } })) as Row;
    const c = as('boss@alpha.test', A);
    expect(await codeOf(depts(c).create({ label: { en: 'Borrowed parent' }, parentId: beta.id }))).toBe('BAD_REQUEST');
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM department WHERE label ->> 'en' = 'Borrowed parent'`)).rows[0].n,
    ).toBe(0);
  });
});

describe('tenancy and permissions', () => {
  it('lists only the tenant’s own departments, answers a duplicate name with CONFLICT, and refuses an employee', async () => {
    const alpha = (await as('boss@alpha.test', A).departments.list({ includeInactive: true })).items;
    const beta = (await as('boss@beta.test', B).departments.list({ includeInactive: true })).items;
    expect(alpha.map((r) => r.id).filter((id) => beta.some((b) => b.id === id))).toEqual([]);
    expect(await codeOf(depts(as('boss@alpha.test', A)).create({ label: { en: ' finance ' } }))).toBe('CONFLICT');
    expect(await codeOf(as('emp@alpha.test', A).departments.list())).toBe('FORBIDDEN');
  });
});

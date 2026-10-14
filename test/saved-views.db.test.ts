/**
 * w4-08 — ExpenseOS's saved views (`savedViews` router), ported, against a real database
 * (migration 0067). ExpenseOS's mocked suite (server/routers/savedViews.test.ts) proves the
 * router's rules; this proves what only the database can:
 *
 *   · a view is its OWNER's: another person in the same tenant neither lists it nor can
 *     change it (NOT_FOUND, as ExpenseOS answers);
 *   · and its TENANT's: RLS keeps another tenant's views out even for an owner id that
 *     matches nothing here;
 *   · exactly one pinned default per person and list, in the table as well as in the code
 *     (`saved_view_one_default`): a second pin through the router moves the default, and a
 *     second pinned row written behind the router's back is refused;
 *   · every write is audited into a chain that verifies; a delete is soft.
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
let bossId: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@sv-a.test', A);
const colleague = () => as('emp@sv-a.test', A);
const other = () => as('boss@sv-b.test', B);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

const STATE = { filters: [{ id: 'c1', field: 'status', op: 'equals' as const, value: 'SUBMITTED' }] };

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'SV A', slug: 'sv-a', adminEmail: 'boss@sv-a.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'SV B', slug: 'sv-b', adminEmail: 'boss@sv-b.test', adminName: 'Other' }))
    .organizationId;
  bossId = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@sv-a.test'`)).rows[0].id;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'emp@sv-a.test', 'Emp', '019e3000-0000-7000-8000-000000000004')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('a saved view', () => {
  it('is its owner’s, in its tenant', async () => {
    const mine = await boss().savedViews.create({ resource: 'approvals', name: 'Mine', state: STATE });
    await other().savedViews.create({ resource: 'approvals', name: 'Theirs', state: STATE });

    expect((await boss().savedViews.list({ resource: 'approvals' })).map((v) => v.name)).toEqual(['Mine']);
    expect(await colleague().savedViews.list({ resource: 'approvals' })).toEqual([]);
    expect((await other().savedViews.list({ resource: 'approvals' })).map((v) => v.name)).toEqual(['Theirs']);

    // Another person in the same tenant cannot reach it; nor can another tenant.
    expect(await codeOf(colleague().savedViews.update({ id: mine.id, name: 'Taken' }))).toBe('NOT_FOUND');
    expect(await codeOf(colleague().savedViews.delete({ id: mine.id }))).toBe('NOT_FOUND');
    expect(await codeOf(other().savedViews.togglePinned({ id: mine.id }))).toBe('NOT_FOUND');
    const row = (await admin.query(`SELECT name, organization_id, owner_id FROM saved_view WHERE id = $1`, [mine.id]))
      .rows[0];
    expect(row).toEqual({ name: 'Mine', organization_id: A, owner_id: bossId });
  });

  it('has one pinned default per person and list, moved rather than doubled', async () => {
    const first = await boss().savedViews.create({ resource: 'expenses', name: 'First', state: STATE, pinned: true });
    const second = await boss().savedViews.create({ resource: 'expenses', name: 'Second', state: STATE, pinned: true });
    const pinned = async () =>
      (
        await admin.query(
          `SELECT id FROM saved_view WHERE owner_id = $1 AND resource = 'expenses' AND pinned AND deleted_at IS NULL`,
          [bossId],
        )
      ).rows.map((r) => r.id);
    expect(await pinned()).toEqual([second.id]);
    await boss().savedViews.togglePinned({ id: first.id });
    expect(await pinned()).toEqual([first.id]);
    await boss().savedViews.update({ id: second.id, pinned: true });
    expect(await pinned()).toEqual([second.id]);

    // VeloExpense: the table holds the rule too — a second default written behind the
    // router's back (or by two pins racing past its read) is refused.
    await expect(
      admin.query(
        `INSERT INTO saved_view (organization_id, owner_id, resource, name, state, pinned)
         VALUES ($1, $2, 'expenses', 'Sneaky', '{"filters":[]}', true)`,
        [A, bossId],
      ),
    ).rejects.toThrow(/saved_view_one_default/);
  });

  it('is soft-deleted, and every write is audited into a chain that verifies', async () => {
    const v = await boss().savedViews.create({ resource: 'people', name: 'To go', state: STATE });
    await boss().savedViews.update({ id: v.id, name: 'Renamed' });
    await boss().savedViews.delete({ id: v.id });

    expect(await boss().savedViews.list({ resource: 'people' })).toEqual([]);
    expect(
      (await admin.query(`SELECT name, deleted_at IS NOT NULL AS gone FROM saved_view WHERE id = $1`, [v.id])).rows,
    ).toEqual([{ name: 'Renamed', gone: true }]);

    const actions = (
      await admin.query(
        `SELECT action FROM audit_entry
          WHERE organization_id = $1 AND action LIKE 'SAVED_VIEW_%' AND (entity_id = $2 OR details->>'name' = 'To go')
          ORDER BY sequence`,
        [A, v.id],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(['SAVED_VIEW_CREATED', 'SAVED_VIEW_UPDATED', 'SAVED_VIEW_DELETED']);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('refuses a list no screen has', async () => {
    expect(await codeOf(boss().savedViews.list({ resource: 'nope' } as never))).toBe('BAD_REQUEST');
  });
});

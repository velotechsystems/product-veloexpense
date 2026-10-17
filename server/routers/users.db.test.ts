// @vitest-environment node
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: the People router's reads against a real database (People 1). Not in
 * ExpenseOS, whose users-router tests are hermetic (users.listDirectory.test.ts and
 * users.reads.test.ts, ported beside this file). Those pin the WHERE clauses the router
 * builds; this pins what only Postgres can say:
 *
 *   · the raw SQL — the pg_trgm search, the recursive scope walk, the facet GROUP BY and
 *     the external-id predicates — names `app_user` and `user_external_id` correctly;
 *   · every read stays inside the caller's tenant, raw SQL included, because it runs under
 *     the tenant's RLS (a second tenant holds a near-identical person);
 *   · the name trigger (0072) splits a row written with only `display_name`, which is how
 *     invitation acceptance writes people.
 *
 * Calls go through the app router as a request does (by email and organization), as
 * roles.db.test.ts does. Gated on DATABASE_URL like every `*.db.test.ts`.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('users router reads (integration)', () => {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let A: string;
  let B: string;
  const ids: Record<string, string> = {};
  let usersAs: (email: string, organizationId?: string) => ReturnType<
    typeof import('@/server/routers/_app').appRouter.createCaller
  >['users'];

  /** A person in a tenant, written as invitation acceptance writes one: display name only. */
  const person = async (
    organizationId: string,
    email: string,
    displayName: string,
    over: { managerId?: string; roleId?: string; departmentId?: string; hasAccess?: boolean } = {},
  ) => {
    const r = await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, manager_id, role_id, department_id, has_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        organizationId,
        email,
        displayName,
        over.managerId ?? null,
        over.roleId ?? SYSTEM_ROLE_IDS.employee,
        over.departmentId ?? null,
        over.hasAccess ?? true,
      ],
    );
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    A = (
      await createOrganization({ name: 'People A', slug: 'people-a', adminEmail: 'boss@people-a.test', adminName: 'Grace Hopper' })
    ).organizationId;
    B = (
      await createOrganization({ name: 'People B', slug: 'people-b', adminEmail: 'boss@people-b.test', adminName: 'Other Boss' })
    ).organizationId;
    ids.boss = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@people-a.test'`)).rows[0].id;

    const dept = (
      await admin.query(`INSERT INTO department (organization_id, label) VALUES ($1, '{"en":"Research"}') RETURNING id`, [A])
    ).rows[0].id as string;
    ids.dept = dept;

    // A reporting tree in A: boss ← manager ← (ada, alan); ada ← intern. Plus a peer of the
    // manager, and somebody whose access is revoked.
    ids.manager = await person(A, 'mgr@people-a.test', 'Margaret Hamilton', {
      managerId: ids.boss,
    });
    ids.ada = await person(A, 'ada@people-a.test', 'Ada Lovelace', { managerId: ids.manager, departmentId: dept });
    ids.alan = await person(A, 'alan@people-a.test', 'Alan Turing', { managerId: ids.manager, departmentId: dept });
    ids.intern = await person(A, 'intern@people-a.test', 'Katherine Johnson', { managerId: ids.ada });
    ids.peer = await person(A, 'peer@people-a.test', 'Barbara Liskov', {
      managerId: ids.boss,
    });
    ids.revoked = await person(A, 'gone@people-a.test', 'Edsger Dijkstra', { hasAccess: false });
    // B holds a near-namesake of Ada, who must never surface in A.
    ids.otherAda = await person(B, 'ada@people-b.test', 'Ada Lovelace-Byron');

    const src = (
      await admin.query(
        `INSERT INTO external_id_source (organization_id, code, label) VALUES ($1, 'netsuite', '{"en":"NetSuite"}') RETURNING id`,
        [A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO user_external_id (organization_id, source_id, source_value, user_id) VALUES ($1, $2, 'NS-1815', $3)`,
      [A, src, ids.ada],
    );

    usersAs = (email, organizationId = A) =>
      createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } }).users;
  });

  afterAll(async () => {
    await admin.end();
  });

  it('splits a display name into first and last name on insert (0072)', async () => {
    const r = await admin.query(`SELECT first_name, last_name FROM app_user WHERE id = $1`, [ids.ada]);
    expect(r.rows[0]).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('lists the whole tenant to an admin, in (first, last, id) order, and nobody from another tenant', async () => {
    const out = await usersAs('boss@people-a.test').listDirectory({ take: 50 });
    const names = out.items.map((u) => `${u.firstName} ${u.lastName}`);
    expect(names).toEqual([
      'Ada Lovelace',
      'Alan Turing',
      'Barbara Liskov',
      'Edsger Dijkstra',
      'Grace Hopper',
      'Katherine Johnson',
      'Margaret Hamilton',
    ]);
    expect(out.totalCount).toBe(7);
    expect(out.items.some((u) => u.email.endsWith('people-b.test'))).toBe(false);
  });

  it('pages with the tuple cursor without skipping or repeating anybody', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const out = await usersAs('boss@people-a.test').listDirectory({ take: 3, cursor });
      seen.push(...out.items.map((u) => u.id));
      if (!out.nextCursor) break;
      cursor = out.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('searches by trigram within the tenant only', async () => {
    const out = await usersAs('boss@people-a.test').listDirectory({ search: 'Lovelace' });
    expect(out.items.map((u) => u.id)).toEqual([ids.ada]);
  });

  it('finds somebody by their external id', async () => {
    const bySearch = await usersAs('boss@people-a.test').listDirectory({ search: 'NS-1815' });
    expect(bySearch.items.map((u) => u.id)).toEqual([ids.ada]);
    const byFilter = await usersAs('boss@people-a.test').listDirectory({
      externalIds: { op: 'equals', value: 'ns-1815' },
    });
    expect(byFilter.items.map((u) => u.id)).toEqual([ids.ada]);
    expect(byFilter.items[0]?.externalIds).toEqual({ netsuite: 'NS-1815' });
  });

  it('filters by access', async () => {
    const out = await usersAs('boss@people-a.test').listDirectory({ access: { op: 'equals', value: 'denied' } });
    expect(out.items.map((u) => u.id)).toEqual([ids.revoked]);
    expect(out.items[0]?.hasAccess).toBe(false);
  });

  it("gives a manager their chain, not themselves and not their peer's team", async () => {
    const chain = await usersAs('mgr@people-a.test').listDirectory({ scope: 'chain' });
    expect(chain.items.map((u) => u.id).sort()).toEqual([ids.ada, ids.alan, ids.intern].sort());
    const direct = await usersAs('mgr@people-a.test').listDirectory({ scope: 'direct' });
    expect(direct.items.map((u) => u.id).sort()).toEqual([ids.ada, ids.alan].sort());
    const indirect = await usersAs('mgr@people-a.test').listDirectory({ scope: 'indirect' });
    expect(indirect.items.map((u) => u.id)).toEqual([ids.intern]);
  });

  it("refuses scope 'all' to somebody without user.read.all", async () => {
    await expect(usersAs('mgr@people-a.test').listDirectory({ scope: 'all' })).rejects.toThrow(/user\.read\.all/);
  });

  it('lets a manager open a report, and not a peer', async () => {
    const ada = await usersAs('mgr@people-a.test').get({ id: ids.ada });
    expect(ada.firstName).toBe('Ada');
    expect(ada.department?.id).toBe(ids.dept);
    await expect(usersAs('peer@people-a.test').get({ id: ids.ada })).rejects.toThrow(/not visible/);
  });

  it('cannot open a person in another tenant, even as an admin', async () => {
    // RLS: the row is not there to find, so canViewUser's admin shortcut leads to NOT_FOUND.
    await expect(usersAs('boss@people-a.test').get({ id: ids.otherAda })).rejects.toThrow();
  });

  it('counts facets with the raw GROUP BY, inside the tenant', async () => {
    const out = await usersAs('boss@people-a.test').facetCounts({ fields: ['status', 'department'] });
    expect(out.scoped).toBe(true);
    expect(out.counts.status).toEqual([{ value: 'ACTIVE', count: 7 }]);
    expect(out.counts.department).toEqual([{ value: ids.dept, label: { en: 'Research' }, count: 2 }]);
  });

  it('offers only the departments somebody is in', async () => {
    await admin.query(`INSERT INTO department (organization_id, label) VALUES ($1, '{"en":"Empty"}')`, [A]);
    const out = await usersAs('boss@people-a.test').listFilterFacets();
    expect(out.departments.map((d) => d.id)).toEqual([ids.dept]);
  });

  it("lists a person's direct reports", async () => {
    const out = await usersAs('mgr@people-a.test').getDirectReports({ userId: ids.manager });
    expect(out.items.map((u) => u.firstName)).toEqual(['Ada', 'Alan']);
  });
});

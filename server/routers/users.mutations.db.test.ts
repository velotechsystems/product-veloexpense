// @vitest-environment node
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: the People router's writes against a real database (People 2). Not in
 * ExpenseOS, whose mutation tests are hermetic (users.mutations.test.ts, ported beside this
 * file). This pins what a stub cannot:
 *
 *   · every write lands an audit row in the tenant's chain, under a registered action —
 *     an unregistered one is refused and rolls the write back (packages/audit writer.ts);
 *   · deactivation hands the leaver's OPEN reports to their manager (ExpenseOS's
 *     `rollUpOnOffboard`), and the report table's own rules allow that on a SUBMITTED report;
 *   · a status that means leaving stamps `deleted_at` through `update`, so the person stops
 *     being a member (and a seat), and setting them back clears it;
 *   · writing first and last name recomposes `display_name` (0072's trigger);
 *   · an external id already held in the tenant is refused naming its holder;
 *   · `create` (People 3) sends an invitation and makes nobody; somebody already here is
 *     reported, not invited again.
 *
 * Calls go through the app router as a request does, as users.db.test.ts does. The seat
 * count's push to the platform is stubbed: it is fire-and-forget network, not this test's.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@/lib/billing/seats', () => ({ pushSeatCountInBackground: vi.fn() }));

describe.skipIf(!process.env.DATABASE_URL)('users router writes (integration)', () => {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let A: string;
  const ids: Record<string, string> = {};
  let usersAs: (email: string) => ReturnType<typeof import('@/server/routers/_app').appRouter.createCaller>['users'];

  const person = async (email: string, displayName: string, managerId: string | null = null) =>
    (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, manager_id, role_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [A, email, displayName, managerId, SYSTEM_ROLE_IDS.employee],
      )
    ).rows[0].id as string;

  const row = async (id: string) =>
    (
      await admin.query(
        `SELECT display_name, first_name, last_name, employee_status, deleted_at, has_access
           FROM app_user WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const auditFor = async (entityId: string) =>
    (
      await admin.query(
        `SELECT action, details FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
        [entityId],
      )
    ).rows as Array<{ action: string; details: Record<string, unknown> }>;

  beforeEach(async () => {
    const { createOrganization } = await import('@/lib/onboarding/provision');
    const { createCallerFactory } = await import('@/server/trpc');
    const { appRouter } = await import('@/server/routers/_app');
    const { db } = await import('@/lib/db/prisma');
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    A = (
      await createOrganization({ name: 'People W', slug: 'people-w', adminEmail: 'boss@people-w.test', adminName: 'Grace Hopper' })
    ).organizationId;
    ids.boss = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@people-w.test'`)).rows[0].id;
    ids.manager = await person('mgr@people-w.test', 'Margaret Hamilton', ids.boss);
    ids.leaver = await person('leaver@people-w.test', 'Alan Turing', ids.manager);
    usersAs = (email) =>
      createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId: A } }).users;
  });

  afterAll(async () => {
    await admin.end();
  });

  it('writes first and last name, recomposes the display name, and audits the edit', async () => {
    await usersAs('boss@people-w.test').update({
      id: ids.leaver,
      patch: { firstName: 'Alan M.', lastName: 'Turing' },
    });
    expect(await row(ids.leaver)).toMatchObject({
      first_name: 'Alan M.',
      last_name: 'Turing',
      display_name: 'Alan M. Turing',
    });
    expect(await auditFor(ids.leaver)).toEqual([
      { action: 'USER_UPDATED', details: { changedFields: ['firstName', 'lastName'] } },
    ]);
  });

  it('revokes access with an audit row naming which way it went', async () => {
    await usersAs('boss@people-w.test').setAccess({ id: ids.leaver, hasAccess: false });
    expect((await row(ids.leaver)).has_access).toBe(false);
    expect(await auditFor(ids.leaver)).toEqual([{ action: 'USER_UPDATED', details: { hasAccess: false } }]);
  });

  it("deactivates, hands the leaver's open reports to their manager, and leaves finished ones", async () => {
    const report = async (status: string) =>
      (
        await admin.query(
          `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, status)
           VALUES ($1, $2, $3, 'CAD', $4::expense_report_status) RETURNING id`,
          [A, ids.leaver, `${status} report`, status],
        )
      ).rows[0].id as string;
    const open = await report('SUBMITTED');
    const draft = await report('DRAFT');
    const done = await report('APPROVED');

    const out = await usersAs('boss@people-w.test').deactivate({ id: ids.leaver });
    expect(out.rollup).toEqual({ managerId: ids.manager, reportsToManager: 2, reportsOrphaned: 0 });

    const submitter = async (id: string) =>
      (await admin.query('SELECT submitter_id FROM expense_report WHERE id = $1', [id])).rows[0].submitter_id;
    expect(await submitter(open)).toBe(ids.manager);
    expect(await submitter(draft)).toBe(ids.manager);
    expect(await submitter(done)).toBe(ids.leaver);
    expect(await row(ids.leaver)).toMatchObject({ employee_status: 'DEACTIVATED' });
    expect((await row(ids.leaver)).deleted_at).toBeInstanceOf(Date);
    expect((await auditFor(ids.leaver)).map((a) => a.action)).toEqual(['USER_DEACTIVATED']);
  });

  it('refuses to deactivate somebody who still has a report', async () => {
    await expect(usersAs('boss@people-w.test').deactivate({ id: ids.manager })).rejects.toThrow(
      /Reassign 1 direct report before deactivating/,
    );
  });

  it('makes a TERMINATED person a non-member through update, and brings them back', async () => {
    await usersAs('boss@people-w.test').update({ id: ids.leaver, patch: { employeeStatus: 'TERMINATED' } });
    expect((await row(ids.leaver)).deleted_at).toBeInstanceOf(Date);
    // A non-member is not in the default directory any more.
    const listed = await usersAs('boss@people-w.test').listDirectory({ take: 50 });
    expect(listed.items.map((u) => u.id)).not.toContain(ids.leaver);

    await usersAs('boss@people-w.test').update({ id: ids.leaver, patch: { employeeStatus: 'ACTIVE' } });
    expect(await row(ids.leaver)).toMatchObject({ employee_status: 'ACTIVE', deleted_at: null });
  });

  it("refuses an external id somebody else in the tenant already holds, and names them", async () => {
    await usersAs('boss@people-w.test').update({ id: ids.manager, patch: { externalIds: { netsuite: 'NS-7' } } });
    await expect(
      usersAs('boss@people-w.test').update({ id: ids.leaver, patch: { externalIds: { netsuite: 'NS-7' } } }),
    ).rejects.toThrow(/already assigned to mgr@people-w\.test/);
    // And the refused write left the leaver's aliases as they were.
    const held = await admin.query('SELECT user_id FROM user_external_id');
    expect(held.rows.map((r) => r.user_id)).toEqual([ids.manager]);
  });

  describe('create (People 3): adding a person sends an invitation', () => {
    const mailbox = async () => {
      const sent: Array<{ to: string; subject: string }> = [];
      const email = await import('@/lib/notifications/email');
      const spy = vi.spyOn(email, 'sendEmail').mockImplementation(async (msg) => {
        sent.push(msg as (typeof sent)[number]);
      });
      return { sent, restore: () => spy.mockRestore() };
    };

    it('invites a new address, normalised, with the default role, and creates nobody', async () => {
      const box = await mailbox();
      try {
        const out = await usersAs('boss@people-w.test').create({ email: '  New.Person@People-W.test ' });
        expect(out).toEqual({ status: 'invited', email: 'new.person@people-w.test', resent: false });
      } finally {
        box.restore();
      }
      expect(box.sent.map((m) => m.to)).toEqual(['new.person@people-w.test']);
      const invite = (await admin.query('SELECT email, role_id FROM invite')).rows;
      expect(invite).toEqual([{ email: 'new.person@people-w.test', role_id: SYSTEM_ROLE_IDS.employee }]);
      // Their row is made when they accept, not now: no seat is taken by asking.
      expect(
        (await admin.query(`SELECT count(*)::int AS n FROM app_user WHERE email = 'new.person@people-w.test'`)).rows[0].n,
      ).toBe(0);
      expect(
        (await admin.query(`SELECT action FROM audit_entry WHERE action LIKE 'INVITE_%'`)).rows.map((r) => r.action),
      ).toEqual(['INVITE_SENT']);
    });

    it('says so when the address was already invited', async () => {
      const box = await mailbox();
      try {
        await usersAs('boss@people-w.test').create({ email: 'again@people-w.test' });
        const second = await usersAs('boss@people-w.test').create({ email: 'again@people-w.test' });
        expect(second).toMatchObject({ status: 'invited', resent: true });
      } finally {
        box.restore();
      }
      expect((await admin.query('SELECT count(*)::int AS n FROM invite')).rows[0].n).toBe(1);
    });

    it('reports somebody already here instead of inviting them, and whether they left', async () => {
      const box = await mailbox();
      try {
        expect(await usersAs('boss@people-w.test').create({ email: 'MGR@people-w.test' })).toEqual({
          status: 'exists',
          userId: ids.manager,
          deactivated: false,
          name: 'Margaret Hamilton',
        });
        await usersAs('boss@people-w.test').deactivate({ id: ids.leaver });
        expect(await usersAs('boss@people-w.test').create({ email: 'leaver@people-w.test' })).toMatchObject({
          status: 'exists',
          userId: ids.leaver,
          deactivated: true,
        });
      } finally {
        box.restore();
      }
      expect(box.sent).toEqual([]);
      expect((await admin.query('SELECT count(*)::int AS n FROM invite')).rows[0].n).toBe(0);
    });

    it('refuses somebody without the permission to add people', async () => {
      await expect(usersAs('mgr@people-w.test').create({ email: 'x@people-w.test' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect((await admin.query('SELECT count(*)::int AS n FROM invite')).rows[0].n).toBe(0);
    });
  });

  it("changes a person's role, refusing the last admin's own demotion", async () => {
    await usersAs('boss@people-w.test').setRole({ id: ids.manager, roleId: SYSTEM_ROLE_IDS['expense-administrator'] });
    expect(
      (await admin.query('SELECT role_id FROM app_user WHERE id = $1', [ids.manager])).rows[0].role_id,
    ).toBe(SYSTEM_ROLE_IDS['expense-administrator']);
    await expect(
      usersAs('boss@people-w.test').setRole({ id: ids.boss, roleId: SYSTEM_ROLE_IDS.employee }),
    ).rejects.toThrow(/last active admin/);
  });
});

// @vitest-environment node
// Ported from ExpenseOS `apps/web/src/server/routers/users.mutations.test.ts` (1e682dd6) with
// People 2. Each adaptation is marked "VeloExpense:".
import { permissions as P, SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { assertPrismaFields } from '../__test-helpers__/prismaShape';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The admin half of the users router: `update`, `setRole`, `setOnLeave`,
 * `deactivate`, `reactivate`, `resetPassword`, `setLocalePref`.
 *
 * These are the privilege-escalation guards, and each one is load-bearing:
 *
 *   · **Grant ceiling.** Anybody holding `user.setRole` could otherwise mint an
 *     admin role for themselves — horizontal privilege turned vertical. A role may
 *     only be assigned if the caller already holds every permission in it.
 *   · **Last-admin guard.** Demoting the final active admin locks the whole org out
 *     of its own administration.
 *   · **Self-lockout guard.** Same failure, one user at a time.
 *   · **Cycle detection.** A reporting-chain cycle makes the recursive scope CTE and
 *     every manager-routed approval walk in circles.
 *   · **Session epoch.** A role change, deactivation, or password reset that does not
 *     bump the epoch leaves the victim's existing JWT valid — the change appears to
 *     work and does nothing until the token expires on its own.
 *     VeloExpense: there is no epoch, because every request reads the person's role,
 *     access and deactivation from the database; those cases now pin that nothing tries
 *     to write one. There is no `resetPassword` or `setLocalePref` either (Google sign-in
 *     only; English only), so their blocks are not ported.
 *
 * Hermetic: `db` is a stub and `withAudit` is stubbed to run its callback, so the
 * assertions are on the payloads. `assertPrismaFields` guards the stub's blind spot —
 * a stub accepts a renamed column happily.
 */

const rollUpOnOffboard = stubFn(async () => ({ managerId: null, reportsToManager: 0, reportsOrphaned: 0 }));

// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));
// VeloExpense: the roll-up is exported from the package root, not `@expenseos/db/offboarding`.
vi.mock('@expenseos/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rollUpOnOffboard,
}));
// VeloExpense: seats. A reactivation is capped like a new member, and every change to the
// count is pushed to the platform; both are stubbed here and covered by users.db.test.ts.
const assertSeatAvailable = stubFn(async () => {});
const pushSeatCountInBackground = stubFn(() => {});
vi.mock('@/lib/billing/caps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertSeatAvailable,
}));
vi.mock('@/lib/billing/seats', () => ({ pushSeatCountInBackground }));
// eos batch 4 (#582): whether directory sync is on is the tenant's connection here
// (ExpenseOS mocks its `loadDirectorySettings`).
const getDirectoryConnection = stubFn(async () => ({ connected: false }) as { connected: boolean });
vi.mock('@/lib/directory/googleConnection', () => ({ getDirectoryConnection }));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: () => ({}) }));

/**
 * `withAudit` is stubbed to invoke its callback with the same stub as `tx`, and to
 * record the audit envelope. What matters is that the mutation happens INSIDE it —
 * an admin write with no audit row is the thing the wrapper exists to prevent.
 */
const auditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        auditCalls.push(envelope);
        return fn(db);
      },
    ),
  };
});

const ADMIN_ROLE = SYSTEM_ROLE_IDS.admin;
const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;

function makeDb(over: Record<string, unknown> = {}) {
  const user = {
    findUnique: stubFn(async () => null as unknown),
    // VeloExpense: the person (and a proposed manager) are read inside the tenant before a
    // write, so another tenant's id is NOT_FOUND. By default somebody active is there.
    findFirst: stubFn(async () => ({ id: U('1'), roleId: U('2'), deletedAt: null }) as unknown),
    findMany: stubFn(async () => [] as unknown[]),
    // `update` feeds its result through `toDirectoryRow`, so the stub has to return
    // the raw select shape (alias rows + the MFA-derivation columns), not just the patch.
    update: vi.fn(async (args: { data: unknown }) => ({
      id: U('1'),
      email: 'ada@e.inc',
      firstName: 'Ada',
      lastName: 'Lovelace',
      department: null,
      businessUnit: null,
      entity: null,
      jobLevel: null,
      country: 'CA',
      externalIds: [],
      employeeStatus: 'ACTIVE',
      hasAccess: true,
      onLeaveAt: null,
      terminationDate: null,
      lastLoginAt: null,
      avatarUrl: null,
      role: { id: U('2'), label: { en: 'Employee' } },
      manager: null,
      ...(args.data as object),
    })),
    count: stubFn(async () => 0),
  };
  // VeloExpense: a role is keyed (organization, id), so it is found with `findFirst`.
  const role = { findFirst: stubFn(async () => null as unknown) };
  return { user, role, ...over };
}

async function callerFor(db: unknown, permissions: readonly string[], userId = U('9')) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { usersRouter } = await import('./users');
  return createCallerFactory(usersRouter)(makeContext({ db, userId, permissions }));
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCalls.length = 0;
  getDirectoryConnection.mockResolvedValue({ connected: false });
});

describe('permission gates', () => {
  const cases = [
    ['update', P.user.update, { id: U('1'), patch: {} }],
    ['setRole', P.user.setRole, { id: U('1'), roleId: U('2') }],
    ['setOnLeave', P.user.setOnLeave, { id: U('1'), onLeave: true }],
    ['deactivate', P.user.deactivate, { id: U('1') }],
    ['reactivate', P.user.deactivate, { id: U('1') }],
    ['setAccess', P.user.setRole, { id: U('1'), hasAccess: true }],
    ['setAccessMany', P.user.setRole, { ids: [U('1')], hasAccess: true }],
  ] as const;

  for (const [name, perm, input] of cases) {
    it(`${name} refuses a caller without ${perm}`, async () => {
      const db = makeDb();
      const caller = await callerFor(db, []);
      await expect(
        (caller as never as Record<string, (i: unknown) => Promise<unknown>>)[name](input),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.user.update).not.toHaveBeenCalled();
    });
  }
});

describe('update', () => {
  it('applies the patch and audits the changed field names', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { firstName: 'Ada', country: 'CA' } });
    expect(db.user.update).toHaveBeenCalledOnce();
    expect(auditCalls[0]?.details).toEqual({ changedFields: ['firstName', 'country'] });
  });

  it('writes only real User columns', async () => {
    // A stub accepts a renamed column silently; Prisma drops it when undefined and
    // throws when it has a value, so this fails only for some inputs in production.
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({
      id: U('1'),
      // VeloExpense: no homeCurrencyId (a person's currency is their entity's).
      patch: { firstName: 'Ada', departmentId: U('3'), managerId: null },
    });
    assertPrismaFields('User', db.user.update.mock.calls[0]?.[0]?.data);
  });

  it('refuses a self-referential manager', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.update({ id: U('1'), patch: { managerId: U('1') } })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
  });

  it('refuses a manager that would close a reporting cycle', async () => {
    /**
     * A → B → A. Walking UP from the proposed manager reaches the user being edited,
     * so the edit is refused. Left in, the recursive scope CTE and every
     * manager-routed approval walk the loop until the depth bound saves them.
     */
    const db = makeDb();
    // Proposed manager U(2) reports to U(1), the user being edited.
    db.user.findUnique.mockResolvedValue({ managerId: U('1') });
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.update({ id: U('1'), patch: { managerId: U('2') } })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      },
    );
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows a manager whose chain terminates above the user', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ managerId: null });
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { managerId: U('2') } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('gives up walking after a bounded number of hops', async () => {
    // A pre-existing cycle above the proposed manager must not hang the request.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ managerId: U('5') });
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { managerId: U('2') } });
    expect(db.user.findUnique.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('rejects an unknown patch key rather than ignoring it', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await expect(
      caller.update({ id: U('1'), patch: { nickname: 'Ada' } } as never),
    ).rejects.toThrow();
  });

  it('rejects a country code that is not two characters', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.update({ id: U('1'), patch: { country: 'CAN' } })).rejects.toThrow();
  });

  // f75: two letters is not enough — the code must be an assigned ISO-3166-1 alpha-2 code.
  it.each(['XX', 'ZZ', 'ca'])('refuses %s as a country, naming it, and writes nothing', async (country) => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    const err = await caller.update({ id: U('1'), patch: { country } }).catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    const { refusalData } = await import('@/server/refusal');
    expect(refusalData(err)).toEqual({ key: 'refusals.people.countryUnknown', params: { country } });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('accepts an assigned code and clearing the country', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { country: 'GB' } });
    await caller.update({ id: U('1'), patch: { country: null } });
    expect(db.user.update).toHaveBeenCalledTimes(2);
  });
});

describe('setRole', () => {
  const target = (roleId: string) => ({ id: U('1'), roleId });
  const role = (id: string, permissions: string[] = [], active = true) => ({
    id,
    active,
    permissions,
  });

  it('is a no-op when the role is unchanged', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('2')));
    db.role.findFirst.mockResolvedValue(role(U('2')));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).resolves.toEqual({
      ok: true,
      unchanged: true,
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(null);
    db.role.findFirst.mockResolvedValue(role(U('2')));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('404s an inactive role', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [], false));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses to demote the last active admin', async () => {
    // Zero remaining admins locks the org out of its own administration.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(ADMIN_ROLE));
    db.role.findFirst.mockResolvedValue(role(U('2')));
    db.user.count.mockResolvedValue(0);
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('allows the demotion when another admin remains', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(ADMIN_ROLE));
    db.role.findFirst.mockResolvedValue(role(U('2')));
    db.user.count.mockResolvedValue(1);
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('excludes the user being demoted from the remaining-admin count', async () => {
    // Counting themselves would let the last admin demote themselves.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(ADMIN_ROLE));
    db.role.findFirst.mockResolvedValue(role(U('2')));
    db.user.count.mockResolvedValue(1);
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setRole({ id: U('1'), roleId: U('2') });
    expect(db.user.count.mock.calls[0]?.[0]?.where).toMatchObject({ id: { not: U('1') } });
  });

  it('refuses to strip the caller of their own setRole permission', async () => {
    const db = makeDb();
    const me = U('9');
    db.user.findUnique.mockResolvedValue({ id: me, roleId: U('3') });
    db.role.findFirst.mockResolvedValue(role(U('2'), []));
    const caller = await callerFor(db, [P.user.setRole], me);
    await expect(caller.setRole({ id: me, roleId: U('2') })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('lets the caller change their own role to another that keeps setRole', async () => {
    const db = makeDb();
    const me = U('9');
    db.user.findUnique.mockResolvedValue({ id: me, roleId: U('3') });
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.user.setRole]));
    const caller = await callerFor(db, [P.user.setRole], me);
    await expect(caller.setRole({ id: me, roleId: U('2') })).resolves.toMatchObject({ ok: true });
  });

  it('refuses to assign a permission the caller does not hold', async () => {
    /**
     * The grant ceiling. Without it, anybody holding `user.setRole` could assign a
     * role carrying `admin.role.update` — to somebody else or to themselves — and
     * turn a narrow permission into full administration.
     */
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.user.setRole, P.admin.role.update]));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('names the escalating permissions in the refusal', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.admin.role.update]));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).rejects.toThrow(
      new RegExp(P.admin.role.update.replace(/\./g, '\\.')),
    );
  });

  it('allows a role whose permissions the caller already holds', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.user.setRole]));
    const caller = await callerFor(db, [P.user.setRole]);
    await expect(caller.setRole({ id: U('1'), roleId: U('2') })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('VeloExpense: writes the role alone — there is no session epoch to bump', async () => {
    // Every request reads the person's role from the database (`resolveTenantMember`), so the
    // change takes effect on their next request without one; an epoch write would fail.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.user.setRole]));
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setRole({ id: U('1'), roleId: U('2') });
    expect(db.user.update.mock.calls[0]?.[0]?.data).toEqual({ roleId: U('2') });
  });

  it('audits the role transition on both sides', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(target(U('3')));
    db.role.findFirst.mockResolvedValue(role(U('2'), [P.user.setRole]));
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setRole({ id: U('1'), roleId: U('2') });
    expect(auditCalls[0]?.details).toEqual({ fromRoleId: U('3'), toRoleId: U('2') });
  });
});

describe('setOnLeave', () => {
  it('moves the user to ON_LEAVE and stamps the date', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setOnLeave]);
    await caller.setOnLeave({ id: U('1'), onLeave: true });
    const data = db.user.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.employeeStatus).toBe('ON_LEAVE');
    expect(data.onLeaveAt).toBeInstanceOf(Date);
  });

  it('clears the date on return', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setOnLeave]);
    await caller.setOnLeave({ id: U('1'), onLeave: false });
    expect(db.user.update.mock.calls[0]?.[0]?.data).toMatchObject({
      employeeStatus: 'ACTIVE',
      onLeaveAt: null,
    });
  });

  it('audits either direction', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setOnLeave]);
    await caller.setOnLeave({ id: U('1'), onLeave: true });
    expect(auditCalls[0]?.details).toEqual({ onLeave: true });
  });
});

describe('setAccess', () => {
  /**
   * The flag `signIn` refuses on. It shipped with no way to see or change it, and production
   * spent a release with every real person locked out while nine QA accounts could sign in —
   * discoverable only by querying the database. These tests are about it being operable.
   */
  it('grants sign-in', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setAccess({ id: U('1'), hasAccess: true });
    expect(db.user.update.mock.calls[0]?.[0]?.data).toMatchObject({ hasAccess: true });
  });

  it('revokes it', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setAccess({ id: U('1'), hasAccess: false });
    expect(db.user.update.mock.calls[0]?.[0]?.data).toMatchObject({ hasAccess: false });
  });

  it('touches nothing else — access is not employment', async () => {
    // Independent of `employeeStatus` on purpose: somebody active may have no business in an
    // expense system, and somebody on leave may still need their own history.
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setAccess({ id: U('1'), hasAccess: false });
    expect(Object.keys(db.user.update.mock.calls[0]?.[0]?.data as object)).toEqual([
      'hasAccess',
    ]);
  });

  it('audits which way it went', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.setRole]);
    await caller.setAccess({ id: U('1'), hasAccess: false });
    expect(auditCalls[0]?.details).toEqual({ hasAccess: false });
  });

  it('refuses a caller who may only edit a profile', async () => {
    // `user.update` is held more widely than `setRole`. Granting somebody the ability to sign
    // in is an authorisation decision, not a profile edit, so it needs the stronger gate.
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.setAccess({ id: U('1'), hasAccess: true })).rejects.toThrow();
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('setAccessMany', () => {
  /**
   * The People page's bulk Grant / Revoke. The rules that matter are the ones a selection
   * makes easy to get wrong: a select-all that includes yourself, and a selection where half
   * the people are already in the asked-for state.
   */
  const person = (n: string, hasAccess: boolean) => ({ id: U(n), hasAccess });

  it('grants each person who lacks access, one audit row apiece', async () => {
    const db = makeDb();
    db.user.findMany.mockResolvedValue([person('1', false), person('2', false)]);
    const caller = await callerFor(db, [P.user.setRole]);
    const out = await caller.setAccessMany({ ids: [U('1'), U('2')], hasAccess: true });
    expect(out).toEqual({ changed: 2, unchanged: 0, skippedSelf: 0, notFound: 0 });
    expect(db.user.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: U('1') }, data: { hasAccess: true } },
      { where: { id: U('2') }, data: { hasAccess: true } },
    ]);
    expect(auditCalls.map((a) => [a.entityId, a.details])).toEqual([
      [U('1'), { hasAccess: true }],
      [U('2'), { hasAccess: true }],
    ]);
  });

  it('leaves alone, and does not audit, somebody already in that state', async () => {
    const db = makeDb();
    db.user.findMany.mockResolvedValue([person('1', true), person('2', false)]);
    const caller = await callerFor(db, [P.user.setRole]);
    const out = await caller.setAccessMany({ ids: [U('1'), U('2')], hasAccess: false });
    expect(out).toMatchObject({ changed: 1, unchanged: 1 });
    expect(db.user.update).toHaveBeenCalledTimes(1);
    expect(auditCalls).toHaveLength(1);
  });

  it('never revokes the caller’s own access', async () => {
    const me = U('9');
    const db = makeDb();
    db.user.findMany.mockResolvedValue([person('1', true), person('9', true)]);
    const caller = await callerFor(db, [P.user.setRole], me);
    const out = await caller.setAccessMany({ ids: [U('1'), me], hasAccess: false });
    expect(out).toMatchObject({ changed: 1, skippedSelf: 1 });
    expect(
      db.user.update.mock.calls.map((c) => (c[0] as unknown as { where: unknown }).where),
    ).toEqual([{ id: U('1') }]);
  });

  it('may grant the caller’s own access — only revoking locks anybody out', async () => {
    const me = U('9');
    const db = makeDb();
    db.user.findMany.mockResolvedValue([person('9', false)]);
    const caller = await callerFor(db, [P.user.setRole], me);
    await expect(caller.setAccessMany({ ids: [me], hasAccess: true })).resolves.toMatchObject({
      changed: 1,
      skippedSelf: 0,
    });
  });

  it('counts ids it could not find, reading only people not deleted', async () => {
    const db = makeDb();
    db.user.findMany.mockResolvedValue([person('1', false)]);
    const caller = await callerFor(db, [P.user.setRole]);
    // The repeated id is one person, not two.
    const out = await caller.setAccessMany({ ids: [U('1'), U('1'), U('3')], hasAccess: true });
    expect(out).toMatchObject({ changed: 1, notFound: 1 });
    expect(db.user.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: [U('1'), U('3')] }, deletedAt: null },
    });
  });

  it('refuses an empty selection', async () => {
    const caller = await callerFor(makeDb(), [P.user.setRole]);
    await expect(caller.setAccessMany({ ids: [], hasAccess: true })).rejects.toThrow();
  });
});

describe('deactivate', () => {
  it('refuses self-deactivation', async () => {
    const db = makeDb();
    const me = U('9');
    const caller = await callerFor(db, [P.user.deactivate], me);
    await expect(caller.deactivate({ id: me })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses while direct reports remain, naming the count', async () => {
    // Leaving reports pointed at a deactivated manager routes their approvals to the
    // pool fallback rather than a person.
    const db = makeDb();
    db.user.count.mockResolvedValue(3);
    const caller = await callerFor(db, [P.user.deactivate]);
    await expect(caller.deactivate({ id: U('1') })).rejects.toThrow(/3 direct reports/);
  });

  it('uses the singular for one report', async () => {
    const db = makeDb();
    db.user.count.mockResolvedValue(1);
    const caller = await callerFor(db, [P.user.deactivate]);
    await expect(caller.deactivate({ id: U('1') })).rejects.toThrow(/1 direct report\b/);
  });

  it('soft-deletes and sets DEACTIVATED together', async () => {
    // VeloExpense: no epoch — `deletedAt` is read on every request.
    const db = makeDb();
    const caller = await callerFor(db, [P.user.deactivate]);
    await caller.deactivate({ id: U('1') });
    const data = db.user.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.employeeStatus).toBe('DEACTIVATED');
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('sessionEpoch');
  });

  it('rolls the departing employee’s cards and reports up in the same transaction', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.deactivate]);
    const out = await caller.deactivate({ id: U('1') });
    expect(rollUpOnOffboard).toHaveBeenCalledWith(db, U('1'));
    // VeloExpense: the reports-only summary (no cards).
    expect(out.rollup).toEqual({ managerId: null, reportsToManager: 0, reportsOrphaned: 0 });
  });

  it('does not roll up when the guard refused', async () => {
    const db = makeDb();
    db.user.count.mockResolvedValue(2);
    const caller = await callerFor(db, [P.user.deactivate]);
    await expect(caller.deactivate({ id: U('1') })).rejects.toThrow();
    expect(rollUpOnOffboard).not.toHaveBeenCalled();
  });
});

describe('reactivate', () => {
  it('clears the soft-delete and restores ACTIVE', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.deactivate]);
    await caller.reactivate({ id: U('1') });
    expect(db.user.update.mock.calls[0]?.[0]?.data).toEqual({
      deletedAt: null,
      employeeStatus: 'ACTIVE',
    });
  });
});

describe('update — external ids', () => {
  const SOURCE_ID = U('7');

  function dbWithAliases(held: { email: string } | null = null) {
    const userExternalId = {
      deleteMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: 'uei1' })),
      findUnique: vi.fn(async () => (held ? { user: held } : null)),
    };
    // VeloExpense: a source is the tenant's own, found by code or created, as roles.ts does.
    const externalIdSource = {
      findFirst: stubFn(async () => ({ id: SOURCE_ID }) as unknown),
      create: stubFn(async () => ({ id: SOURCE_ID })),
    };
    // Spread rather than passed through `over`, whose `Record<string, unknown>` type
    // erases the delegates and leaves the assertions below untypeable.
    return { ...makeDb(), userExternalId, externalIdSource };
  }

  it('writes them as alias rows and keeps them out of the user column patch', async () => {
    const db = dbWithAliases();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { externalIds: { netsuite: '10096345' } } });

    // The whole point: never in `user.update`'s data.
    const dataArg = (db.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('externalIds');

    expect(db.userExternalId.deleteMany).toHaveBeenCalledWith({ where: { userId: U('1') } });
    expect(db.userExternalId.create).toHaveBeenCalledWith({
      data: { sourceId: SOURCE_ID, sourceValue: '10096345', userId: U('1') },
    });
  });

  it('treats an emptied field as a removal, not as a blank id', async () => {
    // Delete-all still runs; nothing is recreated. A stored "" would be an id no
    // system can be asked about, and would occupy the unique slot for the empty string.
    const db = dbWithAliases();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { externalIds: { netsuite: '   ' } } });
    expect(db.userExternalId.deleteMany).toHaveBeenCalled();
    expect(db.userExternalId.create).not.toHaveBeenCalled();
  });

  it('refuses an id another person already holds, and names them', async () => {
    // The raw failure here is Prisma P2002 on a constraint name. That tells an admin
    // nothing; the holder's address tells them exactly what to do next.
    const db = dbWithAliases({ email: 'kati.birmingham@e.inc' });
    const caller = await callerFor(db, [P.user.update]);
    await expect(
      caller.update({ id: U('1'), patch: { externalIds: { netsuite: '7845933' } } }),
    ).rejects.toThrow(/already assigned to kati\.birmingham@e\.inc/);
    expect(db.userExternalId.create).not.toHaveBeenCalled();
  });

  it('leaves existing mappings alone when the key is absent', async () => {
    // A patch that never opened this section must not wipe the person's mappings.
    const db = dbWithAliases();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { firstName: 'Ada' } });
    expect(db.userExternalId.deleteMany).not.toHaveBeenCalled();
  });
});

/* ── VeloExpense ─────────────────────────────────────────────────────────────────────────
 *
 * What VeloExpense adds around ExpenseOS's mutations: a seat is a person who is not
 * deactivated (lib/billing), and DEACTIVATED / TERMINATED move with `deletedAt` wherever a
 * status is written (w4-10f, 0071) — ExpenseOS's `update` writes the status alone.
 */
describe('VeloExpense: leaving and returning through update', () => {
  it('stamps deletedAt, runs the deactivation guards and rolls reports up for DEACTIVATED', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { employeeStatus: 'DEACTIVATED' } });
    const data = db.user.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.employeeStatus).toBe('DEACTIVATED');
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(rollUpOnOffboard).toHaveBeenCalledWith(db, U('1'));
    expect(pushSeatCountInBackground).toHaveBeenCalledOnce();
  });

  it('treats TERMINATED as leaving too', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { employeeStatus: 'TERMINATED' } });
    expect((db.user.update.mock.calls[0]?.[0]?.data as Record<string, unknown>).deletedAt).toBeInstanceOf(Date);
  });

  it('refuses to make somebody with direct reports leave, as deactivate does', async () => {
    const db = makeDb();
    db.user.count.mockResolvedValue(2);
    const caller = await callerFor(db, [P.user.update]);
    await expect(
      caller.update({ id: U('1'), patch: { employeeStatus: 'DEACTIVATED' } }),
    ).rejects.toThrow(/Reassign 2 direct reports/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('clears deletedAt and takes a seat when a leaver is set back to ACTIVE', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ id: U('1'), roleId: U('2'), deletedAt: new Date() });
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { employeeStatus: 'ACTIVE' } });
    expect((db.user.update.mock.calls[0]?.[0]?.data as Record<string, unknown>).deletedAt).toBeNull();
    expect(assertSeatAvailable).toHaveBeenCalledOnce();
    expect(pushSeatCountInBackground).toHaveBeenCalledOnce();
  });

  it('leaves deletedAt and the seat count alone for an ordinary edit', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { firstName: 'Ada', employeeStatus: 'ON_LEAVE' } });
    expect(db.user.update.mock.calls[0]?.[0]?.data).not.toHaveProperty('deletedAt');
    expect(assertSeatAvailable).not.toHaveBeenCalled();
    expect(pushSeatCountInBackground).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for somebody outside the tenant, rather than a failed write', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue(null);
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.update({ id: U('1'), patch: { firstName: 'Ada' } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a manager the tenant does not hold', async () => {
    const db = makeDb();
    db.user.findFirst
      .mockResolvedValueOnce({ id: U('1'), roleId: U('2'), deletedAt: null })
      .mockResolvedValueOnce(null);
    const caller = await callerFor(db, [P.user.update]);
    await expect(caller.update({ id: U('1'), patch: { managerId: U('5') } })).rejects.toThrow(
      /not in this organization/,
    );
  });
});

describe('VeloExpense: seats and the last admin', () => {
  it('refuses to deactivate the tenant’s last active System Administrator', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ roleId: ADMIN_ROLE, deletedAt: null });
    db.user.count.mockResolvedValue(0); // no reports, and no other admin
    const caller = await callerFor(db, [P.user.deactivate]);
    await expect(caller.deactivate({ id: U('1') })).rejects.toThrow(/last active admin/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('pushes the seat count after a deactivation', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.deactivate]);
    await caller.deactivate({ id: U('1') });
    expect(pushSeatCountInBackground).toHaveBeenCalledOnce();
  });

  it('caps a reactivation like a new member, and pushes the count', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ deletedAt: new Date() });
    const caller = await callerFor(db, [P.user.deactivate]);
    await caller.reactivate({ id: U('1') });
    expect(assertSeatAvailable).toHaveBeenCalledOnce();
    expect(pushSeatCountInBackground).toHaveBeenCalledOnce();
  });

  it('refuses a reactivation the plan has no seat for, and writes nothing', async () => {
    const { CapReachedError } = await import('@/lib/billing/caps');
    assertSeatAvailable.mockRejectedValueOnce(new CapReachedError('maxUsers', 5, 'SEAT_LIMIT_REACHED'));
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ deletedAt: new Date() });
    const caller = await callerFor(db, [P.user.deactivate]);
    await expect(caller.reactivate({ id: U('1') })).rejects.toThrow(/allows 5 people/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses to put a leaver on leave, which would revive them without a seat', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ deletedAt: new Date() });
    const caller = await callerFor(db, [P.user.setOnLeave]);
    await expect(caller.setOnLeave({ id: U('1'), onLeave: false })).rejects.toThrow(/Reactivate/);
  });
});

// eos batch 4 — ported from ExpenseOS's users.mutations.test.ts (67db2e33, #582). VeloExpense:
// "sync on" is the tenant's connection; the person is read with `findFirst` (so the stub
// answers by what is selected); status and termination date are not Google-owned here (d85).
describe('update — fields Google Workspace owns', () => {
  /**
   * With directory sync on, a person linked to a Google account takes their name, country,
   * manager and job level from Google. An admin edit to one of them would be put back by
   * the next sync, so it is refused with a sentence that says where to make the change.
   */
  const stored = (over: Record<string, unknown> = {}) => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    jobLevelId: null,
    managerId: null,
    country: 'CA',
    externalIds: [{ id: 'x1' }],
    ...over,
  });
  /** The person as the Google check reads them, and as the update's own read does. */
  const dbWith = (person: unknown) => {
    const db = makeDb();
    db.user.findFirst.mockImplementation(async (args: unknown) =>
      (args as { select?: { externalIds?: unknown } }).select?.externalIds
        ? person
        : { id: U('1'), roleId: U('2'), deletedAt: null, businessUnitId: null },
    );
    return db;
  };

  it('refuses a change to a Google-owned field, naming it', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const db = dbWith(stored());
    const caller = await callerFor(db, [P.user.update]);
    const err = await caller
      .update({ id: U('1'), patch: { firstName: 'Augusta', departmentId: null } })
      .catch((e) => e);
    expect(err.code).toBe('BAD_REQUEST');
    const { refusalData } = await import('@/server/refusal');
    expect(refusalData(err)).toEqual({
      key: 'refusals.people.directoryManaged',
      params: { fields: 'firstName' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('lets a patch through that only repeats what Google already gave', async () => {
    // The drawer sends name on every save; repeating it is not a change.
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const db = dbWith(stored());
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { firstName: 'Ada', country: 'CA', departmentId: null } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('VeloExpense: lets status through — Directory only moves a person out (d85)', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const db = dbWith(stored());
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { employeeStatus: 'ON_LEAVE' } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('allows the change for a person with no Google account', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const db = dbWith(stored({ externalIds: [] }));
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { country: 'US' } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('allows the change while directory sync is off', async () => {
    const db = dbWith(stored());
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { lastName: 'King' } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });

  it('does not consult Google for a patch that touches no Google-owned field', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { departmentId: null } });
    expect(getDirectoryConnection).not.toHaveBeenCalled();
  });

  it('treats a vanished person as nothing to protect', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const db = dbWith(null);
    const caller = await callerFor(db, [P.user.update]);
    await caller.update({ id: U('1'), patch: { country: 'US' } });
    expect(db.user.update).toHaveBeenCalledOnce();
  });
});

describe('directorySync', () => {
  it('reports whether Google directory sync is on', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    const caller = await callerFor(makeDb(), [P.user.update]);
    await expect(caller.directorySync()).resolves.toEqual({ enabled: true });
  });

  it('VeloExpense: is off, whatever the tenant connected, when the platform switch is off', async () => {
    getDirectoryConnection.mockResolvedValue({ connected: true });
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    try {
      const caller = await callerFor(makeDb(), [P.user.update]);
      await expect(caller.directorySync()).resolves.toEqual({ enabled: false });
    } finally {
      delete process.env.GOOGLE_DIRECTORY_DISABLED;
    }
  });

  it('is gated on user.update', async () => {
    const caller = await callerFor(makeDb(), []);
    await expect(caller.directorySync()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

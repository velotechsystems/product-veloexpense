/* eslint-disable @typescript-eslint/no-explicit-any -- ported suite: ExpenseOS's fake reads queries untyped. */
import { describe, expect, it } from 'vitest';
import { resolveAssignment } from './engine';

/** Minimal fake of the bits resolveAssignment touches: user.findUnique (status
 *  + managerId) and delegation.findFirst (active, in-scope, current).
 *
 *  VeloExpense: the fake answers the query the engine now asks of VeloExpense's
 *  `delegation` table (0008) — `fromUserId`, `revokedAt: null`, `startsOn` / `endsOn` —
 *  and maps it onto ExpenseOS's fixture shape, so the cases below read as ExpenseOS wrote
 *  them. Statuses are VeloExpense's (0004): DEACTIVATED is its offboarded status. */
interface FakeUser {
  id: string;
  employeeStatus: 'ACTIVE' | 'ON_LEAVE' | 'DEACTIVATED';
  managerId: string | null;
}
interface FakeDelegation {
  delegatorId: string;
  delegateeId: string;
  scope: 'ALL' | 'REPORTS';
  active: boolean;
  startsAt: Date;
  endsAt: Date | null;
}

function fakeDb(users: FakeUser[], delegations: FakeDelegation[] = []) {
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    // VeloExpense: the engine reads today in the tenant's working timezone with one raw
    // query (`tenantToday`); a UTC tenant's today is enough for these cases, whose fixture
    // ranges sit days either side of now.
    $queryRaw: async () => [{ d: new Date().toISOString().slice(0, 10) }],
    user: {
      findUnique: async ({ where }: any) => byId.get(where.id) ?? null,
    },
    delegation: {
      findFirst: async ({ where }: any) => {
        const now = new Date();
        // VeloExpense: the engine must ask for unrevoked rows only.
        expect(where.revokedAt).toBeNull();
        const match = delegations.find(
          (d) =>
            d.delegatorId === where.fromUserId &&
            d.active &&
            where.scope.in.includes(d.scope) &&
            d.startsAt <= now &&
            (d.endsAt === null || d.endsAt >= now),
        );
        return match ? { toUserId: match.delegateeId } : null;
      },
    },
  } as any;
}

// VeloExpense: no virtual-card subjects (d50); ExpenseOS's VCC-subject cases run on a report.
const VCC = 'EXPENSE_REPORT' as const;
const REPORT = 'EXPENSE_REPORT' as const;
const active = (id: string, managerId: string | null = null): FakeUser => ({
  id,
  employeeStatus: 'ACTIVE',
  managerId,
});

describe('resolveAssignment', () => {
  it('returns the assignee unchanged when active with no delegation', async () => {
    const db = fakeDb([active('u1')]);
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('u1');
  });

  it('returns null for an unassigned (filter) task', async () => {
    expect(await resolveAssignment(fakeDb([]), null, VCC)).toBeNull();
  });

  it('skips an ON_LEAVE assignee up to the first active manager', async () => {
    const db = fakeDb([
      { id: 'u1', employeeStatus: 'ON_LEAVE', managerId: 'm1' },
      { id: 'm1', employeeStatus: 'ON_LEAVE', managerId: 'm2' },
      active('m2'),
    ]);
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('m2');
  });

  it('keeps an ON_LEAVE assignee at the top of the chain (TTL escalation covers)', async () => {
    const db = fakeDb([{ id: 'u1', employeeStatus: 'ON_LEAVE', managerId: null }]);
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('u1');
  });

  it('redirects to an active ALL-scope delegatee', async () => {
    const db = fakeDb(
      [active('u1'), active('d1')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'ALL',
          active: true,
          startsAt: new Date(0),
          endsAt: null,
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('d1');
  });

  // VeloExpense: `delegation.scope` is ALL | REPORTS (0008); there is no VCC scope.
  it.skip('applies a VCC-scoped delegation to a VCC subject', async () => {
    const db = fakeDb(
      [active('u1'), active('d1')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'VCC' as never,
          active: true,
          startsAt: new Date(0),
          endsAt: null,
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('d1');
  });

  it('applies a REPORTS-scoped delegation to an expense-report subject', async () => {
    const db = fakeDb(
      [active('u1'), active('d1')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'REPORTS',
          active: true,
          startsAt: new Date(0),
          endsAt: null,
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', REPORT)).toBe('d1');
  });

  // VeloExpense: no VCC scope (0008's CHECK refuses one).
  it.skip('does NOT apply a VCC-scoped delegation to an expense-report subject', async () => {
    const db = fakeDb(
      [active('u1'), active('d1')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'VCC' as never,
          active: true,
          startsAt: new Date(0),
          endsAt: null,
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', REPORT)).toBe('u1');
  });

  it('skips leave on the delegatee too', async () => {
    const db = fakeDb(
      [active('u1'), { id: 'd1', employeeStatus: 'ON_LEAVE', managerId: 'd2' }, active('d2')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'ALL',
          active: true,
          startsAt: new Date(0),
          endsAt: null,
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('d2');
  });

  it('ignores an expired or inactive delegation', async () => {
    const db = fakeDb(
      [active('u1'), active('d1')],
      [
        {
          delegatorId: 'u1',
          delegateeId: 'd1',
          scope: 'ALL',
          active: true,
          startsAt: new Date(0),
          endsAt: new Date(1), // long past
        },
      ],
    );
    expect(await resolveAssignment(db, 'u1', VCC)).toBe('u1');
  });

  // VeloExpense: DEACTIVATED is VeloExpense's offboarded status (ExpenseOS: TERMINATED).
  it('skips a DEACTIVATED assignee up to the first active manager', async () => {
    const db = fakeDb([{ id: 'u1', employeeStatus: 'DEACTIVATED', managerId: 'm1' }, active('m1')]);
    expect(await resolveAssignment(db, 'u1', REPORT)).toBe('m1');
  });

  it('ignores a revoked delegation', async () => {
    // The engine asks for `revokedAt: null` (asserted in the fake); a revoked row is the
    // fixture's `active: false`.
    const db = fakeDb(
      [active('u1'), active('d1')],
      [{ delegatorId: 'u1', delegateeId: 'd1', scope: 'ALL', active: false, startsAt: new Date(0), endsAt: null }],
    );
    expect(await resolveAssignment(db, 'u1', REPORT)).toBe('u1');
  });
});

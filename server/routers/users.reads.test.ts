// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The read half of the users router: `get`, `getDirectReports`, `listFilterFacets`
 * and `facetCounts`.
 *
 * The visibility rule is the point. A profile is readable by an admin, by its owner,
 * or by anybody above it in the reporting chain — and by nobody else. `getDirectReports`
 * takes a shortcut for the first two cases and only falls through to the chain query
 * when neither applies, so both paths need pinning: a shortcut that is too generous
 * hands one manager another manager's team.
 *
 * `facetCounts` carries a degradation policy that is invisible from its output unless
 * you read the `scoped` flag: above a row threshold, or when a per-field query times
 * out, it answers with GLOBAL counts instead of filtered ones. Reporting `scoped: true`
 * on a degraded answer is the failure that matters — the rail would show numbers that
 * do not match the table and nothing would say so.
 */

const resolveScopedIds =
  vi.fn<(db: unknown, id: string, scope: string) => Promise<string[] | null>>();
const canViewUser = vi.fn<() => Promise<boolean>>();
const getOrSetFacetEntry = vi.fn();
const runFieldCountArgs: Array<Record<string, unknown>> = [];

vi.mock('@/server/lib/userScope', () => ({ resolveScopedIds }));
vi.mock('@/server/lib/canViewUser', () => ({ canViewUser }));
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));
/**
 * The facet cache is stubbed to always MISS and run the producer, so the per-field
 * count query is exercised rather than skipped. The key is captured so the
 * "one entry per field, keyed on the OTHER filters" contract can be asserted.
 */
const cacheKeys: string[] = [];
vi.mock('@/server/lib/facets/cache', () => ({
  hashFilterPayload: (p: unknown) => `hash(${JSON.stringify(p)})`,
  buildCacheKey: (parts: Record<string, unknown>) => {
    const key = `${parts.resource}:${parts.scopeBucket}:${parts.field}:${parts.filterHash}`;
    cacheKeys.push(key);
    return key;
  },
  getOrSetFacetEntry: (key: string, ttl: number, producer: () => Promise<unknown>) =>
    getOrSetFacetEntry(key, ttl, producer),
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;

function rawRow(over: Record<string, unknown> = {}) {
  return {
    id: U('1'),
    email: 'ada@e.inc',
    firstName: 'Ada',
    lastName: 'Lovelace',
    department: null,
    businessUnit: null,
    entity: null,
    jobLevel: null,
    country: 'CA',
    // VeloExpense: no NetSuite class, no MFA columns; the currency is the entity's.
    externalIds: [],
    employeeStatus: 'ACTIVE',
    hasAccess: true,
    onLeaveAt: null,
    terminationDate: null,
    lastLoginAt: null,
    avatarUrl: null,
    role: { id: U('2'), label: { en: 'Employee' } },
    manager: null,
    ...over,
  };
}

function makeDb() {
  const lookup = () => ({ findMany: stubFn(async () => [] as unknown[]) });
  return {
    user: {
      findUnique: stubFn(async () => rawRow() as unknown),
      findMany: stubFn(async () => [rawRow()] as unknown[]),
    },
    businessUnit: lookup(),
    department: lookup(),
    legalEntity: lookup(),
    role: lookup(),
    // The edit-employee drawer renders one external-id field per active source, so the
    // facets query loads them alongside the org lookups.
    externalIdSource: lookup(),
    expenseReport: {
      findMany: stubFn(
        async () =>
          [
            {
              id: U('5'),
              title: 'Toronto client visit',
              status: 'SUBMITTED',
              totalMinor: 124500n,
              submittedAt: new Date('2026-07-14T00:00:00Z'),
              createdAt: new Date('2026-07-01T00:00:00Z'),
              currency: { code: 'CAD', symbol: '$' },
              _count: { expenses: 4 },
            },
          ] as unknown[],
      ),
    },
    delegation: {
      findMany: stubFn(
        async () =>
          [
            {
              // VeloExpense: the delegation table's names (0008); `revokedAt: null` is `active`.
              id: U('6'),
              fromUserId: U('1'),
              toUserId: U('7'),
              startsOn: new Date('2026-07-01T00:00:00Z'),
              endsOn: null,
              scope: 'ALL',
              revokedAt: null,
              fromUser: { id: U('1'), firstName: 'Ada', lastName: 'L', email: 'ada@e.inc' },
              toUser: { id: U('7'), firstName: 'Wei', lastName: 'C', email: 'wei@e.inc' },
            },
          ] as unknown[],
      ),
    },
    $queryRaw: stubFn(async () => [{ reltuples: 1000 }] as unknown[]),
  };
}

async function callerFor(db: unknown, permissions: readonly string[] = [], userId = U('9')) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { usersRouter } = await import('./users');
  return createCallerFactory(usersRouter)(makeContext({ db, userId, permissions }));
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheKeys.length = 0;
  runFieldCountArgs.length = 0;
  resolveScopedIds.mockResolvedValue(null);
  canViewUser.mockResolvedValue(true);
  // Default: the cache misses and the producer runs, returning a scoped result.
  getOrSetFacetEntry.mockImplementation(
    async (_k: string, _t: number, producer: () => Promise<unknown>) => {
      await producer().catch(() => undefined);
      return { scoped: true, values: [{ value: 'ACTIVE', count: 3 }] };
    },
  );
});

describe('get', () => {
  it('refuses a user the caller cannot see', async () => {
    const db = makeDb();
    canViewUser.mockResolvedValue(false);
    const caller = await callerFor(db);
    await expect(caller.get({ id: U('1') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns a visible user, derived', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(
      rawRow({
        externalIds: [{ sourceValue: '77', source: { code: 'netsuite' } }],
        // VeloExpense: no MFA to derive; the currency is the person's entity's.
        entity: { id: U('3'), label: { en: 'Canada' }, homeCurrencyId: 'CAD' },
      }),
    );
    const caller = await callerFor(db);
    const out = await caller.get({ id: U('1') });
    expect(out.externalIds).toEqual({ netsuite: '77' });
    expect(out.homeCurrency).toBe('CAD');
    expect(out.entity).toEqual({ id: U('3'), label: { en: 'Canada' } });
  });

  it('404s a visible-but-missing user', async () => {
    // Distinct from FORBIDDEN on purpose: the caller was allowed to ask.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(null);
    const caller = await callerFor(db);
    await expect(caller.get({ id: U('1') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a non-uuid id', async () => {
    const db = makeDb();
    const caller = await callerFor(db);
    await expect(caller.get({ id: 'nope' })).rejects.toThrow();
  });
});

describe('activity', () => {
  /**
   * The drawer's expense-report and delegation lists. Two things decide what comes back,
   * and they are decided separately because the permissions are held separately: a
   * manager can hold `delegation.view.all` without holding `expense.report.read.all`.
   *
   * The `null` vs `[]` distinction is the contract the UI depends on. `[]` renders as
   * "no expense reports", which is a claim about this person. Returning `[]` to a reader
   * who merely lacks the permission would make the drawer assert something false.
   */
  it('refuses a user the caller cannot see at all', async () => {
    const db = makeDb();
    canViewUser.mockResolvedValue(false);
    const caller = await callerFor(db);
    await expect(caller.activity({ id: U('1') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.expenseReport.findMany).not.toHaveBeenCalled();
    expect(db.delegation.findMany).not.toHaveBeenCalled();
  });

  it("gives an admin both halves of someone else's activity", async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.expense.report.readAll, P.delegation.viewAll]);
    const out = await caller.activity({ id: U('1') });
    expect(out.canReadReports).toBe(true);
    expect(out.canReadDelegations).toBe(true);
    expect(out.reports).toHaveLength(1);
    expect(out.delegations).toHaveLength(1);
  });

  it('withholds reports — as null, not as an empty list — without read.all', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.delegation.viewAll]);
    const out = await caller.activity({ id: U('1') });
    expect(out.reports).toBeNull();
    expect(out.canReadReports).toBe(false);
    // And it does not pay for a query whose result it may not return.
    expect(db.expenseReport.findMany).not.toHaveBeenCalled();
    // The other half is unaffected.
    expect(out.delegations).toHaveLength(1);
  });

  it('withholds delegations without view.all', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.expense.report.readAll]);
    const out = await caller.activity({ id: U('1') });
    expect(out.delegations).toBeNull();
    expect(out.canReadDelegations).toBe(false);
    expect(db.delegation.findMany).not.toHaveBeenCalled();
    expect(out.reports).toHaveLength(1);
  });

  it('shows a person their own activity from read.own alone', async () => {
    // Nobody needs an org-wide permission to look at their own reports, and nobody
    // needs `delegation.view.all` to see who they have delegated to.
    const db = makeDb();
    const me = U('9');
    const caller = await callerFor(db, [P.expense.report.readOwn], me);
    const out = await caller.activity({ id: me });
    expect(out.reports).toHaveLength(1);
    expect(out.delegations).toHaveLength(1);
  });

  it('reads reports and delegations for the VIEWED person, not the caller', async () => {
    // The bug this pins: `expenses.list` hardwires `submitterId` to the caller, so
    // reusing it here would have shown the admin their OWN reports in someone else's
    // drawer — plausible-looking rows that belong to the wrong person.
    const db = makeDb();
    const caller = await callerFor(db, [P.expense.report.readAll, P.delegation.viewAll], U('9'));
    await caller.activity({ id: U('1') });
    expect(db.expenseReport.findMany.mock.calls[0]?.[0]?.where).toEqual({ submitterId: U('1') });
    // VeloExpense: the delegation table's names (0008).
    expect(db.delegation.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ fromUserId: U('1') }, { toUserId: U('1') }],
    });
  });

  it('sends money as a string and dates the report by when it was submitted', async () => {
    // BigInt does not survive JSON serialisation to the client.
    const db = makeDb();
    const caller = await callerFor(db, [P.expense.report.readAll]);
    const out = await caller.activity({ id: U('1') });
    expect(out.reports?.[0]?.totalMinor).toBe('124500');
    expect(out.reports?.[0]?.date).toEqual(new Date('2026-07-14T00:00:00Z'));
  });

  it('falls back to the created date for a report never submitted', async () => {
    const db = makeDb();
    db.expenseReport.findMany.mockResolvedValue([
      {
        id: U('5'),
        title: 'Draft',
        status: 'DRAFT',
        totalMinor: 0n,
        submittedAt: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        currency: { code: 'CAD', symbol: '$' },
        _count: { expenses: 0 },
      },
    ]);
    const caller = await callerFor(db, [P.expense.report.readAll]);
    const out = await caller.activity({ id: U('1') });
    expect(out.reports?.[0]?.date).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  it('labels each delegation by direction and names the other party', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.delegation.viewAll]);
    const out = await caller.activity({ id: U('1') });
    // U('1') is the delegator on the fixture row, so it runs outward from them.
    expect(out.delegations?.[0]?.direction).toBe('OUTGOING');
    expect(out.delegations?.[0]?.counterparty.email).toBe('wei@e.inc');
  });

  it('flips the direction when the viewed person is the delegatee', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.delegation.viewAll]);
    const out = await caller.activity({ id: U('7') });
    expect(out.delegations?.[0]?.direction).toBe('INCOMING');
    expect(out.delegations?.[0]?.counterparty.email).toBe('ada@e.inc');
  });

  it('caps how much it will return', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.expense.report.readAll]);
    await caller.activity({ id: U('1') });
    expect(db.expenseReport.findMany.mock.calls[0]?.[0]?.take).toBe(10);
    await expect(caller.activity({ id: U('1'), limit: 500 })).rejects.toThrow();
  });
});

describe('getDirectReports', () => {
  it('lets anybody read their own reports without a chain query', async () => {
    const db = makeDb();
    const me = U('9');
    const caller = await callerFor(db, [], me);
    await caller.getDirectReports({ userId: me });
    expect(canViewUser).not.toHaveBeenCalled();
    expect(db.user.findMany.mock.calls[0]?.[0]?.where).toMatchObject({ managerId: me });
  });

  it('lets an admin read anybody’s reports without a chain query', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await caller.getDirectReports({ userId: U('1') });
    expect(canViewUser).not.toHaveBeenCalled();
  });

  it('falls through to the chain query for anybody else', async () => {
    const db = makeDb();
    const caller = await callerFor(db, []);
    await caller.getDirectReports({ userId: U('1') });
    expect(canViewUser).toHaveBeenCalledOnce();
  });

  it('refuses when the target is outside the caller’s chain', async () => {
    // The case that keeps one manager out of another manager's team.
    const db = makeDb();
    canViewUser.mockResolvedValue(false);
    const caller = await callerFor(db, []);
    await expect(caller.getDirectReports({ userId: U('1') })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('narrows by employee status when asked', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await caller.getDirectReports({ userId: U('1'), status: 'ON_LEAVE' });
    expect(db.user.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      employeeStatus: 'ON_LEAVE',
    });
  });

  it('omits the status predicate entirely when not asked', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await caller.getDirectReports({ userId: U('1') });
    expect(db.user.findMany.mock.calls[0]?.[0]?.where.employeeStatus).toBeUndefined();
  });

  it('rejects an invalid status', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await expect(
      caller.getDirectReports({ userId: U('1'), status: 'RETIRED' } as never),
    ).rejects.toThrow();
  });

  it('derives each returned row', async () => {
    const db = makeDb();
    // VeloExpense: no MFA to derive; the external ids and the NetSuite placeholders are.
    db.user.findMany.mockResolvedValue([
      rawRow({ externalIds: [{ sourceValue: '42', source: { code: 'adp' } }] }),
    ]);
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.getDirectReports({ userId: U('1') });
    expect(out.items[0]?.externalIds).toEqual({ adp: '42' });
    expect(out.items[0]?.syncDiscrepancies).toEqual([]);
  });
});

describe('listFilterFacets', () => {
  it('is open to any signed-in user', async () => {
    // Nothing here is sensitive — the values appear on every directory row anyway.
    const db = makeDb();
    const caller = await callerFor(db, []);
    await expect(caller.listFilterFacets()).resolves.toEqual({
      businessUnits: [],
      departments: [],
      legalEntities: [],
      roles: [],
      externalIdSources: [],
    });
  });

  it('restricts org facets to lookup rows actually in use', async () => {
    /**
     * The filter rail should not offer a business unit nobody is in — selecting it
     * returns an empty table, which reads as a bug. Legal entities are deliberately
     * NOT restricted: that list feeds the edit-employee form, not the rail.
     */
    const db = makeDb();
    const caller = await callerFor(db, []);
    await caller.listFilterFacets();
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.where).toEqual({
      active: true,
      users: { some: { deletedAt: null } },
    });
    expect(db.department.findMany.mock.calls[0]?.[0]?.where).toEqual({
      active: true,
      users: { some: { deletedAt: null } },
    });
    expect(db.legalEntity.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
    // Sources are not restricted to "in use" either: an integration installed but not
    // yet mapped to anybody is exactly the one an admin needs a field for.
    expect(db.externalIdSource.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
  });

  it('orders by a stable column rather than the Json label', async () => {
    // Prisma cannot order by a Json field; createdAt is the stable substitute.
    const db = makeDb();
    const caller = await callerFor(db, []);
    await caller.listFilterFacets();
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('facetCounts', () => {
  // Not `as const`: the procedure's input takes a mutable array.
  const base = { fields: ['status' as const] };

  it("refuses scope 'all' without user.read.all", async () => {
    const db = makeDb();
    const caller = await callerFor(db, []);
    await expect(caller.facetCounts({ ...base, scope: 'all' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns empty buckets for an empty scope without querying', async () => {
    const db = makeDb();
    resolveScopedIds.mockResolvedValue([]);
    const caller = await callerFor(db, []);
    const out = await caller.facetCounts({ fields: ['status', 'businessUnit'], scope: 'direct' });
    expect(out.counts).toEqual({ status: [], businessUnit: [] });
    expect(getOrSetFacetEntry).not.toHaveBeenCalled();
  });

  it('reports a scoped answer as scoped', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts(base);
    expect(out.scoped).toBe(true);
    expect(out.counts.status).toEqual([{ value: 'ACTIVE', count: 3 }]);
  });

  it('degrades to global counts above the row threshold, and says so', async () => {
    /**
     * The flag is the whole contract. A degraded answer carries GLOBAL counts, which
     * will not match the filtered table — returning it as `scoped: true` puts numbers
     * on screen that silently disagree with the rows beside them.
     */
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([{ reltuples: 900_000 }]);
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts(base);
    expect(out.scoped).toBe(false);
  });

  it('stays scoped just under the threshold', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([{ reltuples: 499_999 }]);
    const caller = await callerFor(db, [P.user.readAll]);
    expect((await caller.facetCounts(base)).scoped).toBe(true);
  });

  it('assumes a small table when pg_class is unreadable', async () => {
    // A permissions error reading pg_class must not degrade every answer.
    const db = makeDb();
    db.$queryRaw.mockRejectedValue(new Error('permission denied for table pg_class'));
    const caller = await callerFor(db, [P.user.readAll]);
    expect((await caller.facetCounts(base)).scoped).toBe(true);
  });

  it('reports the whole answer as unscoped when any single field degraded', async () => {
    const db = makeDb();
    getOrSetFacetEntry
      .mockResolvedValueOnce({ scoped: true, values: [] })
      .mockResolvedValueOnce({ scoped: false, values: [] });
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts({ fields: ['status', 'businessUnit'] });
    expect(out.scoped).toBe(false);
  });

  it('keys the cache per field, excluding that field’s own filter', async () => {
    /**
     * A facet answers "what would the table show if this value were ALSO selected",
     * so a field's own filter must be left out of its count — including it would make
     * every unselected value read zero.
     */
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await caller.facetCounts({
      fields: ['status', 'businessUnit'],
      status: { op: 'equals', value: 'ACTIVE' },
      businessUnit: { op: 'equals', value: 'bu1' },
    });
    expect(cacheKeys).toHaveLength(2);
    const statusKey = cacheKeys.find((k) => k.includes(':status:')) as string;
    const buKey = cacheKeys.find((k) => k.includes(':businessUnit:')) as string;
    // The status bucket's hash carries the businessUnit filter but not its own.
    expect(statusKey).toContain('businessUnit');
    expect(statusKey).not.toContain('ACTIVE');
    expect(buKey).toContain('ACTIVE');
    expect(buKey).not.toContain('bu1');
  });

  it('shares one cache bucket across admins but partitions per user otherwise', async () => {
    const db = makeDb();
    const admin = await callerFor(db, [P.user.readAll], U('9'));
    await admin.facetCounts(base);
    // VeloExpense: the bucket names the tenant first (makeContext's default tenant).
    const TENANT = '00000000-0000-7000-8000-0000000000c1';
    expect(cacheKeys[0]).toBe(`users:${TENANT}:all:status:${cacheKeys[0]?.split(':status:')[1]}`);

    cacheKeys.length = 0;
    resolveScopedIds.mockResolvedValue(['x']);
    const employee = await callerFor(db, [], U('8'));
    await employee.facetCounts(base);
    expect(cacheKeys[0]).toContain(`${TENANT}:chain:${U('8')}`);
  });

  it('VeloExpense: gives two tenants different buckets for the same scope', async () => {
    /**
     * One Redis serves every tenant. ExpenseOS shares the 'all' bucket across admins
     * because its database is one customer's; here that would hand one organization's
     * counts to another's admins.
     */
    const db = makeDb();
    const { createCallerFactory } = await import('@/server/trpc');
    const { usersRouter } = await import('./users');
    for (const organizationId of [U('a'), U('b')]) {
      await createCallerFactory(usersRouter)(
        makeContext({ db, userId: U('9'), permissions: [P.user.readAll], organizationId }),
      ).facetCounts(base);
    }
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).toContain(`${U('a')}:all:`);
    expect(cacheKeys[1]).toContain(`${U('b')}:all:`);
  });

  it('resolves labels for a foreign-key facet', async () => {
    // The rail renders a label and filters by id, so the id alone is not enough.
    const db = makeDb();
    getOrSetFacetEntry.mockResolvedValue({ scoped: true, values: [{ value: 'bu1', count: 5 }] });
    db.businessUnit.findMany.mockResolvedValue([{ id: 'bu1', label: { en: 'Ops' } }]);
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts({ fields: ['businessUnit'] });
    expect(out.counts.businessUnit).toEqual([{ value: 'bu1', label: { en: 'Ops' }, count: 5 }]);
  });

  it('leaves an enum facet unlabelled for the client to translate', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts({ fields: ['status'] });
    expect(out.counts.status?.[0]).not.toHaveProperty('label');
  });

  it('nulls the label for an id the lookup no longer has', async () => {
    // A soft-deleted business unit still on a user row must not drop the count.
    const db = makeDb();
    getOrSetFacetEntry.mockResolvedValue({ scoped: true, values: [{ value: 'gone', count: 2 }] });
    db.businessUnit.findMany.mockResolvedValue([]);
    const caller = await callerFor(db, [P.user.readAll]);
    const out = await caller.facetCounts({ fields: ['businessUnit'] });
    expect(out.counts.businessUnit).toEqual([{ value: 'gone', label: null, count: 2 }]);
  });

  it('skips the label query entirely for an empty facet', async () => {
    const db = makeDb();
    getOrSetFacetEntry.mockResolvedValue({ scoped: true, values: [] });
    const caller = await callerFor(db, [P.user.readAll]);
    await caller.facetCounts({ fields: ['businessUnit'] });
    expect(db.businessUnit.findMany).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await expect(caller.facetCounts({ fields: [] })).rejects.toThrow();
  });

  it('rejects a field it does not compute', async () => {
    const db = makeDb();
    const caller = await callerFor(db, [P.user.readAll]);
    await expect(caller.facetCounts({ fields: ['salary'] } as never)).rejects.toThrow();
  });
});

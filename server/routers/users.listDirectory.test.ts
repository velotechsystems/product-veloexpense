// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The Employee Directory's filter translation — `listDirectory`.
 *
 * Hermetic: `db` is a stub, so what gets asserted is the WHERE clause the router
 * hands Prisma. That is the right seam here, because every bug this area has
 * produced was a filter that quietly matched the wrong set rather than an error.
 * A filter that silently does nothing looks identical to one that works until
 * somebody counts the rows.
 *
 * Four rules carry real weight and none of them are visible from the call site:
 *
 *   · A name filter spans firstName + lastName, so positive operators must OR
 *     ("either side matches") while negative ones must AND ("both sides fail").
 *     OR-ing a negation matches nearly everybody.
 *   · The manager filter accepts ONLY isEmpty / isNotEmpty and throws otherwise,
 *     because "manager contains rim" silently matching everything is exactly the
 *     failure this area keeps reproducing.
 *   · Enum columns must NOT get `mode: 'insensitive'` — Prisma 7 rejects it on an
 *     enum — while text columns must, or `isAnyOf` becomes case-sensitive and
 *     misses rows a single `equals` would have found.
 *   · Scope 'all' is admin-only, and it is enforced at the router boundary rather
 *     than inside the scope resolver.
 */

const resolveScopedIds =
  vi.fn<(db: unknown, id: string, scope: string) => Promise<string[] | null>>();

vi.mock('@/server/lib/userScope', () => ({ resolveScopedIds }));

// `@/server/trpc` pulls the NextAuth root, which imports `next/server` — unresolvable
// under the node environment. Every router test stubs these two for the same reason;
// neither is reachable from a caller built with an injected context.
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: vi.fn(async () => {}),
}));

const ADMIN = [P.user.readAll] as const;

/** A directory row in the RAW shape the select produces, before derivation. */
function rawRow(over: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-7000-8000-00000000000a',
    email: 'a@e.inc',
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
    role: { id: 'r1', label: { en: 'Employee' } },
    manager: null,
    ...over,
  };
}

interface Stub {
  count: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  db: unknown;
}

function makeDb(rows: unknown[] = [rawRow()], total = 1): Stub {
  const count = vi.fn(async () => total);
  const findMany = vi.fn(async () => rows);
  const queryRaw = vi.fn(async () => [] as unknown[]);
  return { count, findMany, queryRaw, db: { user: { count, findMany }, $queryRaw: queryRaw } };
}

async function call(
  stub: Stub,
  input: Record<string, unknown> = {},
  permissions: readonly string[] = ADMIN,
) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { usersRouter } = await import('./users');
  const caller = createCallerFactory(usersRouter)(
    makeContext({ db: stub.db, userId: 'caller-1', permissions }),
  );
  return caller.listDirectory(input as never);
}

/** The AND-stack of per-column filters the router built, or [] if it built none. */
function andClauses(stub: Stub): Record<string, unknown>[] {
  const where = stub.count.mock.calls[0]?.[0]?.where ?? {};
  return (where.AND ?? []) as Record<string, unknown>[];
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveScopedIds.mockResolvedValue(null);
});

describe('scope', () => {
  it("refuses scope 'all' without user.read.all", async () => {
    const stub = makeDb();
    await expect(call(stub, { scope: 'all' }, [])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.count).not.toHaveBeenCalled();
  });

  it("defaults an admin to 'all'", async () => {
    const stub = makeDb();
    await call(stub, {}, ADMIN);
    expect(resolveScopedIds).toHaveBeenCalledWith(expect.anything(), 'caller-1', 'all');
  });

  it("defaults a non-admin to their own chain, not to 'all'", async () => {
    // The important half: an employee who passes no scope must not silently get the
    // whole company just because the parameter was absent.
    const stub = makeDb();
    resolveScopedIds.mockResolvedValue(['x']);
    await call(stub, {}, []);
    expect(resolveScopedIds).toHaveBeenCalledWith(expect.anything(), 'caller-1', 'chain');
  });

  it('lets a non-admin ask for a narrower scope', async () => {
    const stub = makeDb();
    resolveScopedIds.mockResolvedValue(['x']);
    await call(stub, { scope: 'direct' }, []);
    expect(resolveScopedIds).toHaveBeenCalledWith(expect.anything(), 'caller-1', 'direct');
  });

  it('short-circuits an empty scope without querying', async () => {
    // A manager with no reports asking for 'direct'. No row can match, so the query
    // is skipped entirely rather than run with `id IN ()`.
    const stub = makeDb();
    resolveScopedIds.mockResolvedValue([]);
    const out = await call(stub, { scope: 'direct' }, []);
    expect(out).toEqual({ items: [], nextCursor: null, totalCount: 0 });
    expect(stub.count).not.toHaveBeenCalled();
    expect(stub.findMany).not.toHaveBeenCalled();
  });

  it('constrains the query to the scoped ids', async () => {
    const stub = makeDb();
    resolveScopedIds.mockResolvedValue(['u1', 'u2']);
    await call(stub, { scope: 'chain' }, []);
    expect(stub.count.mock.calls[0]?.[0]?.where).toMatchObject({ id: { in: ['u1', 'u2'] } });
  });
});

describe('soft-delete', () => {
  it('excludes deleted users by default', async () => {
    const stub = makeDb();
    await call(stub, {});
    expect(stub.count.mock.calls[0]?.[0]?.where).toMatchObject({ deletedAt: null });
  });

  it('includes them on request', async () => {
    const stub = makeDb();
    await call(stub, { includeDeleted: true });
    expect(stub.count.mock.calls[0]?.[0]?.where.deletedAt).toBeUndefined();
  });
});

describe('the name filter spans both name columns', () => {
  it('ORs a positive operator across firstName and lastName', async () => {
    const stub = makeDb();
    await call(stub, { name: { op: 'contains', value: 'ada' } });
    expect(andClauses(stub)[0]).toEqual({
      OR: [
        { firstName: { contains: 'ada', mode: 'insensitive' } },
        { lastName: { contains: 'ada', mode: 'insensitive' } },
      ],
    });
  });

  it('ANDs a negative operator across them', async () => {
    /**
     * The rule that matters. "Name does not contain ada" has to fail on BOTH
     * columns to exclude a row — OR-ing the two negations keeps every person whose
     * first name alone lacks "ada", which is essentially the whole directory.
     */
    const stub = makeDb();
    await call(stub, { name: { op: 'doesNotContain', value: 'ada' } });
    expect(andClauses(stub)[0]).toEqual({
      AND: [
        { NOT: { firstName: { contains: 'ada', mode: 'insensitive' } } },
        { NOT: { lastName: { contains: 'ada', mode: 'insensitive' } } },
      ],
    });
  });

  it('treats isEmpty as negative, requiring both columns to be blank', async () => {
    const stub = makeDb();
    await call(stub, { name: { op: 'isEmpty' } });
    const clause = andClauses(stub)[0] as { AND: unknown[] };
    expect(clause.AND).toHaveLength(2);
    expect(clause.AND[0]).toEqual({ OR: [{ firstName: null }, { firstName: '' }] });
  });

  it('ORs several name filters together', async () => {
    const stub = makeDb();
    await call(stub, {
      name: [
        { op: 'contains', value: 'ada' },
        { op: 'contains', value: 'grace' },
      ],
    });
    const clause = andClauses(stub)[0] as { OR: unknown[] };
    expect(clause.OR).toHaveLength(2);
  });

  it('unwraps a single-element array rather than nesting a pointless OR', async () => {
    const stub = makeDb();
    await call(stub, { name: [{ op: 'contains', value: 'ada' }] });
    expect(andClauses(stub)[0]).toEqual({
      OR: [
        { firstName: { contains: 'ada', mode: 'insensitive' } },
        { lastName: { contains: 'ada', mode: 'insensitive' } },
      ],
    });
  });
});

describe('enum columns versus text columns', () => {
  it('omits mode:insensitive on an enum', async () => {
    // Prisma 7 REJECTS `mode: insensitive` on an enum, and case-insensitivity is
    // meaningless when the value set is the enum's own literals.
    const stub = makeDb();
    await call(stub, { status: { op: 'equals', value: 'ACTIVE' } });
    expect(andClauses(stub)[0]).toEqual({ employeeStatus: { equals: 'ACTIVE' } });
  });

  it('applies it on a text column', async () => {
    const stub = makeDb();
    await call(stub, { email: { op: 'equals', value: 'A@E.INC' } });
    expect(andClauses(stub)[0]).toEqual({ email: { equals: 'A@E.INC', mode: 'insensitive' } });
  });

  it('keeps isAnyOf case-insensitive on text', async () => {
    // Without this a bare `in` is case-SENSITIVE, so "equals Kati or Naveed" would
    // miss rows that a single `equals` on the same value would have matched.
    const stub = makeDb();
    await call(stub, { email: { op: 'isAnyOf', values: ['a@e.inc', 'b@e.inc'] } });
    expect(andClauses(stub)[0]).toEqual({
      email: { in: ['a@e.inc', 'b@e.inc'], mode: 'insensitive' },
    });
  });

  it('keeps isAnyOf exact on an enum', async () => {
    const stub = makeDb();
    await call(stub, { status: { op: 'isAnyOf', values: ['ACTIVE', 'ON_LEAVE'] } });
    expect(andClauses(stub)[0]).toEqual({ employeeStatus: { in: ['ACTIVE', 'ON_LEAVE'] } });
  });

  it('translates isNoneOf to notIn on both kinds of column', async () => {
    const stub = makeDb();
    await call(stub, {
      status: { op: 'isNoneOf', values: ['TERMINATED'] },
      email: { op: 'isNoneOf', values: ['x@e.inc'] },
    });
    const clauses = andClauses(stub);
    expect(clauses).toContainEqual({ employeeStatus: { notIn: ['TERMINATED'] } });
    expect(clauses).toContainEqual({ email: { notIn: ['x@e.inc'], mode: 'insensitive' } });
  });

  it('covers the remaining string operators', async () => {
    const stub = makeDb();
    await call(stub, {
      email: [
        { op: 'startsWith', value: 'a' },
        { op: 'endsWith', value: 'inc' },
        { op: 'doesNotEqual', value: 'z@e.inc' },
        { op: 'isNotEmpty' },
      ],
    });
    const clause = andClauses(stub)[0] as { OR: unknown[] };
    expect(clause.OR).toEqual([
      { email: { startsWith: 'a', mode: 'insensitive' } },
      { email: { endsWith: 'inc', mode: 'insensitive' } },
      { NOT: { email: { equals: 'z@e.inc', mode: 'insensitive' } } },
      { AND: [{ email: { not: null } }, { email: { not: '' } }] },
    ]);
  });

  it('maps each org column to its physical foreign key', async () => {
    const stub = makeDb();
    await call(stub, {
      businessUnit: { op: 'equals', value: 'bu1' },
      department: { op: 'equals', value: 'd1' },
      entity: { op: 'equals', value: 'le1' },
    });
    const clauses = andClauses(stub);
    expect(clauses).toContainEqual({ businessUnitId: { equals: 'bu1', mode: 'insensitive' } });
    expect(clauses).toContainEqual({ departmentId: { equals: 'd1', mode: 'insensitive' } });
    expect(clauses).toContainEqual({ legalEntityId: { equals: 'le1', mode: 'insensitive' } });
  });
});

describe('the manager-presence filter', () => {
  it('answers "has no manager"', async () => {
    // The operational question: somebody with no reporting line routes to the
    // approver-pool fallback instead of a person, so listing them is how it gets fixed.
    const stub = makeDb();
    await call(stub, { manager: { op: 'isEmpty' } });
    expect(andClauses(stub)[0]).toEqual({ managerId: null });
  });

  it('answers "has a manager"', async () => {
    const stub = makeDb();
    await call(stub, { manager: { op: 'isNotEmpty' } });
    expect(andClauses(stub)[0]).toEqual({ managerId: { not: null } });
  });

  it('rejects any other operator instead of matching everything', async () => {
    const stub = makeDb();
    await expect(call(stub, { manager: { op: 'contains', value: 'rim' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('ORs two presence filters', async () => {
    const stub = makeDb();
    await call(stub, { manager: [{ op: 'isEmpty' }, { op: 'isNotEmpty' }] });
    expect(andClauses(stub)[0]).toEqual({
      OR: [{ managerId: null }, { managerId: { not: null } }],
    });
  });

  it('filters by a specific manager id separately from presence', async () => {
    const stub = makeDb();
    const id = '00000000-0000-7000-8000-0000000000f1';
    await call(stub, { managerId: id });
    expect(stub.count.mock.calls[0]?.[0]?.where).toMatchObject({ managerId: id });
  });
});

/*
 * VeloExpense: ExpenseOS's "derived MFA filter" block is not ported. VeloExpense signs in
 * through Google only and holds no second factor of its own, so there is no `mfaEnrolled`
 * filter or column (users.ts). An `mfaEnrolled` key is not part of the input; zod drops it.
 */
describe('VeloExpense: no MFA filter', () => {
  it('adds no clause for an mfaEnrolled key', async () => {
    const stub = makeDb();
    await call(stub, { mfaEnrolled: { op: 'equals', value: 'enrolled' } });
    expect(andClauses(stub)).toHaveLength(0);
  });
});

describe('the access filter', () => {
  /**
   * `hasAccess` (VeloExpense's name for ExpenseOS's `hasExpenseOSAccess`, 0072) is a
   * plain boolean that reaches the server as an enum: a pill reading "Access: granted" is legible where one
   * reading "Access: true" is not. `accessWhere` is what bridges the two, and it shipped
   * with no test at all — the flag it filters is the one that decides who may sign in, and
   * production has already spent a release with every real person locked out.
   */
  it('translates "granted" to the flag being set', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'equals', value: 'granted' } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: true });
  });

  it('translates "denied" to the flag being clear', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'equals', value: 'denied' } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: false });
  });

  it('reads a negated "granted" as "denied"', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'doesNotEqual', value: 'granted' } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: false });
  });

  it('reads a negated "denied" as "granted"', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'doesNotEqual', value: 'denied' } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: true });
  });

  it('reads isAnyOf with one value', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'isAnyOf', values: ['denied'] } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: false });
  });

  it('reads isNoneOf as the opposite state', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'isNoneOf', values: ['denied'] } });
    expect(andClauses(stub)[0]).toEqual({ hasAccess: true });
  });

  it('drops the filter when both states are selected', async () => {
    /**
     * "granted OR denied" is every user, so it must resolve to NO clause. Picking a side
     * would silently hide half the directory — and on this column, hiding the half that
     * cannot sign in is precisely the state nobody was able to see.
     */
    const stub = makeDb();
    await call(stub, { access: { op: 'isAnyOf', values: ['granted', 'denied'] } });
    expect(andClauses(stub)).toHaveLength(0);
  });

  it('drops the filter when neither state is named', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'isAnyOf', values: ['nonsense'] } });
    expect(andClauses(stub)).toHaveLength(0);
  });

  it('drops the filter for an operator it cannot interpret', async () => {
    const stub = makeDb();
    await call(stub, { access: { op: 'contains', value: 'granted' } });
    expect(andClauses(stub)).toHaveLength(0);
  });

  it('collapses two clauses that agree, and drops two that conflict', async () => {
    const agree = makeDb();
    await call(agree, {
      access: [
        { op: 'equals', value: 'granted' },
        { op: 'doesNotEqual', value: 'denied' },
      ],
    });
    expect(andClauses(agree)[0]).toEqual({ hasAccess: true });

    const conflict = makeDb();
    await call(conflict, {
      access: [
        { op: 'equals', value: 'granted' },
        { op: 'equals', value: 'denied' },
      ],
    });
    expect(andClauses(conflict)).toHaveLength(0);
  });
});

describe('the external-id filter goes through raw SQL', () => {
  it('AND-s the matched ids into the base where', async () => {
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([{ id: 'u7' }, { id: 'u9' }]);
    await call(stub, { externalIds: { op: 'contains', value: '1234' } });
    expect(stub.queryRaw).toHaveBeenCalledOnce();
    expect(andClauses(stub)).toContainEqual({ id: { in: ['u7', 'u9'] } });
  });

  it('short-circuits when the alias lookup matches nobody', async () => {
    // Without this, `id IN ()` would be handed to Prisma.
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([]);
    const out = await call(stub, { externalIds: { op: 'equals', value: 'nope' } });
    expect(out).toEqual({ items: [], nextCursor: null, totalCount: 0 });
    expect(stub.count).not.toHaveBeenCalled();
  });

  it('accepts every operator without throwing', async () => {
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([{ id: 'u1' }]);
    await call(stub, {
      externalIds: [
        { op: 'contains', value: 'a' },
        { op: 'doesNotContain', value: 'b' },
        { op: 'equals', value: 'c' },
        { op: 'doesNotEqual', value: 'd' },
        { op: 'startsWith', value: 'e' },
        { op: 'endsWith', value: 'f' },
        { op: 'isEmpty' },
        { op: 'isNotEmpty' },
        { op: 'isAnyOf', values: ['g', 'h'] },
        { op: 'isNoneOf', values: ['i', 'j'] },
      ],
    });
    expect(stub.queryRaw).toHaveBeenCalledOnce();
  });
});

describe('row derivation', () => {
  it('flattens the alias rows into a code→value map', async () => {
    const stub = makeDb([
      rawRow({
        externalIds: [
          { sourceValue: '1234', source: { code: 'netsuite' } },
          { sourceValue: 'E-9', source: { code: 'adp' } },
        ],
      }),
    ]);
    const out = await call(stub, {});
    expect(out.items[0]?.externalIds).toEqual({ netsuite: '1234', adp: 'E-9' });
  });

  it('takes the home currency from the person\'s legal entity', async () => {
    // VeloExpense: a person has no currency of their own; it is their entity's (Wave 2).
    const stub = makeDb([
      rawRow({ entity: { id: 'e1', label: { en: 'US' }, homeCurrencyId: 'USD' } }),
    ]);
    const out = await call(stub, {});
    expect(out.items[0]?.homeCurrency).toBe('USD');
    expect(out.items[0]?.entity).toEqual({ id: 'e1', label: { en: 'US' } });
  });

  it('tolerates a user with no home currency', async () => {
    const stub = makeDb([rawRow({ entity: null })]);
    const out = await call(stub, {});
    expect(out.items[0]?.homeCurrency).toBeNull();
  });

  it('VeloExpense: gives every row empty NetSuite fields until NetSuite arrives', async () => {
    const out = await call(makeDb([rawRow()]), {});
    expect(out.items[0]).toMatchObject({ nsClass: null, nsBusinessUnit: null, syncDiscrepancies: [] });
  });

  it('VeloExpense: sends no credential or MFA field to the browser', async () => {
    const out = await call(makeDb([rawRow()]), {});
    expect(out.items[0]).not.toHaveProperty('totpSecret');
    expect(out.items[0]).not.toHaveProperty('mfaEnrolled');
  });
});

describe('cursor pagination', () => {
  const row = (id: string, firstName: string) => rawRow({ id, firstName });

  it('peeks one row past the page size', async () => {
    const stub = makeDb([row('a', 'A')], 1);
    await call(stub, { take: 10 });
    expect(stub.findMany.mock.calls[0]?.[0]?.take).toBe(11);
  });

  it('returns no cursor when the page is not full', async () => {
    const stub = makeDb([row('a', 'A')], 1);
    const out = await call(stub, { take: 10 });
    expect(out.nextCursor).toBeNull();
    expect(out.items).toHaveLength(1);
  });

  it('trims the peeked row and emits a cursor when there is more', async () => {
    const stub = makeDb([row('a', 'A'), row('b', 'B'), row('c', 'C')], 3);
    const out = await call(stub, { take: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeTruthy();
    // The cursor names the LAST returned row, not the peeked one.
    const decoded = JSON.parse(Buffer.from(out.nextCursor as string, 'base64url').toString('utf8'));
    expect(decoded.id).toBe('b');
  });

  it('turns a supplied cursor into a tuple-greater-than predicate', async () => {
    const stub = makeDb([row('c', 'C')], 3);
    const cursor = Buffer.from(
      JSON.stringify({ firstName: 'B', lastName: 'B', id: 'b' }),
      'utf8',
    ).toString('base64url');
    await call(stub, { cursor, take: 2 });
    // The count is unfiltered by the cursor — the header shows the whole view, not
    // what is left of it — while findMany is narrowed.
    expect(stub.count.mock.calls[0]?.[0]?.where.OR).toBeUndefined();
    expect(stub.findMany.mock.calls[0]?.[0]?.where.OR).toBeTruthy();
  });

  it('orders by the tuple with nulls last so the cursor stays valid', async () => {
    const stub = makeDb([row('a', 'A')], 1);
    await call(stub, {});
    expect(stub.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { firstName: { sort: 'asc', nulls: 'last' } },
      { lastName: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('reports the filtered total, not the page length', async () => {
    const stub = makeDb([row('a', 'A')], 137);
    const out = await call(stub, { take: 1 });
    expect(out.totalCount).toBe(137);
  });
});

describe('fuzzy search', () => {
  it('preserves the rank order the SQL returned', async () => {
    /**
     * Two-step by design: pg_trgm ranks ids in SQL, then Prisma re-fetches them and
     * applies the column filters. Prisma returns them in ITS order, so the router
     * has to re-sort by the ranked id list — losing that puts an exact external-id
     * match below a weak name-similarity hit.
     */
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([
      { id: 'c', rank: 1 },
      { id: 'a', rank: 0.5 },
      { id: 'b', rank: 0.3 },
    ]);
    stub.findMany.mockResolvedValue([
      rawRow({ id: 'a' }),
      rawRow({ id: 'b' }),
      rawRow({ id: 'c' }),
    ]);
    const out = await call(stub, { search: 'ada' });
    expect(out.items.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('never paginates a search', async () => {
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([{ id: 'a', rank: 1 }]);
    stub.findMany.mockResolvedValue([rawRow({ id: 'a' })]);
    const out = await call(stub, { search: 'ada' });
    expect(out.nextCursor).toBeNull();
  });

  it('drops a ranked id the column filters then exclude', async () => {
    const stub = makeDb();
    stub.queryRaw.mockResolvedValue([
      { id: 'a', rank: 1 },
      { id: 'gone', rank: 0.9 },
    ]);
    stub.findMany.mockResolvedValue([rawRow({ id: 'a' })]);
    const out = await call(stub, { search: 'ada', status: { op: 'equals', value: 'ACTIVE' } });
    expect(out.items.map((r) => r.id)).toEqual(['a']);
  });

  it('returns the total even when the trigram match is empty', async () => {
    const stub = makeDb([], 42);
    stub.queryRaw.mockResolvedValue([]);
    const out = await call(stub, { search: 'zzzz' });
    expect(out).toEqual({ items: [], nextCursor: null, totalCount: 42 });
    expect(stub.findMany).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only search rather than matching nothing', async () => {
    const stub = makeDb([rawRow()], 1);
    await call(stub, { search: '   ' });
    // Falls through to the paginated path — no raw trigram query at all.
    expect(stub.queryRaw).not.toHaveBeenCalled();
    expect(stub.findMany).toHaveBeenCalledOnce();
  });
});

describe('input validation', () => {
  it('caps the page size', async () => {
    const stub = makeDb();
    await expect(call(stub, { take: 1001 })).rejects.toThrow();
  });

  it('rejects a non-uuid manager id', async () => {
    const stub = makeDb();
    await expect(call(stub, { managerId: 'not-a-uuid' })).rejects.toThrow();
  });

  it('rejects an empty operand on a value operator', async () => {
    const stub = makeDb();
    await expect(call(stub, { email: { op: 'contains', value: '' } })).rejects.toThrow();
  });

  it('rejects an empty isAnyOf list', async () => {
    const stub = makeDb();
    await expect(call(stub, { email: { op: 'isAnyOf', values: [] } })).rejects.toThrow();
  });

  it('defaults to a 50-row page with deleted users hidden', async () => {
    const stub = makeDb();
    await call(stub);
    expect(stub.findMany.mock.calls[0]?.[0]?.take).toBe(51);
    expect(stub.count.mock.calls[0]?.[0]?.where).toMatchObject({ deletedAt: null });
  });
});

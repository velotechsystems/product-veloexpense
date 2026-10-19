// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The travel-category admin router.
 *
 * Two rules here carry the weight, and both exist because the alternative corrupts
 * data that already exists:
 *
 *   · **`lineKind` freezes once a category has budget lines.** Every line already
 *     written carries a payload shaped for its block — an airfare line holds a flight
 *     number — and handing those lines to a different block leaves the payload
 *     unreadable rather than merely stale.
 *   · **`code` is not writable.** It is the seed's identity for a row; letting the
 *     admin form set it would let a hand-made category collide with a seeded one, or
 *     silently take over the key `TRAVEL_CATEGORY_CODES` resolves buckets by.
 */

vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, _envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) =>
        fn(db),
    ),
  };
});
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

import { travelCategoriesRouter } from './travelCategories';

const CAT = '019f9a10-0000-7000-8000-000000000101';

function makeDb(over: Record<string, unknown> = {}) {
  return {
    travelCategory: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
      aggregate: stubFn(async () => ({ _max: { sortOrder: 4 } })),
      create: stubFn(async () => ({ id: CAT })),
      update: stubFn(async () => ({ id: CAT })),
      updateMany: stubFn(async () => ({ count: 1 })),
    },
    expenseCategory: { findMany: stubFn(async () => [] as unknown[]) },
    ...over,
  };
}

function caller(db: unknown, perms: string[] = Object.values(P.admin.travelCategory)) {
  return travelCategoriesRouter.createCaller(makeContext({ db, permissions: perms }));
}

beforeEach(() => vi.clearAllMocks());

describe('list', () => {
  it('includes inactive rows — the admin comes here to re-activate one', async () => {
    const db = makeDb();
    await caller(db).list();
    expect(db.travelCategory.findMany.mock.calls[0]?.[0]?.where).toBeUndefined();
  });

  it('reports the account a line will actually stamp, and that it was inherited', async () => {
    /**
     * A mapped travel category is EXPECTED to have no account of its own — it inherits
     * the expense category's. Showing only its own column rendered the ordinary case as
     * "no GL account", which read as broken and had admins setting it a second time.
     */
    const db = makeDb();
    db.travelCategory.findMany.mockResolvedValue([
      {
        id: CAT,
        glAccountId: null,
        glAccount: null,
        expenseCategory: {
          id: 'ec-1',
          label: {},
          glAccount: { number: '620101', name: 'Airfare' },
        },
      },
    ]);
    const [row] = await caller(db).list();
    expect(row.effectiveGlAccountNumber).toBe('620101');
    expect(row.effectiveGlAccountName).toBe('Airfare');
    expect(row.glAccountInherited).toBe(true);
  });

  it('does not claim inheritance when the category has its own account', async () => {
    const db = makeDb();
    db.travelCategory.findMany.mockResolvedValue([
      {
        id: CAT,
        glAccountId: 'gl-9',
        glAccount: { number: '999999', name: 'Own' },
        expenseCategory: {
          id: 'ec-1',
          label: {},
          glAccount: { number: '620101', name: 'Airfare' },
        },
      },
    ]);
    const [row] = await caller(db).list();
    expect(row.effectiveGlAccountNumber).toBe('999999');
    expect(row.glAccountInherited).toBe(false);
  });
});

describe('expenseCategoryOptions', () => {
  it('offers only ACTIVE expense categories', async () => {
    // Mapping to a retired category produces lines a generated report cannot file.
    const db = makeDb();
    await caller(db).expenseCategoryOptions();
    expect(db.expenseCategory.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
  });
});

describe('create', () => {
  const INPUT = {
    label: { en: 'Visa fees', 'fr-CA': 'Frais de visa' },
    lineKind: 'STANDARD' as const,
    active: true,
  };

  it('appends to the end of the manual order', async () => {
    const db = makeDb();
    await caller(db).create(INPUT);
    expect(db.travelCategory.create.mock.calls[0]?.[0]?.data?.sortOrder).toBe(5);
  });

  it('never sets `code` — that is the seed’s identity, not the form’s', async () => {
    const db = makeDb();
    await caller(db).create(INPUT);
    expect(db.travelCategory.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('code');
  });

  it('allows an unmapped category, which estimates but cannot be reconciled', async () => {
    const db = makeDb();
    await caller(db).create(INPUT);
    expect(db.travelCategory.create.mock.calls[0]?.[0]?.data?.expenseCategoryId).toBeNull();
  });

  it('refuses a colour that is not #RRGGBB', async () => {
    const db = makeDb();
    await expect(caller(db).create({ ...INPUT, color: 'red' })).rejects.toThrow();
  });
});

describe('update', () => {
  it('lets the type change while nothing has been estimated yet', async () => {
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue({
      lineKind: 'STANDARD',
      _count: { budgetLines: 0 },
    });
    await caller(db).update({ id: CAT, lineKind: 'AIRFARE' });
    expect(db.travelCategory.update).toHaveBeenCalled();
  });

  it('refuses a type change once budget lines exist', async () => {
    /** Those lines carry a payload the new block has no field to read. */
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue({
      lineKind: 'AIRFARE',
      _count: { budgetLines: 3 },
    });
    await expect(caller(db).update({ id: CAT, lineKind: 'GROUND' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(db.travelCategory.update).not.toHaveBeenCalled();
  });

  it('allows every other edit on a category that has lines', async () => {
    // Renaming one, recolouring it or deactivating it reinterprets nothing already
    // written — only the block does.
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue({
      lineKind: 'AIRFARE',
      _count: { budgetLines: 3 },
    });
    await caller(db).update({ id: CAT, active: false });
    expect(db.travelCategory.update).toHaveBeenCalled();
  });

  it('treats re-submitting the SAME type as no change', async () => {
    // The drawer sends every field, so a rename would otherwise be refused purely for
    // carrying the type it already had.
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue({
      lineKind: 'AIRFARE',
      _count: { budgetLines: 3 },
    });
    await caller(db).update({ id: CAT, lineKind: 'AIRFARE', active: false });
    expect(db.travelCategory.update).toHaveBeenCalled();
  });

  it('404s on a category that does not exist', async () => {
    const db = makeDb();
    db.travelCategory.findUnique.mockResolvedValue(null);
    await expect(caller(db).update({ id: CAT, lineKind: 'GROUND' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('reorder', () => {
  it('writes each id’s position as its sortOrder', async () => {
    const db = makeDb();
    const a = '019f9a10-0000-7000-8000-000000000102';
    await caller(db).reorder({ ids: [a, CAT] });
    const calls = db.travelCategory.updateMany.mock.calls;
    expect(calls[0]?.[0]).toEqual({ where: { id: a }, data: { sortOrder: 0 } });
    expect(calls[1]?.[0]).toEqual({ where: { id: CAT }, data: { sortOrder: 1 } });
  });
});

describe('permissions', () => {
  it('refuses a reader without the list permission', async () => {
    await expect(caller(makeDb(), []).list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a writer without the update permission', async () => {
    await expect(
      caller(makeDb(), [P.admin.travelCategory.list]).update({ id: CAT, active: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

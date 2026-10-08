// @vitest-environment node
import { auditActions } from '@expenseos/audit';
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The expense-category admin router.
 *
 * Ported from ExpenseOS `expenseCategories.test.ts` (550b2945). VeloExpense: most of
 * ExpenseOS's file tests the NetSuite expense-category column and override (FR-6,
 * security MUST-1 and MUST-2), which are not ported (see the router's header). Those
 * cases are not here. What is kept, unchanged except for the override field:
 *
 *   · `list` refuses a caller without `admin.expenseCategory.list`;
 *   · **MUST-3: the audit row records `{ from, to }`** for what changed, not the keys the
 *     form sent;
 *   · an unknown category, a list-only caller and a mileage change on a category with
 *     filed lines are refused, writing nothing.
 *
 * `test/expense-categories.db.test.ts` runs the same router against Postgres: the audit
 * chain it writes, tenancy, and the kind guard on real line items.
 */

const h = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        // Only a callback that returns records an audit row, as in the real writer.
        const result = await fn(db);
        h.audits.push(envelope);
        return result;
      },
    ),
  };
});
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

import { expenseCategoriesRouter } from './expenseCategories';

const CAT = '019f9a10-0000-7000-8000-000000000201';
const GL = '019f9a10-0000-7000-8000-000000000401';
/** A category row as `list` reads it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: CAT,
  label: { en: 'Meals', 'fr-CA': 'Repas' },
  glAccountId: GL,
  glAccount: { name: 'Meals & Ent.', number: '6000', isActive: true },
  icon: null,
  color: null,
  itcGstHstRate: 100,
  itcQstRate: 100,
  pstRecoverable: false,
  requiresAttendees: false,
  acceptsTip: false,
  isMileage: false,
  active: true,
  sortOrder: 0,
  _count: { lineItems: 0 },
  ...over,
});

/** The row as it stood, for `update`'s audit diff. */
const before = (over: Record<string, unknown> = {}) => ({
  label: { en: 'Meals', 'fr-CA': 'Repas' },
  glAccountId: GL,
  icon: null,
  color: null,
  itcGstHstRate: 100,
  itcQstRate: 100,
  pstRecoverable: false,
  requiresAttendees: false,
  isMileage: false,
  acceptsTip: false,
  sortOrder: 0,
  active: true,
  _count: { lineItems: 0 },
  ...over,
});

function makeDb() {
  return {
    expenseCategory: {
      findMany: stubFn(async () => [row()] as unknown[]),
      findUnique: stubFn(async () => before() as unknown),
      update: stubFn(async () => ({ id: CAT })),
    },
  };
}

const ONLY_CATEGORY_ADMIN = Object.values(P.admin.expenseCategory);

function caller(db: unknown, perms: readonly string[] = ONLY_CATEGORY_ADMIN) {
  return expenseCategoriesRouter.createCaller(makeContext({ db, permissions: perms }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.audits = [];
});

describe('list', () => {
  it('flattens the GL account for the list', async () => {
    const { categories } = await caller(makeDb()).list();
    expect(categories[0]).toMatchObject({
      glAccountNumber: '6000',
      glAccountName: 'Meals & Ent.',
      glAccount: { name: 'Meals & Ent.', number: '6000', isActive: true },
    });
  });

  it('refuses a caller without admin.expenseCategory.list', async () => {
    await expect(caller(makeDb(), [P.ledger.referenceView]).list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('update — the audit row (MUST-3) and the guards', () => {
  it('records a label edit as from/to', async () => {
    const db = makeDb();
    await caller(db).update({ id: CAT, label: { en: 'Food', 'fr-CA': 'Repas' } });
    // VeloExpense: this case now also carries the envelope assertions of ExpenseOS's
    // override case (`sets the override and audits it as from/to`), which is not ported.
    expect(h.audits[0]).toMatchObject({
      action: auditActions.admin.expenseCategoryUpdate,
      entityType: 'ExpenseCategory',
      entityId: CAT,
    });
    expect(h.audits[0]?.details).toEqual({
      changed: {
        label: {
          from: { en: 'Meals', 'fr-CA': 'Repas' },
          to: { en: 'Food', 'fr-CA': 'Repas' },
        },
      },
      fields: ['label'],
      unchanged: false,
    });
  });

  it('records only what changed when the whole form is saved', async () => {
    const db = makeDb();
    await caller(db).update({
      id: CAT,
      label: { en: 'Meals', 'fr-CA': 'Repas' },
      glAccountId: GL,
      icon: null,
      color: null,
      itcGstHstRate: 50,
      itcQstRate: 100,
      pstRecoverable: false,
      requiresAttendees: false,
      kind: 'standard',
      active: true,
    });
    expect(h.audits[0]?.details).toEqual({
      changed: { itcGstHstRate: { from: 100, to: 50 } },
      fields: ['itcGstHstRate'],
      unchanged: false,
    });
  });

  it('refuses an unknown category with NOT_FOUND before anything else', async () => {
    const db = makeDb();
    db.expenseCategory.findUnique.mockResolvedValue(null);
    await expect(caller(db).update({ id: CAT, active: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.audits).toEqual([]);
  });

  it('still refuses crossing the mileage boundary once lines are filed', async () => {
    const db = makeDb();
    db.expenseCategory.findUnique.mockResolvedValue(before({ _count: { lineItems: 3 } }));
    await expect(caller(db).update({ id: CAT, kind: 'mileage' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(db.expenseCategory.update).not.toHaveBeenCalled();
  });

  it('refuses a list-only caller', async () => {
    const db = makeDb();
    await expect(
      caller(db, [P.admin.expenseCategory.list]).update({ id: CAT, active: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not accept the override on create', async () => {
    // VeloExpense: nor on update — there is no override; zod strips it either way.
    const db = {
      ...makeDb(),
      expenseCategory: {
        ...makeDb().expenseCategory,
        aggregate: stubFn(async () => ({ _max: { sortOrder: 1 } })),
        create: stubFn(async () => ({ id: CAT })),
      },
    };
    await caller(db).create({
      label: { en: 'New', 'fr-CA': 'Nouveau' },
      itcGstHstRate: 100,
      itcQstRate: 100,
      pstRecoverable: false,
      active: true,
      // Not in create's input: zod strips it.
      ...({ nsCategoryId: '019f9a10-0000-7000-8000-000000000301' } as object),
    });
    expect(db.expenseCategory.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('nsCategoryId');
  });
});

// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/lib/db/prisma';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * `adminLookupRouter` — the factory every admin lookup CRUD page runs on
 * (business units, legal entities, departments, expense categories, …). Exercised
 * through two real consumers, `businessUnits` and `departments`, so the generic
 * behaviour and one entity's `preWrite` hook are both covered.
 *
 * Three rules the factory owns on behalf of every lookup:
 *
 *   · **Lookups are soft-deleted, never removed.** `setActive(false)` is the delete —
 *     historical records reference these rows by id, and a hard delete would strand
 *     every expense coded to a retired department.
 *   · **A unique-constraint violation becomes a sentence.** Prisma's raw message names
 *     a constraint, not a field, so an admin typing a duplicate code would otherwise
 *     see a 500.
 *   · **Search goes through the English label path**, because `label` is a locale-keyed
 *     Json column and a plain `contains` matches nothing on it.
 *
 * And one that `departments` adds: a parent that would close a hierarchy cycle is
 * refused, with the upward walk bounded so pre-existing bad data cannot hang a save.
 *
 * VeloExpense: ported with business units (Wave 1); the `departments` cases with the
 * departments port (w1-03). The External IDs source is found or created per tenant rather than
 * upserted (see `syncEntityAliases`), and the label rules follow `labelSchema`'s
 * VeloExpense note; both marked below. The same rules against Postgres are in
 * test/business-units.db.test.ts.
 */

const withAuditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        withAuditCalls.push(envelope);
        return fn(db);
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

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const BU = U('1');
const LABEL = { en: 'Finance', 'fr-CA': 'Finances' };

function makeDb(model: string, over: Record<string, unknown> = {}) {
  const rows = {
    findMany: stubFn(async () => [] as unknown[]),
    findUnique: stubFn(async () => ({ id: BU, label: LABEL, active: true }) as unknown),
    create: stubFn(async () => ({ id: BU })),
    update: stubFn(async () => ({ id: BU, label: LABEL, active: true })),
  };
  return {
    [model]: rows,
    // VeloExpense: found, or created, within the tenant (no global `code` to upsert on).
    externalIdSource: {
      findFirst: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: U('5') })),
    },
    [`${model}ExternalId`]: {
      deleteMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: U('6') })),
      upsert: stubFn(async () => ({ id: U('6') })),
      createMany: stubFn(async () => ({ count: 0 })),
    },
    ...over,
  } as Record<string, typeof rows> & Record<string, unknown>;
}

async function businessUnits(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { businessUnitsRouter } = await import('./businessUnits');
  return createCallerFactory(businessUnitsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Admin' }),
  );
}

async function departments(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { departmentsRouter } = await import('./departments');
  return createCallerFactory(departmentsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Admin' }),
  );
}

const BU_PERMS = [
  P.admin.businessUnit.list,
  P.admin.businessUnit.create,
  P.admin.businessUnit.update,
  P.admin.businessUnit.delete,
] as const;

const DEPT_PERMS = [
  P.admin.department.list,
  P.admin.department.create,
  P.admin.department.update,
  P.admin.department.delete,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('permission gates', () => {
  it('gates each operation on its own permission', async () => {
    const db = makeDb('businessUnit');
    const lister = await businessUnits(db, [P.admin.businessUnit.list]);
    await expect(lister.list()).resolves.toBeTruthy();
    await expect(lister.create({ label: LABEL } as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(lister.update({ id: BU, patch: { label: LABEL } } as never)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(lister.setActive({ id: BU, active: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not let one lookup’s permissions reach another', async () => {
    // Managing business units is not managing departments.
    const db = makeDb('department');
    const c = await departments(db, [...BU_PERMS]);
    await expect(c.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('list', () => {
  it('hides inactive rows by default', async () => {
    /**
     * Soft-deleted rows must not appear in a picker, or a retired department gets coded
     * onto new spend.
     */
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list();
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
  });

  it('includes them on request, for the admin page', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list({ includeInactive: true });
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.where).toEqual({});
  });

  it('searches through the English label path', async () => {
    // `label` is a locale-keyed Json column; a plain `contains` matches nothing.
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list({ search: 'fin' });
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      label: { path: ['en'], string_contains: 'fin' },
    });
  });

  it('trims the search and bounds it', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list({ search: '  fin  ' });
    expect(
      (
        db.businessUnit.findMany.mock.calls[0]?.[0]?.where as {
          label: { string_contains: string };
        }
      ).label.string_contains,
    ).toBe('fin');
    await expect(c.list({ search: 'x'.repeat(201) })).rejects.toThrow();
  });

  it('ignores an empty search rather than matching nothing', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list({ search: '   ' });
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.where).toEqual({ active: true });
  });

  it('orders deterministically', async () => {
    // A Json label cannot be ordered by, so the stable id is the substitute.
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.list();
    expect(db.businessUnit.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([{ id: 'asc' }]);
  });
});

describe('create', () => {
  it('turns a unique-constraint violation into a sentence', async () => {
    /**
     * Prisma's raw message names a database constraint, not a field, so without this an
     * admin typing a duplicate code sees a 500 and has no idea what to change.
     */
    const db = makeDb('businessUnit');
    db.businessUnit.create.mockRejectedValue(
      new Error('Unique constraint failed on the fields: (`code`)'),
    );
    const c = await businessUnits(db, BU_PERMS);
    await expect(c.create({ label: LABEL } as never)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A Business unit with these values already exists',
    });
  });

  it('rethrows anything that is not a constraint violation', async () => {
    // Swallowing a connection error as "duplicate" would send somebody hunting for a
    // duplicate that does not exist.
    const db = makeDb('businessUnit');
    db.businessUnit.create.mockRejectedValue(new Error('Connection terminated'));
    const c = await businessUnits(db, BU_PERMS);
    await expect(c.create({ label: LABEL } as never)).rejects.toThrow(/Connection terminated/);
  });

  it('never writes externalIds onto the row itself', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.create({ label: LABEL, externalIds: { netsuite: 'BU-1' } } as never);
    expect(db.businessUnit.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('externalIds');
  });

  // VeloExpense: ExpenseOS requires both languages. Here the English name is required and
  // the French one only while French is switched on (`labelSchema`); it is off.
  it('requires the English label', async () => {
    const c = await businessUnits(makeDb('businessUnit'), BU_PERMS);
    await expect(c.create({ label: { 'fr-CA': 'Finances' } } as never)).rejects.toThrow();
    await expect(c.create({ label: { en: '', 'fr-CA': 'Finances' } } as never)).rejects.toThrow();
  });

  it('takes an English-only label while French is off, leaving the empty French out', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.create({ label: { en: 'Finance', 'fr-CA': '' } } as never);
    expect(db.businessUnit.create.mock.calls[0]?.[0]?.data?.label).toEqual({ en: 'Finance' });
  });

  it('keeps a description written in one language, and clears an empty one', async () => {
    // ExpenseOS refuses the first (its `partial()` takes an empty language as invalid).
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.create({ label: LABEL, description: { en: 'Shared services', 'fr-CA': '' } } as never);
    expect(db.businessUnit.create.mock.calls[0]?.[0]?.data?.description).toEqual({
      en: 'Shared services',
    });
    await c.update({ id: BU, patch: { description: { en: ' ', 'fr-CA': '' } } } as never);
    expect(db.businessUnit.update.mock.calls[0]?.[0]?.data?.description).toBe(Prisma.JsonNull);
  });
});

describe('setActive — the soft delete', () => {
  it('deactivates rather than deleting', async () => {
    /**
     * Historical records reference these rows by id. A hard delete would strand every
     * expense coded to a retired department, and the report would render a blank
     * dimension instead of the name it was filed under.
     */
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.setActive({ id: BU, active: false });
    expect(db.businessUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: BU }, data: { active: false } }),
    );
  });

  it('reactivates the same way', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.setActive({ id: BU, active: true });
    expect(db.businessUnit.update.mock.calls[0]?.[0]?.data).toEqual({ active: true });
  });

  it('audits a deactivation as a delete and a reactivation as an update', async () => {
    // The trail should read as "retired", not as an edit.
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.setActive({ id: BU, active: false });
    const deactivate = withAuditCalls[0]?.action;
    withAuditCalls.length = 0;
    await c.setActive({ id: BU, active: true });
    expect(withAuditCalls[0]?.action).not.toBe(deactivate);
  });

  it('records which direction it went', async () => {
    const db = makeDb('businessUnit');
    const c = await businessUnits(db, BU_PERMS);
    await c.setActive({ id: BU, active: false });
    expect(withAuditCalls[0]?.details).toEqual({ active: false });
  });
});

describe('departments — the hierarchy guard', () => {
  it('refuses a department as its own parent', async () => {
    const db = makeDb('department');
    const c = await departments(db, DEPT_PERMS);
    await expect(
      c.update({ id: BU, patch: { label: LABEL, parentId: BU } } as never),
    ).rejects.toThrow(/Cannot set self as parent/);
  });

  it('refuses a parent that would close a cycle', async () => {
    /**
     * A → B → A. Walking UP from the proposed parent reaches the department being
     * edited, so the edit is refused. Left in, every tree walk over departments loops
     * until its depth bound saves it.
     */
    const db = makeDb('department');
    db.department.findUnique.mockResolvedValue({ parentId: BU });
    const c = await departments(db, DEPT_PERMS);
    await expect(
      c.update({ id: BU, patch: { label: LABEL, parentId: U('3') } } as never),
    ).rejects.toThrow(/hierarchy cycle/);
  });

  it('allows a parent whose chain terminates above', async () => {
    const db = makeDb('department');
    db.department.findUnique.mockResolvedValue({ parentId: null });
    const c = await departments(db, DEPT_PERMS);
    await expect(
      c.update({ id: BU, patch: { label: LABEL, parentId: U('3') } } as never),
    ).resolves.toBeTruthy();
  });

  it('bounds the upward walk', async () => {
    // Pre-existing bad data must not hang a save.
    const db = makeDb('department');
    db.department.findUnique.mockResolvedValue({ parentId: U('4') });
    const c = await departments(db, DEPT_PERMS);
    await c.update({ id: BU, patch: { label: LABEL, parentId: U('3') } } as never);
    // MAX_DEPTH hops of the walk, plus the one read the write path does anyway.
    // VeloExpense: plus one — the parent is first looked up to be the tenant's own.
    expect(db.department.findUnique.mock.calls.length).toBeLessThanOrEqual(22);
  });

  it('skips the walk entirely when no parent is being set', async () => {
    const db = makeDb('department');
    const c = await departments(db, DEPT_PERMS);
    await c.update({ id: BU, patch: { label: LABEL } } as never);
    // Exactly one read — the write path's own re-read — and none of the walk's.
    expect(db.department.findUnique).toHaveBeenCalledOnce();
  });

  it('skips the walk when the parent is being cleared', async () => {
    // Detaching a subtree cannot create a cycle.
    const db = makeDb('department');
    const c = await departments(db, DEPT_PERMS);
    await c.update({ id: BU, patch: { label: LABEL, parentId: null } } as never);
    expect(db.department.findUnique).toHaveBeenCalledOnce();
  });

  it('rejects a non-uuid parent', async () => {
    const c = await departments(makeDb('department'), DEPT_PERMS);
    await expect(
      c.update({ id: BU, patch: { label: LABEL, parentId: 'nope' } } as never),
    ).rejects.toThrow();
  });
});

describe('departments — VeloExpense: the parent must be the tenant’s own', () => {
  it('refuses a parent it cannot find — another tenant’s, hidden by RLS — before writing', async () => {
    const db = makeDb('department');
    db.department.findUnique.mockResolvedValue(null);
    const c = await departments(db, DEPT_PERMS);
    await expect(
      c.update({ id: BU, patch: { label: LABEL, parentId: U('3') } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Parent department not found' });
    expect(db.department.update).not.toHaveBeenCalled();
  });
});

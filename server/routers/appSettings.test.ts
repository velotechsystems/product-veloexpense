// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * Application settings — job levels, fiscal years, and the read-only currency list.
 *
 * The fiscal-year rules are the ones that matter, because `isCurrent` is a singleton
 * flag that everything reporting-shaped reads:
 *
 *   · **Exactly one year is current.** Every path that can set the flag has to clear it
 *     elsewhere first — create, update, setCurrent, and the date-driven advance. Two
 *     current years and every budget and report lands in whichever one a query happens
 *     to find.
 *   · **The current year cannot be deleted.** Deleting it leaves the flag unset, and
 *     "no current fiscal year" is a state most callers do not handle.
 *   · **`advanceCurrent` is idempotent.** It runs on a schedule, so it has to report
 *     `changed: false` and write nothing when the right year is already current.
 *   · **A job level in use cannot be deleted**, or every user pointing at it is left
 *     with a dangling reference.
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
// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`; test/job-levels-fiscal-years.db.test.ts
// saves English-only labels).
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));
// VeloExpense: the session comes from `@/auth` (auth-kit).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const FY = U('1');
const LEVEL = U('2');

const LABEL = { en: 'FY2026', 'fr-CA': 'AF2026' };

const fy = (over: Record<string, unknown> = {}) => ({
  id: FY,
  label: LABEL,
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: new Date('2026-12-31T00:00:00Z'),
  isCurrent: false,
  closed: false,
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    jobLevel: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => ({ id: LEVEL, label: LABEL }) as unknown),
      create: stubFn(async () => ({ id: LEVEL })),
      update: stubFn(async () => ({ id: LEVEL })),
      delete: stubFn(async () => ({ id: LEVEL })),
    },
    fiscalYear: {
      findMany: stubFn(async () => [] as unknown[]),
      findFirst: stubFn(async () => null as unknown),
      findUnique: stubFn(async () => fy() as unknown),
      create: stubFn(async () => fy()),
      update: stubFn(async () => fy()),
      updateMany: stubFn(async () => ({ count: 0 })),
      delete: stubFn(async () => fy()),
    },
    currency: { findMany: stubFn(async () => [] as unknown[]) },
    user: { count: stubFn(async () => 0) },
    // VeloExpense: sources are per tenant, found by code then created (`syncEntityAliases`).
    externalIdSource: {
      upsert: stubFn(async () => ({ id: U('5') })),
      findFirst: stubFn(async () => null as unknown),
      create: stubFn(async () => ({ id: U('5') })),
    },
    fiscalYearExternalId: {
      deleteMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: U('6') })),
      upsert: stubFn(async () => ({ id: U('6') })),
      createMany: stubFn(async () => ({ count: 0 })),
    },
    jobLevelExternalId: {
      deleteMany: stubFn(async () => ({ count: 0 })),
      create: stubFn(async () => ({ id: U('7') })),
      upsert: stubFn(async () => ({ id: U('7') })),
      createMany: stubFn(async () => ({ count: 0 })),
    },
    ...over,
  };
}

async function callerFor(db: unknown, permissions: readonly string[]) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { appSettingsRouter } = await import('./appSettings');
  return createCallerFactory(appSettingsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Admin' }),
  );
}

const READ = [P.config.policyRead] as const;
const FY_WRITE = [P.config.fiscalYearUpdate] as const;
const LEVEL_WRITE = [P.config.jobLevelUpdate] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('permission gates', () => {
  it('separates reading from each write permission', async () => {
    const db = makeDb();
    const reader = await callerFor(db, READ);
    await expect(reader.jobLevels.list()).resolves.toBeTruthy();
    await expect(reader.fiscalYears.list()).resolves.toBeTruthy();
    await expect(reader.currencies.list()).resolves.toBeTruthy();
    await expect(reader.jobLevels.delete({ id: LEVEL })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(reader.fiscalYears.setCurrent({ id: FY })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('keeps the two write permissions apart', async () => {
    // Managing job levels is not managing fiscal years.
    const db = makeDb();
    const c = await callerFor(db, LEVEL_WRITE);
    await expect(c.fiscalYears.setCurrent({ id: FY })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('currencies.list', () => {
  // VeloExpense: the shared `currency` table has no `active` flag — every row is usable,
  // so every row is offered — and its exponent is `minorUnit`, returned as `precision`.
  it('offers every currency (VeloExpense: there is no active flag)', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.currencies.list();
    expect(db.currency.findMany.mock.calls[0]?.[0]?.where).toBeUndefined();
  });

  it('includes the precision, because money formatting needs it', async () => {
    // A currency without its exponent cannot be rendered correctly.
    const db = makeDb({
      currency: { findMany: stubFn(async () => [{ code: 'JPY', name: 'Yen', minorUnit: 0 }] as unknown[]) },
    });
    const c = await callerFor(db, READ);
    const list = await c.currencies.list();
    expect(db.currency.findMany.mock.calls[0]?.[0]?.select).toMatchObject({ minorUnit: true });
    expect(list[0]).toMatchObject({ code: 'JPY', precision: 0 });
  });
});

describe('jobLevels', () => {
  it('refuses to delete a level somebody is on', async () => {
    /**
     * Every user pointing at it would be left with a dangling reference, and job level
     * feeds per-diem and approval routing.
     */
    const db = makeDb();
    db.user.count.mockResolvedValue(5);
    const c = await callerFor(db, LEVEL_WRITE);
    await expect(c.jobLevels.delete({ id: LEVEL })).rejects.toThrow();
    expect(db.jobLevel.delete).not.toHaveBeenCalled();
  });

  it('deletes an unused level', async () => {
    const db = makeDb();
    const c = await callerFor(db, LEVEL_WRITE);
    await expect(c.jobLevels.delete({ id: LEVEL })).resolves.toEqual({ ok: true });
  });

  it('counts users by the level id', async () => {
    const db = makeDb();
    const c = await callerFor(db, LEVEL_WRITE);
    await c.jobLevels.delete({ id: LEVEL });
    expect(db.user.count.mock.calls[0]?.[0]?.where).toEqual({ jobLevelId: LEVEL });
  });
});

describe('fiscalYears.create', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    label: LABEL,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T00:00:00Z',
    ...over,
  });

  it('refuses a year that ends before or when it starts', async () => {
    const c = await callerFor(makeDb(), FY_WRITE);
    for (const endDate of ['2025-12-31T00:00:00Z', '2026-01-01T00:00:00Z']) {
      await expect(c.fiscalYears.create(input({ endDate }) as never), endDate).rejects.toThrow(
        /endDate must be after startDate/,
      );
    }
  });

  it('clears the previous current year when creating a current one', async () => {
    /**
     * Exactly one current year. Two, and every budget and report lands in whichever
     * one a query happens to find first.
     */
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.create(input({ isCurrent: true }) as never);
    expect(db.fiscalYear.updateMany).toHaveBeenCalledWith({
      where: { isCurrent: true },
      data: { isCurrent: false },
    });
  });

  it('clears nothing when the new year is not current', async () => {
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.create(input() as never);
    expect(db.fiscalYear.updateMany).not.toHaveBeenCalled();
  });

  it('never writes externalIds onto the FiscalYear row', async () => {
    // They live in their own alias table.
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.create(input({ externalIds: { netsuite: 'FY-1' } }) as never);
    expect(db.fiscalYear.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('externalIds');
  });

  it('requires a label in both locales', async () => {
    const c = await callerFor(makeDb(), FY_WRITE);
    await expect(
      c.fiscalYears.create(input({ label: { en: 'FY2026' } }) as never),
    ).rejects.toThrow();
  });
});

describe('fiscalYears.update', () => {
  it('refuses an inverted window when both dates are supplied', async () => {
    const c = await callerFor(makeDb(), FY_WRITE);
    await expect(
      c.fiscalYears.update({
        id: FY,
        patch: { startDate: '2026-06-01T00:00:00Z', endDate: '2026-01-01T00:00:00Z' },
      } as never),
    ).rejects.toThrow(/endDate must be after startDate/);
  });

  it('clears the previous current year when promoting this one', async () => {
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.update({ id: FY, patch: { isCurrent: true } } as never);
    expect(db.fiscalYear.updateMany).toHaveBeenCalledWith({
      where: { isCurrent: true, id: { not: FY } },
      data: { isCurrent: false },
    });
  });

  it('clears nothing when demoting or leaving the flag alone', async () => {
    const demote = makeDb();
    await (await callerFor(demote, FY_WRITE)).fiscalYears.update({
      id: FY,
      patch: { isCurrent: false },
    } as never);
    expect(demote.fiscalYear.updateMany).not.toHaveBeenCalled();

    const untouched = makeDb();
    await (await callerFor(untouched, FY_WRITE)).fiscalYears.update({
      id: FY,
      patch: { closed: true },
    } as never);
    expect(untouched.fiscalYear.updateMany).not.toHaveBeenCalled();
  });
});

describe('fiscalYears.setCurrent', () => {
  it('clears every other year and sets this one', async () => {
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.setCurrent({ id: FY });
    expect(db.fiscalYear.updateMany).toHaveBeenCalledWith({
      where: { isCurrent: true, id: { not: FY } },
      data: { isCurrent: false },
    });
    expect(db.fiscalYear.update).toHaveBeenCalledWith({
      where: { id: FY },
      data: { isCurrent: true },
    });
  });
});

describe('fiscalYears.advanceCurrent', () => {
  it('reports no change when no year covers today', async () => {
    /**
     * A gap in the configured years is a real state — the flag stays where it is rather
     * than being cleared, because "no current fiscal year" is a state most callers do
     * not handle.
     */
    const db = makeDb();
    db.fiscalYear.findFirst.mockResolvedValue(null);
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.advanceCurrent()).resolves.toEqual({
      ok: true,
      changed: false,
      currentId: null,
    });
    expect(db.fiscalYear.update).not.toHaveBeenCalled();
  });

  it('is idempotent when the right year is already current', async () => {
    // It runs on a schedule, so a no-op has to be genuinely no work and say so.
    const db = makeDb();
    db.fiscalYear.findFirst.mockResolvedValue({ id: FY, isCurrent: true });
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.advanceCurrent()).resolves.toEqual({
      ok: true,
      changed: false,
      currentId: FY,
    });
    expect(db.fiscalYear.updateMany).not.toHaveBeenCalled();
    expect(withAuditCalls).toHaveLength(0);
  });

  it('moves the flag when today falls in a different year', async () => {
    const db = makeDb();
    db.fiscalYear.findFirst.mockResolvedValue({ id: FY, isCurrent: false });
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.advanceCurrent()).resolves.toEqual({
      ok: true,
      changed: true,
      currentId: FY,
    });
    expect(db.fiscalYear.updateMany).toHaveBeenCalledWith({
      where: { isCurrent: true, id: { not: FY } },
      data: { isCurrent: false },
    });
  });

  it('matches on an inclusive window around today', async () => {
    // A year's first and last day must both count as inside it.
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.advanceCurrent();
    const where = db.fiscalYear.findFirst.mock.calls[0]?.[0]?.where as {
      startDate: { lte: Date };
      endDate: { gte: Date };
    };
    expect(where.startDate.lte).toBeInstanceOf(Date);
    expect(where.endDate.gte).toBeInstanceOf(Date);
  });

  it('records that the change came from the sweep', async () => {
    // So the trail distinguishes it from an admin clicking Set current.
    const db = makeDb();
    db.fiscalYear.findFirst.mockResolvedValue({ id: FY, isCurrent: false });
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.advanceCurrent();
    expect(withAuditCalls[0]?.details).toEqual({ via: 'advanceCurrent' });
  });
});

describe('fiscalYears.delete', () => {
  it('404s a year that does not exist', async () => {
    const db = makeDb();
    db.fiscalYear.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.delete({ id: FY })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to delete the current year, and says what to do instead', async () => {
    /**
     * Deleting it leaves the singleton flag unset, and an unset current year breaks
     * every budget and reporting read that assumes one.
     */
    const db = makeDb();
    db.fiscalYear.findUnique.mockResolvedValue(fy({ isCurrent: true }));
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.delete({ id: FY })).rejects.toThrow(
      /Set another year current first/,
    );
    expect(db.fiscalYear.delete).not.toHaveBeenCalled();
  });

  it('deletes a non-current year', async () => {
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await expect(c.fiscalYears.delete({ id: FY })).resolves.toEqual({ ok: true });
  });

  it('records which year went', async () => {
    const db = makeDb();
    const c = await callerFor(db, FY_WRITE);
    await c.fiscalYears.delete({ id: FY });
    expect(withAuditCalls[0]?.details).toEqual({ label: LABEL });
  });
});

describe('fiscalYears reads', () => {
  it('lists newest first', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    await c.fiscalYears.list();
    expect(db.fiscalYear.findMany.mock.calls[0]?.[0]?.orderBy).toEqual({ startDate: 'desc' });
  });

  it('returns the current year, or null when none is set', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    await expect(c.fiscalYears.current()).resolves.toBeNull();
    expect(db.fiscalYear.findFirst.mock.calls[0]?.[0]?.where).toEqual({ isCurrent: true });
  });
});

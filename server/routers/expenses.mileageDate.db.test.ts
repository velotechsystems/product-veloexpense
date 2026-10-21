// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Changing an expense's date reprices its mileage lines.
 *
 * A mileage line's rate and year-to-date band are resolved from the expense date when the
 * line is written. Moving the date afterwards left the line priced at a rate that was never
 * in force on the day claimed. Against a real database because the rule lookup, the YTD
 * basis and the transaction that refuses a date with no rate are the behaviour.
 *
 * Its own country code and its own traveller, so no other suite's rates or lines can
 * change the figures.
 *
 * Ported from ExpenseOS 67db2e33 (#578). VeloExpense: the suite's own tenant
 * (`createTenantHarness`), its own mileage category, and the traveller inserted through the
 * superuser pool; every call runs under RLS.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.createOwn,
] as const;
const COUNTRY = 'XR';

describe.skipIf(!process.env.DATABASE_URL)('an expense date change reprices its mileage', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let travellerId: string;
  let reportId: string;
  let expenseId: string;
  let lineId: string;

  /** A single-band rule: `rateMinor` per unit from the first kilometre. */
  const rule = (from: string, to: string | null, rateMinor: number) =>
    db.mileageRate.create({
      data: {
        country: COUNTRY,
        unit: 'KM',
        effectiveFrom: new Date(`${from}T00:00:00Z`),
        effectiveTo: to ? new Date(`${to}T23:59:59Z`) : null,
        tiers: { create: [{ fromDistance: '0', rateMinor: BigInt(rateMinor) }] },
      },
    });

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'mileage-date', name: 'Mileage Date' });
    db = h.db;
    travellerId = (
      await h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, first_name, last_name, country)
         VALUES ($1, 'mileage-date@example.invalid', 'Mile Age', 'Mile', 'Age', $2) RETURNING id`,
        [h.orgId, COUNTRY],
      )
    ).rows[0].id;
    // 50¢/km through June, 80¢/km from July; nothing before 2026.
    await rule('2026-01-01', '2026-06-30', 50);
    await rule('2026-07-01', null, 80);

    caller = h.makeCaller(RW, travellerId);
    reportId = (await caller.create({ title: 'Mileage by date', currency: 'CAD' })).id;
    expenseId = (await caller.createExpense({ reportId })).id;
    await caller.updateExpense({ expenseId, date: '2026-03-10' });

    // VeloExpense: this suite's own mileage category (ExpenseOS reads a seeded one).
    const mileage = await db.expenseCategory.create({
      data: { label: { en: 'Mileage by date' }, isMileage: true },
      select: { id: true },
    });
    lineId = (
      await caller.lineItemCreate({
        expenseId,
        categoryId: mileage.id,
        mileageDistance: '100',
        mileageUnit: 'KM',
      })
    ).id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const lineAmount = async () =>
    (await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } })).amountMinor;

  it('prices the line at the rate in force on the date it was written', async () => {
    expect(await lineAmount()).toBe(5000n); // 100 km × 50¢
  });

  it('reprices the line, and the totals, when the date moves into another rate', async () => {
    await caller.updateExpense({ expenseId, date: '2026-08-15' });
    expect(await lineAmount()).toBe(8000n); // 100 km × 80¢
    const detail = await caller.report({ reportId });
    expect(detail.expenses[0].amountMinor).toBe('8000');
    expect(detail.totalMinor).toBe('8000');
    // The claimed distance is the traveller's and does not move with the date.
    const line = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.mileageDistance.toString()).toBe('100');
  });

  it('refuses a date with no rate in force, and keeps the date and the price it had', async () => {
    await expect(caller.updateExpense({ expenseId, date: '2025-12-31' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.date.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(await lineAmount()).toBe(8000n);
  });

  it('leaves the price alone when the date is resent unchanged', async () => {
    const before = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
    await caller.updateExpense({ expenseId, date: '2026-08-15' });
    const after = await db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

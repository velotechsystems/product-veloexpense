// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Mileage rules: scope, succession and pricing, against a real database.
 *
 * The three properties worth pinning:
 *   · a car-allowance rule and a country default coexist, and the specific one
 *     wins for the person it names;
 *   · creating a rule for a scope SUPERSEDES the incumbent rather than being
 *     refused, closing it at the new start with no gap and no double coverage;
 *   · a trip crossing a band boundary is split per unit.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 *
 * VeloExpense: ExpenseOS's suite, ported with w2-10 — the resolver the mileage write uses
 * (`resolveMileageRule`) against rules made through the ported `policies.mileageRate`
 * router. The harness is VeloExpense's (`createTenantHarness`: the suite's own tenant and
 * people, every call under RLS), so the fixtures are the suite's own and need no cleanup;
 * `test/mileage-rates.db.test.ts` covers the router itself more widely. Adaptations,
 * each marked: a currency is keyed by its code, the mileage category is the suite's own,
 * and "the seeded country defaults" are not here — VeloExpense seeds no mileage rule (an
 * administrator creates them at /admin/mileage-rates).
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const PERMS = [P.config.policyRead, P.config.mileageUpdate] as const;
/** A country no seed uses, so fixtures can't collide with real rules. */
const COUNTRY = 'ZZ';

describe.skipIf(!process.env.DATABASE_URL)('mileage rules (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: any;
  let resolveMileageRule: typeof import('@/server/lib/mileage').resolveMileageRule;
  let userId: string;
  let allowanceUserId: string;

  const band = (from: number, rate: number) => ({ fromDistance: from, rateMinor: String(rate) });

  beforeAll(async () => {
    // VeloExpense: the harness's tenant; the founder administers, and a second person
    // holds the car allowance.
    h = await createTenantHarness({
      slug: 'mileage-rules',
      name: 'Mileage Rules',
      people: [{ email: 'allowance@mileage-rules.test', name: 'Car Allowance' }],
    });
    db = h.db;
    const { policiesRouter } = await import('@/server/routers/policies');
    ({ resolveMileageRule } = await import('@/server/lib/mileage'));
    userId = h.people[0].id;
    allowanceUserId = h.people[1].id;
    caller = h.makeCaller(PERMS, userId, policiesRouter);
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  it('creates a tiered country default', async () => {
    const created = await caller.mileageRate.create({
      country: COUNTRY,
      unit: 'KM',
      effectiveFrom: '2026-01-01',
      tiers: [band(0, 75), band(5000, 73), band(10000, 71)],
      subjectUserIds: [],
    });
    expect(created.id).toBeTruthy();
    const rule = await resolveMileageRule(db, COUNTRY, userId, new Date('2026-06-01'));
    expect(rule?.tiers).toHaveLength(3);
  });

  it('refuses a rule whose opening band does not start at zero', async () => {
    // Otherwise the first kilometres have no rate at all.
    await expect(
      caller.mileageRate.create({
        country: COUNTRY,
        unit: 'KM',
        effectiveFrom: '2026-02-01',
        tiers: [band(100, 75)],
        subjectUserIds: [],
      }),
    ).rejects.toThrow(/must start at 0/i);
  });

  it('lets a car allowance coexist with the country default', async () => {
    await caller.mileageRate.create({
      country: COUNTRY,
      unit: 'KM',
      effectiveFrom: '2026-01-01',
      tiers: [band(0, 90)],
      subjectUserIds: [allowanceUserId],
    });
    // Same country, same dates, different scope — not a collision.
    const forAllowance = await resolveMileageRule(
      db,
      COUNTRY,
      allowanceUserId,
      new Date('2026-06-01'),
    );
    const forEveryoneElse = await resolveMileageRule(db, COUNTRY, userId, new Date('2026-06-01'));
    expect(forAllowance?.tiers[0].rateMinor).toBe(90n);
    expect(forEveryoneElse?.tiers[0].rateMinor).toBe(75n);
  });

  it('supersedes the incumbent instead of refusing the overlap', async () => {
    await caller.mileageRate.create({
      country: COUNTRY,
      unit: 'KM',
      effectiveFrom: '2026-07-01',
      tiers: [band(0, 70)],
      subjectUserIds: [],
    });
    const rules = await db.mileageRate.findMany({
      where: { country: COUNTRY, subjects: { none: {} } },
      orderBy: { effectiveFrom: 'asc' },
      select: { effectiveFrom: true, effectiveTo: true, supersededById: true },
    });
    expect(rules).toHaveLength(2);
    // Closed exactly where the successor starts: no gap, no double coverage.
    expect(rules[0].effectiveTo?.toISOString()).toBe(rules[1].effectiveFrom.toISOString());
    expect(rules[0].supersededById).toBeTruthy();
    expect(rules[1].effectiveTo).toBeNull();

    // And the old rule still prices the period it governed.
    const before = await resolveMileageRule(db, COUNTRY, userId, new Date('2026-06-01'));
    const after = await resolveMileageRule(db, COUNTRY, userId, new Date('2026-08-01'));
    expect(before?.tiers[0].rateMinor).toBe(75n);
    expect(after?.tiers[0].rateMinor).toBe(70n);
  });

  it('refuses a successor that starts before the rule it would replace', async () => {
    // Slotting a rule in behind an existing one is a rewrite of history.
    await expect(
      caller.mileageRate.create({
        country: COUNTRY,
        unit: 'KM',
        effectiveFrom: '2026-03-01',
        tiers: [band(0, 60)],
        subjectUserIds: [],
      }),
    ).rejects.toThrow(/already starts on or after/i);
  });

  it('retires a rule with no successor, after which nothing is in force', async () => {
    const current = await db.mileageRate.findFirstOrThrow({
      where: { country: COUNTRY, subjects: { none: {} }, effectiveTo: null },
      select: { id: true },
    });
    await caller.mileageRate.retire({ id: current.id, effectiveTo: '2026-09-30' });
    const after = await resolveMileageRule(db, COUNTRY, userId, new Date('2026-12-01'));
    // Refused rather than priced at zero — the honest answer.
    expect(after).toBeNull();
  });

  it('refuses to delete a rule that priced a claim', async () => {
    const rule = await db.mileageRate.findFirstOrThrow({
      where: { country: COUNTRY },
      select: { id: true },
    });
    // VeloExpense: the suite's own mileage category, and a currency keyed by its code.
    const category = await db.expenseCategory.create({
      data: { label: { en: 'Rules mileage' }, isMileage: true },
      select: { id: true },
    });
    const currency = { id: 'CAD' };

    const report = await db.expenseReport.create({
      data: {
        title: 'mileage fixture',
        submitterId: userId,
        currencyId: currency.id,
        expenses: {
          create: [{ ownerId: userId, date: new Date(), amountMinor: 0n, currencyId: currency.id }],
        },
      },
      select: { id: true, expenses: { select: { id: true } } },
    });
    await db.expenseLineItem.create({
      data: {
        expenseId: report.expenses[0].id,
        categoryId: category.id,
        amountMinor: 100n,
        mileageDistance: '10',
        mileageUnit: 'KM',
        mileageRateId: rule.id,
      },
    });

    await expect(caller.mileageRate.delete({ id: rule.id })).rejects.toThrow(
      /priced with this rule/i,
    );

    await db.expenseLineItem.deleteMany({ where: { mileageRateId: rule.id } });
    await db.expense.deleteMany({ where: { reportId: report.id } });
    await db.expenseReport.delete({ where: { id: report.id } });
  });

  // VeloExpense: ExpenseOS's "the seeded country defaults" (CA in KM and US in MI, each
  // with exactly one country default in force, and a US claim priced per mile) pin its
  // seed. VeloExpense seeds no mileage rule; a tenant's administrator creates them.
});

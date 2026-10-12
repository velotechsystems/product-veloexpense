import { describe, expect, it } from 'vitest';
import { type PerDiemGroup, type PerDiemRateRow, pickPerDiemRate } from './perdiem';
import { computePerDiemOverageMinor, perDiemOverageBaseMinor } from './perdiem-overage';

const base = {
  categoryId: 'cat-A',
  amountMinor: 27500n,
  firstLastDay: false,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  currencyId: null,
} satisfies Omit<PerDiemRateRow, 'city'>;

const NO_TIER = { jobLevelId: null, legalEntityId: null, businessUnitId: null };

const ctx = {
  placeText: 'New York, NY',
  date: new Date('2026-07-01'),
  categoryId: 'cat-A',
  jobLevelId: 'vp',
  legalEntityId: 'le1',
  businessUnitId: 'bu1',
};

describe('pickPerDiemRate', () => {
  it('matches placeText by substring and returns the rate', () => {
    const r: PerDiemRateRow = { ...base, city: 'New York' };
    expect(pickPerDiemRate([r], ctx)).toBe(r);
  });

  it('returns null when the placeText does not match any city', () => {
    const r: PerDiemRateRow = { ...base, city: 'Chicago' };
    expect(pickPerDiemRate([r], ctx)).toBeNull();
  });

  it('excludes a rate for a different category', () => {
    const other: PerDiemRateRow = { ...base, city: 'New York', categoryId: 'cat-B' };
    expect(pickPerDiemRate([other], ctx)).toBeNull();
  });

  it('prefers the most specific matching rate (more non-null dims)', () => {
    const generic: PerDiemRateRow = { ...base, city: 'New York' };
    const vpRate: PerDiemRateRow = { ...base, city: 'New York', jobLevelId: 'vp' };
    expect(pickPerDiemRate([generic, vpRate], ctx)).toBe(vpRate);
  });

  it('excludes a rate whose non-null dim does not match the context', () => {
    const managerRate: PerDiemRateRow = { ...base, city: 'New York', jobLevelId: 'manager' };
    expect(pickPerDiemRate([managerRate], ctx)).toBeNull();
  });

  it('respects the effective window', () => {
    const future: PerDiemRateRow = {
      ...base,
      city: 'New York',
      effectiveFrom: new Date('2027-01-01'),
    };
    const expired: PerDiemRateRow = {
      ...base,
      city: 'New York',
      effectiveTo: new Date('2026-06-01'),
    };
    expect(pickPerDiemRate([future], ctx)).toBeNull();
    expect(pickPerDiemRate([expired], ctx)).toBeNull();
  });

  it('a null placeText never matches', () => {
    const r: PerDiemRateRow = { ...base, city: 'New York' };
    expect(pickPerDiemRate([r], { ...ctx, placeText: null })).toBeNull();
  });
});

describe('perDiemOverageBaseMinor', () => {
  // The per-category cap resolves to 27500 base minor via the identity converter.
  const rate: PerDiemRateRow = { ...base, city: 'New York' };
  const cap = (r: PerDiemRateRow) => Number(r.amountMinor);
  const group = (dateKey: string, spendBaseMinor: number): PerDiemGroup => ({
    dateKey,
    placeText: 'New York, NY',
    categoryId: 'cat-A',
    spendBaseMinor,
  });

  it('sums the overage of groups that exceed the daily cap', () => {
    const over = perDiemOverageBaseMinor(
      [group('2026-07-01', 30000), group('2026-07-02', 20000), group('2026-07-03', 40000)],
      [rate],
      NO_TIER,
      cap,
    );
    // 30000-27500=2500 ; 20000 under ; 40000-27500=12500 → 15000
    expect(over).toBe(15000);
  });

  it('does not evaluate groups with no matching rate', () => {
    const chicago: PerDiemRateRow = { ...base, city: 'Chicago' };
    expect(perDiemOverageBaseMinor([group('2026-07-01', 99999)], [chicago], NO_TIER, cap)).toBe(0);
  });

  it('halves the cap on the first + last day of a placeText when firstLastDay is set', () => {
    const fld: PerDiemRateRow = { ...rate, firstLastDay: true };
    // cap 27500 → edges use 13750. Day2 (middle) uses full 27500.
    const over = perDiemOverageBaseMinor(
      [group('2026-07-01', 20000), group('2026-07-02', 20000), group('2026-07-03', 20000)],
      [fld],
      NO_TIER,
      cap,
    );
    // edges: 20000-13750=6250 each (×2) ; middle: under 27500 → 0 → 12500
    expect(over).toBe(12500);
  });
});

describe('computePerDiemOverageMinor (shared FX + grouping shell)', () => {
  const rate: PerDiemRateRow = { ...base, city: 'New York' }; // cat-A cap = 27500

  it('groups spend by day+placeText+category, converts, and sums overage', () => {
    const over = computePerDiemOverageMinor({
      expenses: [
        {
          date: new Date('2026-07-01'),
          placeText: 'New York, NY',
          // day1 cat-A = 35000
          lineItems: [
            { amountMinor: 20000n, categoryId: 'cat-A' },
            { amountMinor: 15000n, categoryId: 'cat-A' },
          ],
        },
        {
          date: new Date('2026-07-02'),
          placeText: 'New York, NY',
          lineItems: [{ amountMinor: 10000n, categoryId: 'cat-A' }], // day2 = 10000 (under)
        },
      ],
      reportCurrencyCode: 'USD',
      baseCode: 'USD',
      fxRates: new Map(),
      rates: [rate],
      tier: NO_TIER,
      rateCurrencyCodeById: new Map(),
    });
    expect(over).toBe(7500); // 35000 - 27500
  });

  it('checks each category against its own cap independently (the split)', () => {
    const meals: PerDiemRateRow = {
      ...base,
      city: 'New York',
      categoryId: 'cat-A',
      amountMinor: 27500n,
    };
    const lodging: PerDiemRateRow = {
      ...base,
      city: 'New York',
      categoryId: 'cat-B',
      amountMinor: 10000n,
    };
    const over = computePerDiemOverageMinor({
      expenses: [
        {
          date: new Date('2026-07-01'),
          placeText: 'New York, NY',
          lineItems: [
            { amountMinor: 30000n, categoryId: 'cat-A' }, // over meals cap by 2500
            { amountMinor: 5000n, categoryId: 'cat-B' }, // under lodging cap → 0
          ],
        },
      ],
      reportCurrencyCode: 'USD',
      baseCode: 'USD',
      fxRates: new Map(),
      rates: [meals, lodging],
      tier: NO_TIER,
      rateCurrencyCodeById: new Map(),
    });
    // Combined spend (35000) is under the summed caps (37500), but per-category
    // the meals overage (2500) still surfaces — that's the point of the split.
    expect(over).toBe(2500);
  });

  it('returns 0 when there are no rates', () => {
    const over = computePerDiemOverageMinor({
      expenses: [
        {
          date: new Date('2026-07-01'),
          placeText: 'New York',
          lineItems: [{ amountMinor: 99999n, categoryId: 'cat-A' }],
        },
      ],
      reportCurrencyCode: 'USD',
      baseCode: 'USD',
      fxRates: new Map(),
      rates: [],
      tier: NO_TIER,
      rateCurrencyCodeById: new Map(),
    });
    expect(over).toBe(0);
  });
});

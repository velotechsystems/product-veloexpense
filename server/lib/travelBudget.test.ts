import type { PerDiemRateRow, PerDiemTier } from '@expenseos/approvals';
import { describe, expect, it } from 'vitest';
import { perDiemForCategory, tripDays } from './travelBudget';

const TIER: PerDiemTier = { jobLevelId: null, legalEntityId: null, businessUnitId: null };
const identity = (amountMinor: bigint) => amountMinor;

function rate(over: Partial<PerDiemRateRow> = {}): PerDiemRateRow {
  return {
    city: 'Toronto',
    categoryId: 'cat-meals',
    amountMinor: 7500n,
    firstLastDay: false,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    effectiveTo: null,
    jobLevelId: null,
    legalEntityId: null,
    businessUnitId: null,
    currencyId: null,
    ...over,
  };
}

describe('tripDays', () => {
  it('counts departure and return inclusive — 3 nights is 4 days', () => {
    const days = tripDays(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-04T00:00:00Z'));
    expect(days).toHaveLength(4);
  });

  it('is a single day for a one-way trip', () => {
    expect(tripDays(new Date('2026-09-01T00:00:00Z'), null)).toHaveLength(1);
  });

  it('reads the same calendar dates whatever the clock time', () => {
    // A trip is a range of dates, not a duration. Submitting from Vancouver at
    // 23:00 must not budget a different number of days than submitting from
    // Montréal the same morning.
    const early = tripDays(new Date('2026-09-01T00:30:00Z'), new Date('2026-09-03T23:30:00Z'));
    const late = tripDays(new Date('2026-09-01T23:30:00Z'), new Date('2026-09-03T00:30:00Z'));
    expect(early).toHaveLength(3);
    expect(late).toHaveLength(3);
  });

  it('crosses a month and a leap day without losing one', () => {
    expect(
      tripDays(new Date('2028-02-27T00:00:00Z'), new Date('2028-03-02T00:00:00Z')),
    ).toHaveLength(5);
  });

  it('degrades to the departure day when the return precedes it', () => {
    expect(
      tripDays(new Date('2026-09-04T00:00:00Z'), new Date('2026-09-01T00:00:00Z')),
    ).toHaveLength(1);
  });

  it('caps a nonsense multi-year range instead of iterating it', () => {
    expect(
      tripDays(new Date('2026-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z')).length,
    ).toBe(366);
  });
});

/**
 * The per-diem lookup for ONE category.
 *
 * This replaced `buildPerDiemBudget`, which generated a line for every category with a
 * rate at the destination. The arithmetic it inherited is unchanged and still matters —
 * the day-by-day sum, the mid-trip rate revision, the halved edge days rounding DOWN —
 * so those tests came across intact. What changed is the question: a traveller picks a
 * category, and this answers for that category alone.
 */
describe('perDiemForCategory', () => {
  const base = {
    destinationCity: 'Toronto',
    departDate: new Date('2026-09-01T00:00:00Z'),
    returnDate: new Date('2026-09-04T00:00:00Z'),
    tier: TIER,
    expenseCategoryId: 'cat-meals',
  };

  it('sums the daily allowance across the trip', () => {
    const out = perDiemForCategory({ ...base, rates: [rate()] }, identity);
    expect(out?.amountMinor).toBe(4n * 7500n);
    expect(out?.days).toBe(4);
  });

  it('answers for the ASKED category only', () => {
    // The change from `buildPerDiemBudget`: a lodging rate at the same destination is
    // not this line's business. Summing both would put a hotel in a meals line.
    const out = perDiemForCategory(
      { ...base, rates: [rate(), rate({ categoryId: 'cat-lodging', amountMinor: 22000n })] },
      identity,
    );
    expect(out?.amountMinor).toBe(4n * 7500n);
  });

  it('halves the edge days when the rate says firstLastDay', () => {
    const out = perDiemForCategory({ ...base, rates: [rate({ firstLastDay: true })] }, identity);
    // 3750 + 7500 + 7500 + 3750
    expect(out?.amountMinor).toBe(22500n);
    expect(out?.edgeDaysHalved).toBe(true);
  });

  it('rounds a halved allowance DOWN', () => {
    // Budgeting a cent above what policy permits would approve a trip that then cannot
    // be expensed, so the half-day never rounds up.
    const out = perDiemForCategory(
      {
        ...base,
        returnDate: base.departDate,
        rates: [rate({ firstLastDay: true, amountMinor: 7501n })],
      },
      identity,
    );
    // One day, which is both the first and the last: 7501 / 2 → 3750.
    expect(out?.amountMinor).toBe(3750n);
  });

  it('prices a mid-trip rate revision with BOTH rates', () => {
    // The reason this sums day by day instead of multiplying a nightly figure:
    // 2 days at 7500, then 2 at 9000.
    const out = perDiemForCategory(
      {
        ...base,
        rates: [
          rate({ effectiveTo: new Date('2026-09-03T00:00:00Z') }),
          rate({ amountMinor: 9000n, effectiveFrom: new Date('2026-09-03T00:00:00Z') }),
        ],
      },
      identity,
    );
    expect(out?.amountMinor).toBe(2n * 7500n + 2n * 9000n);
  });

  it('picks the most specific rate for the traveller’s tier', () => {
    const out = perDiemForCategory(
      {
        ...base,
        tier: { jobLevelId: 'lvl-vp', legalEntityId: null, businessUnitId: null },
        rates: [rate(), rate({ jobLevelId: 'lvl-vp', amountMinor: 15000n })],
      },
      identity,
    );
    expect(out?.amountMinor).toBe(4n * 15000n);
  });

  it('converts the rate out of its own currency', () => {
    const out = perDiemForCategory(
      { ...base, rates: [rate({ currencyId: 'cur-usd' })] },
      (amountMinor, currencyId) => (currencyId === 'cur-usd' ? amountMinor * 2n : amountMinor),
    );
    expect(out?.amountMinor).toBe(4n * 15000n);
  });

  it('reports the DAILY rate as well as the total', () => {
    /**
     * A department meal is heads × occurrences × days, not one allowance per day, so it
     * needs the rate rather than the sum. Deriving it by dividing the total would be
     * wrong on any trip with a halved edge day.
     */
    const out = perDiemForCategory({ ...base, rates: [rate({ firstLastDay: true })] }, identity);
    expect(out?.dailyRateMinor).toBe(7500n);
    expect(out?.amountMinor).toBe(22500n);
  });

  it('is null when no rate covers the destination', () => {
    expect(perDiemForCategory({ ...base, rates: [rate({ city: 'Lisbon' })] }, identity)).toBeNull();
  });

  it('is null when no rate covers the CATEGORY', () => {
    expect(
      perDiemForCategory({ ...base, expenseCategoryId: 'cat-airfare', rates: [rate()] }, identity),
    ).toBeNull();
  });

  it('is null when the destination city is unknown', () => {
    // No city means no per-diem match is possible. Nothing is honest; inventing an
    // allowance from an unrelated rate would not be.
    expect(
      perDiemForCategory({ ...base, destinationCity: null, rates: [rate()] }, identity),
    ).toBeNull();
  });

  it('is null when the converted allowance rounds to nothing', () => {
    // "There is no allowance here" and "the allowance is nothing" mean different things
    // to whoever is deciding whether the estimate is complete, so this does not return
    // a zero line.
    expect(perDiemForCategory({ ...base, rates: [rate()] }, () => 0n)).toBeNull();
  });
});

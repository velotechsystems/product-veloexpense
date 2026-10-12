import { describe, expect, it } from 'vitest';
import type { PerDiemRateRow } from './perdiem';
import { computePerDiemOverageMinor, explainPerDiemOverage } from './perdiem-overage';

const rate = (over: Partial<PerDiemRateRow> = {}): PerDiemRateRow => ({
  city: 'Toronto',
  categoryId: 'meals',
  amountMinor: 7500n,
  firstLastDay: false,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  currencyId: null,
  ...over,
});

const input = (over: Partial<Parameters<typeof explainPerDiemOverage>[0]> = {}) => ({
  expenses: [
    {
      date: new Date('2026-07-15T00:00:00Z'),
      placeText: 'Toronto',
      lineItems: [{ amountMinor: 9500n, categoryId: 'meals' }],
    },
  ],
  reportCurrencyCode: 'CAD',
  baseCode: 'CAD',
  fxRates: new Map<string, string>(),
  rates: [rate()],
  tier: { jobLevelId: null, legalEntityId: null, businessUnitId: null },
  rateCurrencyCodeById: new Map<string, string>(),
  ...over,
});

describe('explainPerDiemOverage', () => {
  it('is the one implementation the numeric helper reports', () => {
    // The submitter's warning, the approver's routing and the assistant's explanation all
    // come from here. Three implementations that agree today is not the same property.
    const i = input();
    expect(computePerDiemOverageMinor(i)).toBe(explainPerDiemOverage(i).overageBaseMinor);
  });

  it('reports the cap, the spend and the difference for a group that went over', () => {
    const { overageBaseMinor, groups } = explainPerDiemOverage(input());
    expect(overageBaseMinor).toBe(2000);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      spendBaseMinor: 9500,
      capBaseMinor: 7500,
      overageBaseMinor: 2000,
      halvedForTripEdge: false,
    });
    expect(groups[0].rate?.city).toBe('Toronto');
  });

  it('surfaces the halved trip-edge cap instead of folding it in silently', () => {
    // Somebody comparing "my cap was $37.50" against a $75 admin table concludes the system
    // is wrong. The GSA first/last-day convention is not something a claimant knows.
    const { groups } = explainPerDiemOverage(input({ rates: [rate({ firstLastDay: true })] }));
    expect(groups[0]).toMatchObject({ capBaseMinor: 3750, halvedForTripEdge: true });
  });

  it('leaves a group with no rate unevaluated rather than capping it at zero', () => {
    const { overageBaseMinor, groups } = explainPerDiemOverage(
      input({ rates: [rate({ city: 'Montreal' })] }),
    );
    expect(overageBaseMinor).toBe(0);
    expect(groups[0]).toMatchObject({ rate: null, capBaseMinor: null, overageBaseMinor: 0 });
  });

  it('says WHY no rate applied, in the terms somebody can act on', () => {
    const { groups } = explainPerDiemOverage(input({ rates: [rate({ city: 'Montreal' })] }));
    expect(groups[0].trace.noMatchReason).toBe('CITY_MISMATCH');
  });

  it('reports a rate that exists but is out of the claimant’s reach', () => {
    // The answer that pre-filtering by tier destroys: "there IS a Toronto rate, and it is
    // scoped to a job level you do not have" is actionable; "there is no rate" is not.
    const { groups } = explainPerDiemOverage(input({ rates: [rate({ jobLevelId: 'director' })] }));
    expect(groups[0].rate).toBeNull();
    expect(groups[0].trace.noMatchReason).toBe('SCOPED_OUT_JOB_LEVEL');
  });

  it('groups a day’s spend per category, not per expense', () => {
    // Two dinners on one day in one city are one per-diem group. Evaluating them separately
    // would let somebody stay under the cap twice on the same day.
    const { groups, overageBaseMinor } = explainPerDiemOverage(
      input({
        expenses: [
          {
            date: new Date('2026-07-15T00:00:00Z'),
            placeText: 'Toronto',
            lineItems: [{ amountMinor: 5000n, categoryId: 'meals' }],
          },
          {
            date: new Date('2026-07-15T00:00:00Z'),
            placeText: 'Toronto',
            lineItems: [{ amountMinor: 5000n, categoryId: 'meals' }],
          },
        ],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].spendBaseMinor).toBe(10000);
    expect(overageBaseMinor).toBe(2500);
  });

  it('explains nothing when no rates are configured at all', () => {
    const { overageBaseMinor, groups } = explainPerDiemOverage(input({ rates: [] }));
    expect(overageBaseMinor).toBe(0);
    expect(groups).toEqual([]);
  });
});

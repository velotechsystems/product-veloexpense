import { describe, expect, it } from 'vitest';
import { type PerDiemContext, type PerDiemRateRow, pickPerDiemRate } from './perdiem';
import { explainPerDiemRate } from './perdiem-explain';

/**
 * Each rejection sends somebody somewhere different: retype the place, ask an admin about an
 * expired rate, or accept that policy scoped them out. Reporting the wrong one is worse than
 * reporting nothing, because it costs somebody a trip to the wrong place.
 */

const MEALS = 'cat-meals';
const HOTEL = 'cat-hotel';

const rate = (over: Partial<PerDiemRateRow> = {}): PerDiemRateRow => ({
  city: 'Toronto',
  categoryId: MEALS,
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

const ctx = (over: Partial<PerDiemContext> = {}): PerDiemContext => ({
  placeText: 'Toronto, ON',
  date: new Date('2026-06-01'),
  categoryId: MEALS,
  jobLevelId: 'jl-3',
  legalEntityId: 'le-1',
  businessUnitId: 'bu-1',
  ...over,
});

describe('explainPerDiemRate agrees with the selector', () => {
  it('returns whatever pickPerDiemRate returns', () => {
    // The explanation must never become a second selector — one that drifts would explain a
    // cap that was not the cap actually applied.
    const candidates = [rate(), rate({ city: 'Ottawa' }), rate({ jobLevelId: 'jl-3' })];
    for (const c of [ctx(), ctx({ placeText: 'Ottawa' }), ctx({ categoryId: HOTEL })]) {
      expect(explainPerDiemRate(candidates, c).rate).toBe(pickPerDiemRate(candidates, c));
    }
  });
});

describe('why nothing applied', () => {
  it('reports a city mismatch — the one the claimant can fix', () => {
    const { rate: picked, trace } = explainPerDiemRate([rate({ city: 'Ottawa' })], ctx());
    expect(picked).toBeNull();
    expect(trace.noMatchReason).toBe('CITY_MISMATCH');
  });

  it('reports an expired rate as not-in-effect, not as a city problem', () => {
    const expired = rate({ effectiveTo: new Date('2026-03-01') });
    const { trace } = explainPerDiemRate([expired], ctx());
    expect(trace.noMatchReason).toBe('NOT_IN_EFFECT');
  });

  it('reports a scope exclusion when the claimant simply is not covered', () => {
    const execOnly = rate({ jobLevelId: 'jl-executive' });
    const { trace } = explainPerDiemRate([execOnly], ctx());
    expect(trace.noMatchReason).toBe('SCOPED_OUT_JOB_LEVEL');
  });

  it('prefers the actionable reason when candidates fail differently', () => {
    // A claimant told "you are not an executive" walks away; told "the city did not match"
    // they fix the expense. Both are true; only one is useful.
    const { trace } = explainPerDiemRate(
      [rate({ jobLevelId: 'jl-executive' }), rate({ city: 'Ottawa' })],
      ctx(),
    );
    expect(trace.noMatchReason).toBe('CITY_MISMATCH');
  });

  it('does not blame the city when the rate was for another category', () => {
    // Ordered as the selector tests: a hotel rate is not a failed meal cap.
    const { trace } = explainPerDiemRate([rate({ categoryId: HOTEL })], ctx());
    expect(trace.candidates[0].rejection).toBe('WRONG_CATEGORY');
    expect(trace.noMatchReason).toBe('WRONG_CATEGORY');
  });

  it('says nothing when there were no candidates at all', () => {
    const { trace } = explainPerDiemRate([], ctx());
    expect(trace.matched).toBe(false);
    expect(trace.noMatchReason).toBeNull();
  });

  it('reports no reason when a rate DID apply', () => {
    const { trace } = explainPerDiemRate([rate()], ctx());
    expect(trace.matched).toBe(true);
    expect(trace.noMatchReason).toBeNull();
  });
});

describe('why this rate rather than that one', () => {
  it('attributes a win to specificity', () => {
    const general = rate({ amountMinor: 7500n });
    const scoped = rate({ amountMinor: 9000n, jobLevelId: 'jl-3' });
    const { rate: picked, trace } = explainPerDiemRate([general, scoped], ctx());
    expect(picked?.amountMinor).toBe(9000n);
    expect(trace.wonBy).toBe('specificity');
  });

  it('attributes a win to recency when specificity ties', () => {
    const older = rate({ amountMinor: 7500n, effectiveFrom: new Date('2026-01-01') });
    const newer = rate({ amountMinor: 8000n, effectiveFrom: new Date('2026-05-01') });
    const { rate: picked, trace } = explainPerDiemRate([older, newer], ctx());
    expect(picked?.amountMinor).toBe(8000n);
    expect(trace.wonBy).toBe('recency');
  });

  it('carries every candidate so an answer can show what was on offer', () => {
    const { trace } = explainPerDiemRate([rate(), rate({ city: 'Ottawa' })], ctx());
    expect(trace.candidates).toHaveLength(2);
    expect(trace.candidates.map((c) => c.city)).toEqual(['Toronto', 'Ottawa']);
    expect(trace.candidates[0].rejection).toBeNull();
  });

  it('carries each candidate’s own currency, so the amounts can be read', () => {
    /**
     * `amountMinor` alone is unreadable. Per-diem is scoped by country and each rate is
     * denominated in that country's currency, so a trace can legitimately list a US
     * candidate beside a Canadian one — and reporting bare integers invites reading a USD
     * cap as CAD.
     *
     * The applied rate has always reported its currency; the candidates beside it did not,
     * which is what made those amounts unformattable further downstream. An id rather than
     * a code because this module is pure and has no currency table; the caller resolves it
     * exactly as it already does for the applied rate, and `null` means the org policy
     * currency.
     */
    const usd = 'cur-usd';
    const { trace } = explainPerDiemRate(
      [rate({ city: 'Chicago', currencyId: usd }), rate({ city: 'Toronto', currencyId: null })],
      ctx(),
    );
    expect(trace.candidates.map((c) => c.currencyId)).toEqual([usd, null]);
  });
});

/**
 * VX3-2 — currency conversion and the rate lookup. No database.
 *
 * `lib/money.ts` and `lib/fx/rates.ts` are pure, which is what lets this run
 * without Postgres. The arithmetic is the part of this ticket most likely to be
 * quietly wrong: a threshold comparison that is off by a factor of ten still
 * returns a boolean, and nothing about the result looks unusual.
 */
import { describe, it, expect } from 'vitest';
import {
  convertMinor,
  rateToScaled,
  reciprocalRate,
  scaledRateToString,
  AmountError,
} from '@/lib/money';
import { buildRateLookup, noRates } from '@/lib/fx/rates';

describe('rateToScaled', () => {
  it('scales to 8 decimal places', () => {
    expect(rateToScaled('1.37')).toBe(137000000n);
    expect(rateToScaled('1')).toBe(100000000n);
    expect(rateToScaled('0.00670000')).toBe(670000n);
  });

  it('refuses a rate it cannot represent rather than truncating', () => {
    // Truncating here would silently move every threshold this rate touches.
    expect(() => rateToScaled('1.123456789')).toThrow(AmountError);
  });

  it('refuses nonsense and zero', () => {
    expect(() => rateToScaled('')).toThrow(AmountError);
    expect(() => rateToScaled('abc')).toThrow(AmountError);
    expect(() => rateToScaled('-1.5')).toThrow(AmountError);
    expect(() => rateToScaled('0')).toThrow(AmountError);
    expect(() => rateToScaled('0.00000000')).toThrow(AmountError);
  });
});

describe('convertMinor', () => {
  it('converts between two-decimal currencies', () => {
    // $100.00 USD at 1.35 -> $135.00 CAD
    expect(convertMinor(10000n, '1.35')).toBe(13500n);
  });

  it('rounds half to even, not half up', () => {
    // 1 minor unit at 0.005 is exactly half a unit. Half-up would give 1 both
    // times and drift upward across a report; half-even splits.
    expect(convertMinor(1n, '0.00500000')).toBe(0n);
    expect(convertMinor(3n, '0.00500000')).toBe(0n);
    expect(convertMinor(2n, '0.00500000')).toBe(0n);
    // 100 units at 0.125 = 12.5 -> 12 (even), 300 at 0.125 = 37.5 -> 38 (even)
    expect(convertMinor(100n, '0.12500000')).toBe(12n);
    expect(convertMinor(300n, '0.12500000')).toBe(38n);
  });

  it('respects differing minor units instead of assuming 100', () => {
    // 1000 JPY (0 decimals) at 0.0067 USD/JPY = 6.70 USD = 670 minor units.
    // Assuming two decimals both sides would give 7.
    expect(convertMinor(1000n, '0.00670000', 0, 2)).toBe(670n);
    // And back the other way: 670 USD minor units at 149.25 JPY/USD = 1000 JPY.
    expect(convertMinor(670n, '149.25000000', 2, 0)).toBe(1000n);
  });

  it('is exact on a large amount', () => {
    // A float would already have drifted here. 2^53 cents is well past exact
    // integer representation once multiplied by a rate.
    const huge = 9007199254740993n; // 2^53 + 1
    expect(convertMinor(huge, '2')).toBe(huge * 2n);
  });

  it('handles a negative amount symmetrically', () => {
    expect(convertMinor(-10000n, '1.35')).toBe(-13500n);
  });
});

describe('reciprocalRate', () => {
  it('inverts a rate to 8 places', () => {
    expect(scaledRateToString(reciprocalRate('2'))).toBe('0.5');
    expect(scaledRateToString(reciprocalRate('1.25'))).toBe('0.8');
  });

  it('round-trips within one minor unit on a non-representable inverse', () => {
    // 1/1.35 is 0.740740..., not representable in 8 decimals. The point of this
    // test is to pin how far off a round trip can be — one minor unit — so that a
    // later change producing a bigger error fails here rather than showing up as
    // a threshold that fires one cent early.
    const usdToCad = rateToScaled('1.35');
    const cadToUsd = reciprocalRate(usdToCad);
    const there = convertMinor(10000n, usdToCad);
    const back = convertMinor(there, cadToUsd);
    expect(Number(back - 10000n)).toBeLessThanOrEqual(1);
    expect(Number(back - 10000n)).toBeGreaterThanOrEqual(-1);
  });
});

describe('buildRateLookup', () => {
  const rows = [
    { base: 'USD', quote: 'CAD', rate: '1.35000000', as_of: '2026-01-01' },
    { base: 'USD', quote: 'CAD', rate: '1.40000000', as_of: '2026-06-01' },
  ];

  it('is the identity for a same-currency pair, with no rate needed', () => {
    const hit = noRates().find('CAD', 'CAD');
    expect(hit).toMatchObject({ basis: 'IDENTITY' });
    expect(convertMinor(12345n, hit!.scaled)).toBe(12345n);
  });

  it('takes the latest rate on or before the bound', () => {
    expect(buildRateLookup(rows, '2026-12-31').find('USD', 'CAD')).toMatchObject({
      asOf: '2026-06-01',
      basis: 'DIRECT',
    });
    // A report filed in March is judged against March's rate, so re-validating an
    // old report does not change its findings because the market moved.
    expect(buildRateLookup(rows, '2026-03-15').find('USD', 'CAD')).toMatchObject({
      asOf: '2026-01-01',
    });
  });

  it('returns null when every known rate is in the future', () => {
    expect(buildRateLookup(rows, '2025-01-01').find('USD', 'CAD')).toBeNull();
  });

  it('DERIVES the reverse direction — the PE-7 fix', () => {
    // Only USD->CAD is stored, as a Bank-of-Canada-shaped source would give it.
    // ExpenseOS looks up forward-only and therefore fails every CAD amount for a
    // tenant whose policy currency is USD.
    const lookup = buildRateLookup(rows, '2026-12-31');
    const hit = lookup.find('CAD', 'USD');
    expect(hit).toMatchObject({ basis: 'RECIPROCAL', asOf: '2026-06-01' });
    // 1/1.40 = 0.714285..., so $140.00 CAD is about $100.00 USD.
    expect(convertMinor(14000n, hit!.scaled)).toBe(10000n);
  });

  it('prefers a stored rate over a derived one', () => {
    const lookup = buildRateLookup(
      [...rows, { base: 'CAD', quote: 'USD', rate: '0.71000000', as_of: '2026-06-01' }],
      '2026-12-31',
    );
    expect(lookup.find('CAD', 'USD')).toMatchObject({ basis: 'DIRECT' });
  });

  it('returns null for an unknown pair rather than triangulating', () => {
    // Deliberate: two chained roundings on a threshold comparison, for a pair
    // nobody configured, is a worse answer than "I could not check this".
    const lookup = buildRateLookup(
      [{ base: 'USD', quote: 'CAD', rate: '1.35', as_of: '2026-01-01' }],
      '2026-12-31',
    );
    expect(lookup.find('EUR', 'CAD')).toBeNull();
    expect(lookup.find('EUR', 'JPY')).toBeNull();
  });

  it('lists the pairs it knows, for a diagnostic', () => {
    expect(buildRateLookup(rows, '2026-12-31').pairs()).toEqual(['USD->CAD']);
  });
});

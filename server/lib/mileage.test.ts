import { describe, expect, it } from 'vitest';
import {
  calendarYearBounds,
  computeMileageMinor,
  convertScaled,
  distanceToScaled,
  priceMileage,
} from './mileage';

/** `[fromDistance, rate]` pairs → the scaled tier shape the engine takes. */
const bands = (...pairs: [number, number][]) =>
  pairs.map(([from, rate]) => ({ fromScaled: BigInt(from * 100), rateMinor: BigInt(rate) }));

/** The example from the spec: 0.75 / 0.73 / 0.71 stepping at 5,000 and 10,000. */
const CRA = bands([0, 75], [5000, 73], [10000, 71]);
const km = (v: string) => distanceToScaled(v) as bigint;

describe('distance parsing', () => {
  it('scales to hundredths', () => {
    expect(distanceToScaled('123.45')).toBe(12_345n);
    expect(distanceToScaled('10')).toBe(1_000n);
    expect(distanceToScaled('0.5')).toBe(50n);
  });

  it('rejects anything that isn’t a plain positive decimal', () => {
    for (const bad of ['-1', '1.234', 'abc', '', '1,5']) {
      expect(distanceToScaled(bad)).toBeNull();
    }
  });
});

describe('unit conversion', () => {
  it('is exact in both directions', () => {
    // 100 mi = 160.9344 km, to the hundredth.
    expect(convertScaled(km('100'), 'MI', 'KM')).toBe(16_093n);
    // …and back: 160.93 km is 100.004 mi, which rounds to 100.00.
    expect(convertScaled(km('160.93'), 'KM', 'MI')).toBe(10_000n);
  });

  it('is the identity when the units already match', () => {
    expect(convertScaled(km('42.5'), 'KM', 'KM')).toBe(4_250n);
  });
});

describe('rounding', () => {
  it('rounds half up', () => {
    // 1.005 km × 0.50 = 0.5025 → 50 (round half up on the half-cent).
    expect(computeMileageMinor(101n, 50n)).toBe(51n);
    expect(computeMileageMinor(100n, 50n)).toBe(50n);
  });
});

describe('banded pricing', () => {
  it('prices wholly inside the opening band', () => {
    const r = priceMileage(CRA, 0n, km('100'));
    expect(r.amountMinor).toBe(7_500n);
    expect(r.segments).toHaveLength(1);
  });

  it('SPLITS a trip that crosses a boundary', () => {
    // The case the whole design turns on: 4,900 YTD + 200 km.
    const r = priceMileage(CRA, km('4900'), km('200'));
    expect(r.segments).toEqual([
      { fromDistance: '0.00', rateMinor: '75', distance: '100.00', amountMinor: '7500' },
      { fromDistance: '5000.00', rateMinor: '73', distance: '100.00', amountMinor: '7300' },
    ]);
    expect(r.amountMinor).toBe(14_800n);
  });

  it('spans three bands when the trip is long enough', () => {
    // 4,900 YTD + 6,000 km: 100 at 0.75, 5,000 at 0.73, 900 at 0.71.
    const r = priceMileage(CRA, km('4900'), km('6000'));
    expect(r.segments.map((s) => s.distance)).toEqual(['100.00', '5000.00', '900.00']);
    expect(r.amountMinor).toBe(7_500n + 365_000n + 63_900n);
  });

  it('prices entirely in the top band once past the last threshold', () => {
    const r = priceMileage(CRA, km('12000'), km('50'));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].rateMinor).toBe('71');
    expect(r.amountMinor).toBe(3_550n);
  });

  it('starts exactly on a boundary in the upper band, not the lower', () => {
    // At exactly 5,000 the next kilometre is already the cheaper rate.
    const r = priceMileage(CRA, km('5000'), km('10'));
    expect(r.segments[0].rateMinor).toBe('73');
  });

  it('totals the sum of its own segments', () => {
    // A total that didn't equal its breakdown would be indefensible in a review,
    // so rounding is per segment.
    const r = priceMileage(CRA, km('4999.99'), km('0.02'));
    const summed = r.segments.reduce((a, s) => a + BigInt(s.amountMinor), 0n);
    expect(r.amountMinor).toBe(summed);
  });

  it('handles a flat rule as one band', () => {
    const r = priceMileage(bands([0, 72]), km('9999'), km('10'));
    expect(r.segments).toHaveLength(1);
    expect(r.amountMinor).toBe(720n);
  });

  it('returns nothing for a zero distance rather than a zero-width segment', () => {
    const r = priceMileage(CRA, 0n, 0n);
    expect(r.amountMinor).toBe(0n);
    expect(r.segments).toHaveLength(0);
  });

  it('does not spin on an empty band list', () => {
    const r = priceMileage([], 0n, km('10'));
    expect(r.amountMinor).toBe(0n);
  });
});

describe('calendar year bounds', () => {
  it('brackets the year containing the date, in UTC', () => {
    const { start, end } = calendarYearBounds(new Date('2026-07-31T23:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('puts 1 January inside the year that starts that day', () => {
    const { start } = calendarYearBounds(new Date('2026-01-01T00:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimedMeters, pickClosestRoute } from './closestRoute';

/**
 * The rebuild's pick (FR-8 step 3): the route closest to what the line claims, a tie to
 * the first in Google's order, compared in metres.
 */

const km = (n: number) => ({ totalMeters: n * 1000, name: `${n} km` });

describe('pickClosestRoute', () => {
  it.each([
    // FR-8's acceptance: a stored claim of 412.0 km against 398, 415 and 440 km.
    ['the acceptance case', [398, 415, 440], 412, '415 km'],
    ['the closest when Google lists it last', [440, 398, 415], 412, '415 km'],
    ['an exact match', [398, 412, 440], 412, '412 km'],
    ['the shorter when every route is longer', [500, 450], 412, '450 km'],
    ['the only route there is', [900], 412, '900 km'],
  ])('picks %s', (_label, totals, claimKm, expected) => {
    const routes = totals.map(km);
    expect(pickClosestRoute(routes, claimKm * 1000)?.name).toBe(expected);
  });

  it('gives a tie to the first in Google’s order, whichever that is', () => {
    expect(pickClosestRoute([km(410), km(414)], 412_000)?.name).toBe('410 km');
    expect(pickClosestRoute([km(414), km(410)], 412_000)?.name).toBe('414 km');
  });

  it('compares in metres, not in rounded hundredths', () => {
    // 10.00 mi = 16 093.44 m: 16 095 m is 1.56 m away, 16 090 m is 3.44 m away.
    const routes = [{ totalMeters: 16_090 }, { totalMeters: 16_095 }];
    const claim = claimedMeters({
      mileageDistance: '10.00',
      mileageDistanceOverride: null,
      mileageUnit: 'MI',
    });
    expect(pickClosestRoute(routes, claim)).toBe(routes[1]);
  });

  it('takes the first route when there is no claim, and nothing when there are no routes', () => {
    const routes = [km(440), km(398)];
    expect(pickClosestRoute(routes, null)).toBe(routes[0]);
    expect(pickClosestRoute([], 412_000)).toBeNull();
    expect(pickClosestRoute([], null)).toBeNull();
  });
});

describe('claimedMeters', () => {
  it.each([
    [
      'a KM claim',
      { mileageDistance: '412.00', mileageDistanceOverride: null, mileageUnit: 'KM' },
      412_000,
    ],
    [
      'a MI claim',
      { mileageDistance: '256.00', mileageDistanceOverride: null, mileageUnit: 'MI' },
      256 * 1609.344,
    ],
    // The traveller's correction is what they said they drove.
    [
      'the override over the distance',
      { mileageDistance: '300.00', mileageDistanceOverride: '412.00', mileageUnit: 'KM' },
      412_000,
    ],
    [
      'half a unit',
      { mileageDistance: '0.5', mileageDistanceOverride: null, mileageUnit: 'KM' },
      500,
    ],
    [
      'a missing unit as KM',
      { mileageDistance: '12', mileageDistanceOverride: null, mileageUnit: null },
      12_000,
    ],
  ] as const)('reads %s', (_label, line, expected) => {
    expect(claimedMeters(line)).toBeCloseTo(expected, 6);
  });

  it.each([
    ['no distance', { mileageDistance: null, mileageDistanceOverride: null, mileageUnit: 'KM' }],
    [
      'an empty distance',
      { mileageDistance: ' ', mileageDistanceOverride: null, mileageUnit: 'KM' },
    ],
    [
      'a non-number',
      { mileageDistance: 'twelve', mileageDistanceOverride: null, mileageUnit: 'KM' },
    ],
    ['a negative', { mileageDistance: '-3', mileageDistanceOverride: null, mileageUnit: 'KM' }],
  ] as const)('is null for %s', (_label, line) => {
    expect(claimedMeters(line)).toBeNull();
  });

  it('feeds the pick: the override decides which route is drawn', () => {
    const routes = [km(300), km(415)];
    const claim = claimedMeters({
      mileageDistance: '300.00',
      mileageDistanceOverride: '412.00',
      mileageUnit: 'KM',
    });
    expect(pickClosestRoute(routes, claim)?.name).toBe('415 km');
  });
});

describe('closestRoute.ts', () => {
  it('imports nothing, so any bundle may carry it', () => {
    const source = readFileSync(join(__dirname, 'closestRoute.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

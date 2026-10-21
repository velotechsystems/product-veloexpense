import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RouteValue } from '@/lib/mileageRouteSchema';
import { isLegsDerived, legsMetersOf, useUnitToggle } from './useUnitToggle';

/**
 * Display-only KM/MI on a saved line (operator, 2026-10-16): which lines get it, and that
 * the figures shown are exact restatements of the legs — never a second rounding of the
 * figure on screen, and never a write.
 */

const route = (...meters: number[]): RouteValue => ({
  stops: meters.length
    ? [
        { description: 'A', placeId: 'a' },
        ...meters.map((_, i) => ({ description: `S${i}`, placeId: `s${i}` })),
      ]
    : [],
  legs: meters.map((m, i) => ({
    fromPlaceId: i ? `s${i - 1}` : 'a',
    toPlaceId: `s${i}`,
    meters: m,
  })),
});

describe('legsMetersOf', () => {
  it('totals the legs', () => {
    expect(legsMetersOf(route(10_050, 2_000))).toBe(12_050);
  });

  it('is null for no route, no legs, or a leg that is not a distance', () => {
    expect(legsMetersOf(null)).toBeNull();
    expect(legsMetersOf({ stops: [] })).toBeNull();
    expect(legsMetersOf(route())).toBeNull();
    expect(
      legsMetersOf({
        stops: [],
        legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: Number.NaN }],
      }),
    ).toBeNull();
  });
});

describe('isLegsDerived', () => {
  it.each([
    // The server sends a Decimal's own text: "24.1", not "24.10".
    ['24.1', 'KM', true],
    ['24.10', 'KM', true],
    ['14.98', 'MI', true],
    // An override, or a figure typed beside the route.
    ['25', 'KM', false],
    ['24.11', 'KM', false],
    // No distance, or no unit.
    [null, 'KM', false],
    ['24.10', null, false],
  ] as const)('%s %s on 24 100 m of legs → %s', (distance, unit, expected) => {
    expect(isLegsDerived(route(24_100), distance, unit)).toBe(expected);
  });

  it('is false for a route with no legs, whatever the distance', () => {
    expect(isLegsDerived({ stops: [{ description: 'A' }] }, '10', 'KM')).toBe(false);
  });
});

describe('useUnitToggle', () => {
  it('KM → MI → KM shows the exact figures from the legs, and the stored one on return', () => {
    const { result } = renderHook(() =>
      useUnitToggle({ route: route(10_050), distance: '10.05', unit: 'KM' }),
    );
    expect(result.current.derived).toBe(true);
    expect(result.current.shownDistance).toBe('10.05');

    act(() => result.current.show('MI'));
    // 10 050 m is 6.2447… mi — from the metres, not from 10.05 km.
    expect(result.current.shownUnit).toBe('MI');
    expect(result.current.shownDistance).toBe('6.24');

    act(() => result.current.show('KM'));
    // Back on the stored text itself; 6.24 mi converted back would be 10.04 km.
    expect(result.current.shownDistance).toBe('10.05');
  });

  it('a typed line is not derived: the unit stays the stored one whatever is asked', () => {
    const { result } = renderHook(() =>
      useUnitToggle({ route: route(10_050), distance: '12', unit: 'KM' }),
    );
    expect(result.current.derived).toBe(false);
    act(() => result.current.show('MI'));
    expect(result.current.shownUnit).toBe('KM');
    expect(result.current.shownDistance).toBe('12');
  });
});

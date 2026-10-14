// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveRouteView, MAX_ROUTE_STOPS, MAX_STOP_DESCRIPTION } from './mileageRouteView';

/**
 * What an approver may see of a filed route. Two rules carry the weight:
 *
 *   · **Only stop names leave the server.** The route is parsed against a typed,
 *     capped schema and rebuilt by name; a route that fails the parse is reported as
 *     unavailable rather than trimmed to fit, and nothing here ever throws.
 *   · **The route distance is shown only when it is the route's own and disagrees.**
 *     The legs must chain through exactly the stops' place ids, and the sum must
 *     differ from the claim by more than max(0.01 unit, 0.5 %). Anything else hides
 *     the figure and keeps the stops.
 */

const stop = (placeId: string | undefined, description = `Place ${placeId ?? 'typed'}`) =>
  placeId === undefined ? { description } : { placeId, description };

/** A route the editor would have saved after a lookup: A → B → C, 12 km + 8 km. */
const route = (over: Record<string, unknown> = {}) => ({
  stops: [stop('A'), stop('B'), stop('C')],
  legs: [
    { fromPlaceId: 'A', toPlaceId: 'B', meters: 12_000 },
    { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
  ],
  ...over,
});

const STOPS_OUT = {
  stops: [{ description: 'Place A' }, { description: 'Place B' }, { description: 'Place C' }],
};

describe('deriveRouteView: the trimmed route', () => {
  it('sends stop descriptions only — no place ids, no legs', () => {
    const out = deriveRouteView(route(), 'KM', '15.00');
    expect(out.mileageRoute).toEqual(STOPS_OUT);
    expect(out.mileageRouteUnavailable).toBe(false);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('placeId');
    expect(wire).not.toContain('legs');
    expect(wire).not.toContain('meters');
  });

  it('drops keys it does not know, rather than passing them through', () => {
    const out = deriveRouteView(
      { stops: [{ description: 'A', placeId: 'A', lat: 1 }], legs: [], extra: 'x' },
      'KM',
      null,
    );
    expect(out.mileageRoute).toEqual({ stops: [{ description: 'A' }] });
  });

  it('treats a line with no route as no route, not as an unavailable one', () => {
    expect(deriveRouteView(null, 'KM', '10.00')).toEqual({
      mileageRoute: null,
      routeDistance: null,
      mileageRouteUnavailable: false,
    });
    expect(deriveRouteView(undefined, 'KM', '10.00').mileageRouteUnavailable).toBe(false);
  });

  it(`refuses more than ${MAX_ROUTE_STOPS} stops, and says the route is unavailable`, () => {
    const stops = Array.from({ length: MAX_ROUTE_STOPS + 1 }, (_, i) => stop(`P${i}`));
    expect(deriveRouteView({ stops }, 'KM', '10.00')).toEqual({
      mileageRoute: null,
      routeDistance: null,
      mileageRouteUnavailable: true,
    });
  });

  it(`takes exactly ${MAX_ROUTE_STOPS} stops`, () => {
    const stops = Array.from({ length: MAX_ROUTE_STOPS }, (_, i) => stop(`P${i}`));
    expect(deriveRouteView({ stops }, 'KM', '10.00').mileageRoute?.stops).toHaveLength(
      MAX_ROUTE_STOPS,
    );
  });

  it(`refuses a description over ${MAX_STOP_DESCRIPTION} characters rather than cutting it`, () => {
    const long = 'x'.repeat(MAX_STOP_DESCRIPTION + 1);
    const out = deriveRouteView(route({ stops: [stop('A'), stop('B', long)] }), 'KM', '15.00');
    expect(out).toEqual({ mileageRoute: null, routeDistance: null, mileageRouteUnavailable: true });

    const exact = 'x'.repeat(MAX_STOP_DESCRIPTION);
    expect(deriveRouteView({ stops: [stop('A', exact)] }, 'KM', null).mileageRoute).toEqual({
      stops: [{ description: exact }],
    });
  });

  it.each([
    ['a string', '{"stops": ['],
    ['a number', 42],
    ['an array', [{ description: 'A' }]],
    ['no stops', { legs: [] }],
    ['stops that are not objects', { stops: ['A', 'B'] }],
    ['a description that is not a string', { stops: [{ description: 7 }] }],
    ['a stop with no description', { stops: [{ placeId: 'A' }] }],
  ])('reports %s as unavailable, and does not throw', (_label, stored) => {
    expect(() => deriveRouteView(stored, 'KM', '10.00')).not.toThrow();
    expect(deriveRouteView(stored, 'KM', '10.00')).toEqual({
      mileageRoute: null,
      routeDistance: null,
      mileageRouteUnavailable: true,
    });
  });
});

describe('deriveRouteView: the route distance', () => {
  it('sums the legs in the claim unit: 12 000 m + 8 000 m is 20.00 km and 12.43 mi', () => {
    expect(deriveRouteView(route(), 'KM', '15.00').routeDistance).toBe('20.00');
    expect(deriveRouteView(route(), 'MI', '15.00').routeDistance).toBe('12.43');
  });

  it('hides it when the claim is the route distance', () => {
    expect(deriveRouteView(route(), 'KM', '20.00').routeDistance).toBeNull();
    expect(deriveRouteView(route(), 'KM', '20').routeDistance).toBeNull();
    expect(deriveRouteView(route(), 'MI', '12.43').routeDistance).toBeNull();
  });

  it('hides it within 0.5 % of the route, and shows it just past', () => {
    // 0.5 % of 20.00 is 0.10.
    expect(deriveRouteView(route(), 'KM', '20.10').routeDistance).toBeNull();
    expect(deriveRouteView(route(), 'KM', '19.90').routeDistance).toBeNull();
    expect(deriveRouteView(route(), 'KM', '20.11').routeDistance).toBe('20.00');
    expect(deriveRouteView(route(), 'KM', '19.89').routeDistance).toBe('20.00');
  });

  it('hides it within 0.01 unit on a short route, where 0.5 % is less than that', () => {
    const short = route({
      stops: [stop('A'), stop('B')],
      legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: 1_000 }],
    });
    expect(deriveRouteView(short, 'KM', '1.01').routeDistance).toBeNull();
    expect(deriveRouteView(short, 'KM', '0.99').routeDistance).toBeNull();
    expect(deriveRouteView(short, 'KM', '1.02').routeDistance).toBe('1.00');
  });

  it('hides it without a unit or a claim to compare against, and keeps the stops', () => {
    for (const [unit, claimed] of [
      [null, '15.00'],
      ['KM', null],
      ['KM', 'fifteen'],
    ] as const) {
      const out = deriveRouteView(route(), unit, claimed);
      expect(out.routeDistance).toBeNull();
      expect(out.mileageRoute).toEqual(STOPS_OUT);
    }
  });

  it.each([
    ['missing legs', { legs: undefined }],
    ['empty legs', { legs: [] }],
    ['legs that are not an array', { legs: 'A-B-C' }],
    [
      'legs for other places',
      {
        legs: [
          { fromPlaceId: 'X', toPlaceId: 'Y', meters: 12_000 },
          { fromPlaceId: 'Y', toPlaceId: 'Z', meters: 8_000 },
        ],
      },
    ],
    [
      'a broken chain',
      {
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'B', meters: 12_000 },
          { fromPlaceId: 'A', toPlaceId: 'C', meters: 8_000 },
        ],
      },
    ],
    ['legs for fewer stops', { legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: 12_000 }] }],
    [
      'legs in the wrong order',
      {
        legs: [
          { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
          { fromPlaceId: 'A', toPlaceId: 'B', meters: 12_000 },
        ],
      },
    ],
    [
      'NaN metres',
      {
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'B', meters: Number.NaN },
          { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
        ],
      },
    ],
    [
      'infinite metres',
      {
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'B', meters: Number.POSITIVE_INFINITY },
          { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
        ],
      },
    ],
    [
      'negative metres',
      {
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'B', meters: -12_000 },
          { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
        ],
      },
    ],
    [
      'metres as a string',
      {
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'B', meters: '12000' },
          { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
        ],
      },
    ],
    // A lookup only runs once every stop is a real place, so legs beside a
    // hand-typed stop are not that stop's legs.
    ['a hand-typed stop beside the legs', { stops: [stop('A'), stop(undefined), stop('C')] }],
  ])('treats %s as stale: no route distance, stops still sent', (_label, over) => {
    const out = deriveRouteView(route(over), 'KM', '15.00');
    expect(out.routeDistance).toBeNull();
    expect(out.mileageRouteUnavailable).toBe(false);
    expect(out.mileageRoute?.stops.length).toBeGreaterThan(0);
  });

  it(`reads at most ${MAX_ROUTE_STOPS - 1} legs: the route distance hides past that, the stops stay`, () => {
    const stops = Array.from({ length: MAX_ROUTE_STOPS }, (_, i) => stop(`P${i}`));
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        fromPlaceId: `P${i}`,
        toPlaceId: `P${i + 1}`,
        meters: 1_000,
      }));

    // The longest chain the stop cap allows is read and summed.
    expect(deriveRouteView({ stops, legs: chain(MAX_ROUTE_STOPS - 1) }, 'KM', '10.00')).toEqual({
      mileageRoute: { stops: stops.map((s) => ({ description: s.description })) },
      routeDistance: '24.00',
      mileageRouteUnavailable: false,
    });

    const out = deriveRouteView({ stops, legs: chain(MAX_ROUTE_STOPS) }, 'KM', '10.00');
    expect(out.routeDistance).toBeNull();
    expect(out.mileageRouteUnavailable).toBe(false);
    expect(out.mileageRoute?.stops).toHaveLength(MAX_ROUTE_STOPS);
  });

  it('counts a zero-metre leg (two stops at one place) as fresh', () => {
    const out = deriveRouteView(
      route({
        stops: [stop('A'), stop('A'), stop('B')],
        legs: [
          { fromPlaceId: 'A', toPlaceId: 'A', meters: 0 },
          { fromPlaceId: 'A', toPlaceId: 'B', meters: 5_000 },
        ],
      }),
      'KM',
      '9.00',
    );
    expect(out.routeDistance).toBe('5.00');
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_LEG_METERS,
  MAX_PLACE_ID,
  MAX_ROUTE_LABEL,
  MAX_ROUTE_STOPS,
  MAX_STOP_DESCRIPTION,
  MAX_VIA,
  metersToDistance,
  mileageRouteReadSchema,
  mileageRouteWriteSchema,
  routeChainMeters,
  viaIssue,
} from './mileageRouteSchema';

/**
 * The stored-route contract. Three things carry the weight:
 *
 *   · **Only the parsed route is stored.** The write schema's output is rebuilt by
 *     name: unknown keys (a drawn path) are dropped, and an absent optional field is
 *     an absent key — an empty label never becomes `''` or `null`.
 *   · **Every route the editor ever wrote still saves.** Hand-typed stops, empty
 *     descriptions, routes with or without legs.
 *   · **The module stays browser-safe.** It imports zod and nothing else.
 */

/** A route the editor wrote before routes were chosen: A → B, 12 km. */
const OLD_ROUTE = {
  stops: [
    { description: '100 King St W, Toronto', placeId: 'place-A' },
    { description: '1 Yonge St, Toronto', placeId: 'place-B' },
  ],
  legs: [{ fromPlaceId: 'place-A', toPlaceId: 'place-B', meters: 12_000 }],
};

const write = (route: unknown) => mileageRouteWriteSchema.safeParse(route);
const stored = (route: unknown) => {
  const r = write(route);
  if (!r.success) throw new Error(r.error.message);
  return r.data;
};

describe('the module', () => {
  it('imports zod and nothing else, so the browser can load it', () => {
    const source = readFileSync(new URL('./mileageRouteSchema.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
      .sort();
    expect(specifiers).toEqual(['zod']);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});

describe('mileageRouteWriteSchema: routes already on file', () => {
  it('stores a route the old editor wrote, unchanged', () => {
    expect(stored(OLD_ROUTE)).toEqual(OLD_ROUTE);
  });

  it('takes hand-typed stops with no place id, and empty descriptions', () => {
    const typed = { stops: [{ description: 'Home' }, { description: '' }] };
    expect(stored(typed)).toEqual(typed);
    expect(Object.keys(stored(typed).stops[0] ?? {})).toEqual(['description']);
  });

  it('takes legs that do not chain through the stops: the read side judges them', () => {
    const stale = {
      ...OLD_ROUTE,
      legs: [{ fromPlaceId: 'place-X', toPlaceId: 'place-Y', meters: 1 }],
    };
    expect(stored(stale)).toEqual(stale);
  });

  it(`takes 2 to ${MAX_ROUTE_STOPS} stops and refuses 1 or ${MAX_ROUTE_STOPS + 1}`, () => {
    const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `S${i}` }));
    expect(write({ stops: stops(2) }).success).toBe(true);
    expect(write({ stops: stops(MAX_ROUTE_STOPS) }).success).toBe(true);
    expect(write({ stops: stops(1) }).success).toBe(false);
    expect(write({ stops: stops(MAX_ROUTE_STOPS + 1) }).success).toBe(false);
  });

  it.each([
    ['no stops', { legs: [] }],
    ['a string', '{"stops": ['],
    ['an array', [{ description: 'A' }, { description: 'B' }]],
    ['a stop without a description', { stops: [{ placeId: 'A' }, { description: 'B' }] }],
    ['a non-string description', { stops: [{ description: 7 }, { description: 'B' }] }],
    [
      `a description over ${MAX_STOP_DESCRIPTION} characters`,
      { stops: [{ description: 'x'.repeat(MAX_STOP_DESCRIPTION + 1) }, { description: 'B' }] },
    ],
    ['an empty place id', { stops: [{ description: 'A', placeId: '' }, { description: 'B' }] }],
    [
      `a place id over ${MAX_PLACE_ID} characters`,
      {
        stops: [{ description: 'A', placeId: 'p'.repeat(MAX_PLACE_ID + 1) }, { description: 'B' }],
      },
    ],
    [
      'a control character in a place id',
      { stops: [{ description: 'A', placeId: 'place\nA' }, { description: 'B' }] },
    ],
    ['legs that are not an array', { ...OLD_ROUTE, legs: 'A-B' }],
    ['a leg with no metres', { ...OLD_ROUTE, legs: [{ fromPlaceId: 'A', toPlaceId: 'B' }] }],
    ['negative metres', { ...OLD_ROUTE, legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: -1 }] }],
    [
      'infinite metres',
      {
        ...OLD_ROUTE,
        legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: Number.POSITIVE_INFINITY }],
      },
    ],
    [
      'NaN metres',
      { ...OLD_ROUTE, legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: Number.NaN }] },
    ],
    [
      'a leg longer than the Earth',
      { ...OLD_ROUTE, legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: MAX_LEG_METERS + 1 }] },
    ],
    [
      'metres as a string',
      { ...OLD_ROUTE, legs: [{ fromPlaceId: 'A', toPlaceId: 'B', meters: '12000' }] },
    ],
    [
      `more than ${MAX_ROUTE_STOPS - 1} legs`,
      {
        ...OLD_ROUTE,
        legs: Array.from({ length: MAX_ROUTE_STOPS }, () => ({
          fromPlaceId: 'A',
          toPlaceId: 'B',
          meters: 1,
        })),
      },
    ],
  ])('refuses %s', (_label, route) => {
    expect(write(route).success).toBe(false);
  });

  it('drops keys it does not name, at every level', () => {
    const out = stored({
      ...OLD_ROUTE,
      stops: OLD_ROUTE.stops.map((s) => ({ ...s, lat: 43.6, lng: -79.4 })),
      legs: OLD_ROUTE.legs.map((l) => ({ ...l, durationSeconds: 900 })),
      drawnPath: 'a~l~Fjk~uOwHJy@P',
      extra: { anything: true },
    });
    expect(out).toEqual(OLD_ROUTE);
    const json = JSON.stringify(out);
    for (const key of ['drawnPath', 'lat', 'lng', 'durationSeconds', 'extra']) {
      expect(json).not.toContain(`"${key}"`);
    }
  });
});

describe('mileageRouteWriteSchema: the chosen route', () => {
  const chosen = (over: Record<string, unknown>) => ({ ...OLD_ROUTE, ...over });

  it('stores the label, the position and the count of routes offered', () => {
    expect(stored(chosen({ routeLabel: 'Hwy 401', routeIndex: 1, routeCount: 3 }))).toEqual({
      ...OLD_ROUTE,
      routeLabel: 'Hwy 401',
      routeIndex: 1,
      routeCount: 3,
    });
  });

  it('trims the label', () => {
    expect(stored(chosen({ routeLabel: '  Hwy 401 ' })).routeLabel).toBe('Hwy 401');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['null', null],
  ])('stores no label key at all for a %s label — never "" or null', (_label, routeLabel) => {
    const out = stored(chosen({ routeLabel, routeIndex: 0, routeCount: 1 }));
    expect('routeLabel' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('routeLabel');
  });

  it('leaves out every field it was not given, rather than storing undefined', () => {
    const out = stored(OLD_ROUTE);
    expect(Object.keys(out).sort()).toEqual(['legs', 'stops']);
    expect(Object.keys(stored({ stops: OLD_ROUTE.stops }))).toEqual(['stops']);
  });

  it(`takes a ${MAX_ROUTE_LABEL}-character label and refuses ${MAX_ROUTE_LABEL + 1}`, () => {
    expect(write(chosen({ routeLabel: 'x'.repeat(MAX_ROUTE_LABEL) })).success).toBe(true);
    expect(write(chosen({ routeLabel: 'x'.repeat(MAX_ROUTE_LABEL + 1) })).success).toBe(false);
  });

  it.each([
    ['a label with a line break', { routeLabel: 'via\nHwy 401' }],
    ['a label that is not text', { routeLabel: 401 }],
    ['a position below 0', { routeIndex: -1 }],
    ['a position past the third route', { routeIndex: 3 }],
    ['a fractional position', { routeIndex: 0.5 }],
    ['a count of 0', { routeCount: 0 }],
    ['a count over 3', { routeCount: 4 }],
    ['a null position', { routeIndex: null }],
    ['a position at the count', { routeIndex: 2, routeCount: 2 }],
    ['a position past the count', { routeIndex: 2, routeCount: 1 }],
  ])('refuses %s', (_label, over) => {
    expect(write(chosen(over)).success).toBe(false);
  });

  it('takes a position or a count alone', () => {
    expect(stored(chosen({ routeIndex: 2 })).routeIndex).toBe(2);
    expect(stored(chosen({ routeCount: 1 })).routeCount).toBe(1);
  });
});

describe('mileageRouteReadSchema', () => {
  it.each([
    ['an old route', OLD_ROUTE],
    ['hand-typed stops', { stops: [{ description: 'Home' }, { description: '' }] }],
    ['a chosen route', { ...OLD_ROUTE, routeLabel: 'Hwy 401', routeIndex: 2, routeCount: 3 }],
    ['a label at the cap', { ...OLD_ROUTE, routeLabel: 'x'.repeat(MAX_ROUTE_LABEL) }],
  ])('reads everything the write schema stores: %s', (_label, route) => {
    expect(mileageRouteReadSchema.safeParse(stored(route)).success).toBe(true);
  });

  it('treats a stored "", whitespace or null label as no label', () => {
    for (const routeLabel of ['', '  ', null]) {
      const r = mileageRouteReadSchema.parse({ ...OLD_ROUTE, routeLabel });
      expect(r.routeLabel).toBeUndefined();
    }
  });

  it(`refuses a stored label over ${MAX_ROUTE_LABEL} characters`, () => {
    const r = mileageRouteReadSchema.safeParse({
      ...OLD_ROUTE,
      routeLabel: 'x'.repeat(MAX_ROUTE_LABEL + 1),
    });
    expect(r.success).toBe(false);
  });

  it('drops a stored count that is not 1 to 3, and keeps the route', () => {
    for (const routeCount of [0, 4, 1.5, '3', null]) {
      const r = mileageRouteReadSchema.parse({ ...OLD_ROUTE, routeCount });
      expect(r.routeCount).toBeUndefined();
      expect(r.stops).toHaveLength(2);
    }
  });

  it('reads malformed legs and place ids loosely: they only hide the route distance', () => {
    const r = mileageRouteReadSchema.safeParse({
      stops: [{ description: 'A', placeId: 7 }],
      legs: 'A-B',
    });
    expect(r.success).toBe(true);
  });
});

describe('routeChainMeters', () => {
  const stops = [{ placeId: 'A' }, { placeId: 'B' }, { placeId: 'C' }];
  const legs = [
    { fromPlaceId: 'A', toPlaceId: 'B', meters: 12_000 },
    { fromPlaceId: 'B', toPlaceId: 'C', meters: 8_000 },
  ];

  it('sums a chain through exactly these stops', () => {
    expect(routeChainMeters(stops, legs)).toBe(20_000);
  });

  it('counts a zero-metre leg', () => {
    expect(
      routeChainMeters(
        [{ placeId: 'A' }, { placeId: 'A' }],
        [{ fromPlaceId: 'A', toPlaceId: 'A', meters: 0 }],
      ),
    ).toBe(0);
  });

  it.each([
    ['no legs', undefined],
    ['empty legs', []],
    ['legs that are not an array', 'A-B-C'],
    ['legs for fewer stops', [legs[0]]],
    ['legs in the wrong order', [legs[1], legs[0]]],
    ['a broken chain', [legs[0], { fromPlaceId: 'A', toPlaceId: 'C', meters: 8_000 }]],
    ['negative metres', [{ ...legs[0], meters: -1 }, legs[1]]],
  ])('is null for %s', (_label, given) => {
    expect(routeChainMeters(stops, given)).toBeNull();
  });

  it('is null when a stop has no place id: those legs are not its own', () => {
    expect(routeChainMeters([{ placeId: 'A' }, {}, { placeId: 'C' }], legs)).toBeNull();
  });

  it(`reads at most ${MAX_ROUTE_STOPS - 1} legs`, () => {
    const many = Array.from({ length: MAX_ROUTE_STOPS + 1 }, (_, i) => ({ placeId: `P${i}` }));
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        fromPlaceId: `P${i}`,
        toPlaceId: `P${i + 1}`,
        meters: 1_000,
      }));
    expect(routeChainMeters(many.slice(0, MAX_ROUTE_STOPS), chain(MAX_ROUTE_STOPS - 1))).toBe(
      24_000,
    );
    expect(routeChainMeters(many, chain(MAX_ROUTE_STOPS))).toBeNull();
  });
});

describe('metersToDistance', () => {
  it('converts to the unit the form is showing', () => {
    expect(metersToDistance(45_000, 'KM')).toBe('45.00');
    expect(metersToDistance(1609.344, 'MI')).toBe('1.00');
  });
});

/**
 * The three keys a drawn route used to carry — the path, its lat/lng points and the fetch
 * stamp (ADR 0020). The schema no longer names them, so an older client that still sends
 * them has them dropped silently: never stored, and never the reason a save is refused,
 * however malformed they are (spec FR-1 2.A).
 */
describe('mileageRouteWriteSchema: the keys a drawing used to be stored with', () => {
  const THREE_STOPS = {
    stops: [
      { description: 'A', placeId: 'place-A' },
      { description: 'B', placeId: 'place-B' },
      { description: 'C', placeId: 'place-C' },
    ],
  };
  const OLD_KEYS = ['encodedPolyline', 'passThrough', 'routeFetchedAt'];

  it('drops all three and stores the rest, `via` included', () => {
    const out = stored({
      ...THREE_STOPS,
      encodedPolyline: 'a~l~Fjk~uOwHJy@P',
      passThrough: [{ lat: 43.6532101, lng: -79.3831843, leg: 0 }],
      routeFetchedAt: '2026-10-06T12:00:00.000Z',
      via: [{ placeId: 'road-0', leg: 0 }],
    });
    expect(out).toEqual({ ...THREE_STOPS, via: [{ placeId: 'road-0', leg: 0 }] });
    const json = JSON.stringify(out);
    for (const key of OLD_KEYS) expect(json).not.toContain(key);
    expect(json).not.toMatch(/"lat"|"lng"|43\.65|79\.38/);
  });

  it.each([
    ['a path over any cap and off the charset', { encodedPolyline: `<${'a'.repeat(70_000)}>` }],
    ['points off the globe and out of order', { passThrough: [{ lat: 91, leg: 1 }, { leg: 0 }] }],
    ['more points than the 25 allow', { passThrough: Array.from({ length: 30 }, () => ({})) }],
    ['a stamp that is not a date', { routeFetchedAt: 'yesterday' }],
    ['all three as the wrong types', { encodedPolyline: 7, passThrough: 'x', routeFetchedAt: {} }],
  ])('never refuses a save over %s', (_label, over) => {
    expect(stored({ ...THREE_STOPS, ...over })).toEqual(THREE_STOPS);
  });
});

describe('viaIssue', () => {
  it.each([
    [3, undefined, null],
    [3, [], null],
    [3, [{ leg: 0 }, { leg: 1 }], null],
    [3, [{ leg: 2 }], 'Pass-through points must lie on a leg of the route'],
    [3, [{ leg: 1 }, { leg: 0 }], 'Pass-through points must follow the route order'],
    [MAX_ROUTE_STOPS, [{ leg: 0 }], `A route can have at most ${MAX_ROUTE_STOPS} stops`],
  ])('%i stops, %j → %s', (stopCount, points, issue) => {
    expect(viaIssue(stopCount, points)).toBe(issue);
  });
});

/**
 * `via` — the points a route passes through, kept as Google place IDs (spec FR-1). The
 * place ID is the one Google value its terms let us keep, so these rules are about shape
 * and order only: no coordinate is ever stored, an empty list is no key at all, and a
 * point out of range or out of order refuses the save with the pass-through message.
 */
describe('via', () => {
  /** A → B → C, so a via point may lie on leg 0 or leg 1. */
  const THREE_STOPS = {
    stops: [
      { description: 'A', placeId: 'place-A' },
      { description: 'B', placeId: 'place-B' },
      { description: 'C', placeId: 'place-C' },
    ],
  };
  const v = (leg: number, placeId = `road-${leg}`) => ({ placeId, leg });

  it('stores each point as its place ID and leg, in route order', () => {
    expect(stored({ ...THREE_STOPS, via: [v(0), v(0, 'road-0b'), v(1)] })).toEqual({
      ...THREE_STOPS,
      via: [v(0), v(0, 'road-0b'), v(1)],
    });
  });

  it('stores `via: []` as no key — never `[]` or `null`', () => {
    const out = stored({ ...THREE_STOPS, via: [] });
    expect(out).toEqual(THREE_STOPS);
    expect(Object.keys(out)).toEqual(['stops']);
    expect('via' in out).toBe(false);
  });

  it('adds no `via` key to a route sent without one (a line saved before it existed)', () => {
    expect(Object.keys(stored(OLD_ROUTE)).sort()).toEqual(['legs', 'stops']);
  });

  it('drops a coordinate or anything else riding on a point — only the place ID is kept', () => {
    const out = stored({
      ...THREE_STOPS,
      via: [{ placeId: 'road-0', leg: 0, lat: 43.6532101, lng: -79.3831843, at: { lat: 1 } }],
    });
    expect(out.via).toEqual([v(0)]);
    expect(JSON.stringify(out)).not.toMatch(/lat|lng|43\.65|79\.38/);
  });

  it.each([
    ['an empty place ID', [v(0, '')]],
    ['a place ID with a control character', [v(0, 'road\u0000x')]],
    [`a place ID over ${MAX_PLACE_ID} characters`, [v(0, 'x'.repeat(MAX_PLACE_ID + 1))]],
    ['a point with no place ID', [{ leg: 0 }]],
    ['a point with no leg', [{ placeId: 'road' }]],
    ['a fractional leg', [v(0.5)]],
    ['a negative leg', [v(-1)]],
    ['a leg past the last one (stops - 1)', [v(2)]],
    ['legs out of route order', [v(1), v(0)]],
    ['points that are not an array', v(0)],
  ])('refuses %s', (_label, via) => {
    expect(write({ ...THREE_STOPS, via }).success).toBe(false);
  });

  it('refuses with the pass-through message, on the `via` path', () => {
    const refused = write({ ...THREE_STOPS, via: [v(1), v(0)] });
    expect(refused.success).toBe(false);
    const issue = refused.success ? null : refused.error.issues[0];
    expect(issue?.path).toEqual(['via']);
    expect(issue?.message).toBe('Pass-through points must follow the route order');
  });

  it(`holds stops plus via to ${MAX_ROUTE_STOPS} in all: 25 saves, 26 is refused`, () => {
    const route = (stops: number, points: number) => ({
      stops: Array.from({ length: stops }, (_, i) => ({ description: `S${i}` })),
      via: Array.from({ length: points }, () => v(0)),
    });
    expect(MAX_VIA).toBe(MAX_ROUTE_STOPS - 2);
    expect(write(route(2, MAX_VIA)).success).toBe(true);
    expect(write(route(3, MAX_VIA - 1)).success).toBe(true);
    const refused = write(route(3, MAX_VIA));
    expect(refused.success ? null : refused.error.issues[0]?.path).toEqual(['via']);
    expect(write(route(2, MAX_VIA + 1)).success).toBe(false);
  });

  it('is not read back for an approver: the read schema names no `via`', () => {
    const route = stored({ ...THREE_STOPS, via: [v(0)] });
    expect(mileageRouteReadSchema.parse(route)).not.toHaveProperty('via');
  });
});

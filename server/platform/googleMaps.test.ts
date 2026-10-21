import { afterEach, describe, expect, it, vi } from 'vitest';

// VeloExpense: ExpenseOS mocks `@expenseos/db/secrets-crypto` here for the installation
// branch of `getMapsConfig`, which VeloExpense does not have yet (see googleMaps.ts).

import { MAX_ROUTE_LABEL, mileageRouteWriteSchema } from '@/lib/mileageRouteSchema';
import {
  computeRoutes,
  GoogleMapsHttpError,
  get,
  getBrowserMapsConfig,
  getMapsConfig,
  googleMessage,
  googleStatus,
  isKeyRefusal,
  isRefusedViaPlace,
  isUrlSafePlaceId,
  mapsError,
  mapsRemedy,
  nearestRoad,
  placeForPoint,
  placeLocation,
  post,
  regionCodes,
  reverseGeocode,
  routesBody,
  searchCities,
  searchPlaces,
} from './googleMaps';

/**
 * The Maps client, against a stubbed fetch. What's worth pinning is the request
 * shape — a wrong field mask or a missing session token is a billing mistake that
 * no test failure would otherwise reveal — and that stops are sent in the order
 * they were driven.
 */

const CFG = { apiKey: 'k-123', region: 'CA' };

function stubFetch(json: unknown, ok = true) {
  // VeloExpense: ESLint's no-unused-vars reads the typed parameters (which type
  // `mock.calls`) as unused; Biome allows them in ExpenseOS.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const spy = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The config reader's default argument is `process.env`, so one case stubs it. Nothing
  // in the root setup unstubs envs, and a leaked key would make a later "not configured"
  // assertion pass or fail depending on file order.
  vi.unstubAllEnvs();
});

describe('searchPlaces', () => {
  it('sends the session token and lowercases the region restriction', async () => {
    const spy = stubFetch({
      suggestions: [{ placePrediction: { placeId: 'p1', text: { text: 'Toronto, ON' } } }],
    });
    const out = await searchPlaces(CFG, 'toron', 'tok-1');
    expect(out).toEqual([{ placeId: 'p1', description: 'Toronto, ON' }]);

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    // The session token is what bills a whole typing-then-picking interaction as
    // one autocomplete session instead of one call per keystroke.
    expect(body.sessionToken).toBe('tok-1');
    // CLDR region codes are lowercase, and this field RESTRICTS rather than biases.
    expect(body.includedRegionCodes).toEqual(['ca']);
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('k-123');
    // Autocomplete (New) does not take a field mask; sending one is rejected, and
    // an empty result set was indistinguishable from "no such address".
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).toBeUndefined();
  });

  it('sends NO region restriction when none is configured', async () => {
    const spy = stubFetch({ suggestions: [] });
    await searchPlaces({ apiKey: 'k' }, 'toron', 'tok');
    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    // A restriction nobody asked for is how every address outside one country
    // becomes unfindable.
    expect(body.includedRegionCodes).toBeUndefined();
  });

  it('accepts several countries, because one is rarely the honest answer', async () => {
    const spy = stubFetch({ suggestions: [] });
    await searchPlaces({ apiKey: 'k', region: 'CA, US' }, 'toron', 'tok');
    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    expect(body.includedRegionCodes).toEqual(['ca', 'us']);
  });

  it('drops a suggestion missing either half of its identity', async () => {
    stubFetch({
      suggestions: [
        { placePrediction: { placeId: 'p1' } },
        { placePrediction: { text: { text: 'nowhere' } } },
        { placePrediction: { placeId: 'p2', text: { text: 'Ottawa, ON' } } },
      ],
    });
    expect(await searchPlaces(CFG, 'ott', 'tok')).toEqual([
      { placeId: 'p2', description: 'Ottawa, ON' },
    ]);
  });

  it('surfaces an API error rather than pretending there were no matches', async () => {
    stubFetch({ error: 'nope' }, false);
    await expect(searchPlaces(CFG, 'x', 'tok')).rejects.toThrow(/Google Maps/);
  });
});

/**
 * The lookup behind Calculate (TR-12). What is pinned: the request is the one the
 * claim is about (stops in order, never reordered, traffic ignored), alternatives are
 * asked for only where Google can give them, at most three routes come back, every
 * label is one the stored-route schema accepts, and the drawn path is never logged.
 */
describe('computeRoutes', () => {
  const MASK =
    'routes.description,routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.routeLabels';

  const route = (over: Record<string, unknown> = {}) => ({
    description: 'Hwy 401',
    duration: '3600s',
    polyline: { encodedPolyline: 'enc-path' },
    legs: [{ distanceMeters: 1000 }],
    ...over,
  });

  it('sends the TR-12 field mask and the claim-shaped request', async () => {
    const spy = stubFetch({
      routes: [route({ legs: [{ distanceMeters: 1 }, { distanceMeters: 2 }] })],
    });
    await computeRoutes(CFG, ['a', 'b', 'c']);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    const headers = init.headers as Record<string, string>;
    // Routes bills by field mask: an extra field is a cost nobody decided on.
    expect(headers['X-Goog-FieldMask']).toBe(MASK);
    expect(headers['X-Goog-Api-Key']).toBe('k-123');

    const body = JSON.parse(init.body as string);
    expect(body.origin).toEqual({ placeId: 'a' });
    expect(body.destination).toEqual({ placeId: 'c' });
    expect(body.intermediates).toEqual([{ placeId: 'b' }]);
    expect(body.travelMode).toBe('DRIVE');
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(body.optimizeWaypointOrder).toBe(false);
  });

  it('asks for alternatives on a two-stop trip', async () => {
    const spy = stubFetch({ routes: [] });
    await computeRoutes(CFG, ['a', 'b']);
    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    expect(body.computeAlternativeRoutes).toBe(true);
    expect(body.intermediates).toBeUndefined();
  });

  it('does not ask for alternatives once there is a stop in between', async () => {
    // Google returns no alternatives with intermediate waypoints; the flag could only
    // add cost or a refusal.
    for (const ids of [['a', 'b', 'c'], Array.from({ length: 25 }, (_, i) => `p${i}`)]) {
      const spy = stubFetch({ routes: [] });
      await computeRoutes(CFG, ids);
      const body = JSON.parse(spy.mock.calls[0][1].body as string);
      expect(body).not.toHaveProperty('computeAlternativeRoutes');
    }
  });

  it('returns each route with its legs, total, duration, label and drawn path', async () => {
    stubFetch({
      routes: [
        route({
          description: 'Hwy 401',
          duration: '5400s',
          legs: [{ distanceMeters: 1000 }, { distanceMeters: 2500 }],
          polyline: { encodedPolyline: 'abc' },
        }),
      ],
    });
    expect(await computeRoutes(CFG, ['a', 'b', 'c'])).toEqual([
      {
        index: 0,
        label: 'Hwy 401',
        // Summed from the legs, so the figure picked is the figure stored.
        totalMeters: 3500,
        durationSeconds: 5400,
        legs: [
          { fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 },
          { fromPlaceId: 'b', toPlaceId: 'c', meters: 2500 },
        ],
        encodedPolyline: 'abc',
      },
    ]);
  });

  it('caps the list at three, in Google’s order', async () => {
    stubFetch({
      routes: [1, 2, 3, 4].map((n) =>
        route({ description: `R${n}`, legs: [{ distanceMeters: n }] }),
      ),
    });
    const out = await computeRoutes(CFG, ['a', 'b']);
    expect(out.map((r) => [r.index, r.label, r.totalMeters])).toEqual([
      [0, 'R1', 1],
      [1, 'R2', 2],
      [2, 'R3', 3],
    ]);
  });

  it('returns one, two or three routes as they come', async () => {
    for (const n of [1, 2, 3]) {
      stubFetch({ routes: Array.from({ length: n }, () => route()) });
      expect(await computeRoutes(CFG, ['a', 'b'])).toHaveLength(n);
    }
  });

  it('counts a leg with no distance as 0 m, the way the same-place probe comes back', async () => {
    // proto3 JSON omits a zero.
    stubFetch({ routes: [route({ legs: [{}] })] });
    const [r] = await computeRoutes(CFG, ['p', 'p']);
    expect(r.legs).toEqual([{ fromPlaceId: 'p', toPlaceId: 'p', meters: 0 }]);
    expect(r.totalMeters).toBe(0);
  });

  it('drops a route whose legs do not match the stops, and numbers what is offered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch({
      routes: [
        route({ description: 'first' }),
        route({ description: 'broken', legs: [{ distanceMeters: 1 }, { distanceMeters: 2 }] }),
        route({ description: 'no legs', legs: undefined }),
        route({ description: 'third' }),
      ],
    });
    const out = await computeRoutes(CFG, ['a', 'b']);
    // The index is the position among routes OFFERED, so a pick always stores an
    // index below the count — which the stored-route schema requires.
    expect(out.map((r) => [r.index, r.label])).toEqual([
      [0, 'first'],
      [1, 'third'],
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('is an empty list, not an error, when there is no drivable route', async () => {
    stubFetch({});
    expect(await computeRoutes(CFG, ['a', 'b'])).toEqual([]);
    stubFetch({ routes: [] });
    expect(await computeRoutes(CFG, ['a', 'b'])).toEqual([]);
  });

  it('sends an empty or missing label as null, never as text', async () => {
    for (const description of ['', '   ', undefined, 42]) {
      stubFetch({ routes: [route({ description })] });
      const [r] = await computeRoutes(CFG, ['a', 'b']);
      expect(r.label).toBeNull();
    }
  });

  it('makes every label one the stored-route schema accepts', async () => {
    const long = `${'x'.repeat(MAX_ROUTE_LABEL - 1)}😀tail`;
    stubFetch({
      routes: [
        route({ description: '  via\tHwy\n401  ' }),
        route({ description: long }),
        route({ description: 'y'.repeat(500) }),
      ],
    });
    const out = await computeRoutes(CFG, ['a', 'b']);
    expect(out[0].label).toBe('via Hwy 401');
    // Cut on a code unit boundary would leave half the emoji; it is dropped instead.
    expect(out[1].label).toBe('x'.repeat(MAX_ROUTE_LABEL - 1));
    expect(out[2].label).toHaveLength(MAX_ROUTE_LABEL);
    for (const r of out) {
      const stored = mileageRouteWriteSchema.safeParse({
        stops: [
          { placeId: 'a', description: 'A' },
          { placeId: 'b', description: 'B' },
        ],
        legs: r.legs,
        routeLabel: r.label,
        routeIndex: r.index,
        routeCount: out.length,
      });
      expect(stored.success).toBe(true);
    }
  });

  it('reads the duration as whole seconds, and as null when it is not one', async () => {
    stubFetch({
      routes: [
        route({ duration: '12.6s' }),
        route({ duration: undefined }),
        route({ duration: '5 minutes' }),
      ],
    });
    const out = await computeRoutes(CFG, ['a', 'b']);
    expect(out.map((r) => r.durationSeconds)).toEqual([13, null, null]);
  });

  it('sends a missing drawn path as null', async () => {
    stubFetch({
      routes: [route({ polyline: undefined }), route({ polyline: { encodedPolyline: '' } })],
    });
    const out = await computeRoutes(CFG, ['a', 'b']);
    expect(out.map((r) => r.encodedPolyline)).toEqual([null, null]);
  });

  it('never logs the drawn path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    stubFetch({
      routes: [
        route({ polyline: { encodedPolyline: 'SECRET-PATH-1' } }),
        route({ polyline: { encodedPolyline: 'SECRET-PATH-2' }, legs: [] }),
      ],
    });
    await computeRoutes(CFG, ['a', 'b']);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('SECRET-PATH');
    for (const s of spies) s.mockRestore();
  });

  /**
   * Pass-through points go to Google as `via` waypoints at their place IDs, each on its own
   * leg, in the order they are driven (spec FR-2). A via waypoint starts no leg, so the
   * answer's legs still match the NAMED stops one for one and join their place ids.
   */
  describe('with via points', () => {
    const via = (placeId: string) => ({ placeId, via: true });

    it('interleaves the points between the named stops by leg', async () => {
      const spy = stubFetch({ routes: [] });
      await computeRoutes(
        CFG,
        ['a', 'b', 'c', 'd'],
        [
          { placeId: 'road-1', leg: 0 },
          { placeId: 'road-2', leg: 0 },
          { placeId: 'road-3', leg: 2 },
        ],
      );
      const body = JSON.parse(spy.mock.calls[0][1].body as string);
      expect(body.origin).toEqual({ placeId: 'a' });
      expect(body.destination).toEqual({ placeId: 'd' });
      // a → road-1 → road-2 → b → c → road-3 → d: leg 1 has no point; the destination is
      // not repeated.
      expect(body.intermediates).toEqual([
        via('road-1'),
        via('road-2'),
        { placeId: 'b' },
        { placeId: 'c' },
        via('road-3'),
      ]);
      expect(body.optimizeWaypointOrder).toBe(false);
    });

    it('sends a two-stop trip with a point as a via waypoint, and asks for no alternatives', async () => {
      const spy = stubFetch({ routes: [] });
      await computeRoutes(CFG, ['a', 'b'], [{ placeId: 'road-1', leg: 0 }]);
      const body = JSON.parse(spy.mock.calls[0][1].body as string);
      expect(body.intermediates).toEqual([via('road-1')]);
      // Google returns no alternatives with intermediate waypoints, via ones included.
      expect(body).not.toHaveProperty('computeAlternativeRoutes');
    });

    it('still asks for alternatives with no points at all', async () => {
      const spy = stubFetch({ routes: [] });
      await computeRoutes(CFG, ['a', 'b'], []);
      const body = JSON.parse(spy.mock.calls[0][1].body as string);
      expect(body.computeAlternativeRoutes).toBe(true);
      expect(body).not.toHaveProperty('intermediates');
    });

    it('keeps the field mask: points cost nothing extra to ask for', async () => {
      const spy = stubFetch({ routes: [] });
      await computeRoutes(CFG, ['a', 'b'], [{ placeId: 'road-1', leg: 0 }]);
      expect((spy.mock.calls[0][1].headers as Record<string, string>)['X-Goog-FieldMask']).toBe(
        MASK,
      );
    });

    it('maps the legs to the named stops, however many points there are', async () => {
      stubFetch({
        routes: [route({ legs: [{ distanceMeters: 1000 }, { distanceMeters: 2500 }] })],
      });
      const out = await computeRoutes(
        CFG,
        ['a', 'b', 'c'],
        [
          { placeId: 'road-1', leg: 0 },
          { placeId: 'road-2', leg: 0 },
          { placeId: 'road-3', leg: 1 },
        ],
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.legs).toEqual([
        { fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 },
        { fromPlaceId: 'b', toPlaceId: 'c', meters: 2500 },
      ]);
      expect(out[0]?.totalMeters).toBe(3500);
    });

    it('drops a route with a leg per waypoint rather than per named stop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Five legs for three stops would mean Google split a leg at each point.
      stubFetch({ routes: [route({ legs: [1, 2, 3, 4, 5].map((d) => ({ distanceMeters: d })) })] });
      const out = await computeRoutes(
        CFG,
        ['a', 'b', 'c'],
        [
          { placeId: 'road-secret-1', leg: 0 },
          { placeId: 'road-secret-2', leg: 1 },
        ],
      );
      expect(out).toEqual([]);
      // The warning is counts only — no place ID rides along.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('road-secret');
      warn.mockRestore();
    });

    it('logs nothing about a successful lookup with points', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );
      stubFetch({ routes: [route()] });
      await computeRoutes(CFG, ['a', 'b'], [{ placeId: 'road-1', leg: 0 }]);
      expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
      for (const s of spies) s.mockRestore();
    });
  });

  /**
   * The polyline cap at the source (security A3): a path the line could not store is not
   * offered, but the route still is — its legs price the claim, and the line saves
   * without a map.
   */
  describe('the drawn path’s bounds', () => {
    it.each([
      ['at the 65,536 cap', 'a'.repeat(65_536), 'a'.repeat(65_536)],
      ['one over the cap', 'a'.repeat(65_537), null],
      ['70,000 characters', 'a'.repeat(70_000), null],
      ['outside the polyline charset', 'abc def', null],
      ['with a character below `?`', 'abc>', null],
      ['every character of the charset', '?@AZ[\\]^_`az{|}~', '?@AZ[\\]^_`az{|}~'],
    ])('a path %s is %s', async (_label, encodedPolyline, expected) => {
      stubFetch({ routes: [route({ polyline: { encodedPolyline } })] });
      const [r] = await computeRoutes(CFG, ['a', 'b']);
      expect(r?.encodedPolyline).toBe(expected);
      // Offered either way: the route is still a route.
      expect(r?.legs).toHaveLength(1);
    });
  });

  it('does not call out at all for fewer than two stops', async () => {
    const spy = stubFetch({});
    expect(await computeRoutes(CFG, ['a'])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a Google rejection with its reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ error: { message: 'Routes API has not been used in project 1' } }, false);
    await expect(computeRoutes(CFG, ['a', 'b'])).rejects.toThrow(
      /Enable "Places API \(New\)" and "Routes API"/,
    );
    vi.mocked(console.error).mockRestore();
  });
});

/**
 * The route request body (spec FR-2, TR-13): a dragged point reaches Routes as its place ID
 * and `via: true`, and nothing else. No coordinate — no `latLng`, `latitude`, `longitude`,
 * `lat` or `lng` — appears anywhere in it, whatever else a caller's entry carries.
 */
describe('routesBody', () => {
  const COORDINATE_KEYS = /latLng|latitude|longitude|"lat"|"lng"|location/;

  it('sends every via point as `{ placeId, via: true }` and nothing else', () => {
    const body = routesBody(
      ['a', 'b', 'c'],
      [
        { placeId: 'road-1', leg: 0 },
        { placeId: 'addr-2', leg: 1 },
      ],
    );
    expect(body.intermediates).toEqual([
      { placeId: 'road-1', via: true },
      { placeId: 'b' },
      { placeId: 'addr-2', via: true },
    ]);
    for (const waypoint of body.intermediates ?? []) {
      expect(Object.keys(waypoint).sort()).toEqual(
        'via' in waypoint ? ['placeId', 'via'] : ['placeId'],
      );
    }
  });

  it('carries no coordinate anywhere, even from an entry that has one', () => {
    // A session-only snapped point must never reach Routes, even if a caller forgot to
    // strip it: the waypoint is built by name.
    const leaky = [
      { placeId: 'road-1', leg: 0, lat: 43.6532101, lng: -79.3831843 },
    ] as unknown as Parameters<typeof routesBody>[1];
    const wire = JSON.stringify(routesBody(['a', 'b'], leaky));
    expect(wire).not.toMatch(COORDINATE_KEYS);
    expect(wire).not.toContain('43.65');
    expect(wire).not.toContain('79.38');
  });

  it('is the request computeRoutes sends, with no coordinate on the wire', async () => {
    const spy = stubFetch({ routes: [] });
    await computeRoutes(
      CFG,
      ['a', 'b', 'c'],
      [
        { placeId: 'road-1', leg: 0 },
        { placeId: 'road-2', leg: 1 },
      ],
    );
    const sent = String(spy.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(sent)).toEqual({
      ...routesBody(
        ['a', 'b', 'c'],
        [
          { placeId: 'road-1', leg: 0 },
          { placeId: 'road-2', leg: 1 },
        ],
      ),
    });
    expect(sent).not.toMatch(COORDINATE_KEYS);
  });
});

/**
 * Whether a Google failure may be Routes refusing a `via` place ID (spec TR-13 check 1) —
 * the one failure the modal answers with a Geocoding retry. A key problem, a quota or an
 * outage never is: retrying those would only spend more.
 */
describe('isRefusedViaPlace', () => {
  const http = (status: number, google: string | null, message = 'Google Maps: refused') =>
    new GoogleMapsHttpError(message, status, google);

  it.each([
    ['400 INVALID_ARGUMENT', http(400, 'INVALID_ARGUMENT')],
    ['400 NOT_FOUND', http(400, 'NOT_FOUND')],
    ['404 NOT_FOUND', http(404, 'NOT_FOUND')],
    ['404 INVALID_ARGUMENT', http(404, 'INVALID_ARGUMENT')],
  ])('is a refused place for %s', (_label, err) => {
    expect(isRefusedViaPlace(err)).toBe(true);
  });

  it.each([
    ['403 PERMISSION_DENIED', http(403, 'PERMISSION_DENIED')],
    ['401', http(401, 'UNAUTHENTICATED')],
    ['400 with a bad key', http(400, 'INVALID_ARGUMENT', 'Google Maps 400: API key not valid')],
    ['429', http(429, 'RESOURCE_EXHAUSTED')],
    ['500', http(500, 'INTERNAL')],
    ['400 with no Google status', http(400, null)],
    ['400 FAILED_PRECONDITION', http(400, 'FAILED_PRECONDITION')],
    ['a timeout', new DOMException('This operation was aborted', 'AbortError')],
    ['a plain error', new Error('Google Maps 400: INVALID_ARGUMENT')],
  ])('is not for %s', (_label, err) => {
    expect(isRefusedViaPlace(err)).toBe(false);
  });
});

/**
 * One redaction for every path that turns a Google failure into words. Google's error
 * bodies echo the request, and these messages land in logs and in an admin's browser.
 */
describe('mapsError', () => {
  it('redacts anything key-shaped', () => {
    const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstuvw';
    const out = mapsError(new Error(`Request had invalid key=${key} for project`));
    expect(out).not.toContain(key);
    expect(out).toContain('<redacted>');
  });

  it('keeps the readable sentence around it', () => {
    expect(mapsError(new Error('Google Maps 403: API key not valid — check it'))).toBe(
      'Google Maps 403: API key not valid — check it',
    );
  });

  it('caps a long message', () => {
    expect(mapsError(new Error('word '.repeat(1000)))).toHaveLength(600);
  });

  it('stringifies a non-Error failure', () => {
    expect(mapsError('quota exceeded')).toBe('quota exceeded');
  });

  it('redacts a decimal coordinate Google echoed back', () => {
    const out = mapsError(new Error('Invalid latitude 43.6532101, longitude -79.3831843 at leg 2'));
    expect(out).not.toContain('43.65');
    expect(out).not.toContain('79.38');
    expect(out).toBe('Invalid latitude <redacted>, longitude <redacted> at leg 2');
  });
});

/**
 * A rejected request never puts what was sent, or where, into a log. A body can carry a
 * traveller's chosen coordinates — the fixture below is a coordinate-carrying route body,
 * which `routesBody` itself no longer builds, kept to pin the transport — and Google's
 * error body echoes the request back, so the old "log the body and the response" line
 * would have written a location to the server log on any 4xx. The rejection is logged as endpoint + status +
 * Google's status enum, and thrown as a typed error a caller can classify without parsing.
 */
describe('a rejected request', () => {
  const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
  const LAT = 43.6532101;
  const LNG = -79.3831843;
  const viaBody = {
    origin: { placeId: 'pl-origin-secret' },
    destination: { placeId: 'pl-destination-secret' },
    intermediates: [{ via: true, location: { latLng: { latitude: LAT, longitude: LNG } } }],
    travelMode: 'DRIVE',
  };

  /** A 400 whose body echoes the request, the way Google's error envelope does. */
  function rejectWith(status: number, body: string) {
    const spy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    }));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  function spyConsole() {
    return (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  }

  const echo = JSON.stringify({
    error: {
      code: 400,
      message: `Invalid value at 'intermediates[0].location.lat_lng.latitude' (${LAT}), longitude ${LNG}`,
      status: 'INVALID_ARGUMENT',
      details: [{ request: viaBody }],
    },
  });

  it('logs no coordinate, no place id and no body for a rejected route with a via point', async () => {
    const spies = spyConsole();
    const fetchSpy = rejectWith(400, echo);
    const err = await post(ROUTES, 'k-123', 'routes.legs', viaBody).catch((e: unknown) => e);

    // The via point really was sent — so its absence below is the redaction, not luck.
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain(String(LAT));

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of ['43.65321', '-79.38318', '79.38318', 'pl-origin-secret', 'via']) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain('k-123');
    // What it does log: where, and how it failed.
    expect(logged).toContain('HTTP 400');
    expect(logged).toContain('INVALID_ARGUMENT');
    expect(logged).toContain('routes.googleapis.com');

    // The thrown message is redacted too: callers log it and show it to an admin.
    expect(err).toBeInstanceOf(GoogleMapsHttpError);
    const message = (err as Error).message;
    expect(message).toMatch(/^Google Maps 400: /);
    expect(message).not.toContain('43.65321');
    expect(message).not.toContain('79.38318');
    for (const s of spies) s.mockRestore();
  });

  it('carries the HTTP status and Google’s status enum on the error', async () => {
    const spies = spyConsole();
    rejectWith(404, JSON.stringify({ error: { message: 'Place not found', status: 'NOT_FOUND' } }));
    const err = (await post(ROUTES, 'k', null, viaBody).catch((e: unknown) => e)) as
      | GoogleMapsHttpError
      | undefined;
    expect(err).toBeInstanceOf(GoogleMapsHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err?.name).toBe('GoogleMapsHttpError');
    expect(err?.httpStatus).toBe(404);
    expect(err?.googleStatus).toBe('NOT_FOUND');
    expect(err?.message).toBe('Google Maps 404: Place not found');
    for (const s of spies) s.mockRestore();
  });

  it('types a rejection whose body is not Google’s envelope, with no Google status', async () => {
    const spies = spyConsole();
    rejectWith(503, `upstream connect error near ${LAT},${LNG}`);
    const err = (await post(ROUTES, 'k', null, viaBody).catch((e: unknown) => e)) as
      | GoogleMapsHttpError
      | undefined;
    expect(err?.httpStatus).toBe(503);
    expect(err?.googleStatus).toBeNull();
    expect(err?.message).not.toContain('43.65321');
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain('43.65321');
    for (const s of spies) s.mockRestore();
  });

  it('does not log the request through computeRoutes either', async () => {
    const spies = spyConsole();
    rejectWith(400, echo);
    await expect(computeRoutes(CFG, ['pl-origin-secret', 'pl-destination-secret'])).rejects.toThrow(
      GoogleMapsHttpError,
    );
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('pl-origin-secret');
    expect(logged).not.toContain('43.65321');
    for (const s of spies) s.mockRestore();
  });

  it('does not log what someone typed into address search', async () => {
    const spies = spyConsole();
    rejectWith(400, JSON.stringify({ error: { message: 'bad', status: 'INVALID_ARGUMENT' } }));
    await expect(searchPlaces(CFG, '12 Private Lane', 'tok')).rejects.toThrow(GoogleMapsHttpError);
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain('Private Lane');
    for (const s of spies) s.mockRestore();
  });
});

describe('googleStatus', () => {
  it('reads Google’s status enum', () => {
    expect(googleStatus('{"error":{"status":"PERMISSION_DENIED"}}')).toBe('PERMISSION_DENIED');
  });

  it.each([
    ['not JSON', 'oops'],
    ['no error', '{}'],
    ['no status', '{"error":{"message":"x"}}'],
    ['a non-string status', '{"error":{"status":7}}'],
    ['a status that is not an enum token', '{"error":{"status":"lat 43.65 · INVALID"}}'],
  ])('is null for %s', (_label, body) => {
    expect(googleStatus(body)).toBeNull();
  });
});

describe('regionCodes', () => {
  it('splits, lowercases and de-duplicates what an admin typed', () => {
    expect(regionCodes('CA, US')).toEqual(['ca', 'us']);
    expect(regionCodes('ca us')).toEqual(['ca', 'us']);
    expect(regionCodes('CA;ca')).toEqual(['ca']);
  });

  it('is empty for nothing configured — no restriction at all', () => {
    expect(regionCodes(undefined)).toEqual([]);
    expect(regionCodes('')).toEqual([]);
    expect(regionCodes('   ')).toEqual([]);
  });

  it('drops a malformed code rather than sending it', () => {
    // Google rejects the whole request on one bad code, taking every valid one
    // with it — so "CAN" must not poison "US".
    expect(regionCodes('CAN, US')).toEqual(['us']);
    expect(regionCodes('1, US')).toEqual(['us']);
  });

  it('caps at the 15 codes the API accepts', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + ((i + 1) % 26)),
    ).join(',');
    expect(regionCodes(many)).toHaveLength(15);
  });
});

describe('googleMessage', () => {
  it('pulls the real reason out of Google’s envelope', () => {
    expect(
      googleMessage(JSON.stringify({ error: { message: 'API key not valid', code: 400 } })),
    ).toBe('API key not valid');
  });

  it('returns null for a body it cannot read, so the caller keeps the raw text', () => {
    expect(googleMessage('<html>502</html>')).toBeNull();
    expect(googleMessage(JSON.stringify({ error: {} }))).toBeNull();
  });
});

describe('mapsRemedy', () => {
  it('names the API-restrictions list for a blocked method', () => {
    // The error that actually happened. Google's wording is accurate and says
    // nothing about which of four console settings to change.
    const body = JSON.stringify({
      error: {
        code: 403,
        message:
          'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.',
      },
    });
    const remedy = mapsRemedy(403, body);
    expect(remedy).toMatch(/API restrictions/);
    // The trap that caused it: two separate console entries on one host.
    expect(remedy).toMatch(/SEPARATE entries/);
  });

  it('names enablement when the API was never turned on', () => {
    expect(
      mapsRemedy(403, 'Places API (New) has not been used in project 42 before or it is disabled'),
    ).toMatch(/Enable "Places API \(New\)"/);
  });

  it('explains why a referrer-restricted key can never work server-side', () => {
    const remedy = mapsRemedy(
      403,
      JSON.stringify({ error: { message: 'API keys with referer restrictions cannot be used' } }),
    );
    expect(remedy).toMatch(/server-side call cannot satisfy/);
  });

  it('points at the NAT egress address for an IP restriction', () => {
    expect(mapsRemedy(403, 'Requests from this ip address are blocked')).toMatch(/NAT gateway/);
  });

  it('distinguishes a bad key from a blocked one', () => {
    expect(mapsRemedy(400, JSON.stringify({ error: { message: 'API key not valid' } }))).toMatch(
      /pasted whole/,
    );
  });

  it('covers billing and quota', () => {
    expect(mapsRemedy(403, 'billing must be enabled')).toMatch(/Billing/);
    expect(mapsRemedy(429, 'quota exceeded')).toMatch(/quota/);
  });

  it('returns null when it has nothing useful to add', () => {
    // Better silent than confidently wrong about a cause it doesn't recognise.
    expect(mapsRemedy(500, 'internal error')).toBeNull();
  });

  it('names Roads API and Geocoding API too, so a key blocked for dragging is told what to add', () => {
    const blocked = mapsRemedy(
      403,
      'Requests to this API roads.googleapis.com method x are blocked.',
    );
    expect(blocked).toMatch(/"Roads API" and "Geocoding API"/);
    const disabled = mapsRemedy(403, 'Roads API has not been used in project 42 before');
    expect(disabled).toMatch(/"Roads API" and "Geocoding API"/);
  });

  it('reads Geocoding’s own wording for a disabled API and a bad key', () => {
    expect(mapsRemedy(403, 'This API project is not authorized to use this API.')).toMatch(
      /Enable "Places API \(New\)"/,
    );
    expect(mapsRemedy(403, 'The provided API key is invalid.')).toMatch(/pasted whole/);
  });
});

describe('searchPlaces error message', () => {
  it('carries Google’s reason AND what to do about it', async () => {
    stubFetch(
      {
        error: {
          code: 403,
          message:
            'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.',
        },
      },
      false,
    );
    await expect(searchPlaces(CFG, 'toronto', 'tok')).rejects.toThrow(/API restrictions/);
  });
});

// ── Reading the installation's config ─────────────────────────────────────────

/**
 * Null is a FIRST-CLASS answer here, not an error.
 *
 * The mileage form falls back to typed addresses and a hand-entered distance, so the
 * feature shipped before anybody had procured a key. Which means every "not configured"
 * shape has to return null rather than throw: an exception on this path would take the
 * expense form down for tenants who never asked for Maps at all.
 *
 * Every case passes its environment explicitly. The default is `process.env`, and a
 * developer with a key in `.env.local` is exactly who this fallback is for — leaving it
 * implicit would make "returns null" depend on whose machine ran the suite.
 */
describe('getMapsConfig', () => {
  const db = (installations: unknown[]) =>
    ({
      integration: { findUnique: async () => ({ installations }) },
    }) as never;

  /** apps/web's `ProcessEnv` is Next's augmented interface with no index signature, so a
   *  literal shares no members with it and needs the widening cast. */
  const asEnv = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

  // VeloExpense: ExpenseOS's `BARE` (no key anywhere) is used only by the installation
  // cases, which are not here — see below.
  const ENV = asEnv({ GOOGLE_PLACES_API_KEY: 'env-key' });

  // VeloExpense: ExpenseOS's eight installation cases — reading the key and region off the
  // active installation, preferring it to the environment, asking only for an active one,
  // null when not installed / none active / no key yet, a whitespace key, a trimmed key,
  // an empty region — and "falls through an installation whose key is blank" come back
  // with the integrations screen. The environment cases below are ExpenseOS's.

  it('falls back to GOOGLE_PLACES_API_KEY when nothing is installed', async () => {
    /** The whole reason the fallback exists: a developer and CI have the env var and no
     *  installation row, and without this the city picker answered `available: false`
     *  with nothing to show for it. */
    expect(await getMapsConfig(db([]), ENV)).toEqual({ apiKey: 'env-key' });
    expect(
      await getMapsConfig({ integration: { findUnique: async () => null } } as never, ENV),
    ).toEqual({ apiKey: 'env-key' });
  });

  it('restricts no region when the key came from the environment', async () => {
    /** Region belongs on the installation next to the key. Inheriting one from the shell
     *  would silently make cities outside it unfindable. */
    const cfg = await getMapsConfig(
      db([]),
      // A neighbouring var that must not be mistaken for the region.
      asEnv({ GOOGLE_PLACES_API_KEY: 'env-key', GOOGLE_PLACES_REGION: 'CA' }),
    );
    expect(cfg?.region).toBeUndefined();
  });

  it('trims an env key, which arrives with a newline as often as a pasted one', async () => {
    const cfg = await getMapsConfig(db([]), asEnv({ GOOGLE_PLACES_API_KEY: ' env-key\n' }));
    expect(cfg?.apiKey).toBe('env-key');
  });

  it('reads process.env by default, because that is how every caller calls it', async () => {
    /** Every call site passes only the db. A default that pointed anywhere else would pass
     *  all of the above and still ship the bug. */
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'from-process-env');
    expect(await getMapsConfig(db([]))).toEqual({ apiKey: 'from-process-env' });
  });
});

// ── The browser key ───────────────────────────────────────────────────────────

/**
 * The one key that reaches a browser, and why it has a resolver of its own.
 *
 * `getMapsConfig` falls back to GOOGLE_PLACES_API_KEY — a SERVER key, unrestricted or
 * IP-restricted. If the map key came from the same function, an installation without a
 * browser key would hand that server key to every signed-in browser. So this resolver
 * takes no environment, reads only `browserApiKey`, and every "no" is a null.
 */
/**
 * VeloExpense (eos batch 5): ExpenseOS reads the browser key off the tenant's `google-maps`
 * installation; VeloExpense's keys are platform settings (`server/platform/googleMaps.ts`),
 * so the browser key is `GOOGLE_MAPS_BROWSER_KEY` and the server key `GOOGLE_PLACES_API_KEY`.
 * Every ExpenseOS case is kept, restated over the environment; the one about asking for an
 * ACTIVE installation has no installation to ask for and becomes "reads one variable only".
 */
describe('getBrowserMapsConfig', () => {
  const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv;

  it('reads the browser key off GOOGLE_MAPS_BROWSER_KEY, trimmed', async () => {
    expect(
      await getBrowserMapsConfig(
        null,
        env({ GOOGLE_PLACES_API_KEY: 'srv', GOOGLE_MAPS_BROWSER_KEY: ' brw\n' }),
      ),
    ).toEqual({ browserApiKey: 'brw', region: null });
  });

  it('reads the browser key from that one variable only', async () => {
    /** No other spelling — in particular no `NEXT_PUBLIC_*` one — is read. */
    expect(
      await getBrowserMapsConfig(
        null,
        // Built from parts, so the key-boundary scan (mapsKeyBoundary.test.ts) does not
        // match this file.
        env({ [`${'NEXT_'}PUBLIC_GOOGLE_MAPS_BROWSER_KEY`]: 'pub', GOOGLE_MAPS_KEY: 'other' }),
      ),
    ).toBeNull();
  });

  it('is null — never the server key — when only the server key is set', async () => {
    expect(
      await getBrowserMapsConfig(null, env({ GOOGLE_PLACES_API_KEY: 'srv', GOOGLE_MAPS_REGION: 'CA' })),
    ).toBe(null);
  });

  it('never falls back to GOOGLE_PLACES_API_KEY, so the server key cannot leak through it', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'env-server-key');
    vi.stubEnv('GOOGLE_MAPS_BROWSER_KEY', '');
    try {
      expect(await getBrowserMapsConfig(null)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('treats a blank browser key as no key', async () => {
    for (const browserKey of ['', '   ', '\n']) {
      expect(
        await getBrowserMapsConfig(
          null,
          env({ GOOGLE_PLACES_API_KEY: 'srv', GOOGLE_MAPS_BROWSER_KEY: browserKey }),
        ),
      ).toBe(null);
    }
  });

  it('refuses a browser key that is the server key set twice', async () => {
    /** Returning it would publish the unrestricted server key to every signed-in browser. */
    expect(
      await getBrowserMapsConfig(
        null,
        env({ GOOGLE_PLACES_API_KEY: 'same-key', GOOGLE_MAPS_BROWSER_KEY: ' same-key ' }),
      ),
    ).toBeNull();
  });

  it('returns exactly two fields — nothing else rides along', async () => {
    const out = await getBrowserMapsConfig(
      null,
      env({
        GOOGLE_PLACES_API_KEY: 'srv',
        GOOGLE_MAPS_BROWSER_KEY: 'brw',
        GOOGLE_MAPS_REGION: 'CA',
        EXTRA: 'x',
      }),
    );
    expect(out).toEqual({ browserApiKey: 'brw', region: 'CA' });
    expect(JSON.stringify(out)).not.toContain('srv');
  });

  it('biases the map to a single country only', async () => {
    /** The region is a LIST (it can restrict address search); the map takes one code
     *  that biases it. Several codes → no bias, rather than whichever was typed first. */
    const region = async (r: string) =>
      (
        await getBrowserMapsConfig(
          null,
          env({ GOOGLE_PLACES_API_KEY: 's', GOOGLE_MAPS_BROWSER_KEY: 'b', GOOGLE_MAPS_REGION: r }),
        )
      )?.region;
    expect(await region('ca')).toBe('CA');
    expect(await region(' CA ')).toBe('CA');
    expect(await region('CA, US')).toBeNull();
    expect(await region('CANADA')).toBeNull();
    expect(await region('')).toBeNull();
  });
});

// ── City suggestions ──────────────────────────────────────────────────────────

/**
 * Cities, not addresses — you fly to a city, and per-diem matches on one.
 *
 * The reason this is its own call rather than a filter over `searchPlaces` is the field
 * problem: picking "123 Bloor St W, Toronto, ON, Canada" gives neither a city nor a
 * country without a second, billable Place Details call. `structuredFormat` splits the
 * answer in the response we already paid for.
 */
describe('searchCities', () => {
  it('splits the city out of the structured answer, and the country off the tail', async () => {
    const spy = stubFetch({
      suggestions: [
        {
          placePrediction: {
            placeId: 'c1',
            text: { text: 'Toronto, ON, Canada' },
            structuredFormat: {
              mainText: { text: 'Toronto' },
              secondaryText: { text: 'ON, Canada' },
            },
          },
        },
      ],
    });
    expect(await searchCities(CFG, 'toron', 'tok-1')).toEqual([
      { placeId: 'c1', description: 'Toronto, ON, Canada', city: 'Toronto', country: 'Canada' },
    ]);
    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    // Restricted to localities — plus the coarser level, because Google files a lot of
    // European towns one step down and `locality` alone misses them.
    expect(body.includedPrimaryTypes).toEqual(['locality', 'administrative_area_level_3']);
    expect(body.sessionToken).toBe('tok-1');
  });

  it('falls back to the first segment of the description when there is no structure', async () => {
    /** Parsing the flat description generally would need to know how many administrative
     *  levels a country has; the first segment is the city in every case seen. */
    stubFetch({
      suggestions: [{ placePrediction: { placeId: 'c1', text: { text: 'Halifax, NS, Canada' } } }],
    });
    expect(await searchCities(CFG, 'hali', 'tok')).toEqual([
      { placeId: 'c1', description: 'Halifax, NS, Canada', city: 'Halifax', country: null },
    ]);
  });

  it('reads a one-segment secondary as the country', async () => {
    // A city-state, or a country with no administrative level above the city.
    stubFetch({
      suggestions: [
        {
          placePrediction: {
            placeId: 'c1',
            text: { text: 'Singapore' },
            structuredFormat: {
              mainText: { text: 'Singapore' },
              secondaryText: { text: 'Singapore' },
            },
          },
        },
      ],
    });
    expect((await searchCities(CFG, 'sing', 'tok'))[0].country).toBe('Singapore');
  });

  it('drops a suggestion with no city, which cannot match a per-diem rate', async () => {
    stubFetch({
      suggestions: [
        { placePrediction: { placeId: 'c1', text: { text: '' } } },
        { placePrediction: { text: { text: 'No id, no use' } } },
      ],
    });
    expect(await searchCities(CFG, 'x', 'tok')).toEqual([]);
  });

  it('honours the configured region restriction', async () => {
    const spy = stubFetch({ suggestions: [] });
    await searchCities({ apiKey: 'k', region: 'CA, US' }, 'x', 'tok');
    expect(JSON.parse(spy.mock.calls[0][1].body as string).includedRegionCodes).toEqual([
      'ca',
      'us',
    ]);
  });

  it('sends no restriction when none is configured', async () => {
    const spy = stubFetch({ suggestions: [] });
    await searchCities({ apiKey: 'k' }, 'x', 'tok');
    expect(JSON.parse(spy.mock.calls[0][1].body as string).includedRegionCodes).toBeUndefined();
  });

  it('returns nothing rather than throwing on an empty response', async () => {
    stubFetch({});
    expect(await searchCities(CFG, 'x', 'tok')).toEqual([]);
  });
});

/**
 * The point-to-place clients (spec FR-2, TR-13) and the GET transport under them.
 *
 * Roads and Geocoding put the dropped coordinate AND the server key in the query string,
 * so the rule pinned hardest here is that no URL is ever logged or thrown (security C2).
 * Place Details puts a place ID in the path, so an ID is checked before any URL is built
 * (C1). Every outcome of each Google check the build cannot run live is proven with a
 * stubbed fetch, routed by host.
 */
describe('point to place', () => {
  const KEY = 'AIzaSyD-SERVERKEY-1234567890abcdefghijklm';
  const MAPS = { apiKey: KEY };
  const DROP = { lat: 43.6532101, lng: -79.3831843 };

  type Answer = { status?: number; body: unknown };
  /** A fetch stub that answers by host; an unexpected host fails the test. */
  function stubGoogle(answers: { roads?: Answer; geocode?: Answer; places?: Answer }) {
    const spy = vi.fn(async (url: string, _init: RequestInit) => {
      const host = new URL(url).host;
      const answer =
        host === 'roads.googleapis.com'
          ? answers.roads
          : host === 'maps.googleapis.com'
            ? answers.geocode
            : host === 'places.googleapis.com'
              ? answers.places
              : undefined;
      if (!answer) throw new Error(`unexpected request to ${host}`);
      const status = answer.status ?? 200;
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(text),
        text: async () => text,
      };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }
  const hosts = (spy: ReturnType<typeof stubGoogle>) =>
    spy.mock.calls.map(([url]) => new URL(url).host);

  function spyConsole() {
    return (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  }
  let spies: ReturnType<typeof spyConsole> = [];
  const logged = () => JSON.stringify(spies.flatMap((s) => s.mock.calls));
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  /** Google's error envelope, echoing the request the way it does. */
  const denied = (status: string, message: string) => ({
    error: { message: `${message} (request points=${DROP.lat},${DROP.lng}&key=${KEY})`, status },
  });
  const ROADS_OFF = {
    status: 403,
    body: denied('PERMISSION_DENIED', 'Roads API has not been used in project 42'),
  };
  const GEOCODE_OFF = {
    body: {
      status: 'REQUEST_DENIED',
      error_message: `This API project is not authorized to use this API. key=${KEY}`,
      results: [],
    },
  };
  const road = (placeId: string, lat: number, lng: number) => ({
    location: { latitude: lat, longitude: lng },
    originalIndex: 0,
    placeId,
  });
  const ROAD_FOUND = { body: { snappedPoints: [road('ChIJroad_segment-1', 43.65322, -79.38319)] } };
  const NO_ROAD = { body: {} };
  const ADDRESS = {
    body: {
      status: 'OK',
      results: [
        { place_id: 'ChIJaddress-1', geometry: { location: { lat: 43.6531, lng: -79.3832 } } },
      ],
    },
  };
  const NO_ADDRESS = { body: { status: 'ZERO_RESULTS', results: [] } };

  describe('get', () => {
    it('logs the label and the status — never the URL, the key or the coordinate', async () => {
      spies = spyConsole();
      stubGoogle({ roads: ROADS_OFF });
      const url = `https://roads.googleapis.com/v1/nearestRoads?points=${DROP.lat},${DROP.lng}&key=${KEY}`;
      const err = (await get('Roads nearestRoads', url).catch(
        (e: unknown) => e,
      )) as GoogleMapsHttpError;

      expect(logged()).toContain('Roads nearestRoads rejected: HTTP 403');
      expect(logged()).toContain('PERMISSION_DENIED');
      for (const secret of [KEY, 'nearestRoads?', '43.65321', '79.38318', 'googleapis.com']) {
        expect(logged()).not.toContain(secret);
      }
      // The thrown message is shown to an admin and logged by callers: redacted too.
      expect(err).toBeInstanceOf(GoogleMapsHttpError);
      expect(err.httpStatus).toBe(403);
      for (const secret of [KEY, '43.65321', '79.38318']) expect(err.message).not.toContain(secret);
    });

    it('rethrows a failure with no answer as the label and the error type only, with no cause', async () => {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${DROP.lat},${DROP.lng}&key=${KEY}`;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError(`fetch failed for ${url}`, { cause: new Error(url) });
        }),
      );
      const err = (await get('Geocoding reverse', url).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe('Google Maps Geocoding reverse request failed: TypeError');
      expect(err.cause).toBeUndefined();
      expect(JSON.stringify(err)).not.toContain(KEY);
    });

    it('sends the key and the field mask as headers when given', async () => {
      const spy = stubGoogle({ places: { body: {} } });
      await get('Places details', 'https://places.googleapis.com/v1/places/abc', {
        apiKey: 'k-1',
        fieldMask: 'location',
      });
      expect(spy.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        headers: { 'X-Goog-Api-Key': 'k-1', 'X-Goog-FieldMask': 'location' },
      });
    });
  });

  describe('nearestRoad (Roads API)', () => {
    it('asks nearestRoads for the one point, with the key as a parameter', async () => {
      const spy = stubGoogle({ roads: ROAD_FOUND });
      await nearestRoad(MAPS, DROP);
      const url = new URL(spy.mock.calls[0]?.[0] as string);
      expect(`${url.origin}${url.pathname}`).toBe('https://roads.googleapis.com/v1/nearestRoads');
      expect(url.searchParams.get('points')).toBe('43.6532101,-79.3831843');
      expect(url.searchParams.get('key')).toBe(KEY);
    });

    it('answers the road segment’s place ID and its snapped point', async () => {
      stubGoogle({ roads: ROAD_FOUND });
      expect(await nearestRoad(MAPS, DROP)).toEqual({
        placeId: 'ChIJroad_segment-1',
        location: { lat: 43.65322, lng: -79.38319 },
      });
    });

    it('takes the snapped point nearest the drop, not the first one', async () => {
      stubGoogle({
        roads: {
          body: {
            snappedPoints: [
              road('far', 43.66, -79.39),
              road('near', 43.65321, -79.38318),
              road('mid', 43.654, -79.384),
            ],
          },
        },
      });
      expect((await nearestRoad(MAPS, DROP))?.placeId).toBe('near');
    });

    it('is null when Roads found no road near the point', async () => {
      stubGoogle({ roads: NO_ROAD });
      expect(await nearestRoad(MAPS, DROP)).toBeNull();
    });

    it('skips a point whose place ID could not go back into a URL, or that has no location', async () => {
      stubGoogle({
        roads: {
          body: {
            snappedPoints: [road('../x', 43.65321, -79.38318), { placeId: 'ok-but-nowhere' }],
          },
        },
      });
      expect(await nearestRoad(MAPS, DROP)).toBeNull();
    });
  });

  describe('reverseGeocode (Geocoding API)', () => {
    it('asks for the nearest street address or road, with the key as a parameter', async () => {
      const spy = stubGoogle({ geocode: ADDRESS });
      expect(await reverseGeocode(MAPS, DROP)).toEqual({
        placeId: 'ChIJaddress-1',
        location: { lat: 43.6531, lng: -79.3832 },
      });
      const url = new URL(spy.mock.calls[0]?.[0] as string);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://maps.googleapis.com/maps/api/geocode/json',
      );
      expect(url.searchParams.get('latlng')).toBe('43.6532101,-79.3831843');
      expect(url.searchParams.get('result_type')).toBe('street_address|route');
      expect(url.searchParams.get('key')).toBe(KEY);
    });

    it('is null for ZERO_RESULTS', async () => {
      stubGoogle({ geocode: NO_ADDRESS });
      expect(await reverseGeocode(MAPS, DROP)).toBeNull();
    });

    it('turns a REQUEST_DENIED body into a key refusal, redacted and logged without the key', async () => {
      spies = spyConsole();
      stubGoogle({ geocode: GEOCODE_OFF });
      const err = await reverseGeocode(MAPS, DROP).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleMapsHttpError);
      expect(isKeyRefusal(err)).toBe(true);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).toMatch(/Enable "Places API \(New\)"/);
      expect(logged()).toContain('REQUEST_DENIED');
      expect(logged()).not.toContain(KEY);
      expect(logged()).not.toContain('43.65321');
    });

    it('treats OVER_QUERY_LIMIT as a failure that may pass, not a refusal', async () => {
      spies = spyConsole();
      stubGoogle({ geocode: { body: { status: 'OVER_QUERY_LIMIT', results: [] } } });
      const err = await reverseGeocode(MAPS, DROP).catch((e: unknown) => e);
      expect((err as GoogleMapsHttpError).httpStatus).toBe(429);
      expect(isKeyRefusal(err)).toBe(false);
    });
  });

  describe('placeLocation (Place Details, spec TR-13 check 2)', () => {
    it('asks for the location alone, the ID encoded into the path, the key in a header', async () => {
      const spy = stubGoogle({
        places: { body: { location: { latitude: 43.65, longitude: -79.38 } } },
      });
      expect(await placeLocation(MAPS, 'ChIJroad_segment-1')).toEqual({ lat: 43.65, lng: -79.38 });
      expect(spy.mock.calls[0]?.[0]).toBe(
        'https://places.googleapis.com/v1/places/ChIJroad_segment-1',
      );
      expect(spy.mock.calls[0]?.[1]).toMatchObject({
        headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'location' },
      });
    });

    it.each([
      ['..', '..'],
      ['a slash', 'a/b'],
      ['a query', 'a?fields=*'],
      ['an encoded dot-dot', '%2e%2e'],
      ['a traversal', 'ok/../../v1'],
      ['an empty ID', ''],
      ['a space', 'a b'],
      ['over 500 characters', 'x'.repeat(501)],
    ])('makes no request at all for %s, and places nothing (C1)', async (_label, placeId) => {
      const spy = stubGoogle({});
      expect(await placeLocation(MAPS, placeId)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('is null when Google does not resolve the ID — a road segment it cannot place', async () => {
      spies = spyConsole();
      stubGoogle({
        places: { status: 404, body: { error: { message: 'Not found', status: 'NOT_FOUND' } } },
      });
      expect(await placeLocation(MAPS, 'ChIJroad_segment-1')).toBeNull();
      stubGoogle({
        places: { status: 400, body: { error: { message: 'bad id', status: 'INVALID_ARGUMENT' } } },
      });
      expect(await placeLocation(MAPS, 'ChIJroad_segment-1')).toBeNull();
    });

    it('is null when Google answers without a location', async () => {
      stubGoogle({ places: { body: {} } });
      expect(await placeLocation(MAPS, 'ChIJx')).toBeNull();
    });

    it('throws a key refusal or a server failure for the caller to report', async () => {
      spies = spyConsole();
      stubGoogle({ places: { status: 403, body: denied('PERMISSION_DENIED', 'blocked') } });
      await expect(placeLocation(MAPS, 'ChIJx')).rejects.toBeInstanceOf(GoogleMapsHttpError);
      stubGoogle({ places: { status: 503, body: 'unavailable' } });
      await expect(placeLocation(MAPS, 'ChIJx')).rejects.toBeInstanceOf(GoogleMapsHttpError);
    });
  });

  describe('placeForPoint: Roads first, then Geocoding', () => {
    it('uses the road segment when Roads finds one, and asks nothing else', async () => {
      const spy = stubGoogle({ roads: ROAD_FOUND });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toEqual({
        kind: 'found',
        source: 'roads',
        placeId: 'ChIJroad_segment-1',
        location: { lat: 43.65322, lng: -79.38319 },
      });
      expect(hosts(spy)).toEqual(['roads.googleapis.com']);
    });

    it('falls back to Geocoding when Roads refuses the key', async () => {
      spies = spyConsole();
      const spy = stubGoogle({ roads: ROADS_OFF, geocode: ADDRESS });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toMatchObject({
        kind: 'found',
        source: 'geocoding',
        placeId: 'ChIJaddress-1',
      });
      expect(hosts(spy)).toEqual(['roads.googleapis.com', 'maps.googleapis.com']);
    });

    it('falls back to Geocoding when Roads finds no road', async () => {
      stubGoogle({ roads: NO_ROAD, geocode: ADDRESS });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toMatchObject({ source: 'geocoding' });
    });

    it('is `none` when there is no road and no address', async () => {
      stubGoogle({ roads: NO_ROAD, geocode: NO_ADDRESS });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toEqual({ kind: 'none' });
      spies = spyConsole();
      stubGoogle({ roads: ROADS_OFF, geocode: NO_ADDRESS });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toEqual({ kind: 'none' });
    });

    it('is `none` when Roads answered no road and Geocoding refused — Roads is the authority', async () => {
      spies = spyConsole();
      stubGoogle({ roads: NO_ROAD, geocode: GEOCODE_OFF });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toEqual({ kind: 'none' });
    });

    it('names both APIs when both refuse the key', async () => {
      spies = spyConsole();
      stubGoogle({ roads: ROADS_OFF, geocode: GEOCODE_OFF });
      expect(await placeForPoint(MAPS, DROP, 'auto')).toEqual({
        kind: 'refused',
        apis: ['Roads API', 'Geocoding API'],
      });
    });

    it('does not fall back on a Roads failure that may pass: it is thrown, Geocoding is not asked (C6)', async () => {
      spies = spyConsole();
      const spy = stubGoogle({ roads: { status: 503, body: 'backend error' }, geocode: ADDRESS });
      await expect(placeForPoint(MAPS, DROP, 'auto')).rejects.toBeInstanceOf(GoogleMapsHttpError);
      expect(hosts(spy)).toEqual(['roads.googleapis.com']);
    });

    it('throws a Geocoding failure that may pass after Roads refused', async () => {
      spies = spyConsole();
      stubGoogle({ roads: ROADS_OFF, geocode: { body: { status: 'UNKNOWN_ERROR' } } });
      await expect(placeForPoint(MAPS, DROP, 'auto')).rejects.toBeInstanceOf(GoogleMapsHttpError);
    });

    describe("method 'geocoding' — the retry when Routes refused a road-segment ID (TR-13 check 1)", () => {
      it('skips Roads and answers the address', async () => {
        const spy = stubGoogle({ roads: ROAD_FOUND, geocode: ADDRESS });
        expect(await placeForPoint(MAPS, DROP, 'geocoding')).toMatchObject({
          kind: 'found',
          source: 'geocoding',
          placeId: 'ChIJaddress-1',
        });
        expect(hosts(spy)).toEqual(['maps.googleapis.com']);
      });

      it('names only Geocoding when it refuses', async () => {
        spies = spyConsole();
        stubGoogle({ geocode: GEOCODE_OFF });
        expect(await placeForPoint(MAPS, DROP, 'geocoding')).toEqual({
          kind: 'refused',
          apis: ['Geocoding API'],
        });
      });
    });

    it('takes injected clients, so the rule can be checked without a fetch at all', async () => {
      const refused = new GoogleMapsHttpError('Google Maps 403: off', 403, 'PERMISSION_DENIED');
      const clients = {
        nearestRoad: vi.fn(async () => {
          throw refused;
        }),
        reverseGeocode: vi.fn(async () => ({ placeId: 'g', location: { lat: 1, lng: 2 } })),
      };
      expect(await placeForPoint(MAPS, DROP, 'auto', clients)).toMatchObject({
        source: 'geocoding',
      });
      expect(clients.reverseGeocode).toHaveBeenCalledTimes(1);
    });

    it('logs no key and no coordinate on any path', async () => {
      spies = spyConsole();
      stubGoogle({ roads: ROADS_OFF, geocode: GEOCODE_OFF });
      await placeForPoint(MAPS, DROP, 'auto');
      stubGoogle({ roads: { status: 500, body: JSON.stringify(denied('INTERNAL', 'boom')) } });
      await placeForPoint(MAPS, DROP, 'auto').catch(() => {});
      expect(logged()).not.toContain(KEY);
      for (const c of ['43.65321', '79.38318', '43.6532101']) expect(logged()).not.toContain(c);
    });
  });

  describe('isUrlSafePlaceId', () => {
    it('takes Google’s URL-safe alphabet and nothing else', () => {
      expect(isUrlSafePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(true);
      expect(isUrlSafePlaceId('GhIJQWDl0CIeQUARxks3icF8U8A')).toBe(true);
      for (const bad of ['..', 'a/b', 'a.b', 'a%2e', '', 'x'.repeat(501), 42, null]) {
        expect(isUrlSafePlaceId(bad)).toBe(false);
      }
    });
  });
});

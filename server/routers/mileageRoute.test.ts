// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The `mileageRoute` router's unit cases — ExpenseOS's `smallRouters.test.ts` (67db2e33),
 * its `mileageRoute` describe and the mocks it needs.
 *
 * VeloExpense (eos batch 5): ExpenseOS keeps four small routers in one file; VeloExpense's
 * `pickers` and `notifications` are tested elsewhere, so only the mileage half is carried,
 * unchanged.
 *
 *   · **Mileage degrades rather than blocking.** A failed address lookup returns the
 *     reason instead of an empty list: an empty list made a rejected API call look
 *     identical to "no such address", so a misconfigured key read as every address in
 *     North America having vanished.
 */

// VeloExpense: the session is `@/auth` (ExpenseOS: `@/server/auth`).
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({
  resolveRbacUser: vi.fn(),
  invalidateRolePermissions: stubFn(async () => {}),
}));

const getMapsConfig = stubFn(async () => ({ apiKey: 'k' }) as unknown);
const getBrowserMapsConfig = stubFn(async () => null as unknown);
const searchPlaces = stubFn(async () => [{ placeId: 'p1', description: 'Toronto, ON' }]);
const computeRoutes = stubFn(async () => [] as unknown[]);
const placeForPoint = stubFn(async () => ({ kind: 'none' }) as unknown);
const placeLocation = stubFn(async () => null as { lat: number; lng: number } | null);
const metersToDistance = stubFn(() => ({ value: 1, unit: 'KM' }));
vi.mock('@/server/platform/googleMaps', async () => {
  // The redaction stays real: what reaches the log is the thing under test.
  const actual = await vi.importActual<typeof import('@/server/platform/googleMaps')>(
    '@/server/platform/googleMaps',
  );
  return {
    getMapsConfig,
    getBrowserMapsConfig,
    searchPlaces,
    computeRoutes,
    placeForPoint,
    placeLocation,
    // Real: which IDs may go into a Google URL (C1) is the thing under test.
    isUrlSafePlaceId: actual.isUrlSafePlaceId,
    mapsError: actual.mapsError,
    // Real: which Google failure is a refused `via` place ID is the thing under test.
    isRefusedViaPlace: actual.isRefusedViaPlace,
    isUnroutableWaypoint: actual.isUnroutableWaypoint,
    metersToDistance,
  };
});

/**
 * The route-lookup limit runs the REAL fixed-window `throttle` against an in-memory
 * counter (its injectable seam), so "the 61st press is refused" is the limiter's own
 * arithmetic rather than a stub's. `throttleCalls` records what the router asked for.
 */
const limiter = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as unknown[][],
}));
vi.mock('@/server/lib/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/server/lib/rateLimit')>('@/server/lib/rateLimit');
  const counter = {
    async incr(key: string) {
      const next = (limiter.counts.get(key) ?? 0) + 1;
      limiter.counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async ttl() {
      return 1800;
    },
  };
  return {
    ...actual,
    throttle: async (key: string, cfg: { max: number; windowSec: number }) => {
      limiter.calls.push([key, cfg]);
      return actual.throttle(key, cfg, counter);
    },
  };
});

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');

async function caller(
  routerName: string,
  db: unknown,
  permissions: readonly string[] = [],
  userId: string = ME,
) {
  const { createCallerFactory } = await import('@/server/trpc');
  const mod = await import(`./${routerName}`);
  const router = Object.values(mod).find(
    (v) => v && typeof v === 'object' && '_def' in (v as object),
  );
  return createCallerFactory(router as never)(makeContext({ db, userId, permissions })) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMapsConfig.mockResolvedValue({ apiKey: 'k' });
  getBrowserMapsConfig.mockResolvedValue(null);
  searchPlaces.mockResolvedValue([{ placeId: 'p1', description: 'Toronto, ON' }]);
  computeRoutes.mockResolvedValue([]);
  placeForPoint.mockResolvedValue({ kind: 'none' });
  placeLocation.mockResolvedValue(null);
  metersToDistance.mockReturnValue({ value: 1, unit: 'KM' });
  limiter.counts.clear();
  limiter.calls.length = 0;
});

describe('mileageRoute', () => {
  const db = () => ({});

  it('is gated on editing an expense, not on an admin permission', async () => {
    // Filling in a mileage line is not an admin surface.
    const c = (await caller('mileageRoute', db(), [])) as { status: () => Promise<unknown> };
    await expect(c.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports availability from the integration config', async () => {
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      status: () => Promise<{ available: boolean; mapAvailable: boolean }>;
    };
    await expect(c.status()).resolves.toEqual({ available: true, mapAvailable: false });
    getMapsConfig.mockResolvedValue(null);
    await expect(c.status()).resolves.toEqual({ available: false, mapAvailable: false });
  });

  describe('the browser key (TR-15, NFR-8)', () => {
    const SERVER_KEY = 'AIzaSERVER-key-000000000000000000000000';
    const BROWSER_KEY = 'AIzaBROWSER-key-11111111111111111111111';
    type MapCaller = {
      status: () => Promise<{ available: boolean; mapAvailable: boolean }>;
      mapConfig: () => Promise<{ browserApiKey: string | null; region: string | null }>;
    };
    const mine = async () =>
      (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as MapCaller;

    it('says the map is available only with lookup on AND a browser key set', async () => {
      // The three configurations of TR-15: no server key, server key only, both.
      const c = await mine();
      getMapsConfig.mockResolvedValue({ apiKey: SERVER_KEY });
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: BROWSER_KEY, region: 'CA' });
      await expect(c.status()).resolves.toEqual({ available: true, mapAvailable: true });

      getBrowserMapsConfig.mockResolvedValue(null);
      await expect(c.status()).resolves.toEqual({ available: true, mapAvailable: false });

      // A browser key with no lookup has no picker to draw in.
      getMapsConfig.mockResolvedValue(null);
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: BROWSER_KEY, region: 'CA' });
      await expect(c.status()).resolves.toEqual({ available: false, mapAvailable: false });
    });

    it('status carries booleans only — no key of either kind', async () => {
      getMapsConfig.mockResolvedValue({ apiKey: SERVER_KEY, region: 'CA' });
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: BROWSER_KEY, region: 'CA' });
      const out = JSON.stringify(await (await mine()).status());
      expect(out).not.toContain(SERVER_KEY);
      expect(out).not.toContain(BROWSER_KEY);
    });

    it('mapConfig returns exactly the browser key and the region, rebuilt', async () => {
      getMapsConfig.mockResolvedValue({ apiKey: SERVER_KEY, region: 'CA, US' });
      // Extra fields on the resolver's answer must not ride along to the browser.
      getBrowserMapsConfig.mockResolvedValue({
        browserApiKey: BROWSER_KEY,
        region: 'CA',
        apiKey: SERVER_KEY,
      });
      const out = await (await mine()).mapConfig();
      expect(out).toEqual({ browserApiKey: BROWSER_KEY, region: 'CA' });
      expect(Object.keys(out)).toEqual(['browserApiKey', 'region']);
      expect(JSON.stringify(out)).not.toContain(SERVER_KEY);
    });

    it('never returns the server key in place of a missing browser key — even an env-only one', async () => {
      /**
       * `getMapsConfig` falls back to GOOGLE_PLACES_API_KEY. The map key must not inherit
       * that fallback: with only the environment's server key configured, mapConfig is
       * all nulls.
       */
      vi.stubEnv('GOOGLE_PLACES_API_KEY', SERVER_KEY);
      try {
        getMapsConfig.mockResolvedValue({ apiKey: SERVER_KEY });
        getBrowserMapsConfig.mockResolvedValue(null);
        const out = await (await mine()).mapConfig();
        expect(out).toEqual({ browserApiKey: null, region: null });
        expect(JSON.stringify(out)).not.toContain(SERVER_KEY);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('refuses a browser key that IS the server key in use, wherever that came from', async () => {
      // The resolver refuses one equal to the installation's apiKey; this is the case it
      // cannot see — the server key in use came from the environment.
      getMapsConfig.mockResolvedValue({ apiKey: SERVER_KEY });
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: SERVER_KEY, region: null });
      const c = await mine();
      await expect(c.mapConfig()).resolves.toEqual({ browserApiKey: null, region: null });
      await expect(c.status()).resolves.toEqual({ available: true, mapAvailable: false });
    });

    it('hands out no key when lookup is off, and does not even read the browser key', async () => {
      getMapsConfig.mockResolvedValue(null);
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: BROWSER_KEY, region: 'CA' });
      await expect((await mine()).mapConfig()).resolves.toEqual({
        browserApiKey: null,
        region: null,
      });
      expect(getBrowserMapsConfig).not.toHaveBeenCalled();
    });

    it('is refused without the permission (FORBIDDEN), before any config is read', async () => {
      getBrowserMapsConfig.mockResolvedValue({ browserApiKey: BROWSER_KEY, region: 'CA' });
      const c = (await caller('mileageRoute', db(), [])) as MapCaller;
      await expect(c.mapConfig()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(getMapsConfig).not.toHaveBeenCalled();
      expect(getBrowserMapsConfig).not.toHaveBeenCalled();
    });

    it('is refused signed out (UNAUTHORIZED)', async () => {
      // No session at all — what an anonymous request to /api/trpc carries.
      const { createCallerFactory } = await import('@/server/trpc');
      const { mileageRouteRouter } = await import('./mileageRoute');
      const anon = createCallerFactory(mileageRouteRouter)({
        session: null,
        db: db(),
        rbac: null,
      } as never) as unknown as MapCaller;
      await expect(anon.mapConfig()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(anon.status()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(getBrowserMapsConfig).not.toHaveBeenCalled();
    });
  });

  it('returns suggestions when configured', async () => {
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      searchPlaces: (i: unknown) => Promise<{ available: boolean; items: unknown[] }>;
    };
    await expect(c.searchPlaces({ query: 'toronto', sessionToken: U('1') })).resolves.toMatchObject(
      { available: true, items: [{ placeId: 'p1' }], error: null },
    );
  });

  it('answers "unavailable" rather than erroring when unconfigured', async () => {
    // The form falls back to typed addresses and a manual distance.
    getMapsConfig.mockResolvedValue(null);
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      searchPlaces: (i: unknown) => Promise<unknown>;
    };
    await expect(c.searchPlaces({ query: 'toronto', sessionToken: U('1') })).resolves.toEqual({
      available: false,
      items: [],
      error: null,
    });
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  it('returns the REASON on a lookup failure, not just an empty list', async () => {
    /**
     * The documented failure this fixes: an empty list made a rejected API call
     * indistinguishable from "no such address", so a misconfigured key looked like
     * every address in North America having vanished.
     */
    searchPlaces.mockRejectedValue(new Error('REQUEST_DENIED: API key not authorized'));
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      searchPlaces: (i: unknown) => Promise<{ available: boolean; error: string | null }>;
    };
    const out = await c.searchPlaces({ query: 'toronto', sessionToken: U('1') });
    expect(out).toMatchObject({ available: true, items: [] });
    expect(out.error).toContain('REQUEST_DENIED');
  });

  it('stringifies a non-Error failure', async () => {
    searchPlaces.mockRejectedValue('quota exceeded');
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      searchPlaces: (i: unknown) => Promise<{ error: string | null }>;
    };
    expect((await c.searchPlaces({ query: 'toronto', sessionToken: U('1') })).error).toBe(
      'quota exceeded',
    );
  });

  it('requires a real query and a session token', async () => {
    // The session token bills the keystrokes and the pick as one autocomplete session.
    const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as {
      searchPlaces: (i: unknown) => Promise<unknown>;
    };
    await expect(c.searchPlaces({ query: 'to', sessionToken: U('1') })).rejects.toThrow();
    await expect(c.searchPlaces({ query: 'toronto', sessionToken: 'nope' })).rejects.toThrow();
  });

  /**
   * `computeRoutes` — the lookup behind Calculate. A paid Google request on a key the
   * whole organisation shares, so the rules that matter are who may call it, that a
   * refused call never reaches Google, and that the answer carries exactly the fields
   * the picker needs.
   */
  describe('computeRoutes', () => {
    type RoutesCaller = { computeRoutes: (i: unknown) => Promise<{ routes: unknown[] }> };
    const v = (leg: number, placeId = `road-${leg}`) => ({ placeId, leg });
    const routesCaller = async (userId: string = ME) =>
      (await caller('mileageRoute', db(), [P.expense.report.updateOwn], userId)) as RoutesCaller;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

    it('is gated on editing an expense', async () => {
      const c = (await caller('mileageRoute', db(), [])) as RoutesCaller;
      await expect(c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(computeRoutes).not.toHaveBeenCalled();
    });

    it('is the only route lookup — the old single-route `computeRoute` is gone', async () => {
      // A Google route request on a mileage line comes only from a press of Calculate
      // (FR-3); a second, unthrottled lookup beside it would undo both rules.
      const { mileageRouteRouter } = await import('./mileageRoute');
      const procedures = Object.keys(mileageRouteRouter._def.procedures);
      expect(procedures).toContain('computeRoutes');
      expect(procedures).not.toContain('computeRoute');
    });

    it('refuses when lookup is not configured, before counting or calling out', async () => {
      getMapsConfig.mockResolvedValue(null);
      const c = await routesCaller();
      await expect(c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(limiter.calls).toHaveLength(0);
      expect(computeRoutes).not.toHaveBeenCalled();
    });

    it('takes 2 to 25 stops: 25 pass, 1 and 26 are refused without a Google call', async () => {
      const c = await routesCaller();
      await expect(c.computeRoutes({ placeIds: ids(1), unit: 'KM' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(c.computeRoutes({ placeIds: ids(26), unit: 'KM' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(computeRoutes).not.toHaveBeenCalled();

      await expect(c.computeRoutes({ placeIds: ids(25), unit: 'KM' })).resolves.toEqual({
        routes: [],
      });
      expect(computeRoutes).toHaveBeenCalledWith({ apiKey: 'k' }, ids(25), []);
    });

    /**
     * Pass-through points as `via` place IDs (spec FR-2): the same 25 in all as the stops
     * alone, each on a leg of this route, in route order — the rule Save applies, so a
     * lookup that succeeds is a route that saves. The input and every entry are strict: a
     * coordinate or an older client's `passThrough` is refused, never routed without. A
     * refused input never reaches Google or the limit.
     */
    it('sends the via points to the lookup, rebuilt by name', async () => {
      const c = await routesCaller();
      await c.computeRoutes({ placeIds: ['a', 'b', 'c'], unit: 'KM', via: [v(0), v(1)] });
      expect(computeRoutes).toHaveBeenCalledWith({ apiKey: 'k' }, ['a', 'b', 'c'], [v(0), v(1)]);
    });

    it('defaults via points to none', async () => {
      const c = await routesCaller();
      await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      expect(computeRoutes).toHaveBeenCalledWith({ apiKey: 'k' }, ['a', 'b'], []);
    });

    it.each([
      [
        '26 stops and points in all',
        { placeIds: ids(3), via: Array.from({ length: 23 }, () => v(0)) },
      ],
      ['a point past the last leg', { placeIds: ids(3), via: [v(2)] }],
      ['points out of route order', { placeIds: ids(4), via: [v(1), v(0)] }],
      ['a fractional leg', { placeIds: ids(3), via: [v(0.5)] }],
      ['a point with no leg', { placeIds: ids(2), via: [{ placeId: 'road' }] }],
      ['a point with no place ID', { placeIds: ids(2), via: [{ leg: 0 }] }],
      ['an empty place ID', { placeIds: ids(2), via: [v(0, '')] }],
      [
        'a point that carries its coordinate',
        { placeIds: ids(2), via: [{ ...v(0), lat: 43.6532101, lng: -79.3831843 }] },
      ],
      [
        'a stale `passThrough` input',
        { placeIds: ids(2), passThrough: [{ lat: 43.6532101, lng: -79.3831843, leg: 0 }] },
      ],
      ['any other unknown key', { placeIds: ids(2), fetchedAt: '2026-10-19T12:00:00.000Z' }],
    ])('refuses %s without a Google call or a count', async (_label, over) => {
      const c = await routesCaller();
      await expect(c.computeRoutes({ unit: 'KM', ...over })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(computeRoutes).not.toHaveBeenCalled();
      expect(limiter.calls).toHaveLength(0);
    });

    it('accepts exactly 25 stops and points in all', async () => {
      const c = await routesCaller();
      const via = Array.from({ length: 22 }, () => v(0));
      await expect(c.computeRoutes({ placeIds: ids(3), unit: 'KM', via })).resolves.toBeDefined();
      expect(computeRoutes).toHaveBeenCalledTimes(1);
    });

    it('answers the routes and no fetch stamp', async () => {
      const c = await routesCaller();
      const out = await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      expect(Object.keys(out)).toEqual(['routes']);
      expect(out).not.toHaveProperty('fetchedAt');
    });

    it('refuses an empty place id and an unknown unit', async () => {
      const c = await routesCaller();
      await expect(c.computeRoutes({ placeIds: ['a', ''], unit: 'KM' })).rejects.toThrow();
      await expect(c.computeRoutes({ placeIds: ['a', 'b'], unit: 'LEAGUES' })).rejects.toThrow();
      expect(computeRoutes).not.toHaveBeenCalled();
    });

    it('returns exactly the picker’s fields, rebuilt — nothing extra rides along', async () => {
      computeRoutes.mockResolvedValue([
        {
          index: 0,
          label: 'Hwy 401',
          totalMeters: 1000,
          durationSeconds: 600,
          legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 1000, raw: 'x' }],
          encodedPolyline: 'enc',
          apiKey: 'k',
          googleJson: { anything: true },
        },
        {
          index: 1,
          label: null,
          totalMeters: 2000,
          durationSeconds: null,
          legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 2000 }],
          encodedPolyline: null,
        },
      ]);
      metersToDistance.mockImplementation(((m: number, u: string) => `${m}${u}`) as never);
      const c = await routesCaller();
      const out = await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'MI' });
      expect(out).toEqual({
        routes: [
          {
            index: 0,
            label: 'Hwy 401',
            totalMeters: 1000,
            distance: '1000MI',
            durationSeconds: 600,
            legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 }],
            encodedPolyline: 'enc',
          },
          {
            index: 1,
            // An empty label crosses the wire as null; the picker renders "Route n".
            label: null,
            totalMeters: 2000,
            distance: '2000MI',
            durationSeconds: null,
            legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 2000 }],
            encodedPolyline: null,
          },
        ],
      });
      expect(JSON.stringify(out)).not.toContain('apiKey');
    });

    it('counts lookups per person, 300 an hour, keyed mileage-routes:{userId}', async () => {
      const c = await routesCaller();
      await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      expect(limiter.calls[0]).toEqual([`mileage-routes:${ME}`, { max: 300, windowSec: 3600 }]);
    });

    it('allows the 300th lookup and refuses the 301st with no Google call (NFR-14)', async () => {
      const c = await routesCaller();
      for (let i = 0; i < 299; i++) {
        await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      }
      // The 300th is still inside the budget.
      await expect(c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' })).resolves.toBeDefined();
      expect(computeRoutes).toHaveBeenCalledTimes(300);

      await expect(c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' })).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
      expect(computeRoutes).toHaveBeenCalledTimes(300);

      // Somebody else's budget is their own.
      const other = await routesCaller(U('8'));
      await expect(
        other.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' }),
      ).resolves.toBeDefined();
      expect(computeRoutes).toHaveBeenCalledTimes(301);
    });

    it('reports a Google failure redacted, and without the raw error attached', async () => {
      const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstuvw';
      computeRoutes.mockRejectedValue(new Error(`Google Maps 400: bad key=${key}`));
      const c = await routesCaller();
      const err = (await c
        .computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' })
        .catch((e: unknown) => e)) as { code: string; message: string; cause?: unknown };
      // INTERNAL_SERVER_ERROR: the person sees the generic message; the server log
      // gets this one — which is why it must already be redacted.
      expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      expect(err.message).toContain('<redacted>');
      expect(err.message).not.toContain(key);
      expect(err.cause).toBeUndefined();
    });

    /**
     * Spec TR-13 check 1, both outcomes, with stubs: Routes either routes through a Roads
     * place ID or refuses it. A refusal on a request that carried a `via` is the typed
     * `mileage.viaPlaceRefused` (BAD_REQUEST + key), which the modal answers by converting
     * its newest point once more through Geocoding. Anything else stays the generic failure.
     */
    describe('a refused via place (TR-13 check 1)', () => {
      const refusedBy = async (status: number, google: string, message = 'Invalid waypoint') => {
        const { GoogleMapsHttpError } = await vi.importActual<
          typeof import('@/server/platform/googleMaps')
        >('@/server/platform/googleMaps');
        return new GoogleMapsHttpError(`Google Maps ${status}: ${message}`, status, google);
      };

      it('routes through the via place ID when Routes accepts it', async () => {
        computeRoutes.mockResolvedValue([
          {
            index: 0,
            label: null,
            totalMeters: 1000,
            durationSeconds: 60,
            legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 }],
            encodedPolyline: 'enc',
          },
        ]);
        const c = await routesCaller();
        const out = await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM', via: [v(0)] });
        expect(out.routes).toHaveLength(1);
        expect(computeRoutes).toHaveBeenCalledWith({ apiKey: 'k' }, ['a', 'b'], [v(0)]);
      });

      it.each([
        ['400 INVALID_ARGUMENT', 400, 'INVALID_ARGUMENT'],
        ['404 NOT_FOUND', 404, 'NOT_FOUND'],
      ])('answers BAD_REQUEST with `mileage.viaPlaceRefused` on %s', async (_l, status, google) => {
        computeRoutes.mockRejectedValue(await refusedBy(status, google));
        const c = await routesCaller();
        const err = (await c
          .computeRoutes({ placeIds: ['a', 'b'], unit: 'KM', via: [v(0)] })
          .catch((e: unknown) => e)) as { code: string; message: string };
        expect(err.code).toBe('BAD_REQUEST');
        // Our words, never Google's (C7).
        expect(err.message).toBe(
          'Google could not route through a point the route was dragged through.',
        );
        const { refusalData } = await import('@/server/refusal');
        expect(refusalData(err)).toEqual({ key: 'refusals.mileage.viaPlaceRefused' });
        // One call, one count: the server never retries on its own.
        expect(computeRoutes).toHaveBeenCalledTimes(1);
        expect(limiter.calls).toHaveLength(1);
      });

      it('is the generic failure when the request carried no via point', async () => {
        computeRoutes.mockRejectedValue(await refusedBy(400, 'INVALID_ARGUMENT'));
        const c = await routesCaller();
        const err = await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' }).catch((e) => e);
        expect(err).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
        const { refusalData } = await import('@/server/refusal');
        expect(refusalData(err)).toBeNull();
      });

      it.each([
        ['a key refusal', 403, 'PERMISSION_DENIED', 'denied'],
        ['a bad key on a 400', 400, 'INVALID_ARGUMENT', 'API key not valid'],
        ['a quota', 429, 'RESOURCE_EXHAUSTED', 'quota'],
        ['an outage', 503, 'UNAVAILABLE', 'down'],
      ])('is the generic failure on %s, even with a via point', async (_l, status, google, msg) => {
        computeRoutes.mockRejectedValue(await refusedBy(status, google, msg));
        const c = await routesCaller();
        const err = await c
          .computeRoutes({ placeIds: ['a', 'b'], unit: 'KM', via: [v(0)] })
          .catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
        const { refusalData } = await import('@/server/refusal');
        expect(refusalData(err)).toBeNull();
      });
    });
  });

  /**
   * `pointToPlace` — a point dropped on the route, as a place ID (spec FR-2). The Roads
   * then Geocoding rule is `placeForPoint`'s, tested against a stubbed fetch beside it;
   * what is pinned here is who may call it, that a refusal before Google costs nothing,
   * that every call costs exactly ONE count (spec NFR-8) however many APIs answer it, and
   * the outcome table the modal branches on.
   */
  describe('pointToPlace', () => {
    type PointCaller = {
      pointToPlace: (i: unknown) => Promise<{
        placeId: string;
        location: { lat: number; lng: number };
        source: string;
      }>;
      computeRoutes: (i: unknown) => Promise<unknown>;
    };
    const DROP = { lat: 43.6532101, lng: -79.3831843 };
    const FOUND = {
      kind: 'found',
      source: 'roads',
      placeId: 'ChIJroad-1',
      location: { lat: 43.65322, lng: -79.38319 },
    };
    const pointCaller = async (userId: string = ME) =>
      (await caller('mileageRoute', db(), [P.expense.report.updateOwn], userId)) as PointCaller;

    it('is a mutation, so the coordinate never rides in a GET query string (C3)', async () => {
      const { mileageRouteRouter } = await import('./mileageRoute');
      const procedure = (
        mileageRouteRouter._def.procedures as Record<string, { _def: { type: string } }>
      ).pointToPlace;
      expect(procedure?._def.type).toBe('mutation');
    });

    it('is gated on editing an expense, before counting or calling out', async () => {
      const c = (await caller('mileageRoute', db(), [])) as PointCaller;
      await expect(c.pointToPlace(DROP)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(limiter.calls).toHaveLength(0);
      expect(placeForPoint).not.toHaveBeenCalled();
    });

    it('refuses when lookup is not configured, before counting or calling out', async () => {
      getMapsConfig.mockResolvedValue(null);
      const c = await pointCaller();
      await expect(c.pointToPlace(DROP)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(limiter.calls).toHaveLength(0);
      expect(placeForPoint).not.toHaveBeenCalled();
    });

    it.each([
      ['a latitude past 90', { lat: 90.5, lng: 0 }],
      ['a longitude past 180', { lat: 0, lng: -180.5 }],
      ['a NaN latitude', { lat: Number.NaN, lng: 0 }],
      ['no longitude', { lat: 0 }],
      ['an unknown method', { ...DROP, method: 'roads' }],
      ['an extra key', { ...DROP, leg: 0 }],
    ])('refuses %s before counting or calling out', async (_label, input) => {
      const c = await pointCaller();
      await expect(c.pointToPlace(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(limiter.calls).toHaveLength(0);
      expect(placeForPoint).not.toHaveBeenCalled();
    });

    it('answers the place ID, its location and its source, built by name', async () => {
      placeForPoint.mockResolvedValue({ ...FOUND, extra: 'never sent' });
      const c = await pointCaller();
      await expect(c.pointToPlace(DROP)).resolves.toEqual({
        placeId: 'ChIJroad-1',
        location: { lat: 43.65322, lng: -79.38319 },
        source: 'roads',
      });
      expect(placeForPoint).toHaveBeenCalledWith({ apiKey: 'k' }, DROP, 'auto');
    });

    it("passes `method: 'geocoding'` on, for the modal's retry", async () => {
      placeForPoint.mockResolvedValue({ ...FOUND, source: 'geocoding' });
      const c = await pointCaller();
      await c.pointToPlace({ ...DROP, method: 'geocoding' });
      expect(placeForPoint).toHaveBeenCalledWith({ apiKey: 'k' }, DROP, 'geocoding');
    });

    it('costs one count per call — on the shared route-lookup budget — however it is answered', async () => {
      const c = await pointCaller();
      placeForPoint.mockResolvedValueOnce(FOUND);
      await c.pointToPlace(DROP);
      // A Roads refusal answered through Geocoding is still one call, one count.
      placeForPoint.mockResolvedValueOnce({ ...FOUND, source: 'geocoding' });
      await c.pointToPlace(DROP);
      placeForPoint.mockResolvedValueOnce({ kind: 'none' });
      await c.pointToPlace(DROP).catch(() => {});
      expect(limiter.calls).toEqual([
        [`mileage-routes:${ME}`, { max: 300, windowSec: 3600 }],
        [`mileage-routes:${ME}`, { max: 300, windowSec: 3600 }],
        [`mileage-routes:${ME}`, { max: 300, windowSec: 3600 }],
      ]);
      expect(placeForPoint).toHaveBeenCalledTimes(3);
    });

    it('refuses past the limit with no Google call, sharing the budget with route lookups', async () => {
      placeForPoint.mockResolvedValue(FOUND);
      const c = await pointCaller();
      for (let i = 0; i < 299; i++) await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      await expect(c.pointToPlace(DROP)).resolves.toBeDefined();
      await expect(c.pointToPlace(DROP)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(placeForPoint).toHaveBeenCalledTimes(1);
    });

    it('refuses "no road near this point" as NOT_FOUND with its catalog key', async () => {
      placeForPoint.mockResolvedValue({ kind: 'none' });
      const c = await pointCaller();
      const err = await c.pointToPlace(DROP).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'NOT_FOUND' });
      const { refusalData } = await import('@/server/refusal');
      expect(refusalData(err)).toEqual({ key: 'refusals.mileage.noRoadNear' });
    });

    it('names only the refused APIs, in our words — never Google’s (C7)', async () => {
      placeForPoint.mockResolvedValue({ kind: 'refused', apis: ['Roads API', 'Geocoding API'] });
      const c = await pointCaller();
      const err = (await c.pointToPlace(DROP).catch((e: unknown) => e)) as { message: string };
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(err.message).toBe(
        'Dragging a route needs Roads API, Geocoding API enabled on the Maps Platform key.',
      );
      const { refusalData } = await import('@/server/refusal');
      expect(refusalData(err)).toEqual({
        key: 'refusals.mileage.dragApisUnavailable',
        params: { apis: 'Roads API, Geocoding API' },
      });

      placeForPoint.mockResolvedValue({ kind: 'refused', apis: ['Geocoding API'] });
      const one = await c.pointToPlace({ ...DROP, method: 'geocoding' }).catch((e: unknown) => e);
      expect(refusalData(one)?.params).toEqual({ apis: 'Geocoding API' });
    });

    it('reports a Google failure redacted — no key, no coordinate — and without the raw error', async () => {
      const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstuvw';
      placeForPoint.mockRejectedValue(
        new Error(`Google Maps 503: points=${DROP.lat},${DROP.lng} key=${key}`),
      );
      const c = await pointCaller();
      const err = (await c.pointToPlace(DROP).catch((e: unknown) => e)) as {
        code: string;
        message: string;
        cause?: unknown;
      };
      expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      expect(err.message).toMatch(/^Point lookup failed: /);
      expect(err.message).not.toContain(key);
      expect(err.message).not.toContain('43.65321');
      expect(err.message).not.toContain('79.38318');
      expect(err.cause).toBeUndefined();
    });
  });

  /**
   * `viaLocations`: placing a reopened route's `via` points (FR-4 step 3). The paid-call
   * budget is the server's to keep, so what is pinned is the counting: one per distinct
   * ID, each before that ID's request, none before the refusals that come first, and a
   * stop at the first ID over the limit.
   */
  describe('viaLocations', () => {
    type Result = {
      placeId: string;
      location: { lat: number; lng: number } | null;
      reason?: string;
    };
    type ViaCaller = {
      viaLocations: (i: unknown) => Promise<{ results: Result[] }>;
      computeRoutes: (i: unknown) => Promise<unknown>;
    };
    const AT = (n: number) => ({ lat: 43 + n / 100, lng: -79 - n / 100 });
    const viaCaller = async (userId: string = ME, dbStub: unknown = db()) =>
      (await caller('mileageRoute', dbStub, [P.expense.report.updateOwn], userId)) as ViaCaller;
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ChIJvia-${i}`);
    const COUNT = [`mileage-routes:${ME}`, { max: 300, windowSec: 3600 }];

    it('is a mutation and not an assistant or MCP tool', async () => {
      const { mileageRouteRouter } = await import('./mileageRoute');
      const procedure = (
        mileageRouteRouter._def.procedures as Record<string, { _def: { type: string } }>
      ).viaLocations;
      expect(procedure?._def.type).toBe('mutation');
      const { TOOLS } = await import('@expenseos/mcp-server');
      expect(TOOLS.some((t) => t.path === 'mileageRoute.viaLocations')).toBe(false);
    });

    it('is gated on editing an expense, before counting or calling out', async () => {
      const c = (await caller('mileageRoute', db(), [])) as ViaCaller;
      await expect(c.viaLocations({ placeIds: ids(2) })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(limiter.calls).toHaveLength(0);
      expect(placeLocation).not.toHaveBeenCalled();
    });

    it('refuses when lookup is not configured, before counting or calling out', async () => {
      getMapsConfig.mockResolvedValue(null);
      const c = await viaCaller();
      await expect(c.viaLocations({ placeIds: ids(2) })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(limiter.calls).toHaveLength(0);
      expect(placeLocation).not.toHaveBeenCalled();
    });

    it.each([
      ['no IDs', { placeIds: [] }],
      ['24 IDs, past the 23 a route can pass through', { placeIds: ids(24) }],
      ['an empty ID', { placeIds: [''] }],
      ['an ID past 500 characters', { placeIds: ['a'.repeat(501)] }],
      ['an ID with a control character', { placeIds: ['ChIJ\u0000x'] }],
      ['an extra key', { placeIds: ids(1), unit: 'KM' }],
    ])('refuses %s before counting or calling out', async (_label, input) => {
      const c = await viaCaller();
      await expect(c.viaLocations(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(limiter.calls).toHaveLength(0);
      expect(placeLocation).not.toHaveBeenCalled();
    });

    it('counts N times for N distinct IDs, each before its request, and answers by name', async () => {
      // How many counts had been taken when each request went out.
      const countsAtFetch: number[] = [];
      placeLocation.mockImplementation(async (_cfg: unknown, placeId: string) => {
        countsAtFetch.push(limiter.calls.length);
        return { ...AT(Number(placeId.slice(-1))), extra: 'never sent' };
      });
      const c = await viaCaller();
      const out = await c.viaLocations({ placeIds: ids(23) });

      expect(limiter.calls).toEqual(Array.from({ length: 23 }, () => COUNT));
      expect(placeLocation).toHaveBeenCalledTimes(23);
      expect(placeLocation).toHaveBeenCalledWith({ apiKey: 'k' }, 'ChIJvia-0');
      // Every count is taken before the first request goes out.
      expect(countsAtFetch).toEqual(Array.from({ length: 23 }, () => 23));
      expect(out.results).toHaveLength(23);
      expect(out.results[0]).toEqual({ placeId: 'ChIJvia-0', location: AT(0) });
      expect(out.results.map((r) => r.placeId)).toEqual(ids(23));
    });

    it('looks a repeated ID up once, with one count, and answers it once', async () => {
      placeLocation.mockResolvedValue(AT(1));
      const c = await viaCaller();
      const out = await c.viaLocations({ placeIds: ['ChIJb', 'ChIJa', 'ChIJb', 'ChIJb'] });
      expect(limiter.calls).toEqual([COUNT, COUNT]);
      expect(placeLocation.mock.calls.map((call) => call[1])).toEqual(['ChIJb', 'ChIJa']);
      expect(out.results.map((r) => r.placeId)).toEqual(['ChIJb', 'ChIJa']);
    });

    it('stops at the first ID over the limit and answers it and the rest `throttled`, unasked', async () => {
      placeLocation.mockResolvedValue(AT(1));
      const c = await viaCaller();
      // 297 of the 300 spent on route lookups: three more fit.
      for (let i = 0; i < 297; i++) await c.computeRoutes({ placeIds: ['a', 'b'], unit: 'KM' });
      limiter.calls.length = 0;

      const out = await c.viaLocations({ placeIds: ids(6) });
      // Three within the limit, the fourth refused — and no count is asked after it.
      expect(limiter.calls).toHaveLength(4);
      expect(placeLocation.mock.calls.map((call) => call[1])).toEqual(ids(3));
      expect(out.results).toEqual([
        { placeId: 'ChIJvia-0', location: AT(1) },
        { placeId: 'ChIJvia-1', location: AT(1) },
        { placeId: 'ChIJvia-2', location: AT(1) },
        { placeId: 'ChIJvia-3', location: null, reason: 'throttled' },
        { placeId: 'ChIJvia-4', location: null, reason: 'throttled' },
        { placeId: 'ChIJvia-5', location: null, reason: 'throttled' },
      ]);
    });

    it('answers an ID that may not go into a Google URL `unresolved`, with no count and no request (C1)', async () => {
      placeLocation.mockResolvedValue(AT(2));
      const c = await viaCaller();
      const out = await c.viaLocations({ placeIds: ['../../v1/places', 'ChIJgood', 'a b'] });
      expect(limiter.calls).toEqual([COUNT]);
      expect(placeLocation).toHaveBeenCalledTimes(1);
      expect(placeLocation).toHaveBeenCalledWith({ apiKey: 'k' }, 'ChIJgood');
      expect(out.results).toEqual([
        { placeId: '../../v1/places', location: null, reason: 'unresolved' },
        { placeId: 'ChIJgood', location: AT(2) },
        { placeId: 'a b', location: null, reason: 'unresolved' },
      ]);
    });

    it('answers a point Google cannot place, or a failed request, as data — the others still placed', async () => {
      const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstuvw';
      placeLocation.mockImplementation(async (_cfg: unknown, placeId: string) => {
        if (placeId === 'ChIJunknown') return null;
        if (placeId === 'ChIJdown') throw new Error(`Google Maps 503: key=${key}`);
        return AT(3);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const c = await viaCaller();
        const out = await c.viaLocations({ placeIds: ['ChIJunknown', 'ChIJdown', 'ChIJok'] });
        expect(out.results).toEqual([
          { placeId: 'ChIJunknown', location: null, reason: 'unresolved' },
          { placeId: 'ChIJdown', location: null, reason: 'failed' },
          { placeId: 'ChIJok', location: AT(3) },
        ]);
        // Every request was counted, the failed one too.
        expect(limiter.calls).toHaveLength(3);
        // The failure is logged redacted: no key.
        const logged = warn.mock.calls.flat().join(' ');
        expect(logged).toMatch(/^\[mileage\.viaLocations\] place lookup failed: /);
        expect(logged).not.toContain(key);
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps at most five requests in flight', async () => {
      let inFlight = 0;
      let most = 0;
      placeLocation.mockImplementation(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return AT(4);
      });
      const c = await viaCaller();
      const out = await c.viaLocations({ placeIds: ids(12) });
      expect(most).toBe(5);
      expect(out.results.every((r) => r.location !== null)).toBe(true);
    });

    it('writes nothing and logs no location (NFR-9)', async () => {
      placeLocation.mockResolvedValue({ lat: 43.6532101, lng: -79.3831843 });
      // Any use of the database at all — a read, a write, raw SQL, a transaction — is recorded.
      const touched: string[] = [];
      const recording = new Proxy(
        {},
        {
          get: (_t, prop) => {
            touched.push(String(prop));
            return new Proxy(() => {}, { get: () => () => {}, apply: () => undefined });
          },
        },
      );
      const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );
      try {
        const c = await viaCaller(ME, recording);
        const out = await c.viaLocations({ placeIds: ['ChIJa', 'ChIJb'] });
        expect(out.results[0]?.location).toEqual({ lat: 43.6532101, lng: -79.3831843 });
        // The config read is stubbed, so any use recorded would be the procedure's own.
        expect(touched.filter((p) => p !== 'then')).toEqual([]);
        const logged = spies.flatMap((s) => s.mock.calls.flat()).join(' ');
        expect(logged).not.toContain('43.65321');
        expect(logged).not.toContain('79.38318');
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });

  /**
   * `lineRoutePath`'s shape. Its behaviour is the database's (the db test beside
   * `mileageRoute.ts`); what is pinned here is how it can be reached at all.
   */
  describe('lineRoutePath', () => {
    type PathCaller = { lineRoutePath: (i: unknown) => Promise<unknown> };

    it('is a mutation, so it is never prefetched or sent as a GET', async () => {
      const { mileageRouteRouter } = await import('./mileageRoute');
      const procedure = (
        mileageRouteRouter._def.procedures as Record<string, { _def: { type: string } }>
      ).lineRoutePath;
      expect(procedure?._def.type).toBe('mutation');
    });

    it('is not an assistant or MCP tool', async () => {
      const { TOOLS } = await import('@expenseos/mcp-server');
      expect(TOOLS.length).toBeGreaterThan(10);
      expect(TOOLS.filter((t) => t.path.startsWith('mileageRoute.'))).toEqual([]);
    });

    it('is gated on editing an expense', async () => {
      const c = (await caller('mileageRoute', db(), [])) as PathCaller;
      await expect(c.lineRoutePath({ lineItemId: U('1') })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(computeRoutes).not.toHaveBeenCalled();
    });

    it.each([
      ['an extra key', { lineItemId: U('1'), encodedPolyline: 'abc' }],
      ['a line id that is not a uuid', { lineItemId: 'line-1' }],
      ['no line id', {}],
    ])('refuses %s before reading anything', async (_label, input) => {
      const c = (await caller('mileageRoute', db(), [P.expense.report.updateOwn])) as PathCaller;
      await expect(c.lineRoutePath(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(computeRoutes).not.toHaveBeenCalled();
      expect(limiter.calls).toHaveLength(0);
    });
  });
});

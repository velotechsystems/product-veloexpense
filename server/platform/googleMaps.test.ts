import { afterEach, describe, expect, it, vi } from 'vitest';

// VeloExpense: ExpenseOS mocks `@expenseos/db/secrets-crypto` here for the installation
// branch of `getMapsConfig`, which VeloExpense does not have yet (see googleMaps.ts).

import {
  computeRoute,
  getMapsConfig,
  googleMessage,
  mapsRemedy,
  metersToDistance,
  regionCodes,
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

describe('computeRoute', () => {
  it('sends intermediates in order and does not let Google reorder them', async () => {
    const spy = stubFetch({
      routes: [{ legs: [{ distanceMeters: 1000 }, { distanceMeters: 2500 }] }],
    });
    const out = await computeRoute(CFG, ['a', 'b', 'c']);

    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    expect(body.origin).toEqual({ placeId: 'a' });
    expect(body.destination).toEqual({ placeId: 'c' });
    expect(body.intermediates).toEqual([{ placeId: 'b' }]);
    // The traveller drove the route they drove; a shorter reordering would be a
    // different claim.
    expect(body.optimizeWaypointOrder).toBe(false);
    // Traffic-aware routing would return a different answer on every recompute.
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');

    expect(out.totalMeters).toBe(3500);
    expect(out.legs).toEqual([
      { fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 },
      { fromPlaceId: 'b', toPlaceId: 'c', meters: 2500 },
    ]);
  });

  it('omits intermediates entirely for a two-stop trip', async () => {
    const spy = stubFetch({ routes: [{ legs: [{ distanceMeters: 500 }] }] });
    await computeRoute(CFG, ['a', 'b']);
    const body = JSON.parse(spy.mock.calls[0][1].body as string);
    expect(body.intermediates).toBeUndefined();
  });

  it('does not call out at all for fewer than two stops', async () => {
    const spy = stubFetch({});
    expect(await computeRoute(CFG, ['a'])).toEqual({ legs: [], totalMeters: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('metersToDistance', () => {
  it('converts to the unit the form is showing', () => {
    expect(metersToDistance(45_000, 'KM')).toBe('45.00');
    expect(metersToDistance(1609.344, 'MI')).toBe('1.00');
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

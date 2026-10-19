// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFn } from '@/test-utils/stubFn';
import { isPastDate, searchFlightOptions, searchStayOptions } from './travelOptions';

/**
 * Only the two network calls and the place lookup are stubbed. What is under test is
 * what this module adds on top of them: storing each option as a candidate so a choice
 * can be server-authoritative, truncating honestly, and telling four different kinds of
 * nothing apart.
 */
const { searchFlights, searchStays, resolveTravelPlace } = vi.hoisted(() => ({
  searchFlights: vi.fn(),
  searchStays: vi.fn(),
  resolveTravelPlace: vi.fn(),
}));
vi.mock('@expenseos/travel-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/travel-search')>()),
  searchFlights,
  searchStays,
}));
vi.mock('./travelPlace', () => ({ resolveTravelPlace }));

/**
 * The candidate cache, stubbed. What is under test is what this module PUTS in it — the
 * converted amount, the provider's own figure, and the search context beside each option —
 * not ioredis.
 */
const { putCandidates } = vi.hoisted(() => ({ putCandidates: vi.fn() }));
vi.mock('./travelOptionsCache', () => ({ putCandidates }));

const REQ = 'r-1';

/**
 * Dates relative to today, never literals.
 *
 * The fixture used to hardcode 2026-09-01, which was in the future when it was written and
 * is in the past now. The searches refuse a departure that has already gone — that is the
 * point of `isPastDate` — so a literal here is a test that passes until the date arrives and
 * then fails for a reason that has nothing to do with the code under test.
 */
const dayFromNow = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DEPART = dayFromNow(30);
const RETURN = dayFromNow(34);
const CONFIG = { apiKey: 'k', currency: 'CAD' } as never;
const identity = (amountMinor: bigint) => amountMinor;

function makeDb() {
  const db = {
    travelRequest: {
      // `stubFn`, and the row typed loosely: an override in a test supplies a pinned
      // airport or a null return date, and a stub inferred from one literal shape
      // refuses both.
      findUniqueOrThrow: stubFn(
        async (): Promise<Record<string, unknown>> => ({
          id: REQ,
          destinationPlaceId: 'p-yyz',
          destinationLabel: 'Toronto, ON',
          destinationCity: 'Toronto',
          destinationCountry: 'CA',
          destinationAirport: null,
          originPlaceId: 'p-yul',
          originLabel: 'Montréal, QC',
          originCity: 'Montréal',
          originCountry: 'CA',
          originAirport: null,
          departDate: new Date(`${DEPART}T00:00:00Z`),
          returnDate: new Date(`${RETURN}T00:00:00Z`),
        }),
      ),
    },
  };
  return db;
}

/** `n` itineraries, each a dollar dearer than the last so order is visible. */
function flights(n: number) {
  const opt = (i: number) => ({
    priceMinor: BigInt(50_000 + i * 100),
    currency: 'CAD',
    legs: [{ from: 'YUL', to: 'YYZ', airline: 'Air Canada', flightNumber: `AC ${400 + i}` }],
    totalDurationMinutes: 75,
    stops: 0,
    airlines: ['Air Canada'],
    bookingToken: `tok-${i}`,
  });
  return {
    best: [opt(0)],
    others: Array.from({ length: Math.max(0, n - 1) }, (_, i) => opt(i + 1)),
    insight: {
      lowestMinor: 45_000n,
      level: 'typical',
      typicalRangeMinor: { lowMinor: 40_000n, highMinor: 60_000n },
      currency: 'CAD',
    },
    currency: 'CAD',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // One id per candidate handed in, so the ids line up with the entries under test.
  putCandidates.mockImplementation(async (_req: string, _kind: string, entries: unknown[]) =>
    entries.map((_, i) => `cand-${i}`),
  );
  resolveTravelPlace.mockResolvedValue({ serpPlaceId: 'serp-1', airports: ['YYZ'] });
  searchFlights.mockResolvedValue(flights(3));
  searchStays.mockResolvedValue({ properties: [], currency: 'CAD', nights: 3 });
});

const INPUT = { tripType: 'ROUND_TRIP' as const, travelClass: 'ECONOMY' as const };

/** The entries handed to the cache — what this module's job actually produces. */
const cached = () =>
  (putCandidates.mock.calls[0]?.[2] ?? []) as {
    amountMinor: string;
    providerAmountMinor: string;
    providerCurrency: string;
    option: Record<string, unknown>;
    search: Record<string, unknown>;
  }[];

describe('searchFlightOptions', () => {
  it('stores every option it returns as a candidate, and hands back the ids', async () => {
    /**
     * The load-bearing behaviour. A choice reads its amount back out of one of these
     * rows, so a client that edits the price it was shown changes nothing.
     */
    const db = makeDb();
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('ok');
    expect(out.options).toHaveLength(3);
    expect(cached()).toHaveLength(3);
    for (const o of out.options) expect(o.candidateId).toBeTruthy();
  });

  it('stores the SEARCH beside each option', async () => {
    /**
     * A `FlightOption` carries the legs and the fare but not the cabin, the trip shape
     * or the dates — those were search inputs. A line rebuilt from the option alone
     * would lose that the fare was a business-class round trip.
     */
    const db = makeDb();
    await searchFlightOptions(
      db as never,
      CONFIG,
      REQ,
      { ...INPUT, travelClass: 'BUSINESS' },
      identity,
    );
    const entry = cached()[0];
    expect(entry.option).toBeTruthy();
    expect(entry.search).toMatchObject({
      travelClass: 'BUSINESS',
      tripType: 'ROUND_TRIP',
      outboundDate: DEPART,
      returnDate: RETURN,
    });
  });

  it('caches BOTH the converted amount and what the provider quoted', async () => {
    /**
     * Both, because they answer different questions. The converted figure is what the line
     * will carry, since a line has no currency of its own. The provider's own figure is the
     * one piece of evidence the dropped `TravelQuote` row held, and it rides onto the
     * payload when the option is chosen — so an approved estimate can still say what the
     * airline actually quoted rather than only a number that depends on an FX rate.
     */
    const db = makeDb();
    await searchFlightOptions(db as never, CONFIG, REQ, INPUT, (m) => m * 2n);
    expect(cached()[0]).toMatchObject({
      amountMinor: '100000',
      providerAmountMinor: '50000',
      providerCurrency: 'CAD',
    });
  });

  it('truncates to twelve and SAYS how many were found', async () => {
    /**
     * A picker rendering sixty is a picker nobody reads, and sixty candidate rows per
     * search is litter. But a truncated list that presented itself as everything on
     * offer would be a silent cap, so `found` reports the real number.
     */
    const db = makeDb();
    searchFlights.mockResolvedValue(flights(30));
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.options).toHaveLength(12);
    expect(out.found).toBe(30);
    expect(cached()).toHaveLength(12);
  });

  it('offers the provider’s own picks first', async () => {
    // Somebody scanning the list should meet the sensible itineraries before the
    // 23-hour two-stop ones.
    const db = makeDb();
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.options[0]?.amountMinor).toBe(50_000n);
  });

  it('converts the price insight, so the confidence compares like with like', async () => {
    // Converting a fare and leaving the typical range alone reports every trip out of an
    // org quoting in another currency as wildly above or below typical.
    const db = makeDb();
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, (m) => m * 2n);
    expect(out.insight?.typicalRangeMinor).toEqual({ lowMinor: 80_000n, highMinor: 120_000n });
  });

  it('answers no-plan without asking anybody, when there is no config', async () => {
    // Null is a first-class answer: travel prices from per-diem without a paid provider.
    const db = makeDb();
    const out = await searchFlightOptions(db as never, null, REQ, INPUT, identity);
    expect(out.reason).toBe('no-plan');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('answers no-airports when a place resolves to none', async () => {
    const db = makeDb();
    resolveTravelPlace.mockResolvedValue({ serpPlaceId: null, airports: [] });
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('no-airports');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('refuses a round trip with no return date before paying to find out', async () => {
    const db = makeDb();
    db.travelRequest.findUniqueOrThrow.mockResolvedValue({
      id: REQ,
      destinationPlaceId: 'p',
      destinationLabel: 'Toronto',
      destinationCity: 'Toronto',
      destinationCountry: 'CA',
      destinationAirport: 'YYZ',
      originPlaceId: 'p2',
      originLabel: 'Montréal',
      originCity: 'Montréal',
      originCountry: 'CA',
      originAirport: 'YUL',
      departDate: new Date(`${DEPART}T00:00:00Z`),
      returnDate: null,
    });
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('no-results');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('classifies a provider failure instead of leaking its message', async () => {
    /**
     * The raw message can contain the request URL, and the request URL contains the
     * key. "Could not be reached" was also one sentence for an exhausted plan, a
     * rejected key and a bug in our parameters — three owners, one useless string.
     */
    const db = makeDb();
    searchFlights.mockRejectedValue(new Error('https://serpapi.com/search?api_key=SECRET'));
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('provider-error');
    expect(out.providerFailure).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('writes nothing when the provider has no flights on the route', async () => {
    const db = makeDb();
    searchFlights.mockResolvedValue({ best: [], others: [], insight: null, currency: 'CAD' });
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('no-results');
    expect(putCandidates).not.toHaveBeenCalled();
  });
});

describe('searchStayOptions', () => {
  const STAY_INPUT = { checkIn: DEPART, checkOut: RETURN };
  const toMajor = (m: bigint) => Number(m) / 100;

  function stays(n: number, over: Record<string, unknown> = {}) {
    return {
      properties: Array.from({ length: n }, (_, i) => ({
        name: `Hotel ${i}`,
        kind: 'hotel',
        nightlyMinor: 20_000n,
        totalMinor: 60_000n,
        currency: 'CAD',
        rating: 4.5,
        reviews: 100,
        starClass: 4,
        propertyToken: `tok-${i}`,
        ...over,
      })),
      currency: 'CAD',
      nights: 3,
    };
  }

  it('prices the whole stay from the provider’s total', async () => {
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1));
    const out = await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(out.options[0]?.amountMinor).toBe(60_000n);
  });

  it('falls back to the nightly rate × the nights the SEARCH covered', async () => {
    // `nights` comes back from the search rather than being recomputed — deriving it
    // twice is how the two disagree. The nightly rate here is deliberately NOT
    // total/nights, so this distinguishes the fallback from the total path.
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1, { totalMinor: null, nightlyMinor: 15_000n }));
    const out = await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(out.options[0]?.amountMinor).toBe(45_000n);
  });

  it('prices a stay the provider gave no rate for at all as zero, not as a crash', async () => {
    // A property with neither figure is a parsing gap. Zero is visible in a list and
    // recoverable; throwing loses the other eleven options.
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1, { totalMinor: null, nightlyMinor: null }));
    const out = await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(out.options[0]?.amountMinor).toBe(0n);
  });

  it('pushes the cap to the provider in MAJOR units', async () => {
    /**
     * Filtering after paying for forty results wastes most of the search. Major units
     * because that is what the provider takes, and the exponent comes from the caller —
     * JPY has none, so a hardcoded /100 would offer a cap a hundred times too small.
     */
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1));
    await searchStayOptions(
      db as never,
      CONFIG,
      REQ,
      { ...STAY_INPUT, capPerNightMinor: 25_000n },
      identity,
      toMajor,
    );
    expect(searchStays.mock.calls[0]?.[1]?.maxPrice).toBe(250);
  });

  it('omits maxPrice entirely when there is no cap', async () => {
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1));
    await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(searchStays.mock.calls[0]?.[1]).not.toHaveProperty('maxPrice');
  });

  it('stores the nights and the cap alongside each option', async () => {
    const db = makeDb();
    searchStays.mockResolvedValue(stays(1));
    await searchStayOptions(
      db as never,
      CONFIG,
      REQ,
      { ...STAY_INPUT, capPerNightMinor: 25_000n },
      identity,
      toMajor,
    );
    // A digit string, because BigInt does not survive JSON.
    expect(cached()[0].search).toMatchObject({ nights: 3, capPerNightMinor: '25000' });
  });

  it('truncates to twelve and reports the real count', async () => {
    const db = makeDb();
    searchStays.mockResolvedValue(stays(20));
    const out = await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(out.options).toHaveLength(12);
    expect(out.found).toBe(20);
  });

  it('classifies a provider failure', async () => {
    const db = makeDb();
    searchStays.mockRejectedValue(new Error('boom'));
    const out = await searchStayOptions(db as never, CONFIG, REQ, STAY_INPUT, identity, toMajor);
    expect(out.reason).toBe('provider-error');
  });
});

describe('a departure that has already gone', () => {
  /**
   * SerpApi refuses a past `outbound_date` with a 400. We classified that as BAD_REQUEST
   * and told the traveller "That is a fault on our side, not something you can fix —
   * please report it", which was wrong twice over: it was not our fault, and they could
   * fix it by changing the dates. Dev's most recent pricing failure was exactly this.
   *
   * Refusing before the call also saves a billable search, which is the economy this whole
   * module is built around.
   */
  it('is not sent to the provider at all', async () => {
    const db = makeDb();
    db.travelRequest.findUniqueOrThrow.mockResolvedValue({
      ...(await db.travelRequest.findUniqueOrThrow()),
      departDate: new Date(`${dayFromNow(-1)}T00:00:00Z`),
      returnDate: new Date(`${dayFromNow(3)}T00:00:00Z`),
    });
    const out = await searchFlightOptions(db as never, CONFIG, REQ, INPUT, identity);
    expect(out.reason).toBe('past-date');
    expect(searchFlights).not.toHaveBeenCalled();
  });

  it('refuses a check-in that has gone, for the same reason', async () => {
    const db = makeDb();
    const out = await searchStayOptions(
      db as never,
      CONFIG,
      REQ,
      { checkIn: dayFromNow(-1), checkOut: dayFromNow(3) },
      identity,
      (m: bigint) => Number(m) / 100,
    );
    expect(out.reason).toBe('past-date');
    expect(searchStays).not.toHaveBeenCalled();
  });

  it('lets today through — a same-day search is legitimate', async () => {
    // The boundary matters: refusing today would break booking a flight this evening.
    expect(isPastDate(dayFromNow(0))).toBe(false);
    expect(isPastDate(dayFromNow(1))).toBe(false);
    expect(isPastDate(dayFromNow(-1))).toBe(true);
  });

  it('does not refuse a date it cannot parse', () => {
    // An unparseable date is a different bug; swallowing it here as "past" would hide it
    // behind a message about dates the traveller can see are fine.
    expect(isPastDate('')).toBe(false);
    expect(isPastDate('not-a-date')).toBe(false);
  });
});

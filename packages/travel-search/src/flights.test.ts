import { describe, expect, it, vi } from 'vitest';
import { TravelSearchError, TravelSearchUnavailableError } from './client';
import { searchFlightDeals, searchFlights, suggestPlaces } from './flights';
import { TRAVEL_CLASS, TRIP_TYPE } from './types';

/**
 * The provider boundary. Two things are worth pinning:
 *
 *   · the REQUEST — every call is billable, so a wrong parameter name is money
 *     spent on a search that answers a different question;
 *   · the NORMALIZER — SerpApi's fields are optional almost everywhere, and a
 *     half-parsed itinerary priced at zero is worse than no itinerary.
 */

const CFG = { apiKey: 'k-123', currency: 'CAD', gl: 'ca', hl: 'en' };

/** A fetch that records the URL it was given and replays a canned body. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  return { impl, calls, params: () => new URL(calls[0]).searchParams };
}

describe('serpApiSearch (via suggestPlaces)', () => {
  it('refuses without a key rather than calling out', async () => {
    const { impl } = stubFetch({});
    await expect(suggestPlaces({ apiKey: '' }, 'tor', { fetchImpl: impl })).rejects.toThrow(
      TravelSearchUnavailableError,
    );
    expect(impl).not.toHaveBeenCalled();
  });

  it('sends the key and drops absent parameters', async () => {
    const f = stubFetch({ suggestions: [] });
    await suggestPlaces({ apiKey: 'k' }, 'tor', { fetchImpl: f.impl });
    const p = f.params();
    expect(p.get('engine')).toBe('google_flights_autocomplete');
    expect(p.get('q')).toBe('tor');
    expect(p.get('api_key')).toBe('k');
    // No gl/hl configured, so neither is sent as the string "undefined".
    expect(p.has('gl')).toBe(false);
    expect(p.has('hl')).toBe(false);
  });

  it('treats an `error` field in a 200 body as a failure', async () => {
    // SerpApi reports business failures inside a successful response.
    const f = stubFetch({ error: 'Your account has run out of searches.' });
    await expect(suggestPlaces(CFG, 'tor', { fetchImpl: f.impl })).rejects.toThrow(
      /run out of searches/,
    );
  });

  it('surfaces an HTTP failure with the provider reason', async () => {
    const f = stubFetch({ error: 'Invalid API key.' }, false, 401);
    await expect(suggestPlaces(CFG, 'tor', { fetchImpl: f.impl })).rejects.toThrow(
      TravelSearchError,
    );
  });
});

describe('suggestPlaces', () => {
  it('normalizes a city with its airports', async () => {
    const f = stubFetch({
      suggestions: [
        {
          position: 1,
          name: 'Toronto',
          type: 'city',
          description: 'Ontario, Canada',
          id: '/m/0h7h6',
          airports: [
            { name: 'Toronto Pearson', id: 'YYZ', city: 'Toronto', distance: '22 km' },
            { name: 'Billy Bishop', id: 'YTZ', city: 'Toronto', distance: '3 km' },
          ],
        },
      ],
    });
    const out = await suggestPlaces(CFG, 'toron', { fetchImpl: f.impl });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: '/m/0h7h6', name: 'Toronto', kind: 'city' });
    expect(out[0].airports.map((a) => a.id)).toEqual(['YYZ', 'YTZ']);
  });

  it('drops a suggestion with nothing to search or show', async () => {
    const f = stubFetch({
      suggestions: [{ name: 'No id' }, { id: 'YYZ' }, { id: 'YOW', name: 'Ottawa' }],
    });
    const out = await suggestPlaces(CFG, 'o', { fetchImpl: f.impl });
    expect(out.map((s) => s.id)).toEqual(['YOW']);
  });

  it('survives a response with no suggestions at all', async () => {
    const f = stubFetch({});
    expect(await suggestPlaces(CFG, 'zzz', { fetchImpl: f.impl })).toEqual([]);
  });
});

describe('an empty search is an answer, not a failure', () => {
  /**
   * SerpApi reports "found nothing" with HTTP 200 and an `error` string — the SAME
   * envelope it uses for a rejected key or a bad parameter. Treating the whole envelope
   * as a failure turned "no flights on this route" into a thrown error, and the traveller
   * was told "Live prices could not be fetched… try again later" about a route where
   * trying again can never help.
   *
   * Seen on dev for Orlando → Napa: APC has no scheduled service, the engine correctly
   * returned nothing, and it surfaced as a provider outage.
   */
  it('returns no flights instead of throwing', async () => {
    const f = stubFetch({ error: "Google Flights hasn't returned any results for this query." });
    const r = await searchFlights(
      CFG,
      {
        departureId: 'MCO',
        arrivalId: 'APC',
        outboundDate: '2026-10-05',
        returnDate: '2026-10-09',
      },
      { fetchImpl: f.impl },
    );
    expect(r.best).toEqual([]);
    expect(r.others).toEqual([]);
    expect(r.insight).toBeNull();
  });

  it('does the same for the curly apostrophe the provider sometimes sends', async () => {
    const f = stubFetch({ error: 'Google Flights hasn’t returned any results for this query.' });
    await expect(
      searchFlights(
        CFG,
        {
          departureId: 'MCO',
          arrivalId: 'APC',
          outboundDate: '2026-10-05',
          returnDate: '2026-10-09',
        },
        { fetchImpl: f.impl },
      ),
    ).resolves.toBeDefined();
  });

  it('still throws for a real error in the same envelope', async () => {
    // The narrowness is the point: a rejected key arrives the same way and must not be
    // mistaken for an empty result, or a broken plan would read as "no flights".
    const f = stubFetch({ error: 'Invalid API key. Your API key should be here: …' });
    await expect(
      searchFlights(
        CFG,
        {
          departureId: 'MCO',
          arrivalId: 'YYZ',
          outboundDate: '2026-10-05',
          returnDate: '2026-10-09',
        },
        { fetchImpl: f.impl },
      ),
    ).rejects.toBeInstanceOf(TravelSearchError);
  });
});

describe('searchFlights', () => {
  const ITINERARY = {
    flights: [
      {
        departure_airport: { name: 'Montréal', id: 'YUL', time: '2026-09-01 08:00' },
        arrival_airport: { name: 'Toronto Pearson', id: 'YYZ', time: '2026-09-01 09:30' },
        duration: 90,
        airline: 'Air Canada',
        flight_number: 'AC 123',
      },
    ],
    layovers: [],
    total_duration: 90,
    price: 312.5,
    booking_token: 'tok-abc',
  };

  it('sends the documented parameter names', async () => {
    const f = stubFetch({ best_flights: [ITINERARY] });
    await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
        travelClass: TRAVEL_CLASS.BUSINESS,
        adults: 2,
        stops: 1,
      },
      { fetchImpl: f.impl },
    );
    const p = f.params();
    expect(p.get('engine')).toBe('google_flights');
    expect(p.get('departure_id')).toBe('YUL');
    expect(p.get('arrival_id')).toBe('YYZ');
    expect(p.get('outbound_date')).toBe('2026-09-01');
    expect(p.get('return_date')).toBe('2026-09-05');
    expect(p.get('type')).toBe(String(TRIP_TYPE.ROUND_TRIP));
    expect(p.get('travel_class')).toBe('3');
    expect(p.get('adults')).toBe('2');
    expect(p.get('stops')).toBe('1');
    // The currency a quote is stored in must be deterministic, not the provider's
    // default.
    expect(p.get('currency')).toBe('CAD');
  });

  it('refuses a round trip with no return date, without spending a search', async () => {
    const f = stubFetch({});
    await expect(
      searchFlights(
        CFG,
        { departureId: 'YUL', arrivalId: 'YYZ', outboundDate: '2026-09-01' },
        { fetchImpl: f.impl },
      ),
    ).rejects.toThrow(/return date/);
    expect(f.impl).not.toHaveBeenCalled();
  });

  it('does not require a return date for a one-way', async () => {
    const f = stubFetch({ best_flights: [] });
    await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        tripType: TRIP_TYPE.ONE_WAY,
      },
      { fetchImpl: f.impl },
    );
    expect(f.params().get('type')).toBe('2');
  });

  it('converts the price to minor units at the currency exponent', async () => {
    const f = stubFetch({ best_flights: [ITINERARY] });
    const out = await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: f.impl },
    );
    // 312.50 CAD → 31250 minor units. A float here becomes a wrong budget.
    expect(out.best[0].priceMinor).toBe(31250n);
    expect(out.best[0].airlines).toEqual(['Air Canada']);
    expect(out.best[0].bookingToken).toBe('tok-abc');
  });

  it('reads stops from layovers, and falls back to the leg count', async () => {
    const twoLeg = {
      ...ITINERARY,
      flights: [ITINERARY.flights[0], ITINERARY.flights[0]],
      layovers: [{ duration: 70, name: 'Ottawa', id: 'YOW' }],
    };
    const noLayoverField = { ...twoLeg, layovers: undefined };
    const f = stubFetch({ best_flights: [twoLeg, noLayoverField] });
    const out = await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: f.impl },
    );
    expect(out.best[0].stops).toBe(1);
    // Absent `layovers` must still read 0/1 rather than null.
    expect(out.best[1].stops).toBe(1);
  });

  it('DROPS an itinerary with no price rather than pricing it at zero', async () => {
    const f = stubFetch({
      best_flights: [{ ...ITINERARY, price: undefined }, ITINERARY],
    });
    const out = await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: f.impl },
    );
    // A free flight and a parsing failure must not look alike.
    expect(out.best).toHaveLength(1);
  });

  it('normalizes price insights, and needs BOTH ends of a range', async () => {
    const f = stubFetch({
      best_flights: [ITINERARY],
      price_insights: {
        lowest_price: 280,
        price_level: 'typical',
        typical_price_range: [250, 400],
      },
    });
    const out = await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: f.impl },
    );
    expect(out.insight).toMatchObject({ lowestMinor: 28000n, level: 'typical' });
    expect(out.insight?.typicalRangeMinor).toEqual({ lowMinor: 25000n, highMinor: 40000n });

    const half = stubFetch({
      best_flights: [ITINERARY],
      price_insights: { typical_price_range: [250] },
    });
    const out2 = await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: half.impl },
    );
    // Half a range cannot be reasoned about.
    expect(out2.insight?.typicalRangeMinor).toBeNull();
  });

  it('only asks for a deep search when told to — it costs more', async () => {
    const off = stubFetch({ best_flights: [] });
    await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
      },
      { fetchImpl: off.impl },
    );
    expect(off.params().has('deep_search')).toBe(false);

    const on = stubFetch({ best_flights: [] });
    await searchFlights(
      CFG,
      {
        departureId: 'YUL',
        arrivalId: 'YYZ',
        outboundDate: '2026-09-01',
        returnDate: '2026-09-05',
        deepSearch: true,
      },
      { fetchImpl: on.impl },
    );
    expect(on.params().get('deep_search')).toBe('true');
  });
});

describe('searchFlightDeals', () => {
  it('normalizes deals and drops the unpriced', async () => {
    const f = stubFetch({
      deals: [
        {
          destination_id: '/m/04jpl',
          name: 'London',
          country: 'United Kingdom',
          price: 512,
          average_price: 780,
          discount_percentage: 34,
          start_date: '2026-10-02',
          end_date: '2026-10-09',
          airline: 'Air Canada',
          stops: 0,
        },
        { name: 'Nowhere' },
      ],
    });
    const out = await searchFlightDeals(CFG, { departureId: 'YUL' }, { fetchImpl: f.impl });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      destinationName: 'London',
      priceMinor: 51200n,
      averagePriceMinor: 78000n,
      discountPercent: 34,
    });
    expect(f.params().get('engine')).toBe('google_flights_deals');
  });
});

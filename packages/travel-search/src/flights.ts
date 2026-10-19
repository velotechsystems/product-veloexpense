/**
 * The three flight engines: autocomplete, search, deals.
 *
 * Each is a thin call plus a normalizer. The normalizers are the substance —
 * SerpApi's shapes are wide and optional almost everywhere, so every field is
 * read defensively and a result that can't be understood is DROPPED rather than
 * turned into a half-populated option. A flight option with no price is not a
 * cheaper flight; it is a parsing failure wearing a price of zero.
 */

import { type SearchOptions, type SerpApiConfig, serpApiSearch } from './client';
import { toMinor } from './money';
import type {
  FlightDeal,
  FlightLeg,
  FlightOption,
  PlaceSuggestion,
  PriceInsight,
  TravelClass,
  TripType,
} from './types';
import { TRAVEL_CLASS, TRIP_TYPE } from './types';

/** The currency a search prices in. Quotes are stored in it, so it must be
 *  deterministic rather than "whatever the provider defaulted to". */
function currencyOf(config: SerpApiConfig): string {
  return (config.currency ?? 'USD').toUpperCase();
}

// ── Autocomplete ────────────────────────────────────────────────────────────

/**
 * Resolve a place to the AIRPORT ids the flight search needs.
 *
 * NOT the destination picker. A travel request's destination comes from Google
 * Places (`platform/googleMaps.ts`), which the product already uses for mileage —
 * one place picker, one set of semantics, one durable placeId. SerpApi's job here
 * is narrower: turn "Toronto" into YYZ/YTZ so `departure_id` / `arrival_id` are
 * something the flight engine accepts.
 *
 * Keeping that boundary matters because the two vocabularies are not
 * interchangeable. A Google placeId means nothing to SerpApi, and a SerpApi city id
 * means nothing to the hotel query, the per-diem city match, or the expense report
 * the trip eventually becomes.
 *
 * Cheap relative to a flight search but NOT free, so the caller debounces and
 * requires a few characters — the same discipline the address lookup uses.
 */
export async function suggestPlaces(
  config: SerpApiConfig,
  query: string,
  opts: SearchOptions = {},
): Promise<PlaceSuggestion[]> {
  const json = await serpApiSearch(
    config,
    {
      engine: 'google_flights_autocomplete',
      q: query,
      gl: config.gl,
      hl: config.hl,
    },
    opts,
  );
  const raw = Array.isArray(json.suggestions) ? json.suggestions : [];
  return (
    raw
      .map((s) => {
        const row = s as {
          id?: unknown;
          name?: unknown;
          type?: unknown;
          description?: unknown;
          airports?: unknown;
        };
        const airports = Array.isArray(row.airports) ? row.airports : [];
        return {
          id: typeof row.id === 'string' ? row.id : '',
          name: typeof row.name === 'string' ? row.name : '',
          kind: typeof row.type === 'string' ? row.type : 'city',
          description: typeof row.description === 'string' ? row.description : null,
          airports: airports
            .map((a) => {
              const ap = a as { id?: unknown; name?: unknown; city?: unknown };
              return {
                id: typeof ap.id === 'string' ? ap.id : '',
                name: typeof ap.name === 'string' ? ap.name : '',
                city: typeof ap.city === 'string' ? ap.city : null,
              };
            })
            .filter((a) => a.id && a.name),
        };
      })
      // Without an id there is nothing to search with, and without a name there is
      // nothing to show — either way the row is unusable.
      .filter((s) => s.id && s.name)
  );
}

// ── Flight search ───────────────────────────────────────────────────────────

export interface FlightSearchInput {
  /** IATA code or SerpApi place id. */
  departureId: string;
  arrivalId: string;
  /** YYYY-MM-DD. */
  outboundDate: string;
  /** YYYY-MM-DD. Required for a round trip. */
  returnDate?: string;
  tripType?: TripType;
  travelClass?: TravelClass;
  adults?: number;
  /** 0 any · 1 nonstop · 2 ≤1 stop · 3 ≤2 stops — SerpApi's numbering. */
  stops?: 0 | 1 | 2 | 3;
  /** Ask the provider for the same results a browser would see. Slower and dearer,
   *  so it is opt-in: worth it when a quote is about to be approved, wasteful while
   *  someone is still choosing dates. */
  deepSearch?: boolean;
}

export interface FlightSearchResult {
  /** Provider's picks first, then the rest — a caller wanting "the price" should
   *  take `best[0]` and not have to re-sort. */
  best: FlightOption[];
  others: FlightOption[];
  insight: PriceInsight | null;
  currency: string;
}

export async function searchFlights(
  config: SerpApiConfig,
  input: FlightSearchInput,
  opts: SearchOptions = {},
): Promise<FlightSearchResult> {
  const tripType = input.tripType ?? TRIP_TYPE.ROUND_TRIP;
  if (tripType === TRIP_TYPE.ROUND_TRIP && !input.returnDate) {
    // The provider errors on this; failing here names the actual problem and costs
    // nothing.
    throw new Error('A round trip needs a return date.');
  }
  const currency = currencyOf(config);
  const json = await serpApiSearch(
    config,
    {
      engine: 'google_flights',
      departure_id: input.departureId,
      arrival_id: input.arrivalId,
      outbound_date: input.outboundDate,
      return_date: input.returnDate,
      type: tripType,
      travel_class: input.travelClass ?? TRAVEL_CLASS.ECONOMY,
      adults: input.adults ?? 1,
      stops: input.stops,
      deep_search: input.deepSearch ? true : undefined,
      currency,
      gl: config.gl,
      hl: config.hl,
    },
    opts,
  );

  return {
    best: normalizeItineraries(json.best_flights, currency),
    others: normalizeItineraries(json.other_flights, currency),
    insight: normalizeInsight(json.price_insights, currency),
    currency,
  };
}

function normalizeItineraries(raw: unknown, currency: string): FlightOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => {
      const row = it as {
        flights?: unknown;
        layovers?: unknown;
        total_duration?: unknown;
        price?: unknown;
        booking_token?: unknown;
      };
      const priceMinor = toMinor(row.price, currency);
      // No price, no option. See the note at the top of the file.
      if (priceMinor === null) return null;
      const legs = normalizeLegs(row.flights);
      return {
        priceMinor,
        currency,
        legs,
        totalDurationMinutes: typeof row.total_duration === 'number' ? row.total_duration : null,
        // Stops are the layovers the provider lists; falling back to leg count − 1
        // keeps a nonstop reading 0 rather than null when `layovers` is absent.
        stops: Array.isArray(row.layovers) ? row.layovers.length : Math.max(0, legs.length - 1),
        airlines: [...new Set(legs.map((l) => l.airline).filter((a): a is string => !!a))],
        bookingToken: typeof row.booking_token === 'string' ? row.booking_token : null,
      } satisfies FlightOption;
    })
    .filter((o): o is FlightOption => o !== null);
}

function normalizeLegs(raw: unknown): FlightLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const leg = f as {
      departure_airport?: { id?: unknown; time?: unknown };
      arrival_airport?: { id?: unknown; time?: unknown };
      airline?: unknown;
      flight_number?: unknown;
      duration?: unknown;
    };
    return {
      from: typeof leg.departure_airport?.id === 'string' ? leg.departure_airport.id : '',
      to: typeof leg.arrival_airport?.id === 'string' ? leg.arrival_airport.id : '',
      departsAt:
        typeof leg.departure_airport?.time === 'string' ? leg.departure_airport.time : null,
      arrivesAt: typeof leg.arrival_airport?.time === 'string' ? leg.arrival_airport.time : null,
      airline: typeof leg.airline === 'string' ? leg.airline : null,
      flightNumber: typeof leg.flight_number === 'string' ? leg.flight_number : null,
      durationMinutes: typeof leg.duration === 'number' ? leg.duration : null,
    };
  });
}

function normalizeInsight(raw: unknown, currency: string): PriceInsight | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as {
    lowest_price?: unknown;
    price_level?: unknown;
    typical_price_range?: unknown;
  };
  const range = Array.isArray(row.typical_price_range) ? row.typical_price_range : null;
  const lowMinor = range ? toMinor(range[0], currency) : null;
  const highMinor = range ? toMinor(range[1], currency) : null;
  return {
    lowestMinor: toMinor(row.lowest_price, currency),
    level: typeof row.price_level === 'string' ? row.price_level : null,
    // Both ends or neither — half a range cannot be reasoned about.
    typicalRangeMinor: lowMinor !== null && highMinor !== null ? { lowMinor, highMinor } : null,
    currency,
  };
}

// ── Deals ───────────────────────────────────────────────────────────────────

export interface FlightDealsInput {
  departureId: string;
  /** Preset trip length: 1 week · 2 weekend · 3 two weeks. */
  travelDuration?: 1 | 2 | 3;
  tripType?: TripType;
  maxPrice?: number;
}

/**
 * Cheap destinations from one origin, for when the destination is the variable —
 * a team offsite, a conference nobody has chosen yet. Not for pricing a trip
 * somebody has already decided on: that is `searchFlights`.
 */
export async function searchFlightDeals(
  config: SerpApiConfig,
  input: FlightDealsInput,
  opts: SearchOptions = {},
): Promise<FlightDeal[]> {
  const currency = currencyOf(config);
  const json = await serpApiSearch(
    config,
    {
      engine: 'google_flights_deals',
      departure_id: input.departureId,
      travel_duration: input.travelDuration,
      type: input.tripType ?? TRIP_TYPE.ROUND_TRIP,
      max_price: input.maxPrice,
      currency,
      gl: config.gl,
      hl: config.hl,
    },
    opts,
  );
  const raw = Array.isArray(json.deals) ? json.deals : [];
  return raw
    .map((d) => {
      const row = d as Record<string, unknown>;
      const priceMinor = toMinor(row.price, currency);
      if (priceMinor === null) return null;
      return {
        destinationId: typeof row.destination_id === 'string' ? row.destination_id : '',
        destinationName: typeof row.name === 'string' ? row.name : '',
        country: typeof row.country === 'string' ? row.country : null,
        priceMinor,
        averagePriceMinor: toMinor(row.average_price, currency),
        discountPercent:
          typeof row.discount_percentage === 'number' ? row.discount_percentage : null,
        currency,
        startDate: typeof row.start_date === 'string' ? row.start_date : null,
        endDate: typeof row.end_date === 'string' ? row.end_date : null,
        airline: typeof row.airline === 'string' ? row.airline : null,
        stops: typeof row.stops === 'number' ? row.stops : null,
      } satisfies FlightDeal;
    })
    .filter((d): d is FlightDeal => d !== null && !!d.destinationName);
}

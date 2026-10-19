/**
 * Searching for flights and stays a traveller can PICK from.
 *
 * The list, not the cheapest. An earlier bulk path asked the same providers and auto-took
 * the cheapest answer; it was removed, because the cheapest itinerary is frequently not the
 * one somebody can travel on — a $180 saving is not worth a 5am connection through Chicago,
 * and only the traveller knows that.
 *
 * ## Why the options are CACHED before they can be chosen
 *
 * A picker seems to want "client sends back the option it picked", and that would let
 * the client name the price. The archived prototype let the form post its own total and
 * this module exists partly to undo that, so the rule holds here too: the client may
 * propose, only the server decides.
 *
 * So a search CACHES each option it returns and the client gets opaque ids.
 * `chooseLineOption` then takes an id, re-reads the amount from the cache, and the client's
 * copy of the price is never trusted for anything.
 *
 * The cache is Redis, not a table. The first version wrote a `TravelQuote` row per candidate
 * on the theory that they were durable evidence — they were not, because the line's payload
 * already carries the route, the flight numbers, the cabin and the dates, and the provider's
 * pre-FX amount now rides along on it too. What was actually needed was for the server to
 * remember for MINUTES. See `travelOptionsCache.ts`.
 *
 * ## Cost
 *
 * Every call spends a SerpApi credit. Which is why these are MUTATIONS in the router
 * rather than queries — react-query refetches a query on mount, on window focus and on
 * invalidation, and each of those would be a purchase nobody asked for.
 */

import type { Prisma, PrismaClient } from '@expenseos/db';
import type { TravelClassName } from '@expenseos/travel-lines';
import {
  type FlightOption,
  type PlaceSuggestion,
  type SerpApiConfig,
  type SerpApiFailureKind,
  type StayOption,
  searchFlights,
  searchStays,
  serpApiFailureKind,
  TRAVEL_CLASS,
  TRIP_TYPE,
  TravelSearchError,
} from '@expenseos/travel-search';
import { type CachedCandidate, putCandidates } from './travelOptionsCache';
import { resolveTravelPlace } from './travelPlace';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * How many options are stored and offered.
 *
 * The provider returns as many as it likes; a picker that renders sixty is a picker
 * nobody reads, and sixty candidate rows per search is litter. The response reports
 * `found` alongside `options`, so a truncated list SAYS it was truncated rather than
 * quietly presenting itself as everything available.
 */
const MAX_OPTIONS = 12;

/** Cabin name → the provider's number. The mapping lives here, at the edge, so a
 *  payload can store a name a human can read and only one place changes if SerpApi
 *  renumbers them. */
const TRAVEL_CLASS_BY_NAME: Record<TravelClassName, number> = {
  ECONOMY: TRAVEL_CLASS.ECONOMY,
  PREMIUM_ECONOMY: TRAVEL_CLASS.PREMIUM_ECONOMY,
  BUSINESS: TRAVEL_CLASS.BUSINESS,
  FIRST: TRAVEL_CLASS.FIRST,
};

export interface OptionCandidate {
  /** The cached candidate's id. What `chooseLineOption` takes, and the only thing the
   *  amount is ever read from. Opaque and request-scoped. */
  candidateId: string;
  amountMinor: bigint;
  /** The normalized option, for rendering the choice. Its price is for DISPLAY — the
   *  write re-reads the cached entry. */
  option: FlightOption | StayOption;
}

/**
 * What a cached candidate holds: the option AND the search that produced it.
 *
 * Both halves are needed, and neither is optional. A `FlightOption` carries the legs and
 * the fare but not the cabin, the trip shape or the dates — those were search INPUTS —
 * so a line rebuilt from the option alone would lose the fact that the fare was a
 * business-class round trip. Storing them together is also what lets `chooseLineOption`
 * reconstruct a line without trusting a single field from the client.
 *
 * The search is part of explaining the number, not noise beside it.
 */

export interface OptionSearchResult {
  options: OptionCandidate[];
  /** How many the provider actually returned, before `MAX_OPTIONS`. */
  found: number;
  /** SerpApi's read on whether a fare is good, when it offered one. Converted into the
   *  request's currency alongside the prices, or `priceConfidence` would compare a
   *  converted fare against an unconverted range. */
  insight: {
    lowestMinor: bigint | null;
    level: string | null;
    typicalRangeMinor: { lowMinor: bigint; highMinor: bigint } | null;
  } | null;
  /** Why nothing came back, when nothing did. Named rather than empty: "no plan", "no
   *  airports for this place" and "no flights on this route" are three problems with
   *  three different owners, and an empty list tells none of them apart. */
  reason: 'ok' | 'no-plan' | 'no-airports' | 'no-results' | 'past-date' | 'provider-error';
  providerFailure?: SerpApiFailureKind;
}

const EMPTY = (reason: OptionSearchResult['reason'], providerFailure?: SerpApiFailureKind) =>
  ({ options: [], found: 0, insight: null, reason, providerFailure }) satisfies OptionSearchResult;

/**
 * Has this date already gone?
 *
 * SerpApi refuses a past `outbound_date` with a 400, which we classified as BAD_REQUEST and
 * showed the traveller as "That is a fault on our side, not something you can fix — please
 * report it." It was not our fault and they COULD fix it: their departure date had passed.
 * Dev's most recent pricing failure was exactly this, on a request whose dates were three
 * weeks old.
 *
 * So the search is refused before it is sent. That saves a billable call — every call here
 * is money — and lets the traveller be told the one thing that actually helps.
 *
 * Compared as calendar dates in UTC. These are `YYYY-MM-DD` strings with no timezone, and
 * `new Date('2026-09-04')` is already UTC midnight, so this is a string-to-string comparison
 * in disguise; today is allowed, only strictly-earlier is refused. A traveller far enough
 * west that their local today is UTC yesterday can still hit the provider's own 400, which
 * is now an honest BAD_REQUEST rather than a mislabelled one.
 */
export function isPastDate(date: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date < now.toISOString().slice(0, 10);
}

/** A provider payload with its BigInts stringified, so it survives JSON. `JSON.stringify`
 *  throws on a BigInt rather than coercing it, and these carry prices in minor units. */
function jsonSafe(value: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
}

function classify(e: unknown): SerpApiFailureKind {
  const status = e instanceof TravelSearchError ? e.status : undefined;
  return serpApiFailureKind(status, e instanceof Error ? e.message : String(e));
}

/**
 * Cache the options as candidates and hand back their ids.
 *
 * Each entry carries the amount in BOTH currencies. `amountMinor` is the converted figure
 * the line will take, because a line carries no currency of its own; `providerAmountMinor`
 * and `providerCurrency` are what the provider actually quoted, and they ride onto the
 * payload when the option is chosen. Converting once here rather than at pick time means the
 * figure a traveller was shown is the figure that lands — an FX table that moved in between
 * cannot silently change the price they agreed to.
 */
async function cacheCandidates(
  requestId: string,
  kind: 'FLIGHT' | 'STAY',
  search: Record<string, unknown>,
  toRequestMinor: (amountMinor: bigint, fromCode: string) => bigint,
  priced: { amountMinor: bigint; currency: string; option: FlightOption | StayOption }[],
): Promise<OptionCandidate[]> {
  const safeSearch = jsonSafe(search);
  const entries: CachedCandidate[] = priced.map((p) => ({
    amountMinor: toRequestMinor(p.amountMinor, p.currency).toString(),
    providerAmountMinor: p.amountMinor.toString(),
    providerCurrency: p.currency,
    option: jsonSafe(p.option),
    search: safeSearch,
  }));
  const ids = await putCandidates(requestId, kind, entries);
  return priced.map((p, i) => ({
    candidateId: ids[i],
    // The CONVERTED figure, so the picker renders what the line will actually carry
    // rather than a provider number in a currency the request is not read in.
    amountMinor: BigInt(entries[i].amountMinor),
    option: p.option,
  }));
}

export interface FlightOptionsInput {
  tripType: 'ROUND_TRIP' | 'ONE_WAY' | 'MULTI_CITY';
  travelClass: TravelClassName;
  /** 0 any · 1 nonstop · 2 ≤1 stop · 3 ≤2 stops — SerpApi's numbering. */
  maxStops?: number | null;
  /** Slower and dearer, so it stays opt-in: worth it when an estimate is about to be
   *  submitted, wasteful while somebody is still choosing dates. */
  deepSearch?: boolean;
}

/**
 * Flight options for a request's route and dates.
 *
 * The route comes from the REQUEST, not from the caller. A traveller changing where they
 * are flying changes the trip, which is `update`'s job — letting a search take its own
 * origin would produce a line priced for a journey the request does not describe.
 */
export async function searchFlightOptions(
  db: Db,
  config: SerpApiConfig | null,
  requestId: string,
  input: FlightOptionsInput,
  toRequestMinor: (amountMinor: bigint, fromCode: string) => bigint,
): Promise<OptionSearchResult> {
  if (!config) return EMPTY('no-plan');

  const req = await db.travelRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true,
      destinationPlaceId: true,
      destinationLabel: true,
      destinationCity: true,
      destinationCountry: true,
      destinationAirport: true,
      originPlaceId: true,
      originLabel: true,
      originCity: true,
      originCountry: true,
      originAirport: true,
      departDate: true,
      returnDate: true,
    },
  });

  const [destination, origin] = await Promise.all([
    resolveTravelPlace(db, config, {
      placeId: req.destinationPlaceId,
      label: req.destinationLabel,
      city: req.destinationCity,
      country: req.destinationCountry,
    }),
    req.originLabel
      ? resolveTravelPlace(db, config, {
          placeId: req.originPlaceId,
          label: req.originLabel,
          city: req.originCity,
          country: req.originCountry,
        })
      : Promise.resolve({ serpPlaceId: null, airports: [] as string[] }),
  ]);

  // A pinned airport OVERRIDES the metro: "I am flying into Gatwick" is a decision, not
  // a preference, and pricing the metro would quote a different airport's fare.
  const arrivalId = req.destinationAirport || destination.serpPlaceId;
  const departureId = req.originAirport || origin.serpPlaceId;
  if (!departureId || !arrivalId) return EMPTY('no-airports');

  const outboundDate = req.departDate.toISOString().slice(0, 10);
  const returnDate = req.returnDate ? req.returnDate.toISOString().slice(0, 10) : undefined;
  const roundTrip = input.tripType === 'ROUND_TRIP';
  // The provider errors on a round trip with no return date; refusing here names the
  // actual problem and costs nothing.
  if (roundTrip && !returnDate) return EMPTY('no-results');
  // Same reasoning, for a date that has already passed. See `isPastDate`.
  if (isPastDate(outboundDate)) return EMPTY('past-date');

  let result: Awaited<ReturnType<typeof searchFlights>>;
  try {
    result = await searchFlights(config, {
      departureId,
      arrivalId,
      outboundDate,
      returnDate,
      tripType: roundTrip ? TRIP_TYPE.ROUND_TRIP : TRIP_TYPE.ONE_WAY,
      travelClass: TRAVEL_CLASS_BY_NAME[input.travelClass] as 1 | 2 | 3 | 4,
      ...(input.maxStops != null ? { stops: input.maxStops as 0 | 1 | 2 | 3 } : {}),
      ...(input.deepSearch ? { deepSearch: true } : {}),
    });
  } catch (e) {
    // The raw message stays in the log and out of the response: it can contain the
    // request URL, and the request URL contains the key.
    const kind = classify(e);
    console.warn(`[travel] flight option search failed (${kind})`, e);
    return EMPTY('provider-error', kind);
  }

  // Provider's picks first, then the rest — a traveller scanning the list should meet
  // the sensible ones before the 23-hour two-stop ones.
  const all = [...result.best, ...result.others];
  if (all.length === 0) return EMPTY('no-results');

  const options = await cacheCandidates(
    req.id,
    'FLIGHT',
    {
      fromLabel: req.originLabel ?? departureId,
      toLabel: req.destinationLabel,
      fromId: departureId,
      toId: arrivalId,
      tripType: input.tripType,
      travelClass: input.travelClass,
      maxStops: input.maxStops ?? null,
      outboundDate,
      returnDate: returnDate ?? null,
      pricedAt: outboundDate,
    },
    toRequestMinor,
    all.slice(0, MAX_OPTIONS).map((option) => ({
      amountMinor: option.priceMinor,
      currency: option.currency,
      option,
    })),
  );

  const insight = result.insight;
  return {
    options,
    found: all.length,
    insight: insight
      ? {
          lowestMinor:
            insight.lowestMinor == null
              ? null
              : toRequestMinor(insight.lowestMinor, insight.currency),
          level: insight.level,
          typicalRangeMinor: insight.typicalRangeMinor
            ? {
                lowMinor: toRequestMinor(insight.typicalRangeMinor.lowMinor, insight.currency),
                highMinor: toRequestMinor(insight.typicalRangeMinor.highMinor, insight.currency),
              }
            : null,
        }
      : null,
    reason: 'ok',
  };
}

export interface StayOptionsInput {
  checkIn: string;
  checkOut: string;
  adults?: number | null;
  vacationRentals?: boolean;
  /** The per-diem lodging cap, in the request's currency. Pushed to the PROVIDER as
   *  `maxPrice` so it filters — paying for forty results and discarding thirty of them
   *  wastes the search. */
  capPerNightMinor?: bigint | null;
  /** 3 lowest price · 8 highest rating · 13 most reviewed — SerpApi's numbering. */
  sortBy?: 3 | 8 | 13;
}

/** Lodging options for the given nights at the request's destination. */
export async function searchStayOptions(
  db: Db,
  config: SerpApiConfig | null,
  requestId: string,
  input: StayOptionsInput,
  toRequestMinor: (amountMinor: bigint, fromCode: string) => bigint,
  /** Minor → major, at the request currency's exponent, for the provider's `maxPrice`.
   *  Owned by the caller, which is the side that knows the exponent. */
  capToMajor: (amountMinor: bigint) => number,
): Promise<OptionSearchResult> {
  if (!config) return EMPTY('no-plan');

  const req = await db.travelRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { id: true, destinationCity: true, destinationLabel: true },
  });
  const query = req.destinationCity || req.destinationLabel;
  if (!query) return EMPTY('no-airports');
  // A check-in that has already passed is refused for the same reason a departure is.
  if (isPastDate(input.checkIn)) return EMPTY('past-date');

  let result: Awaited<ReturnType<typeof searchStays>>;
  try {
    result = await searchStays(config, {
      query,
      checkInDate: input.checkIn,
      checkOutDate: input.checkOut,
      ...(input.adults != null ? { adults: input.adults } : {}),
      ...(input.vacationRentals ? { vacationRentals: true } : {}),
      ...(input.capPerNightMinor != null ? { maxPrice: capToMajor(input.capPerNightMinor) } : {}),
      sortBy: input.sortBy ?? 3,
    });
  } catch (e) {
    const kind = classify(e);
    console.warn(`[travel] stay option search failed (${kind})`, e);
    return EMPTY('provider-error', kind);
  }

  const all = result.properties;
  if (all.length === 0) return EMPTY('no-results');

  const options = await cacheCandidates(
    req.id,
    'STAY',
    {
      city: query,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      // From the SEARCH, not recomputed: deriving the night count twice is how the two
      // disagree, and the provider already told us what it priced.
      nights: result.nights,
      capPerNightMinor: input.capPerNightMinor?.toString() ?? null,
    },
    toRequestMinor,
    all.slice(0, MAX_OPTIONS).map((option) => ({
      // The whole stay where the provider gave one, else the nightly rate × the nights
      // it searched. `nights` comes back from the search rather than being recomputed,
      // because deriving it twice is how the two disagree.
      amountMinor: option.totalMinor ?? (option.nightlyMinor ?? 0n) * BigInt(result.nights),
      currency: option.currency,
      option,
    })),
  );
  return { options, found: all.length, insight: null, reason: 'ok' };
}

/** Airport suggestions for a place, so a traveller can pin one rather than accepting
 *  the metro. Cheap and cached through `TravelPlace` — one lookup per place, reused. */
export async function suggestAirports(
  db: Db,
  config: SerpApiConfig | null,
  place: { placeId: string | null; label: string; city: string | null; country: string | null },
): Promise<PlaceSuggestion['airports']> {
  if (!config) return [];
  const resolved = await resolveTravelPlace(db, config, place);
  return resolved.airports.map((id) => ({ id, name: id, city: place.city ?? null }));
}

/**
 * What the travel module consumes, as distinct from what SerpApi returns.
 *
 * SerpApi's shapes are wide, provider-specific and priced in major-unit numbers.
 * These are narrow, ours, and priced in MINOR UNITS — because everything
 * downstream (the budget, the approval, the eventual expense report) is minor
 * units, and a provider's `price: 512.34` becoming a budget is exactly where a
 * float turns into a wrong reimbursement.
 *
 * Keeping the two apart also means a provider swap is a new normalizer rather than
 * a change to the travel request, the budget, or the UI.
 */

/** A place someone can fly from or to. */
export interface PlaceSuggestion {
  /** IATA code for an airport, or SerpApi's city/region id. What the flight search
   *  takes as `departure_id` / `arrival_id`. */
  id: string;
  name: string;
  /** 'airport' | 'city' | 'region' — SerpApi's own `type`, plus 'airport' for the
   *  nested airports it returns under a city. */
  kind: string;
  description: string | null;
  /** Airports under a city suggestion, so a traveller can pick the specific one. */
  airports: { id: string; name: string; city: string | null }[];
}

/** One leg of a flight itinerary. */
export interface FlightLeg {
  from: string;
  to: string;
  departsAt: string | null;
  arrivesAt: string | null;
  airline: string | null;
  flightNumber: string | null;
  /** Minutes, as the provider reports. */
  durationMinutes: number | null;
}

/** A priced itinerary. */
export interface FlightOption {
  /** Minor units in `currency`. */
  priceMinor: bigint;
  currency: string;
  legs: FlightLeg[];
  totalDurationMinutes: number | null;
  stops: number;
  airlines: string[];
  /** SerpApi's handle for fetching booking options. Retained so a later phase can
   *  offer "book this" without re-searching — a second search is a second charge. */
  bookingToken: string | null;
}

/**
 * The provider's view of whether a price is good.
 *
 * This is the part that makes a travel budget PREDICTIVE rather than a guess: a
 * quote of $612 means something different when the typical range is $400–$500 than
 * when it is $600–$900, and an approver deciding on the number deserves to know
 * which. `level` is SerpApi's own word ('low' | 'typical' | 'high').
 */
export interface PriceInsight {
  lowestMinor: bigint | null;
  level: string | null;
  typicalRangeMinor: { lowMinor: bigint; highMinor: bigint } | null;
  currency: string;
}

/** A hotel or vacation rental. */
export interface StayOption {
  name: string;
  /** 'hotel' | 'vacation rental', as the provider classifies it. */
  kind: string;
  /** Per night, minor units. Null when the provider only gave a total. */
  nightlyMinor: bigint | null;
  /** Whole stay, minor units. Null when the provider only gave a nightly rate. */
  totalMinor: bigint | null;
  currency: string;
  rating: number | null;
  reviews: number | null;
  /** Provider star class where it publishes one. */
  starClass: number | null;
  /** SerpApi's durable handle for this property. */
  propertyToken: string | null;
}

/** A cheap destination the provider is advertising from a given origin. Useful for
 *  "where could I go for a team offsite", not for pricing a fixed itinerary. */
export interface FlightDeal {
  destinationId: string;
  destinationName: string;
  country: string | null;
  priceMinor: bigint;
  averagePriceMinor: bigint | null;
  discountPercent: number | null;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  airline: string | null;
  stops: number | null;
}

/** Cabin classes, in SerpApi's numbering. Named so a caller never passes a bare 3. */
export const TRAVEL_CLASS = {
  ECONOMY: 1,
  PREMIUM_ECONOMY: 2,
  BUSINESS: 3,
  FIRST: 4,
} as const;
export type TravelClass = (typeof TRAVEL_CLASS)[keyof typeof TRAVEL_CLASS];

/** Trip shapes, in SerpApi's numbering. */
export const TRIP_TYPE = { ROUND_TRIP: 1, ONE_WAY: 2, MULTI_CITY: 3 } as const;
export type TripType = (typeof TRIP_TYPE)[keyof typeof TRIP_TYPE];

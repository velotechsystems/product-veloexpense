/**
 * Public surface of `@expenseos/travel-search`.
 *
 * Flight, lodging and deal lookups via SerpApi, plus the pure arithmetic that
 * turns them into a travel budget an approver can judge.
 *
 * Two boundaries this package exists to hold:
 *
 *   · MONEY. Providers report major-unit floats; everything downstream is BigInt
 *     minor units. The conversion happens once, at the provider edge (`money.ts`).
 *   · PROVENANCE. Every budget line records whether its number is a live quote, a
 *     policy cap, or a per-diem — because a total assembled from caps is a policy
 *     maximum, not a prediction, and presenting the two identically is how a bad
 *     trip gets approved on a plausible-looking number.
 *
 * Server-side only: the SerpApi key is a spending credential and every call is
 * billable.
 *
 * SCOPE. SerpApi is for FLIGHT SEARCH and lodging prices. A travel request's
 * DESTINATION comes from Google Places (`platform/googleMaps.ts`) — the picker the
 * product already uses for mileage. `suggestPlaces` here resolves a place to airport
 * ids for the flight query and is not a destination picker; see
 * docs/design/travel-module.md §1.
 */

export {
  type FetchLike,
  isNoResultsMessage,
  type SearchOptions,
  type SerpApiConfig,
  type SerpApiFailureKind,
  serpApiFailureKind,
  serpApiMessage,
  serpApiRemedy,
  serpApiSearch,
  TravelSearchError,
  TravelSearchUnavailableError,
} from './client';
export {
  type BudgetLineEstimate,
  type EstimateInput,
  estimateTravelBudget,
  type PriceBasis,
  type PriceConfidence,
  pickFlight,
  priceConfidence,
  type TravelEstimate,
} from './estimate';
export {
  type FlightDealsInput,
  type FlightSearchInput,
  type FlightSearchResult,
  searchFlightDeals,
  searchFlights,
  suggestPlaces,
} from './flights';
export { toMinor, toMinorOrZero } from './money';
export {
  cheapestStay,
  nightlyRateMinor,
  nightsBetween,
  type StaySearchInput,
  type StaySearchResult,
  searchStays,
} from './stays';
export {
  type FlightDeal,
  type FlightLeg,
  type FlightOption,
  type PlaceSuggestion,
  type PriceInsight,
  type StayOption,
  TRAVEL_CLASS,
  TRIP_TYPE,
  type TravelClass,
  type TripType,
} from './types';

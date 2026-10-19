/**
 * Barrel only. The implementation lives in `kinds.ts`.
 *
 * See `packages/expense-lines/src/index.ts` for why: coverage excludes `**​/index.ts` as
 * a re-export barrel, so a package whose logic lives in its index is not measured at
 * all and the per-package floor cannot see it.
 */
export {
  type AirfarePayload,
  attendeeCountOf,
  type CarRentalPayload,
  type DepartmentMealPayload,
  derivedAmountMinor,
  flightNumbersOf,
  flightRouteOf,
  type GroundPayload,
  kindCarriesAttendees,
  kindIsQuotable,
  type LodgingPayload,
  parseTravelLinePayload,
  payloadSchemaFor,
  readTravelLinePayload,
  routeFromLegs,
  type StandardPayload,
  TRAVEL_CLASS_NAMES,
  TRAVEL_LINE_KINDS,
  TRIP_SHAPES,
  type TravelClassName,
  type TravelLineKindName,
} from './kinds';

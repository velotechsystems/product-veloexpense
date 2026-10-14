/**
 * The approver's view of a mileage line's stored route: stop names only, plus the
 * route's own distance when it disagrees with the claim.
 *
 * Why the server trims it. `expenseApprovals.report` is read by everyone
 * `canViewReport` admits — the submitter's direct manager, anyone ever assigned to,
 * or who decided, a task on the report and, while a task is pending, anyone eligible
 * to decide it, including every member of a filter-approver or fallback pool — a
 * wider audience than the submitter's editor. The stored route (`ExpenseLineItem.mileageRoute`) is whatever the write
 * path accepted (`z.unknown()`), so it is parsed here with a typed, capped schema
 * and rebuilt by name: `placeId`, `legs` and per-leg metres never leave the server.
 *
 * Why the server works out the distance. The traveller's correction overwrites
 * `mileageDistance`, so the original route distance survives only in the legs.
 * Summing them here, and deciding here whether the difference is worth showing,
 * keeps the browser from needing the legs at all. The figure is "as filed", never
 * "verified": the submitter controls the stored legs.
 */

import { z } from 'zod';
import { metersToDistance } from '@/server/platform/googleMaps';

/** Most stops a route may carry — the same bound `mileageRoute.computeRoute` puts
 *  on the place ids it measures. */
export const MAX_ROUTE_STOPS = 25;
/** Longest stop description sent to an approver. */
export const MAX_STOP_DESCRIPTION = 300;

/**
 * The stored route, as far as the approver view needs it. Descriptions are typed
 * and capped; a route that fails here is sent as unavailable, not trimmed to fit.
 * `placeId` and `legs` are read loosely because they feed only the freshness check
 * below: a malformed leg hides the route distance, never the stops. Unknown keys
 * are dropped by the parse and, regardless, the output is built field by field.
 */
const storedRouteSchema = z.object({
  stops: z
    .array(
      z.object({
        description: z.string().max(MAX_STOP_DESCRIPTION),
        placeId: z.unknown().optional(),
      }),
    )
    .max(MAX_ROUTE_STOPS),
  legs: z.unknown().optional(),
});

const legsSchema = z
  .array(
    z.object({
      fromPlaceId: z.string().min(1),
      toPlaceId: z.string().min(1),
      meters: z.number(),
    }),
  )
  .min(1)
  // A chain of N stops has N - 1 legs; more than the stop cap allows is not a route.
  .max(MAX_ROUTE_STOPS - 1);

export interface MileageRouteView {
  /** Stop descriptions in order, or null when there is no route or it is unreadable. */
  mileageRoute: { stops: { description: string }[] } | null;
  /** The filed route's distance in the claim's unit ("12.34"), set only when it
   *  differs from the claim by more than max(0.01 unit, 0.5 % of the route). */
  routeDistance: string | null;
  /** True when a route was stored but failed the parse — the drawer says so
   *  rather than showing nothing. False when there simply is no route. */
  mileageRouteUnavailable: boolean;
}

const NO_ROUTE: MileageRouteView = {
  mileageRoute: null,
  routeDistance: null,
  mileageRouteUnavailable: false,
};

/** "12.34" / "12" → 1234 hundredths; anything else → null. */
function toHundredths(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const n = Math.round(Number(value) * 100);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Total metres of `legs`, or null when they do not describe THESE stops.
 *
 * `RouteEditor` clears the legs on every stop edit and only a lookup rewrites
 * them, so a normal save cannot carry stale legs. The write path accepts any
 * JSON, though, so the check is made here regardless: the legs must form one
 * chain (each leg starts where the previous ended), every leg's metres must be a
 * finite number ≥ 0, and the chain's place ids must be exactly the stops' place
 * ids, in order. Every stop must have one — a lookup only runs once every stop is
 * a real place, so a hand-typed stop beside legs means the legs are not its own.
 */
function freshRouteMeters(stops: readonly { placeId?: unknown }[], legs: unknown): number | null {
  const parsed = legsSchema.safeParse(legs);
  if (!parsed.success) return null;
  const chain = parsed.data;
  if (stops.length !== chain.length + 1) return null;

  let total = 0;
  for (const [i, leg] of chain.entries()) {
    if (!Number.isFinite(leg.meters) || leg.meters < 0) return null;
    if (leg.fromPlaceId !== stops[i]?.placeId) return null;
    if (leg.toPlaceId !== stops[i + 1]?.placeId) return null;
    total += leg.meters;
  }
  return total;
}

/**
 * Trim a stored route for the approver and work out whether its distance is
 * worth showing beside the claim.
 *
 * @param route   `ExpenseLineItem.mileageRoute` as stored (any JSON, or null).
 * @param unit    The line's `mileageUnit`; null hides the route distance.
 * @param claimed The line's `mileageDistance` as a decimal string; null hides it.
 *
 * Never throws: an unreadable route is `{ mileageRoute: null,
 * mileageRouteUnavailable: true }`.
 */
export function deriveRouteView(
  route: unknown,
  unit: 'KM' | 'MI' | null,
  claimed: string | null,
): MileageRouteView {
  if (route == null) return NO_ROUTE;

  const parsed = storedRouteSchema.safeParse(route);
  if (!parsed.success) {
    return { mileageRoute: null, routeDistance: null, mileageRouteUnavailable: true };
  }

  const { stops, legs } = parsed.data;
  const mileageRoute = { stops: stops.map((s) => ({ description: s.description })) };
  return {
    mileageRoute,
    routeDistance: routeDistanceIfDifferent(stops, legs, unit, claimed),
    mileageRouteUnavailable: false,
  };
}

function routeDistanceIfDifferent(
  stops: readonly { placeId?: unknown }[],
  legs: unknown,
  unit: 'KM' | 'MI' | null,
  claimed: string | null,
): string | null {
  if (unit == null || claimed == null) return null;
  const claimedH = toHundredths(claimed);
  if (claimedH == null) return null;
  const meters = freshRouteMeters(stops, legs);
  if (meters == null) return null;

  // The same conversion that filled the editor's distance field, so a claim the
  // traveller left alone compares equal to its own route.
  const routeDistance = metersToDistance(meters, unit);
  const routeH = toHundredths(routeDistance);
  if (routeH == null) return null;

  // Differs by more than max(0.01 unit, 0.5 % of the route): rounding and a
  // nudge of a few metres are not a discrepancy an approver needs to see.
  const threshold = Math.max(1, routeH * 0.005);
  return Math.abs(routeH - claimedH) > threshold ? routeDistance : null;
}

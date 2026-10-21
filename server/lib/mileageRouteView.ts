/**
 * Every server-side view of a mileage line's stored route, and the one rule for which of
 * its keys may be stored or served at all.
 *
 * ── The stored keys ──────────────────────────────────────────────────────────────────
 *
 * A stored route is its claim and nothing Google drew: `stops`, `legs`, `routeLabel`,
 * `routeIndex`, `routeCount` and `via` (`STORED_ROUTE_KEYS`). The only Google-derived
 * values among them are place IDs — on the stops, the legs and `via` — which Google's terms
 * let us keep indefinitely (ADR 0020). `storedRoute` copies those keys and no other, and it
 * sits at both ends of the column:
 *
 *   · every write, at the one persist point (`computeLineFinancials` in
 *     `routers/expenses.ts`), so create, update, the carry-over of a route an update did not
 *     mention and a date-move reprice all store the allowed keys alone;
 *   · the writer's read (`serializeExpense`), so a row that still carries a key from before
 *     this rule — a drawn path, dragged lat/lng points, a fetch stamp — is served without it.
 *     That read is also what the assistant and MCP tools are given (`get_expense_report`),
 *     so their transcripts hold nothing more than the writer's screen.
 *
 * It names the keys it keeps, never the ones it drops, so a key added to the column later
 * is dropped until somebody adds it here on purpose.
 *
 * ── The approver's view ──────────────────────────────────────────────────────────────
 *
 * `deriveRouteView`: stop names, the chosen route's label and how many routes were
 * offered, plus the route's own distance when it disagrees with the claim.
 *
 * Why the server trims it. `expenseApprovals.report` is read by everyone
 * `canViewReport` admits — the submitter's direct manager, anyone ever assigned to,
 * or who decided, a task on the report and, while a task is pending, anyone eligible
 * to decide it, including every member of a filter-approver or fallback pool — a
 * wider audience than the submitter's editor. The stored route
 * (`ExpenseLineItem.mileageRoute`) is parsed here with the shared read schema
 * (`lib/mileageRouteSchema.ts`) and rebuilt by name: `placeId`, `legs`, per-leg
 * metres and `routeIndex` never leave the server. Rows saved before the write path
 * checked the route were stored unchecked, which is why the read is its own schema.
 *
 * Absent stays absent. `routeLabel` and `routeCount` are added only when the stored
 * route carries a usable value — never as `null` — so a line filed without them
 * reads exactly as it did before they existed.
 *
 * Why the server works out the distance. The traveller's correction overwrites
 * `mileageDistance`, so the original route distance survives only in the legs.
 * Summing them here, and deciding here whether the difference is worth showing,
 * keeps the browser from needing the legs at all. The figure, the label and the
 * count are "as filed", never "verified": the submitter controls all three.
 */

import {
  metersToDistance,
  mileageRouteReadSchema,
  routeChainMeters,
} from '@/lib/mileageRouteSchema';

// ── The stored keys ──────────────────────────────────────────────────────────────────

/** The keys a stored route may hold, and the only ones served back to its writer. */
export const STORED_ROUTE_KEYS = [
  'stops',
  'legs',
  'routeLabel',
  'routeIndex',
  'routeCount',
  'via',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // Dates, Prisma Decimals and Buffers are values, not containers.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `route` with only the keys in `STORED_ROUTE_KEYS`, each value as it is; an absent or
 * `undefined` key stays absent. The input is not mutated.
 *
 * A value that is not a route object (null, an array, a scalar — a pre-schema oddity on an
 * old row) is returned as it is: it has no top-level key to drop, and a reprice must never
 * be blocked by it.
 */
export function storedRoute(route: unknown): unknown {
  if (!isPlainObject(route)) return route;
  const out: Record<string, unknown> = {};
  for (const key of STORED_ROUTE_KEYS) {
    if (Object.hasOwn(route, key) && route[key] !== undefined) out[key] = route[key];
  }
  return out;
}

// ── The approver's view ──────────────────────────────────────────────────────────────

export interface MileageRouteView {
  /** Stop descriptions in order — with the chosen route's label and the number of
   *  routes offered, when the route carries them — or null when there is no route or
   *  it is unreadable. */
  mileageRoute: {
    stops: { description: string }[];
    routeLabel?: string;
    routeCount?: number;
  } | null;
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

  const parsed = mileageRouteReadSchema.safeParse(route);
  if (!parsed.success) {
    return { mileageRoute: null, routeDistance: null, mileageRouteUnavailable: true };
  }

  const { stops, legs, routeLabel, routeCount } = parsed.data;
  const mileageRoute = {
    stops: stops.map((s) => ({ description: s.description })),
    ...(routeLabel !== undefined ? { routeLabel } : {}),
    ...(routeCount !== undefined ? { routeCount } : {}),
  };
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
  const meters = routeChainMeters(stops, legs);
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

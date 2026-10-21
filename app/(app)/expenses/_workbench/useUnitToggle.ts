'use client';

/**
 * KM/MI on a saved mileage line (FR-6 step 2), display-only on a line measured by its
 * route (operator decision, 2026-10-16).
 *
 * The server stores every mileage line in its mileage rule's unit, whatever unit it was
 * sent in (`computeLineFinancials`), so a toggle that WROTE would re-round the claim and
 * then snap back to the rule's unit. Instead:
 *
 *   · **A legs-derived line** — its distance is exactly what its stored legs measure in
 *     its stored unit, `metersToDistance(legsMeters, unit) === mileageDistance` — shows the
 *     other unit converted from the leg METRES and writes nothing. Converting from metres
 *     each time, never from the rounded figure on screen, is what makes KM → MI → KM land
 *     back on the stored figure exactly. The claim and its price stay in the rule's unit.
 *   · **Every other line** — a distance typed with lookup off, an override that differs
 *     from the legs, a route with no usable legs — is not this hook's: it keeps the typed
 *     path and its Edit / Save / Cancel lock (`derived: false`).
 *
 * The comparison is on hundredths, not on the strings: the server sends a `Decimal`'s
 * `toString()` ("24.1"), and `metersToDistance` always writes two places ("24.10").
 */

import { useState } from 'react';
import { metersToDistance, type RouteValue } from '@/lib/mileageRouteSchema';

export type DistanceUnit = 'KM' | 'MI';

/** The total of a route's legs in metres, or null when it has none worth trusting. */
export function legsMetersOf(route: RouteValue | null | undefined): number | null {
  const legs = route?.legs;
  if (!legs || legs.length === 0) return null;
  let total = 0;
  for (const leg of legs) {
    if (typeof leg?.meters !== 'number' || !Number.isFinite(leg.meters) || leg.meters < 0) {
      return null;
    }
    total += leg.meters;
  }
  return total > 0 ? total : null;
}

/** "24.1" and "24.10" as the same whole number of hundredths; null when not a distance. */
function hundredths(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Whether the line's distance is exactly what its legs measure in its own unit — the one
 * test that decides between the display-only toggle and the typed path.
 */
export function isLegsDerived(
  route: RouteValue | null | undefined,
  distance: string | null | undefined,
  unit: DistanceUnit | null | undefined,
): boolean {
  const meters = legsMetersOf(route);
  const stored = hundredths(distance);
  if (meters === null || stored === null || !unit) return false;
  return hundredths(metersToDistance(meters, unit)) === stored;
}

export interface UnitToggle {
  /** The line is legs-derived: the toggle below only changes what is shown. */
  derived: boolean;
  /** The unit the line is shown in. */
  shownUnit: DistanceUnit;
  /** The distance in `shownUnit`: the stored figure itself in the stored unit. */
  shownDistance: string;
  /** Show the line in `next`. Writes nothing. */
  show: (next: DistanceUnit) => void;
}

export function useUnitToggle({
  route,
  distance,
  unit,
}: {
  route: RouteValue | null | undefined;
  distance: string | null | undefined;
  unit: DistanceUnit | null | undefined;
}): UnitToggle {
  const stored: DistanceUnit = unit ?? 'KM';
  const [shown, setShown] = useState<DistanceUnit>(stored);
  const derived = isLegsDerived(route, distance, unit);
  const meters = legsMetersOf(route);
  const shownUnit = derived ? shown : stored;
  const shownDistance =
    derived && shownUnit !== stored && meters !== null
      ? metersToDistance(meters, shownUnit)
      : (distance ?? '');
  return { derived, shownUnit, shownDistance, show: setShown };
}

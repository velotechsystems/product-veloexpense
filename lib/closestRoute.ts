/**
 * Which of Google's routes best matches what a mileage line claims — the one a saved
 * line's map draws.
 *
 * Each time a saved line's map is shown, the server asks Google for the line's route and
 * draws the one whose total distance is closest to the CLAIM, so the map shown beside a
 * 412 km claim is the 415 km route, not the 398 km one Google lists first. The claim
 * itself never changes: this only chooses which path to draw.
 *
 * "The claim" is `mileageDistanceOverride ?? mileageDistance`, in the line's `mileageUnit`
 * — the same expression the year-to-date basis uses (`server/lib/mileage.ts`), so two parts
 * of the product cannot disagree about one row. Compared in metres, the unit Google's legs
 * are in.
 *
 * Pure and import-free, so it is testable with no clock and no database, and safe for any
 * bundle. Today the server is its only caller: `mileageRoute.lineRoutePath`, which draws a
 * saved line's map.
 */

/** Metres in one claim unit: a kilometre, and an international mile. */
const METRES_PER_UNIT = { KM: 1000, MI: 1609.344 } as const;

/** What a line says it travelled, as the database holds it (decimals as text). */
export interface LineClaim {
  mileageDistance: string | null;
  mileageDistanceOverride: string | null;
  mileageUnit: 'KM' | 'MI' | null;
}

/**
 * The claim in metres, or null when the line carries no usable distance. A line with a
 * distance always has a unit (the line is priced in its mileage rule's unit); a missing
 * unit is read as KM, the form's default.
 */
export function claimedMeters(line: LineClaim): number | null {
  const raw = line.mileageDistanceOverride ?? line.mileageDistance;
  if (raw == null || raw.trim() === '') return null;
  const distance = Number(raw);
  if (!Number.isFinite(distance) || distance < 0) return null;
  return distance * METRES_PER_UNIT[line.mileageUnit ?? 'KM'];
}

/**
 * The route whose `totalMeters` is closest to `claim`. A tie goes to the first of them in
 * the order given, which is Google's (a strict `<`, so a later equal route never wins).
 * With no claim the first route is the answer; with no routes, null.
 */
export function pickClosestRoute<T extends { totalMeters: number }>(
  routes: readonly T[],
  claim: number | null,
): T | null {
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const route of routes) {
    if (claim === null) return route;
    const gap = Math.abs(route.totalMeters - claim);
    if (gap < bestGap) {
      best = route;
      bestGap = gap;
    }
  }
  return best;
}

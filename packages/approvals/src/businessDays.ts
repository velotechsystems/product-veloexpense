/**
 * Business-day arithmetic for approval TTLs. Weekends (Sat/Sun) are skipped;
 * holidays are not modeled yet (a future per-tenant calendar could refine this).
 */

/** Default approval deadline when a node doesn't set its own ttlBusinessDays. */
export const DEFAULT_TTL_BUSINESS_DAYS = 5;

/** `from` advanced by `n` business days (skipping weekends). */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

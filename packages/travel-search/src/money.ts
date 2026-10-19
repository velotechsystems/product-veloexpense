/**
 * Provider prices → minor units.
 *
 * SerpApi reports money as major-unit JSON numbers (`price: 512.34`). Everything
 * downstream of here is BigInt minor units, because a budget that was approved,
 * an expense that was reimbursed and a report that was posted all have to agree to
 * the cent — and a float that has been through a JSON parse and a multiplication
 * does not reliably agree with anything.
 *
 * The conversion happens ONCE, here, at the provider boundary. A number that got
 * past this module as a float would be a float in the approved budget.
 */

import { getCurrency } from '@expenseos/money';

/** ISO-4217 exponent, defaulting to 2. Never throws: an unrecognised provider
 *  currency must not take down a search. */
function exponentOf(currency: string): number {
  try {
    return getCurrency(currency).exponent;
  } catch {
    return 2;
  }
}

/**
 * A provider's major-unit number as minor units, or null when it isn't a usable
 * number.
 *
 * Null rather than zero: a missing price and a free flight are different facts, and
 * a budget line silently worth 0 is worse than one the UI can say it doesn't know.
 *
 * Rounds half-away-from-zero on the last unit, which is what a human reading
 * "512.345 → 512.35" expects; the alternative (truncation) would systematically
 * under-budget every line by up to a cent.
 */
export function toMinor(value: unknown, currency: string): bigint | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** exponentOf(currency);
  return BigInt(Math.round(Math.abs(n) * scale)) * (n < 0 ? -1n : 1n);
}

/** `toMinor` for a value the caller has already established must exist. Returns 0n
 *  rather than null so arithmetic doesn't need a guard at every call site — used
 *  only where a missing figure genuinely means nothing was charged. */
export function toMinorOrZero(value: unknown, currency: string): bigint {
  return toMinor(value, currency) ?? 0n;
}

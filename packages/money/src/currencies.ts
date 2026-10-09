/**
 * Currency lookup — wraps the per-currency objects re-exported from
 * `dinero.js` so callers ask by ISO-4217 string (matching the DB)
 * rather than importing each currency individually.
 *
 * dinero.js v2 ships one named export per ISO code, each a
 * `DineroCurrency<number>` of shape `{ code, base, exponent }`. We
 * fold them into a code → object map at module load so a DB row's
 * `currencyCode` lookup is O(1).
 */

import type { DineroCurrency } from 'dinero.js';
import * as ALL from 'dinero.js';

type AnyCurrency = DineroCurrency<number>;

/** Build the code -> Currency map once at module load. */
const BY_CODE: Record<string, AnyCurrency> = (() => {
  const out: Record<string, AnyCurrency> = {};
  for (const entry of Object.values(ALL as Record<string, unknown>)) {
    // Each export is either a DineroCurrency object or a helper
    // function — guard on the shape so future additions don't
    // pollute the map.
    if (
      entry &&
      typeof entry === 'object' &&
      'code' in (entry as object) &&
      'base' in (entry as object) &&
      'exponent' in (entry as object)
    ) {
      const c = entry as AnyCurrency;
      out[c.code] = c;
    }
  }
  return out;
})();

/** True when the ISO-4217 code is known to dinero. */
export function isKnownCurrency(code: string): boolean {
  return Object.hasOwn(BY_CODE, code.toUpperCase());
}

/**
 * Look up the dinero currency object for an ISO-4217 code. Throws when
 * the code isn't recognised — callers should validate upstream (the
 * `Currency` table in the DB is the gate for allowed codes; runtime
 * mismatches here mean someone bypassed the gate).
 */
export function getCurrency(code: string): AnyCurrency {
  const c = BY_CODE[code.toUpperCase()];
  if (!c) throw new Error(`Unknown currency code: ${code}`);
  return c;
}

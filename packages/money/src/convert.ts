/**
 * Cross-currency conversion using a snapshot of FX rates.
 *
 * The caller passes a rate map keyed `${from}->${to}` (matching the
 * shape the policy engine already builds from the `FxRate` table) and
 * the helper does the integer-precise multiplication using dinero's
 * `multiply` + `convert` operators.
 *
 * Semantics:
 *   - same-currency → returns the input unchanged
 *   - missing rate  → returns null (callers decide whether to emit a
 *                      diagnostic, default to the source currency, etc.)
 *
 * Why BigInt math under the hood:
 *   FX rates carry 8 decimal places (Decimal(18,8)). Naïve float
 *   multiplication drifts on long-tail rates (e.g. JPY → USD where
 *   one unit costs ~0.0067 USD). dinero multiplies via integer
 *   scaling — exact, no drift.
 */

import { allocate, convert, type Dinero, halfEven, transformScale } from 'dinero.js';
import { getCurrency } from './currencies';
import { fromDinero, toDinero } from './dinero';
import type { Money } from './money';

export interface FxRateMap {
  /** Key shape: `${baseCode}->${quoteCode}`. Value is the rate as a
   *  decimal string (matches the policy engine's `FxRate.rate` shape). */
  get(key: string): string | undefined;
}

export function convertMoney(amount: Money, toCode: string, rates: FxRateMap): Money | null {
  if (amount.currencyCode === toCode) return amount;
  const key = `${amount.currencyCode}->${toCode}`;
  const rate = rates.get(key);
  if (!rate) return null;

  // Use dinero's `convert` op: it takes the source handle, the
  // destination currency, and a rates record { code: { amount, scale } }.
  // The rate string "1.23456789" → { amount: 123456789, scale: 8 }
  // preserves all 8 decimal places without ever touching JS floats.
  const [whole, frac = ''] = rate.split('.');
  const scale = frac.length;
  const amountInt = Number(whole + frac);
  if (!Number.isSafeInteger(amountInt)) {
    throw new Error(`FX rate ${rate} would overflow Number.MAX_SAFE_INTEGER after scaling`);
  }
  const source = toDinero(amount);
  const destinationCurrency = getCurrency(toCode);
  const converted: Dinero<number> = convert(source, destinationCurrency, {
    [destinationCurrency.code]: { amount: amountInt, scale },
  });
  // dinero's `convert` widens the working scale to `source.scale + rate.scale`
  // to preserve precision, so the raw snapshot amount is `cents × 10^rateDecimals`
  // — NOT minor units. Bring it back down to the destination currency's ISO
  // exponent so `amountMinor` is real cents (e.g. 10000 USD × 1.37 → 13700 CAD,
  // not 1370000). Round half-even to match `allocate`'s banker's rounding.
  const normalized = transformScale(converted, destinationCurrency.exponent, halfEven);
  return fromDinero(normalized);
}

// Re-export `allocate` (proportional split, banker's rounding) so
// consumers that want to split a charge across N line items don't have
// to import dinero directly.
export { allocate };

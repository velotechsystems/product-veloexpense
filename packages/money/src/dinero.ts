/**
 * Bridge between the persisted `Money` shape and dinero.js handles.
 *
 * The dinero v2 API is immutable: every operation (add, subtract, …)
 * returns a new handle. The `Money` shape is what we persist; the
 * handle is what we compute on. Always convert at boundaries.
 *
 * Note: dinero accepts `amount` as a number. JavaScript numbers are
 * precise up to 2^53; line-item amounts can't exceed this in realistic
 * usage (≈90 trillion USD cents). We narrow BigInt → Number at the
 * boundary and throw if the input would silently lose precision so the
 * miscompare surfaces early.
 */

import { type Dinero, dinero, toSnapshot } from 'dinero.js';
import { getCurrency } from './currencies';
import type { Money } from './money';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

/** BigInt → number with overflow guard. */
function safeNumber(b: bigint): number {
  if (b > MAX_SAFE_BIGINT || b < MIN_SAFE_BIGINT) {
    throw new Error(
      `amountMinor ${b.toString()} exceeds Number.MAX_SAFE_INTEGER; ` +
        'split the value across multiple operations or extend the helper to chunk.',
    );
  }
  return Number(b);
}

export function toDinero(m: Money): Dinero<number> {
  return dinero({ amount: safeNumber(m.amountMinor), currency: getCurrency(m.currencyCode) });
}

export function fromDinero(d: Dinero<number>): Money {
  const snap = toSnapshot(d);
  return { amountMinor: BigInt(snap.amount), currencyCode: snap.currency.code };
}

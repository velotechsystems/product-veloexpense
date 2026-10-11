import type { ReceiptExtraction } from './schema';

/**
 * Do a document's line items represent PURCHASES, or purchases plus tax?
 *
 * The distinction decides whether per-line categories can be trusted, and it is not a
 * detail. A US hotel folio prints its taxes as rows in the same table as the room
 * charge — Occupancy Tax, City Tax, State Tax, a destination fee — because that is how
 * a folio is laid out. The extraction schema has fields for GST/HST/QST/PST only, so on
 * a US document the model has nowhere to put them and returns them as line items,
 * which is the sane thing to do with an impossible instruction.
 *
 * **Non-Canadian tax is deliberately not collected** (product decision). It is
 * non-recoverable, so it belongs inside the cost of the line that incurred it rather
 * than broken out — which is exactly where this leaves it. The job here is therefore
 * not to capture those rows, it is to stop them becoming expense lines of their own.
 *
 * Left alone, those rows become EXPENSE LINES. On the sample folio the model happened
 * to tag all five rows as lodging, so they collapsed into one correct $346.61 line —
 * but that was luck. Tag "City Tax" as Miscellaneous instead, which the per-line
 * category instruction positively invites, and a $17.57 miscellaneous expense appears
 * for something that is a tax.
 *
 * So the test is arithmetic rather than textual. Keyword-matching descriptions would
 * mean maintaining a list across locales (TPS/TVH/TVQ, VAT, IVA, occupancy, levy) and
 * would still miss "Javits Center Fee", which is a government charge that never says
 * "tax". The sums say it plainly instead:
 *
 *   · lines ≈ SUBTOTAL → the lines are pre-tax purchases, tax is in the tax fields,
 *                        and each line's own category is meaningful.
 *   · lines ≈ TOTAL    → the lines already include tax, so at least one of them IS
 *                        tax and none of their categories can be trusted.
 *   · neither          → the set does not reconcile; treat it as untrustworthy.
 *
 * Getting this wrong in the safe direction costs only granularity: the caller falls
 * back to one line carrying the document total, so the AMOUNT is never wrong — only
 * the split is coarser. That asymmetry is why the ambiguous case resolves to "do not
 * trust".
 */

/** Sum of the positively-priced line amounts, in minor units. */
function sumPricedMinor(ex: ReceiptExtraction, toMinor: (n: number) => bigint): bigint {
  return (ex.lineItems ?? [])
    .map((li) => li.amount ?? 0)
    .filter((a) => a > 0)
    .reduce((acc, a) => acc + toMinor(a), 0n);
}

const abs = (v: bigint) => (v < 0n ? -v : v);

export interface LineReconciliation {
  /** Whether each line's own `categoryCode` may be used. */
  trustPerLine: boolean;
  /** Which figure the lines matched — for logging and for tests to assert on. */
  matched: 'subtotal' | 'total' | 'neither';
}

/**
 * @param toMinor converts a decimal amount to minor units at the document's currency
 *                exponent — passed in because only the caller knows the currency.
 * @param lineCount used for the rounding tolerance: each line may round by up to one
 *                  minor unit, so a five-line receipt can legitimately differ by five.
 */
export function reconcileLineItems(
  ex: ReceiptExtraction,
  toMinor: (n: number) => bigint,
): LineReconciliation {
  const lines = (ex.lineItems ?? []).filter((li) => (li.amount ?? 0) > 0);
  if (lines.length < 2) return { trustPerLine: false, matched: 'neither' };

  const sum = sumPricedMinor(ex, toMinor);
  // One minor unit of slack per line, plus one, absorbs per-line rounding without
  // letting a genuinely different figure match.
  const tolerance = BigInt(lines.length + 1);

  const subtotal = ex.subtotal == null ? null : toMinor(ex.subtotal);
  const total = ex.total == null ? null : toMinor(ex.total);

  // Subtotal first, deliberately. On a tax-free receipt subtotal equals total and both
  // match; the lines are still purchases, so the permissive-but-correct reading wins.
  if (subtotal != null && abs(sum - subtotal) <= tolerance) {
    return { trustPerLine: true, matched: 'subtotal' };
  }
  if (total != null && abs(sum - total) <= tolerance) {
    return { trustPerLine: false, matched: 'total' };
  }
  return { trustPerLine: false, matched: 'neither' };
}

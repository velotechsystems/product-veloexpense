/**
 * Composing the GL lines an expense posts.
 *
 * A receipt is one amount to a human and several lines to an accountant, and the
 * split is not obvious:
 *
 *   • The tax an entity CAN reclaim is not a cost. It posts to its own GL account
 *     as a receivable from the tax authority — one line per tax, per expense.
 *   • The tax it CANNOT reclaim IS a cost, and it belongs to the thing that
 *     incurred it. So it is capitalised into that line's own amount rather than
 *     posted anywhere separately. Two lines on one receipt at different ITC rates
 *     capitalise different amounts (rule 4).
 *   • A US entity reclaims nothing, so sales tax is entirely capitalised and NO
 *     tax line is posted at all (rule 3). This falls out of `entityRecovers`
 *     being false — there is no US branch in here.
 *   • A tip is already inside its line's amount and is not taxable, so it needs
 *     no line of its own; it simply isn't in the taxable base upstream.
 *
 * The invariant the tests hold this to: the composed lines sum EXACTLY to the
 * expense's gross. Nothing may be lost or invented by the split, because that
 * sum is what NetSuite will accept or reject.
 *
 * Pure: no DB, no GL account resolution. The caller maps a `TaxKind` to the
 * configured account for the entity — this module decides the amounts.
 */

import { allocateProportional, nonRecoverablePerLine, type RecoverableLine } from './recoverable';

/** Which tax a recoverable line represents. The caller resolves each to the GL
 *  account configured for the posting entity. */
export type TaxKind = 'GST_HST' | 'QST';

export interface PostingLineInput extends RecoverableLine {
  /** Opaque handle the caller uses to tie a composed line back to its source
   *  (an `ExpenseLineItem.id`). Never interpreted here. */
  ref: string;
}

export interface ComposePostingParams {
  /** The expense total, tax inclusive — what the employee paid. */
  grossMinor: bigint;
  gstHstMinor: bigint;
  qstMinor: bigint;
  /** PST/QST-style tax that is never recoverable by anyone. Capitalised whole. */
  pstMinor?: bigint;
  lines: PostingLineInput[];
  /** `LegalEntity.itcRecoverable`. False → every tax is capitalised and no tax
   *  line is emitted. */
  entityRecovers: boolean;
}

/** An expense line as posted: its own cost plus the tax it can't reclaim. */
export interface PostedExpenseLine {
  ref: string;
  /** The line's share of the expense, tax-exclusive. */
  netMinor: bigint;
  /** The tax capitalised into this line (non-recoverable GST/HST + QST + PST). */
  capitalisedTaxMinor: bigint;
  /** What actually posts: `netMinor + capitalisedTaxMinor`. */
  amountMinor: bigint;
}

/** A recoverable tax line — a receivable, not a cost. */
export interface PostedTaxLine {
  kind: TaxKind;
  amountMinor: bigint;
}

export interface PostingComposition {
  expenseLines: PostedExpenseLine[];
  /** Empty for a non-recovering entity, and empty when the recoverable slice
   *  rounds to zero — a $0.00 GL line is noise NetSuite doesn't need. A refund's
   *  line is negative and IS emitted. */
  taxLines: PostedTaxLine[];
  /** Sum of every emitted line. Equals `grossMinor` by construction; returned so
   *  callers can assert it rather than trusting it. */
  totalMinor: bigint;
}

export function composePosting(params: ComposePostingParams): PostingComposition {
  const { grossMinor, gstHstMinor, qstMinor, lines, entityRecovers } = params;
  const pstMinor = params.pstMinor ?? 0n;

  if (lines.length === 0) {
    return { expenseLines: [], taxLines: [], totalMinor: 0n };
  }

  const weights = lines.map((l) => l.amountMinor);
  const capitalised = nonRecoverablePerLine({ gstHstMinor, qstMinor, lines, entityRecovers });
  // PST is never recoverable, so it is capitalised in full — split by the same
  // weights so it lands on the lines that caused it.
  const pstShare = allocateProportional(pstMinor, weights);

  const recoverableGst = entityRecovers
    ? gstHstMinor - sumOf(splitRecoverable(gstHstMinor, lines, (l) => l.itcGstHstRate))
    : 0n;
  const recoverableQst = entityRecovers
    ? qstMinor - sumOf(splitRecoverable(qstMinor, lines, (l) => l.itcQstRate))
    : 0n;

  // Non-zero, not positive: a refund's credit is a NEGATIVE receivable and has
  // to post, or the original claim's ITC is never reversed.
  const taxLines: PostedTaxLine[] = [];
  if (recoverableGst !== 0n) taxLines.push({ kind: 'GST_HST', amountMinor: recoverableGst });
  if (recoverableQst !== 0n) taxLines.push({ kind: 'QST', amountMinor: recoverableQst });
  const recoverableTotal = recoverableGst + recoverableQst;

  // The lines share what is left after the recoverable tax is carved out. That
  // residual — not the raw line amounts — is what must add up, so it is split by
  // largest remainder and the leftover cent goes to the largest line rather than
  // being dropped.
  const netTotal = grossMinor - recoverableTotal - sumOf(capitalised) - sumOf(pstShare);
  const netShare = allocateProportional(netTotal, weights);

  const expenseLines = lines.map((l, i) => {
    const capitalisedTaxMinor = capitalised[i] + pstShare[i];
    return {
      ref: l.ref,
      netMinor: netShare[i],
      capitalisedTaxMinor,
      amountMinor: netShare[i] + capitalisedTaxMinor,
    };
  });

  return {
    expenseLines,
    taxLines,
    totalMinor: sumOf(expenseLines.map((l) => l.amountMinor)) + recoverableTotal,
  };
}

/**
 * The NON-recoverable share of one tax, per line. Written in terms of the same
 * `allocateProportional` + per-line rate arithmetic `allocateRecoverable` uses,
 * so "recoverable + non-recoverable = the tax" holds to the cent — deriving the
 * recoverable total independently would let the two drift by rounding.
 */
function splitRecoverable(
  total: bigint,
  lines: readonly RecoverableLine[],
  rateOf: (l: RecoverableLine) => number,
): bigint[] {
  const share = allocateProportional(
    total,
    lines.map((l) => l.amountMinor),
  );
  return share.map((s, i) => s - (s * BigInt(Math.max(0, rateOf(lines[i])))) / 100n);
}

function sumOf(values: readonly bigint[]): bigint {
  return values.reduce((a, v) => a + v, 0n);
}

/**
 * Convert a composed posting into the entity's home currency at a single rate.
 *
 * NetSuite receives both: the foreign amount with its currency and rate, and the
 * converted amount (rule 7). Conversion happens AFTER composition and per line,
 * with the residual forced onto the largest line, so the converted lines still
 * sum to the converted total — converting each line independently and hoping is
 * how a report arrives at NetSuite one cent short.
 */
export function convertComposition(
  composition: PostingComposition,
  homeTotalMinor: bigint,
): PostingComposition {
  const all = [
    ...composition.expenseLines.map((l) => l.amountMinor),
    ...composition.taxLines.map((l) => l.amountMinor),
  ];
  const converted = allocateProportional(homeTotalMinor, all);
  const expenseCount = composition.expenseLines.length;
  return {
    expenseLines: composition.expenseLines.map((l, i) => {
      const amountMinor = converted[i];
      // Keep the net/capitalised split proportionate within the converted line
      // so the two parts still add to it.
      const parts = allocateProportional(amountMinor, [l.netMinor, l.capitalisedTaxMinor]);
      return { ref: l.ref, netMinor: parts[0], capitalisedTaxMinor: parts[1], amountMinor };
    }),
    taxLines: composition.taxLines.map((l, i) => ({
      kind: l.kind,
      amountMinor: converted[expenseCount + i],
    })),
    totalMinor: homeTotalMinor,
  };
}

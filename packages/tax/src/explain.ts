/**
 * Why a tax figure came out the way it did.
 *
 * `computeTax` returns numbers. When somebody asks "why is my recoverable ITC zero?", the
 * numbers are exactly what cannot answer them — the reason lives in which branch ran and
 * which input decided it, and that information is discarded today.
 *
 * This re-runs the real engine and returns its result **unchanged**, alongside a trace of how
 * it got there. It deliberately does not reimplement the arithmetic: a second implementation
 * would eventually disagree with the first, and the explanation would then be confidently
 * wrong about the number on the screen.
 *
 * ## Why this exists at all
 *
 * The assistant must never reason about money. Asked "why is this zero" with only the figures
 * in context, a model will produce a fluent and plausible tax rationale — and it has no way to
 * know whether the cause was a foreign jurisdiction, a non-eligible category, or an extraction
 * that read no tax off the receipt. Those are three different answers and only one is true.
 * So the engine says which, and the model reads it out.
 *
 * The same trace drives a "why is this zero?" tooltip in the workbench, which is worth having
 * whether or not a chat surface ever ships.
 */

import { computeTax } from './engine';
import type { CategoryItc, JurisdictionRates, TaxInput, TaxResult } from './types';

/**
 * Why a recoverable figure is zero.
 *
 * A closed set, because the engine has a closed set of ways to produce one. Each maps to a
 * different thing the reader should do — or, in two cases, to "nothing is wrong".
 */
export type ZeroReason =
  /** No Canadian tax was charged, and none was provided. Foreign tax stays in the line cost
   *  by decision — it is non-recoverable, so there is nothing to split out. Nothing is wrong. */
  | 'FOREIGN_JURISDICTION'
  /** The jurisdiction is configured with all-zero rates. That is a configuration problem,
   *  not a property of the expense. */
  | 'ZERO_RATE_JURISDICTION'
  /** There is no taxable amount to tax — an expense with no line items yet, or one whose
   *  whole value is an untaxed tip. Nothing is misconfigured and nothing is foreign; there
   *  is simply nothing there. */
  | 'NO_TAXABLE_AMOUNT'
  /** Tax was supplied (manual entry or receipt extraction) and it was zero. Either the receipt
   *  showed none, or extraction missed it — worth a human looking at the receipt. */
  | 'PROVIDED_ZERO'
  /** Tax was charged, but this category recovers 0% of it. Entertainment, typically. */
  | 'CATEGORY_NOT_RECOVERABLE'
  /** Tax was charged and the category recovers some, but the amount rounded to zero. Only
   *  reachable on trivially small amounts. */
  | 'ROUNDS_TO_ZERO';

/** Which path through the engine ran. */
export type TaxBranch = 'EXPLICIT' | 'CANADIAN_REVERSE_CALC' | 'US_SALES_TAX' | 'NO_TAX_APPLICABLE';

export interface RecoverableExplanation {
  readonly amountMinor: bigint;
  /** Null when the amount is non-zero — there is nothing to explain. */
  readonly zeroReason: ZeroReason | null;
  /** The ITC percentage that applied, for the narration. */
  readonly itcRate: number;
  /** The tax this recovery was a percentage OF. */
  readonly taxBaseMinor: bigint;
}

export interface TaxTrace {
  readonly branch: TaxBranch;
  /** True when any Canadian rate is non-zero — the engine's own test for "Canadian". */
  readonly isCanadianJurisdiction: boolean;
  readonly jurisdiction: JurisdictionRates;
  readonly category: CategoryItc;
  /** Amounts supplied by manual entry or extraction, if any. */
  readonly explicitProvided: boolean;
  readonly grossMinor: bigint;
  readonly gstHst: RecoverableExplanation;
  readonly qst: RecoverableExplanation;
  /** PST is never recoverable in Canada; carried for completeness. */
  readonly pstRecoverable: boolean;
}

/** Which branch `computeTax` took, mirroring its conditions in the same order. */
function branchOf(input: TaxInput, isCanadian: boolean, explicitProvided: boolean): TaxBranch {
  if (explicitProvided) return 'EXPLICIT';
  if (isCanadian) return 'CANADIAN_REVERSE_CALC';
  if (input.jurisdiction.salesTaxRate > 0) return 'US_SALES_TAX';
  return 'NO_TAX_APPLICABLE';
}

/**
 * Work out why one recoverable figure is zero.
 *
 * Order matters, and it is the order a person would ask in: was there any tax at all, and if
 * so why did none of it come back? Reporting `CATEGORY_NOT_RECOVERABLE` for an expense that
 * was never taxed would be true of the category and useless to the reader.
 */
function explainRecoverable(
  amountMinor: bigint,
  taxBaseMinor: bigint,
  itcRate: number,
  branch: TaxBranch,
  isCanadian: boolean,
  grossMinor: bigint,
): RecoverableExplanation {
  const base = { amountMinor, itcRate, taxBaseMinor };
  if (amountMinor > 0n) return { ...base, zeroReason: null };

  if (taxBaseMinor === 0n) {
    if (branch === 'EXPLICIT') return { ...base, zeroReason: 'PROVIDED_ZERO' };
    // Before anything about the jurisdiction: an expense with nothing in it yet is not a
    // configuration problem and not a foreign expense. Reporting either would send somebody
    // to check tax setup over an expense they simply have not filled in — and
    // `ZERO_RATE_JURISDICTION` would be a false statement about a province that does have
    // rates.
    if (grossMinor === 0n) return { ...base, zeroReason: 'NO_TAXABLE_AMOUNT' };
    // A US sales-tax expense has no GST/HST to recover for the same reason a no-tax one
    // does not: the tax that was charged is not a Canadian input tax credit.
    if (!isCanadian) return { ...base, zeroReason: 'FOREIGN_JURISDICTION' };
    return { ...base, zeroReason: 'ZERO_RATE_JURISDICTION' };
  }

  if (itcRate <= 0) return { ...base, zeroReason: 'CATEGORY_NOT_RECOVERABLE' };
  // Tax was charged and the category recovers some of it, yet the result is zero — only
  // possible when the amount is small enough to round away.
  return { ...base, zeroReason: 'ROUNDS_TO_ZERO' };
}

/**
 * Run the engine and explain the result.
 *
 * The returned `TaxResult` fields are `computeTax`'s own, untouched.
 */
export function explainTax(input: TaxInput): TaxResult & { trace: TaxTrace } {
  const result = computeTax(input);
  const j = input.jurisdiction;
  const isCanadian = j.gstRate > 0 || j.hstRate > 0 || j.pstRate > 0 || j.qstRate > 0;
  const explicitProvided = result.source === 'PROVIDED';
  const branch = branchOf(input, isCanadian, explicitProvided);

  return {
    ...result,
    trace: {
      branch,
      isCanadianJurisdiction: isCanadian,
      jurisdiction: j,
      category: input.category,
      explicitProvided,
      grossMinor: input.grossMinor,
      gstHst: explainRecoverable(
        result.recoverableGstHstMinor,
        result.gstHstMinor,
        input.category.itcGstHstRate,
        branch,
        isCanadian,
        input.grossMinor,
      ),
      qst: explainRecoverable(
        result.recoverableQstMinor,
        result.qstMinor,
        input.category.itcQstRate,
        branch,
        isCanadian,
        input.grossMinor,
      ),
      pstRecoverable: input.category.pstRecoverable,
    },
  };
}

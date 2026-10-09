/**
 * Public surface of `@expenseos/tax`.
 *
 * A pure, server-authoritative tax engine: reverse-calculates or accepts
 * explicit GST/HST/PST/QST on a tax-inclusive amount and applies category ITC
 * recoverability (CRA). Rates come from `TaxJurisdiction` and ITC flags from
 * `ExpenseCategory` (both seeded from docs/legacy/business-rules.md §1).
 */

export { computeTax } from './engine';
export {
  explainTax,
  type RecoverableExplanation,
  type TaxBranch,
  type TaxTrace,
  type ZeroReason,
} from './explain';
export {
  type ComposePostingParams,
  composePosting,
  convertComposition,
  type PostedExpenseLine,
  type PostedTaxLine,
  type PostingComposition,
  type PostingLineInput,
  type TaxKind,
} from './posting';
export {
  type AllocateRecoverableParams,
  allocateProportional,
  allocateRecoverable,
  nonRecoverablePerLine,
  type RecoverableLine,
  type RecoverableResult,
} from './recoverable';
export {
  type CreditExplanation,
  explainRecoverable,
  type LineRecovery,
  type RecoverableTrace,
  type RecoverableZeroReason,
} from './recoverable-explain';
export type {
  CategoryItc,
  ExplicitTax,
  JurisdictionRates,
  TaxInput,
  TaxResult,
} from './types';

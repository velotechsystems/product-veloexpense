/**
 * ExpenseOS's `@expenseos/db` helpers, as far as Wave 2 has ported them.
 *
 * VeloExpense: ExpenseOS's package also owns its Prisma client and schema. VeloExpense's
 * client is generated into lib/generated/prisma and reached through the tenant-scoped
 * `db` (lib/db/prisma.ts), so this package re-exports only the shared domain helpers the
 * ported routers import, the generated `Prisma` namespace, and VeloExpense's text enums
 * (`./enums`). Each helper arrives with the slice whose code calls it.
 */
export { Prisma, type PrismaClient } from '@/lib/generated/prisma/client';
export {
  DocExtractStatus,
  DocScanStatus,
  ExpenseLineKind,
  ExpensePaymentMethod,
  ExpenseReportStatus,
  ExpenseTaxSource,
  FxRateSource,
  MileageUnit,
  ReceiptKind,
} from './enums';
// Which business unit column wins, and what a new expense is coded to — VeloExpense has
// only ExpenseOS's EXPENSEOS position (see the module).
export {
  type BusinessUnitSource,
  type CodingDefaultsFor,
  type CodingDefaultsUser,
  codingDefaultsFor,
} from './businessUnitSource';
export {
  allocationCreateFor,
  type CodingDefaults,
  type DefaultAllocation,
  defaultAllocationFrom,
} from './expenseCodingDefaults';
// Currency conversion at the expense level (rule 3) — the web writes it on every
// line change, the worker on extraction, so it lives beside the rest of the
// shared Prisma domain helpers.
export {
  EXPENSE_FX_SELECT,
  type ExpenseFxRow,
  fxColumns,
  fxParamsFrom,
  type ResolvedExpenseFx,
  type ResolveExpenseFxParams,
  resolveExpenseFx,
  snapshotExpensesFx,
} from './expenseFx';
// Stamping a line's GL account from its category — one helper for the four places
// that write expense line items, so they cannot drift.
export { glAccountIdForCategory, glAccountIdsForCategories } from './glAccount';
// Report-total roll-up — shared by the web routers and the worker's prefill so
// one report never has two totals.
export {
  fxOverrideOf,
  isReportTotalFrozenError,
  POSTED_SYNC_STATUSES,
  RECOMPUTABLE_REPORT_STATUSES,
  type RecomputeReportTotalOptions,
  type RecomputeReportTotalResult,
  type ReportTotalDb,
  ReportTotalFrozenError,
  recomputeReportTotal,
  reportRollupFor,
} from './reportTotal';
// Creating the expenses a batch of receipts hangs off (Wave 2, w2-09).
export {
  type BlankExpenseInput,
  createBlankExpensesForReceipts,
  createReportFromReceipts,
  type ReportFromReceiptsInput,
  resolveIntakeCurrencyId,
} from './receiptIntake';
// Wave 3 (w3-02a). The determination record — what a pass concluded and what a human
// changed afterwards. Shared because the worker writes determinations and the web records
// the corrections that must survive the next rebuild (rule 2).
export {
  type CurrentDetermination,
  currentDetermination,
  type OverrideField,
  type OverrideMap,
  overridesForPrompt,
  overridesOf,
  recordOverrides,
  supersedeDetermination,
} from './determination';
// The merchant's printed transaction/auth number, persisted so a later duplicate
// check has something better than vendor + date + total to go on.
export {
  expensesWithTransactionId,
  MERCHANT_RECEIPT_SOURCE,
  merchantReceiptSourceId,
  normalizeTransactionId,
  type RecordTransactionIdInput,
  recordTransactionId,
} from './receiptTransactionId';

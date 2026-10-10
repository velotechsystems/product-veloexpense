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
  ExpenseLineKind,
  ExpensePaymentMethod,
  ExpenseReportStatus,
  ExpenseTaxSource,
  FxRateSource,
  MileageUnit,
  ReceiptKind,
} from './enums';
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

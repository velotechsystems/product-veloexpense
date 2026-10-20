/**
 * VeloExpense: ExpenseOS's Prisma enums for the expense core, as values and types.
 *
 * ExpenseOS declares these as Postgres enums, so its generated client exports them.
 * VeloExpense stores them as text with a CHECK listing the same values (migration
 * 0054), so the generated client has none; ported code that reads
 * `ExpensePaymentMethod.OUT_OF_POCKET` or types a field `FxRateSource` reads these
 * instead. The report status was a Postgres enum in VeloExpense already and comes
 * from the generated client.
 */
export { ExpenseReportStatus } from '@/lib/generated/prisma/enums';

export const ExpensePaymentMethod = {
  OUT_OF_POCKET: 'OUT_OF_POCKET',
  VIRTUAL_CARD: 'VIRTUAL_CARD',
  PHYSICAL_CARD: 'PHYSICAL_CARD',
} as const;
export type ExpensePaymentMethod = (typeof ExpensePaymentMethod)[keyof typeof ExpensePaymentMethod];

export const ExpenseTaxSource = {
  MANUAL: 'MANUAL',
  EXTRACTED: 'EXTRACTED',
  CALCULATED: 'CALCULATED',
} as const;
export type ExpenseTaxSource = (typeof ExpenseTaxSource)[keyof typeof ExpenseTaxSource];

export const FxRateSource = {
  MANUAL: 'MANUAL',
  EXTRACTED: 'EXTRACTED',
  CALCULATED: 'CALCULATED',
} as const;
export type FxRateSource = (typeof FxRateSource)[keyof typeof FxRateSource];

export const ExpenseLineKind = {
  STANDARD: 'STANDARD',
  STANDARD_WITH_TIP: 'STANDARD_WITH_TIP',
  MILEAGE: 'MILEAGE',
} as const;
export type ExpenseLineKind = (typeof ExpenseLineKind)[keyof typeof ExpenseLineKind];

export const MileageUnit = { KM: 'KM', MI: 'MI' } as const;
export type MileageUnit = (typeof MileageUnit)[keyof typeof MileageUnit];

export const ReceiptKind = {
  RECEIPT: 'RECEIPT',
  ITEMIZED_BILL: 'ITEMIZED_BILL',
  CARD_COPY: 'CARD_COPY',
  BANK_STATEMENT: 'BANK_STATEMENT',
  OTHER: 'OTHER',
} as const;
export type ReceiptKind = (typeof ReceiptKind)[keyof typeof ReceiptKind];

// VeloExpense: ExpenseOS's receipt-reading lifecycle, carried by `document_extraction`
// (0056, w3-01) as text with CHECKs; these are the values those CHECKs allow.
export const DocScanStatus = {
  PENDING: 'PENDING',
  SCANNING: 'SCANNING',
  CLEAN: 'CLEAN',
  INFECTED: 'INFECTED',
  FAILED: 'FAILED',
} as const;
export type DocScanStatus = (typeof DocScanStatus)[keyof typeof DocScanStatus];

export const DocExtractStatus = {
  PENDING: 'PENDING',
  EXTRACTING: 'EXTRACTING',
  EXTRACTED: 'EXTRACTED',
  FAILED: 'FAILED',
} as const;
export type DocExtractStatus = (typeof DocExtractStatus)[keyof typeof DocExtractStatus];

/**
 * w4-02a: the policy engine's two enums (ExpenseOS's `PolicyViolationSeverity` and
 * `RuleScope`). VeloExpense: severity is the `policy_severity` Postgres enum (0006) that
 * the policy tables already use, so it comes from the generated client (w4-02b) as the
 * report status does; the scope is text with a CHECK on `policy_rule` (0064).
 * ExpenseOS's fourth scope, `TRAVEL_REQUEST`, is not here: travel is out of VeloExpense's
 * scope, and so are the rule kinds that use it.
 */
export { PolicyViolationSeverity } from '@/lib/generated/prisma/enums';

export const RuleScope = { LINE: 'LINE', REPORT: 'REPORT', AGGREGATE: 'AGGREGATE' } as const;
export type RuleScope = (typeof RuleScope)[keyof typeof RuleScope];

/**
 * w6-04: ExpenseOS's `ApiKeyKind` (who a key acts as). Text with a CHECK here (0079).
 * `USER` is a personal token acting as its owner; `PLATFORM` is a service account that
 * names its subject per request.
 */
export const ApiKeyKind = {
  USER: 'USER',
  PLATFORM: 'PLATFORM',
} as const;
export type ApiKeyKind = (typeof ApiKeyKind)[keyof typeof ApiKeyKind];

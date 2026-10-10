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

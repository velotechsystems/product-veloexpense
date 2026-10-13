/**
 * w4-02a: ExpenseOS's `ExpensePolicy` model — the per-category limits — as a type.
 *
 * VeloExpense: ExpenseOS's generated client exports this from its schema. VeloExpense's
 * per-category policy table arrives with w4-02d (d63), so until then this is the model's
 * shape, field for field (ExpenseOS `packages/db/prisma/schema.prisma`, `ExpensePolicy`),
 * for the built-in rule kinds that read it. Nothing loads one yet: the engine is unused
 * until the cutover (w4-02c), and an empty map is "no policy for any category", which every
 * kind that reads it already handles.
 */
export interface ExpensePolicy {
  categoryId: string;
  receiptRequired: boolean;
  approvalRequired: boolean;
  perTransactionLimitMinor: bigint | null;
  dailyLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  annualLimitMinor: bigint | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

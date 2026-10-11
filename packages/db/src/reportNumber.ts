import type { Prisma } from '@/lib/generated/prisma/client';

/**
 * The next report number in the current tenant's own sequence — `EXP-000042`.
 *
 * VeloExpense: ExpenseOS's column default draws the number from one global sequence; here
 * each organization numbers its own reports (`organization.expense_report_seq`), as
 * VeloExpense's writer always has. Moved here from `server/routers/expenses.ts`
 * (`mintReportNumber`) in w3-06 so the inbound-email worker numbers a report the same way
 * the browser does. The organization row is locked for the rest of the transaction, so two
 * reports created at once cannot be given one number.
 *
 * Null when there is no tenant scope: the caller decides how to refuse.
 */
export async function nextReportNumber(db: Prisma.TransactionClient): Promise<string | null> {
  const [org] = await db.$queryRaw<{ id: string; seq: bigint }[]>`
    SELECT id::text AS id, expense_report_seq AS seq
      FROM organization
     WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid
       FOR UPDATE`;
  if (!org) return null;
  const next = BigInt(org.seq) + 1n;
  await db.$executeRaw`UPDATE organization SET expense_report_seq = ${next} WHERE id = ${org.id}::uuid`;
  return `EXP-${next.toString().padStart(6, '0')}`;
}

import type { Prisma } from '@expenseos/db';

/**
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/report-editable.ts` (550b2945).
 * VeloExpense: the table is `expense_report` (snake case), read under the tenant's RLS scope.
 */

/**
 * The statuses in which the worker may move a report's money.
 *
 * Mirrors `EDITABLE_REPORT_STATUSES` in the web router: a report is the submitter's
 * to change while DRAFT or RETURNED, and nobody's once it is SUBMITTED. Extraction is
 * asynchronous by design — retries back off for up to an hour, the Batch API polls for
 * as long — so a result can land well after the person submitted, and after an
 * approver signed. Whatever the model read then, the filed numbers stand.
 */
export const REPORT_EDITABLE_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'RETURNED']);

export function isReportEditable(status: string | null | undefined): boolean {
  return status != null && REPORT_EDITABLE_STATUSES.has(status);
}

/**
 * The report's status, read under a row lock so it cannot change under the caller
 * for the rest of the transaction.
 *
 * `submit` changes the status with a plain UPDATE, which has to wait for this lock —
 * so a write made after this read is a write to a report that was still editable
 * when it committed, and a submit that already landed is seen here. A plain read
 * would leave a window between the check and the write in which a submit slips
 * through, and a report can be approved seconds after it is submitted.
 */
export async function lockReportStatus(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  reportId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<
    { status: string }[]
  >`SELECT status::text AS status FROM expense_report WHERE id = ${reportId}::uuid FOR UPDATE`;
  return rows[0]?.status ?? null;
}

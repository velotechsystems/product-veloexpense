/**
 * The one notion of "may this expense be written" — who may write it and in which report
 * statuses — shared by `expenses.*` and `mileageRoute.lineRoutePath`.
 *
 * Moved here unchanged from `server/routers/expenses.ts` so a second router can reuse the
 * same gates rather than copy them: a copy would let the two drift, and the comment on
 * `assertExpenseWritable` ("exactly one notion") is the rule this file keeps true.
 */

import { ExpenseReportStatus, type PrismaClient } from '@expenseos/db';
import { TRPCError } from '@trpc/server';
import { REFUSAL_KEYS, type RefusalKey, refusal } from '@/server/refusal';

/** A report is editable (and (re)submittable) by its submitter while DRAFT or
 *  RETURNED — an approver can return a submitted report for fixes (Phase 3),
 *  after which it behaves like a draft again until resubmitted. */
export const EDITABLE_REPORT_STATUSES: ExpenseReportStatus[] = [
  ExpenseReportStatus.DRAFT,
  ExpenseReportStatus.RETURNED,
];

/**
 * Where a document may still be ADDED: the editable statuses, plus SUBMITTED.
 *
 * Attaching evidence is not editing the claim — an approver asking for a missing receipt
 * mid-review is a real flow, and the joint/single-document extraction refuses to move a
 * filed report's numbers (`prefill.ts`, `determine.ts`). The window closes with the
 * decision: once a report is APPROVED, REJECTED or REIMBURSED the evidence set is what
 * the approver signed, and NetSuite's File Cabinet push sends whatever is on the report
 * at post time. There is deliberately no post-approval attach path; a report whose
 * evidence is wrong after approval is a report to reject or reverse, not to patch.
 *
 * Removing or moving a document is narrower still — `EDITABLE_REPORT_STATUSES` only —
 * because both destroy or restate what an approver may already have looked at.
 */
export const ATTACHABLE_REPORT_STATUSES: ExpenseReportStatus[] = [
  ...EDITABLE_REPORT_STATUSES,
  ExpenseReportStatus.SUBMITTED,
];

/** The one refusal for a write to a report the submitter no longer owns the figures of. */
export const NOT_EDITABLE = {
  key: REFUSAL_KEYS.reportNotEditable,
  message: 'Report is not editable.',
} as const;

export async function assertExpenseDraft(
  ctx: {
    db: PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
): Promise<{ reportId: string; ownerId: string }> {
  return assertExpenseWritable(ctx, expenseId, EDITABLE_REPORT_STATUSES, NOT_EDITABLE);
}

/**
 * As `assertExpenseDraft`, for the document endpoints that ADD evidence: the report may
 * also be SUBMITTED (see `ATTACHABLE_REPORT_STATUSES`). Delete and move stay on the
 * draft gate.
 */
export async function assertExpenseAttachable(
  ctx: {
    db: PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
): Promise<{ reportId: string; ownerId: string }> {
  return assertExpenseWritable(ctx, expenseId, ATTACHABLE_REPORT_STATUSES, {
    key: REFUSAL_KEYS.documentsClosed,
    message: 'Documents cannot be added once the report has been decided.',
  });
}

/** Ownership + a status allow-list, in one read. The two public gates above are the
 *  only callers, so there is exactly one notion of "may this expense be written". */
async function assertExpenseWritable(
  ctx: {
    db: PrismaClient;
    session: { user: { id: string } };
  },
  expenseId: string,
  allowed: readonly ExpenseReportStatus[],
  refused: { key: RefusalKey; message: string },
): Promise<{ reportId: string; ownerId: string }> {
  const expense = await ctx.db.expense.findUnique({
    where: { id: expenseId },
    select: {
      reportId: true,
      ownerId: true,
      report: { select: { submitterId: true, status: true } },
    },
  });
  const uid = ctx.session.user.id;
  if (!expense || (expense.ownerId !== uid && expense.report?.submitterId !== uid)) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  if (expense.report && !allowed.includes(expense.report.status)) {
    throw refusal('BAD_REQUEST', refused.key, refused.message);
  }
  return { reportId: expense.reportId, ownerId: expense.ownerId };
}

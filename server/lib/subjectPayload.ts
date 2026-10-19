/**
 * VeloExpense (w6-01): the notification placeholders one subject's events carry — an expense
 * report's (`reportPayload`) or a travel request's (`travelPayload`), read once here.
 *
 * ExpenseOS renders its notifications from catalog sentences with no subject placeholders, so
 * it has no counterpart. VeloExpense's templates name the subject (`{report}`, `{request}`),
 * and four places record an activity on a subject they were handed — a comment in the app, a
 * reply by email or Slack, a workflow Notify node and the approval sweep. Until travel each
 * of them read the report inline; with a second subject that would be four copies of a
 * two-way switch, so it is one function.
 *
 * Returns `{}` for a subject that is gone or has no placeholders (a budget): the template
 * then shows the placeholder verbatim, which is the catalog's intended failure.
 */
import type { TenantDb } from '@/lib/db/prisma';
import { reportPayload, travelPayload } from '@/lib/notifications/service';

export async function subjectPayload(
  db: TenantDb,
  subjectType: string,
  subjectId: string,
): Promise<Record<string, string>> {
  if (subjectType === 'EXPENSE_REPORT') {
    const r = await db.expenseReport.findUnique({
      where: { id: subjectId },
      select: { title: true, number: true, totalMinor: true, currencyId: true },
    });
    return r
      ? reportPayload({
          title: r.title,
          number: r.number,
          totalMinor: r.totalMinor,
          currencyCode: r.currencyId,
        })
      : {};
  }
  if (subjectType === 'TRAVEL_REQUEST') {
    const t = await db.travelRequest.findUnique({
      where: { id: subjectId },
      select: {
        number: true,
        destinationLabel: true,
        currencyId: true,
        approvedTotalMinor: true,
        budgetLines: { select: { amountMinor: true } },
      },
    });
    return t
      ? travelPayload({
          number: t.number,
          destinationLabel: t.destinationLabel,
          // The approved total once there is one, else the estimate as it stands — the
          // engine's own rule for the trip's amount.
          totalMinor: t.approvedTotalMinor ?? t.budgetLines.reduce((a, l) => a + l.amountMinor, 0n),
          currencyCode: t.currencyId,
        })
      : {};
  }
  return {};
}

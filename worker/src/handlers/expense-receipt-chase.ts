import type { JobMap } from '@expenseos/jobs';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { db } from '@/lib/db/prisma';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';

/**
 * Handler for `expense.receiptChase` (daily).
 *
 * Nudges submitters about draft expenses that still have no receipt. Until now
 * the only thing that told anyone was the RECEIPT_REQUIRED policy rule, which
 * fires at submit — so a report could sit half-finished for weeks and the
 * submitter would only discover the blocker at the moment they tried to file it,
 * typically the day expenses were due.
 *
 * Scope is deliberately narrow:
 *
 *   - **DRAFT and RETURNED reports only.** Those are the states where the
 *     submitter can actually attach something. Chasing a SUBMITTED report would
 *     nag about work that is out of their hands, and an APPROVED one is settled.
 *   - **Only expenses old enough to be worth chasing** (`MIN_AGE_DAYS`), so an
 *     expense captured this morning isn't chased tonight.
 *   - **One reminder per report per `COOLDOWN_DAYS`.** The reminder is recorded
 *     as an Activity, and that row is also the throttle — a daily job with no
 *     memory would otherwise mail the same person every night until they gave
 *     up and muted notifications, which is worse than never chasing at all.
 *
 * One reminder per REPORT, not per expense: three receiptless lines on one
 * report is one piece of news, and three emails about it reads as a bug.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/expense-receipt-chase.ts` (550b2945),
 * Wave 3 (w3-05). VeloExpense, each marked below:
 *   · it runs for ONE tenant, the one its payload names (`inTenant`, worker/src/main.ts);
 *     the daily schedule's own run only fans out (`fanOutToTenants`, ./lib/tenant);
 *   · the reminder is VeloExpense's own event, RECEIPT_CHASE (d46), through VeloExpense's
 *     notification service, with the report placeholders every report event carries;
 *   · the cooldown also counts RECEIPT_REMINDER — the person-sent ask — as ExpenseOS's
 *     does, since there both are one event: a colleague who asked yesterday is reminder
 *     enough;
 *   · a receipt is a STORED one (d29);
 *   · the tuning values are constants: VeloExpense has no system flags.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_AGE_DAYS = 3;
const DEFAULT_COOLDOWN_DAYS = 7;
/** Safety cap per run so a backlog can't fan out unboundedly. */
const MAX_REPORTS_PER_RUN = 500;

/** VeloExpense: a receipt counts once its object is in storage (d29). */
const STORED = { status: 'STORED' } as const;

export async function handleExpenseReceiptChase(
  _data: JobMap['expense.receiptChase'],
): Promise<void> {
  // VeloExpense: no system flags, so ExpenseOS's defaults are the values.
  const minAgeDays = DEFAULT_MIN_AGE_DAYS;
  const cooldownDays = DEFAULT_COOLDOWN_DAYS;
  const now = Date.now();
  const olderThan = new Date(now - minAgeDays * DAY_MS);
  const cooldownSince = new Date(now - cooldownDays * DAY_MS);

  // Reports the submitter can still act on, holding at least one sufficiently
  // old expense with no receipt.
  const reports = await db.expenseReport.findMany({
    where: {
      status: { in: ['DRAFT', 'RETURNED'] },
      expenses: { some: { receipts: { none: STORED }, createdAt: { lt: olderThan } } },
    },
    take: MAX_REPORTS_PER_RUN,
    orderBy: { updatedAt: 'asc' },
    select: {
      id: true,
      number: true,
      submitterId: true,
      // VeloExpense: for the report placeholders (`reportPayload`).
      title: true,
      totalMinor: true,
      currencyId: true,
      _count: { select: { expenses: { where: { receipts: { none: STORED } } } } },
    },
  });
  if (reports.length === 0) {
    console.log('[expense.receiptChase] nothing to chase');
    return;
  }

  // One query for every recent reminder, so the cooldown check isn't N queries.
  // VeloExpense: `activity` has no Prisma model, so it is read through the SQL the
  // notification service itself uses; RLS scopes it to this tenant.
  const recent = await db.$transaction((tx) =>
    queryRunnerOf(tx).query(
      `SELECT DISTINCT subject_id FROM activity
        WHERE subject_type = 'EXPENSE_REPORT'
          AND subject_id = ANY($1::uuid[])
          AND event_type IN ('RECEIPT_CHASE', 'RECEIPT_REMINDER')
          AND occurred_at >= $2`,
      [reports.map((r) => r.id), cooldownSince],
    ),
  );
  const onCooldown = new Set(recent.rows.map((a) => String(a.subject_id)));

  let sent = 0;
  for (const report of reports) {
    if (onCooldown.has(report.id)) continue;
    const missing = report._count.expenses;
    if (missing === 0) continue; // raced with an upload
    try {
      // VeloExpense: the activity and its notification in one transaction, as the
      // notification service expects.
      await db.$transaction(async (tx) => {
        const q = queryRunnerOf(tx);
        const activityId = await recordActivity(q, {
          subjectType: 'EXPENSE_REPORT',
          subjectId: report.id,
          eventType: 'RECEIPT_CHASE',
          // System-generated: no actor. The message renders without a name.
          actorId: null,
          payload: {
            ...reportPayload({
              title: report.title,
              number: report.number,
              totalMinor: report.totalMinor,
              currencyCode: report.currencyId,
            }),
            missing,
          },
        });
        await notifyRecipients(q, activityId, [report.submitterId]);
      });
      sent += 1;
    } catch (e) {
      // One bad report must not abandon the rest of the run.
      console.warn(`[expense.receiptChase] report ${report.id} failed`, e);
    }
  }

  console.log(
    `[expense.receiptChase] ${reports.length} candidate report(s), ${sent} reminder(s) sent ` +
      `(minAge ${minAgeDays}d, cooldown ${cooldownDays}d)`,
  );
}

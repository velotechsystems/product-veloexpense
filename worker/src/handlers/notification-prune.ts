import type { JobMap } from '@expenseos/jobs';
import { db } from '@/lib/db/prisma';

/**
 * Handler for `notification.prune` (daily). Deletes Notification rows older than
 * the retention window. Activities are intentionally kept — they're the
 * request/card history rendered in the drawer timeline.
 *
 * Retention window = the `notificationRetentionDays` system flag, else the
 * default. Set the flag to tune it without a redeploy.
 *
 * w5-07 — ported from ExpenseOS `apps/worker/src/handlers/notification-prune.ts` (1e682dd6).
 * VeloExpense:
 *   · per tenant (fanned out by the schedule, as `expense.receiptChase` is), on the tenant's
 *     transaction, so it can only ever delete that tenant's notifications;
 *   · the window is ExpenseOS's default, 90 days, with no flag to tune it — VeloExpense has no
 *     SystemFlag table, and nothing has asked for a different window;
 *   · a notification's delivery rows (`notification_delivery`, the email/Slack outbox) go with
 *     it (ON DELETE CASCADE, 0012): a 90-day-old row is long settled, and the delivery screen
 *     is about what is happening now.
 */
export const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleNotificationPrune(
  _data: JobMap['notification.prune'],
  opts: { now?: Date } = {},
): Promise<number> {
  const days = DEFAULT_RETENTION_DAYS;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * DAY_MS);

  const removed = await db.$transaction(
    (tx) => tx.$executeRaw`DELETE FROM notification WHERE created_at < ${cutoff}`,
  );

  console.log(`[notification.prune] removed ${removed} notifications (>${days}d)`);
  return removed;
}

import { pruneRuns } from '@expenseos/db';
import type { JobMap } from '@expenseos/jobs';
import { db } from '@/lib/db/prisma';

/**
 * Handler for `userSyncRun.prune` (daily). Deletes people-sync run reports older than 90
 * days.
 *
 * The run report is the per-person detail behind each sync — who was changed, linked or
 * refused. It is how an admin answers "what did last night's run do", not the record of it:
 * the hash-chained audit log keeps one summary row per run indefinitely. A sync a day across
 * a tenant's people would otherwise grow the table without bound.
 *
 * eos batch 4 — ported from ExpenseOS `apps/worker/src/handlers/user-sync-run-prune.ts`
 * (67db2e33, #582). VeloExpense: per tenant (fanned out by the schedule, as
 * `notification.prune` is), on the tenant's transaction, so it can only ever delete that
 * tenant's reports.
 */
export async function handleUserSyncRunPrune(
  _data: JobMap['userSyncRun.prune'],
  opts: { now?: Date } = {},
): Promise<{ runs: number; items: number }> {
  const removed = await db.$transaction((tx) => pruneRuns(tx, opts.now));
  console.log(
    `[userSyncRun.prune] removed ${removed.runs} runs and ${removed.items} standalone items`,
  );
  return removed;
}

import { auditActions, withAudit } from '@expenseos/audit';
import { rollUpOnOffboard } from '@expenseos/db';
import { type SyncAllResult, syncAllFromDirectory } from '@expenseos/integrations-google';
import type { JobMap } from '@expenseos/jobs';
import { pushSeatCount } from '@/lib/billing/seats';
import { db, currentTenantId } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { directoryCredentials, recordDirectorySync } from '@/lib/directory/googleConnection';

/**
 * w5-04 — ported from ExpenseOS `apps/worker/src/handlers/directory-sync.ts` (1e682dd6).
 * VeloExpense, each marked below:
 *   · PER TENANT: the job runs as one tenant (fanned out by the schedule, as `audit.purge` is),
 *     with that tenant's stored key (`google_directory_connection`, 0076). A tenant that has
 *     not connected is `disabled` — no audit, no roll-up, no throw — as ExpenseOS's dev is.
 *   · UPDATE ONLY (d84; packages/integrations-google/src/apply.ts). The summary counts
 *     `notFound` / `held` / `offboarded` where ExpenseOS counts `created`, and names the
 *     people it offboarded by id: losing access is the one thing this job does to a person
 *     that they will notice, and "which sync did that" must be answerable from the chain.
 *   · No NetSuite chaining: ExpenseOS enqueues its NetSuite employee sync after every pass;
 *     VeloExpense has no NetSuite.
 *   · The last run is also recorded on the connection row, IN the summary audit row's
 *     transaction, so the admin screen and the chain cannot disagree.
 *   · An offboarding changes the tenant's seat count, which the platform bills on, so the
 *     count is pushed once the run is over — as `users.deactivate` pushes it.
 *   · Cards are out of scope (7 Oct 2026), so the roll-up is reports only
 *     (packages/db/src/offboarding.ts), and so are its totals.
 */

/** Find every offboarded (terminated/deactivated) user who still has cards or
 *  open reports pending transfer and roll each up to their manager. Returns
 *  batch totals for the run's summary audit. */
async function rollUpOffboardedUsers(): Promise<{
  users: number;
  reportsToManager: number;
  reportsOrphaned: number;
}> {
  const pending = await db.user.findMany({
    where: {
      employeeStatus: { in: ['TERMINATED', 'DEACTIVATED'] },
      // VeloExpense: no cards (see the header) — open reports + a manager to move them to
      // (orphaned reports need no action).
      managerId: { not: null },
      reports: { some: { status: { in: ['DRAFT', 'SUBMITTED', 'RETURNED'] } } },
    },
    select: { id: true },
  });
  const totals = { users: 0, reportsToManager: 0, reportsOrphaned: 0 };
  for (const u of pending) {
    // VeloExpense: one person, one tenant transaction.
    const s = await db.$transaction((tx) => rollUpOnOffboard(tx, u.id));
    totals.users += 1;
    totals.reportsToManager += s.reportsToManager;
    totals.reportsOrphaned += s.reportsOrphaned;
  }
  return totals;
}

/**
 * Handler for the `integration.google.directorySync` job. Paginates
 * the entire Workspace directory via the Admin SDK and reconciles
 * every user into the DB via `syncAllFromDirectory`.
 *
 * Emits one summary audit row per run (action
 * `integration.google.directory.synced`) — per-user changes are NOT
 * audited individually because the sync is an idempotent
 * reconciliation from a trusted upstream and per-row audit at 359+
 * users daily would balloon the table without adding signal.
 *
 * Throws on initialization / config errors so BullMQ retries the
 * job. `syncAllFromDirectory` returns `status: 'disabled'` cleanly
 * when `GOOGLE_DIRECTORY_DISABLED=true` — in that case we log and
 * return without throwing (no audit row written for the no-op).
 */
export async function handleDirectorySync(
  data: JobMap['integration.google.directorySync'],
  // VeloExpense: injectable for the test — the client, and the clock the offboarding stamps.
  opts: Parameters<typeof syncAllFromDirectory>[2] = {},
): Promise<SyncAllResult> {
  const trigger = data.trigger ?? 'cron';
  const startedAt = Date.now();

  // VeloExpense: the tenant's own key. Unreadable (the server's key changed) is an error run,
  // recorded like any other, so the screen says so instead of the sync going quiet.
  const stored = await db.$transaction((tx) => directoryCredentials(queryRunnerOf(tx)));
  const result: SyncAllResult =
    stored.state === 'unreadable'
      ? {
          status: 'error',
          scanned: 0,
          updated: 0,
          notFound: 0,
          held: 0,
          offboarded: [],
          errors: 0,
          unmappedTitles: [],
          missingJobLevels: [],
          message: stored.message,
        }
      : await syncAllFromDirectory(
          db,
          stored.state === 'ok' ? stored.credentials : null,
          opts,
        );
  const durationMs = Date.now() - startedAt;

  console.log(
    `[directory.sync] ${result.status}` +
      `  trigger=${trigger}` +
      `  scanned=${result.scanned}` +
      `  updated=${result.updated}` +
      `  notFound=${result.notFound}` +
      `  held=${result.held}` +
      `  offboarded=${result.offboarded.length}` +
      `  errors=${result.errors}` +
      `  took=${durationMs}ms` +
      (result.message ? `  message="${result.message}"` : ''),
  );

  if (result.status === 'disabled') {
    return result; // No-op; no audit, no retry.
  }

  // Roll up cards + open reports for anyone the sync just offboarded (or a
  // prior run missed): terminated/deactivated users who still hold un-rolled
  // non-closed cards, or open reports with a manager to move them to.
  // Idempotent — `rolledUpFromUserId` guards cards from a second roll-up.
  const rollup = await rollUpOffboardedUsers();

  // One summary audit row per run.
  await withAudit(
    db,
    {
      action: auditActions.integration.googleDirectorySynced,
      // VeloExpense: the writer files an entity-less row's `entityType` under `details`.
      entityType: 'Directory',
      actor: { kind: 'system', jobName: 'directory-sync' },
      details: {
        status: result.status,
        trigger,
        scanned: result.scanned,
        updated: result.updated,
        notFound: result.notFound,
        held: result.held,
        offboarded: result.offboarded,
        errors: result.errors,
        durationMs,
        offboardRollup: rollup,
        unmappedTitles: result.unmappedTitles,
        missingJobLevels: result.missingJobLevels,
        ...(result.message ? { message: result.message } : {}),
      },
    },
    // VeloExpense: the screen's copy of the run, on the audit row's transaction.
    async (tx) => recordDirectorySync(queryRunnerOf(tx), trigger, result, new Date(startedAt)),
  );

  // VeloExpense: the seat count changed (see the header).
  if (result.offboarded.length > 0) {
    const organizationId = currentTenantId();
    if (organizationId) await pushSeatCount(organizationId);
  }

  // Initialization / config error — let BullMQ retry.
  if (result.status === 'error') {
    throw new Error(`directory sync failed: ${result.message ?? 'unknown'}`);
  }
  return result;
}

import { auditActions, withAudit } from '@expenseos/audit';
import { finishRun, heartbeatRun, openRun, recordRunItems, rollUpOnOffboard } from '@expenseos/db';
import {
  emptyCounts,
  type SyncAllResult,
  syncAllFromDirectory,
} from '@expenseos/integrations-google';
import type { JobMap } from '@expenseos/jobs';
import { pushSeatCount } from '@/lib/billing/seats';
import { db, currentTenantId } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { directoryCredentials, recordDirectorySync } from '@/lib/directory/googleConnection';

/**
 * w5-04 — ported from ExpenseOS `apps/worker/src/handlers/directory-sync.ts` (1e682dd6), and
 * brought to ExpenseOS 67db2e33 (#582, directory sync v2): every run gets a `user_sync_run`
 * row — opened first, which is also the lock against a second concurrent pass, heart-beaten
 * while it works, and closed with its totals — and one item per person it changed, linked or
 * refused. The audit log keeps ONE summary row per run that did work.
 *
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
 * Handler for the `integration.google.directorySync` job (nightly, 02:30 UTC). Reconciles
 * the tenant's whole Workspace directory via `syncAllFromDirectory`.
 *
 * Every run gets a `user_sync_run` row — opened first, which is also the lock against a
 * second concurrent pass (VeloExpense: per tenant), heart-beaten while it works, and closed
 * with its totals — and one item per person it changed, linked or refused. The audit log
 * gets ONE summary row per run that did work; per-person changes are not audited
 * individually (the sync is an idempotent reconciliation from a trusted upstream, and a row
 * per person per night would bury the signal).
 *
 * A switched-off or unconnected directory closes the run as DISABLED with the reason and
 * writes no audit row. A run that fails to list the directory closes as ERROR, is audited,
 * and throws so the job shows as failed (the schedule allows one attempt, so it is not
 * re-run until the next night).
 */
export async function handleDirectorySync(
  data: JobMap['integration.google.directorySync'],
  // VeloExpense: injectable for the test — the client, and the clock the offboarding stamps.
  opts: Omit<Parameters<typeof syncAllFromDirectory>[2], 'onProgress'> = {},
  job?: { id?: string | null },
): Promise<SyncAllResult> {
  const trigger = data.trigger ?? 'cron';
  const opened = await db.$transaction((tx) =>
    openRun(tx, { kind: 'GOOGLE_DIRECTORY', trigger, jobId: job?.id ?? null }),
  );
  if (opened.status === 'busy') {
    console.warn(`[directory.sync] skipped: run ${opened.runId} is still in progress`);
    return { status: 'disabled', counts: emptyCounts(), items: [], offboarded: [], message: 'busy' };
  }
  const runId = opened.runId;
  const startedAt = Date.now();

  // VeloExpense: the tenant's own key. Unreadable (the server's key changed) is an error run,
  // recorded like any other, so the screen says so instead of the sync going quiet.
  let result: SyncAllResult;
  try {
    const stored = await db.$transaction((tx) => directoryCredentials(queryRunnerOf(tx)));
    result =
      stored.state === 'unreadable'
        ? { status: 'error', counts: emptyCounts(), items: [], offboarded: [], message: stored.message }
        : await syncAllFromDirectory(db, stored.state === 'ok' ? stored.credentials : null, {
            ...opts,
            onProgress: () => db.$transaction((tx) => heartbeatRun(tx, runId)),
          });
  } catch (e) {
    await db.$transaction((tx) =>
      finishRun(tx, runId, { status: 'ERROR', message: e instanceof Error ? e.message : String(e) }),
    );
    throw e;
  }
  const durationMs = Date.now() - startedAt;
  const { counts } = result;

  console.log(
    `[directory.sync] ${result.status}` +
      `  trigger=${trigger}` +
      `  scanned=${counts.scanned}` +
      `  updated=${counts.updated}` +
      `  notFound=${counts.notFound}` +
      `  linked=${counts.linked}` +
      `  conflicts=${counts.conflicts}` +
      `  held=${counts.held}` +
      `  offboarded=${result.offboarded.length}` +
      `  errors=${counts.errors}` +
      `  took=${durationMs}ms` +
      (result.message ? `  message="${result.message}"` : ''),
  );

  await db.$transaction((tx) =>
    recordRunItems(
      tx,
      runId,
      result.items.map((item) => ({
        kind: 'GOOGLE_DIRECTORY' as const,
        outcome: item.outcome,
        userId: item.userId,
        externalRef: item.googleId || null,
        fields: item.fields,
        message: [item.email, item.message].filter(Boolean).join(' — '),
      })),
    ),
  );

  if (result.status === 'disabled') {
    await db.$transaction((tx) =>
      finishRun(tx, runId, { status: 'DISABLED', message: result.message ?? null }),
    );
    return result; // No audit, no retry.
  }

  // Roll up open reports for anyone the sync just offboarded (or a prior run missed):
  // terminated/deactivated users who still hold open reports with a manager to move them to.
  const rollup = result.status === 'completed' ? await rollUpOffboardedUsers() : null;

  await db.$transaction((tx) =>
    finishRun(tx, runId, {
      status: result.status === 'completed' ? 'COMPLETED' : 'ERROR',
      counts: { ...counts, offboarded: result.offboarded.length, durationMs, ...(rollup ? { offboardRollup: rollup } : {}) },
      message: result.message ?? null,
    }),
  );

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
        runId,
        scanned: counts.scanned,
        active: counts.active,
        deleted: counts.deleted,
        updated: counts.updated,
        notFound: counts.notFound,
        linked: counts.linked,
        relinked: counts.relinked,
        conflicts: counts.conflicts,
        skipped: counts.skipped,
        held: counts.held,
        offboarded: result.offboarded,
        errors: counts.errors,
        managersUnresolved: counts.managersUnresolved,
        unmappedTitles: counts.unmappedTitles,
        missingJobLevels: counts.missingJobLevels,
        durationMs,
        ...(rollup ? { offboardRollup: rollup } : {}),
        ...(result.message ? { message: result.message } : {}),
      },
    },
    // VeloExpense: the screen's copy of the run, on the audit row's transaction.
    async (tx) => recordDirectorySync(queryRunnerOf(tx), trigger, result, new Date(startedAt), runId),
  );

  // VeloExpense: the seat count changed (see the header).
  if (result.offboarded.length > 0) {
    const organizationId = currentTenantId();
    if (organizationId) await pushSeatCount(organizationId);
  }

  // Listing failed — surface it as a failed job.
  if (result.status === 'error') {
    throw new Error(`directory sync failed: ${result.message ?? 'unknown'}`);
  }
  return result;
}

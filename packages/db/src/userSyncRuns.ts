/**
 * People-sync run reports — `UserSyncRun` + `UserSyncRunItem` — shared by the Google
 * directory sync and the NetSuite employee sync.
 *
 * A run row is opened before any work, carries a heartbeat while the work makes progress,
 * and is closed with its totals. Items record what happened to each person the run touched
 * (created, updated with from/to, linked, refused…) — the per-person detail the hash-chained
 * audit summary deliberately leaves out.
 *
 * `openRun` is also the run LOCK: one live (non-dry) run per kind. A second run while one is
 * alive is refused, a run whose heartbeat went stale (worker restarted mid-run) is reclaimed,
 * and a run left by the SAME BullMQ job — a stalled job re-delivered — is taken over rather
 * than yielded to, so a redelivery cannot lose the night's run.
 *
 * Pure Prisma, no audit: callers own the audit row for the run as a whole.
 *
 * eos batch 4 — ported from ExpenseOS `packages/db/src/userSyncRuns.ts` (67db2e33, #582).
 * VeloExpense: the tables are per tenant (0082) and every call runs on the caller's tenant
 * transaction, so the run LOCK is one live run per kind PER TENANT, and the prune removes the
 * tenant's own old reports. Exported from the package root (`@expenseos/db`).
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * VeloExpense: ExpenseOS's two Postgres enums are text under CHECKs (0082), so their values
 * are stated here. The kind is GOOGLE_DIRECTORY only — no NetSuite (d80); the outcomes are
 * ExpenseOS's full list.
 */
export type UserSyncKind = 'GOOGLE_DIRECTORY';
export type UserSyncItemOutcome =
  | 'CREATED'
  | 'UPDATED'
  | 'LINKED'
  | 'CONFLICT'
  | 'SKIPPED'
  | 'DEFERRED'
  | 'PUSHED'
  | 'FAILED'
  | 'UNMATCHED'
  | 'AMBIGUOUS'
  | 'ERROR';

/** A RUNNING run with no heartbeat for this long was interrupted. */
export const STALE_RUN_MS = 10 * 60 * 1000;

/** Run reports older than this are pruned. */
export const USER_SYNC_RUN_RETENTION_DAYS = 90;

export interface OpenRunInput {
  kind: UserSyncKind;
  trigger: string;
  dryRun?: boolean;
  jobId?: string | null;
  actorId?: string | null;
}

export type OpenRunResult =
  | { status: 'opened'; runId: string }
  /** Another live run of this kind holds the lock. */
  | { status: 'busy'; runId: string };

/** Open a run, taking the per-kind lock unless it is a dry run. */
export async function openRun(
  db: Db,
  input: OpenRunInput,
  now: Date = new Date(),
): Promise<OpenRunResult> {
  const dryRun = input.dryRun ?? false;
  if (!dryRun) {
    const live = await db.userSyncRun.findMany({
      where: { kind: input.kind, status: 'RUNNING', dryRun: false },
      select: { id: true, jobId: true, heartbeatAt: true },
      orderBy: { startedAt: 'asc' },
    });
    for (const run of live) {
      const stale = now.getTime() - run.heartbeatAt.getTime() > STALE_RUN_MS;
      const sameJob = input.jobId != null && run.jobId === input.jobId;
      if (!stale && !sameJob) return { status: 'busy', runId: run.id };
      await db.userSyncRun.update({
        where: { id: run.id },
        data: {
          status: 'ERROR',
          finishedAt: now,
          message: sameJob
            ? 'Interrupted; the same job was delivered again and took over.'
            : 'Interrupted; no progress for over 10 minutes.',
        },
      });
    }
  }
  const run = await db.userSyncRun.create({
    data: {
      kind: input.kind,
      trigger: input.trigger,
      dryRun,
      jobId: input.jobId ?? null,
      actorId: input.actorId ?? null,
      startedAt: now,
      heartbeatAt: now,
    },
    select: { id: true },
  });
  return { status: 'opened', runId: run.id };
}

/** Bump the heartbeat (and optionally the running totals). */
export async function heartbeatRun(
  db: Db,
  runId: string,
  counts?: Record<string, unknown>,
): Promise<void> {
  await db.userSyncRun.update({
    where: { id: runId },
    data: {
      heartbeatAt: new Date(),
      ...(counts ? { counts: counts as Prisma.InputJsonValue } : {}),
    },
  });
}

/** Close a run with its final status and totals. */
export async function finishRun(
  db: Db,
  runId: string,
  outcome: {
    status: 'COMPLETED' | 'DISABLED' | 'ERROR' | 'CANCELLED';
    counts?: Record<string, unknown>;
    message?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db.userSyncRun.update({
    where: { id: runId },
    data: {
      status: outcome.status,
      finishedAt: now,
      heartbeatAt: now,
      message: outcome.message ?? null,
      ...(outcome.counts ? { counts: outcome.counts as Prisma.InputJsonValue } : {}),
    },
  });
}

export interface RunItemInput {
  kind: UserSyncKind;
  outcome: UserSyncItemOutcome;
  userId?: string | null;
  externalRef?: string | null;
  /** Field → { from, to, reason? }. */
  fields?: Record<string, unknown>;
  message?: string | null;
}

/** Record items against a run (or, with `runId` null, as a standalone edit-triggered push). */
export async function recordRunItems(
  db: Db,
  runId: string | null,
  items: RunItemInput[],
): Promise<void> {
  if (items.length === 0) return;
  await db.userSyncRunItem.createMany({
    data: items.map((item) => ({
      runId,
      kind: item.kind,
      outcome: item.outcome,
      userId: item.userId ?? null,
      externalRef: item.externalRef ?? null,
      fields: (item.fields ?? {}) as Prisma.InputJsonValue,
      message: item.message ?? null,
    })),
  });
}

/**
 * Delete run reports older than the retention window: runs by `startedAt` (their items
 * cascade) and standalone items (no run) by `createdAt`.
 */
export async function pruneRuns(
  db: Db,
  now: Date = new Date(),
  retentionDays: number = USER_SYNC_RUN_RETENTION_DAYS,
): Promise<{ runs: number; items: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const runs = await db.userSyncRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  const items = await db.userSyncRunItem.deleteMany({
    where: { runId: null, createdAt: { lt: cutoff } },
  });
  return { runs: runs.count, items: items.count };
}

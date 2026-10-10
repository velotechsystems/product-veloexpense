/**
 * Persist an expense report's `totalMinor` as the FX/VAT roll-up of its
 * expenses converted into the report currency.
 *
 * Pure Prisma, so every writer shares it: the expenses router (after any
 * line-item change), the approvals router (after an AP FX override), and the
 * WORKER's extraction prefill. The worker used to sum `amountMinor` across
 * currencies itself, which is not a number — ¥1,000 is not $10.00 — so a report
 * could disagree with itself depending on which path last touched it.
 *
 * ── The status guard ──────────────────────────────────────────────────────
 *
 * `totalMinor` is the figure an approver signs and NetSuite posts. Every caller
 * gates on the report's status before it edits a line, but this function is the
 * LAST write on each of those paths and it is reachable from a worker whose job
 * outlived the report's review — extraction lands an hour late, a batch merge
 * fires after the person submitted and the approver signed. A stale caller that
 * had passed its own gate could still rewrite a decided total here, silently.
 *
 * So the write refuses on its own. Inside one transaction it takes the report
 * row's lock, re-reads the status, and:
 *
 *   · writes for DRAFT / RETURNED (the submitter's edits) and SUBMITTED (AP's
 *     review-time FX override, which #506 already confines to that status);
 *   · throws `ReportTotalFrozenError` for APPROVED / REJECTED / REIMBURSED, and
 *     for any report whose NetSuite satellite says it is posted or posting —
 *     whatever the status column claims, a figure that reached the ledger is
 *     the ledger's.
 *
 * The lock is what makes the check mean something: `approve` changes the status
 * with a plain UPDATE, which waits for this lock, so a total written here was
 * written to a report that was still open at COMMIT — not merely at the moment
 * somebody looked. Callers that already hold the row inside their own
 * transaction pass the `tx` and the guard runs under that same lock.
 *
 * `allowFrozen` is the one door through the guard, for reviewed maintenance
 * (a Finance-approved restatement). It is not silent: every use logs, returns
 * the before/after figures, and product code reaches it only through
 * `restateFrozenReportTotal` in `@expenseos/audit`, which puts those figures
 * in a hash-chained audit row. Nothing in the routers or the worker passes it.
 */

import { buildReportRollup, fxRateMapFrom, withFxOverride } from '@expenseos/money';
// VeloExpense: VeloExpense's generated client (lib/generated/prisma).
import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

/** Either the shared client or a transaction already opened by the caller. */
export type ReportTotalDb = PrismaClient | Prisma.TransactionClient;

/**
 * The statuses in which the stored total may still be rewritten.
 *
 * DRAFT and RETURNED are `EDITABLE_REPORT_STATUSES` (the submitter's). SUBMITTED is
 * added because AP restates amounts during review — `setFxOverride` pins a statement
 * rate — and #506 made that the ONLY thing that may touch a SUBMITTED report's money.
 */
export const RECOMPUTABLE_REPORT_STATUSES: ReadonlySet<string> = new Set([
  'DRAFT',
  'RETURNED',
  'SUBMITTED',
]);

/**
 * NetSuite satellite states that mean the total has left the building.
 *
 * SYNCED: we posted it. RECONCILED: a human entered it in NetSuite by hand. PROCESSING:
 * a worker has the payload in flight this second — restating under it would post one
 * figure and store another. PENDING / FAILED / DENIED have not reached the ledger.
 *
 * VeloExpense: VeloExpense posts to the tenant's ledger through `integration_post`, not a
 * NetSuite satellite, so these are ITS states that mean the same thing (`postingStatusOf`
 * below): POSTED (it reached the ledger), NEEDS_REVIEW (the ledger holds it under an
 * external id somebody must check), and PROCESSING — a PENDING row a worker has CLAIMED,
 * which is the payload in flight. PENDING unclaimed, FAILED, DEAD, CANCELLED and HELD
 * have not reached the ledger.
 */
export const POSTED_SYNC_STATUSES: ReadonlySet<string> = new Set([
  'PROCESSING',
  'POSTED',
  'NEEDS_REVIEW',
]);

/**
 * VeloExpense: the report's ledger-posting state, in the vocabulary above — what
 * ExpenseOS reads off `netSuiteExpenseReportSync`. Null when nothing was ever queued.
 */
async function postingStatusOf(
  tx: Prisma.TransactionClient,
  reportId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ status: string; claimed: boolean }[]>`
    SELECT status, claimed_at IS NOT NULL AS claimed
      FROM integration_post WHERE report_id = ${reportId}::uuid`;
  const row = rows[0];
  if (!row) return null;
  return row.status === 'PENDING' && row.claimed ? 'PROCESSING' : row.status;
}

/**
 * The refusal. Carries what was found so a caller can say WHY rather than "no".
 *
 * `name` is the identity check (`isReportTotalFrozenError`), not `instanceof`: the
 * worker suites replace `@expenseos/db` wholesale, and a class that crosses a mocked
 * module boundary is a different constructor on each side.
 */
export class ReportTotalFrozenError extends Error {
  override readonly name = 'ReportTotalFrozenError' as const;
  constructor(
    readonly reportId: string,
    readonly status: string,
    readonly syncStatus: string | null,
  ) {
    super(
      // VeloExpense: the tenant's ledger, through `integration_post`, rather than NetSuite.
      syncStatus !== null && POSTED_SYNC_STATUSES.has(syncStatus)
        ? `The report total cannot be recomputed: the report is ${status} and its ledger ` +
            `posting is ${syncStatus}. A figure that reached the ledger is restated in the ledger, ` +
            'not here.'
        : `The report total cannot be recomputed: the report is ${status}. Once decided, ` +
            'its amounts are what was approved, rejected or paid.',
    );
  }
}

export function isReportTotalFrozenError(err: unknown): err is ReportTotalFrozenError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ReportTotalFrozenError'
  );
}

export interface RecomputeReportTotalOptions {
  /**
   * Rewrite the total even though the report is frozen. Reviewed maintenance only —
   * see the module comment. `reason` is mandatory and non-blank; it is logged and
   * (through `restateFrozenReportTotal`) audited.
   */
  allowFrozen?: { reason: string; actor?: string };
}

export interface RecomputeReportTotalResult {
  reportId: string;
  status: string;
  syncStatus: string | null;
  /** True when the write went through `allowFrozen`. */
  frozen: boolean;
  previousTotalMinor: bigint;
  totalMinor: bigint;
}

/** Map a report's stored FX-override columns (A4) into the `withFxOverride`
 *  shape, or null when no override is set. */
export function fxOverrideOf(r: {
  fxRateOverride: { toString(): string } | null;
  fxRateOverrideCurrency: string | null;
}): { fromCurrency: string; rate: string } | null {
  if (r.fxRateOverride == null || !r.fxRateOverrideCurrency) return null;
  return { fromCurrency: r.fxRateOverrideCurrency, rate: r.fxRateOverride.toString() };
}

/**
 * The FX/VAT roll-up for a report, without persisting anything.
 *
 * Split out of `recomputeReportTotal` because the total is not the only thing callers
 * need from it: `expenses.submit` has to know whether any line could NOT be valued in
 * the report currency (`missingRates`) before it lets the report go for approval. That
 * question was previously unanswerable without recomputing and discarding the roll-up,
 * so nothing asked it — and a report whose stated total silently omitted a fifth of its
 * value reached an approver.
 *
 * Returns null when the report does not exist.
 */
export async function reportRollupFor(
  db: ReportTotalDb,
  reportId: string,
): Promise<ReturnType<typeof buildReportRollup> | null> {
  // The report total is every expense CONVERTED into the report's own
  // currency — a raw cross-currency sum is meaningless. See buildReportRollup.
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: {
      // VeloExpense: the related row is keyed by its code, so `code` is the currency.
      currency: { select: { code: true } },
      fxRateOverride: true,
      fxRateOverrideCurrency: true,
      expenses: {
        select: {
          amountMinor: true,
          recoverableGstHstMinor: true,
          recoverableQstMinor: true,
          currency: { select: { code: true } },
          fxRate: true,
          homeCurrency: true,
        },
      },
    },
  });
  if (!report) return null;
  const fxRows = await db.fxRate.findMany({ orderBy: { fetchedAt: 'desc' } });
  return buildReportRollup(
    report.currency.code,
    report.expenses.map((e) => ({
      amountMinor: e.amountMinor,
      currencyCode: e.currency.code,
      recoverableGstHstMinor: e.recoverableGstHstMinor,
      recoverableQstMinor: e.recoverableQstMinor,
      fxRate: e.fxRate,
      fxHomeCurrency: e.homeCurrency,
    })),
    withFxOverride(fxRateMapFrom(fxRows), report.currency.code, fxOverrideOf(report)),
  );
}

/**
 * Recompute and persist the report total, under the status guard described above.
 *
 * Given the shared client, opens a transaction so the lock, the check and the write
 * are one unit. Given a transaction client, runs inside the caller's transaction —
 * and under the caller's lock, if it already took one (`lockReportStatus`).
 *
 * Resolves null for a report that is not there: this runs after a delete, and from a
 * worker whose job outlived its report. Throwing would fail a job whose work is done.
 */
export async function recomputeReportTotal(
  db: ReportTotalDb,
  reportId: string,
  options: RecomputeReportTotalOptions = {},
): Promise<RecomputeReportTotalResult | null> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return db.$transaction((tx) => recomputeReportTotalIn(tx, reportId, options));
  }
  return recomputeReportTotalIn(db as Prisma.TransactionClient, reportId, options);
}

async function recomputeReportTotalIn(
  tx: Prisma.TransactionClient,
  reportId: string,
  options: RecomputeReportTotalOptions,
): Promise<RecomputeReportTotalResult | null> {
  // Lock first, then read: a decision committing a moment before this waits for
  // nothing and is seen; one racing it waits for this commit and then applies to the
  // total written here. Either order is a total that was open when it was written.
  const rows = await tx.$queryRaw<
    { status: string; totalMinor: bigint | number | string }[]
  // VeloExpense: VeloExpense's table and column names.
  >`SELECT status::text AS "status", total_minor AS "totalMinor" FROM expense_report WHERE id = ${reportId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) return null;

  // VeloExpense: the ledger-posting row (`postingStatusOf`), not a NetSuite satellite.
  const syncStatus: string | null = await postingStatusOf(tx, reportId);
  const frozen =
    !RECOMPUTABLE_REPORT_STATUSES.has(row.status) ||
    (syncStatus !== null && POSTED_SYNC_STATUSES.has(syncStatus));

  if (frozen) {
    const reason = options.allowFrozen?.reason.trim();
    if (!reason) throw new ReportTotalFrozenError(reportId, row.status, syncStatus);
    // Loud on purpose. The audit row is the wrapper's job; the log line is the one
    // trace that exists even if somebody calls this directly.
    // VeloExpense: `posting=` (the ledger-posting state) where ExpenseOS logs `netsuite=`.
    console.warn(
      `[report-total] frozen override: report=${reportId} status=${row.status} ` +
        `posting=${syncStatus ?? 'none'} actor=${options.allowFrozen?.actor ?? 'unspecified'} ` +
        `reason="${reason}"`,
    );
  }

  const rollup = await reportRollupFor(tx, reportId);
  if (!rollup) return null;
  const totalMinor = BigInt(rollup.homeTotalMinor);
  await tx.expenseReport.update({
    where: { id: reportId },
    data: { totalMinor },
  });
  return {
    reportId,
    status: row.status,
    syncStatus,
    frozen,
    previousTotalMinor: BigInt(row.totalMinor),
    totalMinor,
  };
}

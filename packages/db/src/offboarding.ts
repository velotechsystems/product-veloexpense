/**
 * Offboarding roll-up — when an employee leaves (admin deactivate → DEACTIVATED,
 * or directory sync → TERMINATED), their virtual cards and open expense reports
 * transfer to their manager so nothing is stranded on a dead account.
 *
 *   Cards  → reassigned to the manager, kept ACTIVE, tagged `rolledUpFromUserId`
 *            (the manager/AP "awaiting reassignment" queue). With no manager
 *            they are FROZEN and tagged so AP can pick them up. CLOSED cards are
 *            never touched.
 *   Reports→ open reports (DRAFT / SUBMITTED / RETURNED) move to the manager.
 *            Finalized reports (APPROVED / REJECTED / REIMBURSED) stay put so
 *            historical records keep their real submitter. With no manager they
 *            are left in place (derivably orphaned: open + submitter departed).
 *
 * Pure Prisma + idempotent (the `rolledUpFromUserId` tag guards cards against a
 * second roll-up), so both the web `users.deactivate` mutation and the worker's
 * directory-sync reconciliation can call it. Callers own the audit row.
 *
 * VeloExpense: ported from ExpenseOS `packages/db/src/offboarding.ts` (1e682dd6) with People 2
 * (`users.deactivate`), the REPORTS half only. Virtual cards are out of scope (7 Oct 2026), so
 * the cards half and its two counts are not ported; the summary keeps ExpenseOS's report
 * fields. Exported from the package root (`@expenseos/db`), not a subpath.
 */

import type { Prisma, PrismaClient } from '@/lib/generated/prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Open (in-flight) report statuses that follow the departed user to their
 *  manager. Kept as strings to avoid an enum import in this leaf module. */
const OPEN_REPORT_STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED'] as const;

export interface OffboardRollupSummary {
  managerId: string | null;
  /** Open reports moved to the manager. */
  reportsToManager: number;
  /** Open reports left in place (no manager) — AP-visible, derivably orphaned. */
  reportsOrphaned: number;
}

/**
 * Roll up a departed user's cards + open reports to their manager. Safe to call
 * repeatedly; a card already rolled up (rolledUpFromUserId set) is skipped.
 * VeloExpense: reports only (see the header); a second call finds no open report left.
 */
export async function rollUpOnOffboard(db: Db, userId: string): Promise<OffboardRollupSummary> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { managerId: true } });
  const managerId = user?.managerId ?? null;

  const summary: OffboardRollupSummary = {
    managerId,
    reportsToManager: 0,
    reportsOrphaned: 0,
  };

  // VeloExpense: no cards (see the header).

  // ── Open reports ───────────────────────────────────────────────────
  const reportWhere = { submitterId: userId, status: { in: [...OPEN_REPORT_STATUSES] } };
  if (managerId) {
    const res = await db.expenseReport.updateMany({
      where: reportWhere,
      data: { submitterId: managerId },
    });
    summary.reportsToManager = res.count;
  } else {
    summary.reportsOrphaned = await db.expenseReport.count({ where: reportWhere });
  }

  return summary;
}

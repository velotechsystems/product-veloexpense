/**
 * VeloExpense (w4-02d, d66): the budget impacts ExpenseOS's `BUDGET_OVERAGE` kind reads,
 * from VeloExpense's own budgets.
 *
 * ExpenseOS computes them in its approval engine (`evaluateReportAgainstBudgets`). Here the
 * engine reads THIS (packages/approvals/src/budgets.ts, w4-04), so the number an approver is
 * routed on is the number the submitter was shown — ExpenseOS's rule. It maps VeloExpense's
 * per-period projection (`lib/budgets`, the same numbers v1's `BUDGET_OVERAGE` read) into
 * ExpenseOS's `BudgetImpact` shape:
 *
 *   · an impact is a period this report's spend takes PAST its budget (projected spend —
 *     approved + in flight + this report, the report counted once whatever its status,
 *     w4-04 — over the amount), as v1 judged it; its
 *     `crossedBp` is the 100% line (10000 bp). VeloExpense's alert thresholds below 100%
 *     are the alerts' business (lib/budgets/alerts.ts), not the submit check's, as before;
 *   · `glAccountId` and `monthIndex` (1-based within the budget's year) are read from the
 *     budget and its periods, as ExpenseOS reports them.
 *
 * Not carried: v1's separate INFO when a period's projection rests on spend that could not
 * be converted. `BudgetImpact` has no place for it, and ExpenseOS's engine routes on the
 * converted spend alone, as the approval facts here do (w4-04).
 */
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { projectedMinor } from '@/lib/budgets/scope';
import { loadBudgetSnapshots } from '@/lib/budgets/service';
import type { BudgetImpact } from './types';

/** The 100% line, in basis points. */
const OVER_BUDGET_BP = 10_000;

export async function budgetImpactsFor(db: TenantDb, reportId: string): Promise<BudgetImpact[]> {
  const tx = queryRunnerOf(db);
  const snapshots = await loadBudgetSnapshots(tx, reportId);
  const over = snapshots.filter((s) => s.amountMinor > 0n && projectedMinor(s) > s.amountMinor);
  if (over.length === 0) return [];
  const where = await tx.query(
    `SELECT p.id, b.gl_account_id,
            row_number() OVER (PARTITION BY p.budget_id ORDER BY p.starts_on)::int AS month_index
       FROM budget_period p JOIN budget b ON b.id = p.budget_id
      WHERE p.budget_id = ANY($1::uuid[])`,
    [[...new Set(over.map((s) => s.budgetId))]],
  );
  const byPeriod = new Map(
    where.rows.map((r) => [r.id as string, { glAccountId: r.gl_account_id as string, monthIndex: r.month_index as number }]),
  );
  return over.map((s) => ({
    budgetId: s.budgetId,
    glAccountId: byPeriod.get(s.periodId)?.glAccountId ?? '',
    monthIndex: byPeriod.get(s.periodId)?.monthIndex ?? 0,
    amountMinor: s.amountMinor,
    usedMinor: projectedMinor(s),
    crossedBp: OVER_BUDGET_BP,
    currencyCode: s.currencyCode,
  }));
}

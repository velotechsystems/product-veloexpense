/**
 * VeloExpense (w4-04, d66): the budget facts for the approval engine — `overBudget` and
 * `budgetOverageMinor` — from VeloExpense's budgets.
 *
 * NOT a port of ExpenseOS's `packages/approvals/src/budgets.ts`. That file derives actuals
 * on read from ExpenseOS's budget tables (`budget`, `budget_period` by month index,
 * `virtual_card_transaction`); VeloExpense's budgets are a different design (0024: dated
 * periods with stored rollups, `lib/budgets`), and d66 decided to bridge them rather than
 * replace them. What IS ExpenseOS's is the contract the engine calls —
 * `evaluateReportAgainstBudgets(db, reportId)` and the `ReportBudgetEvaluation` it returns —
 * and ExpenseOS's rule for it:
 *
 *   "Shared by the submit-time warning and the routing facts, so the number an approver is
 *    routed on is the same number the submitter was shown."
 *
 * So this reads the very impacts the submit-time `BUDGET_OVERAGE` rule reads
 * (`server/policy/budgetBridge.ts`), and ExpenseOS's last step — which impacts are over, and
 * by how much — is carried verbatim.
 *
 * Differences from ExpenseOS's numbers, each a property of the bridge:
 *   · an impact is a period taken PAST its budget (the 100% line), not one past any alert
 *     threshold; VeloExpense's lower thresholds are the alerts' business (lib/budgets/alerts);
 *   · `underThreshold` is always empty: VeloExpense re-arms its alert markers from the
 *     stored rollup (lib/budgets/alerts.ts), so nothing here needs it;
 *   · the report is counted ONCE whatever its status (`BudgetSnapshot.reportInRollup`): the
 *     engine runs after submit has rolled the report into "pending", which the bridge must
 *     not add a second time;
 *   · no card spend (VeloExpense has no card transactions).
 *
 * `overageMinor` sums the overage across every budget the report pushes over, each in its
 * own budget's currency, as ExpenseOS does — meaningful while a tenant's budgets share a
 * currency, which is every tenant today (flag f37).
 */
import type { Prisma, PrismaClient } from '@expenseos/db';
import type { TenantDb } from '@/lib/db/prisma';
import { budgetImpactsFor } from '@/server/policy/budgetBridge';
import type { BudgetImpact } from '@/server/policy/types';

/** Matches the engine's: fact-building happens inside a transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

export type { BudgetImpact };

export interface ReportBudgetEvaluation {
  /** Budget periods this report's spend pushes past their budget. */
  impacts: BudgetImpact[];
  /** ExpenseOS's alert re-arm list. VeloExpense: always empty (see the header). */
  underThreshold: { budgetId: string; monthIndex: number }[];
  overBudget: boolean;
  overageMinor: bigint;
}

export async function evaluateReportAgainstBudgets(
  db: Db,
  reportId: string,
): Promise<ReportBudgetEvaluation> {
  // VeloExpense: the engine's `db` IS the request's tenant transaction (lifecycle.ts passes
  // `requireTenantDb(tx)`), which is what the bridge reads through.
  const impacts = await budgetImpactsFor(db as unknown as TenantDb, reportId);
  const over = impacts.filter((i) => i.usedMinor > i.amountMinor);
  return {
    impacts,
    underThreshold: [],
    overBudget: over.length > 0,
    overageMinor: over.reduce((acc, i) => acc + (i.usedMinor - i.amountMinor), 0n),
  };
}

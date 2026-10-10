/**
 * Shared eligibility resolution for expense-report approval — used by the
 * approver surfaces (the approvals inbox drawer and the workbench in approver
 * mode) and by `expenses.report` to admit an eligible approver as a reader.
 *
 * Authorization mirrors the VCC / `expenseApprovals` model: being an eligible
 * (assigned or claimable) approver of a PENDING task on the report's running
 * instance IS the authorization — there's no blanket "approve" permission.
 *
 * VeloExpense: an ADAPTER until Wave 4 ports ExpenseOS's approval engine (d23), not a
 * port. ExpenseOS asks its engine's `canDecide` over its own tasks; VeloExpense's
 * approvals run on its own engine, so the question goes to VeloExpense's
 * `resolveDecidableTask` (lib/approvals/inbox.ts) — the function VeloExpense's own
 * decision panel and decide action already share, ported in shape from this one — on the
 * caller's own transaction (`queryRunnerOf`). `mayOverride` is passed as VeloExpense's
 * `isAdmin` override, which is the same grant: decide anyone's report but your own.
 */
import { resolveDecidableTask as resolveVeloExpenseTask } from '@/lib/approvals/inbox';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';

type Db = TenantDb;

/**
 * The first PENDING task on `reportId`'s running approval instance that
 * `userId` may decide — or, with `mayOverride` (the `expense.report.decide.any`
 * grant), any of them but their own. Returns `null` when the report has no
 * running instance or the caller has no decidable task.
 */
export async function resolveDecidableTask(
  db: Db,
  reportId: string,
  userId: string,
  mayOverride: boolean,
): Promise<string | null> {
  return resolveVeloExpenseTask(queryRunnerOf(db), reportId, userId, { isAdmin: mayOverride });
}

/**
 * True when `userId` may decide on `reportId` — an eligible approver of a PENDING task
 * on the report's running instance, which an override holder is for anyone's report but
 * their own.
 */
export async function callerCanDecideReport(
  db: Db,
  reportId: string,
  userId: string,
  mayOverride: boolean,
): Promise<boolean> {
  return (await resolveDecidableTask(db, reportId, userId, mayOverride)) != null;
}

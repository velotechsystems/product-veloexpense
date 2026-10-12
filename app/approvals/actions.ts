'use server';
/**
 * VX2-4 — the approver's inbox, read for /approvals.
 *
 * w4-00c: read from ExpenseOS's engine — `loadMyExpenseApprovalTasks`, the same loader
 * ExpenseOS's `expenseApprovals.myTasks` answers the sidebar's count from — so the page and
 * the count cannot disagree. Being an eligible approver of a pending task IS the
 * authorization, as ExpenseOS says ("being an eligible (assigned or claimable) approver of a
 * PENDING task on the report's running instance IS the authorization"); deciding happens on
 * the report, through `expenseApprovals.decide`, which asks the engine again.
 *
 * The form action that decided from this page (`decideFromForm`) is gone with the ladder:
 * nothing posted to it since the report workbench took over deciding (w2-02a).
 */
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { withTenantDb } from '@/lib/db/prisma';
import type { InboxRoute } from '@/lib/i18n/catalog/enums';
import { loadMyExpenseApprovalTasks } from '@/server/routers/expenseApprovals';
import { shellContext } from '@/server/shell';

export async function getInbox() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { user } = shell;
  return withTenantDb(user.organizationId, async (db) => {
    const inbox = await loadMyExpenseApprovalTasks(db, user.id);
    // VeloExpense: why each one is yours — assigned to you, or open to you to take (a pool,
    // or the no-manager fallback). The loader lists only those two.
    const assigned = new Set(
      (
        await db.approvalTask.findMany({
          where: { id: { in: inbox.items.map((i) => i.taskId) }, assigneeUserId: user.id },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    return {
      tasks: inbox.items.map((i) => ({
        ...i,
        route: (assigned.has(i.taskId) ? 'ASSIGNED' : 'ROLE_POOL') as InboxRoute,
      })),
      capped: inbox.capped,
      cappedAt: inbox.cappedAt,
      actor: { id: user.id, isAdmin: shell.rbac.roleId === SYSTEM_ROLE_IDS.admin },
    };
  });
}

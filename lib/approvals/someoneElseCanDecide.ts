/**
 * w4-00c, generalised in f61: would a subject's first approvals sit with nobody able to
 * act on them?
 *
 * The engine assigns what the flow names, and `canDecide` refuses a requester their own
 * subject — so a task parked on the requester, or a pool whose only member is the
 * requester, is a subject nobody can move. Two cases are knowable at submit, and both
 * count as stranded:
 *   · a task ASSIGNED to the requester (a named fallback, a manager chain that loops back);
 *   · an UNASSIGNED task whose node falls back to a ROLE that nobody but the requester
 *     holds — the default flow's case (d59) for a solo founder.
 * A filter pool, or a relative approver with no fallback, is open to whoever the engine
 * finds eligible when they look; this does not try to predict that, and does not count it.
 *
 * Reports (`lib/expenses/lifecycle.ts`) and travel requests (`travelRequests.submit`) both
 * refuse a submit when this answers true — the 4 Oct 2026 rule: nobody approves their
 * own expenses or their own trip, including the only person in the tenant.
 */
import type { TenantDb } from '@/lib/db/prisma';

/**
 * True when EVERY first approval in `taskIds` is stranded on `requesterId`. One reachable
 * approval of several (a parallel step) is enough to keep the subject moving. No tasks
 * (a flow that decided on submit) is never stranded.
 */
export async function onlyRequesterCouldDecide(
  db: TenantDb,
  requesterId: string,
  taskIds: string[],
): Promise<boolean> {
  if (taskIds.length === 0) return false;
  const tasks = await db.approvalTask.findMany({
    where: { id: { in: taskIds } },
    select: {
      assigneeUserId: true,
      nodeId: true,
      instance: { select: { effectiveGraph: true } },
    },
  });
  const stranded: boolean[] = [];
  for (const t of tasks) {
    if (t.assigneeUserId !== null) {
      stranded.push(t.assigneeUserId === requesterId);
      continue;
    }
    const graph = t.instance.effectiveGraph as {
      nodes?: Array<{ id: string; approver?: { fallback?: { kind: string; roleId?: string } } }>;
    } | null;
    const fallback = graph?.nodes?.find((n) => n.id === t.nodeId)?.approver?.fallback;
    if (fallback?.kind !== 'role' || !fallback.roleId) {
      stranded.push(false);
      continue;
    }
    const others = await db.user.count({
      where: {
        roleId: fallback.roleId,
        id: { not: requesterId },
        deletedAt: null,
        employeeStatus: 'ACTIVE',
      },
    });
    stranded.push(others === 0);
  }
  return stranded.length > 0 && stranded.every(Boolean);
}

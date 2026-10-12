/**
 * Approval notification recipients. Resolves WHO should be notified about a
 * task — the concrete assignee, or (for an unassigned POOL node) its members:
 * a filter-approver's predicate match, or the role a relative approver names as
 * its no-manager fallback. Delivery itself goes through the activity stream:
 * the router records an Activity and calls notifyRecipients(), which writes the
 * in-app rows and enqueues notification.dispatch for email/Slack (gated on the
 * relevant integration + per-user prefs). This module no longer sends email.
 *
 * VeloExpense (w4-00c): ExpenseOS's module. A role fallback's holders are the people whose
 * text role stands for that system role (`rolesStandingFor`), until the role builder (w4-10).
 */

import { graphSchema, type Predicate, type PredicateField } from '@expenseos/approvals';
import type { Prisma, PrismaClient } from '@expenseos/db';
import { rolesStandingFor } from '@/lib/approvals/systemRoleHolders';

type Db = PrismaClient | Prisma.TransactionClient;

/** User columns a filter-approver predicate can target. */
const FIELD_COL: Partial<Record<PredicateField, string>> = {
  departmentId: 'departmentId',
  legalEntityId: 'legalEntityId',
  businessUnitId: 'businessUnitId',
  employeeStatus: 'employeeStatus',
  jobLevelId: 'jobLevelId',
  userId: 'id',
};

/** Best-effort translation of a filter-approver predicate into a User `where`,
 *  for picking notification recipients. Returns null when it can't bound the
 *  set (e.g. `always`, or an untranslatable OR) so we don't mass-notify. */
function predicateToUserWhere(p: Predicate): Prisma.UserWhereInput | null {
  if ('always' in p) return null;
  if ('field' in p) {
    const col = FIELD_COL[p.field];
    if (!col) return null;
    const v = p.value;
    switch (p.op) {
      case 'eq':
        return { [col]: v } as Prisma.UserWhereInput;
      case 'neq':
        return { NOT: { [col]: v } } as Prisma.UserWhereInput;
      case 'in':
        return Array.isArray(v) ? ({ [col]: { in: v } } as Prisma.UserWhereInput) : null;
      case 'nin':
        return Array.isArray(v) ? ({ NOT: { [col]: { in: v } } } as Prisma.UserWhereInput) : null;
      default:
        return null;
    }
  }
  if ('all' in p) {
    const parts = p.all.map(predicateToUserWhere).filter((x): x is Prisma.UserWhereInput => !!x);
    return parts.length ? { AND: parts } : null;
  }
  // OR is only sound if every branch translates.
  const parts = p.any.map(predicateToUserWhere);
  return parts.every(Boolean) ? { OR: parts as Prisma.UserWhereInput[] } : null;
}

/** The userIds to notify about a newly-created task: the concrete assignee, or
 *  — for an unassigned pool node — its members (capped). A pool is either a
 *  `filter` approver's predicate match, or the active holders of the role a
 *  relative approver names as its no-manager fallback. */
async function recipientsForTask(
  db: Db,
  task: {
    assigneeUserId: string | null;
    nodeId: string;
    instance: { effectiveGraph: unknown; workflowVersion: { graph: unknown } };
  },
): Promise<string[]> {
  if (task.assigneeUserId) return [task.assigneeUserId];

  const graph = graphSchema.safeParse(
    task.instance.effectiveGraph ?? task.instance.workflowVersion.graph,
  );
  if (!graph.success) return [];
  const node = graph.data.nodes.find((n) => n.id === task.nodeId);
  if (!node || node.type !== 'approval') return [];

  // A relative approver that resolved to nobody and whose node names a ROLE
  // fallback: the role's active holders are the ones who may claim it, so they
  // are the ones who have to be told. Without this the task is claimable and
  // silent — visible only to somebody who happens to open their queue — which is
  // most of the way back to the dead end the fallback exists to close.
  if (node.approver.kind === 'manager' || node.approver.kind === 'managerChain') {
    const fb = node.approver.fallback;
    if (fb?.kind !== 'role') return [];
    // VeloExpense: the text roles that stand for the named system role.
    const holders = await db.user.findMany({
      where: { deletedAt: null, employeeStatus: 'ACTIVE', role: { in: rolesStandingFor(fb.roleId) } },
      select: { id: true },
      take: 50,
    });
    return holders.map((h) => h.id);
  }

  if (node.approver.kind !== 'filter') return [];
  const matchWhere = predicateToUserWhere(node.approver.match);
  if (!matchWhere) return []; // unbounded filter — skip mass notify
  let minSort: number | null = null;
  if (node.approver.minJobLevelId) {
    const m = await db.jobLevel.findUnique({
      where: { id: node.approver.minJobLevelId },
      select: { sortOrder: true },
    });
    minSort = m?.sortOrder ?? 0;
  }
  const members = await db.user.findMany({
    where: {
      deletedAt: null,
      employeeStatus: 'ACTIVE',
      ...matchWhere,
      ...(minSort != null ? { jobLevel: { sortOrder: { gte: minSort } } } : {}),
    },
    select: { id: true },
    take: 50,
  });
  return members.map((m) => m.id);
}

/** Distinct userIds to notify across the given newly-created tasks. */
export async function taskRecipientIds(db: Db, taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const ids = new Set<string>();
  for (const id of taskIds) {
    const task = await db.approvalTask.findUnique({
      where: { id },
      select: {
        assigneeUserId: true,
        nodeId: true,
        instance: {
          select: {
            effectiveGraph: true,
            workflowVersion: { select: { graph: true } },
          },
        },
      },
    });
    if (!task) continue;
    for (const r of await recipientsForTask(db, task)) ids.add(r);
  }
  return [...ids];
}

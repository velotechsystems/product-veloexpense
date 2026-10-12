/**
 * Executes the pass-through side-effects a workflow run emits (`firedEffects`
 * from startInstance / decideTask):
 *   - **Notify** node → resolve the target + fan out through the activity stream
 *     (in-app + email/Slack).
 *   - **Action** node → `setField` writes into the subject's `metadata`;
 *     `integration` runs the named hook from ACTION_HOOK_REGISTRY (v1: an audited
 *     "action fired" entry; more register as integrations land).
 *
 * Best-effort + fire-and-forget: callers `void` this after the decision commits,
 * exactly like the report/VCC decision fan-out.
 *
 * VeloExpense: ExpenseOS's module (550b2945), w4-00c-1. The plumbing, marked below:
 *   · it runs INSIDE the caller's tenant transaction and is awaited, rather than fired off
 *     after the commit — the transaction is the tenant scope, and VeloExpense records every
 *     notification on the transaction that caused it (delivery is the outbox's job). It
 *     stays best-effort: the whole fan-out sits under a savepoint, and a failure rolls back
 *     to it and is logged, so it never undoes the decision it follows;
 *   · notifications are VeloExpense's (`lib/notifications/service.ts`): a NOTIFY activity
 *     with the report's placeholders, on the same transaction (`queryRunnerOf`);
 *   · a `role` target is the people whose VeloExpense role stands for that ExpenseOS system
 *     role (`systemRoleFor`), until the role builder (w4-10);
 *   · the subject is an expense report; the virtual-card branch is out of scope (d50).
 */

import type { NotifyTarget } from '@expenseos/approvals';
import { graphSchema } from '@expenseos/approvals';
import { type ApprovalSubjectType, loadRequesterId } from '@expenseos/approvals/engine';
import { auditActions, withAudit } from '@expenseos/audit';
import type { Prisma } from '@expenseos/db';
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';

/** VeloExpense: the caller's tenant transaction. */
type PrismaClient = TenantDb;

/**
 * Registry of Action-node integration hooks (server side). Each records/performs
 * the side-effect the hook name promises. v1 ships `audit.log`; real integrations
 * (NetSuite post-on-approval, etc.) register here as they're built. An unknown
 * hook is a logged no-op. The client-safe hook catalog is `@/lib/workflowActionHooks`.
 */
type HookContext = {
  subjectType: ApprovalSubjectType;
  subjectId: string;
  nodeId: string;
  actorId?: string | null;
};
const ACTION_HOOK_REGISTRY: Record<string, (db: PrismaClient, ctx: HookContext) => Promise<void>> =
  {
    'audit.log': async (db, ctx) => {
      // A hash-chained audit entry that the workflow's Action node fired. The
      // actor is the engine itself (system), with the deciding user in details.
      await withAudit(
        db,
        {
          action: auditActions.workflow.actionFired,
          entityType: ctx.subjectType,
          entityId: ctx.subjectId,
          actor: { kind: 'system', jobName: 'workflow.action' },
          details: { hook: 'audit.log', nodeId: ctx.nodeId, triggeredBy: ctx.actorId ?? null },
        },
        async () => {},
      );
    },
  };

/** Resolve a Notify node's target to concrete recipient user ids. */
async function resolveNotifyTarget(
  db: PrismaClient,
  target: NotifyTarget,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<string[]> {
  switch (target.kind) {
    case 'user':
      return [target.userId];
    case 'role': {
      // VeloExpense: the text roles that stand for the named system role (`systemRoleFor`:
      // ADMIN → admin, EMPLOYEE and MANAGER → employee). Any other id names nobody yet.
      const roles =
        target.roleId === SYSTEM_ROLE_IDS.admin
          ? ['ADMIN']
          : target.roleId === SYSTEM_ROLE_IDS.employee
            ? ['EMPLOYEE', 'MANAGER']
            : [];
      if (roles.length === 0) return [];
      const users = await db.user.findMany({
        where: { role: { in: roles }, deletedAt: null },
        select: { id: true },
      });
      return users.map((u) => u.id);
    }
    case 'requester': {
      const id = await loadRequesterId(db, subjectType, subjectId);
      return id ? [id] : [];
    }
    case 'manager': {
      const requesterId = await loadRequesterId(db, subjectType, subjectId);
      if (!requesterId) return [];
      const u = await db.user.findUnique({
        where: { id: requesterId },
        select: { managerId: true },
      });
      return u?.managerId ? [u.managerId] : [];
    }
    default:
      return [];
  }
}

export async function executeWorkflowEffects(
  db: PrismaClient,
  opts: {
    subjectType: ApprovalSubjectType;
    subjectId: string;
    effectNodeIds: string[];
    /** The decider/submitter — never notified about their own action. */
    actorId?: string | null;
  },
): Promise<void> {
  if (opts.effectNodeIds.length === 0) return;
  // VeloExpense: in the caller's transaction, under a savepoint (see the header).
  await db.$executeRaw`SAVEPOINT workflow_effects`;
  await (async () => {
    // The fired effect node ids reference the instance's frozen graph.
    const instance = await db.approvalInstance.findFirst({
      where: { subjectType: opts.subjectType, subjectId: opts.subjectId },
      orderBy: { startedAt: 'desc' },
      select: { effectiveGraph: true, workflowVersion: { select: { graph: true } } },
    });
    if (!instance) return;
    const parsed = graphSchema.safeParse(instance.effectiveGraph ?? instance.workflowVersion.graph);
    if (!parsed.success) return;
    const byId = new Map(parsed.data.nodes.map((n) => [n.id, n]));

    // Action `setField` writes coalesce into one metadata patch per subject.
    const metadataPatch: Record<string, string | boolean | null> = {};

    for (const nodeId of opts.effectNodeIds) {
      const node = byId.get(nodeId);
      if (!node) continue;
      if (node.type === 'notify') {
        const recipients = (
          await resolveNotifyTarget(db, node.target, opts.subjectType, opts.subjectId)
        ).filter((id) => id !== opts.actorId);
        if (recipients.length === 0) continue;
        // VeloExpense: a NOTIFY activity on this transaction, with the report's placeholders.
        const runner = queryRunnerOf(db);
        const activityId = await recordActivity(runner, {
          subjectType: opts.subjectType as 'EXPENSE_REPORT',
          subjectId: opts.subjectId,
          eventType: 'NOTIFY',
          actorId: opts.actorId ?? null,
          payload: await notifyPayload(db, opts.subjectId),
        });
        await notifyRecipients(runner, activityId, recipients);
      } else if (node.type === 'action') {
        for (const act of node.actions) {
          if (act.kind === 'setField') {
            metadataPatch[act.key] = act.value;
          } else if (act.kind === 'integration') {
            const hook = ACTION_HOOK_REGISTRY[act.hook];
            if (hook) {
              await hook(db, {
                subjectType: opts.subjectType,
                subjectId: opts.subjectId,
                nodeId,
                actorId: opts.actorId,
              });
            } else {
              console.warn('[workflow] unknown action hook', act.hook);
            }
          }
        }
      }
    }

    if (Object.keys(metadataPatch).length > 0) {
      await applyMetadataPatch(db, opts.subjectType, opts.subjectId, metadataPatch);
    }
  })().then(
    () => db.$executeRaw`RELEASE SAVEPOINT workflow_effects`,
    async (e) => {
      await db.$executeRaw`ROLLBACK TO SAVEPOINT workflow_effects`;
      console.warn('[workflow] effect execution failed', e);
    },
  );
}

/** VeloExpense: the report placeholders a NOTIFY's template reads (`reportPayload`). */
async function notifyPayload(db: PrismaClient, reportId: string): Promise<Record<string, string>> {
  const r = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { title: true, number: true, totalMinor: true, currencyId: true },
  });
  return r
    ? reportPayload({ title: r.title, number: r.number, totalMinor: r.totalMinor, currencyCode: r.currencyId })
    : {};
}

/** Merge a workflow Action node's field-set patch into the subject's `metadata`
 *  JSON map (read-merge-write; effects run sequentially so no lost-update). */
async function applyMetadataPatch(
  db: PrismaClient,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  patch: Record<string, string | boolean | null>,
): Promise<void> {
  const merge = (existing: unknown): Prisma.InputJsonValue =>
    ({
      ...(existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
      ...patch,
    }) as Prisma.InputJsonValue;
  if (subjectType === 'EXPENSE_REPORT') {
    const row = await db.expenseReport.findUnique({
      where: { id: subjectId },
      select: { metadata: true },
    });
    if (!row) return;
    await db.expenseReport.update({
      where: { id: subjectId },
      data: { metadata: merge(row.metadata) },
    });
  }
  // VeloExpense: no virtual-card subjects (d50).
}

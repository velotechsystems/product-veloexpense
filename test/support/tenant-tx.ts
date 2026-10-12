/**
 * w4-00c — a tenant transaction for the db suites that drive a report through its lifecycle.
 *
 * Submitting and recalling start and stop ExpenseOS's approval engine, which is Prisma code,
 * in the same transaction as the report's status (`lib/expenses/lifecycle.ts`,
 * `requireTenantDb`). A plain `pg` transaction (`withOrg`) cannot carry it: the engine would be
 * another connection, waiting on the report row the lifecycle has locked. So these suites
 * open the tenant's Prisma transaction and hand their `pg`-style code the bridge onto it
 * (`queryRunnerOf`) — the same transaction the app's procedures run in.
 *
 * `withTenantTx` takes the place of `withOrg` in a suite unchanged: same arguments, same
 * `QueryRunner`. The bridge's one difference a suite may notice is that a `date` column comes
 * back as a `Date` (lib/db/prisma-pg-bridge.ts says so).
 */
import type { QueryRunner } from '@/lib/db/client';
import { withTenantDb, type TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';

export function withTenantTx<T>(
  orgId: string,
  fn: (tx: QueryRunner, db: TenantDb) => Promise<T>,
): Promise<T> {
  return withTenantDb(orgId, (db) => fn(queryRunnerOf(db), db));
}

/**
 * The default approval flow (lib/approvals/defaultWorkflow.ts) for a suite's own tenant, which
 * `createOrganization` gives a real one. A suite that inserts its organization by hand has
 * none, and a submit with no workflow is refused (d58) — so a suite that submits seeds it.
 */
export async function seedDefaultFlow(orgId: string): Promise<void> {
  const { seedDefaultExpenseWorkflow } = await import('@/lib/approvals/defaultWorkflow');
  await withTenantTx(orgId, (tx) => seedDefaultExpenseWorkflow(tx, null).then(() => undefined));
}

/**
 * w4-00c: one approver's decision, as the app makes it (`decideThroughEngine`, the body of
 * `expenseApprovals.decide`), in its own tenant transaction. The ladder's suites called its
 * `decide(tx, taskId, actor, 'APPROVED', …)`; this is that call on the engine.
 */
export async function decideAs(
  orgId: string,
  taskId: string,
  actorId: string,
  decision: 'APPROVED' | 'REJECTED',
  opts: { note?: string | null; override?: boolean } = {},
) {
  const { decideThroughEngine } = await import('@/server/lib/reportLifecycle');
  return withTenantDb(orgId, (db) =>
    decideThroughEngine(db, {
      taskId,
      actorId,
      approve: decision === 'APPROVED',
      note: opts.note ?? null,
      mayOverride: opts.override ?? false,
    }),
  );
}

/**
 * w4-00c: a submit as `expenses.submit` makes it — the lifecycle's transition, then ExpenseOS's
 * hooks after it (the first approvers told, the workflow's effects) — in one tenant
 * transaction. The ladder notified inside the transition; the engine leaves it to the caller,
 * as ExpenseOS's router does, so a suite about what a submit SENDS submits through this.
 */
export async function submitAsApp(orgId: string, reportId: string, actorId: string) {
  const { submitReport } = await import('@/lib/expenses/lifecycle');
  const { notifyReportSubmitted } = await import('@/server/lib/reportNotify');
  const { executeWorkflowEffects } = await import('@/server/lib/workflowEffects');
  return withTenantTx(orgId, async (tx, db) => {
    const res = await submitReport(tx, reportId, actorId);
    await notifyReportSubmitted(db, reportId, actorId, res.approval.createdTaskIds);
    await executeWorkflowEffects(db, {
      subjectType: 'EXPENSE_REPORT',
      subjectId: reportId,
      effectNodeIds: res.approval.firedEffects,
      actorId,
    });
    return res;
  });
}

/** w4-00c: a recall as `expenses.recall` makes it — the transition, then the approvers told. */
export async function recallAsApp(orgId: string, reportId: string, actorId: string) {
  const { recallReport } = await import('@/lib/expenses/lifecycle');
  const { notifyReportRecalled } = await import('@/server/lib/reportNotify');
  return withTenantTx(orgId, async (tx, db) => {
    const res = await recallReport(tx, reportId, actorId);
    await notifyReportRecalled(db, reportId, actorId, res.cancelledTaskIds);
    return res;
  });
}

/**
 * w4-00c: publish a workflow for expense reports, more specific than the default (a higher
 * priority wins), as an admin does in the builder. The ladder's suites built a rung with
 * `approvals.createPolicy`; this is that, on the engine. Returns the workflow id.
 */
export async function publishFlow(
  orgId: string,
  key: string,
  graph: { nodes: unknown[]; edges: unknown[] },
  priority = 10,
): Promise<string> {
  return withTenantTx(orgId, async (tx) => {
    const wf = (
      await tx.query(
        `INSERT INTO approval_workflow (key, name, subject_type, priority)
         VALUES ($1, $1, 'EXPENSE_REPORT', $2) RETURNING id`,
        [key, priority],
      )
    ).rows[0].id as string;
    const v = (
      await tx.query(
        `INSERT INTO approval_workflow_version (workflow_id, version, match_condition, graph, status, published_at)
         VALUES ($1, 1, '{"always": true}', $2::jsonb, 'PUBLISHED', now()) RETURNING id`,
        [wf, JSON.stringify(graph)],
      )
    ).rows[0].id as string;
    await tx.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [v, wf]);
    return wf;
  });
}

/** w4-00c: a straight line of approval steps, Start → each → Approved. */
export function linearFlow(...approvers: unknown[]) {
  const steps = approvers.map((approver, i) => ({ id: `s${i + 1}`, type: 'approval', approver }));
  const ids = ['start', ...steps.map((s) => s.id), 'done'];
  return {
    nodes: [{ id: 'start', type: 'start' }, ...steps, { id: 'done', type: 'approved' }],
    edges: ids.slice(1).map((id, i) => ({ id: `e${i + 1}`, source: ids[i], target: id })),
  };
}

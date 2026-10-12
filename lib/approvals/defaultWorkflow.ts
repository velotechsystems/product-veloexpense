/**
 * VeloExpense (w4-00c-1, d54 / d56): the approval flow every tenant starts on.
 *
 * Shaped on ExpenseOS's seeded catch-all (`seedDefaultApprovalWorkflow` in its
 * `packages/db/prisma/seed.ts`, 550b2945): Start → the requester's manager → Approved,
 * published, the default for its subject, with the no-manager fallback naming a person.
 * The differences are VeloExpense's decisions, not plumbing:
 *
 *   · it governs EXPENSE REPORTS (ExpenseOS's names a virtual-card request) — d54: no
 *     tenant's ladder is converted; every tenant starts here and changes it in the builder;
 *   · the fallback is the tenant's FIRST ADMIN (ExpenseOS: a named person from the seed's
 *     environment), so the top of the org chart is never left to a pool;
 *   · it has NO deadline and no `onExpire` (ExpenseOS: 5 business days, escalate) — d56:
 *     the manager approves, and nothing happens on its own. A blank deadline is no
 *     deadline in VeloExpense's engine.
 *
 * Seeded when a tenant is provisioned (`lib/onboarding/provision.ts`), and for the tenants
 * that existed before it by migration 0059, which writes the same graph in SQL. Without
 * it a tenant would have NO expense workflow, and ExpenseOS's engine auto-approves a
 * subject nothing governs (`NO_WORKFLOW`) — the one outcome VeloExpense must never reach
 * by omission.
 */
import type { QueryRunner } from '@/lib/db/client';

/** The default workflow's key, within its tenant. */
export const DEFAULT_EXPENSE_WORKFLOW_KEY = 'expense-report-default';

/** The default workflow's graph, with its no-manager fallback. */
export function defaultExpenseWorkflowGraph(fallbackUserId: string | null) {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 240, y: 40 } },
      {
        id: 'manager',
        type: 'approval',
        approver: {
          kind: 'manager',
          ...(fallbackUserId ? { fallback: { kind: 'user', userId: fallbackUserId } } : {}),
        },
        position: { x: 240, y: 170 },
      },
      { id: 'approved', type: 'approved', position: { x: 240, y: 320 } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'manager' },
      { id: 'e2', source: 'manager', target: 'approved' },
    ],
  };
}

/**
 * Create the tenant's default expense workflow, published, unless it has one already.
 * Runs inside the caller's transaction, scoped to the tenant (`app.current_org` set), so
 * every row takes the tenant from the column default and RLS checks it.
 *
 * Returns the workflow id, or null when the tenant already had a workflow by that key —
 * an admin's edits in the builder are never overwritten.
 */
export async function seedDefaultExpenseWorkflow(
  tx: QueryRunner,
  fallbackUserId: string | null,
): Promise<string | null> {
  const existing = await tx.query(`SELECT id FROM approval_workflow WHERE key = $1`, [
    DEFAULT_EXPENSE_WORKFLOW_KEY,
  ]);
  if (existing.rows.length > 0) return null;

  const wf = await tx.query(
    `INSERT INTO approval_workflow (key, name, description, subject_type, is_default, priority, active, created_by)
     VALUES ($1, 'Default — Manager approval',
             'The submitter''s direct manager approves. With no manager on file, the fallback approver does.',
             'EXPENSE_REPORT', true, 0, true, $2)
     RETURNING id`,
    [DEFAULT_EXPENSE_WORKFLOW_KEY, fallbackUserId],
  );
  const workflowId = wf.rows[0].id as string;
  const version = await tx.query(
    `INSERT INTO approval_workflow_version (workflow_id, version, match_condition, graph, status, published_at, published_by)
     VALUES ($1, 1, '{"always": true}'::jsonb, $2::jsonb, 'PUBLISHED', now(), $3)
     RETURNING id`,
    [workflowId, JSON.stringify(defaultExpenseWorkflowGraph(fallbackUserId)), fallbackUserId],
  );
  await tx.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [
    version.rows[0].id,
    workflowId,
  ]);
  return workflowId;
}

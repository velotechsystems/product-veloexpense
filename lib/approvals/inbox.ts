/**
 * VX2-4 — the approver's side: what is waiting on me, and what may I read.
 *
 * ── The rule that shapes this whole file ────────────────────────────────────
 *
 * The CANDIDATE QUERY decides what is in an inbox. `canDecide` decides whether
 * the actor may act. The filter only ever REMOVES rows — it never adds one — so
 * the inbox and the decide path cannot disagree about permission, which is the
 * failure GAP-AUDIT AP-15 records: ExpenseOS rendered an Approve button from a
 * role check while the mutation asked the engine, and once the engine started
 * refusing a requester their own subject, the button failed when pressed.
 *
 * That split also gives the right answer for an ADMIN. `canDecide` says an admin
 * may decide anybody's task, so filtering a broad query by permission alone
 * would put every pending approval in the tenant into an admin's inbox. An inbox
 * is "what is waiting on ME" — assigned to me, delegated to me, or a role pool I
 * hold — and an admin reaches everything else from the report itself.
 *
 * COST, stated plainly: the filter is one `canDecide` per candidate, and
 * `canDecide` is two to four queries. An inbox of twenty costs perhaps sixty
 * round trips on a page load. That is the price of the inbox and the decide path
 * being the same answer, and it is the trade ExpenseOS makes too
 * (`resolveDecidableTask` loops the same way). The candidate query is bounded by
 * `limit` so the cost cannot run away; if it ever matters, the fix is to make
 * `canDecide` batchable, NOT to reimplement it in SQL.
 */
import type { QueryRunner } from '@/lib/db/client';
import { canDecide, type DecisionContext } from '@/lib/approvals/eligibility';
import { canViewReport, type ReportAccess } from '@/lib/expenses/service';
import type { Actor } from '@/lib/auth/actor';
import type { StepPlan, TaskResolution } from '@/lib/approvals/tiers';
import { countStoredReceipts } from '@/lib/approvals/service';

/** How this task reached you. Shown, because "why am I being asked?" is the
 *  first question an approver has, and a role pool behaves differently from an
 *  assignment — nobody else's inbox holds your assigned task, but a pool task
 *  sits in several. */
export type InboxRoute = 'ASSIGNED' | 'DELEGATED' | 'ROLE_POOL';

export interface InboxTask {
  taskId: string;
  step: number;
  totalSteps: number;
  route: InboxRoute;
  resolvedVia: TaskResolution;
  /** The rung's name from the run's snapshot, not from the live ladder — an
   *  admin retuning the ladder must not change what this approval was called. */
  rungName: string | null;
  requireReceiptViewAck: boolean;
  /** Extra links walked past absent approvers, or short of the intended level.
   *  Non-zero is worth surfacing: it means the ladder was not literally met. */
  escalationLevel: number;
  /**
   * TWO different delegation facts, conflated in the first version of this file
   * and separated by a failing test.
   *
   * `coveringFor` — whose task this is, when you are seeing it because they
   * delegated to you. The task is still ASSIGNED to them; nothing was rerouted.
   * This is the common case, because a delegation created after a report was
   * submitted still lets the delegatee act on tasks already parked.
   *
   * `delegatedFrom` — whom the RESOLVER routed this task away from, at the
   * moment it was created, because a delegation was already in force. Here you
   * ARE the assignee, and this says why you rather than them.
   */
  coveringFor: string | null;
  delegatedFrom: string | null;
  reportId: string;
  reportNumber: string | null;
  reportTitle: string;
  totalMinor: string;
  currencyCode: string;
  submitterName: string;
  submittedAt: Date | null;
}

const CANDIDATES = `
  WITH me AS (
    SELECT id, role FROM app_user
     WHERE id = $1 AND deleted_at IS NULL AND employee_status = 'ACTIVE'
  )
  SELECT t.id            AS task_id,
         t.step,
         t.assignee_id,
         t.claim_role,
         t.resolved_via,
         t.escalation_level,
         COALESCE(df.display_name, df.email)  AS delegated_from,
         COALESCE(asg.display_name, asg.email) AS assignee_name,
         q.total_steps,
         q.policy_snapshot,
         rep.id          AS report_id,
         rep.number      AS report_number,
         rep.title       AS report_title,
         rep.total_minor,
         rep.currency_code,
         rep.submitted_at,
         COALESCE(sub.display_name, sub.email) AS submitter_name
    FROM approval_task    t
    JOIN approval_request q   ON q.id = t.request_id AND q.status = 'RUNNING'
    JOIN expense_report   rep ON rep.id = q.report_id
    JOIN app_user         sub ON sub.id = rep.submitter_id
    CROSS JOIN me
    LEFT JOIN app_user    df  ON df.id  = t.delegated_from_id
    LEFT JOIN app_user    asg ON asg.id = t.assignee_id
   WHERE t.status = 'PENDING'
     AND (
          t.assignee_id = me.id
       OR t.claim_role  = me.role
       OR EXISTS (
            SELECT 1 FROM delegation d
             WHERE d.to_user_id   = me.id
               AND d.from_user_id = t.assignee_id
               AND d.revoked_at IS NULL
               AND d.scope = ANY($2::text[])
               AND d.starts_on <= $3::date
               AND (d.ends_on IS NULL OR d.ends_on >= $3::date)
          )
     )
   ORDER BY rep.submitted_at NULLS LAST, t.step
   LIMIT $4`;

function routeOf(row: Record<string, unknown>, actorId: string): InboxRoute {
  if (row.assignee_id === actorId) return 'ASSIGNED';
  if (row.claim_role !== null) return 'ROLE_POOL';
  return 'DELEGATED';
}

/** The rung as it was when the run opened. */
function snapshotStep(snapshot: unknown, step: number): StepPlan | undefined {
  if (!Array.isArray(snapshot)) return undefined;
  return (snapshot as StepPlan[]).find((s) => s.step === step);
}

export async function listInbox(
  tx: QueryRunner,
  actorId: string,
  ctx: DecisionContext & { limit?: number } = {},
): Promise<InboxTask[]> {
  const onDate = ctx.onDate ?? new Date();
  const r = await tx.query(CANDIDATES, [
    actorId,
    ['ALL', 'REPORTS'],
    onDate,
    Math.min(Math.max(ctx.limit ?? 100, 1), 500),
  ]);

  const out: InboxTask[] = [];
  for (const row of r.rows) {
    // The permission answer comes from ONE place. Note this can drop a
    // candidate — most usefully the actor's own report, which the SQL would
    // happily return if a ladder routed a report to its own submitter.
    if (!(await canDecide(tx, row.task_id as string, actorId, ctx))) continue;
    const step = snapshotStep(row.policy_snapshot, row.step as number);
    const route = routeOf(row, actorId);
    out.push({
      taskId: row.task_id as string,
      step: row.step as number,
      totalSteps: row.total_steps as number,
      route,
      resolvedVia: row.resolved_via as TaskResolution,
      rungName: step?.policyName ?? null,
      requireReceiptViewAck: step?.requireReceiptViewAck ?? false,
      escalationLevel: row.escalation_level as number,
      coveringFor: route === 'DELEGATED' ? ((row.assignee_name as string | null) ?? null) : null,
      delegatedFrom: (row.delegated_from as string | null) ?? null,
      reportId: row.report_id as string,
      reportNumber: (row.report_number as string | null) ?? null,
      reportTitle: row.report_title as string,
      totalMinor: String(row.total_minor),
      currencyCode: row.currency_code as string,
      submitterName: row.submitter_name as string,
      submittedAt: (row.submitted_at as Date | null) ?? null,
    });
  }
  return out;
}

/**
 * The first PENDING task on this report that `actorId` may decide, or null.
 *
 * This is what the report page renders its decision panel from and what the
 * decide action re-resolves — one question, one answer. Ported in shape from
 * ExpenseOS's `resolveDecidableTask`, including the loop: asking `canDecide` per
 * task is what keeps the panel and the mutation in agreement.
 */
export async function resolveDecidableTask(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
  ctx: DecisionContext = {},
): Promise<string | null> {
  const r = await tx.query(
    `SELECT t.id
       FROM approval_task    t
       JOIN approval_request q ON q.id = t.request_id AND q.status = 'RUNNING'
      WHERE q.report_id = $1 AND t.status = 'PENDING'
      ORDER BY t.step`,
    [reportId],
  );
  for (const row of r.rows) {
    if (await canDecide(tx, row.id as string, actorId, ctx)) return row.id as string;
  }
  return null;
}

/**
 * May this person READ this report?
 *
 * Ownership (the submitter, or an ADMIN) OR an approval interest in it. This is
 * where MANAGER's reach finally opens, and it opens THROUGH the existing
 * predicate rather than around it: `canViewReport` is unchanged and still the
 * ownership rule, and being an approver is an additional, narrower grant.
 *
 * "Approval interest" is deliberately WIDER than "has a task I could decide
 * right now". An approver who approves a report and then cannot open it has no
 * way to answer a question about their own decision a week later, and the audit
 * trail is not a substitute for seeing the thing. So: any task on any run of
 * this report that is assigned to them, was decided by them, or sits in a role
 * pool they hold. Read only — deciding still goes through `canDecide`.
 */
export async function canReadReport(
  tx: QueryRunner,
  actor: Actor,
  access: ReportAccess,
  ctx: DecisionContext = {},
): Promise<boolean> {
  if (canViewReport(actor, access)) return true;
  const onDate = ctx.onDate ?? new Date();
  const r = await tx.query(
    `SELECT 1
       FROM approval_task    t
       JOIN approval_request q ON q.id = t.request_id
       CROSS JOIN (SELECT role FROM app_user WHERE id = $2) me
      WHERE q.report_id = $1
        AND (
             t.assignee_id  = $2
          OR t.decided_by_id = $2
          OR t.claim_role   = me.role
          OR EXISTS (
               SELECT 1 FROM delegation d
                WHERE d.to_user_id   = $2
                  AND d.from_user_id = t.assignee_id
                  AND d.revoked_at IS NULL
                  AND d.starts_on <= $3::date
                  AND (d.ends_on IS NULL OR d.ends_on >= $3::date)
             )
        )
      LIMIT 1`,
    [access.id, actor.id, onDate],
  );
  return r.rows.length > 0;
}


/* ── one report's decision, for the panel on it ────────────────────────────── */

export interface DecidableTask {
  taskId: string;
  step: number;
  totalSteps: number;
  rungName: string | null;
  requireReceiptViewAck: boolean;
  route: InboxRoute;
  coveringFor: string | null;
  /** STORED receipts on the report right now — what the acknowledgement is about,
   *  and what `decide` records as `receipts_present_at_decision`. */
  receiptCount: number;
}

/**
 * Everything the decision panel needs, or null when this person has no decision
 * to make on this report.
 *
 * Deliberately built on `resolveDecidableTask` rather than its own query: the
 * panel must appear exactly when the mutation will succeed, and the only way to
 * guarantee that is for both to ask the same function.
 */
export async function decidableTaskForReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
  ctx: DecisionContext = {},
): Promise<DecidableTask | null> {
  const taskId = await resolveDecidableTask(tx, reportId, actorId, ctx);
  if (!taskId) return null;
  const r = await tx.query(
    `SELECT t.step, t.assignee_id, t.claim_role, q.total_steps, q.policy_snapshot,
            COALESCE(asg.display_name, asg.email) AS assignee_name
       FROM approval_task    t
       JOIN approval_request q   ON q.id = t.request_id
       LEFT JOIN app_user    asg ON asg.id = t.assignee_id
      WHERE t.id = $1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const step = snapshotStep(row.policy_snapshot, row.step as number);
  const route = routeOf(row, actorId);
  return {
    taskId,
    step: row.step as number,
    totalSteps: row.total_steps as number,
    rungName: step?.policyName ?? null,
    requireReceiptViewAck: step?.requireReceiptViewAck ?? false,
    route,
    coveringFor: route === 'DELEGATED' ? ((row.assignee_name as string | null) ?? null) : null,
    receiptCount: await countStoredReceipts(tx, reportId),
  };
}

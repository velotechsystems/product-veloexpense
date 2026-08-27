/**
 * VX2-1 — approvals service: the ladder's CRUD, planning a report's approval,
 * and reading a run back.
 *
 * Follows the lib/expenses + lib/policy pattern: pure functions over a tenant
 * `QueryRunner`, called inside a `withOrg` / `withCurrentOrg` transaction with
 * `app.current_org` already set. Nothing here filters on organization_id — RLS
 * does that — except on INSERT, where the column has to be written and comes
 * from the session variable so it cannot disagree with the policy about to check
 * it.
 *
 * NOT HERE, on purpose. There is no `openRequest` and no `decide`: opening runs
 * and moving them is VX2-3's engine, and it lands only after VX2-6's audit log
 * exists so that every transition is written to the trail from the engine's first
 * commit. Resolving a rung's approvers to actual people is VX2-2 (see
 * lib/approvals/routing.ts). Delegation CRUD is VX2-5. This ticket is the schema,
 * the ladder, and the reads the three of them need.
 */
import type { QueryRunner } from '@/lib/db/client';
import { toBigInt } from '@/lib/money';
import {
  ApprovalConfigError,
  DEFAULT_LADDER,
  assertPolicyInput,
  planApproval,
  type ApprovalPolicyPatch,
  type ApprovalPolicyRow,
  type NewApprovalPolicy,
  type NewApprover,
  type RequestStatus,
  type StepPlan,
  type TaskResolution,
  type TaskStatus,
} from '@/lib/approvals/tiers';

export * from '@/lib/approvals/tiers';

/**
 * organization_id on INSERT comes from the session variable, never from an
 * argument — the same expression the RLS policy will evaluate, so the two can
 * never disagree. Copied from lib/expenses/lifecycle.ts.
 */
const ORG = "current_setting('app.current_org', true)::uuid";

/**
 * One round trip for the whole ladder. The approvers come back as an ordered
 * JSON array per rung rather than as a second query plus a stitch in TypeScript —
 * RLS applies inside the lateral exactly as it does outside, so the isolation
 * guarantee is unchanged.
 */
const LADDER_QUERY = `
  SELECT p.id, p.name, p.sequence, p.threshold_minor, p.require_receipt_view_ack,
         p.enabled, p.created_at, p.updated_at,
         COALESCE(a.approvers, '[]'::json) AS approvers
    FROM approval_policy p
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'id',                  ap.id,
               'policy_id',           ap.policy_id,
               'position',            ap.position,
               'approver_kind',       ap.approver_kind,
               'manager_level',       ap.manager_level,
               'approver_role',       ap.approver_role,
               'approver_user_id',    ap.approver_user_id,
               'external_email',      ap.external_email,
               'display_name',        ap.display_name,
               'approver_user_email', u.email,
               'approver_user_name',  u.display_name
             ) ORDER BY ap.position) AS approvers
        FROM approval_policy_approver ap
        LEFT JOIN app_user u ON u.id = ap.approver_user_id
       WHERE ap.policy_id = p.id
    ) a ON true`;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/* ── ladder CRUD ───────────────────────────────────────────────────────────── */

/** The whole ladder, in rung order. Disabled rungs included — an admin editing
 *  the ladder has to be able to see the rung they switched off. */
export async function listPolicies(tx: QueryRunner): Promise<ApprovalPolicyRow[]> {
  const r = await tx.query(`${LADDER_QUERY} ORDER BY p.sequence`);
  return r.rows as ApprovalPolicyRow[];
}

export async function getPolicy(
  tx: QueryRunner,
  policyId: string,
): Promise<ApprovalPolicyRow | null> {
  const r = await tx.query(`${LADDER_QUERY} WHERE p.id = $1`, [policyId]);
  return (r.rows[0] as ApprovalPolicyRow) ?? null;
}

/**
 * A named approver must resolve inside the tenant. RLS already makes a user in
 * another org invisible, so a plain SELECT is the whole check — it returns no row
 * and we reject. Same shape as assertManagerInOrg in lib/employees/service.
 */
async function assertApproverInOrg(tx: QueryRunner, userId: string) {
  const r = await tx.query('SELECT id FROM app_user WHERE id = $1 AND deleted_at IS NULL', [
    userId,
  ]);
  if (r.rows.length === 0) {
    throw new ApprovalConfigError(
      'that approver is not an active employee in this organization',
      'INVALID_APPROVER',
    );
  }
}

async function insertApprovers(tx: QueryRunner, policyId: string, approvers: NewApprover[]) {
  for (const a of approvers) {
    if (a.approverUserId) await assertApproverInOrg(tx, a.approverUserId);
    await tx.query(
      `INSERT INTO approval_policy_approver
         (organization_id, policy_id, position, approver_kind, manager_level,
          approver_role, approver_user_id, external_email, display_name)
       VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        policyId,
        a.position,
        a.approverKind,
        a.managerLevel ?? null,
        a.approverRole ?? null,
        a.approverUserId ?? null,
        a.externalEmail?.trim() ?? null,
        a.displayName?.trim() ?? null,
      ],
    );
  }
}

export async function createPolicy(
  tx: QueryRunner,
  input: NewApprovalPolicy,
): Promise<ApprovalPolicyRow> {
  assertPolicyInput(input);
  let policyId: string;
  try {
    const r = await tx.query(
      `INSERT INTO approval_policy
         (organization_id, name, sequence, threshold_minor, require_receipt_view_ack, enabled)
       VALUES (${ORG}, $1, $2, $3, $4, $5)
       RETURNING id`,
      [
        input.name.trim(),
        input.sequence,
        (input.thresholdMinor === undefined ? 0n : toBigInt(input.thresholdMinor)).toString(),
        input.requireReceiptViewAck ?? true,
        input.enabled ?? true,
      ],
    );
    policyId = r.rows[0].id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApprovalConfigError(
        `rung ${input.sequence} already exists — pick another position in the ladder`,
        'SEQUENCE_TAKEN',
      );
    }
    throw err;
  }
  await insertApprovers(tx, policyId, input.approvers);
  return (await getPolicy(tx, policyId))!;
}

/**
 * Patch-with-nulls on the rung's own fields, not COALESCE: an absent key leaves
 * the column alone, an explicit null clears it. Under COALESCE, clearing a field
 * from a form is impossible (VX1-6's lesson, applied to updateReport and
 * updateEmployee).
 *
 * `approvers` is the exception and is REPLACED WHOLESALE when present. Patching
 * an ordered list element-by-element is ambiguous — is a missing position a
 * deletion or an omission? — and an approval ladder is exactly the wrong place to
 * guess. Absent key = approvers untouched; present = this is now the complete,
 * ordered set.
 */
export async function updatePolicy(
  tx: QueryRunner,
  policyId: string,
  patch: ApprovalPolicyPatch,
): Promise<ApprovalPolicyRow> {
  const current = await getPolicy(tx, policyId);
  if (!current) throw new ApprovalConfigError('approval rung not found', 'NOT_FOUND');

  const merged: NewApprovalPolicy = {
    name: patch.name !== undefined ? patch.name : current.name,
    sequence: patch.sequence !== undefined ? patch.sequence : current.sequence,
    thresholdMinor:
      patch.thresholdMinor !== undefined ? patch.thresholdMinor : current.threshold_minor,
    requireReceiptViewAck:
      patch.requireReceiptViewAck !== undefined
        ? patch.requireReceiptViewAck
        : current.require_receipt_view_ack,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    // Validate against what the rung will ACTUALLY have afterwards, so a patch
    // that only changes the name is not rejected for the existing approvers, and
    // a patch that empties the approvers IS.
    approvers:
      patch.approvers !== undefined
        ? patch.approvers
        : current.approvers.map((a) => ({
            position: a.position,
            approverKind: a.approver_kind,
            managerLevel: a.manager_level,
            approverRole: a.approver_role,
            approverUserId: a.approver_user_id,
            externalEmail: a.external_email,
            displayName: a.display_name,
          })),
  };
  assertPolicyInput(merged);

  try {
    await tx.query(
      `UPDATE approval_policy
          SET name = $2,
              sequence = $3,
              threshold_minor = $4,
              require_receipt_view_ack = $5,
              enabled = $6,
              updated_at = now()
        WHERE id = $1`,
      [
        policyId,
        merged.name.trim(),
        merged.sequence,
        toBigInt(merged.thresholdMinor ?? 0).toString(),
        merged.requireReceiptViewAck ?? true,
        merged.enabled ?? true,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApprovalConfigError(
        `rung ${merged.sequence} already exists — pick another position in the ladder`,
        'SEQUENCE_TAKEN',
      );
    }
    throw err;
  }

  if (patch.approvers !== undefined) {
    await tx.query('DELETE FROM approval_policy_approver WHERE policy_id = $1', [policyId]);
    await insertApprovers(tx, policyId, patch.approvers);
  }
  return (await getPolicy(tx, policyId))!;
}

export async function deletePolicy(tx: QueryRunner, policyId: string): Promise<void> {
  // approval_policy_approver cascades; a run's policy_snapshot is unaffected,
  // which is the point of snapshotting it.
  const r = await tx.query('DELETE FROM approval_policy WHERE id = $1', [policyId]);
  if (r.rowCount === 0) throw new ApprovalConfigError('approval rung not found', 'NOT_FOUND');
}

/**
 * Restore the starter ladder, skipping any rung position already taken. Returns
 * how many were inserted so the caller can say "added 2" rather than guessing.
 *
 * Idempotent by `sequence`, matching ensureDefaultPolicies in lib/policy: this is
 * a "give me a sensible starting point" button, not a reset — it must never
 * overwrite a ladder somebody has tuned.
 */
export async function ensureDefaultLadder(tx: QueryRunner): Promise<number> {
  const existing = await tx.query('SELECT sequence FROM approval_policy');
  const taken = new Set<number>(existing.rows.map((row) => Number(row.sequence)));
  let added = 0;
  for (const rung of DEFAULT_LADDER) {
    if (taken.has(rung.sequence)) continue;
    await createPolicy(tx, rung);
    added += 1;
  }
  return added;
}

/* ── planning ──────────────────────────────────────────────────────────────── */

export interface ApprovalPlan {
  reportId: string;
  submitterId: string;
  totalMinor: string;
  currencyCode: string;
  plan: StepPlan[];
  /** True when no rung applied and IMPLICIT_STEP was used. */
  implicit: boolean;
}

/**
 * What ladder does THIS report have to climb? Reads the rungs and the report's
 * total inside the caller's transaction, so a rung an admin added seconds ago
 * applies — the same reasoning that makes VX1-8's submit gate re-run the policy
 * engine rather than trust stored findings.
 *
 * Planning is separate from opening a run (VX2-3) so the workbench can show an
 * employee who will have to approve their report before they submit it.
 */
export async function planApprovalForReport(
  tx: QueryRunner,
  reportId: string,
): Promise<ApprovalPlan> {
  const r = await tx.query(
    'SELECT id, submitter_id, total_minor, currency_code FROM expense_report WHERE id = $1',
    [reportId],
  );
  if (r.rows.length === 0) throw new ApprovalConfigError('report not found', 'NOT_FOUND');
  const report = r.rows[0];

  const rungs = await listPolicies(tx);
  const plan = planApproval(rungs, String(report.total_minor));

  return {
    reportId: report.id,
    submitterId: report.submitter_id,
    totalMinor: String(report.total_minor),
    currencyCode: report.currency_code,
    plan,
    implicit: plan.length === 1 && plan[0].policyId === null,
  };
}

/* ── reading a run ─────────────────────────────────────────────────────────── */

export interface ApprovalRequestRow {
  id: string;
  report_id: string;
  policy_snapshot: StepPlan[];
  status: RequestStatus;
  current_step: number;
  total_steps: number;
  subject_total_minor: string;
  subject_currency_code: string;
  opened_by_id: string;
  opened_by_name: string | null;
  opened_by_email: string;
  opened_at: Date;
  closed_at: Date | null;
}

export interface ApprovalTaskRow {
  id: string;
  request_id: string;
  step: number;
  /** Null for an external approver, who has no app_user row. */
  assignee_id: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  resolved_via: TaskResolution;
  delegated_from_id: string | null;
  escalation_level: number;
  status: TaskStatus;
  decided_by_id: string | null;
  decided_by_email: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  note: string | null;
  receipt_view_acknowledged_at: Date | null;
  receipts_present_at_decision: number | null;
  created_at: Date;
}

export interface ReportApproval {
  request: ApprovalRequestRow;
  tasks: ApprovalTaskRow[];
}

/**
 * The report's CURRENT run, plus its steps. `opened_at DESC` picks the newest
 * because a RETURN and resubmit opens a fresh run and the old ones stay as
 * history; `opened_at` is clock_timestamp() (0007's lesson) so the ordering is
 * real even for runs opened in one transaction, and `id` breaks any tie.
 */
export async function getReportApproval(
  tx: QueryRunner,
  reportId: string,
): Promise<ReportApproval | null> {
  const r = await tx.query(
    `SELECT q.id, q.report_id, q.policy_snapshot, q.status, q.current_step, q.total_steps,
            q.subject_total_minor, q.subject_currency_code, q.opened_by_id,
            o.display_name AS opened_by_name, o.email AS opened_by_email,
            q.opened_at, q.closed_at
       FROM approval_request q
       JOIN app_user o ON o.id = q.opened_by_id
      WHERE q.report_id = $1
      ORDER BY q.opened_at DESC, q.id DESC
      LIMIT 1`,
    [reportId],
  );
  const request = r.rows[0] as ApprovalRequestRow | undefined;
  if (!request) return null;
  return { request, tasks: await listTasks(tx, request.id) };
}

/**
 * A run's steps in ladder order. `step` is unique per run, so this is a total
 * order and needs no timestamp tie-break.
 *
 * LEFT JOIN on the assignee, not JOIN: an external email approver has no
 * app_user row, and an inner join would silently drop their task from the
 * timeline — the worst possible failure for an approval nobody can see.
 */
export async function listTasks(tx: QueryRunner, requestId: string): Promise<ApprovalTaskRow[]> {
  const r = await tx.query(
    `SELECT t.id, t.request_id, t.step, t.assignee_id,
            COALESCE(a.email, t.assignee_email) AS assignee_email,
            COALESCE(a.display_name, t.assignee_email) AS assignee_name,
            t.resolved_via, t.delegated_from_id, t.escalation_level, t.status,
            t.decided_by_id, t.decided_by_email,
            COALESCE(d.display_name, t.decided_by_email) AS decided_by_name,
            t.decided_at, t.note,
            t.receipt_view_acknowledged_at, t.receipts_present_at_decision, t.created_at
       FROM approval_task t
       LEFT JOIN app_user a ON a.id = t.assignee_id
       LEFT JOIN app_user d ON d.id = t.decided_by_id
      WHERE t.request_id = $1
      ORDER BY t.step`,
    [requestId],
  );
  return r.rows as ApprovalTaskRow[];
}

/**
 * How many STORED receipts hang off a report right now. Fills
 * approval_task.receipts_present_at_decision when VX2-3/VX2-4 record a decision:
 * that column is what lets Module 12's control ask the honest question
 * ("approved without the approver looking at a receipt") instead of the
 * approximation ExpenseOS was stuck with ("approved with no receipt on file").
 *
 * PENDING receipts do not count — an upload intent whose bytes never arrived is
 * not evidence of anything (VX1-5's two-phase upload).
 */
export async function countStoredReceipts(tx: QueryRunner, reportId: string): Promise<number> {
  const r = await tx.query(
    `SELECT COUNT(*)::int AS count
       FROM receipt rc
       JOIN expense e ON e.id = rc.expense_id
      WHERE e.report_id = $1 AND rc.status = 'STORED'`,
    [reportId],
  );
  return r.rows[0].count;
}

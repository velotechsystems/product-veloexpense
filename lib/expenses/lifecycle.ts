/**
 * VX1-8 — report lifecycle: the DRAFT→SUBMITTED gate, recall, and the audit
 * trail (ExpenseOS Module 4's submit path + Module 9's block semantics).
 *
 * WHY THIS IS ITS OWN MODULE. `lib/policy/service.ts` imports
 * `lib/expenses/service.ts` for the report snapshot it validates. Submitting
 * needs both — it re-runs the policy engine and then writes the report — so
 * putting it in either one would make the two import each other. This module
 * sits above both and imports down.
 *
 * The gate, in order:
 *   1. the report must be in DRAFT (the same rule `assertDraft` enforces on
 *      every edit — a report cannot be submitted twice)
 *   2. it must actually contain something to reimburse
 *   3. the policy engine re-runs RIGHT HERE, in this transaction, rather than
 *      trusting whatever the last save stored. Otherwise a rule an admin added
 *      thirty seconds ago would not apply, which is exactly the hole an
 *      employee would learn to exploit.
 *   4. any unresolved BLOCK finding refuses the submit. WARNING findings do
 *      not: Module 9 is explicit that warnings propagate to the approver, and
 *      the employee may acknowledge them with a justification instead.
 */
import type { QueryRunner } from '@/lib/db/client';
import * as policy from '@/lib/policy/service';
import type { ReportStatus } from '@/lib/expenses/service';

const ORG = "current_setting('app.current_org', true)::uuid";

export type TransitionAction = 'SUBMIT' | 'RECALL' | 'APPROVE' | 'REJECT' | 'RETURN' | 'REIMBURSE';

export type LifecycleErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'EMPTY_REPORT'
  | 'BLOCKED_BY_POLICY'
  | 'FORBIDDEN';

export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly code: LifecycleErrorCode,
    /** The findings that refused a submit, so the UI can list them. */
    readonly violations: policy.ViolationRow[] = [],
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export interface ReportEvent {
  id: string;
  report_id: string;
  action: TransitionAction;
  from_status: ReportStatus;
  to_status: ReportStatus;
  actor_id: string;
  actor_name: string | null;
  actor_email: string;
  note: string | null;
  context: Record<string, unknown>;
  created_at: Date;
}

/** Which statuses a recall may return to DRAFT from. */
const RECALLABLE: ReportStatus[] = ['SUBMITTED', 'RETURNED'];

async function requireReport(tx: QueryRunner, reportId: string) {
  const r = await tx.query(
    'SELECT id, number, status, total_minor, currency_code FROM expense_report WHERE id = $1',
    [reportId],
  );
  if (r.rows.length === 0) throw new LifecycleError('report not found', 'NOT_FOUND');
  return r.rows[0];
}

async function recordEvent(
  tx: QueryRunner,
  input: {
    reportId: string;
    action: TransitionAction;
    fromStatus: ReportStatus;
    toStatus: ReportStatus;
    actorId: string;
    note?: string | null;
    context?: Record<string, unknown>;
  },
) {
  await tx.query(
    `INSERT INTO expense_report_event
       (organization_id, report_id, action, from_status, to_status, actor_id, note, context)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.reportId,
      input.action,
      input.fromStatus,
      input.toStatus,
      input.actorId,
      input.note ?? null,
      JSON.stringify(input.context ?? {}),
    ],
  );
}

export interface SubmitResult {
  report: { id: string; number: string | null; status: ReportStatus; submitted_at: Date };
  validation: policy.ValidationSummary;
}

/** DRAFT → SUBMITTED. Throws LifecycleError with the blocking findings attached. */
export async function submitReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
): Promise<SubmitResult> {
  const report = await requireReport(tx, reportId);
  if (report.status !== 'DRAFT') {
    throw new LifecycleError(
      `report ${report.number ?? reportId} is ${report.status}; only a DRAFT can be submitted`,
      'WRONG_STATUS',
    );
  }

  const lines = await tx.query(
    `SELECT COUNT(*)::int AS count
       FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1`,
    [reportId],
  );
  if (lines.rows[0].count === 0) {
    throw new LifecycleError(
      'this report has no line items — code at least one expense before submitting',
      'EMPTY_REPORT',
    );
  }

  // Re-run rather than read: the stored findings could predate a rule change.
  const validation = await policy.validateReport(tx, reportId);
  if (validation.blocking) {
    const blocking = validation.violations.filter(
      (v) => v.severity === 'BLOCK' && v.resolved_at === null,
    );
    throw new LifecycleError(
      blocking.length === 1
        ? 'One blocking policy violation has to be fixed before this report can be submitted.'
        : `${blocking.length} blocking policy violations have to be fixed before this report can be submitted.`,
      'BLOCKED_BY_POLICY',
      blocking,
    );
  }

  const updated = await tx.query(
    `UPDATE expense_report
        SET status = 'SUBMITTED', submitted_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING id, number, status, submitted_at`,
    [reportId],
  );

  await recordEvent(tx, {
    reportId,
    action: 'SUBMIT',
    fromStatus: 'DRAFT',
    toStatus: 'SUBMITTED',
    actorId,
    context: {
      totalMinor: String(report.total_minor),
      currencyCode: report.currency_code,
      // What the gate saw. A later rule edit cannot rewrite this.
      violationCounts: validation.counts,
      acknowledgedCount: validation.violations.filter((v) => v.resolved_at !== null).length,
    },
  });

  return { report: updated.rows[0], validation };
}

/**
 * SUBMITTED | RETURNED → DRAFT. `submitted_at` is cleared because it means
 * "currently submitted at"; the audit trail is what remembers that it once was.
 */
export async function recallReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
  note?: string | null,
) {
  const report = await requireReport(tx, reportId);
  if (!RECALLABLE.includes(report.status)) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} is ${report.status}; only a submitted or returned report can be recalled`,
      'WRONG_STATUS',
    );
  }

  const updated = await tx.query(
    `UPDATE expense_report
        SET status = 'DRAFT', submitted_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, number, status`,
    [reportId],
  );

  await recordEvent(tx, {
    reportId,
    action: 'RECALL',
    fromStatus: report.status,
    toStatus: 'DRAFT',
    actorId,
    note: note ?? null,
  });

  return updated.rows[0];
}

export async function listEvents(tx: QueryRunner, reportId: string): Promise<ReportEvent[]> {
  const r = await tx.query(
    `SELECT e.id, e.report_id, e.action, e.from_status, e.to_status, e.actor_id,
            u.display_name AS actor_name, u.email AS actor_email,
            e.note, e.context, e.created_at
       FROM expense_report_event e
       JOIN app_user u ON u.id = e.actor_id
      WHERE e.report_id = $1
      ORDER BY e.created_at DESC, e.id DESC`,
    [reportId],
  );
  return r.rows as ReportEvent[];
}

/**
 * Can this report be submitted right now? Used to render the button's state
 * without throwing. Reads the STORED findings — the authoritative re-run
 * happens inside submitReport, so a stale "looks fine" can never let a
 * blocked report through, it just shows an enabled button that then explains
 * itself.
 */
export async function getSubmitReadiness(tx: QueryRunner, reportId: string) {
  const report = await requireReport(tx, reportId);
  const lines = await tx.query(
    `SELECT COUNT(*)::int AS count
       FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1`,
    [reportId],
  );
  const validation = await policy.getValidation(tx, reportId);
  const reasons: string[] = [];
  if (report.status !== 'DRAFT') reasons.push(`the report is ${report.status}`);
  if (lines.rows[0].count === 0) reasons.push('it has no line items');
  if (validation.blocking) reasons.push('it has blocking policy violations');
  return {
    canSubmit: reasons.length === 0,
    canRecall: RECALLABLE.includes(report.status),
    reasons,
  };
}

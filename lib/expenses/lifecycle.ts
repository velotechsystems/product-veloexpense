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
import { DomainError, type UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import * as policy from '@/lib/policy/service';
import * as engine from '@/lib/approvals/engine';
import { recomputeForReport } from '@/lib/budgets/service';
import type { ReportStatus } from '@/lib/expenses/service';
import { append as auditAppend } from '@/lib/audit/service';
import { notify, reportPayload } from '@/lib/notifications/service';
import { capabilityAvailability } from '@/lib/integrations/service';
import { uncodedCategories, uncodedDiagnostic } from '@/lib/integrations/coding';

const ORG = "current_setting('app.current_org', true)::uuid";

export type TransitionAction = 'SUBMIT' | 'RECALL' | 'APPROVE' | 'REJECT' | 'RETURN' | 'REIMBURSE';

export type LifecycleErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'EMPTY_REPORT'
  | 'UNCODED'
  | 'BLOCKED_BY_POLICY'
  | 'FORBIDDEN';

export class LifecycleError extends DomainError {
  constructor(
    message: string,
    readonly code: LifecycleErrorCode,
    /** The findings that refused a submit, so the UI can list them. */
    readonly violations: policy.ViolationRow[] = [],
    /**
     * A bare code, or a code WITH parameters. `DomainError` has accepted both
     * since VX4-7 part 2c; this class narrowed it to a bare code, which UD-2's
     * refusal is the first one here to need — it names the categories that have
     * no GL account, and a refusal that does not name them is one an employee can
     * only escalate by guessing.
     */
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
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
  /**
   * The approval run opened for this submission (VX2-3). Always present: a
   * SUBMITTED report with no run is the fail-open state — it looks pending
   * forever and is indistinguishable, from the outside, from one waiting on a
   * busy manager.
   */
  approval: { requestId: string; totalSteps: number; taskId: string };
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
      [],
      'REPORT_NOT_SUBMITTABLE',
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
      [],
      'REPORT_EMPTY',
    );
  }

  // ── UD-2: is this coded well enough to post? ─────────────────────────────
  //
  // BEFORE the policy pass, deliberately. This is a fact about the report, not a
  // judgement about it, and somebody fixing coding should not have to read past a
  // policy warning to learn the report cannot post at all.
  //
  // ONLY WHEN A LEDGER IS CONNECTED. The requirement comes from the integration;
  // a tenant with none has nothing to be coded FOR, and refusing a submission
  // there would conjure a rule out of an absent integration.
  // `capabilityAvailability` rather than `requireCapability` because this must not
  // throw for the two awkward cases: the accounting module being off answers
  // `connected: false` (no gate), and two connected ledgers answers
  // `connected: true` (AC-22 — something is connected, too much of it, and the
  // coding is required whichever one wins).
  const ledger = await capabilityAvailability(tx, 'POST_EXPENSE_REPORT');
  if (ledger.connected) {
    const uncoded = await uncodedCategories(tx, reportId);
    if (uncoded.length > 0) {
      throw new LifecycleError(
        `report ${report.number ?? reportId} cannot post: ${uncodedDiagnostic(uncoded)}`,
        'UNCODED',
        [],
        {
          // One code per branch, as with BLOCKED_BY_POLICY below. The labels are
          // the parameter because the category is what somebody fixes — and they
          // are labels, not ids, so `assertRenderableParams` accepts them.
          code: uncoded.length === 1 ? 'SUBMIT_UNCODED_ONE' : 'SUBMIT_UNCODED_MANY',
          params: { categories: uncoded.map((u) => u.label).join(', ') },
        },
      );
    }
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
      // One code per BRANCH, which is how the plural survives a catalogue that
      // takes no parameters. `POLICY_MESSAGE_CODES` does the same thing for the
      // converted/unconverted split, and for the same reason: the code that
      // KNOWS which sentence applies should record it, not leave a renderer to
      // re-derive it from a count it would have to be handed anyway.
      blocking.length === 1 ? 'BLOCKED_BY_POLICY_ONE' : 'BLOCKED_BY_POLICY_MANY',
    );
  }

  // VX4-5: STAMP the submitter's department onto the report, in the same statement
  // that submits it. `department_id` lives on `app_user`, so a budget rollup could
  // join through the submitter instead — and then a transfer would rewrite a closed
  // period's totals after the fact, with nothing recording why, and recomputing the
  // same period twice could give two answers. This is AC-10's stamp-on-write for
  // the same reason VX3-1 stamps the GL account.
  //
  // FROM THE SUBMITTER, NOT THE ACTOR, and the difference is a real case rather
  // than pedantry: this function performs NO ownership check — the action layer does
  // it, and it permits `submitter_id === actor.id || role === 'ADMIN'`. So an admin
  // submitting somebody else's report is a supported path, and keying this on
  // `actorId` would stamp the ADMIN's department onto an employee's spend. The first
  // draft did exactly that, with a comment claiming an `assertOwner` that does not
  // exist in this function.
  //
  // A scalar sub-select on the target row, so the statement always assigns: NULL is
  // a real answer (somebody with no department) and is stored as such. A
  // `FROM app_user` join would instead update NOTHING if the join missed, turning a
  // data oddity into a silent no-submit.
  const updated = await tx.query(
    `UPDATE expense_report
        SET status = 'SUBMITTED',
            submitted_at = now(),
            department_id =
              (SELECT department_id FROM app_user WHERE id = expense_report.submitter_id),
            updated_at = now()
      WHERE id = $1
      RETURNING id, number, status, submitted_at, department_id`,
    [reportId],
  );

  // VX4-5 part 2 — the budget rollup, ON THE TRANSITION and AFTER the status
  // write, so this report is counted as pending by the recompute it triggers.
  // Same placement rule as VX3-4's ledger hand-off (AC-6): a hook on the
  // transition cannot be forgotten by a new caller, and it commits with the
  // submission or not at all.
  //
  // Note the ordering against `validateReport` above, which is deliberate: the
  // rule warns using the baseline WITHOUT this report plus this report's own
  // contribution, then the report becomes part of the baseline. Recomputing
  // first would double-count it.
  await recomputeForReport(tx, reportId, actorId);

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

  /**
   * Open the approval run in THIS transaction.
   *
   * Coupled rather than left to the caller on purpose. `openRun` routes every
   * step all-or-nothing, so an unroutable ladder refuses the submit HERE, while
   * the employee is at their screen and can be told — instead of days later when
   * an approver clicks and the report has nowhere to go. The cost is that a
   * tenant with no manager chain AND no active administrator cannot submit at
   * all; that is the correct direction to fail, and it is why every tenant is
   * seeded with an admin.
   */
  const approval = await engine.openRun(tx, reportId, actorId);

  return { report: updated.rows[0], validation, approval };
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
      [],
      'REPORT_NOT_RECALLABLE',
    );
  }

  const updated = await tx.query(
    `UPDATE expense_report
        SET status = 'DRAFT', submitted_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING id, number, status`,
    [reportId],
  );

  // Cancel the approval run, or the next submit cannot open one —
  // approval_request_one_running_idx allows exactly one RUNNING request per
  // report. Recalling and resubmitting deliberately opens a NEW run rather than
  // resuming the old one: 0008's reasoning is that a report's total can move
  // while it is back in DRAFT, so re-banding an existing run would let an
  // employee returned at three sign-offs trim a line and resubmit into one.
  const cancelled = await engine.cancelRunForReport(tx, reportId, actorId);

  // Back to DRAFT is spend LEAVING the pending total. Without this a recalled
  // report keeps consuming its budget forever, and the only thing on screen would
  // be a number that is too big for no visible reason.
  await recomputeForReport(tx, reportId, actorId);

  await recordEvent(tx, {
    reportId,
    action: 'RECALL',
    fromStatus: report.status,
    toStatus: 'DRAFT',
    actorId,
    note: note ?? null,
    context: cancelled
      ? { cancelledRequestId: cancelled.requestId, cancelledTasks: cancelled.cancelledTasks }
      : {},
  });

  return updated.rows[0];
}

/* ── reimbursement ─────────────────────────────────────────────────────────── */

export interface ReimburseInput {
  /** The AP run, cheque number or EFT batch. Optional — see `0013`. */
  reference?: string | null;
  note?: string | null;
}

export interface ReimburseResult {
  id: string;
  number: string | null;
  status: ReportStatus;
  reimbursed_at: Date;
}

/**
 * VX2-9 — APPROVED → REIMBURSED. The last transition a report has.
 *
 * Ported from ExpenseOS `markReimbursed` (GAP-AUDIT RB-1..RB-8) with three
 * deliberate changes, each of which closes something their version leaves open.
 *
 * ── 1. THE CLAIM IS ATOMIC, because theirs is not (RB-2) ────────────────────
 *
 * ExpenseOS reads the status in one query and then writes with `where: { id }` —
 * the update does not re-assert what the read checked. So two concurrent calls
 * (a double-click, or two clerks working the same list) both pass the guard and
 * both write, producing two audit rows and two notifications for ONE payment, on
 * the single transition in this product that means money left the building.
 *
 * The read below exists only to produce a good error message. The UPDATE's
 * `AND status = 'APPROVED'` is the guard, and `rowCount !== 1` is how we know.
 * That is the same idiom as VX2-3's decision claim, VX2-8's `consumeActionToken`
 * and VX2-8's `claimDelivery` — the fourth appearance of this shape in the port,
 * and the fourth time the answer is a conditional write rather than a lock.
 *
 * Note what falls out of it for free: because APPROVED is the only permitted
 * source status, "you cannot pay it twice" and "you cannot pay an unapproved
 * report" are ONE guard.
 *
 * ── 2. YOU MAY NOT PAY YOURSELF (RB-3) ─────────────────────────────────────
 *
 * ExpenseOS has no self-payment check at all: `markReimbursed` is gated on a
 * static permission and nothing else. That is hard to defend in a codebase whose
 * `canDecide` ordering exists because self-APPROVAL is a SOX-grade control
 * (AP-13) — approval is an opinion that money should move, payment asserts that
 * it did.
 *
 * The exception is AP-14's existing break-glass, reused rather than duplicated,
 * because the forcing case is identical: a tenant where the admin who submits is
 * the only person who can act. `0013` widens that column's COMMENT to say so.
 *
 * ── 3. THE NOTIFICATION IS IN THIS TRANSACTION (RB-7) ──────────────────────
 *
 * Theirs fires after the commit, un-awaited, with no catch — so a failed
 * notification is lost silently. VX2-7 chose the opposite and the reasoning is in
 * `notifyTaskOwner`: NT-11 is a record of what silent non-delivery costs.
 *
 * ── What this deliberately does NOT check ──────────────────────────────────
 *
 * Whether receipts exist, whether policy violations were resolved, whether the
 * total is non-zero. All three were questions for the submit gate and the
 * approval gate; asking them again at payment time would refuse a report somebody
 * has already approved, which is the wrong place to relitigate it. Ported as-is,
 * and RB-8 records that their version makes the same choice.
 */
export async function reimburseReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
  input: ReimburseInput = {},
): Promise<ReimburseResult> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.title, rep.status, rep.submitter_id,
            rep.total_minor, rep.currency_code,
            org.allow_sole_approver_self_approval AS break_glass
       FROM expense_report rep
       JOIN organization org ON org.id = rep.organization_id
      WHERE rep.id = $1`,
    [reportId],
  );
  if (r.rows.length === 0) throw new LifecycleError('report not found', 'NOT_FOUND');
  const report = r.rows[0];

  if (report.status !== 'APPROVED') {
    throw new LifecycleError(
      // Their sentence, near enough verbatim, plus the current status — which
      // theirs omits and which is the first thing anybody asks.
      `report ${report.number ?? reportId} is ${report.status}; only an approved report can be marked reimbursed`,
      'WRONG_STATUS',
      [],
      'REPORT_NOT_REIMBURSABLE',
    );
  }

  // The self-payment refusal, before anything is written.
  if (report.submitter_id === actorId && report.break_glass !== true) {
    throw new LifecycleError(
      `you cannot mark your own report reimbursed — ask somebody else in finance to release the payment`,
      'FORBIDDEN',
      [],
      'REIMBURSE_OWN_REPORT',
    );
  }

  const reference = input.reference?.trim() || null;

  // THE guard. See note 1 above.
  const claimed = await tx.query(
    `UPDATE expense_report
        SET status = 'REIMBURSED',
            reimbursed_at = clock_timestamp(),
            reimbursed_by_id = $2,
            reimbursement_reference = $3,
            updated_at = now()
      WHERE id = $1 AND status = 'APPROVED'
      RETURNING id, number, status, reimbursed_at`,
    [reportId, actorId, reference],
  );
  if (claimed.rowCount !== 1) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} was reimbursed by somebody else a moment ago`,
      'WRONG_STATUS',
      [],
      'REIMBURSE_RACE',
    );
  }

  await recordEvent(tx, {
    reportId,
    action: 'REIMBURSE',
    fromStatus: 'APPROVED',
    toStatus: 'REIMBURSED',
    actorId,
    note: input.note ?? null,
    context: {
      reference,
      // Strings, not BigInt — the canonicalizer throws on BigInt (AU-5), and
      // this context is JSON.stringify'd on the way in.
      totalMinor: String(report.total_minor),
      currencyCode: report.currency_code,
      selfReimbursedUnderBreakGlass: report.submitter_id === actorId,
    },
  });

  // The hash chain as well as the timeline. This is the only transition in the
  // product that asserts money moved, so it belongs in the tamper-evident record
  // and not only in the report's own history — and `details` carries the
  // reference, which is the thing an auditor reconciles against. ExpenseOS passes
  // `details: {}` here (RB-1) while passing real details from its neighbouring
  // mutations, which is what made the emptiness worth diverging from.
  const actor = await tx.query(
    `SELECT COALESCE(display_name, email) AS name, email, role FROM app_user WHERE id = $1`,
    [actorId],
  );
  if (actor.rows.length === 0) {
    throw new LifecycleError('the acting user is not in this organization', 'FORBIDDEN');
  }
  await auditAppend(
    tx,
    { id: actorId, name: actor.rows[0].name as string, role: actor.rows[0].role as string },
    {
      action: 'REPORT_REIMBURSED',
      entityType: 'expense_report',
      entityId: reportId,
      details: {
        reportNumber: report.number ?? null,
        reference,
        totalMinor: String(report.total_minor),
        currencyCode: report.currency_code,
        selfReimbursedUnderBreakGlass: report.submitter_id === actorId,
      },
    },
  );

  // The submitter is told. `notifyRecipients` drops the actor, so an admin who
  // paid their own report under the break-glass gets no bell about it.
  await notify(
    tx,
    {
      subjectType: 'EXPENSE_REPORT',
      subjectId: reportId,
      eventType: 'REIMBURSED',
      actorId,
      payload: {
        ...reportPayload({
          title: report.title as string,
          number: report.number as string | null,
          totalMinor: String(report.total_minor),
          currencyCode: report.currency_code as string,
        }),
        reference: reference ?? '',
      },
    },
    [report.submitter_id as string],
  );

  return claimed.rows[0] as ReimburseResult;
}

/**
 * Approved and waiting to be paid — the AP screen's only query.
 *
 * Reads the partial index `0013` adds. Oldest first, deliberately: the queue an
 * AP clerk works is a queue, and the report that has been waiting longest is the
 * one somebody is chasing.
 */
export interface PayableReport {
  id: string;
  number: string | null;
  title: string;
  total_minor: string;
  currency_code: string;
  submitter_id: string;
  submitter_name: string;
  approved_at: Date | null;
}

export async function listPayableReports(
  tx: QueryRunner,
  limit = 100,
): Promise<PayableReport[]> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.title, rep.total_minor, rep.currency_code,
            rep.submitter_id, rep.approved_at,
            COALESCE(sub.display_name, sub.email) AS submitter_name
       FROM expense_report rep
       JOIN app_user sub ON sub.id = rep.submitter_id
      WHERE rep.status = 'APPROVED'
      ORDER BY rep.approved_at NULLS FIRST
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows as PayableReport[];
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

/**
 * VX2-3 — the approval engine: opening a run, and moving it.
 *
 * The first consumer of everything Phase 2 built. Ported from ExpenseOS
 * `packages/approvals/src/engine.ts` (`startInstance`, `decideTask`,
 * `applyTerminal`) — but only the parts that survive the model change: their
 * engine moves a TOKEN around a graph, ours walks a linear ladder. What ports
 * is the transactional discipline, and that is the valuable half. See GAP-AUDIT
 * AP-9 for why the graph interpreter is deliberately not a port target.
 *
 * ── Three rules that are not negotiable ─────────────────────────────────────
 *
 * 1. EVERY state change writes its audit entry in the SAME transaction. Not
 *    after, not in a queue. A state change that commits without its audit row is
 *    worse than no audit log, because it is a log that is trusted and wrong.
 *
 * 2. A decision is claimed with a CONDITIONAL WRITE, never a read-then-write.
 *    Ported verbatim in spirit from ExpenseOS, whose comment is the clearest
 *    statement of why:
 *
 *      "the conditional write (status: PENDING in the WHERE) is the real guard
 *       against a double-decide (double-click, or assignee + admin racing the
 *       same task). The read-check above is only a fast-fail — without this, two
 *       concurrent decisions could both pass it and both advance the instance,
 *       duplicating downstream tasks and clobbering the final status."
 *
 * 3. Authorization happens INSIDE this module, via `assertCanDecide`. ExpenseOS
 *    leaves it to the caller ("the caller must have already authorized actorId
 *    against the task") and that is exactly how their read-side and write-side
 *    predicates drifted apart — see GAP-AUDIT AP-15. One question, one answer.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { enqueuePost } from '@/lib/integrations/post-outbox';
import { recomputeForReport } from '@/lib/budgets/service';
import { assertCanDecide } from '@/lib/approvals/eligibility';
import { tieredRouter } from '@/lib/approvals/resolver';
import { RoutingError, type ResolvedAssignment } from '@/lib/approvals/routing';
import { planApprovalForReport, countStoredReceipts } from '@/lib/approvals/service';
import { notify, reportPayload } from '@/lib/notifications/service';
import type { StepPlan } from '@/lib/approvals/tiers';

/** The tenant predicate for an INSERT. Declared locally because every
 *  lib/<domain> module does — six copies and counting. Not worth diverging from
 *  the convention inside one ticket, but it is the same drift hazard GAP-AUDIT
 *  AP-12 describes, and a shared constant would be a five-minute change. */
const ORG = "current_setting('app.current_org', true)::uuid";

export type ApprovalEngineErrorCode =
  | 'REPORT_NOT_FOUND'
  | 'WRONG_STATUS'
  | 'RUN_ALREADY_OPEN'
  | 'TASK_NOT_FOUND'
  | 'ALREADY_DECIDED'
  | 'RUN_NOT_RUNNING'
  | 'RECEIPT_ACK_REQUIRED'
  | 'STEP_UNROUTABLE'
  | 'EXTERNAL_DECISION_UNSUPPORTED';

export class ApprovalEngineError extends DomainError {
  constructor(
    message: string,
    readonly code: ApprovalEngineErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'ApprovalEngineError';
  }
}

/* ── opening a run ─────────────────────────────────────────────────────────── */

export interface OpenRunResult {
  requestId: string;
  totalSteps: number;
  /** The task created for step 1. */
  taskId: string;
}

/**
 * Open an approval run for a SUBMITTED report.
 *
 * Called from `submitReport` inside the same transaction, so a report cannot
 * reach SUBMITTED without a run — that state is the fail-open one: a report
 * sitting in SUBMITTED with nobody asked to approve it looks pending forever and
 * is indistinguishable, from the outside, from one waiting on a busy manager.
 *
 * EVERY step is routed here even though only step 1 becomes a task. That is
 * `ApprovalRouter.resolve`'s all-or-nothing contract doing its job: an
 * unroutable step 3 is caught NOW, while the employee is at their screen and can
 * be told, rather than days later when an approver clicks and the report has
 * nowhere to go. The later steps are re-routed when they materialize (see
 * `materializeStep`), so an approver who went on leave in the meantime is
 * skipped — freshness where it matters, validation where it is cheap.
 */
export async function openRun(
  tx: QueryRunner,
  reportId: string,
  openedById: string,
): Promise<OpenRunResult> {
  const r = await tx.query(
    `SELECT id, number, title, status, submitter_id, total_minor, currency_code
       FROM expense_report WHERE id = $1`,
    [reportId],
  );
  if (r.rows.length === 0) {
    throw new ApprovalEngineError(`report ${reportId} not found`, 'REPORT_NOT_FOUND');
  }
  const report = r.rows[0];
  if (report.status !== 'SUBMITTED') {
    throw new ApprovalEngineError(
      `report ${report.number ?? reportId} is ${report.status}; a run opens on SUBMITTED`,
      'WRONG_STATUS',
      'REPORT_NOT_AWAITING_APPROVAL',
    );
  }

  // approval_request_one_running_idx enforces this, but a 23505 is not a
  // sentence. The index is the guarantee; this is the message.
  const open = await tx.query(
    `SELECT id FROM approval_request WHERE report_id = $1 AND status = 'RUNNING'`,
    [reportId],
  );
  if (open.rows.length > 0) {
    throw new ApprovalEngineError(
      `report ${report.number ?? reportId} already has a running approval`,
      'RUN_ALREADY_OPEN',
      'RUN_ALREADY_OPEN',
    );
  }

  const { plan } = await planApprovalForReport(tx, reportId);
  const subject = {
    reportId,
    submitterId: report.submitter_id as string,
    totalMinor: String(report.total_minor),
    currencyCode: report.currency_code as string,
    onDate: new Date(),
  };

  // All-or-nothing. A RoutingError here refuses the SUBMIT, which is the point.
  const assignments = await tieredRouter.resolve(tx, subject, plan);

  const req = await tx.query(
    `INSERT INTO approval_request
       (organization_id, report_id, policy_snapshot, status, current_step, total_steps,
        subject_total_minor, subject_currency_code, opened_by_id)
     VALUES (${ORG}, $1, $2::jsonb, 'RUNNING', 1, $3, $4, $5, $6)
     RETURNING id`,
    [
      reportId,
      JSON.stringify(plan),
      plan.length,
      subject.totalMinor,
      subject.currencyCode,
      openedById,
    ],
  );
  const requestId = req.rows[0].id as string;

  const taskId = await insertTask(tx, requestId, plan[0], assignments[0]);

  await auditAppend(tx, await actorOf(tx, openedById), {
    action: 'APPROVAL_RUN_OPENED',
    entityType: 'approval_request',
    entityId: requestId,
    details: {
      reportId,
      reportNumber: report.number ?? null,
      totalSteps: plan.length,
      // Strings, not BigInt — canonical() throws on BigInt (GAP-AUDIT AU-5).
      totalMinor: subject.totalMinor,
      currencyCode: subject.currencyCode,
      implicitLadder: plan.length === 1 && plan[0].policyId === null,
    },
  });

  // VX2-7. In the SAME transaction as the submit, deliberately — see
  // `notifyTaskOwner`.
  await notifyTaskOwner(tx, taskId, {
    reportId,
    title: report.title as string,
    number: report.number as string | null,
    totalMinor: String(report.total_minor),
    currencyCode: report.currency_code as string,
    // The SUBMITTER is the actor of a TASK_ASSIGNED, not the person who opened
    // the run — they are the same today (submit opens the run) and will stop
    // being so the moment anything else can open one. The sentence says
    // "{actor} needs your approval", and that is the submitter.
    actorId: report.submitter_id as string,
  });

  return { requestId, totalSteps: plan.length, taskId };
}

/* ── deciding ──────────────────────────────────────────────────────────────── */

export type Decision = 'APPROVED' | 'REJECTED' | 'RETURNED';

export interface DecideInput {
  note?: string | null;
  /**
   * The approver states they reviewed the receipts. Required when the step's
   * rung has `require_receipt_view_ack` — which VX2-1 defaults ON, because the
   * expensive direction to be wrong in is the one where the evidence was never
   * recorded at all.
   */
  receiptViewAcknowledged?: boolean;
}

export interface DecideResult {
  decision: Decision;
  /** Where the RUN ended up. */
  requestStatus: 'RUNNING' | 'APPROVED' | 'REJECTED' | 'RETURNED';
  /** Where the REPORT ended up. */
  reportStatus: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RETURNED';
  /** The next step's task, when the run continues. */
  nextTaskId: string | null;
}

export async function decide(
  tx: QueryRunner,
  taskId: string,
  actorId: string,
  decision: Decision,
  input: DecideInput = {},
  ctx: { isAdmin?: boolean; onDate?: Date } = {},
): Promise<DecideResult> {
  // Rule 3: the guard runs here, so no caller can skip it and no page can
  // disagree with it.
  await assertCanDecide(tx, taskId, actorId, ctx);

  const t = await tx.query(
    `SELECT t.id, t.step, t.status, t.assignee_id, t.claim_role,
            q.id  AS request_id, q.status AS request_status,
            q.current_step, q.total_steps, q.policy_snapshot, q.report_id,
            rep.number AS report_number, rep.status AS report_status,
            rep.title AS report_title, rep.submitter_id, rep.total_minor, rep.currency_code
       FROM approval_task    t
       JOIN approval_request q   ON q.id = t.request_id
       JOIN expense_report   rep ON rep.id = q.report_id
      WHERE t.id = $1`,
    [taskId],
  );
  if (t.rows.length === 0) {
    throw new ApprovalEngineError(`approval task ${taskId} not found`, 'TASK_NOT_FOUND');
  }
  const task = t.rows[0];
  if (task.status !== 'PENDING') {
    throw new ApprovalEngineError(
      `approval task ${taskId} is already decided`,
      'ALREADY_DECIDED',
      'TASK_ALREADY_DECIDED',
    );
  }
  if (task.request_status !== 'RUNNING') {
    throw new ApprovalEngineError(
      `the approval run for report ${task.report_number} is ${task.request_status}`,
      'RUN_NOT_RUNNING',
      'RUN_NOT_RUNNING',
    );
  }

  const snapshot = task.policy_snapshot as StepPlan[];
  const step = snapshot.find((s) => s.step === task.step) ?? null;

  // The receipt-view acknowledgement, on a positive decision only: refusing or
  // returning a report is not a claim to have reviewed its evidence.
  const needsAck = decision === 'APPROVED' && (step?.requireReceiptViewAck ?? false);
  if (needsAck && input.receiptViewAcknowledged !== true) {
    throw new ApprovalEngineError(
      'this approval step requires you to confirm you reviewed the receipts',
      'RECEIPT_ACK_REQUIRED',
      'RECEIPT_ACK_REQUIRED',
    );
  }

  const receiptsPresent = await countStoredReceipts(tx, task.report_id as string);

  // Rule 2: the ATOMIC CLAIM. The read-check above is a fast-fail for a good
  // error message; THIS is the guard. Without the `AND status = 'PENDING'` two
  // concurrent decisions — a double-click, or the assignee and an admin racing —
  // would both proceed, materialize step N+1 twice and clobber the final status.
  const claimed = await tx.query(
    `UPDATE approval_task
        SET status = $2,
            decided_by_id = $3,
            decided_at = clock_timestamp(),
            note = $4,
            receipt_view_acknowledged_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
            receipts_present_at_decision = $6
      WHERE id = $1 AND status = 'PENDING'`,
    [
      taskId,
      decision,
      actorId,
      input.note ?? null,
      input.receiptViewAcknowledged === true,
      receiptsPresent,
    ],
  );
  if (claimed.rowCount !== 1) {
    throw new ApprovalEngineError(
      `approval task ${taskId} is already decided`,
      'ALREADY_DECIDED',
      'TASK_ALREADY_DECIDED',
    );
  }

  const actor = await actorOf(tx, actorId);
  const auditDetails = {
    reportId: task.report_id,
    reportNumber: task.report_number ?? null,
    requestId: task.request_id,
    step: task.step,
    totalSteps: task.total_steps,
    note: input.note ?? null,
    receiptViewAcknowledged: input.receiptViewAcknowledged === true,
    receiptsPresentAtDecision: receiptsPresent,
  };

  /* ── a positive decision that is not the last step ──────────────────── */
  if (decision === 'APPROVED' && task.step < task.total_steps) {
    const nextStep = snapshot.find((s) => s.step === task.step + 1);
    if (!nextStep) {
      // The snapshot is the authoritative record of the ladder; a missing step
      // means it was written wrong, and guessing is worse than refusing.
      throw new ApprovalEngineError(
        `the stored ladder for report ${task.report_number} has no step ${task.step + 1}`,
        'STEP_UNROUTABLE',
        'STEP_UNROUTABLE',
      );
    }
    const nextTaskId = await materializeStep(tx, task, nextStep);
    await tx.query(
      `UPDATE approval_request SET current_step = $2 WHERE id = $1`,
      [task.request_id, task.step + 1],
    );
    await auditAppend(tx, actor, {
      action: 'APPROVAL_STEP_APPROVED',
      entityType: 'approval_task',
      entityId: taskId,
      details: auditDetails,
    });
    // VX2-7. The SUBMITTER is not told that step 1 of 3 passed — ExpenseOS does
    // not either, and a bell per rung on a three-rung ladder is how somebody
    // learns to ignore the bell. They hear from us when the run ENDS.
    await notifyTaskOwner(tx, nextTaskId, {
      reportId: task.report_id as string,
      title: task.report_title as string,
      number: task.report_number as string | null,
      totalMinor: String(task.total_minor),
      currencyCode: task.currency_code as string,
      actorId: task.submitter_id as string,
    });
    return {
      decision,
      requestStatus: 'RUNNING',
      reportStatus: 'SUBMITTED',
      nextTaskId,
    };
  }

  /* ── every other outcome closes the run ────────────────────────────── */
  //
  // Remaining PENDING tasks become CANCELLED, not SKIPPED. ExpenseOS uses
  // SKIPPED, but 0008 already gave these two values distinct meanings in this
  // schema: SKIPPED is "a step the resolver could not fill", CANCELLED is "the
  // tasks voided when a submitter recalls". A run ending early voids its
  // remaining tasks — that is the second one. Keeping their value would make
  // "how often could we not find an approver" unanswerable.
  //
  // In a strictly sequential ladder there is normally nothing to cancel, since
  // only one task is ever PENDING. It is done anyway because VX2-4's reassign
  // and any future parallel rung would both break that assumption, and a
  // stranded PENDING task on a closed run is invisible: it sits in an inbox
  // pointing at a report nobody can act on.
  const cancelled = await tx.query(
    `UPDATE approval_task
        SET status = 'CANCELLED', decided_at = clock_timestamp()
      WHERE request_id = $1 AND status = 'PENDING'`,
    [task.request_id],
  );

  const requestStatus = decision;
  const reportStatus = decision;

  await tx.query(
    `UPDATE approval_request
        SET status = $2, closed_at = clock_timestamp()
      WHERE id = $1`,
    [task.request_id, requestStatus],
  );

  // approved_at stamps ONLY on a positive outcome — ported from ExpenseOS's
  // applyTerminal, which is explicit that REJECTED leaves it null.
  //
  // The CASE is computed HERE rather than in SQL. The obvious form —
  // `SET status = $2, approved_at = CASE WHEN $2 = 'APPROVED' THEN … END` —
  // reuses one placeholder as both `expense_report_status` and a text
  // comparison, and Postgres refuses to deduce its type:
  // 42P08 "inconsistent types deduced for parameter $2, text versus
  // expense_report_status". VX2-1's test helper hit this exact error and left a
  // comment about it; I wrote it again anyway. Same fix as there.
  await tx.query(
    `UPDATE expense_report
        SET status = $2, approved_at = $3, updated_at = now()
      WHERE id = $1`,
    [task.report_id, reportStatus, decision === 'APPROVED' ? new Date() : null],
  );

  // VX4-5 part 2 — the budget rollup, on EVERY terminal decision and not only on
  // APPROVED. A rejection or a return takes the report out of `pending_minor`
  // just as surely as an approval moves it into `actual_minor`, and a budget that
  // only ever counts spend upward is the one nobody trusts.
  await recomputeForReport(tx, task.report_id as string, actorId);

  await recordEvent(tx, {
    reportId: task.report_id as string,
    action: decision === 'APPROVED' ? 'APPROVE' : decision === 'REJECTED' ? 'REJECT' : 'RETURN',
    fromStatus: 'SUBMITTED',
    toStatus: reportStatus,
    actorId,
    note: input.note ?? null,
    context: {
      requestId: task.request_id,
      step: task.step,
      totalSteps: task.total_steps,
      cancelledTasks: cancelled.rowCount ?? 0,
      receiptsPresentAtDecision: receiptsPresent,
    },
  });

  // ── VX3-4: the ledger hand-off, ON THE TRANSITION ─────────────────────────
  //
  // Beside the audit append, in the SAME transaction, and only where the report
  // actually reached APPROVED — not on an intermediate step of a multi-tier
  // workflow. GAP-AUDIT AC-6 is why it lives here rather than in a caller:
  // ExpenseOS hangs its post off FOUR call sites plus a 30-minute cron sweep,
  // and one of those call sites was added after a report that auto-approved on
  // submit was "silently never sent to NetSuite". A hook on the transition cannot
  // be forgotten by a new caller.
  //
  // A ROW, not a job (AC-7): it commits with the approval or not at all, so no
  // fire-and-forget trade and no sweep to compensate for one. And it is enqueued
  // unconditionally — whether anything is CONNECTED is the poller's question, not
  // the approver's, because a tenant connecting a ledger next week should still
  // find last week's approvals waiting to go.
  if (reportStatus === 'APPROVED') {
    await enqueuePost(tx, task.report_id as string);
  }

  await auditAppend(tx, actor, {
    action:
      decision === 'APPROVED'
        ? 'REPORT_APPROVED'
        : decision === 'REJECTED'
          ? 'REPORT_REJECTED'
          : 'REPORT_RETURNED',
    entityType: 'expense_report',
    entityId: task.report_id as string,
    details: { ...auditDetails, cancelledTasks: cancelled.rowCount ?? 0 },
  });

  // VX2-7 — the acceptance criterion: "a decision notifies the submitter
  // in-app". `notifyRecipients` drops the actor, so an admin who approved their
  // own report under the AP-14 break-glass gets no bell telling them what they
  // just did.
  await notify(
    tx,
    {
      subjectType: 'EXPENSE_REPORT',
      subjectId: task.report_id as string,
      eventType: decision,
      actorId,
      payload: {
        ...reportPayload({
          title: task.report_title as string,
          number: task.report_number as string | null,
          totalMinor: String(task.total_minor),
          currencyCode: task.currency_code as string,
        }),
        note: input.note ?? '',
      },
    },
    [task.submitter_id as string],
  );

  return { decision, requestStatus, reportStatus, nextTaskId: null };
}

/* ── cancelling a run ──────────────────────────────────────────────────────── */

export interface CancelRunResult {
  requestId: string;
  cancelledTasks: number;
}

/**
 * Cancel the running approval for a report, if there is one.
 *
 * Called from `recallReport`. THIS WAS MISSING and the test suite caught it: a
 * recall took the report back to DRAFT but left the run RUNNING, so the next
 * submit hit `approval_request_one_running_idx` and the employee could never
 * resubmit. A report that cannot be resubmitted after its own author pulled it
 * back is a dead end with no error anybody would understand.
 *
 * CANCELLED is the exactly-right status here, and 0008 said so before this
 * function existed: it describes CANCELLED as "the tasks voided when a submitter
 * recalls". Returns null when there is no open run — a report submitted before
 * VX2-3, or one recalled twice — because refusing a recall on that basis would
 * strand it for a different reason.
 */
export async function cancelRunForReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
): Promise<CancelRunResult | null> {
  const open = await tx.query(
    `SELECT id, current_step, total_steps FROM approval_request
      WHERE report_id = $1 AND status = 'RUNNING'`,
    [reportId],
  );
  if (open.rows.length === 0) return null;
  const requestId = open.rows[0].id as string;

  // BEFORE the UPDATE, because after it there are no PENDING tasks left to ask
  // about. These are the people whose queue is about to lose an item without
  // anybody deciding anything, which is precisely the case that needs telling.
  const pending = await tx.query(
    `SELECT id FROM approval_task WHERE request_id = $1 AND status = 'PENDING'`,
    [requestId],
  );
  const strandedOwners: string[] = [];
  for (const row of pending.rows) {
    strandedOwners.push(...(await taskRecipients(tx, row.id as string)));
  }

  const cancelled = await tx.query(
    `UPDATE approval_task
        SET status = 'CANCELLED', decided_at = clock_timestamp()
      WHERE request_id = $1 AND status = 'PENDING'`,
    [requestId],
  );
  await tx.query(
    `UPDATE approval_request
        SET status = 'CANCELLED', closed_at = clock_timestamp()
      WHERE id = $1`,
    [requestId],
  );

  await auditAppend(tx, await actorOf(tx, actorId), {
    action: 'APPROVAL_RUN_CANCELLED',
    entityType: 'approval_request',
    entityId: requestId,
    details: {
      reportId,
      reason: 'RECALLED_BY_SUBMITTER',
      atStep: open.rows[0].current_step,
      totalSteps: open.rows[0].total_steps,
      cancelledTasks: cancelled.rowCount ?? 0,
    },
  });

  // VX2-7. A recalled report that stays in an approver's inbox looking live is
  // the mirror image of the dead end `cancelRunForReport` exists to fix: the
  // work is gone and only the queue disagrees.
  if (strandedOwners.length > 0) {
    const rep = await tx.query(
      `SELECT title, number, total_minor, currency_code, submitter_id
         FROM expense_report WHERE id = $1`,
      [reportId],
    );
    if (rep.rows.length > 0) {
      const r = rep.rows[0];
      await notify(
        tx,
        {
          subjectType: 'EXPENSE_REPORT',
          subjectId: reportId,
          eventType: 'RECALLED',
          // The submitter withdrew it. `actorId` is the person who called
          // recall, which the lifecycle gate has already proved is the owner or
          // an admin.
          actorId,
          payload: reportPayload({
            title: r.title as string,
            number: r.number as string | null,
            totalMinor: String(r.total_minor),
            currencyCode: r.currency_code as string,
          }),
        },
        strandedOwners,
      );
    }
  }

  return { requestId, cancelledTasks: cancelled.rowCount ?? 0 };
}

/* ── internals ─────────────────────────────────────────────────────────────── */

/**
 * Who should be told about one task: its assignee, or every ACTIVE holder of its
 * claim role.
 *
 * Telling the whole pool is what a pool means — nobody is assigned from it, so a
 * task nobody is told about is a task nobody claims. It is also the one place in
 * VX2-7 that fans out to more than one person, which is why the preference read
 * is batched (`preferencesForMany`).
 *
 * An EMAIL approver gets nothing and returns empty: they have no `app_user` row
 * to hang an inbox on, and reaching them is the approve-link token VX2-8 ships.
 * The resolver refuses to route onto one today, so this branch is unreachable —
 * it is written down rather than left as a crash for when that changes.
 *
 * NOT included: an active delegatee of the assignee. That is correct rather than
 * an omission. The resolver already redirects a task to a delegatee AT ROUTING
 * TIME, so `assignee_id` IS the delegatee whenever a delegation existed when the
 * task was made; and where the delegation came later, VX2-5's own page promises
 * the delegator keeps their queue.
 */
async function taskRecipients(tx: QueryRunner, taskId: string): Promise<string[]> {
  const r = await tx.query(
    `SELECT assignee_id, claim_role FROM approval_task WHERE id = $1`,
    [taskId],
  );
  if (r.rows.length === 0) return [];
  const assigneeId = r.rows[0].assignee_id as string | null;
  if (assigneeId !== null) return [assigneeId];
  const claimRole = r.rows[0].claim_role as string | null;
  if (claimRole === null) return [];
  const holders = await tx.query(
    `SELECT id FROM app_user
      WHERE role = $1 AND deleted_at IS NULL AND employee_status = 'ACTIVE'`,
    [claimRole],
  );
  return holders.rows.map((h) => h.id as string);
}

/**
 * Tell a task's owner it is theirs.
 *
 * IN THE SAME TRANSACTION as the decision or the submit that caused it, so a
 * notification that cannot be written fails the thing that caused it. That is
 * the same coupling VX2-3 chose for the audit row, and the reasoning transfers:
 * the alternative is catching the error and carrying on, which loses the
 * notification silently — and GAP-AUDIT NT-11 is a record of what silent
 * non-delivery costs ("un-diagnosable across several UAT rounds: no error, no
 * log, no delivery"). A rolled-back approval is loud. This is a deliberate
 * trade, not an oversight.
 */
async function notifyTaskOwner(
  tx: QueryRunner,
  taskId: string,
  subject: {
    reportId: string;
    title: string;
    number: string | null;
    totalMinor: string;
    currencyCode: string;
    actorId: string;
  },
): Promise<void> {
  const recipients = await taskRecipients(tx, taskId);
  if (recipients.length === 0) return;
  await notify(
    tx,
    {
      subjectType: 'EXPENSE_REPORT',
      subjectId: subject.reportId,
      eventType: 'TASK_ASSIGNED',
      actorId: subject.actorId,
      payload: reportPayload(subject),
    },
    recipients,
  );
}

/**
 * Route and create the task for one step, at the moment it becomes current.
 *
 * Re-routing rather than replaying the assignment computed when the run opened
 * is deliberate: a report can sit for days between steps, and the manager who
 * was available at submit time may be on leave by the time step 2 comes round.
 * `openRun` already proved every step routable; this asks again for the one step
 * that is about to become somebody's problem.
 *
 * If routing now fails, the whole decision transaction rolls back and the
 * approver is told why. That is deliberately visible: the alternative is a
 * committed approval whose next step has no owner, i.e. a report stuck in
 * SUBMITTED — the exact failure this ticket exists to prevent.
 */
async function materializeStep(
  tx: QueryRunner,
  task: Record<string, unknown>,
  step: StepPlan,
): Promise<string> {
  const rep = await tx.query(
    `SELECT submitter_id, total_minor, currency_code FROM expense_report WHERE id = $1`,
    [task.report_id],
  );
  const report = rep.rows[0];
  let assignment: ResolvedAssignment;
  try {
    const [resolved] = await tieredRouter.resolve(
      tx,
      {
        reportId: task.report_id as string,
        submitterId: report.submitter_id as string,
        totalMinor: String(report.total_minor),
        currencyCode: report.currency_code as string,
        onDate: new Date(),
      },
      [step],
    );
    assignment = resolved;
  } catch (err) {
    if (err instanceof RoutingError) {
      throw new ApprovalEngineError(
        `step ${step.step} of report ${task.report_number} can no longer be routed (${err.code}); ` +
          `fix the approval ladder or the reporting line and try again`,
        'STEP_UNROUTABLE',
        'STEP_UNROUTABLE',
      );
    }
    throw err;
  }
  return insertTask(tx, task.request_id as string, step, assignment);
}

/**
 * One task row from one resolved step.
 *
 * The `owner` union is what makes this safe: `approval_task_owner_exclusive`
 * requires exactly one of assignee_id / assignee_email / claim_role, and the
 * discriminated union means the three columns cannot all be populated from one
 * code path. This is the payoff for widening the VX2-1 seam in VX2-2 — the
 * INSERT cannot disagree with the constraint.
 */
async function insertTask(
  tx: QueryRunner,
  requestId: string,
  step: StepPlan,
  assignment: ResolvedAssignment,
): Promise<string> {
  const owner = assignment.owner;
  const r = await tx.query(
    `INSERT INTO approval_task
       (organization_id, request_id, step, assignee_id, assignee_email, claim_role,
        resolved_via, delegated_from_id, escalation_level, status)
     VALUES (${ORG}, $1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
     RETURNING id`,
    [
      requestId,
      step.step,
      owner.kind === 'USER' ? owner.assigneeId : null,
      owner.kind === 'EMAIL' ? owner.assigneeEmail : null,
      owner.kind === 'ROLE' ? owner.claimRole : null,
      assignment.resolvedVia,
      assignment.delegatedFromId,
      assignment.escalationLevel,
    ],
  );
  return r.rows[0].id as string;
}

/**
 * The acting employee, frozen for the audit row.
 *
 * `expense_report_event.actor_id` is NOT NULL and `audit_entry.actor_id` is
 * ON DELETE RESTRICT, so both need a real employee. An external EMAIL approver
 * has neither — which is fine today because the router refuses to route onto one
 * until VX2-8 (`EMAIL_APPROVER_UNSUPPORTED`), so no external decision can reach
 * this function. When VX2-8 lands, this is one of the places that has to change.
 */
async function actorOf(tx: QueryRunner, actorId: string): Promise<AuditActor> {
  const r = await tx.query(
    `SELECT id, COALESCE(display_name, email) AS name, role
       FROM app_user WHERE id = $1`,
    [actorId],
  );
  if (r.rows.length === 0) {
    throw new ApprovalEngineError(
      `acting employee ${actorId} not found in this tenant`,
      'EXTERNAL_DECISION_UNSUPPORTED',
    );
  }
  return {
    id: r.rows[0].id as string,
    name: r.rows[0].name as string,
    role: r.rows[0].role as string,
  };
}

/**
 * The report's user-facing timeline. Deliberately a local copy of VX1-8's
 * private `recordEvent` rather than an import: `lib/expenses/lifecycle.ts` calls
 * `openRun`, so an import back the other way would be a cycle. The duplication
 * is twenty lines and one table; the cycle would be a build error nobody enjoys.
 *
 * Note this is NOT the audit log. `expense_report_event` is the report's
 * human-readable history (from/to status); `audit_entry` is the hash-chained
 * compliance record across every entity type. Both get written here, on purpose.
 */
async function recordEvent(
  tx: QueryRunner,
  input: {
    reportId: string;
    action: 'APPROVE' | 'REJECT' | 'RETURN';
    fromStatus: string;
    toStatus: string;
    actorId: string;
    note?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<void> {
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

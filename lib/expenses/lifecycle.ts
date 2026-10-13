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
import { startInstance, type StartResult } from '@expenseos/approvals/engine';
import { writeAudit } from '@expenseos/audit';
import { recomputeForReport } from '@/lib/budgets/service';
import { rolesStandingFor } from '@/lib/approvals/systemRoleHolders';
import { tenantDbOf } from '@/lib/db/prisma-pg-bridge';
import type { TenantDb } from '@/lib/db/prisma';
import { enqueuePost } from '@/lib/integrations/post-outbox';
import { notify, reportPayload } from '@/lib/notifications/service';
import type { ReportStatus } from '@/lib/expenses/service';
import { append as auditAppend } from '@/lib/audit/service';
import { capabilityAvailability } from '@/lib/integrations/service';
import { uncodedCategories, uncodedDiagnostic } from '@/lib/integrations/coding';
import { ORG } from '@/lib/tenant/sql';
import { assertTenantMayWrite } from '@/lib/billing/gate';


export type TransitionAction = 'SUBMIT' | 'RECALL' | 'APPROVE' | 'REJECT' | 'RETURN' | 'REIMBURSE';

/**
 * A stored policy finding, as the submit gate reads it.
 *
 * w4-02d: since the cutover the policy pass is ExpenseOS's (`server/policy/validate.ts`),
 * which the submit procedure runs first, in this same transaction, and which writes the
 * report's findings. This lifecycle no longer runs an engine of its own; it reads what that
 * pass just wrote, so the gate below and the event's record of "what the gate saw" stand.
 */
export interface StoredFinding {
  id: string;
  rule_code: string;
  severity: 'INFO' | 'WARNING' | 'BLOCK';
  message: string;
  line_item_id: string | null;
  resolved_at: Date | null;
  resolved_by_id: string | null;
  resolve_note: string | null;
}

export interface StoredFindings {
  violations: StoredFinding[];
  counts: { INFO: number; WARNING: number; BLOCK: number };
  /** An open BLOCK: one nobody may talk past (`resolved_at` is never set on a BLOCK). */
  blocking: boolean;
  /** WARNINGs with no justification yet (w2-11, d34). */
  unjustifiedWarning: number;
}

/** The report's stored findings (w4-02d), as the gate and the record read them. */
export async function storedFindings(tx: QueryRunner, reportId: string): Promise<StoredFindings> {
  const r = await tx.query(
    `SELECT id, rule_code, severity::text AS severity, message, line_item_id, resolved_at,
            resolved_by_id, resolve_note
       FROM policy_violation WHERE report_id = $1
      ORDER BY created_at, id`,
    [reportId],
  );
  const violations = r.rows as StoredFinding[];
  const counts = { INFO: 0, WARNING: 0, BLOCK: 0 };
  for (const v of violations) counts[v.severity] += 1;
  return {
    violations,
    counts,
    blocking: violations.some((v) => v.severity === 'BLOCK' && v.resolved_at === null),
    unjustifiedWarning: violations.filter((v) => v.severity === 'WARNING' && v.resolved_at === null).length,
  };
}

export type LifecycleErrorCode =
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'EMPTY_REPORT'
  | 'UNDATED'
  | 'UNCODED'
  | 'BLOCKED_BY_POLICY'
  /** w2-11 (d34): a WARNING nobody has justified — ExpenseOS's `unjustifiedWarning` gate. */
  | 'UNJUSTIFIED_WARNING'
  /** w4-00c (d58): no published workflow governs the report. ExpenseOS approves it; this
   *  refuses, so a missing flow can never approve spend by omission. */
  | 'NO_WORKFLOW'
  /** w4-00c: the flow routed the report only to its own submitter, who may not decide it
   *  (4 Oct 2026: nobody approves their own expenses, a solo founder included). */
  | 'NO_APPROVER'
  | 'FORBIDDEN';

export class LifecycleError extends DomainError {
  constructor(
    message: string,
    readonly code: LifecycleErrorCode,
    /** The findings that refused a submit, so the UI can list them. */
    readonly violations: StoredFinding[] = [],
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
  /** Null for a transition no person made (w4-00c): an approval deadline passing, or a
   *  flow that decided on submit. `context.system` then names what made it. */
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  note: string | null;
  context: Record<string, unknown>;
  created_at: Date;
}

/** Which statuses a recall may return to DRAFT from. */
const RECALLABLE: ReportStatus[] = ['SUBMITTED', 'RETURNED'];

/**
 * Which statuses may be submitted. w2-11: RETURNED as well as DRAFT — ExpenseOS's
 * `EDITABLE_REPORT_STATUSES`, and the rule d26 already applied to editing. A report an
 * approver sent back is edited where it stands and resubmitted, as in ExpenseOS; before
 * w2-11 it had to be recalled to DRAFT first. The returned run has already ended
 * (`decide` closes it), so `openRun` below opens a fresh one, as it does after a recall.
 */
const SUBMITTABLE: ReportStatus[] = ['DRAFT', 'RETURNED'];

/**
 * w4-00c: the tenant's Prisma transaction behind `tx`. ExpenseOS's approval engine is Prisma
 * code, and it must run in the SAME transaction as the status this module writes — a plain
 * `pg` transaction (`withOrg`) is another connection, and the engine there would queue behind
 * the report row this one has locked. So a transition is called with `queryRunnerOf(db)`.
 */
function requireTenantDb(tx: QueryRunner): TenantDb {
  const db = tenantDbOf(tx);
  if (!db) {
    throw new Error(
      'lifecycle: a report transition runs on the tenant Prisma transaction (queryRunnerOf), ' +
        'which the approval engine shares — not on a separate pg transaction',
    );
  }
  return db;
}

/**
 * The report's head. `lock: true` for a TRANSITION (submit, recall): the row is
 * then held until COMMIT, so the status checked is the status written over —
 * see `requireReport` in `lib/expenses/service.ts` for the race this closes and
 * `test/report-lock.db.test.ts` for both orderings. The readiness probe passes
 * `false`: it decides nothing, and a page render should not queue behind a save.
 */
async function requireReport(tx: QueryRunner, reportId: string, lock: boolean) {
  const r = await tx.query(
    `SELECT id, number, status, total_minor, currency_code FROM expense_report WHERE id = $1${
      lock ? ' FOR UPDATE' : ''
    }`,
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
    /** Null only for a transition no person made, with `context.system` naming what did. */
    actorId: string | null;
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
  /** w4-02d: the findings the gate read (`storedFindings`). */
  validation: StoredFindings;
  /**
   * The approval instance started for this submission — ExpenseOS's `startInstance` result
   * (w4-00c). Never NO_WORKFLOW (d58 refuses that), so a SUBMITTED report always has a
   * running instance: the fail-open state, a report that looks pending forever, cannot
   * be reached. Its `createdTaskIds` and `firedEffects` are the caller's to notify and run.
   */
  approval: StartResult & { instanceId: string };
}

export interface SubmitOptions {
  /**
   * w4-02d: the policy pass, run by this function at the point v1's ran — after the report
   * is locked and the factual gates (status, lines, dates, coding) have passed, in the same
   * transaction. The submit procedure hands in ExpenseOS's (`server/policy/validate.ts`),
   * which writes the report's findings and may refuse on its own; the gate below then reads
   * what it wrote.
   *
   * Here rather than before this function, for the two things v1's placement bought: the
   * report row is locked FIRST, so an edit that lands while the pass runs is waited for
   * rather than missed (test/report-lock.db.test.ts); and a coding problem is reported
   * before a policy one (UD-2).
   */
  policyPass?: () => Promise<unknown>;
}

/** DRAFT → SUBMITTED. Throws LifecycleError with the blocking findings attached. */
export async function submitReport(
  tx: QueryRunner,
  reportId: string,
  actorId: string,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  // VX5-11. BEFORE the status check and before the policy pass, because a tenant
  // whose subscription has lapsed should be told THAT rather than being walked
  // through validation whose outcome cannot matter. Same ordering argument UD-2
  // makes for the GL-coding gate: check the fact before the judgement.
  await assertTenantMayWrite(tx, 'submit a report');

  const report = await requireReport(tx, reportId, true);
  if (!SUBMITTABLE.includes(report.status)) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} is ${report.status}; only a DRAFT or RETURNED report can be submitted`,
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

  // ── VX4-11: does every expense say WHEN it happened? ─────────────────────
  //
  // `txn_date` is nullable (0003) and the form collected it without insisting, so
  // a tenant whose people skipped it got **no duplicate detection at all** and
  // nothing on any screen said so: `lib/fraud/rules.ts`'s duplicate and outlier
  // detectors both bound on `txn_date`, and an expense with none is invisible to
  // them rather than reported by them. Found by VX4-8's own e2e, which failed for
  // exactly this reason until the date was filled in.
  //
  // REQUIRED AT SUBMIT, NOT AT THE COLUMN, and the receipt-first flow is why: the
  // `startFromReceipts` path (`lib/receipts/service.ts`) creates one expense per
  // uploaded receipt before anybody has opened it, and the person coding it later
  // is the first one who knows the date. A NOT NULL column would have to invent a
  // value there. A DRAFT may be incomplete; a submitted report may not.
  //
  // UNCONDITIONAL, unlike the coding gate below. That one is conditional on a
  // connected ledger because the requirement comes from the integration. This one
  // is not: the date orders the report, attributes the spend to a period for
  // analytics and budgets, goes on the ledger wire, and is what the detectors key
  // on. And unlike an unmapped category — admin-owned, so being blocked is a dead
  // end for the employee — this is a fact the person filing has in front of them.
  const undated = await tx.query(
    `SELECT count(*)::int AS n FROM expense WHERE report_id = $1 AND txn_date IS NULL`,
    [reportId],
  );
  const undatedCount = undated.rows[0].n as number;
  if (undatedCount > 0) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} has ${undatedCount} expense(s) with no transaction date`,
      'UNDATED',
      [],
      undatedCount === 1
        ? 'SUBMIT_UNDATED_ONE'
        : { code: 'SUBMIT_UNDATED_MANY', params: { count: String(undatedCount) } },
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

  // w4-02d: the caller's policy pass (ExpenseOS's engine, `SubmitOptions.policyPass`), then
  // the gate on what it wrote — so no path reaches SUBMITTED past an open BLOCK or an
  // unexplained WARNING, whether or not the caller ran a pass.
  if (options.policyPass) await options.policyPass();
  const validation = await storedFindings(tx, reportId);
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

  // w2-11 (d34): ExpenseOS's other half of the policy gate. A WARNING propagates to the
  // approver only once the submitter has said why — "a warning is submittable only once
  // the submitter attaches a comment over the exception". Until w2-11 VeloExpense let it
  // through unexplained. After the BLOCK check, so a report with both is told about the
  // one that cannot be talked past first.
  if (validation.unjustifiedWarning > 0) {
    const unjustified = validation.violations.filter(
      (v) => v.severity === 'WARNING' && v.resolved_at === null,
    );
    throw new LifecycleError(
      unjustified.length === 1
        ? 'One policy warning needs a justification before this report can be submitted.'
        : `${unjustified.length} policy warnings need a justification before this report can be submitted.`,
      'UNJUSTIFIED_WARNING',
      unjustified,
      unjustified.length === 1 ? 'SUBMIT_UNJUSTIFIED_WARNING_ONE' : 'SUBMIT_UNJUSTIFIED_WARNING_MANY',
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
      WHERE id = $1 AND status IN ('DRAFT', 'RETURNED')
      RETURNING id, number, status, submitted_at, department_id`,
    [reportId],
  );
  // The status is in the WHERE as well as in the check above, so the write
  // refuses on its own even for a caller that reached it without the lock.
  if (updated.rowCount !== 1) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} is no longer a DRAFT or RETURNED; it was not submitted`,
      'WRONG_STATUS',
      [],
      'REPORT_NOT_SUBMITTABLE',
    );
  }

  // VX4-5 part 2 — the budget rollup, ON THE TRANSITION and AFTER the status
  // write, so this report is counted as pending by the recompute it triggers.
  // Same placement rule as VX3-4's ledger hand-off (AC-6): a hook on the
  // transition cannot be forgotten by a new caller, and it commits with the
  // submission or not at all.
  //
  // Note the ordering against the policy pass (run by the submit procedure before this),
  // which is deliberate: the rule warns using the baseline WITHOUT this report plus this
  // report's own contribution, then the report becomes part of the baseline. Recomputing
  // first would double-count it.
  await recomputeForReport(tx, reportId, actorId);

  await recordEvent(tx, {
    reportId,
    action: 'SUBMIT',
    // w2-11: a resubmitted RETURNED report records where it really came from.
    fromStatus: report.status,
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

  // REPORT_SUBMITTED into the audit chain, BEFORE the report is routed, so the chain reads
  // in the order things happened: put forward, then routed.
  await auditTransition(tx, actorId, 'REPORT_SUBMITTED', reportId, {
    reportNumber: report.number ?? null,
    totalMinor: String(report.total_minor),
    currencyCode: report.currency_code,
    acknowledgedCount: validation.violations.filter((v) => v.resolved_at !== null).length,
  });

  const approval = await routeSubmittedReport(tx, reportId, report.number ?? null);
  const status = await tx.query(`SELECT status FROM expense_report WHERE id = $1`, [reportId]);
  return {
    report: { ...updated.rows[0], status: status.rows[0].status as ReportStatus },
    validation,
    approval,
  };
}

/**
 * w4-00c: route a report that has just become SUBMITTED, on ExpenseOS's engine, in THIS
 * transaction — ExpenseOS's `expenses.submit` after its checks (`startInstance`, the status
 * it implies, `approvalInstanceId`).
 *
 * Coupled to the submit rather than left to the caller, as the ladder's `openRun` was: a
 * report that cannot be routed is refused HERE, while the employee is at their screen and
 * can be told, and the whole submit rolls back with it. VeloExpense's differences:
 *   · NO_WORKFLOW refuses the submit (d58). ExpenseOS approves the report;
 *   · a flow that routes the report only to its own submitter refuses it (NO_APPROVER) —
 *     the 4 Oct 2026 rule the ladder enforced, which the engine leaves to `canDecide`, where
 *     the task would sit with nobody able to act on it;
 *   · a flow that decides on submit (a condition with no approval on its path) goes through
 *     `recordReportOutcome`, as a decision does — the budget, the history, the ledger post
 *     and the audit row. ExpenseOS posts it from the router (`postApprovedReport`).
 */
async function routeSubmittedReport(
  tx: QueryRunner,
  reportId: string,
  reportNumber: string | null,
): Promise<StartResult & { instanceId: string }> {
  const db = requireTenantDb(tx);
  const start = await startInstance(db, 'EXPENSE_REPORT', reportId);
  if (start.status === 'NO_WORKFLOW' || start.instanceId === null) {
    throw new LifecycleError(
      `no approval workflow governs report ${reportNumber ?? reportId}`,
      'NO_WORKFLOW',
      [],
      'SUBMIT_NO_WORKFLOW',
    );
  }
  await tx.query(`UPDATE expense_report SET approval_instance_id = $2 WHERE id = $1`, [
    reportId,
    start.instanceId,
  ]);
  if (start.status === 'RUNNING') {
    await assertSomeoneElseCanDecide(db, reportId, start.createdTaskIds);
  } else {
    await recordReportOutcome(tx, {
      reportId,
      outcome: start.status,
      actor: { system: 'approval.workflow' },
      note: null,
      context: { instanceId: start.instanceId },
    });
  }
  return { ...start, instanceId: start.instanceId };
}

/**
 * w4-00c: refuse a submit whose first approvals could only be decided by the submitter.
 *
 * The engine assigns what the flow names, and `canDecide` refuses a requester their own
 * report — so a task parked on the submitter, or a pool whose only member is the submitter,
 * is a report nobody can move. Two cases are knowable here, and both are refused:
 *   · a task ASSIGNED to the submitter (a named fallback, a manager chain that loops back);
 *   · an UNASSIGNED task whose node falls back to a ROLE that nobody but the submitter holds
 *     — the default flow's case (d59) for a solo founder, which `SUBMIT_NEEDS_APPROVER`
 *     already explains in the words the setup checklist uses.
 * A filter pool, or a relative approver with no fallback, is open to whoever the engine finds
 * eligible when they look; this does not try to predict that, and does not refuse it.
 */
async function assertSomeoneElseCanDecide(
  db: TenantDb,
  reportId: string,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { submitterId: true },
  });
  if (!report) return;
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
      stranded.push(t.assigneeUserId === report.submitterId);
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
        role: { in: rolesStandingFor(fallback.roleId) },
        id: { not: report.submitterId },
        deletedAt: null,
        employeeStatus: 'ACTIVE',
      },
    });
    stranded.push(others === 0);
  }
  // Every first approval stranded: nobody can move the report. One reachable approval of
  // several (a parallel step) is enough to keep it moving.
  if (stranded.length > 0 && stranded.every(Boolean)) {
    throw new LifecycleError(
      `report ${reportId} would route only to its own submitter`,
      'NO_APPROVER',
      [],
      'SUBMIT_NEEDS_APPROVER',
    );
  }
}

/** The outcomes a decision, a lapsed deadline or a flow can bring a submitted report to. */
export type ReportOutcome = 'APPROVED' | 'REJECTED' | 'RETURNED';

/** Who brought it about: a person, or — for a deadline or a flow — the named system. */
export type OutcomeActor = { userId: string } | { system: string };

/**
 * w4-00c: everything VeloExpense does when a submitted report reaches an outcome, in the
 * transaction that reached it. The engine writes the status (`applyTerminal`; a return writes
 * it in `expenseApprovals.returnForEdit`); this writes what follows from it, which the ladder's
 * `decide` did on the transition and every path to an outcome must do alike:
 *   · the budgets, recomputed (VX4-5) — the report leaves pending, or becomes actual;
 *   · the report's history (`expense_report_event`), with the approver's note;
 *   · on APPROVED, the ledger post queued (VX3-4, AC-6/AC-7), which ExpenseOS's routers call
 *     `postApprovedReport` for — a row on the transition, so no caller can forget it;
 *   · the audit chain: REPORT_APPROVED / _REJECTED / _RETURNED, as the person, or as the
 *     named system (`system:<name>`).
 * Notifying the submitter is the caller's (`server/lib/reportNotify.ts`), as in ExpenseOS.
 */
export async function recordReportOutcome(
  tx: QueryRunner,
  input: {
    reportId: string;
    outcome: ReportOutcome;
    actor: OutcomeActor;
    note: string | null;
    /** Extra facts for the history row and the audit row (the task, an override). */
    context?: Record<string, unknown>;
  },
): Promise<void> {
  const userId = 'userId' in input.actor ? input.actor.userId : null;
  const system = 'system' in input.actor ? input.actor.system : null;
  await recomputeForReport(tx, input.reportId, userId);
  await recordEvent(tx, {
    reportId: input.reportId,
    action:
      input.outcome === 'APPROVED' ? 'APPROVE' : input.outcome === 'REJECTED' ? 'REJECT' : 'RETURN',
    fromStatus: 'SUBMITTED',
    toStatus: input.outcome,
    actorId: userId,
    note: input.note,
    context: { ...(input.context ?? {}), ...(system ? { system } : {}) },
  });
  if (input.outcome === 'APPROVED') await enqueuePost(tx, input.reportId);

  const number = await tx.query(`SELECT number FROM expense_report WHERE id = $1`, [input.reportId]);
  const action =
    input.outcome === 'APPROVED'
      ? 'REPORT_APPROVED'
      : input.outcome === 'REJECTED'
        ? 'REPORT_REJECTED'
        : 'REPORT_RETURNED';
  const details = {
    reportNumber: (number.rows[0]?.number as string | null | undefined) ?? null,
    note: input.note,
    ...(input.context ?? {}),
  };
  if (userId) {
    await auditTransition(tx, userId, action, input.reportId, details);
  } else {
    await writeAudit(requireTenantDb(tx), {
      action,
      entityType: 'expense_report',
      entityId: input.reportId,
      actor: { kind: 'system', jobName: system ?? 'approval' },
      details,
    });
  }
}

/**
 * A report transition into the tamper-evident chain, as the person who made it.
 *
 * `expense_report_event` already records every transition for the report's own
 * history screen; this is the OTHER record, the one an auditor verifies. Until
 * 4 Oct 2026 the chain held approvals and reimbursements but not submits or
 * recalls, so it could say who signed a report off and not who put it forward.
 */
async function auditTransition(
  tx: QueryRunner,
  actorId: string,
  action:
    | 'REPORT_SUBMITTED'
    | 'REPORT_RECALLED'
    | 'REPORT_APPROVED'
    | 'REPORT_REJECTED'
    | 'REPORT_RETURNED',
  reportId: string,
  details: Record<string, unknown>,
): Promise<void> {
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
    { action, entityType: 'expense_report', entityId: reportId, details },
  );
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
  const report = await requireReport(tx, reportId, true);
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
      WHERE id = $1 AND status IN ('SUBMITTED', 'RETURNED')
      RETURNING id, number, status`,
    [reportId],
  );
  // Without the status in the WHERE, a recall that had read SUBMITTED and then
  // waited behind an approval put the APPROVED report back into DRAFT — editable,
  // with its ledger posting already queued. The lock above makes the read
  // current; this makes the write refuse even if a caller skips the lock.
  if (updated.rowCount !== 1) {
    throw new LifecycleError(
      `report ${report.number ?? reportId} is no longer submitted or returned; it was not recalled`,
      'WRONG_STATUS',
      [],
      'REPORT_NOT_RECALLABLE',
    );
  }

  // Cancel the approval instance. Recalling and resubmitting deliberately starts a NEW
  // instance rather than resuming the old one: a report's total can move while it is back
  // in DRAFT, and the workflow it matches can move with it.
  // ExpenseOS writes no audit row of its own for the cancelled instance, so REPORT_RECALLED
  // carries it: which instance was voided, and how many pending tasks with it.
  const cancelled = await cancelApprovalInstance(requireTenantDb(tx), reportId);
  await auditTransition(tx, actorId, 'REPORT_RECALLED', reportId, {
    reportNumber: report.number ?? null,
    fromStatus: report.status,
    note: note ?? null,
    ...(cancelled ? { instanceId: cancelled.instanceId, cancelledTasks: cancelled.taskIds.length } : {}),
  });

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
      ? { cancelledInstanceId: cancelled.instanceId, cancelledTasks: cancelled.taskIds.length }
      : {},
  });

  // The approvers whose pending tasks were cancelled — the caller tells them
  // (`notifyReportRecalled`), as ExpenseOS's `expenses.recall` does.
  return { ...updated.rows[0], cancelledTaskIds: cancelled?.taskIds ?? [] };
}

/**
 * w4-00c: ExpenseOS's recall body (`expenses.recall`, 550b2945) — the report's running
 * instance CANCELLED and its pending tasks SKIPPED — returning the tasks it cancelled,
 * captured BEFORE they were skipped. Null when nothing was running: a RETURNED report's
 * instance has already ended, and refusing the recall on that basis would strand it.
 *
 * VeloExpense: the instance is the report's `approval_instance_id`, read under the lock the
 * recall already holds on the report, and a cancelled instance's tasks are only those still
 * PENDING, as ExpenseOS's are.
 */
async function cancelApprovalInstance(
  db: TenantDb,
  reportId: string,
): Promise<{ instanceId: string; taskIds: string[] } | null> {
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { approvalInstanceId: true },
  });
  const instanceId = report?.approvalInstanceId ?? null;
  if (!instanceId) return null;
  const instance = await db.approvalInstance.findUnique({
    where: { id: instanceId },
    select: { status: true },
  });
  if (instance?.status !== 'RUNNING') return null;
  // Capture the approvers to notify BEFORE the tasks are skipped.
  const taskIds = (
    await db.approvalTask.findMany({
      where: { instanceId, status: 'PENDING' },
      select: { id: true },
    })
  ).map((tk) => tk.id);
  await db.approvalTask.updateMany({
    where: { instanceId, status: 'PENDING' },
    data: { status: 'SKIPPED' },
  });
  await db.approvalInstance.update({
    where: { id: instanceId },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  return { instanceId, taskIds };
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
  // VX5-11. Reimbursement is not in John's three words ("submit, approve or
  // post") and is gated anyway, stated here rather than assumed: it records that
  // money left the company, which is the same family as the other three and the
  // one a reader would be most surprised to find open.
  await assertTenantMayWrite(tx, 'mark a report reimbursed');

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
       LEFT JOIN app_user u ON u.id = e.actor_id
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
  const report = await requireReport(tx, reportId, false);
  const lines = await tx.query(
    `SELECT COUNT(*)::int AS count
       FROM expense_line_item li JOIN expense e ON e.id = li.expense_id
      WHERE e.report_id = $1`,
    [reportId],
  );
  const validation = await storedFindings(tx, reportId);
  const reasons: string[] = [];
  if (!SUBMITTABLE.includes(report.status)) reasons.push(`the report is ${report.status}`);
  if (lines.rows[0].count === 0) reasons.push('it has no line items');
  if (validation.blocking) reasons.push('it has blocking policy violations');
  // w2-11 (d34).
  if (validation.unjustifiedWarning > 0) reasons.push('it has policy warnings with no justification');
  return {
    canSubmit: reasons.length === 0,
    canRecall: RECALLABLE.includes(report.status),
    reasons,
  };
}

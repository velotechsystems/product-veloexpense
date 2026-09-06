/**
 * VX4-8 part 4 — a person's verdict on a fraud flag, and the queue they read.
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────────────
 *
 * A flag has exactly two authors: the SCAN, which may only ever create or refresh
 * an `ACTIVE` row, and a PERSON, who moves it to `RESOLVED`, `DISMISSED` or
 * `ESCALATED` and gives a reason. Neither may undo the other. `lib/fraud/scan.ts`
 * enforces the machine's half in the database (`ON CONFLICT … WHERE status =
 * 'ACTIVE'`); this file enforces the person's half the same way, with a
 * conditional write, so two reviewers clicking at once produce one verdict and
 * one refusal rather than a last-writer-wins.
 *
 * ── WHY A VERDICT IS NOT REVERSIBLE HERE ────────────────────────────────────
 *
 * There is no "un-dismiss". Upstream has none either, and the reason is the one
 * their scan's header gives: "I already looked at this" has to stick, or the queue
 * becomes noise nobody reads. If a dismissal was wrong, the honest repair is a NEW
 * flag with a person's name on it — which is what `raiseManualFlag` is for — not a
 * silent rewrite of what somebody concluded last quarter.
 *
 * That is a product decision rather than a technical one, and it is the kind
 * worth writing down: the alternative (an editable status) is one line of SQL and
 * would quietly turn the review trail into a mutable field.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { manualFinding, type FraudSeverity } from '@/lib/fraud/rules';
import { requireModule } from '@/lib/modules/service';
import { ORG } from '@/lib/tenant/sql';


/**
 * `AuditActor.id` is nullable — VX2-8's mail worker and VX2-2's token path both
 * act with no `app_user` row. Neither can reach this file (both are gated on the
 * compliance module and on an admin session), so a null here is a caller that
 * should not exist rather than a case to handle politely.
 */
function actorId(actor: AuditActor): string {
  if (!actor.id) throw new Error('a fraud review needs an identified actor');
  return actor.id;
}

/** The three verdicts a person can reach. `ACTIVE` is not among them. */
export const VERDICTS = ['RESOLVED', 'DISMISSED', 'ESCALATED'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Every value `fraud_flag.status` can hold: the scan's one, plus the person's
 * three. A RUNTIME array because `test/i18n-enum-catalog.test.ts` has its own
 * test saying a union with an exported array must use it rather than retyping
 * its members — the correspondence part 1 of this ticket found gone stale.
 */
export const FLAG_STATUSES = ['ACTIVE', ...VERDICTS] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

export type ReviewErrorCode =
  | 'FLAG_NOT_FOUND'
  | 'FLAG_ALREADY_REVIEWED'
  | 'NOTE_REQUIRED'
  | 'SUBJECT_REQUIRED';

export class ReviewError extends DomainError {
  constructor(message: string, readonly code: ReviewErrorCode, userMessage: UserMessageCode) {
    super(message, userMessage);
    this.name = 'ReviewError';
  }
}

export interface FlagRow {
  id: string;
  rule_code: string;
  severity: FraudSeverity;
  status: FlagStatus;
  message_code: string;
  data: Record<string, unknown>;
  evidence: Record<string, unknown>;
  report_id: string | null;
  expense_id: string | null;
  subject_user_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
  /** Joined for the screen. Null when the subject is gone or was never set. */
  report_number: string | null;
  report_title: string | null;
  subject_name: string | null;
  reviewer_name: string | null;
}

const SELECT_FLAG = `
  SELECT f.id, f.rule_code, f.severity, f.status, f.message_code, f.data, f.evidence,
         f.report_id, f.expense_id, f.subject_user_id, f.first_seen_at, f.last_seen_at,
         f.reviewed_at, f.review_note,
         r.number AS report_number, r.title AS report_title,
         coalesce(su.display_name, su.email) AS subject_name,
         coalesce(ru.display_name, ru.email) AS reviewer_name
    FROM fraud_flag f
    LEFT JOIN expense_report r ON r.id = f.report_id
    LEFT JOIN app_user su ON su.id = f.subject_user_id
    LEFT JOIN app_user ru ON ru.id = f.reviewed_by_id`;

/**
 * The queue. Open flags first, worst first, and reviewed ones after.
 *
 * ONE LIST, not a filter the screen has to remember to apply. A queue that shows
 * only open items makes "what did we decide about this" unanswerable without
 * another screen, and the whole argument for keeping reviewed rows (rather than
 * deleting them) is that somebody will ask.
 */
export async function listFlags(tx: QueryRunner, limit = 200): Promise<FlagRow[]> {
  const r = await tx.query(
    `${SELECT_FLAG}
      ORDER BY (f.status = 'ACTIVE') DESC, f.severity DESC, f.last_seen_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows as FlagRow[];
}

export async function flagSummary(
  tx: QueryRunner,
): Promise<{ active: number; reviewed: number; critical: number }> {
  const r = await tx.query(
    `SELECT count(*) FILTER (WHERE status = 'ACTIVE')                          AS active,
            count(*) FILTER (WHERE status <> 'ACTIVE')                         AS reviewed,
            count(*) FILTER (WHERE status = 'ACTIVE' AND severity = 'HIGH')    AS critical
       FROM fraud_flag`,
  );
  const row = r.rows[0];
  return {
    active: Number(row.active),
    reviewed: Number(row.reviewed),
    critical: Number(row.critical),
  };
}

/**
 * Record a person's verdict.
 *
 * ── THE NOTE IS REQUIRED FOR A DISMISSAL, AND ONLY FOR A DISMISSAL ──────────
 *
 * `RESOLVED` means the thing was real and has been dealt with; the fix is its own
 * record. `ESCALATED` means somebody else is now looking. `DISMISSED` means **a
 * finding about somebody's expenses was set aside**, and that is the one an
 * auditor will ask about — VX1-7 made the same call for acknowledging a policy
 * violation ("an acknowledgement requires a note") and for the same reason.
 *
 * A conditional write on `status = 'ACTIVE'`: `rowCount !== 1` means either no
 * such flag or somebody already ruled on it, and the two are told apart by a
 * second read so the refusal can say which.
 */
export async function recordVerdict(
  tx: QueryRunner,
  actor: AuditActor,
  input: { flagId: string; verdict: Verdict; note?: string | null },
): Promise<void> {
  await requireModule(tx, 'compliance');
  const note = input.note?.trim() ?? '';
  if (input.verdict === 'DISMISSED' && note === '') {
    throw new ReviewError(
      'a dismissal requires a note',
      'NOTE_REQUIRED',
      'FRAUD_DISMISS_NEEDS_NOTE',
    );
  }

  const r = await tx.query(
    `UPDATE fraud_flag
        SET status = $2::fraud_flag_status,
            reviewed_at = clock_timestamp(),
            reviewed_by_id = $3,
            review_note = nullif($4, ''),
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING rule_code, severity, message_code`,
    [input.flagId, input.verdict, actorId(actor), note],
  );

  if (r.rowCount !== 1) {
    // Which refusal it is matters to the person: "somebody got there first" and
    // "that does not exist" lead to different next actions.
    const existing = await tx.query('SELECT status FROM fraud_flag WHERE id = $1', [input.flagId]);
    if (existing.rowCount === 1) {
      throw new ReviewError(
        `flag ${input.flagId} is already ${existing.rows[0].status}`,
        'FLAG_ALREADY_REVIEWED',
        'FRAUD_FLAG_ALREADY_REVIEWED',
      );
    }
    throw new ReviewError('no such flag', 'FLAG_NOT_FOUND', 'FRAUD_FLAG_NOT_FOUND');
  }

  // Audited against the FLAG's report where it has one, so the decision sits in
  // the same chain as the approval it is about — the reasoning `auditPostAction`
  // gives for attributing a queue action to its report.
  const flag = await tx.query('SELECT report_id FROM fraud_flag WHERE id = $1', [input.flagId]);
  const reportId = flag.rows[0].report_id as string | null;
  await auditAppend(tx, actor, {
    action: `FRAUD_FLAG_${input.verdict}`,
    entityType: reportId === null ? 'fraud_flag' : 'expense_report',
    entityId: reportId ?? input.flagId,
    details: {
      flagId: input.flagId,
      ruleCode: r.rows[0].rule_code,
      severity: r.rows[0].severity,
      // The note is IN the audit row as well as on the flag. The flag can be
      // cascaded away with its report; the audit chain cannot.
      note: note === '' ? null : note,
    },
  });
}

/**
 * A flag raised by a person rather than by a rule.
 *
 * The finding is built by `manualFinding()` in `lib/fraud/rules.ts` rather than
 * here, and that is not shuffling: `scripts/check-i18n.mjs` finds every fraud
 * message code by scanning THAT file for `finding(RULE, CODE, …)`. A manual flag
 * assembled here would be a message code the gate cannot see — and part 2 already
 * had `MANUAL_FLAG` refused as orphan copy for exactly that reason, which is how
 * the constraint was discovered rather than guessed.
 */
export async function raiseManualFlag(
  tx: QueryRunner,
  actor: AuditActor,
  input: {
    note: string;
    severity: FraudSeverity;
    reportId?: string | null;
    subjectUserId?: string | null;
  },
): Promise<string> {
  await requireModule(tx, 'compliance');
  const note = input.note.trim();
  if (note === '') {
    throw new ReviewError('a manual flag needs a note', 'NOTE_REQUIRED', 'FRAUD_FLAG_NEEDS_NOTE');
  }
  /**
   * A FLAG HAS TO BE ABOUT SOMETHING, and this refusal exists because the
   * database said so first.
   *
   * `fraud_flag_subject_chk` (0031) requires one of report / expense / subject
   * user, on the argument that "a flag about nothing is not a flag". The review
   * form shipped a report id field marked optional, so the first raise from the
   * screen violated the CHECK and the person got the generic "something went
   * wrong" — a constraint doing its job at the cost of a sentence nobody can act
   * on. The rule belongs here, where it can say what to do instead.
   *
   * Not solved by defaulting the subject to the RAISER, which was the tempting
   * one-liner: it would file a concern whose named subject is the person who
   * reported it.
   */
  if ((input.reportId ?? null) === null && (input.subjectUserId ?? null) === null) {
    throw new ReviewError(
      'a manual flag needs a report or a person',
      'SUBJECT_REQUIRED',
      'FRAUD_FLAG_NEEDS_SUBJECT',
    );
  }

  const finding = manualFinding({
    note,
    severity: input.severity,
    reportId: input.reportId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    raisedBy: actorId(actor),
  });

  const r = await tx.query(
    `INSERT INTO fraud_flag (organization_id, rule_code, severity, message_code, data, evidence,
                             report_id, subject_user_id, finding_key)
     VALUES (${ORG}, $1, $2::fraud_severity, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      finding.ruleCode,
      finding.severity,
      finding.messageCode,
      JSON.stringify(finding.data),
      JSON.stringify(finding.evidence),
      finding.reportId,
      finding.subjectUserId,
      finding.findingKey,
    ],
  );
  const id = r.rows[0].id as string;

  await auditAppend(tx, actor, {
    action: 'FRAUD_FLAG_RAISED',
    entityType: finding.reportId === null ? 'fraud_flag' : 'expense_report',
    entityId: finding.reportId ?? id,
    details: { flagId: id, severity: finding.severity, note },
  });
  return id;
}

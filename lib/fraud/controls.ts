/**
 * VX4-8 part 3 — the six periodic compliance checks, ported from
 * `packages/fraud/src/controls.ts` at ExpenseOS `5a11a647`.
 *
 * ── A CONTROL EVALUATION IS NOT A FRAUD SCAN ────────────────────────────────
 *
 * It answers "are the controls operating?" rather than "does this transaction
 * look wrong?", and the difference is structural rather than a matter of degree:
 *
 * · A RUN IS A SNAPSHOT, NOT A QUEUE. Findings are written once, belong to their
 *   run, and are never revised. There is no review workflow — you do not dismiss
 *   a control deficiency, you fix it and the next run stops reporting it. That is
 *   why these rows live in `control_finding` and not in `fraud_flag`, which has a
 *   status, a reviewer and a dedupe key precisely because a fraud flag IS queue
 *   work.
 * · SEVERITY IS ABOUT THE CONTROL, NOT THE MONEY. CRITICAL means it would be a
 *   finding in an audit; WARNING means it is drifting; INFO means configuration
 *   is incomplete but nothing is mis-stated yet.
 * · THE SUBJECT IS WHATEVER SOMEBODY CAN FIX. The GL-mapping check reports the
 *   CATEGORY, not every report that used it — one finding a person can act on
 *   instead of forty that all want the same edit.
 *
 * ── TWO OF UPSTREAM'S EIGHT DO NOT APPLY ────────────────────────────────────
 *
 * `TRAVEL_WITHOUT_APPROVAL` (ETB-01) and `TRAVEL_BUDGET_OVERRUN` (ETB-02) belong
 * to the travel module, which this product declares and does not implement
 * (`lib/modules/registry.ts`). Omitted rather than stubbed: a control that can
 * only ever return zero findings is a control that reads as passing.
 *
 * ── WHAT THE PORT CHANGED, AND WHY ──────────────────────────────────────────
 *
 * **The return-note check reads a COLUMN here, not the audit log.** Upstream's
 * comment calls it "the one control whose evidence is the audit trail itself",
 * because their return handler puts the note in `Audit.details.note` and nowhere
 * else. Ours has `expense_report_event.note` — a real column on the transition
 * row (0007) — so the check is a plain read and the finding does not depend on
 * the shape of a jsonb blob.
 *
 * **The FX check has no AP-override clause.** Theirs excludes reports carrying
 * `fxRateOverride` for the offending currency. No such column exists here, and
 * inventing one to make the port symmetrical would be building a feature inside
 * a compliance check. The rate lookup keeps their both-directions test, which
 * their own comment says was a real defect: matching only expense-to-report kept
 * reporting CRITICAL on reports that converted perfectly well.
 *
 * **Money comes from line items.** Same structural difference part 2 documents:
 * an expense has no amount of its own.
 *
 * **No sentence is built here.** `message_code` + `data`; see
 * `lib/i18n/catalog/control-messages.ts`.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { ControlMessageCode } from '@/lib/i18n/catalog/control-messages';
import { ORG } from '@/lib/tenant/sql';

export const CONTROLS = {
  staleDraft: 'STALE_DRAFT',
  submittedNoAction: 'SUBMITTED_NO_ACTION',
  returnWithoutNote: 'RETURN_WITHOUT_NOTE',
  approvedWithoutReceipt: 'APPROVED_WITHOUT_RECEIPT',
  fxRateMissing: 'FX_RATE_MISSING',
  glMappingGap: 'GL_MAPPING_GAP',
} as const;

export const CONTROL_CODES = [
  CONTROLS.staleDraft,
  CONTROLS.submittedNoAction,
  CONTROLS.returnWithoutNote,
  CONTROLS.approvedWithoutReceipt,
  CONTROLS.fxRateMissing,
  CONTROLS.glMappingGap,
] as const;

export type ControlCode = (typeof CONTROL_CODES)[number];

export const CONTROL_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type ControlSeverity = (typeof CONTROL_SEVERITIES)[number];

/** What the finding is ABOUT. Text, because the set is not the report table. */
export type SubjectType = 'expense_report' | 'expense_category';

export interface ControlFinding {
  controlCode: ControlCode;
  severity: ControlSeverity;
  subjectType: SubjectType;
  /** A LOOSE reference — no FK. See migration 0032's header. */
  subjectId: string | null;
  /** The human handle AT RUN TIME: a report number, a category code. */
  subjectLabel: string | null;
  messageCode: ControlMessageCode;
  data: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/**
 * THE ONLY WAY A CONTROL FINDING IS BUILT — same device and, importantly, the
 * SAME NAME as `finding()` in `lib/fraud/rules.ts` and `lib/policy/rules.ts`.
 *
 * The name is load-bearing, which the first draft of this file found out the
 * useful way. It was named for the thing it builds, and `check:i18n` then refused
 * to run at all: "found no finding(RULE, CODE, …) calls in lib/fraud/controls.ts
 * — if findings are built another way now, update this scan; do not delete the
 * check." That is the gate behaving correctly in the way that matters most. Its
 * scan could not find what it polices, so it FAILED, rather than reporting an
 * empty emitted set and declaring all six sentences orphaned copy — which is the
 * shape part 2b's header criticises in upstream's locale gate, a gate that passes
 * when it cannot see.
 */
function finding(
  controlCode: ControlCode,
  messageCode: ControlMessageCode,
  parts: {
    severity: ControlSeverity;
    subjectType: SubjectType;
    subjectId: string | null;
    subjectLabel: string | null;
    data: Record<string, unknown>;
    evidence: Record<string, unknown>;
  },
): ControlFinding {
  return { controlCode, messageCode, ...parts };
}

/* ── configuration ─────────────────────────────────────────────────────────── */

export interface ControlConfig {
  /** A draft untouched this long is abandoned, not in progress. */
  staleDraftDays: number;
  /** A submitted report unactioned this long is an approval-timeliness failure. */
  submittedNoActionDays: number;
}

export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  staleDraftDays: 30,
  submittedNoActionDays: 14,
};

/**
 * Upstream's config also carries `travelOverrunPercent` and
 * `travelOverrunMinimumMinor`, both belonging to the two checks that do not apply
 * here. Left out rather than carried as dead keys — `resolveControlConfig`
 * ignores anything it does not know, so a tenant blob that has them is harmless.
 */
export function resolveControlConfig(overrides: unknown): ControlConfig {
  const o = (overrides ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  return {
    staleDraftDays: num(o.staleDraftDays, DEFAULT_CONTROL_CONFIG.staleDraftDays),
    submittedNoActionDays: num(
      o.submittedNoActionDays,
      DEFAULT_CONTROL_CONFIG.submittedNoActionDays,
    ),
  };
}

/** This tenant's configuration, from `organization.control_config` (0032). */
export async function loadControlConfig(tx: QueryRunner): Promise<ControlConfig> {
  const r = await tx.query(
    `SELECT control_config FROM organization
      WHERE id = ${ORG}`,
  );
  if (r.rowCount !== 1) throw new Error('no organization in scope');
  return resolveControlConfig(r.rows[0].control_config);
}

/** The window every control evaluates over. `end` is EXCLUSIVE. */
export interface Period {
  start: Date;
  end: Date;
}

/** The trailing 90 days, ending now. */
export function defaultPeriod(now = new Date()): Period {
  return { start: new Date(now.getTime() - 90 * 86_400_000), end: now };
}

/** Whole days between two instants, floored — how long something has waited. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

const ISO_DAY = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/* ── 1. Stale drafts ──────────────────────────────────────────────────────── */

/**
 * Drafts nobody has touched in `staleDraftDays`.
 *
 * The control this tests is COMPLETENESS OF THE PERIOD: expenses sitting in a
 * draft are real costs the company has incurred and not recorded. Measured on
 * `updated_at` rather than `created_at` — a report somebody is still working on
 * is not abandoned, however long ago it was started.
 */
export async function checkStaleDrafts(
  tx: QueryRunner,
  period: Period,
  cfg: ControlConfig,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.updated_at, rep.currency_code, c.minor_unit,
            coalesce(sum(li.amount_minor), 0) AS amount_minor
       FROM expense_report rep
       JOIN currency c ON c.code = rep.currency_code
       LEFT JOIN expense e ON e.report_id = rep.id
       LEFT JOIN expense_line_item li ON li.expense_id = e.id
      WHERE rep.status = 'DRAFT'
        AND rep.updated_at >= $1 AND rep.updated_at < $2
        AND rep.updated_at < $2::timestamptz - make_interval(days => $3::int)
      GROUP BY rep.id, rep.number, rep.updated_at, rep.currency_code, c.minor_unit
      ORDER BY rep.updated_at ASC`,
    [period.start, period.end, cfg.staleDraftDays],
  );
  return r.rows.map((row) =>
    finding(CONTROLS.staleDraft, 'STALE_DRAFT', {
      severity: 'WARNING',
      subjectType: 'expense_report',
      subjectId: row.id as string,
      subjectLabel: (row.number as string | null) ?? null,
      data: {
        lastTouched: ISO_DAY(row.updated_at as Date),
        thresholdDays: cfg.staleDraftDays,
        amountMinor: String(row.amount_minor),
        currencyCode: row.currency_code as string,
        minorUnit: Number(row.minor_unit),
      },
      evidence: {
        updatedAt: (row.updated_at as Date).toISOString(),
        daysStale: daysBetween(row.updated_at as Date, period.end),
        thresholdDays: cfg.staleDraftDays,
        totalMinor: String(row.amount_minor),
      },
    }),
  );
}

/* ── 2. Submitted with no action ──────────────────────────────────────────── */

/**
 * Reports submitted more than `submittedNoActionDays` ago and still SUBMITTED.
 *
 * An approval-TIMELINESS failure: the employee did their part and the control did
 * not operate. Distinct from VX2-6's escalation, which moves individual tasks —
 * this is the report-level outcome, which is what an auditor asks about.
 */
export async function checkSubmittedNoAction(
  tx: QueryRunner,
  period: Period,
  cfg: ControlConfig,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.submitted_at, rep.total_minor,
            rep.currency_code, c.minor_unit
       FROM expense_report rep
       JOIN currency c ON c.code = rep.currency_code
      WHERE rep.status = 'SUBMITTED'
        AND rep.submitted_at >= $1 AND rep.submitted_at < $2
        AND rep.submitted_at < $2::timestamptz - make_interval(days => $3::int)
      ORDER BY rep.submitted_at ASC`,
    [period.start, period.end, cfg.submittedNoActionDays],
  );
  return r.rows.map((row) => {
    const days = daysBetween(row.submitted_at as Date, period.end);
    return finding(CONTROLS.submittedNoAction, 'SUBMITTED_NO_ACTION', {
      // Past DOUBLE the threshold it stops being a delay and starts being a
      // control that is not operating at all. Upstream's split, kept.
      severity: days >= cfg.submittedNoActionDays * 2 ? 'CRITICAL' : 'WARNING',
      subjectType: 'expense_report',
      subjectId: row.id as string,
      subjectLabel: (row.number as string | null) ?? null,
      data: {
        daysWaiting: days,
        thresholdDays: cfg.submittedNoActionDays,
        amountMinor: String(row.total_minor),
        currencyCode: row.currency_code as string,
        minorUnit: Number(row.minor_unit),
      },
      evidence: {
        submittedAt: (row.submitted_at as Date).toISOString(),
        daysWaiting: days,
        thresholdDays: cfg.submittedNoActionDays,
        totalMinor: String(row.total_minor),
      },
    });
  });
}

/* ── 3. Returns without an explanation ────────────────────────────────────── */

/**
 * Reports returned for edits with no note recorded.
 *
 * A return with no explanation leaves the submitter guessing and leaves no record
 * of why the company declined to record a cost — which is the reason a reviewer
 * must give one.
 *
 * READS `expense_report_event`, not the audit log. Upstream has to read theirs
 * because the note lives only in a jsonb blob on an audit row; 0007 gave us a
 * `note` column on the transition itself. The check is a column comparison
 * rather than three jsonb null-shapes, and it cannot be broken by a change to
 * what the audit details happen to carry.
 */
export async function checkReturnsWithoutNote(
  tx: QueryRunner,
  period: Period,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    // The column is `created_at`. The first draft of this file used the name
    // upstream's audit table has, and `tsc` had nothing to say about it — a column
    // name inside a template literal is a string. The suite failed with "column
    // ev.occurred_at does not exist", which is the argument for these six checks
    // being db tests rather than unit tests over a mocked runner.
    `SELECT ev.report_id, ev.created_at, rep.number,
            coalesce(u.display_name, u.email) AS actor_name
       FROM expense_report_event ev
       JOIN app_user u ON u.id = ev.actor_id
       LEFT JOIN expense_report rep ON rep.id = ev.report_id
      WHERE ev.action = 'RETURN'
        AND ev.created_at >= $1 AND ev.created_at < $2
        AND (ev.note IS NULL OR btrim(ev.note) = '')
      ORDER BY ev.created_at DESC`,
    [period.start, period.end],
  );
  return r.rows.map((row) =>
    finding(CONTROLS.returnWithoutNote, 'RETURN_WITHOUT_NOTE', {
      severity: 'WARNING',
      subjectType: 'expense_report',
      subjectId: row.report_id as string,
      // The report may have been deleted since; the label is what we knew then.
      subjectLabel: (row.number as string | null) ?? null,
      data: {
        returnedBy: row.actor_name as string,
        returnedOn: ISO_DAY(row.created_at as Date),
      },
      evidence: {
        returnedAt: (row.created_at as Date).toISOString(),
        returnedBy: row.actor_name,
      },
    }),
  );
}

/* ── 4. Approved without a receipt on file ────────────────────────────────── */

/**
 * Reports approved (or reimbursed) that still have entries with no receipt.
 *
 * ── THE SCOPE NOTE, PORTED BECAUSE IT IS AN HONEST ONE ──────────────────────
 *
 * The Module 12 use case asks for "approvals without recorded receipt-VIEW
 * acknowledgement". Upstream's comment says nothing in their model records that
 * an approver opened a receipt, so they implement approval with no receipt ON
 * FILE — "the stronger deficiency anyway" — and decline to fake the rest.
 *
 * WE ACTUALLY HAVE THE OTHER HALF: VX2-1's `require_receipt_view_ack` and
 * `approval_task.receipt_view_acknowledged_at`. It is deliberately NOT checked
 * here, because it is a per-rung SETTING: a tenant that has not turned it on has
 * no acknowledgement to be missing, and reporting every approval in that tenant
 * as a deficiency would be reporting a configuration choice as a failure. A
 * control over "the rung demanded an acknowledgement and none was recorded" is a
 * real seventh control and belongs to a ticket that can think about it.
 */
export async function checkApprovedWithoutReceipt(
  tx: QueryRunner,
  period: Period,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    `WITH entry AS (
       SELECT e.id, e.report_id,
              coalesce(sum(li.amount_minor), 0) AS amount_minor,
              count(rc.id) AS receipts
         FROM expense e
         LEFT JOIN expense_line_item li ON li.expense_id = e.id
         LEFT JOIN receipt rc ON rc.expense_id = e.id
        GROUP BY e.id, e.report_id
     )
     SELECT rep.id, rep.number, rep.approved_at, rep.currency_code, c.minor_unit,
            count(*)                                        AS entries,
            count(*) FILTER (WHERE entry.receipts = 0)       AS missing,
            coalesce(sum(entry.amount_minor) FILTER (WHERE entry.receipts = 0), 0)
                                                             AS unsupported_minor
       FROM expense_report rep
       JOIN currency c ON c.code = rep.currency_code
       JOIN entry ON entry.report_id = rep.id
      WHERE rep.status IN ('APPROVED', 'REIMBURSED')
        AND coalesce(rep.approved_at, rep.updated_at) >= $1
        AND coalesce(rep.approved_at, rep.updated_at) < $2
      GROUP BY rep.id, rep.number, rep.approved_at, rep.currency_code, c.minor_unit
     HAVING count(*) FILTER (WHERE entry.receipts = 0) > 0
      ORDER BY rep.id DESC`,
    [period.start, period.end],
  );
  return r.rows.map((row) =>
    finding(CONTROLS.approvedWithoutReceipt, 'APPROVED_WITHOUT_RECEIPT', {
      // An approval with no supporting document is the classic audit finding.
      severity: 'CRITICAL',
      subjectType: 'expense_report',
      subjectId: row.id as string,
      subjectLabel: (row.number as string | null) ?? null,
      data: {
        missing: Number(row.missing),
        entries: Number(row.entries),
        unsupportedMinor: String(row.unsupported_minor),
        currencyCode: row.currency_code as string,
        minorUnit: Number(row.minor_unit),
      },
      evidence: {
        missingReceipts: Number(row.missing),
        entries: Number(row.entries),
        unsupportedMinor: String(row.unsupported_minor),
        approvedAt: row.approved_at === null ? null : (row.approved_at as Date).toISOString(),
      },
    }),
  );
}

/* ── 5. Cross-currency with no rate to convert at ─────────────────────────── */

/**
 * Entries in a currency other than their report's, with no FX rate for the pair.
 *
 * Without a rate the reimbursement figure is either wrong or invented, so this is
 * a MEASUREMENT failure rather than a paperwork one. Only the ABSENCE of a rate
 * is reported — a stale rate is a different and much noisier conversation.
 *
 * BOTH DIRECTIONS, and that is upstream's hard-won detail rather than symmetry
 * for its own sake. Their comment: matching only expense-to-report "would keep
 * reporting CRITICAL on reports that now convert perfectly well: every seeded row
 * quotes X-to-CAD, so every USD report holding a CAD line would qualify, and the
 * compliance screen would contradict the total printed on the report itself."
 * `lib/policy/rules.ts` fills a missing direction with the reciprocal, exactly as
 * theirs does, so the same trap is live here.
 */
export async function checkFxRateMissing(
  tx: QueryRunner,
  period: Period,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.currency_code AS report_currency,
            e.currency_code AS expense_currency, ec.minor_unit,
            count(DISTINCT e.id)              AS entries,
            coalesce(sum(li.amount_minor), 0) AS amount_minor
       FROM expense_report rep
       JOIN expense e ON e.report_id = rep.id
       JOIN currency ec ON ec.code = e.currency_code
       LEFT JOIN expense_line_item li ON li.expense_id = e.id
      WHERE e.currency_code <> rep.currency_code
        AND rep.created_at >= $1 AND rep.created_at < $2
        AND NOT EXISTS (
          SELECT 1 FROM fx_rate f
           WHERE (f.base = e.currency_code AND f.quote = rep.currency_code)
              OR (f.base = rep.currency_code AND f.quote = e.currency_code)
        )
      GROUP BY rep.id, rep.number, rep.currency_code, e.currency_code, ec.minor_unit
      ORDER BY rep.id DESC`,
    [period.start, period.end],
  );
  return r.rows.map((row) =>
    finding(CONTROLS.fxRateMissing, 'FX_RATE_MISSING', {
      severity: 'CRITICAL',
      subjectType: 'expense_report',
      subjectId: row.id as string,
      subjectLabel: (row.number as string | null) ?? null,
      data: {
        entries: Number(row.entries),
        expenseCurrency: row.expense_currency as string,
        reportCurrency: row.report_currency as string,
        amountMinor: String(row.amount_minor),
        minorUnit: Number(row.minor_unit),
      },
      evidence: {
        reportCurrency: row.report_currency,
        expenseCurrency: row.expense_currency,
        entries: Number(row.entries),
        amountMinor: String(row.amount_minor),
      },
    }),
  );
}

/* ── 6. GL mapping coverage ───────────────────────────────────────────────── */

/**
 * Categories actually USED in the period whose `gl_account_id` is null.
 *
 * The subject is the CATEGORY, not the report: one unmapped category produces one
 * finding somebody can fix, instead of one per report that used it. INFO — nothing
 * is mis-stated yet, but none of it can be posted.
 *
 * This is UD-2 from the other side, and worth noting: UD-2 wants the same gap
 * caught at SUBMIT, in front of the person who can still recode the line. This
 * catches it retrospectively, for the person who owns the chart of accounts.
 * Neither replaces the other.
 */
export async function checkGlMappingGaps(
  tx: QueryRunner,
  period: Period,
): Promise<ControlFinding[]> {
  const r = await tx.query(
    `SELECT cat.id, cat.code, cat.label,
            count(li.id) AS line_items,
            array_agg(DISTINCT e.currency_code ORDER BY e.currency_code) AS currencies
       FROM expense_line_item li
       JOIN expense_category cat ON cat.id = li.category_id
       JOIN expense e ON e.id = li.expense_id
       JOIN expense_report rep ON rep.id = e.report_id
      WHERE rep.created_at >= $1 AND rep.created_at < $2
        AND cat.gl_account_id IS NULL
      GROUP BY cat.id, cat.code, cat.label
      ORDER BY count(li.id) DESC, cat.code`,
    [period.start, period.end],
  );
  return r.rows.map((row) =>
    finding(CONTROLS.glMappingGap, 'GL_MAPPING_GAP', {
      severity: 'INFO',
      subjectType: 'expense_category',
      subjectId: row.id as string,
      subjectLabel: (row.code as string | null) ?? null,
      data: {
        categoryCode: row.code as string,
        lineItems: Number(row.line_items),
      },
      evidence: {
        code: row.code,
        label: row.label,
        lineItems: Number(row.line_items),
        // THE CURRENCIES INVOLVED, NOT A TOTAL, and this is a correction to this
        // file's own first draft rather than a port decision.
        //
        // That draft summed `li.amount_minor` across the category and labelled the
        // result with the organization's policy currency. Line items inherit their
        // EXPENSE's currency, so a category used on a CAD report and a USD one
        // would have produced a single number that is neither — which is AN-7
        // exactly ("a missing FX rate is currently summed as if it were base
        // currency, unflagged"), reintroduced in the ticket after the one that
        // fixed it. Upstream sums it too and gets away with it only because their
        // sentence never quotes the figure.
        //
        // A per-currency breakdown was the other option. It is not worth it here:
        // this control's finding is "this category has no GL account", the count
        // is what says how much of the period it touched, and an unconvertible
        // total adds nothing a person can act on.
        currencies: (row.currencies as string[] | null) ?? [],
      },
    }),
  );
}

/** Every control, in the order a run executes them. */
export const CONTROL_CHECKS: ReadonlyArray<{
  code: ControlCode;
  run: (tx: QueryRunner, period: Period, cfg: ControlConfig) => Promise<ControlFinding[]>;
}> = [
  { code: CONTROLS.staleDraft, run: checkStaleDrafts },
  { code: CONTROLS.submittedNoAction, run: checkSubmittedNoAction },
  // The two that take no config still take the parameter, so `CONTROL_CHECKS`
  // has one signature and the runner has no special cases.
  { code: CONTROLS.returnWithoutNote, run: (tx, period) => checkReturnsWithoutNote(tx, period) },
  {
    code: CONTROLS.approvedWithoutReceipt,
    run: (tx, period) => checkApprovedWithoutReceipt(tx, period),
  },
  { code: CONTROLS.fxRateMissing, run: (tx, period) => checkFxRateMissing(tx, period) },
  { code: CONTROLS.glMappingGap, run: (tx, period) => checkGlMappingGaps(tx, period) },
];

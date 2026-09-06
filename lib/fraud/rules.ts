/**
 * VX4-8 part 2 — the four fraud detectors, ported from `packages/fraud/src/rules.ts`
 * at ExpenseOS `5a11a647`.
 *
 * ── THE FOUR CONSTRAINTS, KEPT ──────────────────────────────────────────────
 *
 * Upstream's header states four, and all four survive the port unchanged:
 *
 * 1. A RULE PRODUCES A FINDING, NEVER A VERDICT. Nothing here changes a report's
 *    state, blocks a payment, or tells an employee anything. A person resolves,
 *    dismisses or escalates every flag. Their sentence is the one to keep:
 *    "automated fraud accusations are how you get a wrongful-accusation problem
 *    instead of a fraud problem."
 * 2. EVERY FINDING CARRIES A STABLE KEY. The scan is retrospective and repeats;
 *    without an identity for "this exact finding" the queue fills with copies of
 *    the same pair every night and reviewers stop reading it.
 * 3. EVERY FINDING CARRIES ITS EVIDENCE. A reviewer should see the rule's
 *    arithmetic — the twin's date, the sigma multiple, the pair's counts — rather
 *    than be asked to trust a badge.
 * 4. THRESHOLDS ARE CONFIG; THE RULE SET IS A DEPLOYMENT. Tuning after a noisy
 *    week must not need a release. Adding a rule does.
 *
 * ── WHAT THE PORT HAD TO CHANGE, AND WHY ────────────────────────────────────
 *
 * **Their `Expense` carries `ownerId`, `amountMinor` and `date`. Ours carries
 * none of the first two.** In this schema an expense belongs to a report and the
 * report has the `submitter_id` (0003), and the MONEY is on `expense_line_item`
 * — an expense is one or more coded lines, because a split is the normal case.
 * So every rule that talks about "this person's expense of $X" is expressed here
 * over a per-expense TOTAL computed from its lines, joined back through the
 * report for the owner. Same rule, different arithmetic; the CTE at the top of
 * the first two detectors is that difference and nothing else.
 *
 * It also means an expense with NO lines has no amount. Those are real — VX1-5's
 * receipt-first flow creates one — and they are excluded rather than treated as
 * zero, which would make every receiptless entry a duplicate of every other.
 *
 * **`txn_date` is nullable here and their `date` is not.** An expense with no
 * date cannot be inside anybody's window, so the duplicate rule requires one.
 *
 * **Their `PolicyViolation` points at an expense; ours points at a LINE
 * (0006).** The density rule therefore counts distinct expenses reached through
 * their lines, plus report-scope violations, which is the same quantity their
 * `COUNT(DISTINCT v."expenseId")` was after.
 *
 * **Config is per tenant.** Theirs comes from a `systemFlag` row — a global
 * singleton, MT-2 — so one tenant's noisy week retunes everybody's scan.
 * `organization.fraud_config` (migration 0031) is the same values, per org.
 *
 * **No sentence is built here.** Upstream's detectors interpolate English into a
 * `reason` string that is then stored. This file emits a MESSAGE CODE and the
 * numbers behind it; `lib/i18n/catalog/fraud-messages.ts` turns the pair into a
 * sentence in the reader's locale, at read time. That file's header has the
 * argument.
 *
 * ── A PURE-ISH MODULE ───────────────────────────────────────────────────────
 *
 * Detectors take a `QueryRunner` and return findings; they never write. The scan
 * writes (`lib/fraud/scan.ts`). Same separation upstream has, and it is what lets
 * a test assert what a rule FOUND without reconciling anything.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { FraudMessageCode } from '@/lib/i18n/catalog/fraud-messages';
import { ORG } from '@/lib/tenant/sql';

export const FRAUD_RULES = {
  duplicate: 'DUPLICATE',
  amountOutlier: 'AMOUNT_OUTLIER',
  violationDensity: 'VIOLATION_DENSITY',
  approverConcentration: 'APPROVER_CONCENTRATION',
  /**
   * Not a rule — the code a flag raised by a PERSON carries. No detector emits
   * it and nothing writes it yet; the action that does arrives with the review
   * UI in part 3, along with its sentence. Declared here because it is part of
   * the column's vocabulary and `fraud_flag.rule_code` has no CHECK to learn it
   * from.
   */
  manual: 'MANUAL',
} as const;

export const FRAUD_RULE_CODES = [
  FRAUD_RULES.duplicate,
  FRAUD_RULES.amountOutlier,
  FRAUD_RULES.violationDensity,
  FRAUD_RULES.approverConcentration,
  FRAUD_RULES.manual,
] as const;

export type FraudRuleCode = (typeof FRAUD_RULE_CODES)[number];

export const FRAUD_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type FraudSeverity = (typeof FRAUD_SEVERITIES)[number];

/**
 * A finding, ready to be reconciled. Rules never write; `scan.ts` does.
 *
 * `messageCode` and `data` are what the reader eventually sees; `evidence` is
 * everything the rule saw. They overlap and are deliberately not merged — a
 * sentence that had to name every number would be unreadable, and evidence
 * trimmed to what the sentence needs would stop being evidence.
 */
export interface Finding {
  ruleCode: FraudRuleCode;
  severity: FraudSeverity;
  /** Stable identity of this finding across runs — the upsert key. */
  findingKey: string;
  messageCode: FraudMessageCode;
  data: Record<string, unknown>;
  evidence: Record<string, unknown>;
  reportId: string | null;
  expenseId: string | null;
  subjectUserId: string | null;
}

/**
 * THE ONLY WAY A FINDING IS BUILT.
 *
 * Same device as `finding()` in `lib/policy/rules.ts`, and the same reason: the
 * rule code, the message code and the key are three strings that have to agree,
 * and a constructor is the only place that agreement can be checked once instead
 * of at every emit site. It also makes `scripts/check-i18n.mjs` able to find
 * every message code this file can emit by scanning for one call shape.
 */
function finding(
  ruleCode: FraudRuleCode,
  messageCode: FraudMessageCode,
  parts: {
    severity: FraudSeverity;
    key: readonly (string | number)[];
    data: Record<string, unknown>;
    evidence: Record<string, unknown>;
    reportId?: string | null;
    expenseId?: string | null;
    subjectUserId?: string | null;
  },
): Finding {
  return {
    ruleCode,
    severity: parts.severity,
    // The rule code leads, so a key can never be mistaken for another rule's even
    // if two rules key on the same ids.
    findingKey: [ruleCode, ...parts.key].join(':'),
    messageCode,
    data: parts.data,
    evidence: parts.evidence,
    reportId: parts.reportId ?? null,
    expenseId: parts.expenseId ?? null,
    subjectUserId: parts.subjectUserId ?? null,
  };
}

/**
 * A flag raised by a PERSON, built here rather than where it is written.
 *
 * `lib/fraud/review.ts` is what inserts it, and putting the construction there
 * would have been the obvious placement. It is here because
 * `scripts/check-i18n.mjs` finds every fraud message code by scanning THIS FILE
 * for `finding(RULE, CODE, …)` — a code emitted from anywhere else is a code the
 * gate cannot see, and it would report `MANUAL_FLAG` as orphan copy. Part 2
 * discovered that constraint by tripping over it rather than by reasoning about
 * it, which is the better way round.
 *
 * The `findingKey` is the one in this file NOT derived from what was found: two
 * people can legitimately raise the same concern about the same report, and
 * neither should overwrite the other. So it carries the raiser and a timestamp,
 * and every manual flag is its own row by construction.
 */
export function manualFinding(input: {
  note: string;
  severity: FraudSeverity;
  reportId: string | null;
  subjectUserId: string | null;
  raisedBy: string;
}): Finding {
  return finding(FRAUD_RULES.manual, 'MANUAL_FLAG', {
    severity: input.severity,
    key: [input.raisedBy, new Date().toISOString()],
    // The person's sentence, and nothing else. `f.text` refuses a blank one.
    data: { note: input.note },
    evidence: { raisedBy: input.raisedBy, manual: true },
    reportId: input.reportId,
    subjectUserId: input.subjectUserId,
  });
}

/* ── configuration ─────────────────────────────────────────────────────────── */

export interface FraudConfig {
  /** How far back a scan looks. */
  lookbackDays: number;
  duplicate: {
    /** Two charges this many days apart still count as the same charge. */
    windowDays: number;
  };
  amountOutlier: {
    /** Standard deviations above the person's own mean before it is an outlier. */
    sigma: number;
    /** Below this many prior expenses, one person's σ is noise, not a baseline. */
    minSamples: number;
    /** Ignore small amounts however unusual — a $12 outlier is not a fraud risk. */
    minAmountMinor: number;
  };
  violationDensity: {
    /** Violated entries per entry at or above this ratio. */
    ratio: number;
    /** Ignore tiny reports: 1 violation on a 1-entry report is ratio 1.0. */
    minExpenses: number;
  };
  approverConcentration: {
    /** Approvals by the same pair in the window before it is a concern. */
    minApprovals: number;
    /**
     * Only flag when this share of the submitter's approvals went to one
     * approver. A busy manager approving many reports is normal; being the ONLY
     * person who ever approves one employee is the control gap.
     */
    concentration: number;
  };
}

export const DEFAULT_FRAUD_CONFIG: FraudConfig = {
  lookbackDays: 90,
  duplicate: { windowDays: 3 },
  // 3σ is the figure in the Module 12 use cases. 10 samples is the smallest
  // baseline where a standard deviation means anything at all.
  amountOutlier: { sigma: 3, minSamples: 10, minAmountMinor: 10_000 },
  violationDensity: { ratio: 0.5, minExpenses: 4 },
  approverConcentration: { minApprovals: 10, concentration: 1 },
};

/**
 * Merge a tenant's partial overrides over the defaults.
 *
 * EVERY field is validated and falls back on its own. A hand-edited
 * `fraud_config` with one nonsensical value degrades to the shipped default for
 * that value rather than throwing inside a nightly job — a scan that dies on a
 * bad number reports nothing, which looks exactly like a scan that found nothing.
 */
export function resolveFraudConfig(overrides: unknown): FraudConfig {
  const o = (overrides ?? {}) as Partial<Record<keyof FraudConfig, unknown>>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  const d = DEFAULT_FRAUD_CONFIG;
  const sub = (key: keyof FraudConfig) => (o[key] ?? {}) as Record<string, unknown>;
  return {
    lookbackDays: num(o.lookbackDays, d.lookbackDays),
    duplicate: { windowDays: num(sub('duplicate').windowDays, d.duplicate.windowDays) },
    amountOutlier: {
      sigma: num(sub('amountOutlier').sigma, d.amountOutlier.sigma),
      minSamples: num(sub('amountOutlier').minSamples, d.amountOutlier.minSamples),
      minAmountMinor: num(sub('amountOutlier').minAmountMinor, d.amountOutlier.minAmountMinor),
    },
    violationDensity: {
      ratio: num(sub('violationDensity').ratio, d.violationDensity.ratio),
      minExpenses: num(sub('violationDensity').minExpenses, d.violationDensity.minExpenses),
    },
    approverConcentration: {
      minApprovals: num(
        sub('approverConcentration').minApprovals,
        d.approverConcentration.minApprovals,
      ),
      concentration: num(
        sub('approverConcentration').concentration,
        d.approverConcentration.concentration,
      ),
    },
  };
}

/** This tenant's configuration, from `organization.fraud_config` (0031). */
export async function loadFraudConfig(tx: QueryRunner): Promise<FraudConfig> {
  const r = await tx.query(
    `SELECT fraud_config FROM organization
      WHERE id = ${ORG}`,
  );
  if (r.rowCount !== 1) throw new Error('no organization in scope');
  return resolveFraudConfig(r.rows[0].fraud_config);
}

/**
 * The per-expense total, its owner, its date and its currency — the shape
 * upstream's `Expense` row already had and ours has to compute.
 *
 * Reused by the first two detectors, as a SQL fragment rather than a temp table:
 * both need it bounded to the same lookback and neither wants the other's
 * filters. `minor_unit` rides along because every sentence that names money
 * needs it (`f.money(amount, currency, unit)`), and joining `currency` once here
 * is cheaper than a second pass.
 */
const EXPENSE_TOTALS = `
  SELECT e.id,
         e.report_id,
         r.submitter_id      AS owner_id,
         e.merchant,
         e.txn_date,
         e.currency_code,
         c.minor_unit,
         SUM(li.amount_minor) AS amount_minor
    FROM expense e
    JOIN expense_report r ON r.id = e.report_id
    JOIN expense_line_item li ON li.expense_id = e.id
    JOIN currency c ON c.code = e.currency_code
   WHERE e.txn_date >= $1
   GROUP BY e.id, e.report_id, r.submitter_id, e.merchant, e.txn_date, e.currency_code, c.minor_unit`;

function sinceDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/* ── Rule 1: duplicate charge ──────────────────────────────────────────────── */

/**
 * Same owner, same merchant, same amount and currency, dates within
 * `windowDays` — the classic double submission, whether by accident (two
 * receipts for one dinner) or not.
 *
 * The LATER expense is flagged: the earlier one is presumed the original, so a
 * reviewer looking at the flag is looking at the copy.
 *
 * Merchant is compared case-insensitively and must be present. Two receiptless
 * entries with a null merchant and the same amount are not evidence of anything.
 *
 * ── ONE FINDING PER EXPENSE, AGAINST ITS NEAREST EARLIER TWIN ───────────────
 *
 * Ported along with the reason, because the reason is a measurement upstream
 * paid for: a pair-wise join emits a finding for every pair, which is quadratic
 * in the size of a cluster. "300 same-amount charges from one person produced
 * 14,850 findings", enough to take their nightly job from milliseconds to
 * minutes. It is also the wrong answer for a reviewer — constraint 2 above is
 * that a flood of near-identical findings is how the queue stops being read, and
 * N mirror-image pairs say nothing the closest pair does not. Each later copy
 * still flags against its own predecessor, so a chain stays visible one link at
 * a time.
 *
 * `partnerSince` is their other optimisation and is kept for the same reason: the
 * correlated bound on `o` cannot be pushed down by the planner, so the partner
 * side gets the same absolute floor shifted back by the window. It narrows
 * nothing — a partner earlier than that cannot be within `windowDays` of any `e`
 * at or after `since`.
 */
export async function detectDuplicates(
  tx: QueryRunner,
  cfg: FraudConfig,
): Promise<Finding[]> {
  const since = sinceDate(cfg.lookbackDays);
  const partnerSince = sinceDate(cfg.lookbackDays + cfg.duplicate.windowDays);
  const r = await tx.query(
    `WITH totals AS (${EXPENSE_TOTALS}),
     partners AS (${EXPENSE_TOTALS.replace('$1', '$2')})
     SELECT DISTINCT ON (e.id)
            e.id, e.report_id, e.owner_id, e.merchant, e.txn_date,
            e.currency_code, e.minor_unit, e.amount_minor,
            o.id AS other_id, o.report_id AS other_report_id, o.txn_date AS other_date,
            orep.number AS other_report_number
       FROM totals e
       JOIN partners o
         ON o.owner_id = e.owner_id
        AND o.currency_code = e.currency_code
        AND o.amount_minor = e.amount_minor
        AND lower(o.merchant) = lower(e.merchant)
        -- Strictly earlier, so a pair yields ONE finding (on the later row)
        -- rather than two mirror images.
        AND (o.txn_date < e.txn_date OR (o.txn_date = e.txn_date AND o.id < e.id))
        AND o.txn_date >= e.txn_date - make_interval(days => $3::int)
        AND o.merchant IS NOT NULL AND btrim(o.merchant) <> ''
       JOIN expense_report orep ON orep.id = o.report_id
      WHERE e.merchant IS NOT NULL AND btrim(e.merchant) <> ''
      -- The expense id leads because DISTINCT ON requires it; the rest picks the twin.
      ORDER BY e.id DESC, o.txn_date DESC, o.id DESC`,
    [since, partnerSince, cfg.duplicate.windowDays],
  );

  return r.rows.map((row) => {
    const sameReport = row.report_id === row.other_report_id;
    const shared = {
      merchant: row.merchant as string,
      amountMinor: String(row.amount_minor),
      currencyCode: row.currency_code as string,
      minorUnit: Number(row.minor_unit),
      otherDate: String(row.other_date instanceof Date
        ? row.other_date.toISOString().slice(0, 10)
        : row.other_date),
      windowDays: cfg.duplicate.windowDays,
    };
    return finding(
      FRAUD_RULES.duplicate,
      // ONE RULE, TWO SENTENCES — see the note in fraud-messages.ts. The reviewer
      // does something different in each case, which is the test for whether a
      // second code earns its place.
      sameReport ? 'DUPLICATE_SAME_REPORT' : 'DUPLICATE_OTHER_REPORT',
      {
        // Same report is usually a genuine mistake; across reports is the pattern
        // worth a closer look, so it carries more weight. Upstream's split, kept.
        severity: sameReport ? 'MEDIUM' : 'HIGH',
        key: [row.id as string, row.other_id as string],
        data: sameReport
          ? shared
          : { ...shared, otherReportNumber: (row.other_report_number as string | null) ?? '—' },
        evidence: {
          ...shared,
          date: String(row.txn_date instanceof Date
            ? row.txn_date.toISOString().slice(0, 10)
            : row.txn_date),
          duplicateOfExpenseId: row.other_id,
          duplicateOfReportId: row.other_report_id,
          sameReport,
        },
        reportId: row.report_id as string,
        expenseId: row.id as string,
        subjectUserId: row.owner_id as string,
      },
    );
  });
}

/* ── Rule 2: amount outlier ────────────────────────────────────────────────── */

/**
 * An expense at or above `sigma` standard deviations over that person's own mean.
 *
 * Per person and per currency on purpose: a company-wide mean says nothing about
 * whether $4,000 is unusual FOR THIS EMPLOYEE, and mixing CAD with JPY makes both
 * meaningless. `stddev_pop`, not `_samp`, because this describes the population
 * of their own history rather than inferring from a sample of it.
 */
export async function detectAmountOutliers(
  tx: QueryRunner,
  cfg: FraudConfig,
): Promise<Finding[]> {
  const since = sinceDate(cfg.lookbackDays);
  const r = await tx.query(
    `WITH totals AS (${EXPENSE_TOTALS}),
     baseline AS (
       SELECT owner_id, currency_code,
              avg(amount_minor)::float8        AS mean,
              stddev_pop(amount_minor)::float8 AS sd,
              count(*)                         AS samples
         FROM totals
        GROUP BY owner_id, currency_code
       HAVING count(*) >= $2::int
          -- A zero σ means every expense is identical; nothing can be an outlier.
          AND stddev_pop(amount_minor) > 0
     )
     SELECT e.id, e.report_id, e.owner_id, e.merchant, e.amount_minor,
            e.currency_code, e.minor_unit, b.mean, b.sd, b.samples
       FROM totals e
       JOIN baseline b ON b.owner_id = e.owner_id AND b.currency_code = e.currency_code
      WHERE e.amount_minor >= $3::bigint
        AND e.amount_minor::float8 >= b.mean + ($4::float8 * b.sd)
      ORDER BY e.id DESC`,
    [since, cfg.amountOutlier.minSamples, cfg.amountOutlier.minAmountMinor, cfg.amountOutlier.sigma],
  );

  return r.rows.map((row) => {
    const sigmas = (Number(row.amount_minor) - Number(row.mean)) / Number(row.sd);
    return finding(FRAUD_RULES.amountOutlier, 'AMOUNT_OUTLIER', {
      severity: sigmas >= cfg.amountOutlier.sigma * 2 ? 'HIGH' : 'MEDIUM',
      key: [row.id as string],
      data: {
        amountMinor: String(row.amount_minor),
        currencyCode: row.currency_code as string,
        minorUnit: Number(row.minor_unit),
        // ROUNDED to an integer of minor units, because `f.money` formats minor
        // units and a mean of 4133.7 cents is not a thing a currency has.
        meanMinor: String(Math.round(Number(row.mean))),
        sigmas: Number(sigmas.toFixed(2)),
        samples: Number(row.samples),
        lookbackDays: cfg.lookbackDays,
      },
      evidence: {
        merchant: row.merchant,
        amountMinor: String(row.amount_minor),
        meanMinor: Math.round(Number(row.mean)),
        stdDevMinor: Math.round(Number(row.sd)),
        sigmas: Number(sigmas.toFixed(2)),
        threshold: cfg.amountOutlier.sigma,
        samples: Number(row.samples),
        lookbackDays: cfg.lookbackDays,
      },
      reportId: row.report_id as string,
      expenseId: row.id as string,
      subjectUserId: row.owner_id as string,
    });
  });
}

/* ── Rule 3: policy-violation density ──────────────────────────────────────── */

/**
 * A report where violated entries outnumber `ratio × entries`.
 *
 * One violation is a mistake; a report that trips policy on half its entries is
 * either somebody who has not read the policy or somebody testing where the line
 * is. `minExpenses` keeps a 1-entry report with 1 violation (ratio 1.0) out of
 * the queue.
 *
 * Counts distinct VIOLATED ENTRIES rather than raw violation rows, so a single
 * entry breaking four rules does not manufacture density on its own — and that
 * distinction is why `violations` is carried in the evidence separately.
 *
 * OUR VIOLATIONS POINT AT A LINE, not an expense (0006), so the join walks
 * `policy_violation → expense_line_item → expense`. A violation with a NULL
 * `line_item_id` is report-scope (a budget overage, say) and belongs to no entry;
 * it counts toward `violations` and not toward `violatedExpenses`, which is the
 * same treatment their expense-scope filter gave it.
 */
export async function detectViolationDensity(
  tx: QueryRunner,
  cfg: FraudConfig,
): Promise<Finding[]> {
  const since = sinceDate(cfg.lookbackDays);
  const r = await tx.query(
    `SELECT rep.id AS report_id, rep.submitter_id, rep.number,
            count(DISTINCT e.id)                                  AS expenses,
            count(DISTINCT vli.expense_id)                        AS violated,
            count(DISTINCT v.id)                                  AS violations
       FROM expense_report rep
       JOIN expense e ON e.report_id = rep.id
       LEFT JOIN policy_violation v
              ON v.report_id = rep.id
             AND v.resolved_at IS NULL
       LEFT JOIN expense_line_item vli ON vli.id = v.line_item_id
      WHERE rep.created_at >= $1::date
      GROUP BY rep.id, rep.submitter_id, rep.number
     HAVING count(DISTINCT e.id) >= $2::int
        AND count(DISTINCT vli.expense_id)::float8
              >= $3::float8 * count(DISTINCT e.id)::float8
      ORDER BY rep.id DESC`,
    [since, cfg.violationDensity.minExpenses, cfg.violationDensity.ratio],
  );

  return r.rows.map((row) => {
    const expenses = Number(row.expenses);
    const violated = Number(row.violated);
    const ratio = violated / expenses;
    return finding(FRAUD_RULES.violationDensity, 'VIOLATION_DENSITY', {
      severity: ratio >= 0.8 ? 'HIGH' : 'MEDIUM',
      key: [row.report_id as string],
      data: {
        violatedExpenses: violated,
        expenses,
        violations: Number(row.violations),
      },
      evidence: {
        reportNumber: row.number,
        expenses,
        violatedExpenses: violated,
        violations: Number(row.violations),
        ratio: Number(ratio.toFixed(2)),
        threshold: cfg.violationDensity.ratio,
      },
      reportId: row.report_id as string,
      subjectUserId: row.submitter_id as string,
    });
  });
}

/* ── Rule 4: segregation of duties ─────────────────────────────────────────── */

/**
 * One approver deciding effectively all of one submitter's reports.
 *
 * The control this protects is "more than one person sees the money". A manager
 * approving many reports is normal; being the ONLY person who ever approves a
 * particular employee's reports means a collusive pair would never be caught by
 * the workflow itself. Hence `concentration` — volume alone is not the signal.
 *
 * ── KEYED PER CALENDAR MONTH ────────────────────────────────────────────────
 *
 * Ported with its reason: a dismissed finding must not suppress the same concern
 * forever, and a still-live concern should re-surface on a predictable cadence
 * rather than on the day the count happens to tick over. It is the one key here
 * that is not made only of record ids, and the one place upstream's global
 * `dedupeKey` uniqueness would have been genuinely risky — which is why ours is
 * `UNIQUE (organization_id, finding_key)` (0031).
 *
 * EXTERNAL APPROVERS ARE EXCLUDED, and that is a difference from upstream worth
 * stating. VX2-1 admits an `EMAIL` approver with no `app_user` row, so
 * `decided_by_id` is nullable here and theirs is not. A concentration finding
 * naming somebody with no record in this organization is not actionable, and
 * `subject_user_id` could not point at them anyway.
 */
export async function detectApproverConcentration(
  tx: QueryRunner,
  cfg: FraudConfig,
): Promise<Finding[]> {
  const since = sinceDate(cfg.lookbackDays);
  const r = await tx.query(
    `WITH decisions AS (
       SELECT req.report_id, rep.submitter_id, t.decided_by_id
         FROM approval_task t
         JOIN approval_request req ON req.id = t.request_id
         JOIN expense_report rep   ON rep.id = req.report_id
        WHERE t.status = 'APPROVED'
          AND t.decided_by_id IS NOT NULL
          AND t.decided_at >= $1::date
          -- Self-approval is a different (worse) finding and the engine prevents
          -- it; excluded here so it cannot masquerade as a concentrated pair.
          AND t.decided_by_id <> rep.submitter_id
     ),
     pairs AS (
       SELECT submitter_id, decided_by_id,
              count(*) AS pair_approvals,
              (array_agg(report_id ORDER BY report_id DESC))[1] AS last_report_id
         FROM decisions GROUP BY submitter_id, decided_by_id
     ),
     totals AS (
       SELECT submitter_id, count(*) AS total_approvals
         FROM decisions GROUP BY submitter_id
     )
     SELECT p.submitter_id, p.decided_by_id, p.pair_approvals, p.last_report_id,
            t.total_approvals,
            coalesce(su.display_name, su.email) AS submitter_name,
            coalesce(du.display_name, du.email) AS approver_name
       FROM pairs p
       JOIN totals t ON t.submitter_id = p.submitter_id
       JOIN app_user su ON su.id = p.submitter_id
       JOIN app_user du ON du.id = p.decided_by_id
      WHERE p.pair_approvals >= $2::int
        AND p.pair_approvals::float8 >= $3::float8 * t.total_approvals::float8
      ORDER BY p.pair_approvals DESC`,
    [since, cfg.approverConcentration.minApprovals, cfg.approverConcentration.concentration],
  );

  // The month the scan runs in, not the month the approvals fell in — the key's
  // job is to re-raise a live concern periodically, not to describe a period.
  const period = new Date().toISOString().slice(0, 7);
  return r.rows.map((row) =>
    finding(FRAUD_RULES.approverConcentration, 'APPROVER_CONCENTRATION', {
      // LOW: this is a control observation, not an accusation. Upstream's choice
      // and the right one — the pair may be a two-person department.
      severity: 'LOW',
      key: [row.submitter_id as string, row.decided_by_id as string, period],
      data: {
        approverName: row.approver_name as string,
        submitterName: row.submitter_name as string,
        pairApprovals: Number(row.pair_approvals),
        totalApprovals: Number(row.total_approvals),
        lookbackDays: cfg.lookbackDays,
      },
      evidence: {
        approverId: row.decided_by_id,
        pairApprovals: Number(row.pair_approvals),
        totalApprovals: Number(row.total_approvals),
        concentration: Number(
          (Number(row.pair_approvals) / Number(row.total_approvals)).toFixed(2),
        ),
        threshold: cfg.approverConcentration.concentration,
        lookbackDays: cfg.lookbackDays,
        period,
      },
      reportId: row.last_report_id as string,
      subjectUserId: row.submitter_id as string,
    }),
  );
}

/** Every detector, in the order the scan runs them. */
export const DETECTORS: ReadonlyArray<{
  code: FraudRuleCode;
  run: (tx: QueryRunner, cfg: FraudConfig) => Promise<Finding[]>;
}> = [
  { code: FRAUD_RULES.duplicate, run: detectDuplicates },
  { code: FRAUD_RULES.amountOutlier, run: detectAmountOutliers },
  { code: FRAUD_RULES.violationDensity, run: detectViolationDensity },
  { code: FRAUD_RULES.approverConcentration, run: detectApproverConcentration },
];

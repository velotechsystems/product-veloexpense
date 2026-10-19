// Ported from ExpenseOS `apps/web/src/server/policy/types.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". The travel shapes were left out at w4-02a and restored by w6-01.
/**
 * Shared shapes for the policy engine.
 *
 * The engine is a pure(-ish) function that takes a fully-hydrated
 * report (line items + categories + currencies + receipts + the
 * submitter) plus the loaded reference data (policies, FX rates,
 * system flags) and returns a flat list of `Violation` rows. The
 * orchestrator persists those into the `PolicyViolation` table —
 * wholesale replace on each call — and returns the same list to
 * the caller for inline UI rendering.
 *
 * Severity matches the Prisma enum literal strings so a violation
 * row can flow straight from the engine to the table without
 * conversion.
 */

import type { PolicyViolationSeverity } from '@expenseos/db';

export type Severity = PolicyViolationSeverity; // 'INFO' | 'WARNING' | 'BLOCK'

/** One rule firing on one report (or one specific line item). */
export interface Violation {
  /** Stable identifier from the rule registry. Used for analytics
   *  rollups and for the per-rule deduplication in the engine —
   *  duplicate `(reportId, ruleCode, lineItemId)` triples are
   *  collapsed to the first occurrence. */
  ruleCode: string;
  severity: Severity;
  /**
   * The message KEY, resolved against `expenses.policy.labels.*` when it is rendered.
   *
   * Not pre-localized, despite what this field used to claim. A violation is read by the
   * submitter AND by approvers who need not share a language, so a sentence fixed in one locale
   * when the rule fired is wrong for half its audience — and money formatting is locale-dependent
   * for the same reason. The FE interpolates from `data` in the READER's locale.
   */
  message: string;
  /**
   * The subject's LINE anchor, or null for a subject-wide rule (fiscal-close,
   * currency mismatch across the whole report, a travel total overrun).
   *
   * Which table it names depends on which subject was validated: an
   * `ExpenseLineItem` id on a report, a `TravelBudgetLine` id on a travel request.
   * The engine does not need to know the difference — it uses this only as the
   * grouping key for its two collapse passes — so the persistence layer is where
   * the id is written into the right column (`lineItemId` vs `travelLineId`), and
   * the CHECK constraint is what stops a wrong guess from being storable.
   */
  lineItemId: string | null;
  /** Optional structured payload — surfaced to the FE so it can
   *  render the numbers (limit, actual, etc.) without re-deriving. */
  data?: Record<string, unknown>;
  /**
   * The rule KIND that fired, carried only between the engine's two collapse passes.
   *
   * Not persisted and not sent anywhere: `keepMostSevere` needs to tell two instances of one kind
   * (a warn threshold and a block threshold) apart from two unrelated kinds landing on the same
   * line, and `ruleCode` holds the instance id, which cannot answer that.
   */
  kindCode?: string;
}

/** Translator function used by every rule to render its message
 *  in the submitter's locale. The host wires this at the engine
 *  boundary from `next-intl` so the engine itself stays pure. */
export type RuleTranslator = (key: string, values?: Record<string, string | number>) => string;

// ── v2: data-driven rule instances ───────────────────────────────────

import type { PerDiemRateRow, PerDiemTier } from '@expenseos/approvals';
import type { ExpensePolicy, RuleScope as DbRuleScope } from '@expenseos/db';
import type { TravelLineKindName } from '@expenseos/travel-lines';

/**
 * VeloExpense (w6-01): ExpenseOS imports `RuleScope`, `TravelLineKind` and `TravelPriceBasis`
 * from its Prisma enums. VeloExpense's are text under CHECKs (0064, 0077), so they are typed
 * here: the scope is @expenseos/db's three plus TRAVEL_REQUEST (allowed by 0077's CHECK), the
 * line kind is @expenseos/travel-lines' own list, and the basis is 0077's CHECK list.
 */
export type RuleScope = DbRuleScope | 'TRAVEL_REQUEST';
export type TravelLineKind = TravelLineKindName;
export type TravelPriceBasis = 'QUOTE' | 'POLICY_CAP' | 'PER_DIEM' | 'MANUAL';

/**
 * A budget-month this report pushes past a threshold.
 *
 * VeloExpense (w4-02a): ExpenseOS's `BudgetImpact` (`packages/approvals/src/budgets.ts`),
 * copied as a type. VeloExpense's producer is ./budgetBridge (d66), read by validate and,
 * through `evaluateReportAgainstBudgets`, by the approval engine (w4-04). `BUDGET_OVERAGE`
 * reads `budgetImpacts: null` as "nothing over budget", as it does in ExpenseOS when the
 * finance-reporting module is off.
 */
export interface BudgetImpact {
  budgetId: string;
  glAccountId: string;
  monthIndex: number;
  amountMinor: bigint;
  usedMinor: bigint;
  crossedBp: number | null;
  currencyCode: string;
}

/** The report shape the engine + built-in kinds consume — line items flattened
 *  with their parent expense's facts (date/merchant/currency/receipts) carried
 *  down onto each line. Built by the tRPC loader (validate.ts). */
export interface HydratedReport {
  id: string;
  submittedAt: Date | null;
  submitter: {
    id: string;
    homeCurrency: string | null;
    localePref: string;
    /** Tier, for rules that exempt seniority (see REQUIRES_APPROVED_TRAVEL). */
    jobLevelId: string | null;
  };
  /**
   * Whether this report was built from a travel request that is APPROVED.
   *
   * A linked request that is still pending is deliberately `false`: the point of
   * pre-approval is that the approval happened BEFORE the spend, and "I filed a
   * request this morning" is not that.
   */
  travelApproved: boolean;
  lineItems: Array<{
    id: string;
    date: Date;
    amountMinor: bigint;
    merchant: string | null;
    category: {
      id: string;
      code: string;
      /** A distance-based category (mileage). Its evidence is the measured route,
       *  not a document — see the receipt rules, which skip these. */
      isMileage: boolean;
      /** Meal / entertainment categories, where "who was there" is part of the
       *  record. AUDIT_THRESHOLD only demands attendees on these — a $2,000
       *  flight has no attendees to name, and asking for them would produce a
       *  violation nobody can satisfy. */
      requiresAttendees: boolean;
      /** VeloExpense (w4-02d, d70): false once an admin has deactivated the category —
       *  what `CATEGORY_ACTIVE` (server/policy/veloexpenseKinds.ts) refuses. Absent reads as
       *  active, as ExpenseOS's lines always are. */
      active?: boolean;
    };
    currency: { code: string };
    receipts: Array<{ id: string }>;
    /** Distance on a mileage-category line, as a decimal string (Prisma
     *  Decimal). Null on every ordinary line — MILEAGE_MAX skips those. */
    mileageKm: string | null;
    /**
     * The voluntary tip inside `amountMinor`, or 0n on a line that carries none.
     *
     * Resolved from the line's kind + payload by `tipMinorOf` at load time rather
     * than exposing the raw payload: a rule reading an untyped Json blob is how the
     * shape of that blob becomes load-bearing in six places at once. It is INSIDE
     * `amountMinor`, not additional to it — the pre-tip base is the difference.
     */
    tipMinor: bigint;
    /**
     * The parent expense's business purpose, trimmed; null when blank.
     *
     * Deliberately NOT `explanation`. Explanation justifies a warning after the
     * fact ("why this charge is fine"); purpose states why the spend happened at
     * all. Accepting either would let somebody satisfy an audit requirement with
     * a warning justification.
     */
    purpose: string | null;
    /** Attendees recorded on the parent expense. */
    attendeeCount: number;
  }>;
}

/** An admin-authored `PolicyRule` row as the runner consumes it. `condition`
 *  (Predicate AST) and `params` are validated at write time by the kind. */
export interface PolicyRuleInstance {
  id: string;
  kindCode: string;
  scope: RuleScope;
  severity: Severity;
  condition: unknown | null;
  params: unknown;
  messageKey: string;
  /** LINE-scope rules may narrow to one category (null = all). */
  categoryId: string | null;
}

/** Per-diem inputs for the aggregate per-diem kind — the same data the
 *  approval engine hydrates, reused so submit/approval math can't drift. */
export interface PerDiemInputs {
  expenses: ReadonlyArray<{
    date: Date;
    placeText: string | null;
    lineItems: ReadonlyArray<{ amountMinor: bigint; categoryId: string }>;
  }>;
  reportCurrencyCode: string;
  rates: readonly PerDiemRateRow[];
  tier: PerDiemTier;
  rateCurrencyCodeById: Map<string, string>;
}

/** Context passed to AGGREGATE rule kinds (grouping/pairwise/temporal math).
 *  Carries the full hydrated report + reference data so built-in kinds (the
 *  migrated per-transaction / running-limit / receipt / duplicate / etc. rules)
 *  can read per-category policies, FX rates, and the fiscal-close date. */
export interface AggregateContext {
  report: HydratedReport;
  policiesByCategoryId: Map<string, ExpensePolicy>;
  policyCurrency: string;
  fxRates: Map<string, string>;
  fiscalCloseDate: Date | null;
  perDiemEnabled: boolean;
  perDiem: PerDiemInputs | null;
  /** Budgets this report pushes past a threshold. Null when the
   *  finance-reporting module is off or no budget is configured — the same
   *  "stated, not omitted" convention `perDiem` uses. */
  budgetImpacts: readonly BudgetImpact[] | null;
  /** What the linked APPROVED travel request budgeted, per expense category. Null when
   *  there is no such request, or no TRAVEL_OVERRUN instance asked for it. */
  travelBudget: TravelBudgetByCategory | null;
  t: RuleTranslator;
}

// ── Travel requests ──────────────────────────────────────────────────

/**
 * Everything a TRAVEL_REQUEST-scope kind may read.
 *
 * Deliberately NOT `HydratedReport` with some fields blanked, and deliberately narrow.
 * A travel estimate is a different document: its lines carry flight payloads instead of
 * receipts and merchants, nothing on it has happened yet, and there is no per-category
 * policy or fiscal close to consult. Handing a report-shaped context to a travel rule
 * would mean every travel kind has to remember which two-thirds of it are lies.
 *
 * It must stay narrow. If a travel rule ever needs FX rates or per-diem inputs, add the
 * one field it needs — not the report context.
 */
export interface TravelRequestContext {
  request: {
    id: string;
    tripType: string;
    departDate: Date;
    returnDate: Date | null;
    destinationCity: string | null;
    destinationCountry: string | null;
    /** ISO-4217 code every line's `amountMinor` is denominated in. A travel line
     *  carries no currency of its own — the request holds the only one. */
    currencyCode: string;
    /** Sum of the lines below. Provided rather than re-derived so a rule and the
     *  drawer cannot disagree about the estimate's total. */
    totalMinor: bigint;
  };
  submitter: {
    id: string;
    jobLevelId: string | null;
  };
  lines: ReadonlyArray<{
    id: string;
    categoryId: string;
    /** `TravelCategory.code`, or '' for a category an admin created by hand. */
    categoryCode: string;
    kind: TravelLineKind;
    /** The kind's payload as stored. Read it through
     *  `readTravelLinePayload(kind, payload)` — tolerant on read, so a payload
     *  written by an older deployment yields null rather than throwing inside a
     *  rule. */
    payload: unknown;
    amountMinor: bigint;
    basis: TravelPriceBasis;
    /**
     * The traveller's own words on this line, or null.
     *
     * Not the server's explanation of the figure — that used to live in this column and
     * moved into the payload as facts precisely so a rule could require this one. See
     * `TRAVEL_LINE_DETAIL_REQUIRED`.
     */
    notes: string | null;
  }>;
  t: RuleTranslator;
}

/**
 * What an approved travel request budgeted, bucketed on the axis the claim side shares.
 *
 * ## Why per expense category, and why NOT a total
 *
 * A total comparison is wrong, and not marginally. A report legitimately carries spend the
 * travel request never budgeted — an unexpected client meeting on the last day, a category
 * with no travel counterpart at all — so comparing report total against approved total
 * reports an overrun for money nobody claimed was in the estimate. The rule would fire on
 * ordinary reports and be switched off.
 *
 * So the comparison is the INTERSECTION: for each travel category that maps to an expense
 * category, the sum of that travel category's budget lines against the sum of the claim
 * lines coded to the mapped expense category. Everything outside that intersection —
 * unmapped travel categories, claims in categories the trip never budgeted — is silent by
 * design, because neither side of the comparison exists.
 *
 * ## Why the bucket key is the EXPENSE category
 *
 * An expense line has no travel category; the mapping is the only axis both sides share.
 * Two travel categories mapping to one expense category therefore merge into one bucket,
 * which is correct — the claims coded to it cannot be told apart either. `travelLabels`
 * keeps their names so the finding can still speak in travel's vocabulary.
 *
 * No join between a claim and a specific budget LINE is needed or implied. There is no such
 * relation, and inventing one by position would be meaningless the moment a traveller
 * splits a round trip into two tickets.
 */
export interface TravelBudgetByCategory {
  /** Expense-category id → budgeted minor units, already in the POLICY currency. */
  budgetedByExpenseCategoryId: ReadonlyMap<string, bigint>;
  /** Expense-category id → the travel categories that fed the bucket, for the message. */
  travelLabels: ReadonlyMap<string, readonly string[]>;
}

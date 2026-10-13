// Ported from ExpenseOS `apps/web/src/server/policy/types.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
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
   * currency mismatch across the whole report).
   *
   * VeloExpense: an `ExpenseLineItem` id. ExpenseOS also validates travel requests, where
   * this holds a `TravelBudgetLine` id; travel is out of VeloExpense's scope.
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
import type { ExpensePolicy, RuleScope } from '@expenseos/db';

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
    /** Tier, for rules that exempt seniority. */
    jobLevelId: string | null;
  };
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
  // VeloExpense: ExpenseOS's `travelBudget` (TRAVEL_OVERRUN's input) is not carried —
  // travel is out of scope.
  t: RuleTranslator;
}

// VeloExpense: ExpenseOS's `TravelRequestContext` and `TravelBudgetByCategory` (the travel
// subject and TRAVEL_OVERRUN's budget map) end the file there; travel is out of
// VeloExpense's scope, so they are not carried.

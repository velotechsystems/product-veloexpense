// Ported from ExpenseOS `apps/web/src/server/policy/kinds.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:"; travel, which is out of VeloExpense's scope, is the main one.
/**
 * Rule-kind registry (policy engine v2). A rule TYPE is code; a rule INSTANCE is
 * a `PolicyRule` row. Kinds return `Finding[]`; the runner stamps the instance's
 * severity + localized message → `Violation`, so a kind can't forge severity.
 *
 * Most admin rules use the generic PREDICATE kinds (condition = a `Predicate`
 * over the LINE or REPORT fact set — no per-kind code). Exotic money-math checks
 * (per-diem, later duplicate/velocity) are dedicated AGGREGATE kinds, because the
 * predicate language can't express grouping / pairwise / temporal math.
 */
import { computePerDiemOverageMinor } from '@expenseos/approvals';
import type { RuleScope } from '@expenseos/db';
// VeloExpense: ExpenseOS also imports `convertMoney` here, for TRAVEL_OVERRUN (not carried).
import { evaluatePredicate, type FactValue, type Predicate } from '@expenseos/predicate';
import { z } from 'zod';
import { BUILTIN_KINDS } from './builtinKinds';
import { linePredicateSchema, reportPredicateSchema } from './facts';
import type { AggregateContext, PolicyRuleInstance, Severity } from './types';

/** Facts a kind needs; the loader hydrates the union across enabled kinds. */
export type FactRequirement =
  | 'PER_DIEM_RATES'
  | 'FX_RATES'
  | 'SUBMITTER_TIER'
  | 'EXPENSE_DATE_GROUPS'
  | 'EXPENSE_LOCATION'
  | 'LINE_RECEIPTS'
  | 'BUDGET_IMPACTS';

/** A kind's raw output; the runner stamps severity + message + anchor.
 *
 *  `severity` / `messageKey` are per-finding OVERRIDES for built-in kinds that
 *  legitimately emit heterogeneous findings from one instance — e.g. the
 *  per-transaction-limit kind emitting a degraded `fxRateMissing` INFO, or the
 *  running-limit kind emitting daily/monthly/annual findings with distinct
 *  message keys. Admin-authored PREDICATE kinds never set these, so the
 *  instance's own severity/messageKey governs and a kind can't forge them. */
export interface Finding {
  lineItemId?: string | null;
  expenseId?: string | null;
  severity?: Severity;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
  data?: Record<string, unknown>;
}

/**
 * One editable parameter on a rule INSTANCE, described so the Rule Builder can render
 * it without knowing the kind.
 *
 * This exists because `paramsSchema` is a Zod schema and stays on the server: the
 * client cannot introspect it, so the drawer posted `params: {}` and **no kind with
 * parameters was configurable at all**. RECEIPT_THRESHOLD, MILEAGE_MAX and
 * AUDIT_THRESHOLD were all effectively admin-invisible — creatable, but only ever with
 * empty params, which makes each one inert.
 *
 * A declared spec rather than a generated one, deliberately: the schema knows a
 * threshold is a digit string, not that it is MONEY and should be typed in dollars and
 * stored in minor units. That distinction is the whole difference between a usable
 * field and a trap.
 */
export type ParamField =
  /** Money. Entered in major units, stored as a minor-unit digit STRING (BigInt-safe). */
  | { name: string; kind: 'moneyMinor'; required: boolean }
  /** A plain positive number, stored as a number. */
  | { name: string; kind: 'number'; required: boolean }
  /** A switch. `default` is the value applied when the param is absent. */
  | { name: string; kind: 'boolean'; default: boolean }
  /**
   * A SET of lookup-row ids, stored as a uuid array.
   *
   * `entity` names which lookup the Rule Builder offers, so the control can be a real
   * multi-select of the rows an admin recognises rather than a textarea of uuids. Added
   * because the alternative for a "who is exempt" list was the `SPEC_EXEMPT` hole — a
   * rule creatable from the UI and configurable only over the API, which is a rule most
   * admins will never manage to turn on. (ExpenseOS's example, `REQUIRES_APPROVED_TRAVEL`,
   * is a travel kind and not carried.)
   */
  | { name: string; kind: 'lookupIds'; entity: 'jobLevel'; required: boolean }
  /** A closed set of literal values. `options` are the wire values; the Rule Builder
   *  labels each one from `params.<name>.<option>` so the admin reads "Business", not
   *  "BUSINESS". */
  | { name: string; kind: 'enum'; options: readonly string[]; required: boolean };

export interface RuleKind {
  code: string;
  scope: RuleScope;
  requires: readonly FactRequirement[];
  /** Validates `PolicyRule.condition` (PREDICATE kinds only). */
  conditionSchema?: z.ZodTypeAny;
  /** Validates `PolicyRule.params`. */
  paramsSchema: z.ZodTypeAny;
  /**
   * Editable params, for the admin UI. Omit for a kind that takes none.
   *
   * MUST be declared whenever `paramsSchema` accepts a field — `policy.paramsSpec.test.ts`
   * enforces that, because the failure mode is silent: the rule saves, validates, and
   * then does nothing.
   */
  paramsSpec?: readonly ParamField[];
  /** Param names of which at least one must be set (MILEAGE_MAX's refine). */
  paramsAtLeastOneOf?: readonly string[];
  defaultSeverity: Severity;
  /** Fallback i18n key when an instance doesn't set its own. */
  messageKey: string;
  /** LINE / REPORT kinds: evaluate one fact unit → a Finding (or null). */
  evaluate?: (facts: Record<string, FactValue>, inst: PolicyRuleInstance) => Finding | null;
  /** AGGREGATE kinds: their own grouping over the whole report. */
  evaluateAggregate?: (inst: PolicyRuleInstance, agg: AggregateContext) => Finding[];
  // VeloExpense: ExpenseOS's `evaluateTravel` (TRAVEL_REQUEST kinds) is not carried —
  // travel is out of scope.
}

const emptyParams = z.object({}).passthrough();

/** Per-line predicate — the workhorse. Fires on the one line matching the
 *  authored condition, so a violation is attributed to that line. */
const predicateLineKind: RuleKind = {
  code: 'PREDICATE_LINE',
  scope: 'LINE',
  requires: [],
  conditionSchema: linePredicateSchema,
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'policy.generic',
  evaluate: (facts, inst) =>
    inst.condition && evaluatePredicate(inst.condition as Predicate, facts) ? {} : null,
};

/** Report-level predicate (e.g. report total over $X). */
const predicateReportKind: RuleKind = {
  code: 'PREDICATE_REPORT',
  scope: 'REPORT',
  requires: [],
  conditionSchema: reportPredicateSchema,
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'policy.generic',
  evaluate: (facts, inst) =>
    inst.condition && evaluatePredicate(inst.condition as Predicate, facts)
      ? { lineItemId: null }
      : null,
};

/** Report spend over the applicable per-diem allowance. Reuses the SAME
 *  `computePerDiemOverageMinor` the approval engine calls, so submit-time and
 *  approval-time per-diem math cannot drift. Gated by the platform per-diem flag
 *  (via the aggregate context). Registered + ready; activates once an instance
 *  is seeded (the current built-in R8 remains authoritative until then). */
const perDiemKind: RuleKind = {
  code: 'PER_DIEM',
  scope: 'AGGREGATE',
  requires: [
    'PER_DIEM_RATES',
    'FX_RATES',
    'SUBMITTER_TIER',
    'EXPENSE_DATE_GROUPS',
    'EXPENSE_LOCATION',
  ],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  // Matches the pre-existing per-diem translation key (was built-in R8).
  messageKey: 'perDiemRate',
  evaluateAggregate: (_inst, agg) => {
    if (!agg.perDiemEnabled || !agg.perDiem || agg.perDiem.rates.length === 0) return [];
    const overageMinor = computePerDiemOverageMinor({
      expenses: agg.perDiem.expenses,
      reportCurrencyCode: agg.perDiem.reportCurrencyCode,
      baseCode: agg.policyCurrency,
      fxRates: agg.fxRates,
      rates: agg.perDiem.rates,
      tier: agg.perDiem.tier,
      rateCurrencyCodeById: agg.perDiem.rateCurrencyCodeById,
    });
    if (overageMinor <= 0) return [];
    return [
      {
        lineItemId: null,
        messageValues: { overageMinor: String(overageMinor) },
        data: { overageMinor: String(overageMinor), policyCurrency: agg.policyCurrency },
      },
    ];
  },
};

/**
 * Report spend that pushes a budget past one of its configured thresholds.
 *
 * WARNING, deliberately never BLOCK. The money on a card has already left, and
 * an unsubmittable claim strands a real expense — the answer to over-budget
 * spend is routing it to somebody who can decide about it (the `overBudget`
 * workflow condition), not refusing to file it.
 *
 * Reads the impacts the loader hydrated rather than querying: this reuses the
 * SAME `evaluateReportAgainstBudgets` the approval engine calls, so the number
 * the submitter is warned about is the number the approver is routed on.
 *
 * ONE finding for the whole report, carrying every crossed budget in `data`.
 * Not one per (budget, month), which is what this originally did: a violation's
 * identity is `(ruleCode, lineItemId)` — `dedupe` collapses on it and
 * `validate.ts` carries justification notes forward on it — so a second
 * report-level finding from the same instance is silently dropped, and any
 * justification would attach to whichever row happened to be first. The notes
 * lives in `data.impacts` for the drawer to expand.
 */
const budgetOverageKind: RuleKind = {
  code: 'BUDGET_OVERAGE',
  scope: 'AGGREGATE',
  requires: ['BUDGET_IMPACTS'],
  paramsSchema: emptyParams,
  defaultSeverity: 'WARNING',
  messageKey: 'budgetOverage',
  evaluateAggregate: (_inst, agg) => {
    const impacts = agg.budgetImpacts;
    if (!impacts || impacts.length === 0) return [];
    // The worst crossing leads, because that is the one worth acting on first.
    const worst = impacts.reduce((a, b) => ((b.crossedBp ?? 0) > (a.crossedBp ?? 0) ? b : a));
    return [
      {
        lineItemId: null,
        messageValues: {
          budgetCount: impacts.length,
          // Whole percent: "at 90% of budget" reads; "at 9000bp" does not.
          thresholdPercent: Math.round((worst.crossedBp ?? 0) / 100),
          currency: worst.currencyCode,
        },
        data: {
          budgetCount: impacts.length,
          worstCrossedBp: worst.crossedBp,
          impacts: impacts.map((i) => ({
            budgetId: i.budgetId,
            glAccountId: i.glAccountId,
            monthIndex: i.monthIndex,
            crossedBp: i.crossedBp,
            usedMinor: String(i.usedMinor),
            amountMinor: String(i.amountMinor),
            currencyCode: i.currencyCode,
          })),
        },
      },
    ];
  },
};

// VeloExpense: ExpenseOS's three travel kinds — TRAVEL_CABIN_CLASS, TRAVEL_OVERRUN and
// TRAVEL_LINE_DETAIL_REQUIRED — sit here. Travel is out of VeloExpense's scope, so they are
// not carried, and neither is their registry entry below.

/** The frozen registry. Engineers add a kind here (one line) + ship a module;
 *  admins then instantiate/scope/tune it as data. `BUILTIN_KINDS` are the
 *  migrated pre-v2 rules (per-transaction/running-limit/receipt/etc.), seeded as
 *  instances — see builtinKinds.ts. */
export const RULE_KINDS: Readonly<Record<string, RuleKind>> = Object.freeze({
  PREDICATE_LINE: predicateLineKind,
  PREDICATE_REPORT: predicateReportKind,
  PER_DIEM: perDiemKind,
  BUDGET_OVERAGE: budgetOverageKind,
  ...Object.fromEntries(BUILTIN_KINDS.map((k) => [k.code, k])),
});

/** Registry codes an admin can author against (for the Rule Builder + router
 *  validation). */
export const RULE_KIND_CODES = Object.keys(RULE_KINDS);

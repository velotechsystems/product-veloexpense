// Ported from ExpenseOS `apps/web/src/server/policy/kinds.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". The travel kinds were left out at w4-02a and restored by w6-01.
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
// VeloExpense (w6-01): from ./types, which adds TRAVEL_REQUEST to @expenseos/db's scopes.
import type { RuleScope } from './types';
import { convertMoney } from '@expenseos/money';
import { evaluatePredicate, type FactValue, type Predicate } from '@expenseos/predicate';
import { readTravelLinePayload, TRAVEL_CLASS_NAMES } from '@expenseos/travel-lines';
import { z } from 'zod';
import { BUILTIN_KINDS } from './builtinKinds';
import { linePredicateSchema, reportPredicateSchema } from './facts';
import type { AggregateContext, PolicyRuleInstance, Severity, TravelRequestContext } from './types';
// VeloExpense (w4-02d, d70): VeloExpense's own kinds, registered with ExpenseOS's below.
import { VELOEXPENSE_KINDS } from './veloexpenseKinds';

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
   * because the alternative for a "who is exempt" list was the `SPEC_EXEMPT` hole —
   * `REQUIRES_APPROVED_TRAVEL` sits in it, creatable from the UI and configurable only
   * over the API, which is a rule most admins will never manage to turn on.
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
  /**
   * VeloExpense (w4-02d): the most severe an instance of this kind may be — the router
   * refuses more and the engine clamps a row set past it by other means. ExpenseOS has no
   * ceiling; VeloExpense's v1 engine had one on BUDGET_OVERAGE (BG-4), kept below.
   */
  maxSeverity?: Severity;
  /** Fallback i18n key when an instance doesn't set its own. */
  messageKey: string;
  /** LINE / REPORT kinds: evaluate one fact unit → a Finding (or null). */
  evaluate?: (facts: Record<string, FactValue>, inst: PolicyRuleInstance) => Finding | null;
  /** AGGREGATE kinds: their own grouping over the whole report. */
  evaluateAggregate?: (inst: PolicyRuleInstance, agg: AggregateContext) => Finding[];
  /** TRAVEL_REQUEST kinds: read the estimate, not a report. `runTravelRules` is the
   *  only caller, and `runRules` never reaches these — the two validators dispatch on
   *  `scope`, so a kind can only ever be handed the context it was written against. */
  evaluateTravel?: (inst: PolicyRuleInstance, travel: TravelRequestContext) => Finding[];
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
  // VeloExpense (BG-4, kept at w4-02d): a budget never BLOCKS. The money has already left,
  // so a claim nobody can submit strands a real expense; the warning is the control.
  maxSeverity: 'WARNING',
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

/** The cabins a rule may restrict. ECONOMY is absent on purpose: a rule forbidding the
 *  cheapest cabin is a rule forbidding travel. Derived from the payload's own enum
 *  (`TRAVEL_CLASS_NAMES`) rather than retyped, so adding a cabin there cannot leave this
 *  list quietly behind. */
const RESTRICTED_CABINS = TRAVEL_CLASS_NAMES.filter((c) => c !== 'ECONOMY') as unknown as [
  string,
  ...string[],
];

/**
 * A cabin nobody below a named seniority may quote for.
 *
 * BLOCK by default, and this is the one rule where that asymmetry is the whole point.
 * The expense side WARNS on an unexpected figure and asks for a justification, because
 * the money has already left. A travel request has not spent anything yet, so the
 * discouraged booking can simply be refused before it is made — "a blocking violation
 * must be fixed, not justified".
 *
 * `allowedJobLevelIds` rather than a rank threshold. `JobLevel.sortOrder` exists and
 * looks like it would do, but the ladder is populated by title-matching heuristics from
 * free-text Google Workspace titles, so its ordering is not accurate enough to hang a
 * hard block on. Naming the levels is explicit, and an admin adding a level and
 * forgetting this rule gets the SAFE failure: the new level is not on the list, so it
 * is blocked rather than silently exempt.
 *
 * One instance per restricted cabin, so "business needs VP+, first is nobody" is two
 * admin rows and no deploy.
 *
 * Reads `travelClass` off each AIRFARE line's payload. That field exists because phase
 * 8 stored the cabin by NAME rather than the provider's number — `"travelClass": 3`
 * explains nothing years later, and would not be checkable here at all.
 */
const travelCabinClassKind: RuleKind = {
  code: 'TRAVEL_CABIN_CLASS',
  scope: 'TRAVEL_REQUEST',
  requires: ['SUBMITTER_TIER'],
  paramsSchema: z
    .object({
      cabin: z.enum(RESTRICTED_CABINS),
      allowedJobLevelIds: z.array(z.string().uuid()).default([]),
    })
    .passthrough(),
  paramsSpec: [
    { name: 'cabin', kind: 'enum', options: RESTRICTED_CABINS, required: true },
    { name: 'allowedJobLevelIds', kind: 'lookupIds', entity: 'jobLevel', required: false },
  ],
  defaultSeverity: 'BLOCK',
  messageKey: 'travelCabinClass',
  evaluateTravel: (inst, travel) => {
    const params = (inst.params ?? {}) as { cabin?: unknown; allowedJobLevelIds?: unknown };
    const cabin = typeof params.cabin === 'string' ? params.cabin : null;
    if (!cabin) return [];
    const allowed = Array.isArray(params.allowedJobLevelIds)
      ? new Set(params.allowedJobLevelIds.filter((v): v is string => typeof v === 'string'))
      : new Set<string>();
    // A submitter with NO job level is not exempt. An unlevelled employee is a data
    // gap, and reading it as "allowed" would make the block bypassable by having no
    // level — the seed already reports unmapped titles for exactly this reason.
    if (travel.submitter.jobLevelId && allowed.has(travel.submitter.jobLevelId)) return [];

    const out: Finding[] = [];
    for (const line of travel.lines) {
      if (line.kind !== 'AIRFARE') continue;
      const payload = readTravelLinePayload('AIRFARE', line.payload);
      if (payload?.travelClass !== cabin) continue;
      out.push({
        lineItemId: line.id,
        messageValues: { cabin },
        data: { cabin, travelLineId: line.id, amountMinor: String(line.amountMinor) },
      });
    }
    return out;
  },
};

/**
 * A claim that overruns the trip its approval authorised.
 *
 * The expense-side half of the cabin control, and it is the half that actually catches
 * the scenario. An employee who cannot request business class and books it anyway files
 * a travel request saying ECONOMY — so a check reading the request's cabin reads
 * "economy" and finds nothing. The cabin is recorded nowhere on the expense either. The
 * only signal that survives is the AMOUNT, which is what this reads.
 *
 * WARNING, not BLOCK: the money is spent, and an unsubmittable claim strands a real
 * expense. An unjustified WARNING already blocks submit, so the traveller must write an
 * explanation the approver then reads — which is the outcome asked for.
 *
 * BOTH a percentage AND an absolute floor, because either alone is useless. A tolerance
 * of 10% flags a $40 trip that came in $4 over; a floor of $200 ignores a $180 overrun
 * on a $200 estimate. Both must be exceeded. (The same reasoning
 * `TRAVEL_BUDGET_OVERRUN` carries as a periodic control.)
 *
 * Report-scope rather than per-category. A per-category comparison needs every
 * TravelCategory to map to an ExpenseCategory, and an admin-created one need not — so
 * the precise version would go quiet exactly where the taxonomy is incomplete. The
 * total always exists.
 */
const travelOverrunKind: RuleKind = {
  code: 'TRAVEL_OVERRUN',
  // AGGREGATE, not REPORT: the comparison is a grouping over the report's lines against a
  // per-category budget map, and a `Record<string, FactValue>` cannot carry a map.
  scope: 'AGGREGATE',
  requires: ['FX_RATES'],
  paramsSchema: z
    .object({
      tolerancePercent: z.number().min(0).max(1000).default(10),
      absoluteFloorMinor: z.string().regex(/^\d+$/).default('0'),
    })
    .passthrough(),
  paramsSpec: [
    { name: 'tolerancePercent', kind: 'number', required: true },
    { name: 'absoluteFloorMinor', kind: 'moneyMinor', required: true },
  ],
  defaultSeverity: 'WARNING',
  messageKey: 'travelOverrun',
  evaluateAggregate: (inst, agg) => {
    const budget = agg.travelBudget;
    if (!budget || budget.budgetedByExpenseCategoryId.size === 0) return [];

    const params = (inst.params ?? {}) as {
      tolerancePercent?: unknown;
      absoluteFloorMinor?: unknown;
    };
    const tolerance = typeof params.tolerancePercent === 'number' ? params.tolerancePercent : 10;
    const floor =
      typeof params.absoluteFloorMinor === 'string' && /^\d+$/.test(params.absoluteFloorMinor)
        ? BigInt(params.absoluteFloorMinor)
        : 0n;

    /**
     * Claims summed per expense category, in the POLICY currency.
     *
     * Converted rather than added raw: a report may hold lines in several currencies, and
     * the budget map is already in policy currency. Adding incommensurable minor units
     * would produce an overrun out of an exchange rate.
     */
    const claimed = new Map<string, bigint>();
    for (const line of agg.report.lineItems) {
      // Only categories the trip actually budgeted. A claim in any other category is the
      // unexpected client meeting this rule deliberately says nothing about.
      if (!budget.budgetedByExpenseCategoryId.has(line.category.id)) continue;
      const inPolicy = toPolicyMinor(line.amountMinor, line.currency.code, agg);
      claimed.set(line.category.id, (claimed.get(line.category.id) ?? 0n) + inPolicy);
    }

    const over: Array<{
      expenseCategoryId: string;
      travelLabels: readonly string[];
      budgetedMinor: bigint;
      claimedMinor: bigint;
      overrunMinor: bigint;
      overrunPercent: number;
    }> = [];
    for (const [categoryId, budgetedMinor] of budget.budgetedByExpenseCategoryId) {
      // A budget with nothing claimed against it is an UNDERRUN. Silent: the traveller
      // spent less than they asked for, which is not what this rule is about.
      if (budgetedMinor <= 0n) continue;
      const claimedMinor = claimed.get(categoryId) ?? 0n;
      const overrunMinor = claimedMinor - budgetedMinor;
      if (overrunMinor <= 0n) continue;
      // BOTH thresholds, not either. A 10% tolerance alone flags a $40 category that came
      // in $4 over; a $200 floor alone ignores $180 over on a $200 budget.
      if (overrunMinor < floor) continue;
      if (overrunMinor * 100n <= budgetedMinor * BigInt(Math.round(tolerance))) continue;
      over.push({
        expenseCategoryId: categoryId,
        travelLabels: budget.travelLabels.get(categoryId) ?? [],
        budgetedMinor,
        claimedMinor,
        overrunMinor,
        overrunPercent: Number((overrunMinor * 100n) / budgetedMinor),
      });
    }
    if (over.length === 0) return [];

    /**
     * ONE finding for the whole report, every offending category inside `data`.
     *
     * Not one per category, for the reason `BUDGET_OVERAGE` records above: a violation's
     * identity is `(ruleCode, lineItemId)`, so a second finding from this instance with the
     * same null anchor is silently dropped by `dedupe`, and any justification would attach
     * to whichever happened to be first. The worst category leads because that is the one
     * worth acting on.
     */
    const worst = over.reduce((a, b) => (b.overrunPercent > a.overrunPercent ? b : a));
    return [
      {
        lineItemId: null,
        messageValues: {
          categoryCount: over.length,
          overrunPercent: worst.overrunPercent,
          tolerancePercent: tolerance,
        },
        data: {
          categoryCount: over.length,
          overrunPercent: worst.overrunPercent,
          tolerancePercent: tolerance,
          absoluteFloorMinor: String(floor),
          policyCurrency: agg.policyCurrency,
          categories: over.map((o) => ({
            expenseCategoryId: o.expenseCategoryId,
            travelLabels: o.travelLabels,
            budgetedMinor: String(o.budgetedMinor),
            claimedMinor: String(o.claimedMinor),
            overrunMinor: String(o.overrunMinor),
            overrunPercent: o.overrunPercent,
          })),
        },
      },
    ];
  },
};

/** A line's amount in the policy currency. Same rule the fact builder applies: no rate,
 *  or the same currency, leaves it unchanged rather than guessing. */
function toPolicyMinor(amountMinor: bigint, fromCode: string, agg: AggregateContext): bigint {
  if (fromCode === agg.policyCurrency) return amountMinor;
  const converted = convertMoney(
    { amountMinor, currencyCode: fromCode },
    agg.policyCurrency,
    agg.fxRates,
  );
  return converted ? converted.amountMinor : amountMinor;
}

/**
 * A line the traveller has not explained.
 *
 * The rule the notes field was freed up for. It used to hold a sentence the
 * SERVER composed ("Per diem · 3 days · Toronto"), which made requiring it meaningless —
 * every priced line already had one, written by nobody. It is the traveller's own words
 * now, so "explain this line" is a demand that can actually be made.
 *
 * `thresholdMinor` because the demand is not equally reasonable everywhere. A $12 taxi
 * needs no essay; a $4,800 business-class fare does, and that is precisely the line an
 * approver wants a sentence about — "why this fare and not the cheaper one on another
 * carrier" is a question the payload can never answer. `'0'` requires one on every line.
 *
 * BLOCK by default, matching the travel side's asymmetry: nothing has been spent, so a
 * missing justification is fixed rather than justified. An admin can soften it to
 * WARNING per instance, which then blocks submit until explained anyway.
 */
const travelLineDetailRequiredKind: RuleKind = {
  code: 'TRAVEL_LINE_DETAIL_REQUIRED',
  scope: 'TRAVEL_REQUEST',
  requires: [],
  paramsSchema: z.object({ thresholdMinor: z.string().regex(/^\d+$/).default('0') }).passthrough(),
  paramsSpec: [{ name: 'thresholdMinor', kind: 'moneyMinor', required: false }],
  defaultSeverity: 'BLOCK',
  messageKey: 'travelLineDetailRequired',
  evaluateTravel: (inst, travel) => {
    const params = (inst.params ?? {}) as { thresholdMinor?: unknown };
    const threshold =
      typeof params.thresholdMinor === 'string' && /^\d+$/.test(params.thresholdMinor)
        ? BigInt(params.thresholdMinor)
        : 0n;
    const out: Finding[] = [];
    for (const line of travel.lines) {
      if (line.amountMinor < threshold) continue;
      // Trimmed: a space is not an explanation, and the router trims on write anyway —
      // this guards a row written before it did.
      if (line.notes?.trim()) continue;
      out.push({
        lineItemId: line.id,
        data: {
          travelLineId: line.id,
          amountMinor: String(line.amountMinor),
          thresholdMinor: String(threshold),
        },
      });
    }
    return out;
  },
};

/** The frozen registry. Engineers add a kind here (one line) + ship a module;
 *  admins then instantiate/scope/tune it as data. `BUILTIN_KINDS` are the
 *  migrated pre-v2 rules (per-transaction/running-limit/receipt/etc.), seeded as
 *  instances — see builtinKinds.ts. */
export const RULE_KINDS: Readonly<Record<string, RuleKind>> = Object.freeze({
  PREDICATE_LINE: predicateLineKind,
  PREDICATE_REPORT: predicateReportKind,
  PER_DIEM: perDiemKind,
  BUDGET_OVERAGE: budgetOverageKind,
  TRAVEL_CABIN_CLASS: travelCabinClassKind,
  TRAVEL_LINE_DETAIL_REQUIRED: travelLineDetailRequiredKind,
  TRAVEL_OVERRUN: travelOverrunKind,
  ...Object.fromEntries(BUILTIN_KINDS.map((k) => [k.code, k])),
  ...Object.fromEntries(VELOEXPENSE_KINDS.map((k) => [k.code, k])),
});

/** Registry codes an admin can author against (for the Rule Builder + router
 *  validation). */
export const RULE_KIND_CODES = Object.keys(RULE_KINDS);

// Ported from ExpenseOS `apps/web/src/server/policy/engine.ts` (550b2945), w4-02a (d63). Each adaptation is
// marked "VeloExpense:". The travel entry point was left out at w4-02a and restored by w6-01.
/**
 * Policy engine — 12 rules from docs/use-cases/09 implemented server-side.
 *
 * Design notes:
 *
 *   - Pure-ish: takes a fully-hydrated report + loaded reference data,
 *     returns a list of `Violation` rows. Database writes happen in
 *     `runValidation` (the orchestrator), not in the rule functions
 *     themselves, so each rule is easy to unit-test in isolation later.
 *
 *   - Per-rule cap on output: a rule can emit up to one violation per
 *     scope (one per line item for line-scope rules, one for the
 *     report for report-scope rules). This keeps the violation list
 *     bounded — a 100-line report with every limit blown would still
 *     produce ≤ ~600 rows, not thousands.
 *
 *   - Currency handling: line-item amounts are converted to the policy
 *     currency (SystemFlag `policyCurrency`, default CAD) using the
 *     latest `FxRate` row before comparing against limits. If no rate
 *     is found, the limit rules degrade to `info` severity with a
 *     "rate missing" payload — never silently skip, never crash.
 *
 *   - Severity matches the doc table verbatim. Future tightening
 *     (e.g. per-category `block` on per-transaction limit) is an
 *     additive change to ExpensePolicy + this file.
 */

import type { PerDiemRateRow, PerDiemTier } from '@expenseos/approvals';
import type { ExpensePolicy, FxRate, PolicyViolationSeverity, Prisma } from '@expenseos/db';
import type { BuiltFacts, FxGap } from './facts';
import { type Finding, RULE_KINDS } from './kinds';
// VeloExpense: `BudgetImpact` from ./types (ExpenseOS imports it from its approvals engine's
// budgets, which arrive with w4-04).
import type {
  AggregateContext,
  BudgetImpact,
  HydratedReport,
  PolicyRuleInstance,
  RuleTranslator,
  TravelBudgetByCategory,
  TravelRequestContext,
  Violation,
} from './types';

// ── Hydrated input types ─────────────────────────────────────────────

// `HydratedReport` now lives in ./types (shared with the built-in kinds'
// AggregateContext). Re-exported here for existing importers.
export type { HydratedReport } from './types';

export interface PolicyContext {
  report: HydratedReport;
  /** Categoryid → ExpensePolicy row. Missing entries default to
   *  "no policy" — every rule that depends on a policy bails for
   *  that category. */
  policiesByCategoryId: Map<string, ExpensePolicy>;
  /** ISO-4217 code the policy limits are denominated in. */
  policyCurrency: string;
  /** Map keyed as `${base}->${quote}` → Decimal rate string. The
   *  engine reads strings to avoid float drift; conversion uses
   *  string-based decimal math via the host's helpers below. */
  fxRates: Map<string, string>;
  /** Optional fiscal-close date — submitting on/after this date with
   *  any line dated before it is a BLOCK. */
  fiscalCloseDate: Date | null;
  /** True when the per-diem rule is enabled at platform level. */
  perDiemEnabled: boolean;
  /** Per-diem inputs (null unless `perDiemEnabled` + rates exist). Carries the
   *  report's expenses (date/place/line amounts), the tier-matched rates, the
   *  submitter's tier, and the rate-currency lookup — everything the shared
   *  `computePerDiemOverageMinor` helper needs. */
  perDiem: {
    expenses: ReadonlyArray<{
      date: Date;
      placeText: string | null;
      lineItems: ReadonlyArray<{ amountMinor: bigint; categoryId: string }>;
    }>;
    reportCurrencyCode: string;
    rates: readonly PerDiemRateRow[];
    tier: PerDiemTier;
    rateCurrencyCodeById: Map<string, string>;
  } | null;
  /** Budgets this report pushes past a threshold (null when the module is off or
   *  nothing is budgeted). Hydrated by the loader, because the check needs the
   *  database and a kind's `evaluateAggregate` is synchronous. */
  budgetImpacts: readonly BudgetImpact[] | null;
  /** What the linked APPROVED travel request budgeted, per expense category. Hydrated by
   *  the loader for the same reason, and only when a TRAVEL_OVERRUN instance is enabled. */
  travelBudget: TravelBudgetByCategory | null;
  /** Localized rule-message renderer. */
  t: RuleTranslator;
  /** v2: enabled, scope/date/dim-filtered admin-authored rule instances. */
  rules: PolicyRuleInstance[];
  /** v2: LINE + REPORT facts projected from the report. */
  facts: BuiltFacts;
}

// ── Orchestrator entry point ─────────────────────────────────────────

/** Stamp a kind's Finding with the instance's severity + localized message. A
 *  kind cannot forge severity — that's the point of the Finding/Violation split. */
function stamp(t: RuleTranslator, inst: PolicyRuleInstance, f: Finding): Violation {
  const kind = RULE_KINDS[inst.kindCode];
  // A built-in kind may override severity/message per finding (e.g. the
  // per-transaction kind's degraded fxRateMissing INFO); admin PREDICATE kinds
  // never set these, so the instance's own values govern.
  const severity = f.severity ?? inst.severity;
  return {
    // Each instance is its own rule; its id is the stable code (dedupe + analytics).
    ruleCode: inst.id,
    // VeloExpense (BG-4): held to the kind's ceiling, so a row forced past it — a seed, an
    // import, a hand edit — still cannot block.
    severity:
      kind?.maxSeverity && SEVERITY_RANK[severity] > SEVERITY_RANK[kind.maxSeverity]
        ? kind.maxSeverity
        : severity,
    message: t(
      f.messageKey || inst.messageKey || kind?.messageKey || 'policy.generic',
      f.messageValues,
    ),
    lineItemId: f.lineItemId ?? null,
    data: f.data,
    // Not persisted — `kindCode` exists only so `keepMostSevere` can tell two instances of the
    // SAME rule kind apart from two unrelated rules that happen to hit one line.
    kindCode: inst.kindCode,
  };
}

/** VeloExpense (PE-7): the facts a missing FX rate leaves unknown, by scope. */
const LINE_AMOUNT_FACTS: ReadonlySet<string> = new Set(['lineAmount']);
const REPORT_AMOUNT_FACTS: ReadonlySet<string> = new Set(['reportTotal', 'maxLineAmount']);

/** VeloExpense (PE-7): does this condition compare any of these facts, at any depth? */
function comparesAmount(condition: unknown, fields: ReadonlySet<string>): boolean {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition)) return condition.some((c) => comparesAmount(c, fields));
  const node = condition as Record<string, unknown>;
  if (typeof node.field === 'string' && fields.has(node.field)) return true;
  return Object.values(node).some((v) => typeof v === 'object' && comparesAmount(v, fields));
}

/** VeloExpense (PE-7): the INFO a rule raises when it cannot convert an amount — the same
 *  `fxRateMissing` the built-in per-transaction kind degrades to. */
function fxGapFinding(gap: FxGap, lineItemId: string | null): Finding {
  return {
    lineItemId,
    severity: 'INFO',
    messageKey: 'fxRateMissing',
    messageValues: { from: gap.from, to: gap.to },
    data: { from: gap.from, to: gap.to },
  };
}

/** BLOCK outranks WARNING outranks INFO. */
const SEVERITY_RANK: Record<string, number> = { INFO: 0, WARNING: 1, BLOCK: 2 };

/**
 * One violation per (rule kind × line item), keeping the most severe.
 *
 * Two instances of the same kind can both fire: a receipt threshold that WARNS over one amount
 * and one that BLOCKS over a higher amount are separate rules, and a line above both breaches
 * both. Reporting both is
 * two problems where there is one — and worse than cosmetic, because the submit gate counts
 * unjustified WARNINGs, so the submitter is asked to justify a warning about the very thing that
 * is already blocking them. Justifying it changes nothing; the block still stands.
 *
 * Grouped on the KIND rather than the instance, which is what `dedupe` above already does. Two
 * different kinds landing on one line stay separate, because those are genuinely two problems.
 *
 * Among equal severities the first is kept. An admin who configures two BLOCKs of one kind on the
 * same spend has expressed one requirement twice, and either message states it.
 */
function keepMostSevere(violations: Violation[]): Violation[] {
  const best = new Map<string, Violation>();
  const order: string[] = [];
  for (const v of violations) {
    const key = `${v.kindCode ?? v.ruleCode}|${v.lineItemId ?? ''}`;
    const held = best.get(key);
    if (!held) {
      best.set(key, v);
      order.push(key);
      continue;
    }
    const rank = SEVERITY_RANK[v.severity] ?? 0;
    const heldRank = SEVERITY_RANK[held.severity] ?? 0;
    if (rank > heldRank) best.set(key, v);
  }
  return order.map((k) => best.get(k) as Violation);
}

/** Collapse duplicate `(ruleCode, lineItemId)` firings to the first — the pass
 *  the Violation type always promised. */
function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.ruleCode}|${v.lineItemId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Run every rule INSTANCE (by kind + scope) then dedupe. Both the migrated
 *  built-ins (seeded instances of the AGGREGATE built-in kinds) and
 *  admin-authored PREDICATE rules flow through the same loop — the legacy
 *  hardcoded rule functions are gone. The caller writes the result into
 *  `PolicyViolation` (replace-all per report). */
export function runRules(ctx: PolicyContext): Violation[] {
  const out: Violation[] = [];
  const agg: AggregateContext = {
    report: ctx.report,
    policiesByCategoryId: ctx.policiesByCategoryId,
    policyCurrency: ctx.policyCurrency,
    fxRates: ctx.fxRates,
    fiscalCloseDate: ctx.fiscalCloseDate,
    perDiemEnabled: ctx.perDiemEnabled,
    perDiem: ctx.perDiem,
    budgetImpacts: ctx.budgetImpacts,
    travelBudget: ctx.travelBudget,
    t: ctx.t,
  };

  // VeloExpense (f36): each line's category, so an AGGREGATE kind's findings can be held to
  // the instance's category scope below.
  const categoryOfLine = new Map(ctx.report.lineItems.map((l) => [l.id, l.category.id]));

  for (const inst of ctx.rules) {
    const kind = RULE_KINDS[inst.kindCode];
    if (!kind) continue;
    if (kind.scope === 'LINE' && kind.evaluate) {
      for (const line of ctx.facts.lines) {
        // A category-scoped LINE rule only evaluates lines of that category.
        if (inst.categoryId && line.categoryId !== inst.categoryId) continue;
        // VeloExpense (PE-7, d67): a rule comparing this line's amount cannot be decided
        // when the amount has no rate into the policy currency. Say so, rather than let
        // the null fact read as "under every limit".
        if (line.fxGap && comparesAmount(inst.condition, LINE_AMOUNT_FACTS)) {
          out.push(stamp(ctx.t, inst, fxGapFinding(line.fxGap, line.lineItemId)));
          continue;
        }
        const f = kind.evaluate(line.facts, inst);
        if (f) out.push(stamp(ctx.t, inst, { ...f, lineItemId: f.lineItemId ?? line.lineItemId }));
      }
    } else if (kind.scope === 'REPORT' && kind.evaluate) {
      // VeloExpense (PE-7): as above, for the report's converted totals.
      if (ctx.facts.reportFxGap && comparesAmount(inst.condition, REPORT_AMOUNT_FACTS)) {
        out.push(stamp(ctx.t, inst, fxGapFinding(ctx.facts.reportFxGap, null)));
        continue;
      }
      const f = kind.evaluate(ctx.facts.report, inst);
      if (f) out.push(stamp(ctx.t, inst, f));
    } else if (kind.scope === 'AGGREGATE' && kind.evaluateAggregate) {
      for (const f of kind.evaluateAggregate(inst, agg)) {
        // VeloExpense (f36): ExpenseOS applies a rule's category scope to LINE kinds only,
        // so an AGGREGATE kind scoped to one category (a receipt threshold for Meals, say)
        // fired on every category — a silent widening of the policy an admin wrote. A
        // line finding outside the scope is dropped; a report-level one stands.
        if (inst.categoryId && f.lineItemId && categoryOfLine.get(f.lineItemId) !== inst.categoryId) {
          continue;
        }
        out.push(stamp(ctx.t, inst, f));
      }
    }
  }

  // Two passes, and they answer different questions. `dedupe` collapses repeat firings of ONE
  // instance; `keepMostSevere` collapses a warn-and-block pair from two instances of one kind.
  return keepMostSevere(dedupe(out));
}

// ── Travel requests ──────────────────────────────────────────────────

export interface TravelPolicyContext {
  travel: TravelRequestContext;
  /** Enabled, effective, dimension-filtered instances — the SAME query the report
   *  validator runs. Non-travel scopes are simply skipped below, rather than filtered
   *  out here, so one loader serves both subjects. */
  rules: PolicyRuleInstance[];
}

/**
 * Run the TRAVEL_REQUEST-scope rules over a travel estimate.
 *
 * A fourth entry point rather than a fifth branch inside `runRules`, because `runRules`
 * needs a `HydratedReport` to build its `AggregateContext` and a travel request is not
 * one. Faking a report to get here would put a lie in the shared context that every
 * report kind would then have to defend against.
 *
 * The two collapse passes are shared verbatim, and that is the point of sharing them: a
 * travel warn-and-block pair from two instances of one kind collapses exactly as it does
 * on a report, so the submit gate cannot ask somebody to justify the warning about the
 * very thing that is already blocking them.
 *
 * `Violation.lineItemId` here holds a `TravelBudgetLine` id. The engine only ever uses
 * it as a grouping key; `validateTravelRequest` is what writes it into `travelLineId`.
 */
export function runTravelRules(ctx: TravelPolicyContext): Violation[] {
  const out: Violation[] = [];
  for (const inst of ctx.rules) {
    if (inst.scope !== 'TRAVEL_REQUEST') continue;
    const kind = RULE_KINDS[inst.kindCode];
    // Scope is denormalized onto the row, so a kind re-scoped in code after an instance
    // was authored would otherwise be handed the wrong context. The kind's own scope
    // governs.
    if (!kind || kind.scope !== 'TRAVEL_REQUEST' || !kind.evaluateTravel) continue;
    for (const f of kind.evaluateTravel(inst, ctx.travel)) out.push(stamp(ctx.travel.t, inst, f));
  }
  return keepMostSevere(dedupe(out));
}

// ── Helpers re-exported for the orchestrator ─────────────────────────

export type { ExpensePolicy, FxRate, PolicyViolationSeverity, Prisma };

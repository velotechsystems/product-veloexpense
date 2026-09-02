/**
 * VX1-7 — the rule TYPE registry (ExpenseOS Module 9, v2 architecture).
 *
 * Rule kinds live in code; rule INSTANCES are `expense_policy` rows. That split
 * is deliberate and comes straight from the ExpenseOS spec: an admin retunes a
 * limit for their tenant without a deploy, but the evaluation logic — the part
 * that must be reviewable and testable — stays in version control.
 *
 * This module is PURE. It takes an already-loaded snapshot of a report and
 * returns findings; it never touches the database. That is what makes the rules
 * unit-testable and what keeps `validateReport` a single transaction.
 *
 * v1 ships the four starter rules the ticket names. Module 9's fuller set
 * (daily/monthly/annual aggregates, mileage, per-diem, custom fields, duplicate
 * detection, fiscal-period close) slots in by adding entries here — no
 * migration, since `expense_policy.kind` is deliberately not a CHECK constraint.
 */
import { convertMinor, formatMinor, toBigInt, type MinorAmount } from '@/lib/money';
import {
  hasUnconvertible,
  projectedMinor,
  type BudgetSnapshot,
} from '@/lib/budgets/scope';
import type { RateBasis, RateLookup } from '@/lib/policy/rates';
import type { WorkbenchExpense, WorkbenchReport } from '@/lib/expenses/service';

export const RULE_KINDS = [
  'PER_TRANSACTION_LIMIT',
  'RECEIPT_REQUIRED',
  'CATEGORY_ACTIVE',
  'NON_NEGATIVE_AMOUNT',
  'BUDGET_OVERAGE',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const SEVERITIES = ['INFO', 'WARNING', 'BLOCK'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isRuleKind(value: string): value is RuleKind {
  return (RULE_KINDS as readonly string[]).includes(value);
}
export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Is `severity` stronger than `maximum`? An INDEX COMPARISON against `SEVERITIES`,
 * not a hand-written ordering — the array already states the ranking once, and a
 * second copy of it is a second thing to get wrong when a level is added.
 */
export function severityExceeds(severity: Severity, maximum: Severity): boolean {
  return SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(maximum);
}

/** `severity`, held down to a rule's declared maximum. No maximum means no clamp. */
export function clampSeverity(severity: Severity, maximum: Severity | undefined): Severity {
  if (maximum === undefined) return severity;
  return severityExceeds(severity, maximum) ? maximum : severity;
}

/** A rule instance as stored. `params` is validated per kind by the service. */
export interface PolicyRow {
  id: string;
  kind: RuleKind;
  severity: Severity;
  enabled: boolean;
  category_id: string | null;
  category_label?: string | null;
  /**
   * Currency this rule's amount thresholds are written in. NULL means the
   * organization's `policy_currency_code` (VX3-2 / PE-1) — the override exists for
   * a tenant with a Canadian and a US entity, where a cap is natural in each.
   */
  currency_code: string | null;
  params: Record<string, unknown>;
  effective_from: string | null;
  effective_to: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What the rules see. Exactly the shape `getReportWorkbench` already returns. */
export interface PolicyContext {
  report: WorkbenchReport;
  expenses: WorkbenchExpense[];
  /**
   * The currency amount thresholds are compared in when a rule does not name its
   * own — `organization.policy_currency_code`. VX3-2 / PE-1: a report's currency
   * is per report and a threshold is per tenant, so something has to convert
   * before any numeric comparison, and this is what it converts INTO.
   */
  policyCurrency: string;
  /** `currency.minor_unit` per code, for every currency in play. Never 100. */
  minorUnits: Record<string, number>;
  /** Built by `lib/policy/service.ts`; pure here. */
  rates: RateLookup;
  /**
   * The budget periods this report's spend lands in, already converted into each
   * budget's currency by `lib/budgets/service.ts`.
   *
   * Loaded INTO the context because `evaluate` is pure and synchronous and gets
   * no transaction — the rule cannot query, so the rule and its loader are one
   * unit. Empty is the normal case: most reports code to accounts nobody has
   * budgeted, and the loader is skipped entirely when no BUDGET_OVERAGE instance
   * is enabled, because the scan is the expensive part of a validation.
   */
  budgets: BudgetSnapshot[];
}

export interface Finding {
  ruleCode: RuleKind;
  message: string;
  /** null when the finding is about the report or an expense, not one line. */
  lineItemId: string | null;
  /**
   * Distinguishes several findings of the same rule at the same scope — e.g.
   * one per receipt-less expense. '' means "the only finding of its kind".
   */
  findingKey: string;
  data: Record<string, unknown>;
  /**
   * PE-3, and VX3-2 is what needed it. Overrides the configured severity for ONE
   * finding, so a rule can say "I could not check this" instead of choosing
   * between firing at full severity and staying silent. The only current use is
   * the missing-rate INFO below; ExpenseOS has the same mechanism
   * (`f.severity ?? inst.severity`) and it is what makes their loud degradation
   * possible.
   */
  severity?: Severity;
}

export interface ParamSpec {
  name: string;
  label: string;
  type: 'amount' | 'boolean';
  required: boolean;
  help?: string;
}

export interface RuleDefinition {
  kind: RuleKind;
  label: string;
  description: string;
  defaultSeverity: Severity;
  /**
   * The strongest severity an INSTANCE of this rule may evaluate at.
   *
   * Severity normally belongs to the instance (`f.severity ?? inst.severity`), so
   * an admin can turn any rule into a hard stop. For a rule where that would
   * contradict a product decision, the decision has to be a MECHANISM rather than
   * a comment — BG-4 is precisely ExpenseOS's version of this going unenforced:
   * `BUDGET_OVERAGE` is documented "WARNING, deliberately never BLOCK" and
   * nothing stops an admin configuring the instance at BLOCK.
   *
   * Enforced in TWO places, and both are needed. `createPolicy`/`updatePolicy`
   * REFUSE a severity above this, so a stored value can never disagree with what
   * is evaluated and an admin is told no rather than silently overruled; and
   * `validateReport` clamps anyway, because a row written by a seed, an import,
   * or before this maximum existed has to evaluate correctly regardless.
   * Refusing at the write is the courtesy; clamping at the read is the invariant.
   */
  maxSeverity?: Severity;
  /** Whether a rule instance may be narrowed to one expense category. */
  supportsCategoryScope: boolean;
  params: ParamSpec[];
  evaluate(context: PolicyContext, policy: PolicyRow): Finding[];
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function money(context: PolicyContext, amount: string | number | bigint) {
  return formatMinor(amount, context.report.currency_code, context.report.minor_unit);
}

/** The currency a rule's thresholds are written in. */
function thresholdCurrency(context: PolicyContext, policy: PolicyRow): string {
  return policy.currency_code ?? context.policyCurrency;
}

function minorUnitOf(context: PolicyContext, code: string): number {
  // Defaulting to 2 rather than throwing: every currency this product ships has
  // two, and a rule that cannot evaluate should degrade through the FX path
  // below, not crash the whole validation over a missing reference row.
  return context.minorUnits[code] ?? 2;
}

/** Format an amount in a named currency — used for the THRESHOLD, which is not
 *  necessarily in the report's currency. That confusion was the original bug:
 *  `rules.ts` printed a CAD-set limit with the report's currency and it read as
 *  though it had been converted. */
function moneyIn(amount: MinorAmount, code: string, context: PolicyContext) {
  return formatMinor(amount, code, minorUnitOf(context, code));
}

type Comparable =
  | { ok: true; amount: bigint; basis: RateBasis; rate: bigint; asOf: string }
  | { ok: false; from: string; to: string };

/**
 * Put a report-currency amount into the threshold's currency.
 *
 * Returns a miss rather than the unconverted number. That distinction IS the
 * ticket: ExpenseOS's v2 predicate path returns `amountMinor` unchanged when a
 * rate is absent, so 10,000 JPY minor units get compared against a CAD threshold
 * as if no conversion were needed — no INFO, no payload, no signal, and a
 * threshold that silently under- or over-triggers (GAP-AUDIT PE-7).
 */
function toThresholdCurrency(
  context: PolicyContext,
  policy: PolicyRow,
  amount: MinorAmount,
): Comparable {
  const from = context.report.currency_code;
  const to = thresholdCurrency(context, policy);
  const hit = context.rates.find(from, to);
  if (!hit) return { ok: false, from, to };
  return {
    ok: true,
    amount: convertMinor(amount, hit.scaled, minorUnitOf(context, from), minorUnitOf(context, to)),
    basis: hit.basis,
    rate: hit.scaled,
    asOf: hit.asOf,
  };
}

/**
 * The INFO finding a rule emits when it could not convert.
 *
 * Ported from ExpenseOS's built-in limit rules, whose engine header states the
 * rule: limit rules "degrade to `info` severity with a 'rate missing' payload —
 * never silently skip, never crash." The message names both currencies, because
 * the fix is an admin action and "no rate" without the pair is not actionable.
 */
function rateMissingFinding(
  ruleCode: RuleKind,
  lineItemId: string | null,
  findingKey: string,
  miss: { from: string; to: string },
  what: string,
): Finding {
  return {
    ruleCode,
    lineItemId,
    findingKey,
    severity: 'INFO',
    message:
      `${what} could not be checked against the limit: there is no exchange rate from ` +
      `${miss.from} to ${miss.to}, so the two amounts are not comparable. ` +
      `An administrator needs to add one.`,
    data: { fxRateMissing: true, fromCurrency: miss.from, toCurrency: miss.to },
  };
}

function threshold(policy: PolicyRow, name = 'thresholdMinor'): bigint | null {
  const raw = policy.params?.[name];
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return toBigInt(raw as string | number);
  } catch {
    return null;
  }
}

function lineLabel(expense: WorkbenchExpense, description: string | null, category: string | null) {
  return description?.trim() || category || expense.merchant || 'this line item';
}

function expenseLabel(expense: WorkbenchExpense) {
  return expense.merchant?.trim() || 'an expense';
}

/* ── the starter rules ─────────────────────────────────────────────────────── */

const PER_TRANSACTION_LIMIT: RuleDefinition = {
  kind: 'PER_TRANSACTION_LIMIT',
  label: 'Per-transaction limit',
  description:
    'Flags any single line item above the limit. Scope it to one category to give, say, meals a tighter cap than airfare.',
  defaultSeverity: 'WARNING',
  supportsCategoryScope: true,
  params: [
    {
      name: 'thresholdMinor',
      label: 'Limit',
      type: 'amount',
      required: true,
      help: 'A line item above this amount raises the violation.',
    },
  ],
  evaluate(context, policy) {
    const limit = threshold(policy);
    if (limit === null) return [];
    const limitCurrency = thresholdCurrency(context, policy);
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        if (policy.category_id && line.category_id !== policy.category_id) continue;
        const amount = toBigInt(line.amount_minor);
        const label = lineLabel(expense, line.description, line.category_label);
        // VX3-2 / PE-1: the LINE is converted into the LIMIT's currency, not the
        // other way round. The limit is what an admin typed and is authoritative
        // in the currency they typed it in; converting it would print a number
        // nobody chose back at them.
        const comparable = toThresholdCurrency(context, policy, amount);
        if (!comparable.ok) {
          findings.push(
            rateMissingFinding('PER_TRANSACTION_LIMIT', line.id, '', comparable, label),
          );
          continue;
        }
        if (comparable.amount <= limit) continue;
        findings.push({
          ruleCode: 'PER_TRANSACTION_LIMIT',
          lineItemId: line.id,
          findingKey: '',
          // Both currencies are named whenever they differ. A sentence that reads
          // "is $700.00, over the $500.00 limit" while one is USD and the other
          // CAD is the sentence that hid this defect in the first place.
          message:
            comparable.basis === 'IDENTITY'
              ? `${label} is ${money(context, amount)}, over the ` +
                `${moneyIn(limit, limitCurrency, context)} per-transaction limit.`
              : `${label} is ${money(context, amount)} — ` +
                `${moneyIn(comparable.amount, limitCurrency, context)} converted — over the ` +
                `${moneyIn(limit, limitCurrency, context)} per-transaction limit.`,
          data: {
            amountMinor: amount.toString(),
            thresholdMinor: limit.toString(),
            thresholdCurrency: limitCurrency,
            convertedMinor: comparable.amount.toString(),
            rateBasis: comparable.basis,
            rateAsOf: comparable.asOf,
          },
        });
      }
    }
    return findings;
  },
};

const RECEIPT_REQUIRED: RuleDefinition = {
  kind: 'RECEIPT_REQUIRED',
  label: 'Receipt required',
  description:
    'Flags an expense with no receipt attached. Set a limit to require receipts only above an amount.',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: true,
  params: [
    {
      name: 'thresholdMinor',
      label: 'Only above',
      type: 'amount',
      required: false,
      help: 'Leave blank to require a receipt on every expense.',
    },
  ],
  evaluate(context, policy) {
    const floor = threshold(policy);
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      if (expense.receipts.length > 0) continue;
      const lines = policy.category_id
        ? expense.lineItems.filter((line) => line.category_id === policy.category_id)
        : expense.lineItems;
      // A scoped rule only speaks to expenses that carry its category.
      if (policy.category_id && lines.length === 0) continue;
      const subtotal = lines.reduce((sum, line) => sum + toBigInt(line.amount_minor), 0n);

      // No floor means "every expense needs a receipt", which is a rule about
      // presence and not about an amount — so it needs no conversion and must not
      // be able to degrade to INFO over a missing rate. Checking this BEFORE
      // converting is the difference between a BLOCK that always fires and one a
      // missing reference row can quietly turn into a note.
      if (floor === null) {
        findings.push({
          ruleCode: 'RECEIPT_REQUIRED',
          lineItemId: null,
          // One finding per expense — this is why finding_key exists.
          findingKey: expense.id,
          message: `${expenseLabel(expense)} has no receipt attached.`,
          data: { expenseId: expense.id, subtotalMinor: subtotal.toString() },
        });
        continue;
      }

      const floorCurrency = thresholdCurrency(context, policy);
      const comparable = toThresholdCurrency(context, policy, subtotal);
      if (!comparable.ok) {
        findings.push(
          rateMissingFinding(
            'RECEIPT_REQUIRED',
            null,
            expense.id,
            comparable,
            expenseLabel(expense),
          ),
        );
        continue;
      }
      if (comparable.amount <= floor) continue;
      findings.push({
        ruleCode: 'RECEIPT_REQUIRED',
        lineItemId: null,
        findingKey: expense.id,
        message:
          comparable.basis === 'IDENTITY'
            ? `${expenseLabel(expense)} is ${money(context, subtotal)} and has no receipt ` +
              `attached (receipts required above ${moneyIn(floor, floorCurrency, context)}).`
            : `${expenseLabel(expense)} is ${money(context, subtotal)} — ` +
              `${moneyIn(comparable.amount, floorCurrency, context)} converted — and has no ` +
              `receipt attached (receipts required above ` +
              `${moneyIn(floor, floorCurrency, context)}).`,
        data: {
          expenseId: expense.id,
          subtotalMinor: subtotal.toString(),
          thresholdMinor: floor.toString(),
          thresholdCurrency: floorCurrency,
          convertedMinor: comparable.amount.toString(),
          rateBasis: comparable.basis,
          rateAsOf: comparable.asOf,
        },
      });
    }
    return findings;
  },
};

const CATEGORY_ACTIVE: RuleDefinition = {
  kind: 'CATEGORY_ACTIVE',
  label: 'Category must be active',
  description:
    'Flags a line item coded to a category the tenant has retired. Catches reports left in draft across a chart-of-accounts change.',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        if (line.category_active !== false) continue;
        findings.push({
          ruleCode: 'CATEGORY_ACTIVE',
          lineItemId: line.id,
          findingKey: '',
          message: `${lineLabel(expense, line.description, line.category_label)} is coded to ${
            line.category_label ?? 'a category'
          }, which is no longer active. Recode it.`,
          data: { categoryId: line.category_id },
        });
      }
    }
    return findings;
  },
};

const NON_NEGATIVE_AMOUNT: RuleDefinition = {
  kind: 'NON_NEGATIVE_AMOUNT',
  label: 'No negative amounts',
  description:
    'Flags a line item below zero. Credits and refunds belong on the original report, not as a negative line.',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        const amount = toBigInt(line.amount_minor);
        if (amount >= 0n) continue;
        findings.push({
          ruleCode: 'NON_NEGATIVE_AMOUNT',
          lineItemId: line.id,
          findingKey: '',
          message: `${lineLabel(expense, line.description, line.category_label)} is ${money(
            context,
            amount,
          )}. Line items cannot be negative.`,
          data: { amountMinor: amount.toString() },
        });
      }
    }
    return findings;
  },
};

/**
 * Report spend that pushes a budget period past its budget.
 *
 * ── WARNING, and here that is enforced rather than commented ────────────────
 *
 * ExpenseOS's own reasoning, kept: "the money on a card has already left, and an
 * unsubmittable claim strands a real expense — the answer to over-budget spend is
 * routing it to somebody who can decide about it, not refusing to file it." John
 * settled the same decision for us on 31 Aug. Theirs is a comment their engine
 * then ignores (BG-4); ours is `maxSeverity`, which the write refuses to exceed
 * and the read clamps.
 *
 * ── ONE finding per budget period, which is the OPPOSITE of theirs ──────────
 *
 * Their kind emits a single collapsed finding for the whole report, and its
 * comment explains why it has to: their violation identity is
 * `(ruleCode, lineItemId)`, so a second report-level finding from the same
 * instance is silently dropped and a justification would attach to whichever row
 * happened to be first. `policy_violation.finding_key` (VX1-7) exists precisely to
 * fix that defect, so the constraint that forced their shape does not apply here —
 * and the finer shape is the better product: an acknowledgement carries a NOTE,
 * and one note waving through "the travel budget and the marketing budget
 * together" tells an auditor nothing about either.
 *
 * ── The comparison, ported ──────────────────────────────────────────────────
 *
 * Against APPROVED + SUBMITTED + this report, not approved spend alone. Their
 * `crossedThreshold` says why: "warning somebody at 90% while an already-submitted
 * report would take them to 110% is worse than not warning them, because it reads
 * as headroom."
 *
 * Configurable thresholds (warn at 90%) are BG-6's alert concern and arrive in
 * part 3 with the alert table and the screen that edits them. This rule answers
 * one question — does this report put the period over — so it has no params.
 */
const BUDGET_OVERAGE: RuleDefinition = {
  kind: 'BUDGET_OVERAGE',
  label: 'Over budget',
  description:
    'Flags a report whose spend takes a budget period past its budget, counting what is already approved and what is still awaiting a decision. Warns; it never blocks.',
  defaultSeverity: 'WARNING',
  maxSeverity: 'WARNING',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const budget of context.budgets) {
      const scope = `${budget.budgetName} (${budget.startsOn} to ${budget.endsOn})`;
      const amount = (value: bigint) =>
        formatMinor(value, budget.currencyCode, budget.minorUnit);

      // The overage, when there is one. Certain even if some spend could not be
      // converted: unconvertible spend can only ADD, so being over stays true.
      const projected = projectedMinor(budget);
      if (budget.amountMinor > 0n && projected > budget.amountMinor) {
        findings.push({
          ruleCode: 'BUDGET_OVERAGE',
          lineItemId: null,
          findingKey: `${budget.budgetId}|${budget.periodId}`,
          message:
            `This report takes ${scope} to ${amount(projected)} against a budget of ` +
            `${amount(budget.amountMinor)} — over by ${amount(projected - budget.amountMinor)}. ` +
            `${amount(budget.actualMinor)} is already approved, ${amount(budget.pendingMinor)} ` +
            `is awaiting a decision, and this report adds ${amount(budget.reportMinor)}.`,
          data: {
            budgetId: budget.budgetId,
            periodId: budget.periodId,
            currencyCode: budget.currencyCode,
            amountMinor: budget.amountMinor.toString(),
            projectedMinor: projected.toString(),
            overageMinor: (projected - budget.amountMinor).toString(),
            actualMinor: budget.actualMinor.toString(),
            pendingMinor: budget.pendingMinor.toString(),
            reportMinor: budget.reportMinor.toString(),
          },
        });
      }

      // A SEPARATE finding, with its own key, so it can coexist with the overage
      // above rather than one silently replacing the other. AN-7 inverted: a
      // number built on spend that could not be converted is a FLOOR, and saying
      // so is the difference between "I cannot answer" and "you are fine".
      if (!hasUnconvertible(budget)) continue;
      const missing = budget.reportMissingRateFrom;
      findings.push({
        ruleCode: 'BUDGET_OVERAGE',
        lineItemId: null,
        findingKey: `${budget.budgetId}|${budget.periodId}|fx`,
        severity: 'INFO',
        message:
          `Some spend counted against ${scope} could not be converted into ` +
          `${budget.currencyCode}, so ${amount(projected)} is a floor rather than a total` +
          (missing.length > 0
            ? `. This report has spend in ${missing.join(', ')} with no exchange rate to ` +
              `${budget.currencyCode}; an administrator needs to add one.`
            : `. Earlier spend on this budget is affected; an administrator needs to add the ` +
              `missing exchange rates.`),
        data: {
          budgetId: budget.budgetId,
          periodId: budget.periodId,
          fxRateMissing: true,
          toCurrency: budget.currencyCode,
          reportMissingRateFrom: missing,
          unconvertibleMinor: budget.unconvertibleMinor.toString(),
        },
      });
    }
    return findings;
  },
};

export const RULE_DEFINITIONS: Record<RuleKind, RuleDefinition> = {
  PER_TRANSACTION_LIMIT,
  RECEIPT_REQUIRED,
  CATEGORY_ACTIVE,
  NON_NEGATIVE_AMOUNT,
  BUDGET_OVERAGE,
};

export function ruleDefinition(kind: RuleKind): RuleDefinition {
  return RULE_DEFINITIONS[kind];
}

/**
 * The starter set a tenant gets from "Restore starter rules" on the admin page.
 * This is the ONLY definition of the defaults — `scripts/seed.mjs` deliberately
 * does not seed policies, so there is nothing to drift out of step with.
 */
export const DEFAULT_POLICIES: Array<{
  kind: RuleKind;
  severity: Severity;
  params: Record<string, unknown>;
}> = [
  { kind: 'PER_TRANSACTION_LIMIT', severity: 'WARNING', params: { thresholdMinor: 50000 } },
  { kind: 'RECEIPT_REQUIRED', severity: 'BLOCK', params: { thresholdMinor: 2500 } },
  { kind: 'CATEGORY_ACTIVE', severity: 'BLOCK', params: {} },
  { kind: 'NON_NEGATIVE_AMOUNT', severity: 'BLOCK', params: {} },
  // BUDGET_OVERAGE is deliberately NOT here. A fresh tenant has no budgets, so a
  // starter instance would be a rule that cannot fire — and a rule on the admin
  // page that never says anything trains people to ignore the page. It is created
  // alongside a budget, on part 3's screen.
];

/** A finding plus the rule instance that raised it — severity lives on the instance. */
export interface EvaluatedFinding {
  policy: PolicyRow;
  finding: Finding;
}

/** Runs every enabled rule instance over one report snapshot. */
export function evaluatePolicies(
  context: PolicyContext,
  policies: PolicyRow[],
): EvaluatedFinding[] {
  const results: EvaluatedFinding[] = [];
  for (const policy of policies) {
    const definition = RULE_DEFINITIONS[policy.kind];
    if (!definition) continue; // a kind retired from the registry: ignore, don't crash
    for (const finding of definition.evaluate(context, policy)) {
      results.push({ policy, finding });
    }
  }
  return results;
}

/** Identity of a finding — must match migration 0006's unique index exactly. */
export function findingIdentity(ruleCode: string, lineItemId: string | null, findingKey: string) {
  return `${ruleCode}|${lineItemId ?? ''}|${findingKey}`;
}

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
import { convertMinor, toBigInt, type MinorAmount } from '@/lib/money';
import { renderPolicyMessage, type PolicyMessageCode } from '@/lib/i18n/catalog/policy-messages';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
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
  /**
   * Which SENTENCE this is — one per branch, not one per rule. VX4-7 part 2b:
   * five rule kinds emit ten sentences, so `ruleCode` cannot choose among them
   * at render time without re-deriving the branch this rule already took.
   */
  messageCode: PolicyMessageCode;
  /**
   * The sentence in the DEFAULT locale, which `finding()` produces by rendering
   * `messageCode` + `data` — never by hand. That is what makes the stored
   * `policy_violation.message` and the per-reader render incapable of
   * disagreeing: there is one set of words, in
   * `lib/i18n/catalog/policy-messages.ts`, and this is a snapshot of it. Stored
   * as the audit record (0029); the screen renders from the code.
   */
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
  /*
   * NO `label`. It was an English literal here and is now
   * `RULE_PARAM_COPY[ruleParamKey(kind, name)]` in `lib/i18n/catalog/enums.ts`,
   * for the same reason `RuleDefinition.label` moved there in VX4-10 part 4: it
   * was read only by `lib/policy/service.ts`, which put it verbatim into a
   * CATALOGUED refusal — so a French reader got a French sentence with an English
   * word inside it.
   *
   * A rule definition is the evaluator. Copy belongs where a locale can reach it.
   */
  type: 'amount' | 'boolean';
  required: boolean;
  help?: string;
}

export interface RuleDefinition {
  kind: RuleKind;
  /*
   * NO `label` AND NO `description`, deliberately, and their removal is VX4-10
   * part 4's actual content.
   *
   * They used to live here as English literals, and `lib/i18n/catalog/enums.ts`
   * separately held `RULE_KIND_COPY` — a second list of the same five names,
   * built in VX4-7 part 2a, covered by the union, tested, and read by nothing but
   * its own test. The pair had already drifted on two members: this file said "No
   * negative amounts" and "Over budget" where the catalogue said "Amount cannot be
   * negative" and "Budget overage". A reader only ever saw this file's, because
   * this file's is what the screen and the eight refusals in `service.ts` used.
   *
   * One list now, in the catalogue, where a locale can reach it. Anything wanting
   * a rule's NAME calls `enumLabel(RULE_KIND_COPY, kind, locale)`; anything
   * wanting its SENTENCE calls `enumLabel(RULE_DESCRIPTION_COPY, kind, locale)`.
   *
   * A rule definition still has no business holding copy: it is the evaluator,
   * and every field left below is something the evaluator or the form needs.
   */
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

/**
 * Build a finding. THE ONLY WAY ONE IS BUILT — the `Finding` object literal does
 * not appear anywhere below.
 *
 * `message` is rendered here from `messageCode` + `data` at the default locale,
 * so the stored English and the per-reader render cannot drift: they are the
 * same function of the same inputs. Before part 2b each rule wrote its sentence
 * inline, which would have made the catalogue a SECOND copy of the copy — and
 * part 2a is the evidence for how that ends (three sentences quietly reworded
 * behind a comment claiming a verbatim port).
 *
 * It also means a `data` key the sentence needs and the rule forgot is visible
 * immediately: `message` comes back as `{LIMIT_EXCEEDED}` and every test that
 * looks at a message fails. That is UD-5 requirement 3 landing at the point of
 * WRITE as well as the point of read.
 */
function finding(
  ruleCode: RuleKind,
  messageCode: PolicyMessageCode,
  parts: {
    lineItemId: string | null;
    findingKey: string;
    severity?: Severity;
    data: Record<string, unknown>;
  },
): Finding {
  return {
    ruleCode,
    messageCode,
    lineItemId: parts.lineItemId,
    findingKey: parts.findingKey,
    ...(parts.severity === undefined ? {} : { severity: parts.severity }),
    message: renderPolicyMessage(messageCode, parts.data, DEFAULT_LOCALE),
    data: parts.data,
  };
}

/**
 * The report's own currency and its minor unit, as render inputs.
 *
 * These go INTO `data` rather than being looked up when the violation is
 * displayed, and that is deliberate: a render happens months later, from a row,
 * with no report loaded and no guarantee the report still says what it did. A
 * finding is a statement about a moment, so it carries the facts that moment
 * needs.
 */
function reportMoney(context: PolicyContext) {
  return {
    currencyCode: context.report.currency_code,
    minorUnit: context.report.minor_unit,
  };
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

/**
 * The THRESHOLD's currency and minor unit, as render inputs.
 *
 * A threshold is not necessarily in the report's currency, and conflating the
 * two was the original PE-1 bug: `rules.ts` printed a CAD-set limit with the
 * report's currency and it read as though it had been converted. Part 2b keeps
 * that separation by carrying BOTH pairs in `data`, so the sentence formats each
 * amount in the currency it is actually denominated in — which is the only way a
 * reader in another locale gets a correct sentence rather than a
 * consistent-looking wrong one.
 */
function thresholdMoney(context: PolicyContext, code: string) {
  return { thresholdCurrency: code, thresholdMinorUnit: minorUnitOf(context, code) };
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
  return finding(ruleCode, 'RATE_MISSING', {
    lineItemId,
    findingKey,
    severity: 'INFO',
    data: { label: what, fxRateMissing: true, fromCurrency: miss.from, toCurrency: miss.to },
  });
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
  defaultSeverity: 'WARNING',
  supportsCategoryScope: true,
  params: [
    {
      name: 'thresholdMinor',
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
        // Two CODES rather than one code and a conditional sentence. Both
        // currencies are named whenever they differ — a sentence reading "is
        // $700.00, over the $500.00 limit" while one is USD and the other CAD is
        // the sentence that hid this defect in the first place — and which of the
        // two shapes applies is a decision this rule is making right now, with
        // the conversion in hand. Recording it beats re-deriving it from `data`
        // at render time, months later, in another module.
        findings.push(
          finding(
            'PER_TRANSACTION_LIMIT',
            comparable.basis === 'IDENTITY' ? 'LIMIT_EXCEEDED' : 'LIMIT_EXCEEDED_CONVERTED',
            {
              lineItemId: line.id,
              findingKey: '',
              data: {
                label,
                ...reportMoney(context),
                ...thresholdMoney(context, limitCurrency),
                amountMinor: amount.toString(),
                thresholdMinor: limit.toString(),
                convertedMinor: comparable.amount.toString(),
                rateBasis: comparable.basis,
                rateAsOf: comparable.asOf,
              },
            },
          ),
        );
      }
    }
    return findings;
  },
};

const RECEIPT_REQUIRED: RuleDefinition = {
  kind: 'RECEIPT_REQUIRED',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: true,
  params: [
    {
      name: 'thresholdMinor',
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
        findings.push(
          finding('RECEIPT_REQUIRED', 'RECEIPT_MISSING', {
            lineItemId: null,
            // One finding per expense — this is why finding_key exists.
            findingKey: expense.id,
            data: {
              label: expenseLabel(expense),
              ...reportMoney(context),
              expenseId: expense.id,
              subtotalMinor: subtotal.toString(),
            },
          }),
        );
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
      findings.push(
        finding(
          'RECEIPT_REQUIRED',
          comparable.basis === 'IDENTITY'
            ? 'RECEIPT_MISSING_ABOVE'
            : 'RECEIPT_MISSING_ABOVE_CONVERTED',
          {
            lineItemId: null,
            findingKey: expense.id,
            data: {
              label: expenseLabel(expense),
              ...reportMoney(context),
              ...thresholdMoney(context, floorCurrency),
              expenseId: expense.id,
              subtotalMinor: subtotal.toString(),
              thresholdMinor: floor.toString(),
              convertedMinor: comparable.amount.toString(),
              rateBasis: comparable.basis,
              rateAsOf: comparable.asOf,
            },
          },
        ),
      );
    }
    return findings;
  },
};

const CATEGORY_ACTIVE: RuleDefinition = {
  kind: 'CATEGORY_ACTIVE',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        if (line.category_active !== false) continue;
        findings.push(
          finding('CATEGORY_ACTIVE', 'CATEGORY_INACTIVE', {
            lineItemId: line.id,
            findingKey: '',
            data: {
              label: lineLabel(expense, line.description, line.category_label),
              // The `?? 'a category'` fallback used to live in the sentence. It
              // belongs HERE, where the category row is in hand: a renderer
              // choosing a noun for absent data is a renderer inventing content,
              // and it hides that the label was never loaded.
              categoryLabel: line.category_label ?? 'a category',
              categoryId: line.category_id,
            },
          }),
        );
      }
    }
    return findings;
  },
};

const NON_NEGATIVE_AMOUNT: RuleDefinition = {
  kind: 'NON_NEGATIVE_AMOUNT',
  defaultSeverity: 'BLOCK',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        const amount = toBigInt(line.amount_minor);
        if (amount >= 0n) continue;
        findings.push(
          finding('NON_NEGATIVE_AMOUNT', 'NEGATIVE_AMOUNT', {
            lineItemId: line.id,
            findingKey: '',
            data: {
              label: lineLabel(expense, line.description, line.category_label),
              ...reportMoney(context),
              amountMinor: amount.toString(),
            },
          }),
        );
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
  defaultSeverity: 'WARNING',
  maxSeverity: 'WARNING',
  supportsCategoryScope: false,
  params: [],
  evaluate(context) {
    const findings: Finding[] = [];
    for (const budget of context.budgets) {
      // The budget's OWN currency and unit, not the report's — every amount in
      // both sentences below is denominated in the budget, which is the point of
      // `lib/budgets/service.ts` converting before this rule ever runs.
      const scope = {
        budgetName: budget.budgetName,
        startsOn: budget.startsOn,
        endsOn: budget.endsOn,
        currencyCode: budget.currencyCode,
        minorUnit: budget.minorUnit,
      };

      // The overage, when there is one. Certain even if some spend could not be
      // converted: unconvertible spend can only ADD, so being over stays true.
      const projected = projectedMinor(budget);
      if (budget.amountMinor > 0n && projected > budget.amountMinor) {
        findings.push(
          finding('BUDGET_OVERAGE', 'BUDGET_EXCEEDED', {
            lineItemId: null,
            findingKey: `${budget.budgetId}|${budget.periodId}`,
            data: {
              ...scope,
              budgetId: budget.budgetId,
              periodId: budget.periodId,
              amountMinor: budget.amountMinor.toString(),
              projectedMinor: projected.toString(),
              overageMinor: (projected - budget.amountMinor).toString(),
              actualMinor: budget.actualMinor.toString(),
              pendingMinor: budget.pendingMinor.toString(),
              reportMinor: budget.reportMinor.toString(),
            },
          }),
        );
      }

      // A SEPARATE finding, with its own key, so it can coexist with the overage
      // above rather than one silently replacing the other. AN-7 inverted: a
      // number built on spend that could not be converted is a FLOOR, and saying
      // so is the difference between "I cannot answer" and "you are fine".
      if (!hasUnconvertible(budget)) continue;
      const missing = budget.reportMissingRateFrom;
      findings.push(
        finding('BUDGET_OVERAGE', 'BUDGET_FLOOR_FX', {
          lineItemId: null,
          findingKey: `${budget.budgetId}|${budget.periodId}|fx`,
          severity: 'INFO',
          data: {
            ...scope,
            budgetId: budget.budgetId,
            periodId: budget.periodId,
            projectedMinor: projected.toString(),
            fxRateMissing: true,
            // Kept beside `currencyCode`, which now carries the same value:
            // `toCurrency` is what the FX-diagnostic half of `data` has always
            // been called (`rateMissingFinding` writes it too), and an admin
            // grepping their logs for one missing pair should not have to know
            // which finding they are looking at.
            toCurrency: budget.currencyCode,
            reportMissingRateFrom: missing,
            unconvertibleMinor: budget.unconvertibleMinor.toString(),
          },
        }),
      );
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

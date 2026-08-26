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
import { formatMinor, toBigInt } from '@/lib/money';
import type { WorkbenchExpense, WorkbenchReport } from '@/lib/expenses/service';

export const RULE_KINDS = [
  'PER_TRANSACTION_LIMIT',
  'RECEIPT_REQUIRED',
  'CATEGORY_ACTIVE',
  'NON_NEGATIVE_AMOUNT',
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

/** A rule instance as stored. `params` is validated per kind by the service. */
export interface PolicyRow {
  id: string;
  kind: RuleKind;
  severity: Severity;
  enabled: boolean;
  category_id: string | null;
  category_label?: string | null;
  params: Record<string, unknown>;
  effective_from: Date | string | null;
  effective_to: Date | string | null;
  created_at: Date;
  updated_at: Date;
}

/** What the rules see. Exactly the shape `getReportWorkbench` already returns. */
export interface PolicyContext {
  report: WorkbenchReport;
  expenses: WorkbenchExpense[];
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
  /** Whether a rule instance may be narrowed to one expense category. */
  supportsCategoryScope: boolean;
  params: ParamSpec[];
  evaluate(context: PolicyContext, policy: PolicyRow): Finding[];
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function money(context: PolicyContext, amount: string | number | bigint) {
  return formatMinor(amount, context.report.currency_code, context.report.minor_unit);
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
    const findings: Finding[] = [];
    for (const expense of context.expenses) {
      for (const line of expense.lineItems) {
        if (policy.category_id && line.category_id !== policy.category_id) continue;
        const amount = toBigInt(line.amount_minor);
        if (amount <= limit) continue;
        findings.push({
          ruleCode: 'PER_TRANSACTION_LIMIT',
          lineItemId: line.id,
          findingKey: '',
          message: `${lineLabel(expense, line.description, line.category_label)} is ${money(
            context,
            amount,
          )}, over the ${money(context, limit)} per-transaction limit.`,
          data: { amountMinor: amount.toString(), thresholdMinor: limit.toString() },
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
      if (floor !== null && subtotal <= floor) continue;
      findings.push({
        ruleCode: 'RECEIPT_REQUIRED',
        lineItemId: null,
        // One finding per expense — this is why finding_key exists.
        findingKey: expense.id,
        message:
          floor === null
            ? `${expenseLabel(expense)} has no receipt attached.`
            : `${expenseLabel(expense)} is ${money(context, subtotal)} and has no receipt attached (receipts required above ${money(context, floor)}).`,
        data: { expenseId: expense.id, subtotalMinor: subtotal.toString() },
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

export const RULE_DEFINITIONS: Record<RuleKind, RuleDefinition> = {
  PER_TRANSACTION_LIMIT,
  RECEIPT_REQUIRED,
  CATEGORY_ACTIVE,
  NON_NEGATIVE_AMOUNT,
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

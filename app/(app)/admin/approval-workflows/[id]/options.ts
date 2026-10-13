/**
 * Shared editor option shapes + predicate field metadata. The `options` tRPC
 * endpoint feeds the pickers; these helpers turn a predicate field + raw value
 * into a human label (resolving id-valued fields against the option lists) and
 * expose the enum facets a field offers. Used by ConditionBar, CriteriaPills,
 * and NodeConfigPanel so labels stay consistent everywhere.
 */

import { PREDICATE_FIELDS, type PredicateField, type PredicateOp } from '@expenseos/approvals';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';

/** Predicate fields the engine does NOT populate for a given subject, so the
 *  condition builder shouldn't offer them (a condition on them would silently
 *  never match). Expense reports have no vendor / spend-interval; VCC requests
 *  have no line items, so the report-only category/compliance facts are hidden. */
const REPORT_ONLY_FIELDS = [
  'categoryIds',
  'requiresApproval',
  'hasPolicyViolation',
  'lineCount',
  'maxLineAmount',
  'overPerDiem',
  'perDiemOverageMinor',
  // Budgets are hit by filed spend. A card request is a request for a limit,
  // and a travel request is a plan — neither has landed on a budget yet.
  'overBudget',
  'budgetOverageMinor',
] as const satisfies readonly PredicateField[];

// VeloExpense: w4-01 also hid `requiresApproval` and the budget pair on a report while the
// engine stated them rather than computed them; since w4-04 it computes all three
// (packages/approvals/src/engine.ts), so the list is ExpenseOS's again.
const SUBJECT_HIDDEN_FIELDS: Record<string, readonly PredicateField[]> = {
  EXPENSE_REPORT: ['interval', 'vendorId'],
  VIRTUAL_CARD_REQUEST: REPORT_ONLY_FIELDS,
};

/** The predicate fields selectable in the condition builder for `subjectType`
 *  (all fields minus the ones the engine leaves null for that subject). */
export function fieldsForSubject(subjectType: string | undefined): PredicateField[] {
  const hidden = new Set(subjectType ? (SUBJECT_HIDDEN_FIELDS[subjectType] ?? []) : []);
  return PREDICATE_FIELDS.filter((f) => !hidden.has(f));
}

/** Lightweight {value,label} option (the design-system FacetOption is only
 *  exposed via a subpath; we only need these two fields). */
export interface FacetOption {
  value: string;
  label: string;
}

export interface EditorOptions {
  jobLevels: { id: string; code: string; label: unknown; sortOrder: number }[];
  departments: { id: string; label: unknown }[];
  legalEntities: { id: string; label: unknown }[];
  businessUnits: { id: string; label: unknown }[];
  currencies: { id: string; code: string; symbol: string }[];
  vendors: { id: string; name: string }[];
  workflows: { key: string; name: string }[];
  roles: { id: string; label: unknown }[];
  categories: { id: string; label: unknown }[];
  /** Active people, for the approver's no-manager fallback picker. */
  users: { id: string; firstName: string | null; lastName: string | null; email: string }[];
}

export const FIELD_LABEL: Record<PredicateField, string> = {
  amount: 'Amount',
  currency: 'Currency',
  interval: 'Limit interval',
  vendorId: 'Vendor',
  departmentId: 'Department',
  jobLevelId: 'Job level',
  legalEntityId: 'Legal entity',
  businessUnitId: 'Business unit',
  glAccountId: 'GL account',
  employeeStatus: 'Employee status',
  userId: 'User',
  categoryIds: 'Expense category',
  requiresApproval: 'Approval-required category',
  hasPolicyViolation: 'Has policy warning',
  lineCount: 'Line-item count',
  maxLineAmount: 'Largest line amount',
  overPerDiem: 'Over per-diem',
  perDiemOverageMinor: 'Per-diem overage',
  overBudget: 'Over budget',
  budgetOverageMinor: 'Budget overage',
};

export const OP_LABEL: Record<PredicateOp, string> = {
  eq: '=',
  neq: '≠',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  in: 'is any of',
  nin: 'is none of',
};

/** Spend-interval enum values, humanized (mirrors VirtualCardSpendInterval). */
const INTERVAL_FACETS: FacetOption[] = [
  { value: 'ONE_TIME', label: 'One-time' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'TOTAL', label: 'Total' },
];

/** Employee-status enum values (mirrors EmployeeStatus).
 *  VeloExpense: `app_user.employee_status` is ACTIVE | ON_LEAVE | DEACTIVATED (0004), so
 *  ExpenseOS's TERMINATED — a value no person here can hold — is not offered. */
const EMPLOYEE_STATUS_FACETS: FacetOption[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'DEACTIVATED', label: 'Deactivated' },
];

/** Boolean facts are stored as the strings 'true' / 'false'. */
const YES_NO_FACETS: FacetOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

export const APPROVER_KIND_LABEL: Record<'manager' | 'managerChain' | 'filter', string> = {
  manager: 'Direct manager',
  managerChain: 'Manager ancestor',
  filter: 'Custom filter',
};

/** Fields a `filter` approver matches against the candidate approver's own
 *  attributes (job-level ordering is the dedicated min-level control). */
export const APPROVER_FILTER_FIELDS: PredicateField[] = [
  'departmentId',
  'jobLevelId',
  'legalEntityId',
  'businessUnitId',
  'employeeStatus',
  'userId',
];

/** Numeric field — its value is a free-typed number, not picked from a list. */
export function isNumericField(field: PredicateField): boolean {
  return (
    field === 'amount' ||
    field === 'maxLineAmount' ||
    field === 'lineCount' ||
    field === 'perDiemOverageMinor' ||
    field === 'budgetOverageMinor'
  );
}

/** Operators valid for a field's type. Numeric fields compare; enum/id/list
 *  fields only do equality + set membership (so e.g. a Department can't be
 *  "greater than or equals"). */
export function opsForField(field: PredicateField): PredicateOp[] {
  return isNumericField(field)
    ? ['eq', 'neq', 'lt', 'lte', 'gt', 'gte']
    : ['eq', 'neq', 'in', 'nin'];
}

/** The enum facets a field offers, or `null` for free-text / numeric fields
 *  (and id fields with no option source yet — legal entity, BU, GL, user). */
export function fieldFacets(
  field: PredicateField,
  options: EditorOptions | undefined,
  locale: Locale,
): FacetOption[] | null {
  switch (field) {
    case 'interval':
      return INTERVAL_FACETS;
    case 'currency':
      return (options?.currencies ?? []).map((c) => ({ value: c.id, label: c.code }));
    case 'vendorId':
      return (options?.vendors ?? []).map((v) => ({ value: v.id, label: v.name }));
    case 'departmentId':
      return (options?.departments ?? []).map((d) => ({
        value: d.id,
        label: (getLocalized(d.label, locale) ?? d.id) as string,
      }));
    case 'jobLevelId':
      return (options?.jobLevels ?? []).map((j) => ({
        value: j.id,
        label: `${j.code} — ${getLocalized(j.label, locale) ?? j.code}`,
      }));
    case 'legalEntityId':
      return (options?.legalEntities ?? []).map((e) => ({
        value: e.id,
        label: (getLocalized(e.label, locale) ?? e.id) as string,
      }));
    case 'businessUnitId':
      return (options?.businessUnits ?? []).map((b) => ({
        value: b.id,
        label: (getLocalized(b.label, locale) ?? b.id) as string,
      }));
    case 'employeeStatus':
      return EMPLOYEE_STATUS_FACETS;
    case 'categoryIds':
      return (options?.categories ?? []).map((c) => ({
        value: c.id,
        label: (getLocalized(c.label, locale) ?? c.id) as string,
      }));
    case 'requiresApproval':
    case 'hasPolicyViolation':
    case 'overPerDiem':
    case 'overBudget':
      return YES_NO_FACETS;
    default:
      return null;
  }
}

/** Display a single predicate value (resolving an id to its label). */
export function labelForValue(
  field: PredicateField,
  value: string,
  options: EditorOptions | undefined,
  locale: Locale,
): string {
  const facets = fieldFacets(field, options, locale);
  return facets?.find((f) => f.value === value)?.label ?? value;
}

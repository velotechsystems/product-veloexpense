/**
 * Filter-clause types used by `<FilterBlock>` + `<AddFilterPill>`. These are
 * the data shape behind the pill-bar UX (the visible chips above a data
 * table), one clause per (field, op, value) tuple. Distinct from the
 * column-header filter types in `../data-table/types.ts`, which model an
 * already-aggregated per-column filter via a discriminated union.
 */

// ─── Filter operators ────────────────────────────────────────────

export type FilterOp =
  | 'equals'
  | 'doesNotEqual'
  | 'contains'
  | 'doesNotContain'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  // Date-kind comparison ops (see dateFilter.ts for value encoding).
  | 'on'
  | 'before'
  | 'after'
  | 'between'
  | 'within';

export const OP_LABELS: Record<FilterOp, string> = {
  equals: 'equals',
  doesNotEqual: "doesn't equal",
  contains: 'contains',
  doesNotContain: "doesn't contain",
  startsWith: 'starts with',
  endsWith: 'ends with',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  on: 'on',
  before: 'before',
  after: 'after',
  between: 'between',
  within: 'is',
};

/** Ops that don't carry a value — UI hides the value pill / add-value
 *  affordance for these. */
export const VALUELESS_OPS = new Set<FilterOp>(['isEmpty', 'isNotEmpty']);

export type FieldKind = 'enum' | 'text' | 'date';

export const OPS_BY_KIND: Record<FieldKind, FilterOp[]> = {
  enum: ['equals', 'doesNotEqual', 'isEmpty', 'isNotEmpty'],
  // `contains` leads — it's the intuitive default for free-text search
  // (typing part of a name/email should match), and the first op is what
  // `<AddFilterPill>` selects by default when a text field is chosen.
  text: [
    'contains',
    'doesNotContain',
    'equals',
    'doesNotEqual',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty',
  ],
  // `within` (relative presets) leads — it's the most common date filter.
  date: ['within', 'on', 'before', 'after', 'between'],
};

// ─── Clause ──────────────────────────────────────────────────────

export interface FilterClause<F extends string = string> {
  id: string;
  field: F;
  op: FilterOp;
  value: string;
}

/** Stable id generator for new clauses. */
export function newClauseId(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Facet option (for enum-kind fields) ─────────────────────────

export interface FacetOption {
  value: string;
  label: string;
  /** Optional facet count rendered alongside the label. */
  count?: number;
}

/**
 * Copy for the filter-pill chrome.
 *
 * These strings were hardcoded English inside `FilterBlock`, so a French reader saw
 * "Add filter" three times on one page among otherwise translated tiles (GA readiness
 * report F43). They were invisible to `check-used-keys` for the reason that made them easy
 * to miss: they are not catalog keys at all, so no coverage tool had anything to look for.
 *
 * The design system deliberately takes no next-intl dependency — the same reason
 * `DataTableLabels` exists — so the host app supplies these, and the defaults below keep
 * every existing caller working unchanged.
 */
export interface FilterLabels {
  addFilter: string;
  field: string;
  operator: string;
  value: string;
  valuePlaceholder: string;
  /** Add-form placeholder for a free-text operator. */
  typeAValue: string;
  /** Add-form placeholder when the field offers suggestions. */
  typeOrPick: string;
  add: string;
  cancel: string;
  addValue: string;
  addAnotherValue: string;
  changeOperator: string;
  removeCondition: string;
  removeValue: string;
  lastNDays: string;
  /**
   * The OPERATOR words on a pill — "equals", "contains", "is any of".
   *
   * These were a plain English const rendered directly by `FilterBlock`, so a fr-CA pill read
   * "Statut equals Approuvé": the field and the value translated, the verb between them did
   * not. PR #333 threaded the rest of the filter chrome through this bag and left the
   * operators behind, on all 33 sites (GA readiness report F43).
   */
  ops: Record<FilterOp, string>;
}

/** English defaults, so a caller that passes no labels behaves exactly as before. */
export const DEFAULT_FILTER_LABELS: FilterLabels = {
  ops: OP_LABELS,
  addFilter: 'Add filter',
  field: 'Field',
  operator: 'Operator',
  value: 'Value',
  valuePlaceholder: 'value…',
  typeAValue: 'Type a value…',
  typeOrPick: 'Type or pick…',
  add: 'Add',
  cancel: 'Cancel',
  addValue: 'Add value',
  addAnotherValue: 'Add another value (OR)',
  changeOperator: 'Change operator',
  removeCondition: 'Remove condition',
  removeValue: 'Remove value',
  lastNDays: 'Last N days…',
};

/**
 * Shared types for the rich data-table primitives.
 *
 * These are intentionally generic in `<K>` (the column-id type) and
 * `<V>` (the filter operand type) so each consumer can constrain
 * them to their own column key union.
 */

// ─── Filtering ────────────────────────────────────────────────────

export type FilterOp =
  | 'contains'
  | 'doesNotContain'
  | 'equals'
  | 'doesNotEqual'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isAnyOf'
  | 'isNoneOf';

export type ColumnFilter =
  | { op: 'contains'; value: string }
  | { op: 'doesNotContain'; value: string }
  | { op: 'equals'; value: string }
  | { op: 'doesNotEqual'; value: string }
  | { op: 'startsWith'; value: string }
  | { op: 'endsWith'; value: string }
  | { op: 'isEmpty' }
  | { op: 'isNotEmpty' }
  | { op: 'isAnyOf'; values: string[] }
  | { op: 'isNoneOf'; values: string[] };

/** Tags a filterable column as enum-typed (only `isAnyOf` / `isNoneOf`
 *  apply) or text-typed (all ops). */
export type FilterColumnType = 'enum' | 'text';

export const TEXT_OPS: FilterOp[] = [
  'contains',
  'doesNotContain',
  'equals',
  'doesNotEqual',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'isAnyOf',
];
export const ENUM_OPS: FilterOp[] = ['isAnyOf', 'isNoneOf'];

export const SINGLE_VALUE_OPS: FilterOp[] = [
  'contains',
  'doesNotContain',
  'equals',
  'doesNotEqual',
  'startsWith',
  'endsWith',
];
export const MULTI_VALUE_OPS: FilterOp[] = ['isAnyOf', 'isNoneOf'];
export const NO_VALUE_OPS: FilterOp[] = ['isEmpty', 'isNotEmpty'];

// ─── Sorting ──────────────────────────────────────────────────────

export type SortDir = 'asc' | 'desc';
export interface SortState<F extends string = string> {
  field: F;
  dir: SortDir;
}

// ─── Density ──────────────────────────────────────────────────────

export type Density = 'compact' | 'normal' | 'comfortable';

// ─── i18n bag ─────────────────────────────────────────────────────
//
// The data-table primitives don't depend on a specific i18n library;
// callers pass labels as plain strings via this object. Each consumer
// (People directory, Expense Reports, …) builds it from their own
// next-intl catalog.

export interface DataTableLabels {
  /** Column-action menu strings. */
  colMenu: {
    menu: string;
    sortAsc: string;
    sortDesc: string;
    filter: string;
    hide: string;
    cancel: string;
    clear: string;
    apply: string;
    value: string;
    resize: string;
    removeFilter: string;
    op_contains: string;
    op_doesNotContain: string;
    op_equals: string;
    op_doesNotEqual: string;
    op_startsWith: string;
    op_endsWith: string;
    op_isEmpty: string;
    op_isNotEmpty: string;
    op_isAnyOf: string;
    op_isNoneOf: string;
  };
  /** Table-settings dropdown sections. */
  settings: {
    trigger: string;
    columns: string;
    groupBy: string;
    density: string;
    densityCompact: string;
    densityNormal: string;
    densityComfortable: string;
    resetDefaults: string;
  };
  /** Misc strings used across the table chrome. */
  misc: {
    clearAll: string;
  };
}

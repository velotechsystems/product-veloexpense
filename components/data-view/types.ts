/**
 * Shared types for the SentinelOne-inspired DataView chrome
 * (ViewsBar + FacetRail + ActionStrip + saved-views dropdown).
 *
 * The chrome is directory-agnostic — `Field` is parameterized so
 * /users (people), /expenses, /cards, etc. can reuse the same UI by
 * providing their own field union.
 *
 * Filter-clause + facet types are structurally identical to the ones
 * in `@expenseos/design-system/data-display/filters` (which the moved
 * `<AddFilterPill>` + `<FilterBlock>` use internally). Kept local here
 * so the data-view chrome doesn't need a name-collision dance with the
 * data-table's broader `FilterOp` union.
 */

import type { DirectoryScope } from '@/server/lib/userScope';

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
  // Date-kind comparison ops — mirror of the design-system union.
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
  text: [
    'equals',
    'doesNotEqual',
    'contains',
    'doesNotContain',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty',
  ],
  date: ['within', 'on', 'before', 'after', 'between'],
};

// ─── Clause + persisted view state ───────────────────────────────

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

/** Server-persisted view state. Mirrors viewStateSchema in
 *  apps/web/src/server/routers/savedViews.ts. Kept local (not a
 *  re-export of the DS generic) because the app pins `groupBy` to
 *  the narrow people-domain union for router-schema compatibility,
 *  whereas the DS generic uses `string | null`. The DS components
 *  accept this narrower type structurally via their `<F, S>`
 *  generics. */
export interface PersistedViewState<F extends string = string> {
  scope?: DirectoryScope;
  filters: FilterClause<F>[];
  visibleColumns?: string[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  density?: 'compact' | 'normal' | 'comfortable';
  groupBy?: 'manager' | 'department' | 'businessUnit' | 'status' | null;
}

// ─── Dropdown view kinds ────────────────────────────────────────
// Kept as local definitions (not re-exports of the DS generic) so
// the rest of the app's chain — DataTableState filters, the saved-
// views router schema, EmployeeDirectory.captureViewState — keeps
// using the local FilterClause/FilterOp identity TS already
// computed graph-wide. The DS `<ViewDropdown>`, `<FilterPillBar>`,
// and `<ViewsBar>` accept these structurally via their `<F, S>`
// generics — the shapes are identical, just differently-named
// aliases.

export interface SystemView<F extends string = string> {
  kind: 'system';
  id: string;
  name: string;
  scope?: DirectoryScope;
  filters?: FilterClause<F>[];
}

export interface UserView<F extends string = string> {
  kind: 'user';
  id: string;
  name: string;
  pinned: boolean;
  state: PersistedViewState<F>;
}

export type DropdownView<F extends string = string> = SystemView<F> | UserView<F>;

// ─── Facet option ───────────────────────────────────────────────

export interface FacetOption {
  value: string;
  label: string;
  /** Optional facet count. When provided, the FacetCard renders it
   *  alongside the label (e.g. "Active (1,234)"). When undefined,
   *  no count is shown — useful while the async count query is
   *  still loading or for resources that don't compute counts. */
  count?: number;
}

// ─── Helper: clauses → server filter payload ────────────────────
// Multiple `equals` clauses on the same field collapse to `isAnyOf`;
// `doesNotEqual` collapse to `isNoneOf`. Mixed operator clauses on
// the same field send the FIRST clause only — Phase 1 backend does
// not yet support AND/OR composition.
/** Server-payload shape for a single column. Matches the
 *  `columnFilterSchema` discriminated union in
 *  `apps/web/src/server/routers/users.ts`. */
export type ServerColumnFilter =
  | { op: 'isAnyOf'; values: string[] }
  | { op: 'isNoneOf'; values: string[] }
  | { op: 'isEmpty' }
  | { op: 'isNotEmpty' }
  | {
      op: 'equals' | 'doesNotEqual' | 'contains' | 'doesNotContain' | 'startsWith' | 'endsWith';
      value: string;
    };

export function clausesToServerFilters<F extends string>(
  filters: FilterClause<F>[],
): Partial<Record<F, ServerColumnFilter>> {
  const byField = new Map<F, FilterClause<F>[]>();
  for (const f of filters) {
    if (!byField.has(f.field)) byField.set(f.field, []);
    byField.get(f.field)?.push(f);
  }
  const out: Partial<Record<F, ServerColumnFilter>> = {};
  for (const [field, list] of byField) {
    const allEquals = list.every((c) => c.op === 'equals');
    const allNotEquals = list.every((c) => c.op === 'doesNotEqual');
    if (allEquals) {
      out[field] = { op: 'isAnyOf', values: list.map((c) => c.value) };
    } else if (allNotEquals) {
      out[field] = { op: 'isNoneOf', values: list.map((c) => c.value) };
    } else {
      const first = list[0];
      if (!first) continue;
      const op = first.op;
      if (op === 'isEmpty' || op === 'isNotEmpty') {
        out[field] = { op };
      } else if (
        op === 'equals' ||
        op === 'doesNotEqual' ||
        op === 'contains' ||
        op === 'doesNotContain' ||
        op === 'startsWith' ||
        op === 'endsWith'
      ) {
        out[field] = { op, value: first.value };
      }
      // Date ops (on/before/after/between/within) are resolved client-side
      // into absolute bounds by their own pages and never reach this
      // people-directory aggregator, so there's nothing to map here.
    }
  }
  return out;
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

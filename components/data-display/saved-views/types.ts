/**
 * Saved-views type model — used by `<ViewDropdown>`, `<FilterPillBar>`,
 * and `<ViewsBar>`.
 *
 * Generic over:
 *   - `F` — the field union for the host table (e.g.
 *     'name' | 'email' | 'department' for People).
 *   - `S` — the scope union for the host table (e.g.
 *     'all' | 'direct' | 'chain' for the People directory). When the
 *     host has no scope concept, default to `string` and pass an
 *     empty list of available scopes.
 */

import type { FilterClause } from '../filters/types';

/** Server-persisted view state shape. Consumers project this into
 *  their own router-payload type. */
export interface PersistedViewState<F extends string = string, S extends string = string> {
  scope?: S;
  filters: FilterClause<F>[];
  visibleColumns?: string[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  density?: 'compact' | 'normal' | 'comfortable';
  /** Domain-specific group-by key — typically a field name. */
  groupBy?: string | null;
}

/** Built-in views the host app ships (e.g. "All", "My team"). */
export interface SystemView<F extends string = string, S extends string = string> {
  kind: 'system';
  id: string;
  name: string;
  scope?: S;
  filters?: FilterClause<F>[];
}

/** User-saved views (created via "Save current as new view"). */
export interface UserView<F extends string = string, S extends string = string> {
  kind: 'user';
  id: string;
  name: string;
  pinned: boolean;
  state: PersistedViewState<F, S>;
}

export type DropdownView<F extends string = string, S extends string = string> =
  | SystemView<F, S>
  | UserView<F, S>;

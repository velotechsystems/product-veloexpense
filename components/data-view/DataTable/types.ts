/**
 * `<DataTable<Row>>` — generic, reusable directory-style table.
 *
 * The shape every directory page (people, expenses, cards, …)
 * programs against. The component owns layout, sticky pinning,
 * drag-reorder + FLIP, resize, column visibility, density,
 * selection, and the column header dropdown (sort / filter / pin /
 * auto-size / hide). The consumer provides:
 *
 *   - `columns: ColumnDef<Row>[]`  — domain rendering
 *   - `rows: Row[]`                — data
 *   - `state` + `onStateChange`    — controlled state (URL / saved views)
 *   - `facetCounts?`               — for filter-editor option counts
 *   - `onRowClick?`                — usually opens a detail drawer
 *
 * Bulk actions, scope chips, saved views, and the detail drawer
 * sit OUTSIDE the table — those vary too much per page and are
 * wired by the consumer.
 */

import type { Density, FilterColumnType, RowAction } from '@expenseos/design-system';
import type { ReactNode } from 'react';
import type { FilterClause, FilterOp } from '../types';

// ─── Column definition ─────────────────────────────────────────────

/** Per-column configuration. The `cell` function is the only place
 *  domain rendering lives — everything else is metadata the
 *  DataTable uses to wire its generic chrome. */
export interface ColumnDef<Row, ColumnId extends string = string> {
  /** Stable id used as DOM key, sort field, filter field, pin
   *  toggle, etc. Must be unique within the column list. */
  id: ColumnId;
  /** Header label (already localized by the consumer). */
  label: string;
  /** Initial pixel width. Resizable at runtime — final width lives
   *  in DataTableState.columnWidths. Default 180. */
  defaultWidth?: number;
  /** Sortable on this column. When an object, `serverField` is the
   *  field name passed to the data query when this column drives
   *  the sort. When just `true`, `id` is used as the field name. */
  sortable?: boolean | { serverField: string };
  /** Filterable on this column. `kind: 'enum'` constrains operators
   *  to equals/notEquals (plus isEmpty/isNotEmpty); `kind: 'text'`
   *  unlocks contains/startsWith/endsWith. `options` are the enum
   *  values (also used as the FacetCard's option list and as the
   *  source for the autocomplete datalist on text fields). */
  filterable?: { kind: FilterColumnType; options?: Array<{ value: string; label: string }> };
  /** When true, shown as a card in the facet rail. Implies
   *  `filterable`. Default false. */
  facet?: boolean;
  /** When true, user can hide/show the column via the gear menu.
   *  Default true. Set false for the row-identification column. */
  hideable?: boolean;
  /** When true, user can drag the column header to reorder.
   *  Default true. Pinned columns are non-draggable automatically. */
  draggable?: boolean;
  /** When true, user can resize via the right-edge handle. Default
   *  true. */
  resizable?: boolean;
  /** When true, user can pin to left or right via the column menu.
   *  Default true. */
  pinnable?: boolean;
  /** Per-cell render function. Receives the row and a context with
   *  hover/selected/active hints + any "leading" decoration
   *  injected by the table (e.g. tree-expand chevron). */
  cell: (row: Row, ctx: CellContext) => ReactNode;
  /** When set, the cell becomes inline-editable: clicking it swaps
   *  the read-only `cell` for this editor. The DataTable tracks which
   *  cell is in edit mode and passes `close` so the editor can exit
   *  (on commit / blur / Escape). Only fires while the column is
   *  visible — hiding the column hides the affordance. */
  editable?: (row: Row, ctx: EditCellContext) => ReactNode;
  /** When true, the cell is allowed to use a custom <td>. Most
   *  consumers should leave this false (the default) and return
   *  just the cell CONTENT — DataTable wraps it in a <td> with the
   *  correct sticky/bg/padding. Set true when you need to override
   *  the td (rare — e.g. when spanning columns). */
  rawCell?: boolean;
  /** Plain-text value for this column when the row is exported.
   *  `cell` returns JSX and can't be stringified, so export goes
   *  through this accessor. Columns without it export as an empty
   *  cell — set it on every column you want in the download.
   *
   *  This is the human-readable form and is what CSV and the print/PDF
   *  view use verbatim, formatting and all. */
  exportValue?: (row: Row) => string | number | boolean | null | undefined;

  /** Raw number for this column, in MAJOR units, when one exists.
   *
   *  Excel uses this in preference to `exportValue` so the cell lands as a
   *  real number: `"1,500.00"` as text cannot be summed, pivoted or charted,
   *  which is most of the reason anyone exports to Excel. Return null for a
   *  row with no numeric value (the cell falls back to the text form).
   *
   *  Not used by CSV or PDF — those stay human-readable. */
  exportNumber?: (row: Row) => number | null | undefined;

  /** Raw date for this column, when one exists. Excel uses it in preference to
   *  `exportValue` so the cell is a real date — text dates don't group by
   *  month or sort chronologically in a pivot. */
  exportDate?: (row: Row) => Date | null | undefined;
}

/** Hints passed to `cell()`. */
export interface CellContext {
  rowIndex: number;
  /** Tree depth when grouping is active. 0 otherwise. */
  depth: number;
  /** Pre-cell leading element (e.g. group-expand chevron). Render
   *  it inline in the first column's cell if you want indentation
   *  to work. The DataTable doesn't auto-inject — the consumer
   *  decides which column receives the leading. */
  leading?: ReactNode;
  /** Whether THIS row is currently selected. */
  isSelected: boolean;
  /** Whether THIS row is the "active" row (e.g. a detail drawer is
   *  open for it). */
  isActive: boolean;
  /**
   * True when this cell is being drawn as a CARD slot rather than a `<td>`.
   *
   * A card field is the same `cell` in a different frame, and that is the
   * point of the design — but a handful of cells embed a control next to
   * their value (the row kebab folded into the identity column is the one in
   * the product today). In a card that control is wrong twice over: it is a
   * second, 24px kebab beside the card's own 44px one, and `devWarnCards`
   * rightly reports it as a control inside a value slot.
   *
   * So the frame is disclosed, and the cell drops the control:
   *
   *     cell: (row, ctx) => (
   *       <div>
   *         {row.title}
   *         {!ctx.compact && <RowActionsMenu … />}
   *       </div>
   *     )
   *
   * Undefined in the table tree, `true` in the card tree. It is a HINT about
   * the surface, never a licence to render different DATA — a card that
   * showed a different value from the table would be the divergence the
   * shared `cell` exists to prevent. Hiding the control with a `md:` utility
   * class instead was the alternative and is worse: the button is still in
   * the DOM, still inside the card's accessible name computation, and still
   * trips the dev warning.
   */
  compact?: boolean;
}

/** Hints passed to an inline-edit `editable()` cell. */
export interface EditCellContext {
  /** Exit edit mode (the editor calls this on commit / blur / Escape). */
  close: () => void;
}

// ─── DataTable state ──────────────────────────────────────────────

export interface SortState {
  field: string;
  dir: 'asc' | 'desc';
}

/** All controllable state. The consumer owns this so it can be
 *  hydrated from URL params / a saved view / localStorage. */
export interface DataTableState<ColumnId extends string = string> {
  filters: FilterClause<ColumnId>[];
  sort: SortState | null;
  density: Density;
  /** Linear order of all columns the consumer defined (visible or
   *  not). Initialized to the order of `columns` on first render. */
  columnOrder: ColumnId[];
  /** Per-column show/hide flag. Columns not in the map are visible. */
  columnVisibility: Record<string, boolean>;
  /** Per-column pixel widths. Falls back to ColumnDef.defaultWidth. */
  columnWidths: Record<string, number>;
  /** Pin state per side. Order within each array determines the
   *  rendered order of the pinned band — first id is the leftmost
   *  pinned-left column. */
  pinnedColumns: { left: ColumnId[]; right: ColumnId[] };
  /** Selected row ids. */
  selectedIds: Set<string>;
  /** Currently-active group-by column id, or null for ungrouped.
   *  Defined separately from sort so a list can be grouped by one
   *  field and sorted by another. */
  groupBy?: ColumnId | null;
  /** Group keys currently collapsed (rendered as a header row only,
   *  with body rows hidden). Empty / undefined = all groups expanded. */
  collapsedGroups?: Set<string>;
}

export function createDataTableState<ColumnId extends string>(
  columns: ColumnDef<unknown, ColumnId>[],
  overrides: Partial<DataTableState<ColumnId>> = {},
): DataTableState<ColumnId> {
  return {
    filters: [],
    sort: null,
    density: 'normal',
    columnOrder: columns.map((c) => c.id),
    columnVisibility: {},
    columnWidths: {},
    pinnedColumns: { left: [], right: [] },
    selectedIds: new Set(),
    ...overrides,
  };
}

// ─── Compact (card) layout ────────────────────────────────────────

/** Which columns a card borrows, when the table renders as cards on a
 *  compact viewport.
 *
 *  A card is not a narrow table — it cannot show fifteen columns, and
 *  picking which ones survive is a per-page editorial decision the table
 *  has no way to guess. So the consumer names them, by column id, and the
 *  card reuses that column's existing `cell` renderer. There is no second
 *  rendering path to keep in sync: a card field IS the table cell, drawn
 *  in a different frame.
 *
 *  Ids are checked against the table's own `ColumnId` union, so renaming a
 *  column breaks the build here rather than silently blanking a card. */
export interface DataTableMobileConfig<Row, ColumnId extends string = string> {
  /** Column whose cell is the card's headline. Always rendered, even when
   *  the user has hidden this column in the table — a card with no identity
   *  is not a card.
   *
   *  On a card with no `onRowClick` the title slot is the card's tap target,
   *  so a `cell` that returns an ELEMENT is rendered unwrapped and stretched
   *  to the 44px tap floor: the frame does not clamp it. Clamp inside the
   *  `cell`, which is also where the column knows how many lines it wants.
   *  A `cell` returning plain text keeps the frame's two-line clamp. */
  title: ColumnId;
  /** Optional second line under the title (e.g. merchant, submitter). */
  subtitle?: ColumnId;
  /** Optional status-shaped column rendered as the card's badge. Like
   *  `title`, it ignores column visibility. */
  badge?: ColumnId;
  /**
   * Detail rows inside the card, in this order.
   *
   * Keep it to three. Beyond that the card stops being scannable and starts
   * being a table with extra steps — but this is deliberately `ColumnId[]`
   * and not a 1–3 tuple.
   *
   * Two reasons. A tuple rejects every computed list: `columns.map(c => c.id)`
   * or a `.filter()` over a permission check widens to `ColumnId[]` and no
   * longer assigns, so every page that builds its fields dynamically would
   * need an `as const` it cannot write or a cast that defeats the check. And
   * a tuple would be a bound the type cannot actually hold: the rendered
   * field rows are this list INTERSECTED with the user's live
   * `state.columnVisibility`, so a "guaranteed 3" can be 0 at runtime
   * anyway. A limit the type cannot enforce belongs where it can be —
   * a dev-only warning at render.
   */
  fields: ColumnId[];
  /** Per-row actions for the card's kebab menu. `RowAction` is the design
   *  system's own shape (`RowActionsMenu`), reused rather than redefined so
   *  a page can hand the same array to both surfaces. */
  rowActions?: (row: Row) => RowAction[];
  /**
   * Show the per-card selection checkbox. Default false.
   *
   * A SECOND opt-in, on top of the table's `selectable`, and deliberately
   * not just inherited from it. Selection on a phone is only half a
   * feature: the bulk-action bar that gives it a purpose lives outside the
   * table, is authored per page, and none of them are laid out for 360px
   * yet. Inheriting `selectable` would have handed every list page a column
   * of checkboxes that tick rows nothing can then act on. So a page says
   * "yes, cards too" explicitly, when its bulk bar is ready.
   *
   * Both flags are required: `selectable` says the page has selection at
   * all, this says it survives the trip to a card.
   */
  selectable?: boolean;
}

// ─── DataTable props ──────────────────────────────────────────────

export interface DataTableLabels {
  /** Labels for the column header dropdown — sort / filter / hide
   *  / pin / auto-size, etc. The DataTable passes these to its
   *  internal `<ColumnHeader>` instances. */
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
  /** Labels for the gear (Columns + Density + Reset). */
  settings: {
    trigger: string;
    columns: string;
    density: string;
    densityCompact: string;
    densityNormal: string;
    densityComfortable: string;
    resetDefaults: string;
  };
  /** Misc labels — empty state, loading, "select all", etc. */
  /** Accessible name for the header's select-all checkbox. REQUIRED: while it was
   *  optional, both real label bags omitted it and every list page rendered the
   *  checkbox with no name at all. */
  selectAll: string;
  /**
   * The per-ROW accessible names — the checkbox, the expand chevron in both of
   * its states, and the drag handle.
   *
   * These were hardcoded English inside `DataTable` until the card work made
   * them audible: on a desktop grid an unlabelled-in-English control sits next
   * to a translated column header and reads as a rough edge, but a card list is
   * navigated by screen reader one row at a time, and "Select row" spoken into
   * a French session is the only thing the reader hears for that control.
   *
   * Optional, each with the same plain-English default at the point of use it
   * had as a literal — so the thirty-odd label bags in `apps/web` that never
   * heard of them keep rendering exactly what they rendered before, and
   * `useTableLabels` (which every real page uses) supplies the translated ones.
   */
  selectRow?: string;
  /** Accessible name for the row-expand chevron while COLLAPSED — it expands.
   *  Default "Expand row". */
  expandRow?: string;
  /** Accessible name for the row-expand chevron while EXPANDED — it collapses.
   *  Default "Collapse row". */
  collapseRow?: string;
  /** Accessible name for the row drag handle. Default "Drag to reorder". */
  dragToReorder?: string;
  loading?: string;
  endOfList?: string;
  /**
   * Labels the CARD tree needs and the table has no use for.
   *
   * Optional, each with a plain-English default at the point of use. That
   * is the seam the i18n phase threads next-intl catalog keys through
   * without every one of the thirty-odd label bags in `apps/web` having to
   * grow three fields on the same commit that ships the cards.
   */
  cards?: {
    /** Accessible name for the card's kebab trigger. Default "Row actions". */
    rowActions?: string;
    /** Accessible name for the card's selection checkbox. Default "Select row". */
    selectRow?: string;
    /** Text announced in the card list's polite live region when the row
     *  count changes — a filter applied from the sheet is otherwise silent,
     *  because the count is off-screen behind it (SC 4.1.3). Default
     *  "12 results". */
    resultCount?: (count: number) => string;
  };
}

export interface DataTableProps<Row, ColumnId extends string = string> {
  /**
   * Which tree the table renders. Public API, not a test hook.
   *
   * `'auto'` (the default) picks by viewport AND by opt-in: cards below
   * Tailwind's `md` breakpoint **only when `mobile` names the card's columns**.
   * A table that has not opted in keeps the horizontal scroller it has today
   * — the grid inside `<Scroll2D>` — at every width.
   *
   * That gate is the contract, not an implementation detail. An unconfigured
   * card falls back to the first visible column and renders no field rows, so
   * an ungated `'auto'` would silently drop every other column on a phone;
   * the scroller keeps them all, one swipe away, and its `overflow-x` means
   * the page itself still does not scroll sideways.
   *
   * `'table'` and `'cards'` pin the choice and ignore both the viewport and
   * the opt-in — `'table'` for a listing that genuinely needs the grid at any
   * width (a reconciliation view, a print target), `'cards'` for a surface
   * that is card-shaped everywhere (which is why `mobile` stays optional:
   * `'cards'` with no config renders the fallback title deliberately).
   *
   * Exactly ONE tree is mounted at a time; the decision is made in JS, and
   * the CSS cloak only covers the gap between SSR (which has no viewport and
   * therefore always emits the table) and hydration.
   *
   * What crossing the breakpoint live costs you, precisely — the branch is
   * an early return inside one component, so the SUBTREE is replaced but
   * `DataTable` itself is not remounted:
   *
   *   - `state` (this prop) is untouched. Selection, sort, filters, column
   *     order, visibility, density, grouping all come through.
   *   - Scroll position is genuinely lost — the old tree's scroll element is
   *     destroyed — and is re-established by anchoring on the row key of the
   *     topmost visible row. See `useScrollAnchor` in `DataTable.tsx`.
   *   - An in-progress inline cell edit and an uncommitted row-drag reorder
   *     are CANCELLED, on purpose. They would otherwise persist invisibly
   *     behind the card tree, which renders neither.
   *   - Row expansion persists.
   */
  layout?: 'auto' | 'table' | 'cards';

  /**
   * Which columns the card tree borrows — and, with `layout: 'auto'`, THE
   * SWITCH THAT REACHES THE CARD TREE AT ALL.
   *
   * Supply it and a narrow viewport gets cards. Omit it and `'auto'` keeps
   * the table inside its horizontal scroller at every width, because a card
   * with no config falls back to the first visible column and shows nothing
   * else — honest, useless, and a silent loss of every other column.
   * Presence is judged on `title`, the one field a card cannot do without;
   * an empty `fields` list is legal and does not disable card mode.
   *
   * `layout: 'cards'` ignores this switch and mounts the card tree anyway.
   */
  mobile?: DataTableMobileConfig<Row, ColumnId>;

  /** Strip the column-header affordances (sort / filter / menu / resize). For a
   *  small fixed table in a narrow pane, they reserve padding in every header
   *  and read as clutter rather than power. */
  plainHeaders?: boolean;

  columns: ColumnDef<Row, ColumnId>[];
  rows: Row[];
  /**
   * Who orders the rows.
   *
   * `'client'` (the default) sorts here, using the column's export accessors. `'external'`
   * means the listing sorts for itself — in its own memo, or by passing the sort to a
   * server query — and the table must leave the order it was handed alone.
   *
   * The default is 'client' deliberately: the previous behaviour was to record the sort,
   * draw the indicator and reorder nothing, so a listing that forgot to wire it up showed
   * an arrow that did not work (GA readiness report F04). Forgetting now costs correct
   * behaviour rather than a lie.
   */
  sortMode?: 'client' | 'external';
  rowKey: (row: Row) => string;

  // Async / pagination
  loading?: boolean;
  totalCount?: number;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  /** When true (default false), don't render the load-more sentinel.
   *  Used when the data query is "single-shot" — e.g. grouped views
   *  fetch all rows at once and pagination would be wrong. */
  disableInfiniteScroll?: boolean;

  // Controlled state
  state: DataTableState<ColumnId>;
  onStateChange: (next: DataTableState<ColumnId>) => void;

  // Row interactions
  /** Whole-row click handler (suppressed for clicks on nested
   *  interactives). Typically opens a detail drawer. */
  onRowClick?: (row: Row) => void;
  /** When set, this row id gets the "active" visual treatment
   *  (e.g. a left accent bar). Use to indicate "this row's detail
   *  drawer is open". */
  activeRowId?: string | null;

  /** When provided, each row gets a leading chevron that toggles an
   *  inline expansion panel rendered full-width beneath the row. Use
   *  for per-row detail / edit affordances that don't fit in cells
   *  (e.g. attachments + extra coding dimensions). Expansion state is
   *  owned internally, keyed by `rowKey`. */
  renderExpanded?: (row: Row) => ReactNode;

  /** Window the visible rows (render only those in/near the viewport,
   *  spacer rows preserve scroll height) so large lists/trees stay fast.
   *  Assumes UNIFORM row height — incompatible with grouping and the
   *  detail-panel `renderExpanded`; the table silently falls back to a
   *  full render when those are active. */
  virtualizeRows?: boolean;
  /** Uniform row height in px used by virtualization. Defaults from density
   *  (compact 36 / normal 44 / comfortable 52). */
  rowHeight?: number;

  // Selection — only rendered when `selectable` is true
  selectable?: boolean;
  /**
   * Which rows a bulk action can apply to. Omitted means all of them.
   *
   * An ineligible row's checkbox is disabled and select-all skips it, so the header count
   * and what the action will actually do are the same number. Without this a preview table
   * could tick three hundred rows and then act on twelve, describing neither.
   */
  rowSelectable?: (row: Row) => boolean;

  // Row drag-and-drop reordering. When set (and the table is NOT
  // grouped), a leading grip handle is rendered and draggable rows can
  // be reordered via native HTML5 drag. On drop, `onReorder` fires with
  // the new full row-id order. `canDrag` gates which rows may be dragged
  // (default: all) — non-draggable rows stay put and act as drop floors.
  rowDnd?: {
    onReorder: (orderedIds: string[]) => void;
    canDrag?: (row: Row) => boolean;
  };

  // Facet count data — passed-through to filter editors and to the
  // facet rail (if the consumer wires one separately). Shape:
  // `{ fieldId: [{value, count, label?}] }`.
  facetCounts?: Record<string, Array<{ value: string; count: number; label?: string }>>;

  // Empty / loading templates
  renderEmpty?: () => ReactNode;
  renderLoadingRow?: () => ReactNode;

  // Labels (delegated from i18n at the consumer)
  labels: DataTableLabels;

  // Sort handling — when the consumer needs to translate ColumnId
  // → server field name (for `ORDER BY`), this fn is called. By
  // default, the column's `sortable.serverField` is used (or `id`
  // when `sortable` is `true`).
  sortFieldFor?: (col: ColumnDef<Row, ColumnId>) => string;

  // Group-by — when `state.groupBy` is set, the table partitions
  // visible rows by `groupKeyFor(row)` and inserts a `GroupHeaderRow`
  // before each group. The consumer supplies both functions:
  //   - `groupKeyFor`   stable key (used as collapse-state key)
  //   - `groupLabelFor` display label (rendered in the header row)
  // The optional `groupCountLabel` lets the consumer format the
  // right-aligned count (defaults to "{n} items").
  groupKeyFor?: (row: Row, groupBy: ColumnId) => string;
  groupLabelFor?: (key: string, groupBy: ColumnId) => string;
  groupCountLabel?: (count: number) => string;
}

// ─── Re-exports for convenience ───────────────────────────────────

export type { FilterClause, FilterOp };

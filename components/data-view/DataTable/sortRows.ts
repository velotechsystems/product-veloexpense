import type { ColumnDef, SortState } from './types';

/**
 * Sort rows by the column the header arrow is pointing at.
 *
 * WHY THIS EXISTS. `DataTable` recorded `state.sort` and drew the ascending / descending
 * indicator, and then never reordered anything — sorting was the consumer's job, exactly
 * as filtering is. Nine of the twenty-one listings did that work; the rest drew an arrow
 * that meant nothing. Clicking "Report" or "Total" on the Expense Reports list moved the
 * indicator and left all twelve rows where they were (GA readiness report F04).
 *
 * A control that appears to work and does not is worse than one that is absent, so the
 * table now sorts by default and a listing that sorts for itself opts out with
 * `sortMode="external"`.
 *
 * NO NEW ACCESSOR. The comparable value comes from the export accessors the listing
 * standard already requires for the toolbar's Export menu — `exportDate`, then
 * `exportNumber`, then `exportValue`. Preferring them in that order is what keeps a date
 * column ordering as dates and a money column as numbers, rather than as the strings a
 * `cell` renderer happens to produce ("$1,500.00" sorts before "$9.00" as text).
 *
 * Failing all three, a row field named exactly like the column is used, which covers the
 * many simple listings that define `{ id: 'name', cell: (r) => r.name }` and no accessor.
 *
 * A column that yields nothing by any of those routes cannot be sorted honestly, so the
 * header does not offer the affordance — see `canSortClientSide`, which decides from the
 * ROWS rather than from the declaration, because whether a value exists depends on the
 * data as much as on the config.
 */

/** How many rows to look at before concluding a column has nothing to sort by. */
const SORTABILITY_SAMPLE = 20;

/** The comparable value for a row in a column, or undefined when there is none. */
function comparableOf<Row, ColumnId extends string>(
  col: ColumnDef<Row, ColumnId>,
  row: Row,
): string | number | undefined {
  const d = col.exportDate?.(row);
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
  const n = col.exportNumber?.(row);
  if (typeof n === 'number' && !Number.isNaN(n)) return n;
  const v = col.exportValue?.(row);
  if (v !== null && v !== undefined) return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  // Last resort: a row field named exactly like the column. Plenty of simple listings
  // define `{ id: 'name', cell: (r) => r.name }` and no export accessor, and refusing to
  // sort those would hide a working control for the sake of a rule.
  const raw = (row as Record<string, unknown>)[col.id];
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.getTime();
  return undefined;
}

/**
 * Can this column be sorted in the browser, given these rows?
 *
 * `sortable: { serverField }` means the listing sends the sort to its query, so re-sorting
 * the page that came back would fight it — and on a cursor-paginated list it would order
 * only the rows loaded so far, which reads as a broken sort rather than a partial one.
 */
export function canSortClientSide<Row, ColumnId extends string>(
  col: ColumnDef<Row, ColumnId> | undefined,
  rows: readonly Row[],
): boolean {
  if (!col || col.sortable !== true) return false;
  // Decided from the ROWS, not from the column's declaration. Whether a value exists
  // depends on the data as much as on the config — a column with no export accessor may
  // still sort perfectly well by a row field of the same name — and a static guess would
  // hide working controls to avoid showing broken ones.
  for (const row of rows.slice(0, SORTABILITY_SAMPLE)) {
    if (comparableOf(col, row) !== undefined) return true;
  }
  return false;
}

/**
 * A stable, locale-aware sort. Returns the input untouched when there is nothing to do,
 * so an unsorted table keeps the identity react-query handed it and does not re-render.
 *
 * Blanks sort LAST in both directions. A row with no value has not "got a small one" —
 * reversing the order should not march the empties to the top, because the question being
 * asked is "show me the biggest" or "the smallest", and neither means "show me the ones
 * that have none".
 */
export function sortRows<Row, ColumnId extends string>(
  rows: readonly Row[],
  sort: SortState | null | undefined,
  columns: readonly ColumnDef<Row, ColumnId>[],
): readonly Row[] {
  if (!sort?.field) return rows;
  const col = columns.find((c) => c.id === sort.field);
  if (!col || !canSortClientSide(col, rows)) return rows;

  const dir = sort.dir === 'desc' ? -1 : 1;
  // Decorate–sort–undecorate: `comparableOf` may call three accessors per cell, and a
  // comparator runs O(n log n) times.
  const decorated = rows.map((row, i) => ({ row, i, v: comparableOf(col, row) }));
  decorated.sort((a, b) => {
    if (a.v === undefined || b.v === undefined) {
      if (a.v === b.v) return a.i - b.i;
      return a.v === undefined ? 1 : -1; // blanks last, whichever way we are sorting
    }
    if (typeof a.v === 'number' && typeof b.v === 'number') {
      return a.v === b.v ? a.i - b.i : (a.v - b.v) * dir;
    }
    // `numeric` so "Item 2" precedes "Item 10", and `sensitivity: base` so case and
    // accents do not split what a reader sees as one group.
    const c = String(a.v).localeCompare(String(b.v), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return c === 0 ? a.i - b.i : c * dir;
  });
  return decorated.map((d) => d.row);
}

// ─── Which field a column sorts by, if any ─────────────────────────────────
//
// The header used to work this out inline, in the middle of its `<th>` map.
// The mobile sort SHEET has to answer the identical question — cards have no
// header row, so the sheet IS the affordance — and a second copy of the rule
// would be a sheet that offers a field the header would have withheld, which
// is F04 again by another route: an arrow that moves and rows that do not.
// So the rule lives here, once, and both surfaces call it.

/** Options both callers pass through from `<DataTable>`'s own props. */
export interface SortFieldOptions<Row, ColumnId extends string> {
  /** `'external'` means the listing sorts for itself — see `DataTableProps`. */
  sortMode?: 'client' | 'external';
  /** Consumer override for ColumnId → server field name. */
  sortFieldFor?: (col: ColumnDef<Row, ColumnId>) => string;
}

/**
 * The field name this column sorts by, or `null` when it sorts by nothing.
 *
 * Three routes to a value, in order:
 *   - `sortable: true` — the column id, but ONLY if the rows actually yield a
 *     comparable value (`canSortClientSide`), or the listing is sorting
 *     externally and is doing that check itself.
 *   - `sortable: { serverField }` — that name, unconditionally; the listing
 *     sends it to its query and the browser never compares anything.
 *   - anything else — `null`.
 *
 * `sortFieldFor`, when the consumer supplies one, replaces the answer
 * outright — including replacing `null`. That is the behaviour the header has
 * always had and this extraction deliberately preserves it rather than
 * quietly tightening it: a consumer that maps every column to a server field
 * is saying it sorts them all. Preserving it is also what makes the sheet
 * safe, because "the sheet offers exactly what the header offers" is a
 * stronger guarantee than any rule this function could invent.
 */
export function resolveSortField<Row, ColumnId extends string>(
  col: ColumnDef<Row, ColumnId>,
  rows: readonly Row[],
  opts: SortFieldOptions<Row, ColumnId> = {},
): string | null {
  const declared =
    col.sortable === true
      ? opts.sortMode === 'external' || canSortClientSide(col, rows)
        ? (col.id as string)
        : null
      : col.sortable
        ? col.sortable.serverField
        : null;
  return opts.sortFieldFor ? opts.sortFieldFor(col) : declared;
}

/** One entry in `<SortSheet>`'s field list. Structurally the design system's
 *  `SortSheetOption`; defined here so this module stays importable from a
 *  plain Node test with no DS dependency. */
export interface SortFieldChoice {
  field: string;
  label: string;
}

/**
 * The field list for `<SortSheet>` — `resolveSortField` mapped over the
 * columns with the unsortable ones dropped.
 *
 * Pass the columns the reader can actually see, in the order they are shown.
 * Visibility is the caller's call, not this function's: a card list hides
 * columns by `state.columnVisibility`, and whether a hidden column should
 * still be sortable is a page decision.
 */
export function sortSheetOptions<Row, ColumnId extends string>(
  columns: readonly ColumnDef<Row, ColumnId>[],
  rows: readonly Row[],
  opts: SortFieldOptions<Row, ColumnId> = {},
): SortFieldChoice[] {
  const out: SortFieldChoice[] = [];
  for (const col of columns) {
    const field = resolveSortField(col, rows, opts);
    if (field) out.push({ field, label: col.label });
  }
  return out;
}

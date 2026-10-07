/**
 * Row grouping — the one definition of what a GROUP is, for both trees.
 *
 * This was a `useMemo` inline in `DataTable`, feeding `<GroupHeaderRow>`. The
 * card tree needs the identical partition — the same rows under the same
 * headers, in the same order, with the same collapsed and selected verdicts —
 * and a second copy is a partition that agrees today and drifts the first time
 * either side is touched. When it drifts, the two surfaces disagree about
 * which rows belong to which group and about how many are in it, which on a
 * phone is the only summary of a list the reader can see at once.
 *
 * Same discipline as `groupClauses` in the design system: the bar and the
 * sheet call it, and neither keeps a copy.
 *
 * ── Order is part of the contract ───────────────────────────────────
 *
 *   - Groups come back in FIRST-APPEARANCE order — the order their first row
 *     appears in the input. The table does not sort groups; that is the
 *     consumer's sort field, and re-ordering here would silently override it.
 *   - Rows inside a group keep their relative input order.
 *
 * ── What it deliberately does NOT do ────────────────────────────────
 *
 * It does not read `state`, does not write it, and holds no React. The
 * collapsed set and the selected set come in as plain readonly sets, so the
 * card tree — which is forbidden from writing state — can call it with the
 * same arguments the table does and get the same answer.
 *
 * It is also NOT handed the row-DRAG order. What `DataTable` passes is
 * `rows` — the client-sorted list, `sortRows(rawRows, state.sort, columns)`
 * unless the page sorts for itself — and never `orderedRows`, which is
 * `rows` with the person's hand-dragged order applied on top. So grouping
 * and the client sort DO compose: the rows arrive sorted and this partitions
 * them in that order, which is why "first-appearance order" above means
 * first appearance in the sorted list. Grouping and a drag order do not
 * compose, and that is the composition this extraction preserves exactly —
 * moving to `orderedRows` here would change what the table renders on every
 * grouped page at once.
 */

/**
 * One group's worth of rows, plus the header metrics both surfaces draw.
 *
 * `allSelected` / `someSelected` are computed rather than left to the caller
 * because the table's header checkbox and the card header would otherwise
 * each decide what "some" means — and an indeterminate checkbox that
 * disagrees with the rows under it is worse than none.
 */
export interface RowGroup<Row> {
  /** Stable key, from `groupKeyFor`. Also the collapse-state key. */
  key: string;
  /** Display label, from `groupLabelFor`. Falls back to `key`. */
  label: string;
  rows: Row[];
  allSelected: boolean;
  someSelected: boolean;
  collapsed: boolean;
}

export interface GroupRowsOptions<Row, ColumnId extends string> {
  /** The active group-by column, or null/undefined for ungrouped. */
  groupBy: ColumnId | null | undefined;
  /** Stable key per row. Grouping is OFF unless this is supplied — the
   *  consumer opts in by providing it, exactly as `DataTable` requires. */
  groupKeyFor?: (row: Row, groupBy: ColumnId) => string;
  /** Display label per key. Omitted means the key is shown as-is. */
  groupLabelFor?: (key: string, groupBy: ColumnId) => string;
  /** Row identity, for the selection metrics. */
  rowKey: (row: Row) => string;
  selectedIds: ReadonlySet<string>;
  collapsedGroups?: ReadonlySet<string>;
}

/**
 * Partition rows into groups. Returns `[]` when grouping is off — which is
 * the signal both trees use to take their ungrouped path, so "grouped" is one
 * question with one answer rather than a flag each surface re-derives.
 */
export function groupRows<Row, ColumnId extends string>(
  rows: readonly Row[],
  opts: GroupRowsOptions<Row, ColumnId>,
): RowGroup<Row>[] {
  const { groupBy, groupKeyFor, groupLabelFor, rowKey, selectedIds, collapsedGroups } = opts;
  if (!groupBy || !groupKeyFor) return [];

  const order: string[] = [];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = groupKeyFor(r, groupBy);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      order.push(k);
    }
    byKey.get(k)?.push(r);
  }

  const collapsed = collapsedGroups ?? new Set<string>();
  return order.map((k) => {
    const rs = byKey.get(k) ?? [];
    return {
      key: k,
      label: groupLabelFor ? groupLabelFor(k, groupBy) : k,
      rows: rs,
      allSelected: rs.length > 0 && rs.every((r) => selectedIds.has(rowKey(r))),
      someSelected: rs.some((r) => selectedIds.has(rowKey(r))),
      collapsed: collapsed.has(k),
    };
  });
}

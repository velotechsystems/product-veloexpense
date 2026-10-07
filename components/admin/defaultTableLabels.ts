/**
 * Default English label bag for admin pages that don't wire up
 * next-intl. The People directory + Role Builder pull labels from
 * translation catalogs; the smaller admin pages (Job Levels,
 * Fiscal Years, Approval Thresholds, etc.) reuse this constant.
 *
 * Two exports because the DS `<TableSettingsButton>` expects a
 * `settings` shape with `groupBy` (since it can render the group-by
 * radio group), while the app's local `<DataTable>` labels schema
 * omits `groupBy`. They're built from the same string set; pick
 * the shape that matches the consumer prop.
 */
import type { DataTableLabelsX } from '@/components/data-view';

const COL_MENU = {
  menu: 'Column menu',
  sortAsc: 'Sort ascending',
  sortDesc: 'Sort descending',
  filter: 'Filter',
  hide: 'Hide column',
  cancel: 'Cancel',
  clear: 'Clear',
  apply: 'Apply',
  value: 'Value',
  resize: 'Auto-size',
  removeFilter: 'Remove filter',
  op_contains: 'contains',
  op_doesNotContain: 'does not contain',
  op_equals: 'equals',
  op_doesNotEqual: 'does not equal',
  op_startsWith: 'starts with',
  op_endsWith: 'ends with',
  op_isEmpty: 'is empty',
  op_isNotEmpty: 'is not empty',
  op_isAnyOf: 'is any of',
  op_isNoneOf: 'is none of',
} as const;

/** For the app's local `<DataTable>` — `settings` does NOT include
 *  `groupBy` (the DataTable doesn't render the group-by control). */
export const DEFAULT_TABLE_LABELS: DataTableLabelsX = {
  colMenu: COL_MENU,
  settings: {
    trigger: 'Table settings',
    columns: 'Columns',
    density: 'Density',
    densityCompact: 'Compact',
    densityNormal: 'Normal',
    densityComfortable: 'Comfortable',
    resetDefaults: 'Reset to defaults',
  },
  selectAll: 'Select all rows',
  /**
   * The per-row accessible names, kept here word-for-word as `table.misc.*`
   * spells them.
   *
   * `DataTable` defaults each of these to the same English at its point of use,
   * so this block changes nothing today — it is here so the bag stays a
   * COMPLETE picture of what the table renders. A fallback bag that is merely
   * mostly complete is how the select-all checkbox shipped with no accessible
   * name at all: both real bags omitted an optional field, and nothing said so.
   */
  selectRow: 'Select row',
  expandRow: 'Expand row',
  collapseRow: 'Collapse row',
  dragToReorder: 'Drag to reorder',
  loading: 'Loading…',
  endOfList: 'End of list',
};

/** For the DS `<TableSettingsButton>` — adds the `groupBy` label
 *  the gear popover needs to render its radio group. */
export const DEFAULT_SETTINGS_LABELS = {
  trigger: 'Table settings',
  columns: 'Columns',
  groupBy: 'Group by',
  density: 'Density',
  densityCompact: 'Compact',
  densityNormal: 'Normal',
  densityComfortable: 'Comfortable',
  resetDefaults: 'Reset to defaults',
} as const;

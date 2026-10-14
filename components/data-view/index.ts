/**
 * `data-view` chrome barrel — single import point combining the DS
 * primitives that drive list pages with the app-local types pinned
 * to the saved-views router schema (narrower `groupBy` than the DS
 * generic).
 *
 * DS primitives now live in `@expenseos/design-system` directly;
 * we re-export them here so consumer files keep using one import
 * path. The local module remains the home for:
 *   - `<DataTable>` + its types (app composition)
 *   - The persisted-view + filter-clause types pinned to
 *     `DirectoryScope` (router-schema-aligned)
 *   - The `<ScopeChip>` wrapper that pins the DS generic to
 *     `DirectoryScope`
 *   - `useSavedViews` hook + helpers
 */

export {
  AddFilterPill,
  CustomScrollBox,
  FacetCard,
  FacetRail,
  FilterBlock,
  FilterSheet,
  type FilterSheetLabels,
  Scroll2D,
  SortSheet,
  type SortSheetLabels,
  type SortSheetOption,
  ViewDropdown,
  ViewsBar,
} from '@expenseos/design-system';
export {
  type CellContext,
  type ColumnDef,
  canSortClientSide,
  createDataTableState,
  DataTable,
  type DataTableLabels as DataTableLabelsX, // avoid name collision with design-system
  type DataTableMobileConfig,
  type DataTableProps,
  type DataTableState,
  resolveSortField,
  type SortFieldChoice,
  type SortFieldOptions,
  type SortState,
  sortSheetOptions,
} from './DataTable';
export { ScopeChip } from './ScopeChip';
export { type ExportFormat, TableExportMenu } from './TableExportMenu';
export {
  clausesToServerFilters,
  cls,
  type DropdownView,
  type FacetOption,
  type FieldKind,
  type FilterClause,
  type FilterOp,
  newClauseId,
  OP_LABELS,
  OPS_BY_KIND,
  type PersistedViewState,
  type ServerColumnFilter,
  type SystemView,
  type UserView,
  VALUELESS_OPS,
} from './types';
export { useDebouncedValue } from './useDebouncedValue';
// w4-08: ExpenseOS's saved views, persisted through its `savedViews` router.
export { type ListViewsLabels, useListViews } from './useListViews';
export { type SavedViewResource, useSavedViews } from './useSavedViews';

export {
  type TableLabels,
  type ToolbarLabels,
  useFilterChromeLabels,
  useFilterSheetLabels,
  useSortSheetLabels,
  useTableLabels,
  useToolbarLabels,
} from './useTableLabels';
export { flattenTree, type TreeNode, useTreeRows } from './useTreeRows';

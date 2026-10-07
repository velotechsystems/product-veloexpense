'use client';

/**
 * Filter-pill bar for admin tables — the visible pills above a data
 * table that mirror DataTable's column-header filter editor.
 *
 * Optional saved-views slot: pass `savedViews` props to render the
 * bookmark + ViewDropdown at the left edge (admins can save / rename
 * / pin / delete filter combinations per entity). Omitting them
 * yields a slim variant for pages that don't need saved views yet.
 *
 * Slimmer than `<ViewsBar>` in two ways: no scope chip, no
 * "Show all filters" toggle. The pills are bound to the table's
 * filter state — column-header filter edits and pill-bar edits write
 * to the same clause array.
 */
import { IconBookmark } from '@tabler/icons-react';
import { AddFilterPill, FilterBlock } from '../filters/FilterBlock';
import type {
  FacetOption,
  FieldKind,
  FilterClause,
  FilterLabels,
  FilterOp,
} from '../filters/types';
import { clauseGroupKey, groupClauses } from './groupClauses';
import type { DropdownView } from './types';
import { ViewDropdown } from './ViewDropdown';

interface SavedViewsProps<F extends string, S extends string = string> {
  views: DropdownView<F, S>[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  onSaveAsNew: () => void;
  onRenameView: (id: string, currentName: string) => void;
  onDeleteView: (id: string, name: string) => void;
  onTogglePinned: (id: string) => void;
}

interface FilterPillBarProps<F extends string, S extends string = string> {
  filters: FilterClause<F>[];
  fields: F[];
  fieldLabels: Record<F, string>;
  fieldKinds: Record<F, FieldKind>;
  options: Record<F, FacetOption[]>;
  onUpdateOp: (id: string, op: FilterOp) => void;
  onUpdateValue: (id: string, value: string) => void;
  onRemoveClause: (id: string) => void;
  onAddClause: (field: F, op: FilterOp, value: string) => void;
  onClearAll: () => void;
  /** When provided, renders the saved-views dropdown at the left. */
  savedViews?: SavedViewsProps<F, S>;
  clearLabel?: string;
  /** Localized copy for the pill chrome (Add filter / Field / Operator / …).
   *  Defaults to English inside the pill components, so this is optional. */
  labels?: FilterLabels;
  /** Fallback name for a saved view with none. English default; pass a
   *  translation — it renders on every listing page. */
  untitledViewLabel?: string;
}

export function FilterPillBar<F extends string, S extends string = string>({
  filters,
  fields,
  fieldLabels,
  fieldKinds,
  options,
  onUpdateOp,
  onUpdateValue,
  onRemoveClause,
  onAddClause,
  onClearAll,
  savedViews,
  clearLabel = 'Clear filters',
  labels,
  untitledViewLabel = 'Untitled view',
}: FilterPillBarProps<F, S>) {
  // Group clauses by (field, op) so e.g. "code equals X" + "code
  // equals Y" render as a single block with X / Y joined by "or".
  //
  // Shared with `<FilterSheet>`, which stacks the same blocks vertically on
  // a phone. See `groupClauses.ts` — the partition and its ordering are the
  // contract, not an implementation detail of this bar.
  const groups = groupClauses(filters);

  const activeView = savedViews?.views.find((v) => v.id === savedViews.activeViewId);

  return (
    // `min-h-[46px]` matches the bar's at-rest height when a
    // FilterBlock is rendered, so adding the first filter doesn't
    // cause a height jump.
    <div className="flex min-h-[46px] flex-wrap items-center gap-2 px-3 py-2">
      {savedViews && (
        <>
          <div className="flex items-center gap-1">
            <IconBookmark size={14} className="text-primary" />
            <ViewDropdown<F, S>
              views={savedViews.views}
              activeId={savedViews.activeViewId}
              onSelect={savedViews.onSelectView}
              activeName={activeView?.name ?? untitledViewLabel}
              onSaveAsNew={savedViews.onSaveAsNew}
              onRenameView={savedViews.onRenameView}
              onDeleteView={savedViews.onDeleteView}
              onTogglePinned={savedViews.onTogglePinned}
            />
          </div>
          <span className="h-5 w-px bg-border" />
        </>
      )}

      {groups.map((group) => (
        <FilterBlock
          labels={labels}
          key={clauseGroupKey(group)}
          field={group.field}
          fieldKind={fieldKinds[group.field]}
          op={group.op}
          fieldLabel={fieldLabels[group.field]}
          clauses={group.clauses}
          options={options[group.field] ?? []}
          onOpChange={(newOp) => {
            for (const c of group.clauses) onUpdateOp(c.id, newOp);
          }}
          onValueChange={onUpdateValue}
          onRemoveValue={onRemoveClause}
          onRemoveBlock={() => {
            for (const c of group.clauses) onRemoveClause(c.id);
          }}
          onAddValue={(value) => onAddClause(group.field, group.op, value)}
        />
      ))}

      <AddFilterPill
        labels={labels}
        fields={fields}
        fieldKinds={fieldKinds}
        facetLabels={fieldLabels}
        facetOptions={options}
        onAdd={onAddClause}
      />

      {filters.length > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className="font-semibold text-primary text-xs hover:underline"
        >
          {clearLabel}
        </button>
      )}
    </div>
  );
}

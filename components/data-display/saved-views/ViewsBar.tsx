'use client';

import { IconBookmark, IconBookmarkFilled, IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cls } from '../data-table/helpers';
import { AddFilterPill, FilterBlock } from '../filters/FilterBlock';
import type { FacetOption, FieldKind, FilterClause, FilterOp } from '../filters/types';
import { ScopeChip } from '../ScopeChip';
import type { DropdownView } from './types';
import { ViewDropdown } from './ViewDropdown';

/**
 * The full list-page chrome: bookmark + saved-view dropdown + scope
 * chip + filter blocks + "+ Add filter" + Clear + Show/Hide filters
 * toggle. Generic over the host's field union (`F`) and scope union
 * (`S`).
 */
export function ViewsBar<F extends string, S extends string = string>({
  views,
  activeViewId,
  onSelectView,
  onSaveAsNew,
  onRenameView,
  onDeleteView,
  onTogglePinned,
  filters,
  fields,
  fieldKinds,
  facetLabels,
  facetOptions,
  onUpdateOp,
  onUpdateValue,
  onRemoveClause,
  onAddClause,
  onClearAll,
  railOpen,
  onToggleRail,
  availableScopes,
  scope,
  onScopeChange,
  scopeLabel,
  labels,
}: {
  views: DropdownView<F, S>[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  onSaveAsNew: () => void;
  onRenameView: (id: string, currentName: string) => void;
  onDeleteView: (id: string, name: string) => void;
  onTogglePinned: (id: string) => void;
  filters: FilterClause<F>[];
  fields: F[];
  fieldKinds: Record<F, FieldKind>;
  facetLabels: Record<F, string>;
  facetOptions: Record<F, FacetOption[]>;
  onUpdateOp: (id: string, op: FilterOp) => void;
  onUpdateValue: (id: string, value: string) => void;
  onRemoveClause: (id: string) => void;
  onAddClause: (field: F, op: FilterOp, value: string) => void;
  onClearAll: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  availableScopes: S[];
  scope: S;
  onScopeChange: (s: S) => void;
  scopeLabel: (s: S) => string;
  /**
   * User-facing chrome text. Optional with English fallbacks so existing call
   * sites keep compiling, but app-side callers should pass it: these were
   * hardcoded, and this component ships on the People page — "Show filters" and
   * "Untitled view" were visible English in a French session.
   */
  labels?: {
    clearFilters?: string;
    showFilters?: string;
    hideFilters?: string;
    untitledView?: string;
  };
}) {
  const activeView = views.find((v) => v.id === activeViewId);
  // The bookmark next to the view-dropdown reads as the "make this
  // view my default" affordance. We treat user-view `pinned` as the
  // default-flag. System views (`Default`, `Active employees`, etc.)
  // can't be toggled — render the icon inert.
  const isUserView = activeView?.kind === 'user';
  const isDefault = isUserView && activeView.pinned === true;

  // Group clauses by (field, op) for display. One block per group;
  // values within render as separate inner pills joined by `or`.
  const groups = useMemo(() => {
    const map = new Map<string, { field: F; op: FilterOp; clauses: FilterClause<F>[] }>();
    for (const c of filters) {
      const key = `${c.field}::${c.op}`;
      if (!map.has(key)) map.set(key, { field: c.field, op: c.op, clauses: [] });
      map.get(key)?.clauses.push(c);
    }
    return Array.from(map.values());
  }, [filters]);

  return (
    // `min-h-[46px]` matches the height of the bar AT REST when a
    // FilterBlock with at least one value pill is rendered. Without
    // this lock, the empty state is ~44px (tallest chip = the
    // AddFilterPill outer) and the bar JUMPS ~2-4px the moment the
    // first filter appears (the FilterBlock with a value pill inside
    // is ~30px vs the AddFilterPill's ~26px). Locking the floor at
    // the with-filter height keeps the bar stable in both states.
    <div className="flex min-h-[46px] flex-wrap items-center gap-2 px-3 py-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => isUserView && onTogglePinned(activeViewId)}
          disabled={!isUserView}
          aria-pressed={isDefault}
          aria-label={isDefault ? 'Remove as default view' : 'Set as default view'}
          title={
            isUserView
              ? isDefault
                ? 'Default view — click to unset'
                : 'Set as default view'
              : 'System views cannot be set as default'
          }
          className={cls(
            'rounded p-0.5 transition-colors',
            !isUserView
              ? 'cursor-not-allowed text-muted-foreground/40'
              : isDefault
                ? 'cursor-pointer text-primary hover:bg-primary/10'
                : 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {isDefault ? <IconBookmarkFilled size={14} /> : <IconBookmark size={14} />}
        </button>
        <ViewDropdown<F, S>
          views={views}
          activeId={activeViewId}
          onSelect={onSelectView}
          activeName={activeView?.name ?? labels?.untitledView ?? 'Untitled view'}
          onSaveAsNew={onSaveAsNew}
          onRenameView={onRenameView}
          onDeleteView={onDeleteView}
          onTogglePinned={onTogglePinned}
        />
      </div>

      <span className="h-5 w-px bg-border" />

      <ScopeChip<S>
        availableScopes={availableScopes}
        current={scope}
        onChange={onScopeChange}
        scopeLabel={scopeLabel}
      />

      {groups.map((group) => (
        <FilterBlock
          key={`${group.field}::${group.op}`}
          field={group.field}
          fieldKind={fieldKinds[group.field]}
          op={group.op}
          fieldLabel={facetLabels[group.field]}
          clauses={group.clauses}
          options={facetOptions[group.field] ?? []}
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
        fields={fields}
        fieldKinds={fieldKinds}
        facetLabels={facetLabels}
        facetOptions={facetOptions}
        onAdd={onAddClause}
      />

      {filters.length > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className="font-semibold text-primary text-xs hover:underline"
        >
          {labels?.clearFilters ?? 'Clear filters'}
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* VeloExpense kit: the kit's Button has no `soft`; `secondary` is its tinted fill. */}
        <Button type="button" variant="secondary" size="xs" onClick={onToggleRail}>
          <IconFilter size={12} className="mr-1" />
          {railOpen
            ? (labels?.hideFilters ?? 'Hide filters')
            : (labels?.showFilters ?? 'Show filters')}
          <IconChevronDown
            size={12}
            className={cls('ml-1 transition-transform', railOpen && 'rotate-180')}
          />
        </Button>
      </div>
    </div>
  );
}

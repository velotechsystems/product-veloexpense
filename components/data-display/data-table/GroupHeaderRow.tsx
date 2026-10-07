'use client';

import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { cls } from './helpers';

/**
 * Sub-header row rendered between groups in a grouped data-table view.
 * Uses the same column structure as a regular row so the right-edge
 * marker, checkbox alignment, and chevron-x-position all match the
 * body rows pixel-for-pixel.
 *
 * Layout:
 *   [✓ select] [▾ label] [colSpan: counter]
 */
export function GroupHeaderRow({
  label,
  countLabel,
  collapsed,
  onToggle,
  colSpan,
  showSelect,
  allSelected,
  someSelected,
  onToggleSelectGroup,
}: {
  label: string;
  countLabel: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Total number of columns currently rendered, INCLUDING the optional
   *  select column. The component subtracts the select + Name slots to
   *  derive the colSpan for the remaining-columns cell. */
  colSpan: number;
  showSelect: boolean;
  allSelected: boolean;
  someSelected: boolean;
  onToggleSelectGroup: () => void;
}) {
  const nameRestColSpan = colSpan - (showSelect ? 1 : 0) - 1;
  return (
    <tr className="border-border border-b bg-muted">
      {showSelect && (
        <td className="sticky left-0 z-10 w-11 bg-muted px-3 py-3 text-center align-middle">
          <input
            type="checkbox"
            aria-label={`Select all in ${label}`}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={onToggleSelectGroup}
            className="h-4 w-4"
          />
        </td>
      )}
      {/* Name slot — sticky-left, carries the right-edge marker shadow
          so the line is continuous from column header → group headers
          → body rows. */}
      <td
        className={cls(
          // No vertical freeze line — opaque bg-muted does the boundary
          // work and matches the row-level Name cell after restyling.
          'sticky z-10 bg-muted py-3 pr-2 pl-1',
          showSelect ? 'left-11' : 'left-0',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-2.5 text-left"
        >
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          <span className="truncate font-semibold text-foreground text-sm">{label}</span>
        </button>
      </td>
      <td colSpan={nameRestColSpan} className="py-3 pr-4 pl-2 text-right">
        <span className="text-muted-foreground text-xs">{countLabel}</span>
      </td>
    </tr>
  );
}

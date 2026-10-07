'use client';

/**
 * BulkActionsMenu — the left-side data-table toolbar trigger that
 * exposes per-selection actions (Deactivate, Archive, Move-to-folder,
 * etc.).
 *
 * Normally you don't render this directly — `<DataTableToolbar>` owns the rule
 * for when it appears and what it says (absent with an empty selection, and
 * labelled "N selected" otherwise). Use it standalone only outside a table
 * toolbar. With `selectedCount === 0` the trigger is `disabled` as a
 * belt-and-braces guard.
 *
 * The action list is supplied by the caller via `actions`; each item
 * runs `onSelect` then closes the popover. Items can be `destructive`
 * (red text on hover) or `disabled` (greyed). Add a `{ divider: true }`
 * entry to render a horizontal rule between groups.
 */

import { IconChevronDown } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MenuDivider, MenuItem } from './Menu';

export type BulkAction =
  | { divider: true }
  | {
      id: string;
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      destructive?: boolean;
      disabled?: boolean;
    };

export interface BulkActionsMenuProps {
  /** Number of currently-selected rows. Trigger is disabled when 0. */
  selectedCount: number;
  /** Action list. Items run their `onSelect` and close the popover. */
  actions: BulkAction[];
  /** Trigger label. The toolbar passes "N selected"; the default is a bare
   *  "Actions" for standalone use. */
  label?: string;
  /** Force-disable the trigger regardless of `selectedCount` — use
   *  when an outer mutation is pending. */
  disabled?: boolean;
  className?: string;
}

export function BulkActionsMenu({
  selectedCount,
  actions,
  label = 'Actions',
  disabled,
  className,
}: BulkActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerDisabled = disabled || selectedCount === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* VeloExpense kit: Radix's `asChild` where ExpenseOS's Base UI trigger took `render`. */}
      <PopoverTrigger asChild className={className}>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={triggerDisabled}
          className="font-bold"
        >
          {label}
          <IconChevronDown size={12} className="ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-56 p-1">
        <div className="space-y-0.5">
          {actions.map((a, i) => {
            if ('divider' in a) {
              // biome-ignore lint/suspicious/noArrayIndexKey: dividers carry no identity
              return <MenuDivider key={`d-${i}`} />;
            }
            return (
              <MenuItem
                key={a.id}
                icon={a.icon}
                destructive={a.destructive}
                disabled={a.disabled}
                onClick={() => {
                  if (a.disabled) return;
                  setOpen(false);
                  a.onSelect();
                }}
              >
                {a.label}
              </MenuItem>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

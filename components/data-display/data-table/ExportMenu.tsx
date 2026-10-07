'use client';

/**
 * ExportMenu — the right-side data-table toolbar trigger that exposes
 * download formats (CSV, Excel, PDF, etc.).
 *
 * Caller supplies `formats` (the full ordered list) and an optional
 * `disabledFormats` subset; disabled rows render with a "Coming soon"
 * trailing badge and ignore clicks. Available rows fire `onExport`
 * with the chosen format and close the popover.
 *
 * Trigger is a ghost button so it doesn't compete with the bordered
 * BulkActionsMenu on the left — the toolbar's two clusters read as
 * primary-action / view-control respectively.
 */

import { IconChevronDown, IconDownload } from '@tabler/icons-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MenuItem } from './Menu';

export interface ExportMenuProps<TFormat extends string = string> {
  /** Full list of formats to render, in order. */
  formats: readonly TFormat[];
  /** Subset that should render disabled with a "Coming soon" hint.
   *  Defaults to `[]` (all formats enabled). */
  disabledFormats?: readonly TFormat[];
  /** Fired with the chosen format on click. */
  onExport?: (format: TFormat) => void;
  /** Trigger label. Defaults to "Export". */
  label?: string;
  /** Trailing-badge copy for disabled rows. Defaults to "Coming soon". */
  disabledLabel?: string;
  className?: string;
}

export function ExportMenu<TFormat extends string = string>({
  formats,
  disabledFormats = [],
  onExport,
  label = 'Export',
  disabledLabel = 'Coming soon',
  className,
}: ExportMenuProps<TFormat>) {
  const [open, setOpen] = useState(false);
  const disabledSet = new Set<TFormat>(disabledFormats);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* VeloExpense kit: Radix's `asChild` where ExpenseOS's Base UI trigger took `render`. */}
      <PopoverTrigger asChild className={className}>
        <Button type="button" variant="ghost" size="sm">
          <IconDownload size={14} className="mr-1" />
          {label}
          <IconChevronDown size={12} className="ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-48 p-1">
        <div className="space-y-0.5">
          {formats.map((fmt) => {
            const isDisabled = disabledSet.has(fmt);
            return (
              <MenuItem
                key={fmt}
                disabled={isDisabled}
                trailing={isDisabled ? disabledLabel : undefined}
                onClick={() => {
                  if (isDisabled) return;
                  setOpen(false);
                  onExport?.(fmt);
                }}
              >
                {fmt}
              </MenuItem>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

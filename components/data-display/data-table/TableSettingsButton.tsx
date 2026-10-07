'use client';

import { IconSettings2 } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cls, DENSITY_ICON } from './helpers';
import type { DataTableLabels, Density } from './types';

/**
 * Table settings dropdown — consolidates column visibility, group-by,
 * and density into one toolbar button. Reorder is handled by dragging
 * the column header, so this menu has no ↑/↓ controls in the column
 * section.
 */
export function TableSettingsButton<C extends string, G extends string>({
  columnOrder,
  columnVisibility,
  onVisibilityChange,
  columnLabelFor,
  groupBy,
  onGroupChange,
  groupOptions,
  density,
  onDensityChange,
  onReset,
  labels,
}: {
  columnOrder: C[];
  columnVisibility: Record<C, boolean>;
  onVisibilityChange: (vis: Record<C, boolean>) => void;
  columnLabelFor: (c: C) => string;
  /** Group-by section is optional — when these three props are
   *  omitted, the popover renders Columns + Density only. */
  groupBy?: G;
  onGroupChange?: (g: G) => void;
  groupOptions?: Array<{ value: G; label: string }>;
  density: Density;
  onDensityChange: (d: Density) => void;
  onReset: () => void;
  labels: DataTableLabels['settings'];
}) {
  // A column is visible unless explicitly `false` (matches the table renderer's
  // `columnVisibility[id] !== false` rule) — so a missing/undefined entry means
  // visible. Derive checked + the toggle target from that same rule, otherwise
  // visible-by-default columns render unchecked and the first click is a no-op.
  const isVisible = (col: C) => columnVisibility[col] !== false;
  const toggleVis = (col: C) => {
    onVisibilityChange({ ...columnVisibility, [col]: !isVisible(col) });
  };

  const densityLabel: Record<Density, string> = {
    compact: labels.densityCompact,
    normal: labels.densityNormal,
    comfortable: labels.densityComfortable,
  };

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-foreground text-sm hover:bg-muted"
        aria-label={labels.trigger}
        title={labels.trigger}
      >
        <IconSettings2 size={14} />
        {labels.trigger}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-72 p-0">
        <Section label={labels.columns}>
          {columnOrder.map((col) => (
            <label
              key={col}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={isVisible(col)}
                onChange={() => toggleVis(col)}
                className="h-4 w-4"
              />
              <span className="flex-1">{columnLabelFor(col)}</span>
            </label>
          ))}
        </Section>
        {groupOptions && onGroupChange && (
          <>
            <Divider />
            <Section label={labels.groupBy}>
              {groupOptions.map((o) => (
                <RadioRow
                  key={o.value}
                  label={o.label}
                  checked={groupBy === o.value}
                  onSelect={() => onGroupChange(o.value)}
                />
              ))}
            </Section>
          </>
        )}
        <Divider />
        <Section label={labels.density}>
          {(['compact', 'normal', 'comfortable'] as Density[]).map((d) => {
            const Icon = DENSITY_ICON[d];
            return (
              <RadioRow
                key={d}
                label={densityLabel[d]}
                checked={density === d}
                onSelect={() => onDensityChange(d)}
                icon={<Icon size={14} className="text-muted-foreground" />}
              />
            );
          })}
        </Section>
        <Divider />
        <div className="p-1">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onReset}>
            {labels.resetDefaults}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-2 py-2">
      <div className="px-1 pb-1.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}

function RadioRow({
  label,
  checked,
  onSelect,
  icon,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground text-sm hover:bg-muted"
    >
      <span
        aria-hidden
        className={cls(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary' : 'border-border',
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      {icon}
      <span className="flex-1">{label}</span>
    </button>
  );
}

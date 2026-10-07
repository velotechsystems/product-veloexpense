'use client';

import type { ReactNode } from 'react';
import { cls } from './helpers';

/**
 * MenuItem — a clickable row inside any data-table popover (column
 * actions, row actions, table settings, bulk actions). Pass
 * `destructive` for Delete / Deactivate-style entries, `disabled` to
 * grey-out and ignore clicks. `icon` is optional — when omitted, the
 * item label sits flush to the popover padding.
 */
export function MenuItem({
  icon,
  onClick,
  children,
  destructive = false,
  disabled = false,
  trailing,
}: {
  icon?: ReactNode;
  onClick: () => void;
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Slot rendered at the right edge of the row — use for shortcuts,
   *  badges, or "Coming soon" hints. */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cls(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {trailing ? <span className="ml-auto text-muted-foreground text-xs">{trailing}</span> : null}
    </button>
  );
}

/** 1-px horizontal rule used between menu sections. */
export function MenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}

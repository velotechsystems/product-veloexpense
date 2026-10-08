'use client';

import type { Icon as TablerIcon } from '@tabler/icons-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface NavLinkProps {
  label: string;
  icon?: TablerIcon;
  active?: boolean;
  onClick?: () => void;
  /** Optional badge (e.g. unread notification count). Renders as a red pill on the right.
   *  Kit: white on `bg-destructive`, as the kit's destructive button is — the kit's tokens
   *  have no `--destructive-foreground` (ExpenseOS's do), so that class painted nothing. */
  badge?: string | number;
  disabled?: boolean;
  href?: string;
  /** Override the rendered element — useful when wrapping with a router link. */
  as?: React.ElementType;
  className?: string;
}

/**
 * NavLink — a single nav row inside <Sidebar>.
 *
 * Assumes a navy sidebar surface: white-faded text inactive, white text +
 * orange background + 3px white left-accent active, optional notification
 * badge. The hover state is handled by Tailwind's group/peer-style classes.
 */
export const NavLink: React.FC<NavLinkProps> = ({
  label,
  icon: IconComponent,
  active = false,
  onClick,
  badge,
  disabled = false,
  href,
  as: Element = 'button',
  className,
}) => {
  return (
    <Element
      type={Element === 'button' ? 'button' : undefined}
      href={Element === 'a' ? href : undefined}
      onClick={disabled ? undefined : onClick}
      disabled={Element === 'button' ? disabled : undefined}
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex w-full items-center gap-2.5 py-2 pr-[18px] pl-[15px] text-left font-normal text-[13px] transition-colors',
        'border-l-[3px] border-l-transparent',
        active && 'font-semibold',
        // Inactive: text + hover treatments come from className so the
        // CSS :hover pseudo can win (inline `style` always beats it).
        !active &&
          !disabled &&
          'text-[color:var(--sidebar-item-text)] hover:border-l-[color:var(--sidebar-item-accent-color-hover)] hover:bg-[color:var(--sidebar-item-bg-hover)] hover:text-[color:var(--sidebar-item-text-hover)]',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      style={
        active
          ? {
              color: 'var(--sidebar-item-text-active)',
              background: 'var(--sidebar-item-bg-active)',
              borderLeftColor: 'var(--sidebar-item-accent-color)',
            }
          : undefined
      }
    >
      {IconComponent && (
        <span className="inline-flex w-5 shrink-0 items-center justify-center" aria-hidden>
          <IconComponent size={15} />
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && badge !== null && badge !== '' && (
        <span
          role="status"
          aria-label={typeof badge === 'number' ? `${badge} notifications` : undefined}
          className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 font-bold text-[10px] text-white"
        >
          {typeof badge === 'number' && badge > 99 ? '99+' : badge}
        </span>
      )}
    </Element>
  );
};

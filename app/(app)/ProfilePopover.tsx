'use client';

import { Avatar, Button, Popover, PopoverContent, PopoverTrigger } from '@expenseos/design-system';
import { IconChevronUp, IconLogout, IconUserCircle } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

interface ProfilePopoverProps {
  name: string;
  roleLabel: string;
  email: string;
}

/**
 * Sidebar profile popover. Combines the visible user pill (name +
 * role) with a popover menu containing the profile link and the
 * sign-out action.
 *
 * VeloExpense: three ExpenseOS items are not here.
 *   · The language switcher. VeloExpense is English-only for now (decided 7 Oct): the
 *     fr-CA catalogues are ported but switched off, and VeloExpense's URLs carry no locale
 *     segment for the switcher to rewrite. It comes back, with `users.setLocalePref`, when
 *     French is switched on.
 *   · "Install ExpenseOS". VeloExpense is not a PWA; there is no install section to link to.
 *   · Locale-prefixed links. `/${locale}/profile` is VeloExpense's `/preferences`, and
 *     sign-out returns to `/login`.
 */
export function ProfilePopover({ name, roleLabel, email }: ProfilePopoverProps) {
  const router = useRouter();
  const tProfile = useTranslations('nav.profile');
  const tItems = useTranslations('nav.items');
  const [open, setOpen] = useState(false);

  const displayName = name || email || 'User';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Trigger renders as a button. Children are flexed inline-grade
          so the orange avatar / name / role / chevron all sit on one row.
          Sidebar tokens (`--sidebar-item-*`) are not registered Tailwind
          theme colors, so we reach into them with inline styles instead
          of `text-sidebar-foreground` (which doesn't exist).
          VeloExpense: ExpenseOS's navy sidebar hard-coded white text; VeloExpense's
          sidebar is light, so the colours come from the sidebar roles (lib-ui-kit tokens). */}
      <PopoverTrigger
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--sidebar-item-bg-hover)]"
        aria-label={displayName}
      >
        {/* VeloExpense: the reader's name and initials are tenant DATA, so `translate="no"`
            (a browser's translate prompt, and the pseudo-locale crawl, leave them alone), as
            VeloExpense's shell did. `contents`, so the wrapper adds no box to the row. */}
        <span translate="no" className="contents">
          <Avatar initials={initials(displayName)} alt={displayName} size="md" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate font-medium text-xs"
            style={{ color: 'var(--sidebar-item-text)' }}
            translate="no"
          >
            {displayName}
          </span>
          <span
            className="block truncate text-[10px]"
            style={{ color: 'var(--sidebar-profile-role-color)' }}
          >
            {roleLabel}
          </span>
        </span>
        <IconChevronUp
          size={14}
          className="shrink-0 opacity-50 group-hover:opacity-100"
          style={{ color: 'var(--sidebar-item-text)' }}
        />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 p-2">
        {/* Identity */}
        <div className="px-2 pt-1 pb-2">
          {/* VeloExpense: tenant data, as on the pill. */}
          <div className="truncate font-semibold text-foreground text-sm" translate="no">
            {displayName}
          </div>
          <div className="truncate text-muted-foreground text-xs" translate="no">
            {email}
          </div>
          <div className="mt-1 text-muted-foreground text-xs">{roleLabel}</div>
        </div>
        <div className="my-1 h-px bg-border" />

        {/* My Profile */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => {
            setOpen(false);
            router.push('/preferences');
          }}
        >
          <IconUserCircle size={14} />
          {tItems('myProfile')}
        </Button>

        <div className="my-1 h-px bg-border" />

        {/* Sign out */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => void signOut({ callbackUrl: '/login' })}
        >
          <IconLogout size={14} />
          {tProfile('signOut')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase();
}

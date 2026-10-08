import type * as React from 'react';

export interface SidebarProfileProps {
  /** Full name — used for the displayed name and initials avatar. */
  name: string;
  /**
   * Human-readable role / title shown below the name (e.g. "System Administrator").
   *
   * Named `roleLabel` rather than `role` to avoid collision with the standard
   * HTML/ARIA `role` attribute — that name would trip a11y linters.
   */
  roleLabel: string;
  /** Explicit initials override; defaults to first letter of each word. */
  initials?: string;
  /** Click handler for the logout button. */
  onLogout?: () => void;
  /** Aria-label for the logout button. */
  logoutLabel?: string;
}

function deriveInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase())
    .slice(0, 2)
    .join('');
}

/**
 * SidebarProfile — orange-circle initials avatar + name + role + logout
 * button. Bottom slot of <Sidebar>.
 *
 * Kit: text colours come from the sidebar roles in tokens/tailwind-v4.css (ExpenseOS painted
 * them white on its navy sidebar), so the block follows each product's brand and dark mode.
 */
export const SidebarProfile: React.FC<SidebarProfileProps> = ({
  name,
  roleLabel,
  initials,
  onLogout,
  logoutLabel = 'Log out',
}) => {
  const resolvedInitials = initials ?? deriveInitials(name);

  return (
    <div className="flex items-center gap-2.5">
      <div
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground text-xs"
      >
        {resolvedInitials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[color:var(--sidebar-item-text)] text-xs">{name}</div>
        <div
          className="truncate text-[10px]"
          style={{ color: 'var(--sidebar-profile-role-color)' }}
        >
          {roleLabel}
        </div>
      </div>
      {onLogout && (
        <button
          type="button"
          onClick={onLogout}
          aria-label={logoutLabel}
          title={logoutLabel}
          className="cursor-pointer border-none bg-transparent p-1 text-sm hover:text-[color:var(--sidebar-item-text-hover)]"
          style={{ color: 'var(--sidebar-section-color)' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label={logoutLabel}
          >
            <title>{logoutLabel}</title>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      )}
    </div>
  );
};

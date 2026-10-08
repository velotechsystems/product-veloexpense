import type * as React from 'react';

export interface SidebarSectionProps {
  /** Section header label — uppercase, small-caps, white-faded. */
  label?: string;
  /** Nav items in this section — typically <NavLink>s. */
  children: React.ReactNode;
}

/**
 * SidebarSection — groups <NavLink>s under a small-caps header.
 *
 * When `label` is omitted, only the children render. Useful for the top
 * section of the sidebar that doesn't need a heading.
 */
export const SidebarSection: React.FC<SidebarSectionProps> = ({ label, children }) => {
  return (
    <div className="mb-1">
      {label && (
        <div
          className="px-[18px] pt-2.5 pb-1 font-bold text-[10px] uppercase tracking-[0.08em]"
          style={{ color: 'var(--sidebar-section-color)' }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  );
};

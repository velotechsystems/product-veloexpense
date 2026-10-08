import type * as React from 'react';

export interface SidebarHeaderProps {
  /** Logo content — typically an <img> or icon component. */
  logo?: React.ReactNode;
  /** Product name shown below the logo. Optional. */
  productName?: string;
  /** Subtitle (version / environment) below the product name. Optional. */
  subtitle?: string;
}

/**
 * SidebarHeader — logo + product label block at the top of <Sidebar>.
 *
 * Kit: text colours come from the sidebar roles in tokens/tailwind-v4.css (ExpenseOS painted
 * them white on its navy sidebar), so the block follows each product's brand and dark mode.
 */
export const SidebarHeader: React.FC<SidebarHeaderProps> = ({ logo, productName, subtitle }) => {
  return (
    <div>
      {logo && <div className="mb-1">{logo}</div>}
      {productName && (
        <div className="font-semibold text-[13px] text-[color:var(--sidebar-item-text)] tracking-tight">{productName}</div>
      )}
      {subtitle && (
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--sidebar-section-color)' }}>
          {subtitle}
        </div>
      )}
    </div>
  );
};

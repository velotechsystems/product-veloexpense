import type { ComponentType } from 'react';

/**
 * Stat card color variant for semantic meaning.
 */
export type StatCardVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger';

/**
 * Trend direction for StatCard.
 */
export interface StatCardTrend {
  /**
   * Trend direction (up or down).
   */
  direction: 'up' | 'down';

  /**
   * Trend value (e.g., "+15%" or "-5%").
   */
  value: string;
}

/**
 * Props for the StatCard component.
 */
export interface StatCardProps {
  /**
   * Primary metric label (small text above value).
   */
  label: string;

  /**
   * Primary metric value (large text).
   */
  value: string | number;

  /**
   * Optional secondary value (small text below primary value).
   */
  secondaryValue?: string;

  /**
   * Optional icon component (Tabler icon).
   * Rendered in top-right corner at 24px size.
   */
  icon?: ComponentType<{ size?: number }>;

  /**
   * Optional trend indicator (up/down arrow with percentage).
   */
  trend?: StatCardTrend;

  /**
   * Color variant for the value text.
   * @default 'default'
   */
  variant?: StatCardVariant;

  /**
   * Optional click handler (makes card interactive).
   */
  onClick?: () => void;

  /**
   * Loading state (shows skeleton placeholder).
   * @default false
   */
  loading?: boolean;
}

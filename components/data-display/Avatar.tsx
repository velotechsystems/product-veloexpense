'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Avatar — circle with an image or initials fallback.
 *
 * Three sizes match the recurring usage in the app:
 *   - `sm` 24px — inline lists (e.g. direct-reports row in a drawer)
 *   - `md` 32px — table rows, popovers
 *   - `lg` 40px — detail drawer header
 *   - `xl` 72px — hero / profile page header
 *
 * Two variants:
 *   - `solid` (default) — `bg-primary` with primary-foreground text.
 *     The strong-fill avatar that anchors most lists.
 *   - `soft` — `bg-primary/15` with primary-colored text. Quieter;
 *     reserved for nested / dense contexts where many avatars compete
 *     for attention (e.g. the direct-reports list inside a drawer
 *     where the main avatar is already solid).
 *
 * Pass `imageUrl` for a real photo; the initials fallback paints when
 * the image is absent (or, in the future, fails to load — for now we
 * trust the URL).
 */

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export type AvatarVariant = 'solid' | 'soft';

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-[11px]',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-[72px] w-[72px] border-[3px] border-white/30 text-2xl',
};

const VARIANT_CLASSES: Record<AvatarVariant, string> = {
  solid: 'bg-primary text-primary-foreground',
  soft: 'bg-primary/15 text-primary',
};

export interface AvatarProps {
  /** Optional photo URL. When provided the initials are not shown. */
  imageUrl?: string | null;
  /** Pre-computed initials to display when no `imageUrl` is given.
   *  Caller decides how to derive them — see `initialsFrom` helper. */
  initials?: string;
  /** Optional `alt` for the image variant; falls back to `initials`. */
  alt?: string;
  size?: AvatarSize;
  variant?: AvatarVariant;
  /** Render slot above / below the standard avatar — used for status
   *  dots, badges, or any consumer-specific overlay. */
  overlay?: ReactNode;
  className?: string;
}

export function Avatar({
  imageUrl,
  initials,
  alt,
  size = 'md',
  variant = 'solid',
  overlay,
  className,
}: AvatarProps) {
  const base = cn(
    'relative inline-flex shrink-0 items-center justify-center rounded-full font-bold',
    size === 'xl' && 'font-extrabold',
    SIZE_CLASSES[size],
    !imageUrl && VARIANT_CLASSES[variant],
    className,
  );

  if (imageUrl) {
    return (
      <span className={base}>
        {/* A plain <img>, not next/image: avatar URLs come from arbitrary external
            sources (Google), not from /public, and this package must not depend on
            Next. Was a biome-ignore for lint/performance/noImgElement, but that rule
            is not enabled here so the suppression only produced an unused-suppression
            warning. Kept as prose so the reasoning survives if it is ever turned on. */}
        <img
          src={imageUrl}
          alt={alt ?? initials ?? ''}
          className="h-full w-full rounded-full object-cover"
        />
        {overlay}
      </span>
    );
  }

  return (
    <span className={base} role="img" aria-label={alt}>
      {initials ?? ''}
      {overlay}
    </span>
  );
}

// `initialsFrom` is intentionally not exported from this file —
// it's in a sibling `initials.ts` module without `'use client'` so
// Server Components can call it. Re-exporting it from here would
// transitively mark it client-only.

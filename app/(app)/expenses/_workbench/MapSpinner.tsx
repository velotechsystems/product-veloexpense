'use client';

/**
 * The spinner over a map that is still loading — the app's first spinning element (spec
 * FR-3, NFR-10; UX arbitration U1). Shared by the saved line's small map and the route
 * modal's map; it owns only the icon and the overlay that centres it. Its parent must be
 * the map's sized, `relative` box.
 *
 * The icon turns only for people whose system allows motion (`motion-safe:`); with reduced
 * motion it is a still loader icon. It is `aria-hidden` in both modes: what a screen reader
 * hears depends on the map.
 *
 *   · `mode="line"` — the icon alone, with no live region. Up to five line maps load at
 *     once and five announcements would be noise; the line's map box says it instead,
 *     through its `aria-label` (loading, then the route) and `aria-busy`.
 *   · `mode="modal"` — the visible "Loading the map…" under the icon, inside the page's one
 *     `role="status"`. The visible text is the status text, so there is no `sr-only` copy.
 */

import { IconLoader2 } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';

export function MapSpinner({ mode }: { mode: 'line' | 'modal' }) {
  const t = useTranslations('expenses');
  const icon = (
    <IconLoader2
      aria-hidden
      size={mode === 'modal' ? 24 : 20}
      className="text-muted-foreground motion-safe:animate-spin"
    />
  );
  if (mode === 'line') {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
        {icon}
      </div>
    );
  }
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
    >
      <div className="flex flex-col items-center gap-2">
        {icon}
        <span className="text-muted-foreground text-xs">{t('route.picker.mapLoading')}</span>
      </div>
    </div>
  );
}

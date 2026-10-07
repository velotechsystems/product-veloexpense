'use client';

import { useSyncExternalStore } from 'react';
import { COMPACT_QUERY } from '@/lib/breakpoints';

/**
 * `useIsCompact` — is the viewport narrower than Tailwind's `md` breakpoint?
 *
 * Returns a plain boolean. `true` means compact (phone width, card tree),
 * `false` means regular (table tree). The polarity comes straight from
 * `COMPACT_QUERY`, which is phrased so `matches === true` means compact.
 *
 * This is the JS half of the single-tree mechanism: the hook decides which
 * tree MOUNTS, and the `CARDS_ONLY` / `TABLE_ONLY` cloak classes only cover
 * the pre-hydration default. Only one tree exists in the DOM at a time, so
 * component tests never see a duplicated row and never have to disambiguate
 * two copies of the same cell.
 *
 * SSR: `getServerSnapshot` returns `false`. The server has no viewport, so
 * the server-rendered markup is always the table tree; on a phone that
 * markup is CSS-cloaked until hydration flips it. Erring towards the table
 * is the safe direction — it is the layout the rest of the stack assumes.
 */

/**
 * Subscribe to viewport changes.
 *
 * Module-level (not an inline closure) so its identity is stable across
 * renders — `useSyncExternalStore` re-subscribes whenever `subscribe`
 * changes identity, and an inline arrow would tear down and rebuild the
 * listener on every commit.
 */
function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(COMPACT_QUERY);
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

/**
 * Read the current value.
 *
 * Returns the BOOLEAN, not the `MediaQueryList`. `matchMedia` hands back a
 * fresh object on each call, so returning the MQL would give React a new
 * reference every time it re-read the snapshot and it would loop forever
 * ("The result of getSnapshot should be cached"). A boolean compares by
 * value, so repeat calls are stable and there is nothing to tear.
 */
function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(COMPACT_QUERY).matches;
}

/** No viewport on the server — always the regular (table) tree. */
function getServerSnapshot(): boolean {
  return false;
}

export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

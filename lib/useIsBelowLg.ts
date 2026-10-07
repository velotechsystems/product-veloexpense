'use client';

import { useSyncExternalStore } from 'react';

/**
 * "Is the viewport below Tailwind's `lg`?" — the one seam the workbench's
 * chrome relocation is decided and tested through.
 *
 * WHY THIS IS APP-LOCAL AND NOT A DESIGN-SYSTEM TOKEN. The obvious home looks
 * like `packages/design-system/src/tokens/breakpoints.ts`, beside
 * `COMPACT_QUERY`. It is the wrong home. That module is imported by
 * `<DataTable>`, which has forty-two call sites, so adding an `lg` query there
 * turns a single route's viewport question into a shared-package change with
 * the whole table surface as its blast radius. This hook answers a question
 * exactly one route asks. It lives with the route's app.
 *
 * RELOCATION → JS. SUPPRESSION → CSS. This hook exists for the first half of
 * that rule and must not be reached for by the second. Where a viewport change
 * RELOCATES a control — the report chrome moving out of the rationed TopBar
 * slot and into a body-level action bar — one tree is selected here, in JS,
 * because two trees would define the report's action set twice and the copies
 * would drift the first time someone added an action. Where a viewport change
 * merely SUPPRESSES a region in favour of a notice, both subtrees stay in the
 * DOM and CSS picks: a JS branch there would UNMOUNT the stateful editors on a
 * desktop resize across 1024px and discard typed input with no recovery path.
 * The test for which applies is duplication of an accessible name or of a
 * source of truth — not the mechanism's fashion.
 */

/** Tailwind's `lg` breakpoint, in px. Mirrors the framework default. */
export const LG_BREAKPOINT_PX = 1024;

/**
 * Upper bound of the below-`lg` range, in px. `LG_BREAKPOINT_PX` minus the
 * sub-pixel epsilon — the same reasoning `breakpoints.ts` gives for `767.98`.
 *
 * `(max-width: 1024px)` would NOT be a complement of `min-width: 1024px` — at
 * exactly 1024px both match, so JS would mount the phone tree while CSS
 * un-cloaked the desktop one. `(max-width: 1023px)` fails the other way: on a
 * fractional viewport (browser zoom, a 1023.5px device-pixel-ratio window)
 * neither matches and the chrome disappears from both destinations at once.
 * 1023.98px is above every width a browser can report below 1024 and below
 * 1024 itself.
 */
export const BELOW_LG_MAX_WIDTH_PX = 1023.98;

/**
 * The below-`lg` media query. `matches === true` means below `lg` (the body
 * action bar); `false` means `lg` and up (the TopBar publication).
 *
 * ── POLARITY IS LOAD-BEARING, AND IT FAILS SILENTLY ─────────────────
 *
 * The query is deliberately phrased so `matches === true` MEANS below `lg`, so
 * it must stay a `max-width` one. An inverted `(min-width: 1024px)` would flip
 * which tree mounts — and here is the part worth stopping over: it would not
 * turn a single test red. The root Vitest polyfill at `tests/setup.ts:26-35`
 * answers `matches: false` to EVERY query, so under an inverted query every
 * existing test in this suite would keep passing while asserting the exact
 * opposite behaviour, and the mistake would ship. `useIsBelowLg.test.ts` pins
 * the literal for that reason — if you are here to change this string, that
 * test is the conversation you need to have first.
 *
 * The `satisfies` clause is the COMPILE-time half of the same pin: it keeps
 * the exact literal type intact while rejecting a `min-width:` rewrite at
 * build time. The exact VALUE is pinned at runtime by the test.
 */
export const BELOW_LG_QUERY = '(max-width: 1023.98px)' satisfies `(max-width: ${number}px)`;

/**
 * ONE `MediaQueryList` and one `change` listener for the whole app — not one
 * per mount.
 *
 * Modelled on `useCoarsePointer.ts`, and deliberately NOT on
 * `packages/design-system/src/hooks/useIsCompact.ts`. That hook calls
 * `window.matchMedia(COMPACT_QUERY)` fresh inside both `subscribe` and
 * `getSnapshot` (`useIsCompact.ts:44-58`), so every mount constructs its own
 * `MediaQueryList`. `useCoarsePointer.ts:30-41` already names that as the
 * shape that does not scale, and names THIS PAGE as the reason: three of the
 * four receipt-upload entry points are mounted together in
 * `/expenses/[reportId]`. The chrome relocation adds a fourth and fifth reader
 * to the same page. A module-level store registers one listener for as long as
 * anything is subscribed, and every caller reads the same already-correct
 * value.
 *
 * `undefined` = not resolved yet. `null` = this environment has no
 * `matchMedia`.
 */
let query: MediaQueryList | null | undefined;
let belowLg = false;
const listeners = new Set<() => void>();

const handleChange = (event: MediaQueryListEvent) => {
  belowLg = event.matches;
  for (const listener of listeners) listener();
};

/**
 * Resolve the `MediaQueryList` once, lazily, and leave the current answer in
 * `belowLg`.
 *
 * This runs from `getSnapshot`, i.e. during render. That is deliberate and it
 * is safe: constructing the list is idempotent and memoised right here, so a
 * StrictMode double render or a concurrent re-render still produces one list
 * and one answer. Resolving here rather than in `subscribe` is what stops a
 * component mounted AFTER hydration — a dialog opening, say — from painting a
 * frame of the desktop shape before its subscription lands.
 *
 * No `matchMedia` at all (a non-DOM environment, or a jsdom old enough to lack
 * it) reads as "not below `lg`" and never throws. Desktop is the safe
 * direction to fail in: a caller that gets `false` renders exactly what it
 * renders today.
 */
function resolve(): MediaQueryList | null {
  if (query === undefined) {
    query =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(BELOW_LG_QUERY)
        : null;
    belowLg = query?.matches === true;
  }
  return query;
}

const getSnapshot = () => {
  resolve();
  return belowLg;
};

/**
 * The server, and the hydration render, both answer `false` — `false` ⇒
 * DESKTOP ⇒ the TopBar publication. A product decision, not a placeholder.
 *
 * A viewport width is not knowable server-side; no request header carries it.
 * So the server and the hydration render emit today's DOM exactly as it stands
 * — the report chrome published into the TopBar slot — and a phone swaps to
 * the body action bar on the first client commit after hydration. That is the
 * safe direction in both senses: it is the shape every existing test in this
 * suite was written against, and it keeps them on today's behaviour rather
 * than quietly re-pointing them at a tree they were never written for.
 *
 * There is no hydration mismatch here and nothing needs
 * `suppressHydrationWarning`. React uses `getServerSnapshot` for the server
 * render AND for the hydration render, then re-renders if the client snapshot
 * differs. That is the mechanism, not a workaround for it.
 */
const getServerSnapshot = () => false;

function subscribe(onStoreChange: () => void): () => void {
  const list = resolve();
  if (list && listeners.size === 0) {
    // Nothing has been subscribed until now, so the `change` listener was
    // detached and the cached answer may have gone stale while it was off. Read
    // it again before anyone reads us.
    belowLg = list.matches;
    list.addEventListener('change', handleChange);
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    if (list && listeners.size === 0) list.removeEventListener('change', handleChange);
  };
}

/**
 * Whether the viewport is below Tailwind's `lg` — narrower than 1024px.
 *
 * `true` means below `lg`. Returns `false` on the server and on the hydration
 * render, then the true answer from the first client commit onward, and it
 * tracks changes after that (a desktop window dragged across 1024px, a tablet
 * rotating).
 *
 * Read it to decide what to RELOCATE, per the rule at the top of this file. A
 * region that is merely suppressed in favour of a notice does not come through
 * here — that is `hidden lg:contents` in a class list.
 */
export function useIsBelowLg(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * TEST-ONLY. Forget the resolved `MediaQueryList` and the cached answer, so the
 * next read calls `window.matchMedia` again.
 *
 * Same contract and same rationale as `resetCoarsePointerStore`. It has to
 * exist because the store resolves ONCE per module instance while a test module
 * is loaded once for the whole file: a `matchMedia` stub installed in
 * `beforeEach` would be ignored by every test after the first, which had
 * already fixed the answer for good. Vitest will not clean it up for us either
 * — `vitest.config.ts` sets neither `unstubGlobals` nor `restoreMocks`, and
 * `vi.restoreAllMocks()` does not undo a `vi.stubGlobal` in any case.
 *
 * The contract, so a caller can rely on it: call this and install the stub in
 * either order, as long as BOTH happen before the first render that reads the
 * store. A `beforeEach` is the right home for the reset.
 * `apps/web/src/test-utils/pointer.ts` wraps the pair, and resets THIS store
 * and the pointer store together — the two are independent and a test that
 * reset only one would leak the other across files.
 *
 * Safe only between tests, when nothing is mounted: it forgets its subscribers
 * rather than notifying them.
 */
export function resetIsBelowLgStore(): void {
  query?.removeEventListener('change', handleChange);
  query = undefined;
  belowLg = false;
  listeners.clear();
}

'use client';

import { useSyncExternalStore } from 'react';

/**
 * "Is the primary pointer a finger?" — the one seam every coarse-pointer
 * decision in this app is made and tested through.
 *
 * ATTRIBUTE → JS. SIZE → CSS. That single rule is why this hook exists at all
 * rather than a Tailwind `pointer-coarse:` variant, and it is the line to hold
 * when the next caller arrives. A touch target's 44px minimum is a
 * presentational property of a control that is ALREADY in the DOM, so CSS is
 * both cheaper and flicker-free and that decision belongs in a class list, not
 * here. Whether a control EXISTS cannot be CSS: `capture="environment"` on a
 * file input changes what the operating system's picker does, and no media
 * query can add or remove an attribute. So anything that changes MARKUP comes
 * through this hook; anything that changes APPEARANCE does not.
 *
 * `(pointer: coarse)`, and NOT `(any-pointer: coarse)`. `any-pointer` matches
 * when any pointer available to the device is coarse, so it matches a
 * touch-screen laptop with a mouse in hand — and a caller keyed on it would
 * render the phone shape to a mouse user who has a perfectly good file picker
 * two inches away. `pointer` asks about the PRIMARY pointer, which is the
 * question every caller actually means.
 */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * ONE `MediaQueryList` and one `change` listener for the whole app — not one
 * per mount.
 *
 * The obvious shape is `useState` + `useEffect`, and
 * `packages/design-system/src/components/ui/resizable-panels.tsx:70-76` does
 * exactly that. For a single component it is fine. It does not scale to this
 * hook's caller list: three of the four receipt-upload entry points live inside
 * `/expenses/[reportId]` and are mounted at the same time, so that shape would
 * construct three `MediaQueryList`s and register three `change` listeners to
 * answer one boolean — and each one would render `false` for a frame before its
 * own effect corrected it. A module-level store registers one listener for as
 * long as anything is subscribed, and every caller reads the same
 * already-correct value.
 *
 * `undefined` = not resolved yet. `null` = this environment has no
 * `matchMedia`.
 */
let query: MediaQueryList | null | undefined;
let coarse = false;
const listeners = new Set<() => void>();

const handleChange = (event: MediaQueryListEvent) => {
  coarse = event.matches;
  for (const listener of listeners) listener();
};

/**
 * Resolve the `MediaQueryList` once, lazily, and leave the current answer in
 * `coarse`.
 *
 * This runs from `getSnapshot`, i.e. during render. That is deliberate and it
 * is safe: constructing the list is idempotent and memoised right here, so a
 * StrictMode double render or a concurrent re-render still produces one list
 * and one answer. Resolving here rather than in `subscribe` is what stops a
 * component mounted AFTER hydration — a dialog opening, say — from painting a
 * frame of the desktop shape before its subscription lands.
 *
 * No `matchMedia` at all (a non-DOM environment, or a jsdom old enough to lack
 * it) reads as "not coarse" and never throws. Not-coarse is the safe direction
 * to fail in: a caller that gets `false` renders exactly what it renders today.
 */
function resolve(): MediaQueryList | null {
  if (query === undefined) {
    query =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(COARSE_POINTER_QUERY)
        : null;
    coarse = query?.matches === true;
  }
  return query;
}

const getSnapshot = () => {
  resolve();
  return coarse;
};

/**
 * The server, and the hydration render, both answer `false` — a product
 * decision, not a placeholder.
 *
 * `(pointer: coarse)` is not knowable server-side. No request header carries
 * it, and a user-agent guess would be wrong for precisely the devices that
 * matter (an iPad that reports as a Mac; a touch laptop). So a real phone's
 * first paint shows the single library-picker control — today's DOM, unchanged
 * — and the camera control appears on the first client commit after hydration.
 * That is the only answer available, and it is worth knowing when reading a
 * screen recording of a phone: the second control arriving a beat late is the
 * design, not a bug.
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
    coarse = list.matches;
    list.addEventListener('change', handleChange);
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    if (list && listeners.size === 0) list.removeEventListener('change', handleChange);
  };
}

/**
 * Whether the device's primary pointer is coarse — a finger rather than a
 * mouse.
 *
 * Read it to decide what to RENDER, per the rule at the top of this file.
 * Returns `false` on the server and on the hydration render, then the true
 * answer from the first client commit onward, and it tracks changes after that
 * (a tablet gaining a trackpad, a device rotating into a different pointer
 * profile).
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * TEST-ONLY. Forget the resolved `MediaQueryList` and the cached answer, so the
 * next read calls `window.matchMedia` again.
 *
 * This has to exist because the store resolves ONCE per module instance while a
 * test module is loaded once for the whole file: a `matchMedia` stub installed
 * in `beforeEach` would be ignored by every test after the first, which had
 * already fixed the answer for good. Vitest will not clean it up for us either
 * — `vitest.config.ts` sets neither `unstubGlobals` nor `restoreMocks`, and
 * `vi.restoreAllMocks()` does not undo a `vi.stubGlobal` in any case.
 *
 * The contract, so a caller can rely on it: call this and install the stub in
 * either order, as long as BOTH happen before the first render that reads the
 * store. A `beforeEach` is the right home for the reset.
 * `apps/web/src/test-utils/pointer.ts` wraps the pair.
 *
 * Safe only between tests, when nothing is mounted: it forgets its subscribers
 * rather than notifying them.
 */
export function resetCoarsePointerStore(): void {
  query?.removeEventListener('change', handleChange);
  query = undefined;
  coarse = false;
  listeners.clear();
}

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COARSE_POINTER_QUERY,
  resetCoarsePointerStore,
  useCoarsePointer,
} from './useCoarsePointer';

/**
 * The pointer seam, with no consumer yet.
 *
 * Four things are pinned here rather than left to the callers, because each one
 * is a decision that would be expensive to rediscover:
 *
 *   · the QUERY is `(pointer: coarse)`. `any-pointer` would match a
 *     touch-screen laptop with a mouse in hand, and the first caller's whole
 *     point is not to show a camera control to a mouse user;
 *   · a missing `matchMedia` reads as NOT coarse and does not throw — the
 *     caller then renders what it renders today;
 *   · however many callers mount, there is ONE `MediaQueryList` and one
 *     `change` listener. That is the reason this is a module store and not the
 *     `useState` + `useEffect` shape in `resizable-panels.tsx`;
 *   · the listener comes off when the last caller unmounts.
 *
 * `resetCoarsePointerStore()` in `beforeEach` is load-bearing, not hygiene. The
 * store resolves `matchMedia` once per module instance, and this file is one
 * module instance for all of its tests, so without the reset the second test
 * onwards would read the FIRST test's stub.
 */

type ChangeHandler = (event: MediaQueryListEvent) => void;

/**
 * Install a `window.matchMedia` that answers `matches` and can fire a real
 * `change`.
 *
 * `vi.stubGlobal` is the idiom this repo already uses for exactly this global —
 * see `packages/design-system/src/components/ui/resizable-panels.test.tsx:16`.
 * What it does NOT do is clean up after itself here: `vitest.config.ts` sets
 * neither `unstubGlobals` nor `restoreMocks`, and `vi.restoreAllMocks()` does
 * not undo a stubbed global. Hence the explicit `vi.unstubAllGlobals()` in
 * `afterEach` — without it this file would leave a coarse `matchMedia` behind
 * for whatever ran next in the same worker.
 *
 * The baseline it replaces is `tests/setup.ts`'s own stub, which answers
 * `matches: false` to every query. So every OTHER test in the suite sees a fine
 * pointer, which is the shape they were all written against.
 */
function stubMatchMedia(matches: boolean) {
  const handlers = new Set<ChangeHandler>();
  const list = {
    matches,
    media: COARSE_POINTER_QUERY,
    addEventListener: vi.fn((_type: string, handler: ChangeHandler) => {
      handlers.add(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: ChangeHandler) => {
      handlers.delete(handler);
    }),
  };
  const matchMedia = vi.fn(() => list);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    list,
    /** Live listener count — 1 while anything is subscribed, 0 after the last unmount. */
    get listenerCount() {
      return handlers.size;
    },
    /** Fire `change`, exactly as a browser would: list first, then the event. */
    emit(next: boolean) {
      list.matches = next;
      const event = { matches: next, media: COARSE_POINTER_QUERY } as MediaQueryListEvent;
      for (const handler of [...handlers]) handler(event);
    },
  };
}

beforeEach(() => {
  resetCoarsePointerStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoarsePointerStore();
  vi.restoreAllMocks();
});

describe('useCoarsePointer', () => {
  it('is true when the primary pointer is coarse', () => {
    const mq = stubMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
    // The ruling, pinned: primary pointer only.
    expect(mq.matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('is false when the primary pointer is fine', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
  });

  it('is false, and does not throw, where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);
  });

  it('follows a change event', () => {
    const mq = stubMatchMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);

    act(() => mq.emit(true));
    expect(result.current).toBe(true);

    act(() => mq.emit(false));
    expect(result.current).toBe(false);
  });

  it('keeps one MediaQueryList and one listener however many callers mount', () => {
    // Three of the four entry points are mounted together in /expenses/[reportId].
    const mq = stubMatchMedia(true);
    const first = renderHook(() => useCoarsePointer());
    const second = renderHook(() => useCoarsePointer());
    const third = renderHook(() => useCoarsePointer());

    expect(mq.matchMedia).toHaveBeenCalledTimes(1);
    expect(mq.list.addEventListener).toHaveBeenCalledTimes(1);
    expect(mq.listenerCount).toBe(1);
    expect([first, second, third].map((h) => h.result.current)).toEqual([true, true, true]);

    // All three see the same change, from the one listener.
    act(() => mq.emit(false));
    expect([first, second, third].map((h) => h.result.current)).toEqual([false, false, false]);
  });

  it('detaches the listener only once the last caller unmounts', () => {
    const mq = stubMatchMedia(true);
    const first = renderHook(() => useCoarsePointer());
    const second = renderHook(() => useCoarsePointer());

    first.unmount();
    expect(mq.list.removeEventListener).not.toHaveBeenCalled();
    expect(mq.listenerCount).toBe(1);

    second.unmount();
    expect(mq.list.removeEventListener).toHaveBeenCalledTimes(1);
    expect(mq.listenerCount).toBe(0);

    // Nothing is listening, so a later change is inert rather than an update
    // aimed at an unmounted tree.
    expect(() => mq.emit(false)).not.toThrow();
  });

  it('re-reads the query when a caller mounts again after the last one left', () => {
    // The window can change while nothing is subscribed, and the answer the next
    // caller reads has to be the current one, not the one cached before the gap.
    const mq = stubMatchMedia(false);
    renderHook(() => useCoarsePointer()).unmount();

    mq.list.matches = true;
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
    expect(mq.matchMedia).toHaveBeenCalledTimes(1);
  });
});

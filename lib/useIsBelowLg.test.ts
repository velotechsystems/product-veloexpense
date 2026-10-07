import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BELOW_LG_MAX_WIDTH_PX,
  BELOW_LG_QUERY,
  LG_BREAKPOINT_PX,
  resetIsBelowLgStore,
  useIsBelowLg,
} from './useIsBelowLg';

/**
 * The `lg` viewport seam.
 *
 * THE POLARITY PIN IS THE POINT OF THIS FILE, and it is pinned the way
 * `packages/design-system/tests/tokens/breakpoints.test.ts` pins `767.98`,
 * for the same reason and against the same failure mode. `BELOW_LG_QUERY` is
 * phrased so `matches === true` means BELOW `lg`. Inverting it to
 * `min-width: 1024px` would flip which tree mounts on this route — and it
 * would do so without reddening anything: the root `matchMedia` polyfill at
 * `tests/setup.ts:26-35` answers `matches: false` to every query, so under an
 * inverted query every existing test in this suite keeps passing while the app
 * does the opposite thing. These assertions exist so that mistake fails here,
 * loudly and in one place, instead of shipping green.
 *
 * Four more things are pinned rather than left to the callers:
 *
 *   · the SERVER snapshot is `false`, and `false` means desktop — the TopBar
 *     publication, i.e. today's DOM. That is the direction that keeps every
 *     existing test on today's behaviour;
 *   · however many callers mount, there is ONE `MediaQueryList` and one
 *     `change` listener. That is the reason this is a module store and not the
 *     per-mount shape in `useIsCompact.ts`, and the route this hook serves
 *     mounts four or five readers at once;
 *   · a `change` event reaches every subscriber;
 *   · `resetIsBelowLgStore()` actually clears the cached answer — without
 *     which the seam in `test-utils/pointer.ts` would leak a phone viewport
 *     across files in the same worker.
 *
 * `resetIsBelowLgStore()` in `beforeEach` is load-bearing, not hygiene. The
 * store resolves `matchMedia` once per module instance, and this file is one
 * module instance for all of its tests, so without the reset the second test
 * onwards would read the FIRST test's stub.
 */

type ChangeHandler = (event: MediaQueryListEvent) => void;

/**
 * Install a `window.matchMedia` that answers `matches` and can fire a real
 * `change`. The same helper shape as `useCoarsePointer.test.ts` — see its note
 * on why `vi.stubGlobal` needs the explicit `vi.unstubAllGlobals()` below.
 */
function stubMatchMedia(matches: boolean) {
  const handlers = new Set<ChangeHandler>();
  const list = {
    matches,
    media: BELOW_LG_QUERY,
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
      const event = { matches: next, media: BELOW_LG_QUERY } as MediaQueryListEvent;
      for (const handler of [...handlers]) handler(event);
    },
  };
}

/**
 * Render the hook through the SERVER renderer and hand back the markup.
 *
 * This is the only way to reach `getServerSnapshot` — a jsdom render always
 * takes the client path, so a test that asserted on `renderHook` would be
 * asserting the wrong branch. `renderToStaticMarkup` is the server render and
 * the hydration render both, which is exactly the window the assertion is
 * about.
 */
function serverRenderedAnswer(): string {
  function Probe() {
    return createElement('span', null, String(useIsBelowLg()));
  }
  return renderToStaticMarkup(createElement(Probe));
}

beforeEach(() => {
  resetIsBelowLgStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIsBelowLgStore();
  vi.restoreAllMocks();
});

describe('BELOW_LG_QUERY', () => {
  it('pins the media-query literal', () => {
    // The exact value, spelled out. The compile-time half of the pin (the
    // query must stay a `max-width` one) lives on the constant itself as a
    // `satisfies` clause.
    expect(BELOW_LG_QUERY).toBe('(max-width: 1023.98px)');
  });

  it('is a max-width query — polarity, not just value', () => {
    // Phrased independently of the literal above so a careless "fix" to one
    // assertion does not quietly satisfy the other.
    expect(BELOW_LG_QUERY).toMatch(/^\(max-width:/);
    expect(BELOW_LG_QUERY).not.toMatch(/min-width/);
  });

  it('is the sub-pixel-safe complement of the lg breakpoint', () => {
    // Strictly below `lg`, so the two queries can never both match…
    expect(BELOW_LG_MAX_WIDTH_PX).toBeLessThan(LG_BREAKPOINT_PX);
    // …and within one pixel of it, so they can never both miss.
    expect(LG_BREAKPOINT_PX - BELOW_LG_MAX_WIDTH_PX).toBeLessThan(1);
    // The query string is built from that number, not drifting beside it.
    expect(BELOW_LG_QUERY).toBe(`(max-width: ${BELOW_LG_MAX_WIDTH_PX}px)`);
  });

  it('mirrors Tailwind default lg (no --breakpoint-lg override in globals.css)', () => {
    expect(LG_BREAKPOINT_PX).toBe(1024);
  });
});

describe('useIsBelowLg', () => {
  it('is true below lg — matches === true MEANS below lg', () => {
    const mq = stubMatchMedia(true);
    const { result } = renderHook(() => useIsBelowLg());
    expect(result.current).toBe(true);
    // The polarity pin again, this time through the hook rather than the
    // constant: the hook must ask the max-width question and pass its answer
    // through unnegated.
    expect(mq.matchMedia).toHaveBeenCalledWith('(max-width: 1023.98px)');
  });

  it('is false at lg and above', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useIsBelowLg());
    expect(result.current).toBe(false);
  });

  it('is false, and does not throw, where matchMedia does not exist', () => {
    // Desktop is the safe direction to fail in: the caller renders what it
    // renders today.
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useIsBelowLg());
    expect(result.current).toBe(false);
  });

  it('answers false on the server — false means desktop, i.e. the TopBar', () => {
    // Read the server snapshot the way React does, through
    // `renderToString`, rather than by exporting it. `false` here is the
    // product decision: the server and the hydration render both emit today's
    // DOM, and a phone swaps to the body action bar on the first client
    // commit. Asserted directly because it is the one branch a jsdom render
    // can never reach.
    //
    // The stub says PHONE, and the server render must still say `false`: the
    // server has no viewport, so the answer is a decision rather than a
    // measurement, and the decision is desktop.
    stubMatchMedia(true);
    expect(serverRenderedAnswer()).toBe('<span>false</span>');
  });

  it('follows a change event', () => {
    const mq = stubMatchMedia(false);
    const { result } = renderHook(() => useIsBelowLg());
    expect(result.current).toBe(false);

    act(() => mq.emit(true));
    expect(result.current).toBe(true);

    act(() => mq.emit(false));
    expect(result.current).toBe(false);
  });

  it('keeps one MediaQueryList and one listener however many callers mount', () => {
    // The relocation adds a fourth and fifth reader to a page that already
    // mounts three. This is the assertion that says "module store", and it is
    // the one that fails if someone re-models this on `useIsCompact`.
    const mq = stubMatchMedia(true);
    const first = renderHook(() => useIsBelowLg());
    const second = renderHook(() => useIsBelowLg());

    expect(mq.matchMedia).toHaveBeenCalledTimes(1);
    expect(mq.list.addEventListener).toHaveBeenCalledTimes(1);
    expect(mq.listenerCount).toBe(1);
    expect([first, second].map((h) => h.result.current)).toEqual([true, true]);

    // Both see the same change, from the one listener.
    act(() => mq.emit(false));
    expect([first, second].map((h) => h.result.current)).toEqual([false, false]);
  });

  it('detaches the listener only once the last caller unmounts', () => {
    const mq = stubMatchMedia(true);
    const first = renderHook(() => useIsBelowLg());
    const second = renderHook(() => useIsBelowLg());

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
    // The window can be resized while nothing is subscribed, and the answer the
    // next caller reads has to be the current one, not the one cached before
    // the gap.
    const mq = stubMatchMedia(false);
    renderHook(() => useIsBelowLg()).unmount();

    mq.list.matches = true;
    const { result } = renderHook(() => useIsBelowLg());
    expect(result.current).toBe(true);
    expect(mq.matchMedia).toHaveBeenCalledTimes(1);
  });
});

describe('resetIsBelowLgStore', () => {
  it('clears the cached answer so the next read sees a new stub', () => {
    // This is the contract `test-utils/pointer.ts` depends on. Without it, the
    // store's resolve-once caching would hand every test after the first the
    // FIRST test's device — a phone viewport leaking across files in the same
    // worker, which is a cross-file failure a path-filtered run cannot
    // reproduce.
    const phone = stubMatchMedia(true);
    expect(renderHook(() => useIsBelowLg()).result.current).toBe(true);
    expect(phone.matchMedia).toHaveBeenCalledTimes(1);

    // A new stub alone is not enough — the store is still holding the old list.
    const desktop = stubMatchMedia(false);
    resetIsBelowLgStore();

    expect(renderHook(() => useIsBelowLg()).result.current).toBe(false);
    expect(desktop.matchMedia).toHaveBeenCalledTimes(1);
  });
});

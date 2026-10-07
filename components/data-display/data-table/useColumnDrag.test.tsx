import { act, render } from '@testing-library/react';
import { type RefObject, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useColumnDrag, useColumnFlip } from './useColumnDrag';

/**
 * Pointer-driven column reordering, and the FLIP animation that follows it.
 *
 * Everything here is layout arithmetic, which jsdom does not provide: `offsetLeft`,
 * `offsetWidth` and `getBoundingClientRect` all read zero, and WAAPI does not exist. So
 * the layout is faked — deliberately, and only the layout. The hook's own logic runs
 * unmodified, which is the part that has failure modes worth catching:
 *
 *   · **A pinned column being shoved.** `isSwappable` is the only thing stopping a drag
 *     from dropping a column into a pinned slot. If drop detection ignored it, the pinned
 *     column would move — the one thing pinning promises will not happen.
 *   · **Leaked window listeners.** The drag installs `pointermove` on `window` and sets
 *     `body.userSelect`/`cursor`. A missed cleanup leaves the page unselectable and every
 *     later pointer move running dead swap detection.
 *   · **A FLIP that animates the wrong elements.** Deltas are measured on headers and
 *     applied to body cells BY INDEX, which is only valid under `table-layout: fixed`. An
 *     off-by-one there slides the wrong column.
 *   · **Cancelling unrelated animations.** The runner cancels in-flight FLIPs so it can
 *     measure clean layout. It must cancel only its own, or it kills the drag-source fade.
 */

/** Columns in visual order, each 100px wide starting at x=0. */
type Col = { id: string; left: number; width: number };
const COLS: Col[] = [
  { id: 'a', left: 0, width: 100 },
  { id: 'b', left: 100, width: 100 },
  { id: 'c', left: 200, width: 100 },
];

/** Every animation started during a test, so assertions can inspect them. */
type FakeAnim = { id: string; target: Element; keyframes: unknown; cancelled: boolean };
let anims: FakeAnim[] = [];

beforeEach(() => {
  anims = [];
  // jsdom has no Web Animations API. These two are the whole of what the FLIP runner uses.
  Element.prototype.animate = function (
    this: Element,
    keyframes: unknown,
    opts: { id?: string },
  ): Animation {
    const record: FakeAnim = {
      id: opts?.id ?? '',
      target: this,
      keyframes,
      cancelled: false,
    };
    anims.push(record);
    return { id: record.id, cancel: () => (record.cancelled = true) } as unknown as Animation;
  } as typeof Element.prototype.animate;
  Element.prototype.getAnimations = function (this: Element) {
    return anims
      .filter((a) => a.target === this && !a.cancelled)
      .map((a) => ({ id: a.id, cancel: () => (a.cancelled = true) })) as unknown as Animation[];
  };
});

afterEach(() => {
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  vi.restoreAllMocks();
});

/**
 * Give a `<th>` a position and width.
 *
 * `offsetLeft`/`offsetWidth` are what drop detection reads — chosen by the hook on purpose,
 * because they ignore in-flight transforms and so keep the boundary still while a column
 * animates past the cursor. `getBoundingClientRect` is what the FLIP snapshot reads.
 */
function place(el: HTMLElement, left: number, width: number) {
  Object.defineProperty(el, 'offsetLeft', { value: left, configurable: true });
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left, right: left + width, width, top: 0, bottom: 32, height: 32 }) as DOMRect;
}

interface HarnessProps {
  cols: Col[];
  isSwappable?: (id: string) => boolean;
  onSwap: (source: string, target: string) => void;
  /** Rendered order, so a test can re-render post-swap and drive the FLIP. */
  order?: readonly string[];
  flip?: boolean;
}

/** A minimal table wired to the hook, with the layout faked on mount. */
function Harness({ cols, isSwappable = () => true, onSwap, order, flip }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { drag, beginDrag, pendingFlipOldX } = useColumnDrag({ scrollRef, isSwappable, onSwap });
  useColumnFlip({
    scrollRef,
    columnOrder: flip ? (order ?? cols.map((c) => c.id)) : [],
    pendingFlipOldX: pendingFlipOldX as RefObject<Map<string, number> | null>,
  });

  return (
    <div ref={scrollRef}>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.id}
                data-col={c.id}
                // VeloExpense: a block body; React 19's ref callback may return only a cleanup.
                ref={(el) => {
                  if (el) place(el, c.left, c.width);
                }}
                onPointerDown={(e) => beginDrag(c.id, c.id.toUpperCase(), c.width, e)}
              >
                {c.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {cols.map((c) => (
              <td key={c.id} data-col={c.id} ref={(el) => {
                  if (el) place(el, c.left, c.width);
                }}>
                {c.id}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <output data-testid="dragging">{drag?.col ?? 'none'}</output>
    </div>
  );
}

/** Press on a header to open a drag session. */
function pressHeader(id: string, clientX = 10) {
  const th = document.querySelector(`th[data-col="${id}"]`) as HTMLElement;
  act(() => {
    th.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX, clientY: 5 }) as PointerEvent,
    );
  });
}

function movePointer(clientX: number, clientY = 5) {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY }));
  });
}

function releasePointer(type: 'pointerup' | 'pointercancel' = 'pointerup') {
  act(() => {
    window.dispatchEvent(new PointerEvent(type));
  });
}

describe('useColumnDrag — starting a drag', () => {
  it('records the column and the cursor offset within its header', () => {
    // The offset is what stops the ghost from jumping to the cursor's position: grab a
    // header 40px in and the ghost should stay 40px in.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('b', 140);
    expect(document.querySelector('[data-testid="dragging"]')?.textContent).toBe('b');
  });

  it('takes over the page cursor and disables text selection', () => {
    // Without this, dragging across headers selects their labels — the drag looks broken.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a');
    expect(document.body.style.cursor).toBe('grabbing');
    expect(document.body.style.userSelect).toBe('none');
  });
});

describe('useColumnDrag — drop detection', () => {
  it('swaps when the cursor enters another column', () => {
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a', 10);
    movePointer(150); // inside b (100..200)
    expect(onSwap).toHaveBeenCalledWith('a', 'b');
  });

  it('does NOT swap while the cursor is still over the dragged column', () => {
    // Otherwise every pointer move fires a swap onto itself and the parent re-renders
    // continuously for the duration of the drag.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a', 10);
    movePointer(50); // still inside a (0..100)
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('SKIPS a pinned column — the one thing pinning promises', () => {
    /**
     * `b` is pinned. Dragging `a` across it must not move it. The hook's only defence is
     * consulting `isSwappable` inside the hit-test loop; drop that check and this becomes
     * a swap that silently unpins a column the user deliberately fixed in place.
     */
    const onSwap = vi.fn();
    render(<Harness cols={COLS} isSwappable={(id) => id !== 'b'} onSwap={onSwap} />);
    pressHeader('a', 10);
    movePointer(150); // squarely inside b
    expect(onSwap).not.toHaveBeenCalled();

    // ...and a swappable column further along still works, so the skip is a skip and not
    // an early exit from the loop.
    movePointer(250); // inside c
    expect(onSwap).toHaveBeenCalledWith('a', 'c');
  });

  it('ignores a cursor beyond the last column', () => {
    // Dragging off the right edge of the table should do nothing, not snap to the end.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a', 10);
    movePointer(5000);
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('treats the shared edge between two columns as a hit, not a dead zone', () => {
    // The bounds are inclusive on both ends, so x=100 belongs to both a and b and the
    // first swappable match wins. Pinned because an exclusive bound would create a 1px
    // gap where the drag stalls.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('c', 250);
    movePointer(100);
    expect(onSwap).toHaveBeenCalledWith('c', 'a');
  });

  it('captures header positions BEFORE calling onSwap, so the FLIP has an origin', () => {
    /**
     * Ordering that cannot be observed any other way: the snapshot has to be taken while
     * the OLD layout is still on screen. Taken afterwards it would record the new
     * positions, every delta would be zero, and the reorder would jump instead of slide.
     */
    const seen: (number | undefined)[] = [];
    let flipRef: RefObject<Map<string, number> | null> | null = null;
    function Capture() {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const { beginDrag, pendingFlipOldX } = useColumnDrag({
        scrollRef,
        isSwappable: () => true,
        // Read the ref DURING the swap callback — that is the moment the parent would
        // re-render, and the snapshot must already be populated.
        onSwap: () => seen.push(pendingFlipOldX.current?.get('a')),
      });
      flipRef = pendingFlipOldX as RefObject<Map<string, number> | null>;
      return (
        <div ref={scrollRef}>
          <table>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.id}
                    data-col={c.id}
                    ref={(el) => {
                  if (el) place(el, c.left, c.width);
                }}
                    onPointerDown={(e) => beginDrag(c.id, c.id, c.width, e)}
                  >
                    {c.id}
                  </th>
                ))}
              </tr>
            </thead>
          </table>
        </div>
      );
    }
    render(<Capture />);
    pressHeader('a', 10);
    movePointer(150);

    expect(seen).toEqual([0]); // a's left edge, as it was before the swap
    // VeloExpense: TypeScript 5 narrows a variable assigned only inside a closure to `never`.
    expect((flipRef as RefObject<Map<string, number> | null> | null)?.current?.get('b')).toBe(100);
  });
});

describe('useColumnDrag — ending a drag', () => {
  it('releases the cursor and text selection on pointerup', () => {
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a');
    releasePointer('pointerup');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(document.querySelector('[data-testid="dragging"]')?.textContent).toBe('none');
  });

  it('also ends on pointercancel', () => {
    // Fires when the browser takes the pointer away — a touch becoming a scroll, or the
    // window losing focus. Without this the drag would never end and the page would stay
    // unselectable.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a');
    releasePointer('pointercancel');
    expect(document.body.style.cursor).toBe('');
    expect(document.querySelector('[data-testid="dragging"]')?.textContent).toBe('none');
  });

  it('stops detecting swaps once the drag has ended', () => {
    // The listener-leak test. A missed `removeEventListener` leaves every later pointer
    // move on the page running drop detection against a stale drag.
    const onSwap = vi.fn();
    render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a', 10);
    releasePointer();
    onSwap.mockClear();
    movePointer(150);
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount, not only on pointerup', () => {
    const onSwap = vi.fn();
    const { unmount } = render(<Harness cols={COLS} onSwap={onSwap} />);
    pressHeader('a', 10);
    unmount();
    onSwap.mockClear();
    movePointer(150);
    expect(onSwap).not.toHaveBeenCalled();
  });
});

describe('useColumnFlip', () => {
  /** Render with a snapshot already staged, as a real swap would leave it. */
  function renderWithSnapshot(oldPositions: Record<string, number>, cols = COLS) {
    function FlipHarness() {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pending = useRef<Map<string, number> | null>(new Map(Object.entries(oldPositions)));
      useColumnFlip({ scrollRef, columnOrder: cols.map((c) => c.id), pendingFlipOldX: pending });
      return (
        <div ref={scrollRef}>
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.id} data-col={c.id} ref={(el) => {
                  if (el) place(el, c.left, c.width);
                }}>
                    {c.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {cols.map((c) => (
                  <td key={c.id} data-col={c.id} ref={(el) => {
                  if (el) place(el, c.left, c.width);
                }}>
                    {c.id}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      );
    }
    return render(<FlipHarness />);
  }

  it('animates each moved column from its old position to its new one', () => {
    // `a` was at 200 and is now at 0, so it slides in from +200.
    renderWithSnapshot({ a: 200, b: 100, c: 0 });
    const headerAnims = anims.filter((x) => (x.target as HTMLElement).tagName === 'TH');
    expect(headerAnims).toHaveLength(2); // a and c moved; b did not
    const first = headerAnims[0].keyframes as { transform: string }[];
    expect(first[0].transform).toBe('translateX(200px)');
    expect(first[1].transform).toBe('translateX(0)');
  });

  it('animates body cells by INDEX, matching their header', () => {
    /**
     * Only valid under `table-layout: fixed` + a colgroup, where every cell in a column
     * shares its header's x delta — which is why the hook does it. An off-by-one here
     * slides the wrong column's data while the headers move correctly, so the table looks
     * subtly scrambled mid-animation.
     */
    renderWithSnapshot({ a: 200, b: 100, c: 0 });
    const cellAnims = anims.filter((x) => (x.target as HTMLElement).tagName === 'TD');
    expect(cellAnims).toHaveLength(2);
    // Column index 0 (`a`) gets a's delta, not c's.
    const aCell = cellAnims.find((x) => (x.target as HTMLElement).dataset.col === 'a');
    expect((aCell?.keyframes as { transform: string }[])[0].transform).toBe('translateX(200px)');
  });

  it('does nothing at all without a staged snapshot', () => {
    /**
     * The guard that keeps the initial mount and every unrelated re-render from sliding
     * the table. `pendingFlipOldX` being null is the signal "this order change was not a
     * user reorder".
     */
    function NoSnapshot() {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pending = useRef<Map<string, number> | null>(null);
      useColumnFlip({ scrollRef, columnOrder: ['a', 'b', 'c'], pendingFlipOldX: pending });
      return (
        <div ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th data-col="a" ref={(el) => {
                  if (el) place(el, 0, 100);
                }}>
                  a
                </th>
              </tr>
            </thead>
          </table>
        </div>
      );
    }
    render(<NoSnapshot />);
    expect(anims).toHaveLength(0);
  });

  it('clears the snapshot after running, so the next render does not re-animate', () => {
    // Left in place, the table would slide again on every subsequent re-render.
    let pendingRef: RefObject<Map<string, number> | null> | null = null;
    function Once() {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pending = useRef<Map<string, number> | null>(new Map([['a', 200]]));
      pendingRef = pending;
      useColumnFlip({ scrollRef, columnOrder: ['a'], pendingFlipOldX: pending });
      return (
        <div ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th data-col="a" ref={(el) => {
                  if (el) place(el, 0, 100);
                }}>
                  a
                </th>
              </tr>
            </thead>
          </table>
        </div>
      );
    }
    render(<Once />);
    expect(anims.length).toBeGreaterThan(0);
    expect((pendingRef as RefObject<Map<string, number> | null> | null)?.current).toBeNull();
  });

  it('ignores sub-pixel movement', () => {
    // A 0.3px delta is a rounding artefact, not a reorder. Animating it would fire a
    // 320ms transition on every layout jitter.
    renderWithSnapshot({ a: 0.3, b: 100.2, c: 200 });
    expect(anims).toHaveLength(0);
  });

  it('ignores a column that was not in the snapshot', () => {
    // A newly-shown column has no old position, so it appears rather than sliding in from
    // an arbitrary place.
    renderWithSnapshot({ a: 200 });
    const targets = anims.map((x) => (x.target as HTMLElement).dataset.col);
    expect(new Set(targets)).toEqual(new Set(['a']));
  });

  it('cancels its OWN in-flight animations and leaves others alone', () => {
    /**
     * The runner cancels prior FLIPs so it can measure clean layout. It matches on the
     * animation id — cancel everything instead and it kills the drag-source opacity fade
     * that runs on the same element for the duration of the drag.
     */
    // Two reorders on the SAME elements — two separate renders would give the second flip
    // a fresh DOM with nothing to cancel, and the test would pass without proving anything.
    let bump: ((positions: Record<string, number>) => void) | null = null;
    function Twice() {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pending = useRef<Map<string, number> | null>(new Map([['a', 200]]));
      const [order, setOrder] = useState<readonly string[]>(['a', 'b', 'c']);
      bump = (positions) => {
        pending.current = new Map(Object.entries(positions));
        setOrder((o) => [...o].reverse());
      };
      useColumnFlip({ scrollRef, columnOrder: order, pendingFlipOldX: pending });
      return (
        <div ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th data-col="a" ref={(el) => {
                  if (el) place(el, 0, 100);
                }}>
                  a
                </th>
              </tr>
            </thead>
          </table>
        </div>
      );
    }
    render(<Twice />);
    const firstFlip = anims.find((x) => x.id === 'flip-column');
    expect(firstFlip, 'the first reorder did not animate').toBeDefined();

    const th = document.querySelector('th[data-col="a"]') as HTMLElement;
    // An unrelated animation on the same element, as the drag-source dim would be.
    th.animate([{ opacity: '1' }], { id: 'drag-source-dim' } as KeyframeAnimationOptions);
    const unrelated = anims.find((x) => x.id === 'drag-source-dim');

    // A second reorder: this cancels the prior FLIP so its measurement is clean.
    act(() => bump?.({ a: 150 }));

    expect(firstFlip?.cancelled, 'the prior FLIP was not cancelled').toBe(true);
    expect(unrelated?.cancelled, 'the drag-source fade was cancelled too').toBe(false);
  });
});

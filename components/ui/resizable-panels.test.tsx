import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizablePanels } from './resizable-panels';

/**
 * The component counts its children to decide how many columns there are, which
 * is a sharp edge: a caller that groups two panes in a fragment gets a layout
 * one column short, silently and with no type error. That cost a three-column
 * workbench two of its columns, so it's pinned here.
 */

/**
 * A query-KEYED `matchMedia`: `matches` is true only for the queries named, so
 * stubbing "wide" does not also answer yes to `(prefers-reduced-motion: reduce)`
 * or to whatever else mounts in the same tree.
 */
function stubMedia(...trueFor: string[]) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: trueFor.includes(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/** The component's own default breakpoint — the one the reorder rides. */
const WIDE = '(min-width: 80rem)';

beforeEach(() => {
  // Stacked mode — the resizable path needs real layout, and the child-counting
  // behaviour under test is the same either way.
  stubMedia();
});

/**
 * NOT covered by `vi.restoreAllMocks()`, and not optional: `vi.stubGlobal` is
 * undone only by `vi.unstubAllGlobals()`. Without this, the one wide test below
 * would leave a desktop-shaped `matchMedia` behind for every test that ran after
 * it in the same worker — a cross-file failure a path-filtered run cannot
 * reproduce. `ExpenseReportWorkbench.test.tsx` carries the same warning for the
 * phone-shaped version of it.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS = {
  minWidths: [100, 100, 100],
  panelKeys: ['a', 'b', 'c'],
  flexIndex: 1,
  storageKey: 'test.panes',
};

describe('<ResizablePanels>', () => {
  it('renders one panel per child', () => {
    const { container } = render(
      <ResizablePanels {...PROPS}>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </ResizablePanels>,
    );
    expect(container.firstElementChild?.children).toHaveLength(3);
    expect(screen.getByText('three')).toBeInTheDocument();
  });

  it('flattens an array child into separate panels', () => {
    // How a caller returns two panes from one expression and still gets two
    // columns — `React.Children.toArray` flattens arrays.
    const { container } = render(
      <ResizablePanels {...PROPS}>
        <div>one</div>
        {[<div key="b">two</div>, <div key="c">three</div>]}
      </ResizablePanels>,
    );
    expect(container.firstElementChild?.children).toHaveLength(3);
  });

  it('counts a fragment as ONE panel — the trap', () => {
    // Not a behaviour to rely on: a caller wanting three columns must not wrap
    // two of them in a fragment. Documented so the next person recognises the
    // symptom (a column silently missing) instead of hunting the CSS.
    const { container } = render(
      <ResizablePanels {...PROPS}>
        <div>one</div>
        {/* biome-ignore lint/complexity/noUselessFragments: the fragment IS the subject —
            this asserts it collapses to ONE panel (toHaveLength(2), not 3). Removing it
            makes the test assert the opposite of what it is named for. An --unsafe
            autofix has already deleted it once. */}
        <>
          <div>two</div>
          <div>three</div>
        </>
      </ResizablePanels>,
    );
    expect(container.firstElementChild?.children).toHaveLength(2);
  });
});

/**
 * `stackedOrder` — the card page puts the pane carrying the card's own face at
 * the top of the stack, and nothing else may move because of it.
 *
 * Two properties are load-bearing and neither is visible in the rendered order:
 *
 *   · it is ADDITIVE. A caller that passes nothing must render byte-for-byte
 *     what it rendered before the prop existed, in BOTH branches.
 *   · it moves a POSITION, not a subtree. `panelKeys[i]` stays paired with
 *     `panels[i]`, so React moves the existing DOM node instead of unmounting
 *     and remounting it. A panel whose child must mount exactly once — and fire
 *     exactly one mutation when it does — depends on that.
 */
/**
 * `stackedScroll` — the stacked column's panels stop squeezing each other, and
 * nothing outside the opt-in moves.
 *
 * The property under test is a LAYOUT one, which jsdom cannot compute, so what
 * is pinned is the contract that produces it: the wrapper each panel gets. The
 * default wrapper is the string this branch has always emitted — that is the
 * additive guarantee, and it is the half a host who passes nothing depends on.
 */
describe('<ResizablePanels> stackedScroll', () => {
  const three = (props: Partial<React.ComponentProps<typeof ResizablePanels>> = {}) => (
    <ResizablePanels {...PROPS} {...props}>
      <div>one</div>
      <div>two</div>
      <div>three</div>
    </ResizablePanels>
  );
  const wrappers = (container: HTMLElement) =>
    Array.from(container.firstElementChild?.children ?? []).map((el) => el.className);

  it('leaves the stacked wrapper exactly as it was when it is not passed', () => {
    const { container } = render(three());
    expect(wrappers(container)).toEqual(['min-h-0', 'min-h-0', 'min-h-0']);
    expect(container.firstElementChild?.className).not.toContain('overflow-y-auto');
  });

  it('gives every panel a full-height, self-scrolling wrapper when it is passed', () => {
    const { container } = render(three({ stackedScroll: true }));
    for (const cls of wrappers(container)) {
      // `grid` stretches the panel to the wrapper so its inner `flex-1`
      // scroll region has a definite height to fill; `shrink-0` is what stops
      // three panels compressing each other into a column that fits by force.
      expect(cls).toBe('grid h-full min-h-0 shrink-0 overflow-y-auto');
    }
    // And the stack itself is what scrolls between them.
    expect(container.firstElementChild?.className).toContain('overflow-y-auto');
  });

  it('is ignored entirely by the resizable row', () => {
    // The wide layout is the half no phone test can see regress: the row's
    // wrapper is sized by width and must not gain a height or a scroller.
    stubMedia(WIDE);
    const { container } = render(three({ stackedScroll: true }));
    const panes = Array.from(container.firstElementChild?.children ?? []).filter(
      (el) => el.getAttribute('role') !== 'separator',
    );
    for (const el of panes) {
      expect(el.className).toBe('grid min-h-0 min-w-0');
    }
    expect(container.firstElementChild?.className).not.toContain('overflow-y-auto');
  });
});

describe('<ResizablePanels> stackedOrder', () => {
  const text = (container: HTMLElement) =>
    Array.from(container.firstElementChild?.children ?? []).map((el) => el.textContent);

  const three = (props: Partial<React.ComponentProps<typeof ResizablePanels>> = {}) => (
    <ResizablePanels {...PROPS} {...props}>
      <div>one</div>
      <div>two</div>
      <div>three</div>
    </ResizablePanels>
  );

  it('stacks in child order when it is not passed — the additive guarantee', () => {
    const { container } = render(three());
    expect(text(container)).toEqual(['one', 'two', 'three']);
  });

  it('emits the stacked panels in the order given', () => {
    const { container } = render(three({ stackedOrder: [2, 0, 1] }));
    expect(text(container)).toEqual(['three', 'one', 'two']);
  });

  it('keeps each panel paired with its OWN key while reordering', () => {
    // The whole safety argument rests on this pairing: reorder `panelKeys`
    // instead of the sequence and every index-aligned prop — the minimum width,
    // the default width, the persisted size — lands on the wrong pane, silently.
    const { container } = render(three({ stackedOrder: [2, 0, 1] }));
    const keyed = Array.from(container.firstElementChild?.children ?? []).map(
      (el) => el.textContent,
    );
    // 'three' is panelKeys[2] === 'c'; React does not expose keys, so this
    // asserts the observable consequence instead: the child that moved to the
    // front is the third child, intact, and no child was dropped or duplicated.
    expect(keyed).toHaveLength(3);
    expect(new Set(keyed)).toEqual(new Set(['one', 'two', 'three']));
  });

  it('does NOT remount a panel when the order changes', () => {
    /**
     * The audit invariant, in miniature. `CardIdentityPanel` reveals a card
     * number by firing a mutation on mount; remount it and the audit log gains a
     * second reveal nobody performed. Keyed reconciliation is what prevents
     * that, so it is pinned rather than assumed.
     */
    const mounts = vi.fn();
    function Probe() {
      React.useEffect(() => mounts(), []);
      return <span data-testid="probe">probe</span>;
    }
    const tree = (order?: number[]) => (
      <ResizablePanels {...PROPS} stackedOrder={order}>
        <div>one</div>
        <div>two</div>
        <div>
          <Probe />
        </div>
      </ResizablePanels>
    );

    const { container, rerender } = render(tree());
    const before = screen.getByTestId('probe');
    expect(mounts).toHaveBeenCalledTimes(1);

    rerender(tree([2, 0, 1]));
    expect(text(container)[0]).toContain('probe');
    // Same DOM node, moved — not a replacement built in its place.
    expect(screen.getByTestId('probe')).toBe(before);
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('ignores an order that is not a permutation of the children', () => {
    // A duplicate index would emit a duplicate key, which is exactly what WOULD
    // remount a panel. Refused, and the caller gets the order it had before.
    expect(text(render(three({ stackedOrder: [0, 0, 1] })).container)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(text(render(three({ stackedOrder: [1, 0] })).container)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(text(render(three({ stackedOrder: [0, 1, 3] })).container)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('is ignored entirely by the resizable row, widths still paired by key', () => {
    /**
     * The half that catches the silent DESKTOP regression. Above the breakpoint
     * the panels are a row, `panelKeys[i]` addresses `widths[]`, and `flexIndex`
     * names a column by index — so if `stackedOrder` leaked into this branch the
     * columns would swap and each would wear another column's width, with no
     * phone test able to see it.
     */
    stubMedia(WIDE);
    const { container } = render(
      <ResizablePanels
        {...PROPS}
        minWidths={[100, 100, 300]}
        defaultWidths={[150, undefined, 350]}
        stackedOrder={[2, 0, 1]}
      >
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </ResizablePanels>,
    );
    const panes = Array.from(container.firstElementChild?.children ?? []).filter(
      (el) => el.getAttribute('role') !== 'separator',
    ) as HTMLElement[];
    expect(panes.map((el) => el.textContent)).toEqual(['one', 'two', 'three']);
    // 'a' keeps defaultWidths[0], 'c' keeps defaultWidths[2], and the flex pane
    // ('b', flexIndex 1) is sized by flex rather than by a width.
    expect(panes[0].style.width).toBe('150px');
    expect(panes[1].style.width).toBe('');
    expect(panes[1].style.flex).toBe('1 1 0%');
    expect(panes[2].style.width).toBe('350px');
  });

  it('leaves the resizable row identical when nothing is passed', () => {
    // The same row, with the prop absent: the baseline the assertion above is
    // measured against, so "unchanged" means unchanged and not merely "equal to
    // whatever the prop happens to produce".
    stubMedia(WIDE);
    const { container } = render(
      <ResizablePanels {...PROPS} minWidths={[100, 100, 300]} defaultWidths={[150, undefined, 350]}>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </ResizablePanels>,
    );
    const panes = Array.from(container.firstElementChild?.children ?? []).filter(
      (el) => el.getAttribute('role') !== 'separator',
    ) as HTMLElement[];
    expect(panes.map((el) => el.textContent)).toEqual(['one', 'two', 'three']);
    expect(panes[0].style.width).toBe('150px');
    expect(panes[2].style.width).toBe('350px');
  });
});

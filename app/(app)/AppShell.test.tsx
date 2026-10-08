import '@testing-library/jest-dom/vitest';
import type { RbacUser } from '@expenseos/rbac';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/server/trpc'; // VeloExpense: the ExpenseOS-shaped session (server/trpc.ts)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shell around every signed-in page: the nav, and whether it is pinned.
 *
 * Two states, and the difference matters on a small laptop where 240px of fixed nav is
 * a real cost:
 *
 *   · **Pinned** — the persistent sidebar. Unpinning is remembered, because a
 *     preference you have to re-set on every page load is not a preference.
 *   · **Off-canvas** — an overlay with a backdrop, opened from the hamburger. It has to
 *     close on a route change, on Escape, and on the backdrop, and it must not be in
 *     the DOM when shut: an invisible full-screen backdrop swallows every tap on the
 *     page behind it.
 *
 * It starts pinned regardless of the stored preference and applies the preference on
 * mount, so the server render and the first client render agree.
 */

const h = vi.hoisted(() => ({ pathname: '/expenses' }));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (k: string) => k;
    (t as { has?: () => boolean }).has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => h.pathname,
}));
// The nav and the bar are separate surfaces with their own tests; what is under test
// here is the shell's own state.
vi.mock('./Sidebar', () => ({
  AppSidebar: () => <nav>the-nav</nav>,
}));
vi.mock('./TopBar', () => ({
  TopBar: ({
    onMenu,
    collapsed,
    onToggleCollapsed,
  }: {
    onMenu?: () => void;
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
  }) => (
    <header>
      <button type="button" onClick={onMenu}>
        open-nav
      </button>
      <button type="button" onClick={onToggleCollapsed}>
        {collapsed ? 'unpinned' : 'pinned'}
      </button>
    </header>
  ),
}));

import { AppShell } from './AppShell';

const PROPS = {
  user: { id: 'u-1', name: 'Ada' } as unknown as Session['user'],
  rbac: { permissions: [] } as unknown as RbacUser,
  canSeeOthers: false,
  activeModules: new Set<string>(),
};

const show = () =>
  render(
    <AppShell {...PROPS}>
      <p>page content</p>
    </AppShell>,
  );

const openNav = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'open-nav' }));
/**
 * The backdrop button, found by its accessible name.
 *
 * That name is `nav.closeMenu` now rather than a hardcoded "Close navigation", and the
 * `next-intl` mock at the top of this file is the identity function — so what a query sees
 * is the KEY. Asserting on `'closeMenu'` is therefore also the assertion that the label is
 * catalog-backed at all: put the English string back in the component and every query
 * through this helper stops resolving. `packages/i18n/scripts/check-used-keys.mjs` is the
 * other half — it resolves `nav.closeMenu` against the EN catalog, so this pair covers both
 * "the code asks the catalog" and "the catalog answers".
 */
const overlay = () => screen.queryByRole('button', { name: 'closeMenu' });

/** The scrolling box the lock is applied to. Queried from the document, not by role: the
 *  shell renders exactly one `<main>` and its `id` is the skip link's target. */
const main = () => document.querySelector('#main-content') as HTMLElement;

/** The overlay's outermost layer — the `fixed inset-0` cover, not the backdrop button
 *  inside it. Reached through the button so the selector cannot drift onto the sidebar. */
const overlayLayer = () => overlay()?.parentElement as HTMLElement;

/**
 * The locked / unlocked class pairs, asserted POSITIVE AND NEGATIVE together.
 *
 * Tailwind's `overflow-y-hidden` and `overflow-y-auto` set the same property, so a
 * half-done edit that emits both is decided by stylesheet order rather than by anything in
 * this component — and it passes either positive assertion on its own. Only the pair
 * catches it. Same reasoning as
 * `packages/design-system/tests/components/navigation/Sidebar.test.tsx`.
 */
const LOCKED = ['overflow-y-hidden', '[scrollbar-gutter:stable]'] as const;
const UNLOCKED = ['overflow-y-auto'] as const;

const expectLocked = () => {
  for (const c of LOCKED) expect(main()).toHaveClass(c);
  for (const c of UNLOCKED) expect(main()).not.toHaveClass(c);
};
const expectUnlocked = () => {
  for (const c of UNLOCKED) expect(main()).toHaveClass(c);
  for (const c of LOCKED) expect(main()).not.toHaveClass(c);
};

/**
 * A real-enough localStorage.
 *
 * jsdom's own is not a full Storage here (no `clear`), and the shell's whole
 * persistence story is what these tests are about — so the store is explicit.
 */
let store: Record<string, string> = {};
const fakeStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    store = {};
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() {
    return Object.keys(store).length;
  },
};

beforeEach(() => {
  h.pathname = '/expenses';
  store = {};
  vi.stubGlobal('localStorage', fakeStorage);
});
afterEach(() => {
  store = {};
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('keyboard access', () => {
  it('offers skip-to-content as the first focusable thing', () => {
    /**
     * Without it a keyboard user tabs through the entire ~50-item sidebar before reaching
     * the page, on every navigation (GA readiness report F48).
     *
     * Asserted on ORDER, not just presence: a skip link that is not first is not a skip
     * link. And it must point at the `<main>` the shell actually renders, or it skips to
     * nothing.
     */
    render(<AppShell {...PROPS}>page</AppShell>);
    const focusable = document.querySelectorAll('a[href], button, input, [tabindex]');
    expect(focusable[0]).toHaveAttribute('href', '#main-content');
    expect(document.querySelector('#main-content')?.tagName).toBe('MAIN');
  });
});

describe('what it renders', () => {
  it('renders the page inside the nav and the bar', () => {
    show();
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.getByText('the-nav')).toBeInTheDocument();
  });

  it('starts pinned, whatever was stored, so both renders agree', () => {
    /**
     * Reading localStorage during render would make the server and client disagree on
     * the first paint — the hydration mismatch this deliberately avoids.
     */
    localStorage.setItem('eos.sidebarCollapsed', '1');
    show();
    // Applied by the mount effect, not by the first render.
    expect(screen.getByRole('button', { name: 'unpinned' })).toBeInTheDocument();
  });

  it('is pinned when nothing was stored', () => {
    show();
    expect(screen.getByRole('button', { name: 'pinned' })).toBeInTheDocument();
  });

  it('survives a browser that refuses localStorage', () => {
    // Private mode and some embedded webviews throw on read.
    vi.stubGlobal('localStorage', {
      ...fakeStorage,
      getItem: () => {
        throw new Error('denied');
      },
    });
    show();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});

describe('pinning', () => {
  it('remembers that the nav was unpinned', async () => {
    // A preference you must re-set on every page load is not a preference.
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('button', { name: 'pinned' }));
    expect(localStorage.getItem('eos.sidebarCollapsed')).toBe('1');
  });

  it('remembers that it was pinned again', async () => {
    const user = userEvent.setup();
    localStorage.setItem('eos.sidebarCollapsed', '1');
    show();
    await user.click(screen.getByRole('button', { name: 'unpinned' }));
    expect(localStorage.getItem('eos.sidebarCollapsed')).toBe('0');
  });

  it('still toggles when the write is refused', async () => {
    /**
     * The preference is a convenience; failing to persist it must not stop the user
     * from reclaiming the width right now.
     */
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', {
      ...fakeStorage,
      setItem: () => {
        throw new Error('quota');
      },
    });
    show();
    await user.click(screen.getByRole('button', { name: 'pinned' }));
    expect(screen.getByRole('button', { name: 'unpinned' })).toBeInTheDocument();
  });
});

describe('the off-canvas nav', () => {
  it('is not in the DOM until it is opened', () => {
    /**
     * The backdrop is a full-screen button. Rendered-but-hidden, it would swallow every
     * click on the page behind it — which is why it is conditional, not CSS-hidden.
     */
    show();
    expect(overlay()).not.toBeInTheDocument();
  });

  it('opens from the bar', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    expect(overlay()).toBeInTheDocument();
  });

  it('closes when the backdrop is tapped', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.click(overlay() as HTMLElement);
    expect(overlay()).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.keyboard('{Escape}');
    expect(overlay()).not.toBeInTheDocument();
  });

  it('ignores other keys', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.keyboard('{Enter}');
    expect(overlay()).toBeInTheDocument();
  });

  it('closes itself when the route changes', async () => {
    /**
     * Tapping a nav link navigates but does not unmount the overlay, so without this
     * the new page arrives underneath a nav that is still covering it.
     */
    const user = userEvent.setup();
    const view = show();
    await openNav(user);
    h.pathname = '/budgets';
    view.rerender(
      <AppShell {...PROPS}>
        <p>page content</p>
      </AppShell>,
    );
    expect(overlay()).not.toBeInTheDocument();
  });

  it('stops listening for Escape once it is closed', async () => {
    // The listener is added per-open; leaking one per open would pile them up.
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.keyboard('{Escape}');
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('shows the same nav in the overlay as when pinned', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    // One AppSidebar, rendered twice — not two different navs that could drift.
    expect(screen.getAllByText('the-nav')).toHaveLength(2);
  });
});

describe('the scroll lock behind the open nav', () => {
  /**
   * The page behind the open off-canvas nav must not move — and the box that moves is
   * `main`, not `body`. The shell's root is `h-dvh` and the column holding the bar and the
   * content is `overflow-hidden`, so the document has never scrolled here; a lock on `body`
   * would be locking something already still while the content kept sliding under the
   * backdrop.
   *
   * ─── WHAT THESE ASSERTIONS ARE FOR, AND WHAT THEY ARE NOT ──────────────────────────────
   *
   * jsdom computes no layout and honours no `overflow`, so nothing here proves a wheel or a
   * touch is actually refused. That claim is made in a real engine, in
   * `e2e/scroll-lock.mobile.spec.ts`, by wheeling over the backdrop and reading `scrollTop`.
   *
   * What jsdom CAN see, and what actually ships broken, is the lock's LIFECYCLE: applied on
   * open, and gone again after every one of the three close paths and after an unmount while
   * open. A leaked lock is an app that is silently unscrollable until the user reloads, with
   * no visible overlay to explain why — a far worse bug than a nav that scrolls the page,
   * and the one a `useEffect`-with-cleanup implementation produces the first time a cleanup
   * is skipped. Hence a case per exit rather than one on-open assertion.
   */

  it('leaves main scrollable while the nav is shut', () => {
    show();
    expectUnlocked();
  });

  it('locks main when the nav opens', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    expectLocked();
  });

  it('keeps main horizontally clipped in both states', async () => {
    /**
     * Only the Y axis is conditional. `overflow-x-hidden` is what stops the page itself
     * scrolling sideways on a phone — data tables scroll X internally — so a lock that
     * swapped the whole overflow pair for `overflow-y-hidden` alone would trade a scroll
     * bug for a wider one.
     */
    const user = userEvent.setup();
    show();
    expect(main()).toHaveClass('overflow-x-hidden');
    await openNav(user);
    expect(main()).toHaveClass('overflow-x-hidden');
  });

  it('refuses overscroll on the overlay layer', async () => {
    /**
     * `overscroll-none` on the `fixed inset-0` cover, which is a different value from the
     * `overscroll-contain` on the design-system `Sidebar`'s scroll body — see the comments
     * on both elements. This layer scrolls nothing of its own, so the only overscroll it can
     * produce is a chain outwards to the page it is covering, or iOS's own rubber-band, and
     * `none` refuses both. `contain` here would keep a bounce on a box that is meant to be
     * an inert cover.
     */
    const user = userEvent.setup();
    show();
    await openNav(user);
    expect(overlayLayer()).toHaveClass('fixed', 'inset-0', 'overscroll-none');
  });

  it('releases the lock when the backdrop is tapped', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.click(overlay() as HTMLElement);
    expectUnlocked();
  });

  it('releases the lock on Escape', async () => {
    const user = userEvent.setup();
    show();
    await openNav(user);
    await user.keyboard('{Escape}');
    expectUnlocked();
  });

  it('releases the lock when the route changes under an open nav', async () => {
    /**
     * The path that leaks under an effect-based lock: tapping a nav link navigates, and the
     * close is a side effect of the pathname changing rather than of anything the user did
     * to the overlay. Derived in render, the lock and the overlay are decided by the same
     * `navOpen` in the same render and cannot disagree.
     */
    const user = userEvent.setup();
    const view = show();
    await openNav(user);
    expectLocked();
    h.pathname = '/budgets';
    view.rerender(
      <AppShell {...PROPS}>
        <p>page content</p>
      </AppShell>,
    );
    expectUnlocked();
  });

  it('leaves nothing locked behind when it unmounts with the nav open', async () => {
    /**
     * THE CASE THIS BLOCK EXISTS FOR. An implementation that locks by writing to a node
     * OUTSIDE its own tree — `document.body.style.overflow`, the `position: fixed` body
     * hack, a class added to `documentElement` — survives its own unmount, and the app is
     * then unscrollable with no overlay on screen to explain it. Signing out or a hard
     * navigation while the nav is open is enough to reach it.
     *
     * Asserted as an absence across the WHOLE document rather than on `main`, because the
     * point is that no node anywhere is left holding the lock — `main` itself is gone.
     */
    const user = userEvent.setup();
    const view = show();
    await openNav(user);
    expectLocked();
    view.unmount();

    expect(document.querySelector('#main-content')).toBeNull();
    expect(document.querySelector('.overflow-y-hidden')).toBeNull();
    // The body-position hack, and the two inline styles that stand in for it. None of them
    // is how this is implemented; the assertions are here so that a future rewrite into one
    // of them fails a test rather than shipping.
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.position).toBe('');
    expect(document.body.className).toBe('');
  });
});

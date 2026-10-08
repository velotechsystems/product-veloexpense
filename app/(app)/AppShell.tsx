'use client';

import type { RbacUser } from '@expenseos/rbac';
import type { Session } from '@/server/trpc';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { AppSidebar } from './Sidebar';
import { TopBar } from './TopBar';

export interface AppShellProps {
  user: Session['user'];
  rbac: RbacUser;
  canSeeOthers: boolean;
  /** Slugs of installed + active modules; gates module-bound nav sections. */
  activeModules: ReadonlySet<string>;
  /** VeloExpense: the tenant's name, shown under the wordmark. Not in ExpenseOS. */
  organizationName?: string;
  children: React.ReactNode;
}

/** localStorage key for the desktop pin/unpin preference. */
const COLLAPSE_KEY = 'eos.sidebarCollapsed';

/**
 * Client-side app shell. Renders the navy sidebar + main content slot.
 * The server layout in `(app)/layout.tsx` injects the resolved session
 * + RbacUser so the sidebar avoids any client-side round-trip for
 * permission gating.
 *
 * Responsive nav:
 *  - `lg` and up, the sidebar is persistent — but the TopBar exposes a
 *    **pin/unpin toggle** so a user on a smaller laptop can reclaim the fixed
 *    240px on demand (persisted in localStorage). Unpinned, content spans full
 *    width and the hamburger re-shows the nav as an overlay.
 *  - Below `lg`, the sidebar is always off-canvas and opens from the hamburger.
 */
export function AppShell({
  user,
  rbac,
  canSeeOthers,
  activeModules,
  organizationName,
  children,
}: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  // Desktop pin/unpin. Starts pinned (false) for a stable SSR/first paint; the
  // stored preference is applied on mount to avoid a hydration mismatch.
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const t = useTranslations('common');
  // `nav`, the namespace `TopBar.tsx` already binds for the hamburger's `openMenu`. The
  // backdrop's label is that string's mirror, so it belongs in the same namespace.
  const tNav = useTranslations('nav');

  useEffect(() => {
    try {
      if (localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true);
    } catch {
      /* localStorage unavailable — keep the default */
    }
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });

  // Close the off-canvas nav whenever the route changes (tapping a link).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Escape closes the overlay.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const sidebar = (
    <AppSidebar
      user={user}
      rbac={rbac}
      canSeeOthers={canSeeOthers}
      activeModules={activeModules}
      organizationName={organizationName}
    />
  );

  /*
   * The scroll lock for the open off-canvas nav — on `main`, and DERIVED IN RENDER.
   *
   * WHICH ELEMENT. `main#main-content` is the scrolling box in this shell, not `body`: the
   * root is `h-dvh` with `overflow-hidden` on the column below the bar, so the document
   * never scrolls (measured: `documentElement.scrollHeight > clientHeight` is false on
   * `/profile` at 360×800) and locking `body` would be locking something that was already
   * still. If the page behind the nav moves, it is `main` that moved.
   *
   * ─── WHAT THIS IS AND IS NOT, MEASURED ──────────────────────────────────────────────
   *
   * READ THIS BEFORE ASSUMING THE LOCK IS LOAD-BEARING TODAY. It is DEFENCE IN DEPTH, not
   * the fix for an observed scroll-through, and the difference was established by removing
   * it and looking. With `mainScrollClass` forced to an unconditional `'overflow-y-auto'`
   * AND the `overscroll-none` below deleted, on `mobile-360` with `main` parked at
   * `scrollTop` 120 and the nav open, every one of these left it at exactly 120:
   *
   *   · a 400px wheel over the exposed backdrop strip,
   *   · a CDP-synthesized TOUCH scroll of -400px at the same point,
   *   · a 400px wheel over the nav's own list with that list already at its end, and
   *   · PageDown with focus on the hamburger.
   *
   * The reason is structural rather than lucky: the overlay is a `fixed inset-0` SIBLING
   * subtree, so `elementFromPoint` in the backdrop strip returns
   * BUTTON → DIV.fixed → DIV.h-dvh → BODY → HTML — a chain that does not contain `main`.
   * Hit-testing and scroll chaining both follow DOM ancestry, so no gesture delivered to
   * the overlay can reach `main`, and the document it can reach does not scroll.
   *
   * So this class does not currently change any measurable behaviour. It is kept because
   * it is free, because it is the correct expression of the intent, and because the
   * structural guarantee above is an accident of the CURRENT overlay: a backdrop that stops
   * short of an edge, a bottom-sheet nav, a `pointer-events: none` scrim, or moving the
   * overlay inside the content column would each restore the gesture path, silently. The
   * one gesture that DOES move the page behind an open nav is keyboard focus escaping the
   * overlay into `main` — 80 Tabs from the nav scrolled it 0 → 1368 with the nav still open
   * — and `overflow-y-hidden` does not stop focus-reveal scrolling. That is a focus-trap
   * bug, and this is not its fix.
   *
   * WHY DERIVED AND NOT AN EFFECT. An effect that adds a class on open and removes it on
   * cleanup is the shape to avoid: there is no cleanup path to forget and no way for a fast
   * route change to leave `main` locked when the lock is a function of `navOpen` in the same
   * render that decides whether the overlay exists at all. The two cannot disagree. A leaked
   * lock — an app that is permanently unscrollable until reload, with no overlay on screen
   * to explain why — is the regression that actually ships, and it is strictly worse than
   * the one this class prevents. `AppShell.test.tsx`'s unmount-while-open case exists to
   * fail if this ever grows an effect.
   *
   * ONLY THE Y AXIS IS CONDITIONAL. `overflow-x-hidden` stays on the element unconditionally
   * (see the comment on `main` below); swapping the pair would let the page scroll sideways
   * while the nav is shut.
   *
   * `scrollbar-gutter: stable` reserves the scrollbar's track while the scrollbar itself is
   * gone, so locking does not reflow the content a few pixels wider and shift the page under
   * the backdrop. It is inert on the overlay-scrollbar platforms — which is every platform
   * this lock matters most on — so nothing is gated on it; it is here for the desktop
   * unpinned case, where the nav is also an overlay and a classic scrollbar does exist.
   */
  const mainScrollClass = navOpen
    ? 'overflow-y-hidden [scrollbar-gutter:stable]'
    : 'overflow-y-auto';

  return (
    /*
     * `h-dvh`, not the `100vh` form this line carried before.
     *
     * `100vh` is the LARGE viewport — the height the window would have with the browser
     * chrome retracted. On a phone that is taller than what the page actually gets,
     * so the shell's last row sits under the URL bar and the bottom of `main`'s scroll
     * container is unreachable. `h-dvh` is `100dvh`, the *dynamic* viewport: what is on
     * screen right now.
     *
     * The cost, recorded because it is real rather than hypothetical: `100dvh` on iOS
     * Safari CHANGES as the chrome retracts during a scroll, which reflows this
     * fixed-height flex column mid-gesture. The window in which that is visible here is
     * small — the scrolling box is `main`, not the document, and below `lg` the sidebar is
     * an overlay over a scroll-locked page — but it is the first thing to look at if the
     * shell is reported as "jumping" on an iPhone. `100svh` would be stable and would waste
     * the chrome's height permanently; `dvh` is the right trade for a shell whose bottom
     * edge is chrome the user has to be able to reach.
     */
    <div className="flex h-dvh bg-muted">
      {/*
       * Skip to content — the first focusable thing in the document, visible only when
       * focused.
       *
       * Without it a keyboard user tabs through the entire ~50-item sidebar before
       * reaching the page, on every navigation (GA readiness report F48). `sr-only` with
       * a `focus:` escape is the standard shape: invisible to everyone who does not need
       * it, and unmissable to everyone who does.
       */}
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t('skipToContent')}
      </a>
      {/* Persistent sidebar — lg and up, unless the user unpinned it. */}
      <div className={`hidden shrink-0 ${collapsed ? '' : 'lg:block'}`}>{sidebar}</div>

      {/* Off-canvas sidebar — the hamburger target below lg AND on desktop when
          unpinned. Backdrop dismisses; slides in from the left. Rendered only
          when open so it never intercepts taps otherwise. */}
      {navOpen && (
        /*
         * `overscroll-none` on the full-screen overlay layer, and note this is a DIFFERENT
         * value from the `overscroll-contain` on the design-system `Sidebar`'s scroll body,
         * deliberately. This layer is not a scroller and has nothing of its own to scroll,
         * so the only overscroll it can produce is chaining outwards — to the page behind it
         * and, on iOS, to the browser's own rubber-band. `none` refuses both, which is
         * exactly right for a box whose job is to be an inert cover. `contain` would be the
         * wrong word here: it permits the element's own bounce and only blocks the chain,
         * and a backdrop bouncing under the user's thumb is the artefact this removes.
         *
         * Its measured effect in Blink is nil, for the same structural reason as the lock
         * above — see the "WHAT THIS IS AND IS NOT, MEASURED" note there, where removing
         * this class alongside the lock changed no reading. It is kept for the iOS
         * rubber-band, which no engine in this pipeline models, and it is verified on the
         * on-device pass rather than by a spec.
         */
        <div className="fixed inset-0 z-40 overscroll-none">
          <button
            type="button"
            aria-label={tNav('closeMenu')}
            className="absolute inset-0 bg-black/50"
            onClick={() => setNavOpen(false)}
          />
          <div className="relative z-10 h-full w-fit">{sidebar}</div>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar
          onMenu={() => setNavOpen(true)}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          activeModules={activeModules}
        />
        {/* Scroll the content area vertically: plain content pages (e.g.
            /profile) that exceed the viewport must scroll. Data-table pages
            stay put — their Scroll2D is `flex-1 min-h-0` and scrolls
            internally, so `main` never overflows for them. X stays hidden so
            the page itself never scrolls sideways (tables scroll x internally)
            — unconditionally, unlike Y, which `mainScrollClass` above swaps to
            `overflow-y-hidden` while the off-canvas nav is open. */}
        <main
          id="main-content"
          className={`flex flex-1 flex-col ${mainScrollClass} overflow-x-hidden p-4 text-foreground`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

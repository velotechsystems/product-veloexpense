import type * as React from 'react';
import { cn } from '@/lib/utils';

export interface SidebarProps {
  header?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Override the default 240px width (e.g. for a collapsed variant). */
  widthPx?: number;
  ariaLabel?: string;
  className?: string;
}

/**
 * Sidebar — navy chrome around the navigation.
 *
 * Three slots: header (logo / brand), scroll body (nav sections), footer
 * (user profile + logout). The scroll body has a bottom mask-image fade
 * and the bespoke white-faded scrollbar from globals.css
 * (`.einc-sidebar-scroll`).
 *
 * The navy background, dividers, and scroll body fade are not part of
 * shadcn's semantic surface tokens (those describe the light app surface).
 * The sidebar is its own surface system, with tokens (--sidebar-*) in
 * globals.css that components reference via CSS vars + Tailwind classes.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  header,
  children,
  footer,
  widthPx = 240,
  ariaLabel = 'Primary navigation',
  className,
}) => {
  return (
    /*
     * `h-dvh`, not the `100vh` form this line carried before. `100vh` is the LARGE viewport
     * — taller than what a phone actually gets, so the footer slot below sits under the URL
     * bar and the profile / logout control it holds is unreachable. `h-dvh` is the visual
     * viewport, which is the height the sidebar is actually given.
     *
     * This is a workspace-linked package, so this line reaches every consumer with no
     * semver gate to stage it behind. `tests/components/navigation/Sidebar.test.tsx` is the
     * pin that substitutes for that gate: it asserts `h-dvh` is present and the `100vh`
     * class is absent, so a revert here fails a test rather than shipping quietly.
     */
    <aside
      aria-label={ariaLabel}
      className={cn('flex h-dvh flex-none flex-col overflow-hidden', className)}
      style={{
        width: widthPx,
        minWidth: widthPx,
        flexBasis: widthPx,
        background: 'var(--sidebar-bg)',
      }}
    >
      {header && (
        <div
          className="px-[18px] pt-[14px] pb-3"
          style={{ borderBottom: '1px solid var(--sidebar-border)' }}
        >
          {header}
        </div>
      )}
      {/*
       * `overscroll-contain` on the scroll body — `contain`, and not the `overscroll-none`
       * that `AppShell`'s backdrop layer carries. Two elements, two values, on purpose.
       *
       * This box IS a scroller: a ~50-item nav overflows 240×dvh comfortably. What has to
       * stop is the CHAIN — on iOS, flicking the nav list past its last item hands the
       * remaining momentum to the nearest scrollable ancestor, which is the page under the
       * open overlay, so the content the overlay is covering slides while the user is
       * reading the nav. `contain` blocks that hand-off and keeps the element's own bounce,
       * which is the platform's normal end-of-list feedback and worth keeping. `none` would
       * also block the chain but would kill that bounce, making the nav feel dead at its
       * ends; `auto` is the default and is the bug.
       *
       * Note this is the belt to `AppShell`'s braces, not a duplicate of it: the lock on
       * `main` addresses a scroll that STARTS on the page, and this one starts in the nav
       * and continues into the page. Neither covers the other's case.
       *
       * HONESTY, BECAUSE IT WAS MEASURED. In Blink this class changes nothing observable:
       * with it and the shell's lock both removed, a wheel over this list already at its
       * end left `main`'s `scrollTop` at exactly 120 on `mobile-360` — the overlay is a
       * `fixed inset-0` sibling subtree, so the chain out of here never reaches `main`.
       * What it is for is iOS momentum handing a flick past the last nav item to the page,
       * which no engine in this repo's pipeline models. So the assertion in
       * `tests/components/navigation/Sidebar.test.tsx` is a PACKAGING pin — this line
       * reaches every consumer the instant it is edited — and not a behaviour claim; the
       * behaviour is verified on the on-device pass. Do not cite a green suite as proof
       * that the chaining is fixed.
       *
       * This package is workspace-linked, so — as with `h-dvh` above — the line reaches
       * every consumer with no semver gate.
       * `tests/components/navigation/Sidebar.test.tsx` is the pin.
       */}
      <div
        className={cn('einc-sidebar-scroll flex-1 overflow-y-auto overscroll-contain py-2.5')}
        style={{
          maskImage: 'linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)',
        }}
      >
        {children}
      </div>
      {footer && (
        /*
         * The footer is the sidebar's bottom edge, so on a notched phone it is the slot that
         * lands under the home indicator. `py-3` is split into `pt-3` plus an explicit
         * bottom that adds the inset to the same 12px:
         *
         *   pb-[calc(12px_+_var(--safe-area-bottom))]
         *
         * ADDITIVE, not `max(12px, …)`. The 34px home indicator is not padding, it is a
         * region the user's thumb cannot reach and the system paints its own affordance
         * over; a `max()` would let it EAT the 12px gutter this footer's design asks for
         * and leave the profile row flush against the indicator. Additive keeps the design
         * intact and moves it up out of the way. On every non-notched surface
         * `var(--safe-area-bottom)` is `0px`, so this computes to exactly `12px` and the
         * change is a provable no-op — `tests/components/navigation/Sidebar.test.tsx` pins
         * the class, and `e2e/safe-area.mobile.spec.ts` measures both the 12px and the
         * +34px delta on a phone.
         *
         * `data-sidebar-slot="footer"` is a test seam, in the same spirit as the top bar's
         * `data-zone`: without it a geometry test has to say `aside > div:last-child`, which
         * silently measures a different box the day anything is appended here, and reports
         * green while doing it.
         */
        <div
          data-sidebar-slot="footer"
          className="px-4 pt-3 pb-[calc(12px_+_var(--safe-area-bottom))]"
          style={{ borderTop: '1px solid var(--sidebar-border)' }}
        >
          {footer}
        </div>
      )}
    </aside>
  );
};

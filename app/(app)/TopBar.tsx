'use client';

import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMenu2,
} from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { type DependencyList, type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';
import { usePathname } from '@/i18n/navigation';
import { NotificationBell } from './NotificationBell';
import { titleKeyForPath } from './pageTitle';
import { isPortedScreen } from './veloexpenseNav';

// ─── Slot store ────────────────────────────────────────────────────
// Pages mount JSX into the topbar's `center` / `right` zones without
// prop-drilling. We use a module-level external store (NOT React
// context) so writes don't subscribe the writer — that prevents the
// infinite-loop pattern when the page commits new JSX on every render.

/**
 * What a page may mount, and on what terms.
 *
 * The store above is a contract about LIFECYCLE — who writes, when it commits, when it
 * clears. It says nothing about SPACE, and that omission is why the top bar has been
 * reported broken more than once: roughly thirty pages publish unbounded JSX of their
 * own choosing into a bar that also has to hold the shell's own controls, and for a
 * while nothing arbitrated between them.
 *
 * The rule now, enforced by the shell rather than requested of publishers:
 * **shell chrome outranks page chrome for space.** Read that narrowly, because the shell
 * only enforces it where it can:
 *
 *  · **In the `right` zone it is real.** That is the one zone holding both kinds of chrome,
 *    and it holds them in two boxes: the shell's controls in a `shrink-0` one
 *    (`data-chrome="shell"`) and `{right}` in a `min-w-0` one (`data-chrome="page"`). So
 *    page content is the designated shrink victim and the shell's controls keep their width.
 *  · **In the `left` zone there is no arbitration at all, and you should not expect any.**
 *    `{left}` is a BARE child of `[data-zone="left"]` — there is no per-slot box around it,
 *    so there is nothing for the shell to nominate as the victim, and the zone's own
 *    `min-w-0` only lets the TRACK narrow, not the row you mounted inside it. Whatever you
 *    publish there is on its own.
 *  · **Nothing CLIPS, in either zone.** No zone and no box the shell puts inside one carries
 *    `overflow-*`, deliberately — see bullet 1 below. An earlier version of this paragraph
 *    said the page box clips; it does not, and a publisher who believed it would skip the
 *    one thing the shell cannot do for them.
 *
 * Publishing here therefore does NOT require you to add `shrink-0` to what you
 * mount — and specifically does not justify pushing `shrink-0` or `whitespace-nowrap` into
 * a shared primitive's base, which is harmful at the primitive's other call sites.
 *
 * Two things follow for a publisher, and they are the only two:
 *
 *  1. **Nothing you mount here is clipped by the shell.** No zone, and no box the shell puts
 *     inside one, carries `overflow-*` — page slots mount hover panels and dropdowns that
 *     have to escape these boxes, and the shell's own popovers mount from the box beside
 *     yours. So an unportalled overlay is safe here.
 *  2. **Which is exactly why your row has to be able to yield on its own.** In the `right`
 *     zone the shell decides which box gives way (yours) and which direction its overflow
 *     goes (leftward, away from the shell's controls), but it cannot make a row of
 *     `shrink-0` boxes narrower than their content. In the `left` zone it does not even
 *     decide that much. Either way a row with no `min-w-0` / `truncate` yielder inside it is
 *     painted OUTSIDE its zone on a header too narrow to hold it, over whatever sits to its
 *     left. Put a yielder in it, and put what matters at the trailing end.
 *
 *     Live in the `left` zone today, and the reason this paragraph is worded as a warning
 *     rather than a note: `ExpenseReportWorkbench.tsx:993`'s crumb `<button>` is `shrink-0`
 *     with no `truncate`, so at 1024px with the sidebar pinned that row cannot reach the
 *     40px floor its track sits on and the breadcrumb is painted 137.9px (EN) / 184.3px
 *     (fr-CA) outside the zone — measured, and filed as its own defect.
 *
 * See `docs/adr/0002-topbar-shell-chrome-outranks-page-chrome.md`.
 */
interface Slots {
  /** Replaces the route-derived title on the left (e.g. a page breadcrumb). */
  left: ReactNode;
  /**
   * Between the two neighbours, and NOT centred — on the page or between them. The header's
   * flexible track is the left one, so this slot is sized to its own content and lands
   * immediately left of the `right` zone at every breakpoint. Exactly one route publishes
   * it today.
   */
  center: ReactNode;
  /**
   * Trailing page actions. Mounted BEFORE the shell's own controls and yields to them, so
   * what a too-narrow header pushes out of place is this slot's LEADING end. Omit it (or
   * publish `null`) and the box is not rendered at all.
   *
   * ── BELOW `lg` THIS SLOT IS RATIONED, AND THE RATION IS ONE ICON ────────────────────
   *
   * **At most one icon-only control — 32x32 visual, 44x44 hit area (`einc-tap-slop-both`)
   * — or nothing at all.** Anything carrying a TEXT LABEL is over budget below `lg`.
   *
   * It will not be truncated and it will not be clipped — nothing in this file clips, on
   * purpose, and the zone comment at the bottom of this file says why it may not start.
   * What happens instead is the failure mode described two paragraphs up: the row is laid
   * out at its full width and PAINTED OVER THE ROUTE TITLE.
   *
   * This is a measurement rather than a matter of taste. At 360px the header has a 328px
   * content box, and it is almost all spent before your slot is reached:
   *
   *       328   header content box                 (360 − 2 × 16, `px-4`)
   *     −  16   the grid's two `gap-2` seams
   *     −  36   the off-canvas hamburger's run in the left track — a 32px box at `-ml-1`,
   *             then `gap-2` before the title. It is why the left track's 2.5rem floor
   *             does NOT buy the title 40px: 36 of the 40 are the hamburger.
   *     −   6   this zone's own `gap-1.5`, between your box and the shell's
   *     −  32   the shell cluster: the notification bell
   *       ────
   *       238   left for the ROUTE TITLE AND YOUR SLOT TOGETHER
   *
   * — and 238 is the generous reading. On a tenant where the `assistant` module is active
   * the shell cluster is 70 rather than 32 (two 32px controls plus the 6px between them),
   * and the shared pool is **200px**.
   *
   * Measured on `/users` at 360, a route that publishes exactly one labelled button:
   *
   *   · EN — title "People" 51.8px, `Add user` 75.7px. 127.5 of 238. Comfortable.
   *   · fr-CA — title "Personnes" 80.0px, `Ajouter un utilisateur` 144.8px. 224.8 of 238.
   *     **13.2px of slack**, and 24.8px OVER on a tenant with the assistant launcher.
   *
   * One button, on a route with a short title, in a locale this product ships from day
   * one. That is the entire budget, spent. An icon-only control spends 32 of it and leaves
   * French its title, which is why the ration is shaped the way it is rather than
   * expressed as a pixel allowance nobody would measure against.
   *
   * ── IT BINDS ON EVERY ROUTE — INCLUDING ONE WHOSE BODY IS THE DESKTOP-ONLY NOTICE ───
   *
   * A route ruled `desktop` in `mobileReadiness.ts` shows `DesktopOnlyNotice` below `lg`
   * instead of its page. That does NOT exempt it, and the reason is mechanical rather
   * than a matter of discipline.
   *
   * `DesktopOnlyNotice` renders BOTH branches always and lets CSS pick — the page subtree
   * is wrapped in `hidden lg:contents`. `display: none` removes boxes; it does not
   * unmount. The page component still mounts, its effects still run, and
   * `useTopBarSlots` still fires. And what it writes to is the module-level store at the
   * top of this file, which lives OUTSIDE `main` — so the header goes on painting a slot
   * belonging to a page the reader has just been told they cannot use at this width, at
   * the width where the budget above is tightest.
   *
   * So: budget your `right` slot for 360px even when your body is desktop-only. Or
   * publish nothing below `lg`, which is the same rule read the other way.
   *
   * See `docs/adr/0002-topbar-shell-chrome-outranks-page-chrome.md`.
   */
  right: ReactNode;
}

let slots: Slots = { left: null, center: null, right: null };
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getSnapshot = () => slots;

/** Imperative setter — `null` clears. */
export function setTopBarSlot(area: keyof Slots, node: ReactNode) {
  slots = { ...slots, [area]: node };
  for (const l of listeners) l();
}

/**
 * Page-side helper. The `builder` callback returns the JSX for the
 * slots, and the hook commits its result whenever `deps` change. Pass
 * stable deps (primitives or memoised values).
 */
export function useTopBarSlots(builder: () => Partial<Slots>, deps: DependencyList) {
  useEffect(() => {
    const next = builder();
    if ('left' in next) setTopBarSlot('left', next.left ?? null);
    if ('center' in next) setTopBarSlot('center', next.center ?? null);
    if ('right' in next) setTopBarSlot('right', next.right ?? null);
    return () => {
      setTopBarSlot('left', null);
      setTopBarSlot('center', null);
      setTopBarSlot('right', null);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps is forwarded from the caller of this custom hook helper
    // VeloExpense: the same suppression in ESLint's spelling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function TopBar({
  onMenu,
  collapsed,
  onToggleCollapsed,
  activeModules,
}: {
  /** Below `lg`: open the off-canvas nav overlay. */
  onMenu?: () => void;
  /** Desktop sidebar pin state. */
  collapsed?: boolean;
  /** Desktop pin/unpin toggle. */
  onToggleCollapsed?: () => void;
  /**
   * Slugs of installed + active modules, resolved server-side in `(app)/layout.tsx`
   * and threaded through `AppShell` — the same set that gates the sidebar's
   * module-bound sections. Omitted in tests that do not care, which reads as "no
   * module is on" and is the safe direction for a gate.
   */
  activeModules?: ReadonlySet<string>;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav.items');
  const tNav = useTranslations('nav');
  const { left, center, right } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const titleKey = titleKeyForPath(pathname);
  const title = titleKey ? t(titleKey as Parameters<typeof t>[0]) : '';

  return (
    /*
     * `minmax(2.5rem,1fr) | auto | minmax(0,auto)` at EVERY breakpoint — there is
     * deliberately no `lg:` variant, and each of the three functions is load-bearing.
     *
     * The first round of this fix removed `lg:grid-cols-3`, and that much still holds:
     * `grid-cols-3` expands to `repeat(3, minmax(0, 1fr))`, whose damaging half was not the
     * `1fr` maximum but the `0` MINIMUM — it forbids a track from growing to its own
     * min-content, so the right zone was clamped to a third of the header while its content
     * needed twice that, and the overflow painted over the shell's own controls.
     *
     * Plain `auto` on the right, which is what that round left behind, has the OPPOSITE
     * failure. An `auto` track's minimum is its item's min-content, and this zone's
     * min-content EQUALS its max-content: every box a page mounts in `right` is `shrink-0`
     * (`NetSuitePush.tsx:160` is one) and so is the shell's own, so nothing in the row can
     * compress and the track measures 708px in EN / 853px in fr-CA however narrow the
     * header is. At 1024px with the sidebar PINNED the header has 720px of content box, so
     * the zone ran past its right edge — 4px in EN, 149px in fr-CA — and `AppShell`'s
     * `overflow-hidden` cut the notification bell and the assistant launcher off the screen.
     * Measured, both rounds, in `e2e/topbar-overlap.spec.ts`.
     *
     * So `minmax(0, auto)`: the right track may still grow to its full max-content, and may
     * no longer be wider than the header. The zone therefore always ends on the header's own
     * content edge, and the shell's controls sit at the zone's trailing end — measured at
     * 1024 pinned in both locales, the bell lands at [960, 992] against a content box that
     * ends at 992, hit-tests as itself and takes a click.
     *
     * What a bounded track does NOT do is make the content fit. Nothing in this zone can
     * compress (see the zone below), so in the band where the bar is narrower than everything
     * mounted in it the page's own chrome is laid out at full width inside a box that is not
     * wide enough and painted outside it — leftward, into the header's own middle, which is
     * the least-bad direction available and the reason for `justify-end` down there. That
     * residue is real and it is reported rather than hidden; the zone comment has the numbers
     * and the reason nothing may clip it away.
     *
     * `minmax(2.5rem, 1fr)` on the LEFT and `auto` (not `1fr`) in the middle are the
     * priority order, not decoration. Grid maximises the non-flexible tracks before it
     * feeds the flexible one, so putting the `1fr` on the left is what keeps the right
     * zone's claim on space ahead of the title's: measured, the right zone still gets its
     * whole content width everywhere it fits — 1100px and up in EN, 1280px and up in fr-CA
     * with the sidebar pinned, identical to plain `auto` — and the title takes what is left.
     * `2.5rem` is the floor nothing may go below: the sidebar toggle's `w-8`
     * plus this row's `gap-2`. That button is shell chrome, and a track that collapses under
     * it leaves it painted outside its own zone (24px of it, measured, on a plain `1fr`) —
     * this file's own defect wearing a different hat. The floor costs the right zone 40px in
     * the narrow band and moves not one painted pixel anywhere else: with and without it, at
     * 1024 pinned, the page's chrome is painted in exactly the same place. What changes is
     * which box is allowed to call it its own.
     *
     * What this spends: the `center` slot is no longer in the flexible track, so it is
     * content-sized and sits immediately left of the right zone rather than centred in the
     * slack. **The operator signed that off on 2026-09-02** — content-sized and flush
     * against the right zone at every breakpoint is the accepted position, not an
     * outstanding disclosure. The reason it is worth the trade is what claim 5 in
     * `e2e/topbar-overlap.spec.ts` costs: leave the `1fr` in the middle and the two
     * content-sized tracks split the free space evenly, starving the right zone by 118px at
     * 1280px in EN where it fits today. Exactly one
     * route publishes `center` (`expenses/[reportId]/ExpenseReportWorkbench.tsx`) and it is
     * the page all of this was reported on.
     */
    /*
     * ─── `pt-[calc(14px_+_var(--safe-area-top))]` ──────────────────────────────────────
     *
     * The top bar is the shell's top edge, so it is the box that lands under the status bar
     * and the notch. The 14px is unchanged; the inset is ADDED to it rather than folded in
     * with `max(14px, …)`, because the notch is not padding — it is screen a control cannot
     * occupy — so a `max()` would let a 47px inset consume the 14px gutter and leave the
     * hamburger tangent to the status bar. On every non-notched surface
     * `var(--safe-area-top)` is `0px` and this computes to exactly `14px`, which is what
     * makes the change a provable no-op off-phone.
     *
     * `px-4 lg:px-8` IS LEFT LITERALLY UNCHANGED, and horizontal insets are NOT applied
     * here. `e2e/topbar-overlap.spec.ts` uses `headerPaddingLeft === 32` as its proof that
     * the `lg:` branch is live, and its per-locale width constants are MEASUREMENTS, not
     * tolerances — a horizontal term here (`--safe-area-left`, a `max()`, anything) moves
     * that number and turns a top-bar-overlap gate red for a reason three files away. In
     * portrait, the orientation this phase covers, both side insets are `0px` anyway;
     * landscape side insets are a separate change with that spec's constants re-measured in
     * the same commit.
     *
     * VERIFIED BY: `e2e/safe-area.mobile.spec.ts`, as a DELTA — forced `top: 47`, cleared,
     * and the computed `padding-top` asserted to have moved by exactly 47. An absolute
     * `toBe(47)` would also pass on a hardcoded `padding-top: 47px` that consumes nothing.
     */
    <header className="grid shrink-0 grid-cols-[minmax(2.5rem,1fr)_auto_minmax(0,auto)] items-center gap-2 border-border border-b bg-background px-4 pt-[calc(14px_+_var(--safe-area-top))] pb-3 lg:px-8">
      {/*
       * `data-zone` on all three grid children — a testability seam, not decoration.
       *
       * The top bar's job is to keep three zones side by side, and the only honest way to
       * assert that is to measure them. Without a stable handle a geometry test has to
       * select them as `header > div:nth-child(n)`, which silently measures the wrong box
       * the first time anybody adds a fourth child — and reports green while doing it.
       *
       * `data-chrome="page"` / `data-chrome="shell"` are the same thing one level down, on the
       * right zone's two boxes. Which of them yields is the whole subject of this file, so a
       * test has to be able to say which one it measured — and the page box is conditional
       * now, so its position among the zone's children is not even stable. See
       * `e2e/topbar-overlap.spec.ts`.
       */}
      <div data-zone="left" className="flex h-8 min-w-0 items-center gap-2">
        {/* Desktop (lg+): pin/unpin the persistent sidebar to reclaim width. */}
        {onToggleCollapsed && (
          <button
            type="button"
            aria-label={collapsed ? tNav('expandSidebar') : tNav('collapseSidebar')}
            onClick={onToggleCollapsed}
            className="-ml-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            {collapsed ? (
              <IconLayoutSidebarLeftExpand size={20} />
            ) : (
              <IconLayoutSidebarLeftCollapse size={20} />
            )}
          </button>
        )}
        {/* Below lg: open the off-canvas nav.
            `einc-tap-slop-both` (coarse pointers only) floors this 32x32 control's
            hit target at 44x44 without resizing it. Both axes here, unlike the
            icon Button sizes: this is the leftmost control in the bar with the
            title's own box the only thing to its right, so the horizontal reach
            has nothing to steal a tap from. The class is on this control and NOT
            on the `lg:inline-flex` collapse toggle above, which is desktop-only. */}
        {onMenu && (
          <button
            type="button"
            aria-label={tNav('openMenu')}
            onClick={onMenu}
            className="einc-tap-slop-both -ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
          >
            <IconMenu2 size={20} />
          </button>
        )}
        {left ??
          /* VeloExpense: only a PORTED screen is titled here; VeloExpense's own pages carry
             their own <h1>, and a second one would name the page twice (veloexpenseNav.ts). */
          (isPortedScreen(pathname) ? (
            <h1 className="truncate font-semibold text-base text-foreground">{title}</h1>
          ) : null)}
      </div>
      <div data-zone="center" className="flex h-8 items-center justify-center">
        {center}
      </div>
      <div data-zone="right" className="flex h-8 items-center justify-end gap-1.5">
        {/*
         * The zone holds at most two boxes, and which of them yields is decided HERE.
         *
         * BELOW `lg` the arbitration below is still the only mechanism, and it is not
         * enough — 328px of header cannot hold a labelled page control, a route title and
         * the shell's cluster at once. What closes that gap is a rule on the PUBLISHER,
         * not a template: at most one icon-only 32x32 control with a 44x44 hit area, or
         * nothing. It is stated with its arithmetic and its measured fr-CA margin on
         * `Slots.right` above, and recorded in ADR-0002 under "Below `lg`". The template
         * on this header is deliberately unchanged at every breakpoint — there is no
         * `max-lg:` variant of it, no second row, and no `overflow-*` — because none of
         * those makes 328px hold 400, and each of them costs something the desktop layout
         * or the overlays below currently rely on.
         *
         * DOM order is page content first, shell controls after, so on a line that does not
         * fit, the shell's bell and launcher paint on top of the page's badges and buttons —
         * later sibling, same stacking context. That was the reported symptom.
         *
         * So the shell's box is pinned (`shrink-0`) and the page's box is the designated
         * yielder (`min-w-0`) — and `justify-end` on it is the part that matters once there
         * is nothing left to yield. Every box a page mounts here is `shrink-0`
         * (`NetSuitePush.tsx:160` is one) and so is the shell's own, so the zone's min-content
         * equals its max-content: 708px in EN, 853px in fr-CA, measured. When the bounded
         * track hands this box less than that, the content does not compress — it is laid out
         * at full width and painted outside the box. `justify-end` packs it against the
         * shell's controls so it goes LEFTWARD, away from the bell and the launcher. Without
         * it the overflow goes right, straight over them: +350px of sibling overlap at 1024
         * pinned, which is the originally reported defect reached by a longer route.
         *
         * Nothing here clips, and that is a constraint rather than a preference. Page slots
         * mount unportalled overlays that must escape this box —
         * `ExpenseReportWorkbench.tsx:707` is an `absolute top-full right-0 w-72` hover panel
         * anchored to the zone's LEADING box, so it reaches ~200px left of this box at every
         * width — and the bell's popover and the assistant's drawer mount from the `shrink-0`
         * box beside it. Any `overflow-*` here or on the zone cuts one of them, whichever
         * value it is given.
         *
         * The residue, stated plainly because a reader will otherwise assume it was missed:
         * in that band the page's leading chrome is painted over the left zone's title —
         * 142px of it at 1024 pinned in EN, 188px in fr-CA — and in fr-CA a further 101px
         * lands left of the app shell's content column, where the shell's own
         * `overflow-hidden` hides it. `e2e/topbar-overlap.spec.ts` reports that as a claim-2
         * red at 1024 pinned, and it is NOT fixable from this file: 853px of unshrinkable
         * page chrome plus the toggle cannot be made to fit a 720px header by any track
         * function. What fixes it is a `min-w-0` / `truncate` yielder inside `{right}`'s own
         * row, which is the publisher's to add.
         *
         * Rendered only when a page published something. An unconditional box gave every
         * route that published nothing a zero-width flex item plus this row's `gap-1.5` —
         * 6px of dead space to the left of the bell.
         *
         * `right != null` catches TWO of the three spellings of "nothing", and the third is
         * not fixable from here. Stated in full because the gap is easy to mistake for a
         * bug in the condition:
         *
         *  1. **Absent.** Around thirty routes publish no `right` slot at all. The store
         *     holds `null` — `useTopBarSlots` normalises `undefined` to it — and the box is
         *     not rendered. Caught.
         *  2. **An explicit `null`.** `admin/notification-templates/NotificationTemplatesAdmin.tsx:387`
         *     publishes `{ right: null }`, which is how a page says "nothing here" rather
         *     than "I did not mention this zone". Caught.
         *  3. **An element that RENDERS nothing.** A component that returns `null`, or a
         *     `right: cond && <X/>` whose condition is false — `false != null`, and an
         *     element is non-null however little it draws. NOT caught: whether an element
         *     renders anything is decided by React while rendering it, and the shell cannot
         *     ask from out here without rendering it itself. So the box is rendered, the
         *     `gap-1.5` applies, and those routes still pay the 6px.
         *
         * The third is live rather than hypothetical, and it lands on precisely the viewers
         * least able to explain it: `netsuite/NetSuiteSyncControl.tsx:129` returns `null`
         * when the viewer lacks `netsuite.sync`, and its two publishers —
         * `netsuite/NetSuiteReferenceList.tsx:545` and
         * `netsuite/sync/NetSuiteSyncDashboard.tsx:62` — publish it unconditionally. So a
         * read-only viewer on either NetSuite route gets the empty box and the 6px, while a
         * viewer with the permission gets a control that fills it.
         *
         * `right != null` stays anyway: the alternative is a shell that renders page JSX
         * twice or probes it, and 6px on two routes for one class of viewer does not buy
         * that. The cost is pinned as characterization in `TopBar.test.tsx` so it reads as a
         * known limitation rather than as something nobody noticed.
         */}
        {right != null && (
          <div data-chrome="page" className="flex min-w-0 items-center justify-end">
            {right}
          </div>
        )}
        <div data-chrome="shell" className="flex shrink-0 items-center gap-1.5">
          <NotificationBell />
          {/* The literal, not the exported constant: this is a client component and
              `@expenseos/assistant` carries the Anthropic SDK, which has no business in
              the browser bundle just to name a slug. Same call the sidebar makes. */}
          {activeModules?.has('assistant') && <AssistantLauncher />}
        </div>
      </div>
    </header>
  );
}

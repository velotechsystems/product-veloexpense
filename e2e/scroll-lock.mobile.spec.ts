import { expect, type Page, test } from '@playwright/test';
import { assertPhoneProject } from './support/safe-area';

/**
 * VeloExpense: ExpenseOS's `e2e/scroll-lock.mobile.spec.ts` (1e682dd6), ported with its phone
 * specs. `AppShell`'s lock is ExpenseOS's. One change, marked at `ROUTE`: the subject is
 * `/notifications/preferences`, the tall half of what ExpenseOS keeps on `/profile`, with no
 * locale segment. The falsification numbers below are ExpenseOS's, measured on its `/profile`;
 * VeloExpense's own are in the run's `scroll-lock` annotation.
 *
 * The scroll lock behind the open off-canvas nav — applied to the element that actually
 * scrolls, and released again by every close path.
 *
 * ─── READ THIS FIRST: THE MEASUREMENT THAT RESHAPED THIS FILE ────────────────────────────
 *
 * This spec was commissioned to assert that a wheel over the open nav's backdrop leaves the
 * page behind it still. IT DOES ASSERT THAT, below — and that assertion is PASSED BY A BUILD
 * WITH NO SCROLL LOCK AT ALL. That was not reasoned about, it was run: with `AppShell`'s
 * `mainScrollClass` forced to an unconditional `'overflow-y-auto'` and the `overscroll-none`
 * on the overlay layer deleted, on `mobile-360`, with `main` parked at `scrollTop` 120 and
 * the nav open, every one of the following left it at exactly 120 —
 *
 *   · a 400px wheel over the exposed backdrop strip,
 *   · a CDP-synthesized TOUCH scroll of -400px at the same point,
 *   · a 400px wheel over the nav's own list with that list already scrolled to its end, and
 *   · PageDown with focus on the hamburger.
 *
 * The cause is structural, not incidental. The overlay is a `fixed inset-0` SIBLING subtree
 * of the content column, so `document.elementFromPoint` in the backdrop strip returns
 *
 *     BUTTON.absolute·inset-0 → DIV.fixed·inset-0 → DIV.flex·h-dvh → BODY → HTML
 *
 * and `main#main-content` is nowhere in it. Hit-testing and scroll chaining both walk DOM
 * ancestry, so a gesture delivered to the overlay cannot reach `main`; and the one ancestor
 * it can reach, the document, does not scroll here (`h-dvh` root — measured
 * `documentElement.scrollHeight > clientHeight === false`).
 *
 * So the gesture assertion is retained, but RELABELLED for what it can actually carry: it is
 * a claim about THE OVERLAY — that the backdrop covers the strip and swallows what lands on
 * it — and not about the lock. The lock's own claim is the COMPUTED-STYLE pair below, which
 * is the assertion that was watched to fail. Anyone tempted to delete that pair as "just
 * asserting the class" should read the falsification section: it is the only thing in this
 * file that a broken lock turns red.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * In a real engine, at a phone viewport, on a route that genuinely overflows:
 *
 *   · `main#main-content`'s COMPUTED `overflow-y` is `auto` with the nav shut, `hidden`
 *     while it is open, and `auto` again after Escape closes it — computed, so a class that
 *     is emitted but loses the cascade does not pass,
 *   · `main` is a LIVE SCROLLER on this route: it overflows, and a wheel at the test's own
 *     pointer coordinates moves it by the full delta once the nav is shut,
 *   · no wheel over the backdrop strip moves it while the nav is open, and
 *   · `document.body` is not `position: fixed` at any point.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH ─────────────────────────────────────────────────
 *
 * THE LOCK IS DEFENCE IN DEPTH, AND THIS FILE DOES NOT SHOW IT PREVENTING ANYTHING. Per the
 * measurement above, nothing observable changes when it is removed. It is worth keeping —
 * the structural guarantee that protects the page is a property of the CURRENT overlay, and
 * a backdrop that stops short of an edge, a bottom-sheet nav, a `pointer-events: none` scrim
 * or an overlay moved inside the content column would each restore the gesture path silently
 * — but "the suite is green" is not evidence that the lock is doing work. It is evidence
 * that it is correctly applied and correctly released.
 *
 * IT DOES NOT EXERCISE TOUCH. The gesture here is a wheel, because that is what Playwright
 * delivers deterministically. `overflow-y-hidden` refuses wheel and touch alike, so for the
 * CURRENT implementation the distinction does not matter. IF THE LOCK IS EVER REIMPLEMENTED
 * AS A `touchmove` HANDLER CALLING `preventDefault()`, THIS FILE DOES NOT EXERCISE IT: a
 * wheel is not a `touchmove`, no such handler would fire, and the computed-style pair above
 * would be asserting a class that no longer implements the behaviour. Whoever makes that
 * change owes this file a touch-based counterpart, or owes it a rewrite.
 *
 * Nor does it say anything about iOS scroll chaining out of the nav's own list, which is
 * `overscroll-contain` on the design-system `Sidebar`'s scroll body. Measured nil in Blink
 * (third bullet above); real on iOS momentum, which no engine in this pipeline models. That
 * class is pinned as a PACKAGING gate in
 * `packages/design-system/tests/components/navigation/Sidebar.test.tsx` and verified on the
 * on-device pass.
 *
 * And it does not cover the one gesture that genuinely moves the page behind an open nav:
 * KEYBOARD FOCUS ESCAPING THE OVERLAY. Measured on `mobile-360` — 80 Tabs from the nav
 * scrolled `main` from 0 to 1368 while the nav was still open, focus landing inside
 * `#main-content`. `overflow-y-hidden` does not stop focus-reveal scrolling, so the lock is
 * not that bug's fix; it wants a focus trap, which is not this change.
 *
 * ─── FALSIFICATION: OBSERVED, NOT ASSUMED ────────────────────────────────────────────────
 *
 * Green (`mobile-360`): floor 2065 / 741; `overflow-y` auto → hidden → auto; scrollTop
 *   120 → 120 locked → 520 after close, a delta of +400.
 * Green (`mobile-390`): floor 1909 / 605; same three `overflow-y` readings; scrollTop
 *   120 → 120 → 520, delta +400.
 *
 * RED — `mainScrollClass` forced to `'overflow-y-auto'`, on `mobile-360`:
 *   > main#main-content did not lock while the nav was open: computed overflow-y is "auto".
 *   Expected "hidden", received "auto".
 * The floor stayed green in that run; the two wheel steps never reached, because the test
 * aborts on the first failure. That they are INSENSITIVE to this same break is the separate
 * measurement at the top of this header, taken against the earlier draft of this spec whose
 * only assertions were the gesture ones — it passed, 120 → 120 and +400, with the lock gone.
 * Together those two runs are the demonstration that only the computed-style pair catches
 * the regression. It went green again on restore.
 */

/** Matches `crawl-mobile.spec.ts` and `safe-area.mobile.spec.ts` — layout is not
 *  locale-specific, and the nav's EN labels are the ones queried below. */
const LOCALE = 'en';

/**
 * `/profile`, and the choice is load-bearing rather than incidental.
 *
 * It is the tallest route in the shell that is NOT a data table. Table pages are the wrong
 * subject: their `Scroll2D` is `flex-1 min-h-0` and scrolls internally, so `main` never
 * overflows for them and the floor below would fail on every one. `/profile` stacks
 * independent cards — employment, locale, notifications, security, API key — with no
 * internal scroller, which is exactly the "plain content page that exceeds the viewport"
 * case `main`'s `overflow-y-auto` exists for. Every signed-in user can reach it, so it needs
 * no particular role from the stored session.
 */
// VeloExpense: `/notifications/preferences`, with no locale segment. VeloExpense split
// ExpenseOS's `/profile` in two, and its `/preferences` half is one short card that fits a
// 360×800 screen with nothing to scroll (measured: scrollHeight 741 = clientHeight 741). The
// notifications half is the tall one — ExpenseOS's `/profile` "notifications" card on a page
// of its own, plain cards, no internal scroller, reachable by every signed-in user (measured:
// 7438 / 741 at 360).
void LOCALE;
const ROUTE = '/notifications/preferences';

/** The shell's scrolling box, and the element under test. Its `id` is the skip link's
 *  target, so it is a seam the shell already maintains rather than one added for a test. */
const MAIN = '#main-content';

/**
 * The nav, addressed as the VISIBLE one.
 *
 * `:visible` is load-bearing, for the reason written up at length in
 * `e2e/safe-area.mobile.spec.ts`: `AppShell` renders the sidebar TWICE — a `hidden … lg:block`
 * desktop copy present in the DOM at every width, and the overlay copy mounted only while
 * open. Below `lg` the first is `display: none`, and `.first()` would silently pick it. Here
 * the consequence is worse than a wrong measurement: the hidden copy has no layout box, so
 * `boundingBox()` returns null and the pointer coordinates below would be computed from
 * nothing.
 */
const OPEN_NAV = 'aside[aria-label]:visible';

/** How far to wheel, in CSS pixels. More than one line, and comfortably inside `/profile`'s
 *  scrollable range at both phone viewports — so the unlocked control lands mid-range rather
 *  than clamped at the end, and a clamped read cannot be mistaken for a refused one. */
const WHEEL_DELTA = 400;

/**
 * Where `main` is parked before anything is measured. Deliberately not 0: at `scrollTop === 0`
 * an unchanged reading and a "could not scroll up" reading are the same number. Mid-range,
 * the value under assertion is free to move in either direction.
 */
const START_SCROLL_TOP = 120;

/** One read of the scroller's geometry, taken as a set so the numbers describe a single
 *  layout state rather than three. */
async function geometryOf(page: Page) {
  const box = page.locator(MAIN);
  await expect(box, `${MAIN} did not resolve to exactly one element`).toHaveCount(1);
  return box.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

async function scrollTopOf(page: Page): Promise<number> {
  return (await geometryOf(page)).scrollTop;
}

/**
 * `main`'s COMPUTED `overflow-y`, which is the lock's actual claim.
 *
 * Computed rather than the class string, and the difference is the point: `cn()` and
 * Tailwind's cascade sit between the class and the property, so a build that emits
 * `overflow-y-hidden` alongside a surviving `overflow-y-auto` has the outcome decided by
 * stylesheet order. Only one of the two can win the cascade, and only the computed value
 * says which. (The class pair is asserted too, in `AppShell.test.tsx`, where the claim is
 * about what the component emits rather than about what the engine resolves.)
 */
async function overflowYOf(page: Page): Promise<string> {
  return page.locator(MAIN).evaluate((el) => getComputedStyle(el).overflowY);
}

/**
 * Let a wheel's effect land, then stop.
 *
 * Wheel-driven scrolling is applied off the task that dispatched the event, so the first read
 * after `mouse.wheel` can legitimately still be the previous value — which for the unchanged
 * assertion would be a false green. A poll is no use for asserting a value did NOT change
 * (it succeeds on its first read, before anything could have happened), so this waits a
 * fixed, generous interval: three frames plus 300ms.
 *
 * What makes that interval defensible rather than arbitrary is the close-then-wheel control.
 * It uses this same helper and asserts a MOVE, so every green run demonstrates that a wheel's
 * effect is observable within this window on this machine. If the window were too short, that
 * control would be the assertion that failed.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))),
        );
      }),
  );
}

test.describe('scroll lock behind the off-canvas nav', () => {
  test('main locks while the nav is open, releases on close, and scrolls again', async ({
    page,
  }, testInfo) => {
    /**
     * Fails in ~0ms rather than after a navigation, and names the project.
     *
     * Borrowed from `e2e/support/safe-area.ts` because it is the house guard for "this spec
     * is only meaningful at a phone viewport", and the two phone projects are exactly the set
     * it checks. Its message talks about forced insets, which this spec does not use — the
     * CHECK is a project check and applies; only the prose is inherited. This spec needs it
     * for its own reason: at 1280×720 the nav is pinned rather than off-canvas and `/profile`
     * does not overflow, so both the floor and the lock would fail for reasons that say
     * nothing about either.
     */
    assertPhoneProject(testInfo);

    const response = await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `GET ${ROUTE} did not answer 200`).toBe(200);
    // The service worker answers 200 with the offline fallback under whatever URL failed,
    // and that page is short — so it would fail the floor below with a message about height
    // rather than about the network. Named here instead.
    expect(
      await page.locator('[data-testid="offline-page"]').count(),
      'the service worker served the offline fallback in place of the profile page',
    ).toBe(0);

    // ── The floor: is there anything to scroll at all? ─────────────────────────────────
    // Polled before it is asserted: `domcontentloaded` can be ahead of the client components
    // that give this route its height, and a bare read would race them.
    await expect
      .poll(async () => {
        const g = await geometryOf(page);
        return g.scrollHeight > g.clientHeight;
      })
      .toBe(true);
    const floor = await geometryOf(page);
    expect(
      floor.scrollHeight,
      `${ROUTE} is not taller than its scroll box at ${testInfo.project.name}: scrollHeight ` +
        `${floor.scrollHeight} vs clientHeight ${floor.clientHeight}. THIS IS NOT A LOCK ` +
        'FAILURE — the route stopped being tall enough to scroll (or stopped rendering), so ' +
        'the control below could not mean anything. Pick a taller plain-content route, or ' +
        'fix the render.',
    ).toBeGreaterThan(floor.clientHeight);

    // Baseline: unlocked with the nav shut. Half of the lock's claim is that it is NOT
    // applied the rest of the time — a `main` that is permanently `hidden` would pass every
    // open-state assertion in this file.
    expect(
      await overflowYOf(page),
      `${MAIN} is not scrollable with the nav SHUT: computed overflow-y should be "auto" ` +
        'here. A permanently locked main passes every open-nav assertion below while ' +
        'leaving the app unscrollable.',
    ).toBe('auto');

    // Park mid-range, so the value under assertion is free to move either way.
    await page.locator(MAIN).evaluate((el, top) => {
      el.scrollTop = top;
    }, START_SCROLL_TOP);
    const before = await scrollTopOf(page);
    expect(before, `could not park ${MAIN} at ${START_SCROLL_TOP}px before opening the nav`).toBe(
      START_SCROLL_TOP,
    );

    // ── Open the nav. `nav.openMenu` in the EN catalog is "Open menu". ─────────────────
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator(OPEN_NAV)).toBeVisible();
    /**
     * The backdrop, by its now catalog-backed label — the i18n debt this phase paid.
     *
     * This query is load-bearing beyond finding the element: it resolves only if
     * `nav.closeMenu` renders as "Close menu" in the running app. Put the hardcoded English
     * `aria-label` back and it still passes; render the raw key, and it fails here. The
     * complementary halves are `AppShell.test.tsx` (the component asks the catalog) and
     * `packages/i18n/scripts/check-used-keys.mjs` (the catalog answers).
     */
    const backdrop = page.getByRole('button', { name: 'Close menu' });
    await expect(backdrop).toBeVisible();

    // ── THE LOCK. This is the assertion a broken lock turns red. ───────────────────────
    const lockedOverflowY = await overflowYOf(page);
    expect(
      lockedOverflowY,
      `${MAIN} did not lock while the nav was open: computed overflow-y is ` +
        `"${lockedOverflowY}". This is AppShell.tsx's \`mainScrollClass\` — either the ` +
        'derived `overflow-y-hidden` is not being emitted, or it is being emitted alongside ' +
        'a surviving `overflow-y-auto` and losing the cascade. Note the gesture assertions ' +
        'below CANNOT catch this; see the header.',
    ).toBe('hidden');

    /**
     * The body-position hack, ruled out while the nav is open.
     *
     * A GUARD AGAINST A FUTURE AUTHOR, NOT A TEST OF THE CURRENT CODE — nothing in
     * `AppShell.tsx` touches `body`, so it cannot fail today, and that is exactly why it is
     * here rather than redundant. `position: fixed` on `body` is the widely copied iOS
     * scroll-lock recipe and it would satisfy every other assertion in this file while
     * introducing two bugs of its own: it collapses the document's scroll position to 0, so
     * closing the nav returns the user to the top of a page they were halfway down, and it
     * fights an `h-dvh` shell whose height is already the visual viewport. Do not delete
     * this as dead weight; its job is to be dead.
     */
    expect(
      await page.evaluate(() => getComputedStyle(document.body).position),
      'the scroll lock reached for `position: fixed` on <body>. That recipe resets the ' +
        "document's scroll position and fights the h-dvh shell — lock the element that " +
        'actually scrolls (main#main-content) instead. See the comment above this assertion.',
    ).not.toBe('fixed');

    /**
     * The pointer's target: the exposed backdrop strip, to the RIGHT of the open nav.
     *
     * Computed from the nav's own box rather than hardcoded, because the two phone projects
     * are 360 and 390 wide and the nav is a fixed 240 — a literal x would be inside the nav
     * at one width or off-screen at another the day either number changes. The y is the
     * vertical middle of `main`, which is below the top bar at both viewports.
     *
     * The same point serves both wheels, and that is the design: while the nav is open it is
     * over the `fixed inset-0` backdrop, and once the nav is closed it is over `main` itself.
     * One gesture, one location, two states.
     */
    const navBox = await page.locator(OPEN_NAV).boundingBox();
    const mainBox = await page.locator(MAIN).boundingBox();
    if (!navBox || !mainBox) {
      throw new Error(
        `no layout box for ${!navBox ? OPEN_NAV : MAIN} — if it is the nav, the :visible ` +
          'filter matched the hidden lg:block copy, which has no box',
      );
    }
    const strip = {
      x: (navBox.x + navBox.width + (mainBox.x + mainBox.width)) / 2,
      y: mainBox.y + mainBox.height / 2,
    };
    expect(
      strip.x,
      'the open nav leaves no backdrop strip to aim at — the nav is as wide as the viewport, ' +
        'so the wheel below would be delivered to the nav rather than to the layer covering ' +
        'the page',
    ).toBeGreaterThan(navBox.x + navBox.width);

    /**
     * Wheel over the backdrop: nothing moves.
     *
     * A CLAIM ABOUT THE OVERLAY, NOT ABOUT THE LOCK, and the header explains at length why:
     * this passes with the lock deleted, because `main` is not in the backdrop's ancestor
     * chain and so is not in its scroll-chaining path either. What it does pin is that the
     * backdrop COVERS this strip and absorbs what lands on it — which a scrim given
     * `pointer-events: none`, or one that stopped short of an edge, would break, and which
     * is the property the structural guarantee rests on. Kept for that, and labelled so
     * nobody cites it as proof the lock works.
     */
    await page.mouse.move(strip.x, strip.y);
    await page.mouse.wheel(0, WHEEL_DELTA);
    await settle(page);
    const during = await scrollTopOf(page);
    expect(
      during,
      `the page scrolled behind the open nav: ${MAIN}'s scrollTop went ${before} → ${during} ` +
        `(delta ${during - before}) after a ${WHEEL_DELTA}px wheel over the backdrop at ` +
        `(${Math.round(strip.x)}, ${Math.round(strip.y)}). Since this reading is insensitive ` +
        'to the lock, look at the OVERLAY: is the backdrop still covering this point, and ' +
        'does it still absorb the gesture?',
    ).toBe(before);

    // ── Close, and release. ────────────────────────────────────────────────────────────
    /**
     * Escape rather than a tap on the backdrop, deliberately. A tap at `strip` would close
     * the nav and simultaneously re-prove that the backdrop is hit-testable there — the one
     * thing about the previous step that must not be re-established by the step meant to
     * control for it. Escape closes without touching the pointer, so the mouse is still
     * exactly where the first wheel was delivered.
     */
    await page.keyboard.press('Escape');
    await expect(backdrop).toHaveCount(0);

    const releasedOverflowY = await overflowYOf(page);
    expect(
      releasedOverflowY,
      `${MAIN} stayed locked after the nav closed: computed overflow-y is ` +
        `"${releasedOverflowY}". A lock that is not released leaves the app unscrollable ` +
        'with nothing on screen to explain why — the worse half of this regression. The ' +
        'other close paths (backdrop, route change) and unmount-while-open are covered in ' +
        'apps/web/src/app/[locale]/(app)/AppShell.test.tsx.',
    ).toBe('auto');

    /**
     * The control: the same wheel, at the same point, now that the nav is shut.
     *
     * This is what keeps the two readings above from being vacuous in the other direction —
     * it establishes that `main` is a live scroller at these coordinates and that a wheel's
     * effect is observable inside `settle()`'s window. Without it, "scrollTop unchanged"
     * could mean the wheel never arrived, and "overflow-y is auto" could describe an element
     * that scrolls no better for it.
     */
    await page.mouse.wheel(0, WHEEL_DELTA);
    await settle(page);
    const after = await scrollTopOf(page);
    expect(
      after,
      `the same ${WHEEL_DELTA}px wheel at the same point did not scroll ${MAIN} once the nav ` +
        `was closed: scrollTop is still ${after}. The readings above are therefore taken on ` +
        'an element that does not scroll here at all — look at the pointer coordinates ' +
        `(${Math.round(strip.x)}, ${Math.round(strip.y)}) and at whether anything is still ` +
        'covering main, not at the lock.',
    ).toBeGreaterThan(during);

    // Recorded rather than merely asserted: the header transcribes these numbers, and a
    // reader comparing a red run against them wants them in the run's own log.
    testInfo.annotations.push({
      type: 'scroll-lock',
      description:
        `floor ${floor.scrollHeight}/${floor.clientHeight}; overflow-y auto → ` +
        `${lockedOverflowY} → ${releasedOverflowY}; scrollTop ${before} → ${during} locked; ` +
        `→ ${after} after close (delta +${after - during})`,
    });
  });
});

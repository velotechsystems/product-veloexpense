import { expect, type Page, test } from '@playwright/test';
import {
  assertPhoneProject,
  forceSafeAreaInsets,
  IPHONE_14_PORTRAIT_INSETS,
} from './support/safe-area';

/*
 * VeloExpense: ExpenseOS's `e2e/safe-area.mobile.spec.ts` (1e682dd6), ported with the phone
 * projects (phone e2e 3): the shell's top bar and nav footer consume a forced safe-area inset.
 * The path has no locale segment, and the unshelled `/login` block is left out (see its note at
 * the foot of the file).
 */

/**
 * The two vertical safe-area insets, consumed by the two controls that sit on the edges.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * With a notch and a home indicator forced into existence over CDP:
 *
 *   · the top bar's computed `padding-top` MOVES BY EXACTLY the forced top inset,
 *   · the nav's footer slot's computed `padding-bottom` MOVES BY EXACTLY the forced bottom
 *     inset, and
 *   · `/login`'s own top edge — it renders no shell and no `<header>` — moves by exactly the
 *     forced top inset too, and does NOT grow a bottom one.
 *
 * and with no insets all three read their design values exactly — 14px, 12px and 24px — so
 * the change is a provable no-op on every non-notched surface, which is nearly all of them.
 *
 * ─── WHY DELTAS AND NOT ABSOLUTES ────────────────────────────────────────────────────────
 *
 * This is the whole design of the file, so it is first. The obvious spec forces
 * `{top: 47}` and asserts `padding-top === 47`. That assertion is passed by a header
 * carrying a hardcoded `padding-top: 47px` that consumes nothing at all — the exact
 * regression this file exists to catch, arriving green. So each claim is measured three
 * times: at inset 0, with the inset forced, and at inset 0 again after `restore()`, and
 * what is asserted is that the number MOVED by the forced amount and moved back. A constant
 * cannot do that, whatever its value.
 *
 * The inset-0 absolutes are asserted too, but for the other half of the claim: that the
 * `calc(14px + var(--safe-area-top))` form did not quietly change the design anywhere the
 * insets are zero.
 *
 * ─── THE TOOK-EFFECT GUARD, AND WHAT A RED RUN MEANS ─────────────────────────────────────
 *
 * Before either claim is measured, a PROBE ELEMENT — injected by this spec, not owned by
 * the shell, and reading the four `env(safe-area-inset-*)` functions DIRECTLY rather than
 * through the app's `--safe-area-*` aliases — is polled until it reports the forced numbers.
 * That split is what makes a red run readable:
 *
 *   · probe reports 0/0 → THE OVERRIDE OR THE EMULATION BROKE. Nothing about the app is
 *     implicated. Look at `e2e/support/safe-area.ts` and at the Chromium version.
 *   · probe reports 47/34, header or footer did not move → THE CONSUMPTION BROKE. The
 *     `calc()` on `TopBar.tsx`'s `<header>`, the one on the design-system `Sidebar`'s footer
 *     slot, or the `--safe-area-*` aliases in `packages/design-system/src/globals.css`.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ THIS BEFORE CITING THE FILE ──────────────
 *
 * IT DOES NOT PROVE `viewportFit: 'cover'` IS PRESENT, and therefore does not prove the app
 * would see non-zero insets on a real handset at all. Measured on the harness and written up
 * at the head of `e2e/support/safe-area.ts`, which is the record: Chromium's CDP inset override
 * IGNORES `viewport-fit` entirely — forced insets apply identically with `cover`, with
 * `contain`, and with no meta viewport tag at all. So a red probe above has a THIRD possible
 * cause a reader might reach for, and it is the wrong one: `viewport-fit` cannot be it, in
 * either direction, in this browser.
 *
 * That claim lives somewhere else on purpose, and here is the pointer:
 * `apps/web/src/app/[locale]/layout.test.tsx:120` asserts `viewport.viewportFit === 'cover'`
 * on the App Router `viewport` export. It is a unit assertion on the object Next is given,
 * and it is deliberately NOT duplicated here — folding it in would make one red run mean two
 * unrelated things. The narrow gap neither test closes is that nothing proves Next actually
 * EMITS the resulting tag into the document; that is covered by the on-device pass.
 *
 * Nor does a green run say anything about the horizontal insets. In portrait both are 0 on
 * the handsets in scope, and `TopBar.tsx`'s `px-4 lg:px-8` is deliberately untouched —
 * `e2e/topbar-overlap.spec.ts` uses `headerPaddingLeft === 32` as its proof that the `lg:`
 * branch is live, and its width constants are measurements rather than tolerances.
 * Landscape side insets are a separate change, with that spec re-measured in the same
 * commit.
 *
 * ─── FALSIFICATION: OBSERVED, NOT ASSUMED ────────────────────────────────────────────────
 *
 * Both assertions were WATCHED TO FAIL during the build, one at a time, by reverting the
 * padding each one gates. An assertion nobody has seen fail is not a gate. The numbers below
 * are transcribed from those runs, not reasoned about.
 *
 * Green, for reference (identical on `mobile-360` and `mobile-390`):
 *   header padding-top      14 → 61 → 14   (delta +47, and back)
 *   nav footer padding-bot  12 → 46 → 12   (delta +34, and back)
 *
 * RED 1 — `TopBar.tsx`'s `pt-[calc(14px_+_var(--safe-area-top))]` reverted to `pt-[14px]`,
 * on `mobile-390`:
 *   > the top bar did not consume the forced 47px top inset: padding-top is 14px forced vs
 *   > 14px at inset 0, a delta of 0.
 *   Expected 47, received 0.
 *
 * RED 2 — the design-system `Sidebar` footer slot's
 * `pb-[calc(12px_+_var(--safe-area-bottom))]` reverted to `py-3`, on `mobile-390`:
 *   > the nav footer did not consume the forced 34px bottom inset: padding-bottom is 12px
 *   > forced vs 12px at inset 0, a delta of 0.
 *   Expected 34, received 0.
 *
 * RED 3 — `login/page.tsx`'s `pt-[calc(1.5rem_+_var(--safe-area-top))]` reverted to `py-6`,
 * on `mobile-390`:
 *   > the login page did not consume the forced 47px top inset: padding-top is 24px forced vs
 *   > 24px at inset 0, a delta of 0.
 *   Expected 47, received 0.
 *   The shell's two claims stayed green in the same run, which is the point of measuring the
 *   unshelled pages separately: they are a different box on a different layout, and a green
 *   top bar says nothing about them.
 *
 * THE PART WORTH KEEPING: in ALL THREE red runs the inset-0 absolutes — 14px, 12px and 24px —
 * stayed green, and the probe stayed green. That is the demonstration that neither the absolutes
 * nor the guard could have caught either regression on their own, and that only the delta
 * does. Both went green again on restore.
 */

/** Matches `crawl-mobile.spec.ts` — layout is not locale-specific, and one locale is enough. */
// VeloExpense: no locale segment in a path, so ExpenseOS's `const LOCALE = 'en'` is gone.

/**
 * The route measured. Any `(app)` route would do — the two boxes under test are the SHELL's,
 * not the page's — and `/dashboard` is chosen because it is the post-login landing page, so
 * it is the one route the stored session is certain to render rather than redirect.
 */
const ROUTE = '/dashboard';

/** The forced insets. iPhone 14 portrait, from the shared fixture: 47pt notch, 34pt indicator. */
const FORCED = IPHONE_14_PORTRAIT_INSETS;

/** The design values, with no insets. Both must survive the change untouched. */
const HEADER_PADDING_TOP_AT_ZERO = 14;
const NAV_FOOTER_PADDING_BOTTOM_AT_ZERO = 12;

/**
 * `data-*`, not an `#id`, and not a class.
 *
 * `npm run e2e:check-ids` exits 1 on any `#id` this suite addresses that does not exist in
 * `apps/web/src`, and this element does not exist there at all — it is created here. A class
 * selector would be worse: the probe's whole value is that the shell does not own it, and a
 * class is one `cn()` merge away from being something the shell does own.
 */
const PROBE = '[data-safe-area-probe]';

/** The shell's top bar. Addressed through the `data-zone` seam `TopBar.tsx` maintains for
 *  exactly this, rather than as `header` — `PlatformAdmin.tsx` and several page bodies also
 *  render a `<header>`, and a bare tag selector would measure whichever came first. */
const TOP_BAR = 'header:has([data-zone="left"])';

/**
 * The nav's footer slot — the `data-sidebar-slot` seam on the design-system `Sidebar`.
 *
 * `:visible` is load-bearing. `AppShell` renders the sidebar TWICE: once in a
 * `hidden … lg:block` wrapper (the persistent desktop nav, present in the DOM at every
 * width and `display: none` below `lg`) and once inside the `fixed inset-0 z-40` overlay,
 * mounted only while the nav is open. Both carry a footer slot, so an unfiltered selector is
 * strict-mode-ambiguous, and resolving that with `.first()` would silently measure the
 * hidden desktop copy — which reports the same padding here, so the mistake would be
 * invisible until the day the two diverge.
 */
const NAV_FOOTER = '[data-sidebar-slot="footer"]:visible';

interface Measurement {
  headerPaddingTop: number;
  navFooterPaddingBottom: number;
}

/** One box's computed padding on one side, in CSS pixels. */
async function paddingOf(
  page: Page,
  selector: string,
  side: 'top' | 'bottom' | 'left' | 'right',
): Promise<number> {
  const box = page.locator(selector);
  await expect(box, `${selector} did not resolve to exactly one element`).toHaveCount(1);
  const raw = await box.evaluate(
    (el, s) => getComputedStyle(el).getPropertyValue(`padding-${s}`),
    side,
  );
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(`padding-${side} on ${selector} did not parse as a number: "${raw}"`);
  }
  return value;
}

/** Both claims' boxes, measured together so the pair is from one layout state. */
async function measure(page: Page): Promise<Measurement> {
  return {
    headerPaddingTop: await paddingOf(page, TOP_BAR, 'top'),
    navFooterPaddingBottom: await paddingOf(page, NAV_FOOTER, 'bottom'),
  };
}

/**
 * The probe: a fixed 1×1 box whose four paddings are the four `env()` functions.
 *
 * Injected as a STYLESHEET RULE rather than as inline `style` properties. CSSOM's
 * inline-style parser is the fragile path for `env()` — a rejected declaration leaves the
 * property empty and the computed padding at 0px, which is indistinguishable from "the
 * override did not land" and would send a reader to the wrong file. A stylesheet rule parses
 * the same way the app's own CSS does. The `getComputedStyle` check closes the residual case:
 * if the rule were dropped, the probe fails HERE, naming itself, before it can be read as
 * evidence about anything else.
 *
 * `position: fixed` + `pointer-events: none` so it neither participates in the shell's flex
 * layout nor intercepts the hamburger tap that follows.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate((probeAttr) => {
    const style = document.createElement('style');
    style.textContent = `[${probeAttr}]{position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);}`;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.setAttribute(probeAttr, '');
    document.body.appendChild(el);
    if (getComputedStyle(el).position !== 'fixed') {
      throw new Error('safe-area probe: the injected stylesheet rule did not apply');
    }
  }, 'data-safe-area-probe');
}

/**
 * Wait until the probe reports the insets the browser has been told to serve.
 *
 * A poll rather than a bare assertion: the override arrives over CDP, out of band with the
 * page's own event loop, so the first computed style read after `forceSafeAreaInsets` (or
 * after `restore()`) can legitimately still be the previous value. Polling here rather than
 * on the header or footer keeps the guard's meaning intact — it is asking "did the OVERRIDE
 * land", and nothing about the app is in the answer.
 */
async function awaitProbe(page: Page, top: number, bottom: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const [t, b] = await Promise.all([
          paddingOf(page, PROBE, 'top'),
          paddingOf(page, PROBE, 'bottom'),
        ]);
        return `${t}/${b}`;
      },
      {
        message:
          `the probe element never reported top/bottom insets of ${top}/${bottom}. The probe ` +
          'reads `env(safe-area-inset-*)` directly, so this is the CDP override or the ' +
          'emulation, NOT the app consuming them — see e2e/support/safe-area.ts. It is also ' +
          "NOT `viewportFit: cover`: this Chromium's inset override ignores `viewport-fit` " +
          'entirely (measured), and that claim is asserted separately at ' +
          'apps/web/src/app/[locale]/layout.test.tsx:120.',
      },
    )
    .toBe(`${top}/${bottom}`);
}

test.describe('safe-area insets, portrait', () => {
  test('the top bar and the nav footer each move by exactly the forced inset', async ({
    page,
  }, testInfo) => {
    // Fails in ~0ms rather than after a navigation and a sign-in, and names the project.
    assertPhoneProject(testInfo);

    const response = await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `GET ${ROUTE} did not answer 200`).toBe(200);
    // The service worker serves `/<locale>/offline` under whatever URL failed, and the
    // fallback still answers 200 with a `<main>`. It has no top bar, so the selector below
    // would fail — but with a message about a missing header rather than about the network.
    expect(
      await page.locator('[data-testid="offline-page"]').count(),
      'the service worker served the offline fallback in place of the dashboard',
    ).toBe(0);

    await installProbe(page);

    /**
     * Open the nav, because below `lg` the footer slot under test is inside the overlay and
     * is not mounted until then. The hamburger is `TopBar.tsx`'s `aria-label={tNav('openMenu')}`
     * — "Open menu" in the EN catalog (`packages/i18n/src/catalogs/en/nav.json`), which is
     * the locale this file runs in.
     */
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator(NAV_FOOTER)).toBeVisible();

    // ── Claim 0: at inset 0, nothing moved. The no-op half of the change. ───────────────
    await awaitProbe(page, 0, 0);
    const atZero = await measure(page);
    expect(
      atZero.headerPaddingTop,
      "the top bar's padding-top is not its design value with no insets — the calc() " +
        'changed the layout on every non-notched surface, which it must not',
    ).toBe(HEADER_PADDING_TOP_AT_ZERO);
    expect(
      atZero.navFooterPaddingBottom,
      "the nav footer's padding-bottom is not its design value with no insets — the calc() " +
        'changed the layout on every non-notched surface, which it must not',
    ).toBe(NAV_FOOTER_PADDING_BOTTOM_AT_ZERO);

    // ── Forced: a notch and a home indicator. ───────────────────────────────────────────
    const restore = await forceSafeAreaInsets(page, testInfo, FORCED);
    await awaitProbe(page, FORCED.top, FORCED.bottom);
    const forced = await measure(page);

    expect(
      forced.headerPaddingTop - atZero.headerPaddingTop,
      `the top bar did not consume the forced ${FORCED.top}px top inset: padding-top is ` +
        `${forced.headerPaddingTop}px forced vs ${atZero.headerPaddingTop}px at inset 0, a ` +
        `delta of ${forced.headerPaddingTop - atZero.headerPaddingTop}. The probe already ` +
        "confirmed the override landed, so this is TopBar.tsx's calc() or the " +
        '--safe-area-top alias in packages/design-system/src/globals.css.',
    ).toBe(FORCED.top);
    expect(
      forced.navFooterPaddingBottom - atZero.navFooterPaddingBottom,
      `the nav footer did not consume the forced ${FORCED.bottom}px bottom inset: ` +
        `padding-bottom is ${forced.navFooterPaddingBottom}px forced vs ` +
        `${atZero.navFooterPaddingBottom}px at inset 0, a delta of ` +
        `${forced.navFooterPaddingBottom - atZero.navFooterPaddingBottom}. The probe already ` +
        "confirmed the override landed, so this is the design-system Sidebar footer slot's " +
        'calc() or the --safe-area-bottom alias in globals.css.',
    ).toBe(FORCED.bottom);

    // ── Cleared: and back down again, by the same amount. ───────────────────────────────
    /**
     * The second half of the delta, and not redundant with the first.
     *
     * The forced-vs-zero pair is measured across a state change in ONE direction, which a
     * padding that grew for an unrelated reason between the two reads could counterfeit.
     * Measuring the return trip means a passing implementation has to track the inset DOWN
     * as well as up — which a `calc()` reading `env()` does for free, and a value written
     * once by script does not.
     */
    await restore();
    await awaitProbe(page, 0, 0);
    const cleared = await measure(page);

    expect(
      forced.headerPaddingTop - cleared.headerPaddingTop,
      'the top bar kept the top inset after it was cleared — the padding is not tracking ' +
        'env(), it was set once',
    ).toBe(FORCED.top);
    expect(
      forced.navFooterPaddingBottom - cleared.navFooterPaddingBottom,
      'the nav footer kept the bottom inset after it was cleared — the padding is not ' +
        'tracking env(), it was set once',
    ).toBe(FORCED.bottom);
    // And it landed back exactly on the design values, not merely somewhere lower.
    expect(cleared).toEqual(atZero);
  });
});

/*
 * VeloExpense: ExpenseOS's second block — "the unshelled auth pages", `/login` moving its own
 * top edge by the forced inset — is not here. VeloExpense's `/login` is VeloExpense's own page
 * (SSO, invite-only), not ExpenseOS's, and consumes no safe-area inset; it is left out with the
 * other auth pages, as `tap-targets.mobile.spec.ts` leaves them out.
 */

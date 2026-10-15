import type { Page, TestInfo } from '@playwright/test';
import { PHONE_PROJECTS } from './phone-projects';

/**
 * Forced safe-area insets for the phone projects — the notch and the home indicator, made
 * to exist in a browser that has neither.
 *
 * ─── WHY THIS IS NOT JUST A VIEWPORT SETTING ─────────────────────────────────────────────
 *
 * `env(safe-area-inset-*)` is what a page uses to keep its own chrome out from under the
 * notch and the home indicator. In headless Chromium every one of those four values is
 * `0px`, whatever viewport is emulated and whatever `devices['iPhone 14']` declares — the
 * descriptor carries metrics, not insets. So a spec that renders a bottom tab bar at 390px
 * and measures it is measuring the ONE case the padding does not matter in, and a shell
 * that forgot `padding-bottom: env(safe-area-inset-bottom)` passes green while sitting
 * under the home indicator on every real handset. The insets have to be forced, or they are
 * not being tested.
 *
 * ─── THE MECHANISM ───────────────────────────────────────────────────────────────────────
 *
 * CDP `Emulation.setSafeAreaInsetsOverride`, which drives the same values the CSS `env()`
 * function reads. Verified against the Chromium that ships with this repo's Playwright
 * (148.0.7778.96) — the four facts worth writing down, because none is in the protocol
 * docs in a form you can rely on:
 *
 *   · The `insets` PARAMETER is required; its MEMBERS are all optional. `{ insets: {} }` is
 *     accepted and zeroes everything (that is `restore()` below). Sending `{}` with no
 *     `insets` key at all is rejected outright as "Invalid parameters" — so there is no
 *     "un-override" call, only an override back to zero.
 *   · The `*Max` members (`topMax`, …) are optional. They back the separate
 *     `env(safe-area-max-inset-*)` family; this app does not use it, so they are set equal
 *     to their plain counterparts rather than left out, so that anything reading the max
 *     form sees the same geometry instead of a surprising zero.
 *   · The override is CONTEXT-DURABLE: it survives `page.goto` and `setContent`. Calling it
 *     once before navigating is enough, and it does NOT need re-applying per route.
 *   · IT IGNORES `viewport-fit`. See the honesty note below — this is the one that matters.
 *
 * ─── WHAT A GREEN RUN USING THIS DOES NOT ESTABLISH ──────────────────────────────────────
 *
 * IT DOES NOT PROVE `viewport-fit=cover` IS PRESENT. In a real browser `env(safe-area-
 * inset-*)` resolves to zero unless the page's `<meta name="viewport">` opts in with
 * `viewport-fit=cover`. Chromium's CDP override does not honour that gate: measured here,
 * forced insets apply identically with `viewport-fit=cover`, with `viewport-fit=contain`,
 * and with no meta viewport tag at all (47/0/34/0 in all three). So this helper proves the
 * app CONSUMES the insets; it cannot prove the app ASKED for them. Deleting the
 * `viewportFit: 'cover'` line from the app's `viewport` export would ship a regression that
 * every spec built on this helper still calls green. That assertion has to be made
 * separately, against the emitted meta tag, and must not be folded in here on the reasoning
 * that this file is already about safe areas.
 */

/**
 * `PHONE_PROJECTS` — the only projects in which forced insets are meaningful, and the whole
 * content of the guard below — is IMPORTED from `./phone-projects`, never restated here.
 *
 * Every one of them is declared `browserName: 'chromium'` in `playwright.config.ts`, which
 * is what makes CDP available at all (there is no `newCDPSession` on firefox or webkit). So
 * the project-name check below is transitively an engine check too: nothing can reach the
 * CDP call from a project that could not serve it. THAT INFERENCE IS ONLY SOUND WHILE THE
 * TWO LISTS AGREE — and until P02 they agreed by hand, under a comment saying that a third
 * phone project added to the config and not added here should "fail loudly on first use".
 * Loud, but only once a phone spec actually runs, which needs a server, a database and a
 * browser. `scripts/check-phone-projects.mjs` makes it fail at build time instead, with no
 * browser, and refuses any restatement of the list in this file.
 */

/** The four CSS insets, in CSS pixels. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * iPhone 14 in portrait: a 47pt notch and a 34pt home indicator, nothing at the sides.
 *
 * These are the published iOS metrics for the handset `mobile-390` emulates, NOT numbers
 * measured on a device — on-device verification is iOS-only for this ticket and lands
 * separately. They are here as a realistic non-zero fixture: what a spec needs is insets
 * big enough that forgetting to pad for them is visible, and 34px at the bottom is roughly
 * a tab bar's worth. `mobile-360` and `mobile-412` get the same numbers deliberately —
 * neither is a handset, they are the narrow and wide ends of the field, and giving either
 * one its own invented inset set would imply a device this repo does not claim to cover.
 */
export const IPHONE_14_PORTRAIT_INSETS: SafeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };

/**
 * Refuse to run outside the phone projects, naming the caller's project in the message.
 *
 * THIS GUARD IS THE POINT OF THE FILE, not defensive garnish. `chromium` runs
 * `e2e/topbar-overlap.spec.ts`, which asserts `headerPaddingLeft === 32` as its proof that
 * the `lg:` branch is live; a forced 47px top inset reaching that project moves top-bar
 * geometry and turns that spec red for a reason that has nothing to do with the top bar,
 * three files away from the edit that caused it. The two ways to get there are a phone spec
 * mis-named so `chromium`'s `testIgnore` misses it, and a desktop spec importing this
 * module for the geometry helpers. `playwright.config.ts` closes the first by construction;
 * this closes the second, and closes the first again if the config is ever half-edited.
 *
 * It names the project because the failure is otherwise unreadable: "insets are not allowed
 * here" sends the reader to this file, whereas "called from chromium" sends them to the
 * `testIgnore` list, which is where the bug is.
 */
export function assertPhoneProject(testInfo: TestInfo): void {
  const project = testInfo.project.name;
  if (!(PHONE_PROJECTS as readonly string[]).includes(project)) {
    throw new Error(
      `safe-area: forced insets were requested from the "${project}" project. They are ` +
        `only valid in ${PHONE_PROJECTS.join(' / ')}. Either this spec is collected by the ` +
        'wrong project — check PHONE_ONLY_SPECS / PHONE_PROJECT_SPECS in ' +
        'playwright.config.ts — or a desktop spec is importing e2e/support/safe-area.ts. ' +
        'Forcing insets in chromium moves top-bar geometry and breaks ' +
        'e2e/topbar-overlap.spec.ts, which asserts headerPaddingLeft === 32.',
    );
  }
}

/**
 * Give the page a notch and a home indicator, and hand back the undo.
 *
 * Call it ONCE per page, before navigating: the override is context-durable (see the header
 * note), so it applies to every subsequent load without being re-sent. The returned
 * `restore` zeroes all four insets — the protocol has no "stop overriding", so zero is the
 * closest thing, and it is also the state the browser was in beforehand, which makes it a
 * true restore rather than an approximation.
 *
 * `restore` exists so a spec can assert the SAME layout with and without insets in one
 * test, which is the assertion that actually catches a hardcoded `padding-bottom: 34px`
 * standing in for the `env()` call.
 */
export async function forceSafeAreaInsets(
  page: Page,
  testInfo: TestInfo,
  insets: SafeAreaInsets = IPHONE_14_PORTRAIT_INSETS,
): Promise<() => Promise<void>> {
  assertPhoneProject(testInfo);

  // Bound to this page, though created from the context — one session is reused for the
  // override and its undo so a spec that restores does not open a second one.
  const cdp = await page.context().newCDPSession(page);
  const apply = (i: SafeAreaInsets) =>
    cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: {
        top: i.top,
        topMax: i.top,
        right: i.right,
        rightMax: i.right,
        bottom: i.bottom,
        bottomMax: i.bottom,
        left: i.left,
        leftMax: i.left,
      },
    });

  await apply(insets);
  return () => apply({ top: 0, right: 0, bottom: 0, left: 0 }).then(() => undefined);
}

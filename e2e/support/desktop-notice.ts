import { expect, type Page, test } from '@playwright/test';

/**
 * Stepping past the desktop-only notice, for the specs that have to measure the PAGE behind
 * a route ruled `desktop`.
 *
 * ─── WHY THIS IS SHARED MACHINERY AND NOT A LOCAL HELPER ─────────────────────────────────
 *
 * `desktop-notice.spec.ts` owns the claim "the notice appears, suppresses the page, and
 * Continue anyway reveals it". Every OTHER phone spec has the opposite relationship with the
 * notice: it is an obstacle in front of the thing being measured. Before a route is ruled
 * `desktop`, those specs measure the page directly; after, they measure nothing at all unless
 * they can get past the notice first. Both needs are the same three lines of Playwright, and
 * the failure modes they have to avoid are the same two, so they are written once here.
 *
 * ─── THE ONE INVARIANT: THIS IS NEVER A SILENT NO-OP ─────────────────────────────────────
 *
 * A "step past the notice if there is one" helper is worse than no helper. A gate that calls
 * it goes green whether or not the ruling it depends on is still in place — the notice
 * disappears from `mobileReadiness.ts`, the helper shrugs, and the only signal that a route's
 * disposition changed is lost. So the caller must DECLARE which side of the ruling it expects
 * to be on, and the declaration is checked:
 *
 *   · `{ expect: 'present' }` — there must be a visible notice, and it is dismissed. No
 *     notice is a failure, not a fast path.
 *   · `{ expect: 'absent' }`  — there must be no visible notice, and nothing is clicked. A
 *     notice is a failure, not something to click through opportunistically.
 *
 * ─── WHAT THIS MODULE DELIBERATELY DOES NOT KNOW ─────────────────────────────────────────
 *
 * WHICH ROUTES ARE RULED `desktop`. That lives in `mobileReadiness.ts` and nowhere else; a
 * second copy in the e2e tree is a list that goes stale silently and then lies about which
 * pages a phone can reach. Callers pass their own expectation per route; the helper checks
 * the page in front of it and says which route and which project when the two disagree.
 */

/** The notice's handle in the DOM. The one selector; `desktop-notice.spec.ts` imports it too,
 *  and both halves of the contract below are written in terms of it. */
export const DESKTOP_NOTICE_SELECTOR = '[data-testid="desktop-only-notice"]';

/**
 * VISIBILITY, not presence, is the question — and that is not a stylistic choice.
 *
 * The suppression is CSS: the notice is in the server's HTML in EVERY project, and at `lg`
 * it is `display: none` rather than absent (`desktop-notice.spec.ts`, the no-flash claim).
 * A `toHaveCount(1)` here would be satisfied at 1280 by a notice no reader can see, and a
 * `toHaveCount(0)` would never be satisfied anywhere. `:visible` is the only form that
 * distinguishes the two sides.
 */
const VISIBLE_NOTICE = `${DESKTOP_NOTICE_SELECTOR}:visible`;

export interface StepPastDesktopNoticeOptions {
  /**
   * What the caller asserts about this route, in this project, before anything is clicked.
   * Required and not defaulted: a default would make the no-op case reachable by omission,
   * which is the failure this helper exists to prevent.
   */
  expect: 'present' | 'absent';
}

/**
 * Where we are, for a failure message — PATH ONLY, never the query string.
 *
 * `tap-targets.mobile.spec.ts`'s `query` field exists so that a credential in a query string
 * stays out of the logs. A helper that printed `page.url()` verbatim would undo that
 * discipline from the outside.
 */
function whereAmI(page: Page): string {
  let path: string;
  try {
    path = new URL(page.url()).pathname;
  } catch {
    path = page.url() || '(no page loaded)';
  }
  let project: string;
  try {
    project = test.info().project.name;
  } catch {
    // `test.info()` throws outside a running test. Nothing here needs it badly enough to fail.
    project = 'unknown project';
  }
  return `${path} at ${project}`;
}

/**
 * Tap "Continue anyway", and keep tapping until it takes.
 *
 * ─── THIS IS NOT FLAKE MANAGEMENT. IT IS A MEASURED PROPERTY OF THE PRODUCT ──────────────
 *
 * The control is a client handler, so it does nothing until the route has hydrated — and the
 * route it belongs to is one whose page is deliberately heavy (that is WHY it is ruled
 * `desktop`). `/admin/roles` mounts `RoleBuilder` and its tRPC queries behind
 * `display: none`, and measured here on `mobile-390`, the first tap ~1s after the notice
 * paints is swallowed, while a tap ~4s in is honoured. A real reader on a real handset can
 * therefore tap this button and watch nothing happen.
 *
 * That is worth stating plainly rather than hiding inside a `waitForTimeout`: the notice
 * PAINTS before it WORKS, because the paint is CSS and the button is JavaScript. It is the
 * exact inverse of the property the notice was built for, it is inherent to any client
 * control on a heavy route, and it is out of this change's scope — but a fixed sleep here
 * would have buried it, and a reader debugging a slow phone deserves to find it written down.
 *
 * `toPass` re-runs the click until the notice is gone. Re-clicking is harmless: the handler
 * is idempotent, and the first click that lands ends the loop.
 *
 * (Measured on `/admin/roles`, but the property is the route's weight and not its identity,
 * so every route a later phase opts in gets the same loop. A route so heavy that 30s is not
 * enough is a finding about that route, not a reason to raise the budget.)
 */
async function continueAnyway(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('desktop-only-notice').getByRole('button').click({ timeout: 2_000 });
    await expect(page.locator(DESKTOP_NOTICE_SELECTOR)).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Put the page — not the notice — in front of the assertions that follow.
 *
 * With `{ expect: 'present' }`: assert exactly one VISIBLE notice, dismiss it, and assert it
 * is UNMOUNTED (not merely hidden — `crawl-mobile.spec.ts` fails a present-but-hidden notice,
 * and a mounted one keeps its controls in the tab order above the page the reader asked for).
 *
 * With `{ expect: 'absent' }`: assert no visible notice and click nothing.
 *
 * Both directions fail with the route, the project, and what to go and look at.
 */
export async function stepPastDesktopNotice(
  page: Page,
  options: StepPastDesktopNoticeOptions,
): Promise<void> {
  const where = whereAmI(page);

  if (options.expect === 'absent') {
    expect(
      await page.locator(VISIBLE_NOTICE).count(),
      `${where} rendered the desktop-only notice, so this gate measured the notice and not the ` +
        'page. If the route was ruled `desktop` in mobileReadiness.ts after this gate was ' +
        'written, opt it in — set `pastNotice: true` on its entry and the gate will step past ' +
        'the notice and go on measuring the page. Do NOT delete the entry: the gate is the ' +
        'only witness this route has, and a ruled route is still a route a reader can reach ' +
        'with Continue anyway. If the route was NOT ruled, then either the ruling is wrong or ' +
        'this project is below lg when it should not be (playwright.config.ts).',
    ).toBe(0);
    return;
  }

  // `expect: 'present'`. Checked BEFORE the click loop, and with a short budget, because the
  // loop's own failure for a missing notice is a 30s timeout on a click that has no target —
  // loud, but 30 seconds of it, and it names the button rather than the ruling.
  await expect(
    page.locator(VISIBLE_NOTICE),
    `${where} was expected to render the desktop-only notice and did not, so there was nothing ` +
      'to step past. Either the route is no longer ruled `desktop` in mobileReadiness.ts — ' +
      'check its registry row, and remember rulings are inherited by longest prefix, so a ' +
      'parent row moving changes children that carry no row of their own — in which case the ' +
      'caller should stop asking to step past it; or this project is at or above the lg ' +
      'breakpoint, where the notice is display:none by design (playwright.config.ts).',
  ).toHaveCount(1, { timeout: 15_000 });

  await continueAnyway(page);

  await expect(
    page.locator(DESKTOP_NOTICE_SELECTOR),
    `${where}: Continue anyway must UNMOUNT the notice, not hide it`,
  ).toHaveCount(0);
}

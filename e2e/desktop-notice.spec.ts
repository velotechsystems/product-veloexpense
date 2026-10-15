import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { DESKTOP_NOTICE_SELECTOR, stepPastDesktopNotice } from './support/desktop-notice';
import { PHONE_PROJECTS } from './support/phone-projects';

/*
 * VeloExpense: ExpenseOS's `e2e/desktop-notice.spec.ts` (1e682dd6), ported with the phone
 * projects (phone e2e 3). Runs in every project, as there. Only the paths changed (no locale
 * segment). `/admin/roles` is ruled `desktop` here as in ExpenseOS.
 */

/**
 * The desktop-only notice: a route ruled `desktop` shows the notice and not its page below
 * `lg`, shows its page and not the notice at `lg`, and does both before the first style
 * resolution rather than after a client round-trip.
 *
 * ─── THE ONE SPEC THAT RUNS IN EVERY PROJECT, AND WHY ────────────────────────────────────
 *
 * Registered in `PHONE_SHARED_SPEC_PATTERNS` in `playwright.config.ts` — the only entry
 * there. Every other phone spec is phone-only, and this one is not, because HALF OF ITS
 * CLAIM IS THE DESKTOP HALF. "The notice shows at 360" is passed by a build whose
 * suppression is unconditional — one that hides every `desktop`-ruled page from everybody,
 * on every screen. Only "and does NOT show at 1280, where the page renders instead"
 * distinguishes a gate from a deletion, and it has to run in a 1280 project to say so.
 *
 * So almost every test below is written once and asserts the INVERSE per project, driven by
 * `expectsNotice(testInfo)`. Where a test genuinely cannot be inverted — clicking a control
 * that is `display: none` at 1280 — it is skipped by project, and the skip says which.
 *
 * ─── THE TOOK-EFFECT GUARD ───────────────────────────────────────────────────────────────
 *
 * Before any claim about the notice, `assertBreakpointEmulation` checks that the engine
 * actually is on the side of the `lg` breakpoint this project claims — `matchMedia`, read in
 * the page, against the project's declared viewport. That split is what makes a red run
 * readable:
 *
 *   · guard red  → THE EMULATION BROKE, or a project's viewport moved. Nothing about the app
 *                  is implicated; look at `playwright.config.ts`.
 *   · guard green, notice wrong → THE APP BROKE. `DesktopOnlyNotice.tsx`'s `lg:hidden` /
 *                  `hidden lg:contents` pair, or `mobileReadiness.ts`'s ruling for the route.
 *
 * It is a real guard rather than a formality: Chromium's CDP `Emulation.setEmulatedMedia`
 * silently ignores a `pointer` feature in this build (148.0.7778.96) — measured on the
 * harness and written up at `assertCoarsePointer` in `e2e/support/tap-targets.ts`, which is
 * the record — so "the emulation was requested" and "the emulation happened" are known to be
 * different things in this pipeline.
 *
 * ─── THE NO-FLASH CLAIM, IN THREE LAYERS, AND EXACTLY HOW FAR IT REACHES ─────────────────
 *
 * The mechanism is CSS precisely so that a phone never paints the page it is not allowed to
 * use. Three independent oracles, because each one alone has a hole the next covers:
 *
 *   1. THE SERVER'S HTML. A raw `request.get` of the route, asserted on the response BODY:
 *      both subtrees are present in the document as delivered. Rules out "the notice is
 *      client-rendered", which would flash by construction. Blind to CSS.
 *   2. A `javaScriptEnabled: false` CONTEXT. The notice shows and the page does not, with no
 *      hydration having happened at all. Rules out "a `useEffect` decides this". Blind to
 *      ordering within the load.
 *   3. A `requestAnimationFrame` PROBE, installed before the document exists and fired on the
 *      first frame after `DOMContentLoaded`. Reads the COMPUTED `display` of both elements at
 *      that instant. Rules out "the classes are right but the stylesheet arrives late".
 *
 * WHAT NONE OF THE THREE ESTABLISHES, AND THE SPEC WILL NOT CLAIM: that no pixel of the page
 * was ever painted. Layer 3 proves the styles were correct at the first frame after the
 * document parsed; it does not prove the compositor never presented an earlier frame, and no
 * oracle available here does — Playwright has no per-frame pixel history, and a screenshot is
 * taken after the fact by definition. THE CLAIM IS "PROVEN TO FIRST STYLE RESOLUTION, NOT TO
 * PAINTED PIXELS." Anyone who needs the stronger claim needs a trace with paint events, and
 * should say so rather than cite this file.
 *
 * ─── WHAT ELSE A GREEN RUN DOES NOT ESTABLISH ────────────────────────────────────────────
 *
 * IT SAYS NOTHING ABOUT WHO MAY OPEN THE ROUTE. The gate is cosmetic, and `permissions.spec.ts`
 * remains the file that proves `/admin/roles` is RBAC-enforced server-side. If this spec ever
 * starts asserting a 403 or a redirect, the gate has stopped being cosmetic and that is a
 * defect, not a feature.
 *
 * IT DOES NOT COVER FR-CA. The suppression is layout, not language; `crawl-mobile.spec.ts`
 * makes the same locale choice for the same reason. The catalog keys are proved to resolve in
 * both locales in `DesktopOnlyNotice.test.tsx`, against the catalogs off disk.
 *
 * IT DOES NOT PROVE THE FOCUS HANDOVER IS ANNOUNCED. It asserts `document.activeElement` is
 * the content container after "Continue anyway"; what a screen reader says at that moment is
 * an on-device question.
 *
 * ─── FALSIFICATION: OBSERVED, NOT ASSUMED ────────────────────────────────────────────────
 *
 * Watched to fail during the build, one break at a time, against a dev server on :3118. The
 * numbers and messages below are transcribed from those runs, not reasoned about.
 *
 * RED 1 — `lg:hidden` DELETED from the notice, run in `chromium` and `mobile-390` together.
 *   `mobile-390` STAYED GREEN — the notice is supposed to show there, and a build that shows
 *   it everywhere satisfies every phone assertion in this file. `chromium` went red:
 *     > /en/admin/roles rendered a VISIBLE desktop-only notice at chromium — the suppression
 *     > is unconditional, not a gate.
 *     Expected "none", received "flex".
 *   That pair IS the argument for this file being in all three projects. The regression is
 *   invisible to both phone projects, and a phone task would have written only those.
 *
 * RED 2 — `hidden lg:contents` reduced to `lg:contents`, on `mobile-360`:
 *     > the page is not suppressed at mobile-360.
 *     Expected "none", received "block".
 *   The notice's own assertions stayed green in that run — it was still visible, still
 *   exactly one — which is the demonstration that "one visible notice" does not imply "no
 *   page". Measured separately in the same broken build: 308 laid-out elements of RoleBuilder
 *   were sitting under the notice at 360px, which is what `laidOutContent` exists to catch
 *   when the `display` reading is ever made less direct.
 *
 * RED 3 — `contents` swapped for `block` on the content wrapper, on `chromium`:
 *     > removing the display:contents wrapper moved 4 of 154 rectangles — the desktop layout
 *     > is NOT byte-identical.
 *     Expected 0, received 4.
 *   FOUR OF 154, AND THE SMALLNESS IS THE POINT. Most of the page is width-driven and reflows
 *   identically inside a block box; what moves is the page root's own height chain, where
 *   `h-full min-h-0` stops resolving against `main`. That is exactly the class of change no
 *   reviewer spots in a diff and no screenshot test at one viewport catches, and it is why
 *   this is measured rather than asserted from the class name.
 *
 * RED 4 — a SECOND element given `data-testid="desktop-only-notice"`, on `mobile-360`:
 *     > /en/admin/roles rendered 2 desktop-only notices; the contract is exactly one, in
 *     > every project, because the suppression is CSS and not a conditional render.
 *     Expected 1, received 2.
 *   The same break also turns `DesktopOnlyNotice.test.tsx`'s repo guard red
 *   ("production elements carrying the testid: expected 2 to be 1"), which is deliberate
 *   overlap: one catches it without a browser, in a second, and the other catches the case
 *   where the duplicate is produced at runtime rather than written in the source.
 *
 * All four went green again on restore.
 */

/** Matches `crawl-mobile.spec.ts`, `safe-area.mobile.spec.ts` and `scroll-lock.mobile.spec.ts`. */
// VeloExpense: no locale segment in a path, so ExpenseOS's `const LOCALE = 'en'` is gone.

/**
 * The route under test, and the reason it is this one.
 *
 * `/admin/roles` is `mobileReadiness.ts`'s only `desktop` row. It is not module-gated, so
 * unlike `/netsuite/*` and `/admin/assistant-feedback` it answers 200 on a stock seed for the
 * admin session in `e2e/.auth/user.json` — which is what lets the notice branch be exercised
 * at all rather than asserted about a 404.
 */
const GATED = '/admin/roles';

/**
 * A route that is NOT ruled `desktop`. Every assertion about the notice must be NEGATIVE
 * here, in every project — that is what separates "a gate" from "a notice on every page".
 *
 * It is ruled, and that is now the stronger half of the claim rather than an accident.
 * `/dashboard` was UNRULED when this constant was written, so the negative was being proved
 * against a route the registry had never heard of — which cannot tell "the notice keys on
 * `desktop`" apart from the much weaker "the notice keys on being listed at all". P02 ruled
 * this route `limited`, so the route now HAS a registry row, `dispositionFor` returns it,
 * and the notice still has to stay away. That is the claim worth holding: a route not ruled
 * `desktop` is structurally untouched by this feature.
 */
const NOT_DESKTOP = '/dashboard';

/** The one definition lives with the helper that steps past it; this file is its other
 *  caller and uses the same string rather than a second copy of it. */
const NOTICE = DESKTOP_NOTICE_SELECTOR;
const CONTENT = '[data-testid="desktop-only-content"]';
const FOCUS_ANCHOR = '[data-testid="desktop-only-focus-anchor"]';
const MAIN = 'main#main-content';

/**
 * `PHONE_PROJECTS` — the projects below the `lg` breakpoint — is IMPORTED, never restated.
 *
 * It was a hand-kept copy here until P02, under a comment promising that a third phone
 * project added to `playwright.config.ts` and not added here would "fail the guard rather
 * than pass quietly". There was no such guard, and this was the copy where the mistake was
 * SILENT rather than loud: `expectsNotice()` returns `false` for an unlisted project, so a
 * new phone project would assert the DESKTOP half of every test below — notice absent, page
 * rendered — at a phone width, and pass. `scripts/check-phone-projects.mjs` is the guard
 * that comment was promising, and it now refuses any restatement of the list in this file.
 */

/** Tailwind's `lg`, in CSS pixels. The one number this whole feature turns on. */
const LG_BREAKPOINT_PX = 1024;

function expectsNotice(testInfo: TestInfo): boolean {
  return (PHONE_PROJECTS as readonly string[]).includes(testInfo.project.name);
}

/**
 * THE GUARD. Is this project actually on the side of `lg` it claims to be on?
 *
 * Read in the page with `matchMedia`, not from the project config, because the config states
 * an intent and this states an outcome. A viewport that silently failed to apply — or a `lg`
 * breakpoint changed in the design system — turns every assertion below into a statement
 * about the wrong side of the line, and each one would fail with a message about the notice.
 */
async function assertBreakpointEmulation(page: Page, testInfo: TestInfo): Promise<void> {
  const seen = await page.evaluate(
    (px) => ({
      innerWidth: window.innerWidth,
      atLeastLg: window.matchMedia(`(min-width: ${px}px)`).matches,
    }),
    LG_BREAKPOINT_PX,
  );
  const shouldBeBelowLg = expectsNotice(testInfo);
  expect(
    seen.atLeastLg,
    `${testInfo.project.name} reports innerWidth ${seen.innerWidth} and ` +
      `(min-width: ${LG_BREAKPOINT_PX}px) = ${seen.atLeastLg}. This project is supposed to be ` +
      `${shouldBeBelowLg ? 'BELOW' : 'AT OR ABOVE'} lg. The viewport emulation or the ` +
      `breakpoint moved — look at playwright.config.ts, not at DesktopOnlyNotice.tsx.`,
  ).toBe(!shouldBeBelowLg);
}

/**
 * What the notice and the page are doing right now, as one reading.
 *
 * `laidOutContent` is the honest form of "the page is not showing": a count of descendants of
 * the content wrapper that have at least one client rect. `display: none` gives every
 * descendant zero rects, so the count is zero; `display: contents` gives the children their
 * own boxes back and the count is large. It is preferred over a `toBeVisible()` on the wrapper
 * for a specific reason — Playwright's visibility is "has a non-empty bounding box", and a
 * `display: contents` element has NO box of its own, so a visible page reads as an invisible
 * wrapper and the obvious assertion is backwards.
 */
async function readState(page: Page) {
  return page.evaluate(
    ({ notice, content }) => {
      const n = document.querySelector(notice);
      const c = document.querySelector(content);
      return {
        noticeCount: document.querySelectorAll(notice).length,
        noticeDisplay: n === null ? null : getComputedStyle(n).display,
        noticeRects: n === null ? 0 : n.getClientRects().length,
        contentPresent: c !== null,
        contentDisplay: c === null ? null : getComputedStyle(c).display,
        laidOutContent:
          c === null
            ? 0
            : [...c.querySelectorAll('*')].filter((e) => e.getClientRects().length > 0).length,
      };
    },
    { notice: NOTICE, content: CONTENT },
  );
}

/** Land on a route with the shell settled enough to measure. `domcontentloaded` plus a
 *  `main` wait rather than `networkidle`, which never arrives on a page holding a live query. */
async function open(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(MAIN), `${route} did not render the app shell`).toHaveCount(1);
}

test.describe('the desktop-only notice', () => {
  test('shows on the ruled route below lg, and the page instead at lg', async ({
    page,
  }, testInfo) => {
    await open(page, GATED);
    await assertBreakpointEmulation(page, testInfo);
    const state = await readState(page);

    // Present in the DOM in EVERY project — that is the mechanism. What differs is whether
    // it has a box.
    expect(
      state.noticeCount,
      `${GATED} rendered ${state.noticeCount} desktop-only notices; the contract is exactly one, ` +
        `in every project, because the suppression is CSS and not a conditional render`,
    ).toBe(1);
    expect(state.contentPresent, `${GATED} rendered no content wrapper`).toBe(true);

    if (expectsNotice(testInfo)) {
      expect(
        state.noticeDisplay,
        `the notice is not laid out at ${testInfo.project.name}`,
      ).not.toBe('none');
      expect(state.noticeRects).toBeGreaterThan(0);
      expect(state.contentDisplay, `the page is not suppressed at ${testInfo.project.name}`).toBe(
        'none',
      );
      expect(
        state.laidOutContent,
        `${GATED} rendered ${state.laidOutContent} laid-out elements of page content behind ` +
          `the notice at ${testInfo.project.name}; the contract is none`,
      ).toBe(0);
    } else {
      expect(
        state.noticeDisplay,
        `${GATED} rendered a VISIBLE desktop-only notice at ${testInfo.project.name} — the ` +
          `suppression is unconditional, not a gate`,
      ).toBe('none');
      expect(state.noticeRects).toBe(0);
      expect(state.contentDisplay).toBe('contents');
      expect(
        state.laidOutContent,
        `${GATED} rendered no page content at ${testInfo.project.name}, where the page is ` +
          `supposed to be the whole point`,
      ).toBeGreaterThan(10);
    }
  });

  test('renders no notice at all on a route not ruled `desktop`, in every project', async ({
    page,
  }, testInfo) => {
    /**
     * The negative that keeps the positive honest. A component that renders its notice
     * unconditionally passes every phone assertion above and takes the whole product away on
     * a phone; this is the only test that fails it. The wrapper's ABSENCE is asserted too —
     * 51 of 52 routes must come out of this feature structurally untouched, `limited` and
     * `ready` rows included — `dispositionFor` answering for a route is not the trigger,
     * answering `desktop` is.
     */
    await open(page, NOT_DESKTOP);
    await assertBreakpointEmulation(page, testInfo);
    const state = await readState(page);
    expect(
      state.noticeCount,
      `${NOT_DESKTOP} is ruled \`limited\`, not \`desktop\`, and rendered a desktop-only ` +
        `notice at ${testInfo.project.name}. The suppression must key on \`desktop\` alone.`,
    ).toBe(0);
    expect(
      state.contentPresent,
      `${NOT_DESKTOP} is ruled \`limited\` and was wrapped anyway — every route not ruled ` +
        '`desktop` must come out of this feature structurally untouched',
    ).toBe(false);
    expect(await page.locator(MAIN).evaluate((el) => el.children.length)).toBeGreaterThan(0);
  });

  test('introduces no horizontal overflow while it is showing', async ({ page }, testInfo) => {
    /**
     * The gate the architect established `display: none` does not skip.
     *
     * `crawl-mobile.spec.ts` deliberately SKIPS its overflow assertion for a route classified
     * `desktop-notice` — there is no phone layout to measure, by design. That leaves the
     * notice's OWN layout ungated everywhere, and a notice that itself overflows at 360 is a
     * horizontal scrollbar on the one screen the whole feature exists to make usable. So it
     * is measured here, where the notice is the only thing in `main`.
     */
    test.skip(!expectsNotice(testInfo), 'the notice has no layout at 1280; nothing to measure');
    await open(page, GATED);
    await assertBreakpointEmulation(page, testInfo);
    await expect(page.locator(NOTICE)).toBeVisible();
    const box = await page.locator(MAIN).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      box.scrollWidth - box.clientWidth,
      `the desktop-only notice overflows main by ${box.scrollWidth - box.clientWidth}px at ` +
        `${testInfo.project.name} (scrollWidth ${box.scrollWidth}, clientWidth ${box.clientWidth})`,
    ).toBe(0);
  });
});

/**
 * The project guards live in the test BODIES rather than in a `beforeEach`.
 *
 * Playwright requires a destructuring pattern for a hook's first argument, so the guard would
 * have to be written `({}, testInfo) => …`, and Biome's `noEmptyPattern` refuses an empty one.
 * Naming a fixture just to satisfy both would instantiate a browser page for a hook that only
 * reads a project name. One line at the top of each test is cheaper and says the same thing.
 */
const CLICK_IS_MEANINGLESS_AT_LG =
  'the control is display:none at 1280; clicking it would be forcing a click on a control no ' +
  'reader can reach, which asserts nothing about the product';

test.describe('Continue anyway', () => {
  test('reveals the page, unmounts the notice, and survives a reload in the same session', async ({
    page,
  }, testInfo) => {
    test.skip(!expectsNotice(testInfo), CLICK_IS_MEANINGLESS_AT_LG);
    await open(page, GATED);
    await assertBreakpointEmulation(page, testInfo);
    await expect(page.locator(NOTICE)).toBeVisible();
    await stepPastDesktopNotice(page, { expect: 'present' });

    // UNMOUNTED, not hidden. `crawl-mobile.spec.ts` fails a notice that is present-but-hidden,
    // and a hidden-but-mounted notice keeps its heading and both controls in the tab order
    // above the page the reader just asked for.
    await expect(
      page.locator(NOTICE),
      'Continue anyway must UNMOUNT the notice, not hide it',
    ).toHaveCount(0);

    const after = await readState(page);
    expect(after.contentDisplay).toBe('contents');
    expect(
      after.laidOutContent,
      'Continue anyway revealed a wrapper with nothing laid out inside it',
    ).toBeGreaterThan(10);

    /**
     * Focus lands INSIDE the content container rather than falling back to `<body>`.
     *
     * On the `sr-only` anchor that is the wrapper's first child, and NOT on the wrapper
     * itself — measured during this build: an element at `display: contents` generates no box
     * and Chromium 148 refuses to focus it even with `tabIndex={-1}` (`activeElement` stayed
     * `<body>`). `contents` is not negotiable, because it is what makes the desktop layout
     * byte-identical, so the focus target is an out-of-flow one-pixel element instead.
     */
    const focus = await page.evaluate(
      ({ anchor, content }) => {
        const a = document.querySelector(anchor);
        const c = document.querySelector(content);
        return {
          anchorPresent: a !== null,
          onAnchor: a !== null && document.activeElement === a,
          insideContent: c?.contains(document.activeElement) ?? false,
          activeTag: document.activeElement?.tagName ?? null,
        };
      },
      { anchor: FOCUS_ANCHOR, content: CONTENT },
    );
    expect(focus.anchorPresent, 'no focus anchor was rendered after Continue anyway').toBe(true);
    expect(
      focus.onAnchor,
      `focus did not move into the content after Continue anyway — activeElement is ${focus.activeTag}`,
    ).toBe(true);
    expect(focus.insideContent).toBe(true);

    // …and the choice outlives a reload, because it is in sessionStorage under `eos.desktopOk`.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(MAIN)).toHaveCount(1);
    await expect(
      page.locator(NOTICE),
      'the acknowledgement did not survive a reload in the same session',
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => sessionStorage.getItem('eos.desktopOk')),
      'the acknowledgement is stored against the MATCHED PREFIX, not the full path',
    ).toBe(JSON.stringify(['/admin/roles']));
  });

  test('covers every path under the matched prefix', async ({ page }, testInfo) => {
    test.skip(!expectsNotice(testInfo), CLICK_IS_MEANINGLESS_AT_LG);
    await open(page, GATED);
    await assertBreakpointEmulation(page, testInfo);
    await stepPastDesktopNotice(page, { expect: 'present' });
    await expect(page.locator(NOTICE)).toHaveCount(0);

    // A deeper path under `/admin/roles`. It 404s inside the shell — there is no page for it —
    // and that is fine and is the point: what is asserted is that the NOTICE does not
    // reappear, which is a decision about the prefix and not about the leaf.
    await page.goto(`${GATED}/not-a-real-role`, { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator(NOTICE),
      'the choice is keyed on the full path rather than on the matched prefix',
    ).toHaveCount(0);
  });
});

test.describe('the no-flash claim', () => {
  test('layer 1: the server HTML carries both subtrees', async ({ page, request }) => {
    /**
     * Asserted on the RESPONSE BODY, so nothing about the browser is involved. If the notice
     * were client-rendered — a `matchMedia` branch, a `useEffect` — it would be absent here,
     * and the phone would necessarily paint the page first and swap.
     *
     * The `page` fixture is used only to establish the session: the raw request needs the
     * context's cookies, or the route answers a redirect to /login and the body is a login form.
     */
    await open(page, GATED);
    const cookies = await page.context().cookies();
    const jar = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const response = await request.get(GATED, { headers: { cookie: jar } });
    expect(response.status(), `${GATED} did not answer 200 for the stored session`).toBe(200);
    const body = await response.text();

    expect(
      body.includes('data-testid="desktop-only-notice"'),
      'the notice is not in the server HTML — it is being rendered on the client, which ' +
        'means a phone paints the page first and swaps',
    ).toBe(true);
    expect(body.includes('data-testid="desktop-only-content"')).toBe(true);
    // Both subtrees, in one document: the suppression is a class, not an omission. The page's
    // own content is inside the wrapper and therefore also present.
    const noticeAt = body.indexOf('data-testid="desktop-only-notice"');
    const contentAt = body.indexOf('data-testid="desktop-only-content"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(noticeAt);
    expect(
      body.slice(contentAt).length,
      'the content wrapper is the last thing in the document — the page subtree is missing',
    ).toBeGreaterThan(2_000);
    /*
     * The class pair itself, as delivered — `lg:hidden` on one element and `hidden lg:contents`
     * on the other, in the bytes rather than applied later. React emits `data-testid` before
     * `class` here (JSX prop order), and the regexes follow that rather than being order-blind,
     * so a reader debugging a red run can paste them straight into the response body.
     *
     * This layer is BLIND TO CSS: it proves the elements and their classes shipped, and says
     * nothing about what those classes do. Layers 2 and 3 are what close that.
     */
    expect(body).toMatch(/data-testid="desktop-only-notice" class="[^"]*\blg:hidden"/);
    expect(body).toMatch(/data-testid="desktop-only-content" class="hidden lg:contents"/);
  });

  test('layer 2: it works with JavaScript disabled', async ({ browser }, testInfo) => {
    /**
     * A context with `javaScriptEnabled: false` never hydrates. Whatever it shows is what the
     * server sent plus what the stylesheet did, and nothing else — which rules out every
     * mechanism that could produce a flash, because a flash requires a second decision.
     *
     * The context is built by hand rather than taken from the fixture, and every key that
     * matters is carried across from the project: viewport, `isMobile`, `hasTouch`, and the
     * stored session. Missing the session is the silent failure here — the route would 307 to
     * /login and the assertion would be measuring a login page with no notice on it, green
     * in the desktop project and red in the phone ones for entirely the wrong reason.
     */
    const viewport = testInfo.project.use.viewport ?? { width: 1280, height: 720 };
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport,
      isMobile: testInfo.project.use.isMobile,
      hasTouch: testInfo.project.use.hasTouch,
      deviceScaleFactor: testInfo.project.use.deviceScaleFactor,
      // VeloExpense: the admin's session, as every project uses (ExpenseOS: `user.json`).
      storageState: 'e2e/.auth/state.json',
      baseURL: testInfo.project.use.baseURL,
    });
    try {
      const page = await context.newPage();
      await page.goto(GATED, { waitUntil: 'domcontentloaded' });
      await expect(
        page.locator(MAIN),
        'the JS-disabled context did not render the shell — it probably redirected to /login',
      ).toHaveCount(1);

      const state = await readState(page);
      expect(state.noticeCount, 'the notice is not in the server HTML').toBe(1);
      if (expectsNotice(testInfo)) {
        expect(
          state.noticeDisplay,
          'with JavaScript off at a phone viewport the notice must still show — if it does ' +
            'not, the suppression depends on hydration and a real phone flashes the page',
        ).not.toBe('none');
        expect(state.contentDisplay).toBe('none');
        expect(state.laidOutContent).toBe(0);
      } else {
        expect(state.noticeDisplay).toBe('none');
        expect(state.contentDisplay).toBe('contents');
        expect(state.laidOutContent).toBeGreaterThan(10);
      }
    } finally {
      await context.close();
    }
  });

  test('layer 3: the computed styles are already right at the first frame', async ({
    page,
  }, testInfo) => {
    /**
     * A probe installed BEFORE the document exists, resolving on the first
     * `requestAnimationFrame` after `DOMContentLoaded` — the earliest moment at which both
     * elements are guaranteed to be in the tree and styles have been resolved for them.
     *
     * READ THE HEADER BEFORE CITING THIS. It proves the styles were correct at first style
     * resolution. It does NOT prove no earlier frame was presented; nothing available in this
     * pipeline can, and the difference is the whole reason the claim is worded the way it is.
     */
    await page.addInitScript(
      ({ notice, content }) => {
        (window as unknown as { __firstFrame?: Promise<unknown> }).__firstFrame = new Promise(
          (resolve) => {
            const read = () =>
              requestAnimationFrame(() => {
                const n = document.querySelector(notice);
                const c = document.querySelector(content);
                resolve({
                  reached: true,
                  noticeDisplay: n === null ? null : getComputedStyle(n).display,
                  contentDisplay: c === null ? null : getComputedStyle(c).display,
                  // Whether React had already replaced anything by this point. React clears
                  // this attribute on hydration in no version — it is our own marker that the
                  // probe ran before any client-side work could have mattered.
                  readyState: document.readyState,
                });
              });
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', read, { once: true });
            } else {
              read();
            }
          },
        );
      },
      { notice: NOTICE, content: CONTENT },
    );

    await page.goto(GATED, { waitUntil: 'domcontentloaded' });
    await assertBreakpointEmulation(page, testInfo);
    const first = (await page.evaluate(
      () => (window as unknown as { __firstFrame: Promise<unknown> }).__firstFrame,
    )) as {
      reached: boolean;
      noticeDisplay: string | null;
      contentDisplay: string | null;
      readyState: string;
    };

    // The guard on the probe: if it never resolved, or resolved with the elements absent, the
    // assertions below would be about `null` and would read as an app failure.
    expect(first.reached, 'the first-frame probe never ran').toBe(true);
    expect(
      first.noticeDisplay,
      'the notice was not in the tree at the first frame — it is client-rendered',
    ).not.toBeNull();
    expect(first.contentDisplay).not.toBeNull();

    if (expectsNotice(testInfo)) {
      expect(first.noticeDisplay).not.toBe('none');
      expect(
        first.contentDisplay,
        'the page was laid out at the first frame and suppressed afterwards — that is the flash',
      ).toBe('none');
    } else {
      expect(first.noticeDisplay).toBe('none');
      expect(first.contentDisplay).toBe('contents');
    }
  });
});

test.describe('the `contents` wrapper changes no desktop geometry', () => {
  test('removing the wrapper moves nothing, and a block wrapper moves everything', async ({
    page,
  }, testInfo) => {
    test.skip(
      expectsNotice(testInfo),
      'there is no desktop layout to compare below lg — the page is display:none there',
    );
    /**
     * `hidden lg:contents`, and `contents` rather than `block`, is a load-bearing choice:
     * `main#main-content` is `flex flex-1 flex-col` and the page's own root is one of its flex
     * items. A `block` wrapper inserts a box between them, so every `flex-1`, `min-h-0` and
     * `gap` on the page starts resolving against the wrapper instead of against `main`.
     *
     * MEASURED, NOT ASSERTED. Three readings of the same live DOM, in one page:
     *
     *   A. as shipped, with the `display: contents` wrapper in place,
     *   B. with the wrapper REPLACED BY ITS OWN CHILDREN — the tree the page had before this
     *      feature existed — and
     *   C. with the wrapper restored as `display: block`.
     *
     * A must equal B rectangle for rectangle. C must differ, and that third reading is what
     * stops the check passing on a page whose layout is insensitive to all of this.
     */
    await open(page, GATED);
    const result = await page.evaluate((sel) => {
      const wrapper = document.querySelector(sel) as HTMLElement | null;
      if (wrapper === null) return { error: 'no wrapper' as const };
      const kids = [...wrapper.children] as HTMLElement[];
      const tracked = kids.flatMap((k) => [k, ...k.querySelectorAll('*')] as Element[]);
      const snap = () =>
        tracked.map((e) => {
          const r = e.getBoundingClientRect();
          return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        });

      const asShipped = snap();

      // C first, because it is non-destructive and can be undone; B destroys the wrapper.
      wrapper.style.display = 'block';
      void wrapper.offsetHeight;
      const asBlock = snap();
      wrapper.style.display = '';
      void wrapper.offsetHeight;

      const parent = wrapper.parentElement as HTMLElement;
      while (wrapper.firstChild !== null) parent.insertBefore(wrapper.firstChild, wrapper);
      parent.removeChild(wrapper);
      void parent.offsetHeight;
      const unwrapped = snap();

      return { tracked: tracked.length, asShipped, unwrapped, asBlock };
    }, CONTENT);

    expect('error' in result ? result.error : null).toBeNull();
    if ('error' in result) return;

    // The guard on the comparison: a page with two elements in it would make every claim
    // below true and meaningless.
    expect(
      result.tracked,
      'too few elements tracked for the geometry comparison to mean anything',
    ).toBeGreaterThan(20);

    const changed = result.asShipped.filter((r, i) => r !== result.unwrapped[i]).length;
    expect(
      changed,
      `removing the display:contents wrapper moved ${changed} of ${result.tracked} rectangles — ` +
        `the desktop layout is NOT byte-identical`,
    ).toBe(0);

    const movedByBlock = result.asShipped.filter((r, i) => r !== result.asBlock[i]).length;
    expect(
      movedByBlock,
      'a display:block wrapper moved nothing either, so this page cannot tell the two apart ' +
        'and the comparison above proves nothing. Measure a different route.',
    ).toBeGreaterThan(0);
  });
});

/**
 * ─── THE NAV WALK: FOLLOWING THE MENU TO "CONTINUE ANYWAY" ───────────────────────────────
 *
 * NOT RUN ANYWHERE. Read this before reading anything below it as evidence:
 *
 *   Not run anywhere. There are no browser binaries on this machine and TLS blocks the
 *   download; `ci.yml` runs no E2E at all, so a green CI run is not an E2E result; and the
 *   most recent nightly recorded in `tasks/pwa.md` — 2026-09-15, on `main` — died before any
 *   spec (`docker pull` denied for `minio/minio`, exit 125; `ci/e2e-nightly-minio-registry`
 *   is open). They are written, committed, and unexecuted.
 *
 * Unlike every RED above, which was watched, these two cases have been watched neither fail
 * nor pass. They are here because the claim they make is the one claim no unit test in this
 * repo can make, and leaving it unwritten until somebody has a browser would mean losing it.
 *
 * ─── WHAT THE CLAIM IS ───────────────────────────────────────────────────────────────────
 *
 * Everything above this line is about a reader who ALREADY ARRIVED at a `desktop`-ruled
 * route. The notice and its "Continue anyway" always worked for them. What did not work is
 * getting there: below `lg` the nav removed the link BEFORE the reader could reach the route
 * that would have offered them the escape hatch. `Sidebar.test.tsx` now pins that the hidden
 * rows carry a per-section disclosure and that activating it strips `max-lg:hidden` from
 * them — but jsdom resolves no media query and paints nothing, so it can say the class
 * changed and can say nothing about a reader seeing, reaching or tapping the row. That
 * remaining half is a browser claim, and this is where it lives.
 *
 * ─── WHY BOTH HALVES, AGAIN ──────────────────────────────────────────────────────────────
 *
 * Same argument as the file header, one layer up. "The phone reader can reveal ADMINISTRATION
 * and tap through" is satisfied by a build that simply stopped hiding anything — one that
 * deleted `max-lg:hidden` from the nav rows outright, or wired the disclosure to a class with
 * no `lg` upper bound. The desktop half is what refuses that build: at 1280 the control must
 * have NO BOX AT ALL and every ADMINISTRATION destination must already be one click away
 * without it. A phone-only spec passes on a build that broke the desktop nav, which is why
 * `desktop-notice.spec.ts` is still the right file for this and a new `*.mobile.spec.ts`
 * would have been the wrong one.
 *
 * ─── SELECTORS: ROLE AND ACCESSIBLE NAME, SCOPED TO THE SECTION ──────────────────────────
 *
 * There is deliberately no `id`, no `aria-controls` and no `data-testid` on any of this — the
 * revealed rows are interleaved siblings of rows that were always visible, so the only thing
 * an idref could point at is the wrapper the same change deleted, and `Sidebar.test.tsx` has
 * an executable case asserting that none of those attributes appears anywhere in the sidebar.
 * So this walk queries the way a reader perceives it: the section by its heading text, and
 * the control by its role and its own accessible name, scoped inside that section. Scoping is
 * not fastidiousness — six sections lose something for a reader who sees everything, so the
 * six controls' accessible names collide, and an unscoped `getByRole('button')` finds the
 * wrong one.
 *
 * ─── THE COUNT IS ASSERTED AS A PATTERN, AND THEN AGAINST ITSELF ─────────────────────────
 *
 * `nav.sectionHiddenToggle` renders "Show N more pages" where N is what THIS reader lost in
 * THIS section — post-RBAC, post-module, post-registry (ADR-0005 D7). It is therefore a
 * property of the seeded session in `e2e/.auth/user.json`, not of the product, and no figure
 * measured in a unit fixture is a prediction of it. `Sidebar.test.tsx` measured 14 for
 * ADMINISTRATION for a fixture that sees EVERYTHING; the e2e session is a seeded admin whose
 * effective permissions and active modules are a database fact this file cannot read without
 * a database. Hardcoding 14 here would be inventing a number, and a red on it would say
 * "the seed changed" while reading as "the disclosure broke".
 *
 * So the number is never asserted. What is asserted is stronger than a literal anyway: the
 * count the control STATES equals the number of rows that are actually suppressed, and equals
 * the number the tap actually reveals. A control that says "Show 3 more pages" and reveals
 * seven fails here; a control that says the truth fails on no seed. If a later reader wants
 * the literal, measure it against the seed first — do not copy one out of `Sidebar.test.tsx`.
 */

/** The nav landmark that a reader can actually see. Below `lg` the persistent copy is
 *  `display: none` and the off-canvas copy exists only while the drawer is open, so both
 *  projects' "the nav" is this one selector and the `:visible` is what distinguishes them.
 *  Matches `scroll-lock.mobile.spec.ts`'s `OPEN_NAV`. */
const VISIBLE_NAV = 'aside[aria-label]:visible';

/** `nav.sections.administration` in the EN catalog. The section the plan names, because it is
 *  the one that loses `/admin/roles` — the route every other test in this file is about. */
const ADMINISTRATION = 'ADMINISTRATION';

/** `nav.items.roleBuilder` in the EN catalog: the row that leads to `GATED`. */
const ROLE_BUILDER = 'Role Builder';

/** `nav.openMenu`. The same literal `scroll-lock.mobile.spec.ts` and `safe-area.mobile.spec.ts`
 *  use, and resolving it is itself a check that the catalog still answers for the key. */
const OPEN_MENU = 'Open menu';

/**
 * "Show N more pages" / "Show 1 more page", the collapsed half of `nav.sectionHiddenToggle`.
 *
 * Anchored at both ends so "Show fewer" — the expanded half — cannot satisfy it, and so a
 * label that grew a suffix is a failure rather than a substring match. The digits are
 * captured, never asserted; see the header.
 */
const SHOW_MORE = /^Show (\d+) more pages?$/;

/** The expanded half of the same key. */
const SHOW_FEWER = /^Show fewer$/;

/**
 * The section with this heading, as the element that CONTAINS the heading.
 *
 * `SidebarSection` renders `<div class="mb-1">` with the heading `<div>` as its first child
 * and the rows and the control after it, so the heading's parent IS the section — the same
 * structural fact `Sidebar.test.tsx`'s `sectionByHeading` asserts on, reached here through
 * `xpath=..` because Playwright has no `parentElement`. Deliberately NOT `div.mb-1`: that is
 * a design-system implementation detail, and a spec that selects on it goes red for a
 * restyle that changed no behaviour.
 *
 * The heading is a `<div>`, not a heading role, so `getByRole('heading')` finds nothing here.
 * That is worth knowing before someone "fixes" this selector.
 */
async function sectionByHeading(page: Page, heading: string): Promise<Locator> {
  const nav = page.locator(VISIBLE_NAV);
  await expect(
    nav,
    `expected exactly one VISIBLE nav landmark. Below lg that means the off-canvas drawer is ` +
      `open; at lg it means the persistent sidebar is mounted and pinned (AppShell.tsx's ` +
      `\`collapsed\` starts false, so a fresh context is pinned).`,
  ).toHaveCount(1);
  const label = nav.getByText(heading, { exact: true });
  await expect(
    label,
    `the ${heading} section is not in the nav this session can see. Either RBAC filtered every ` +
      `item out of it for the e2e user — in which case this walk has no subject and the ` +
      `fixture, not the feature, is what changed — or the section was renamed in ` +
      `packages/i18n/src/catalogs/en/nav.json.`,
  ).toHaveCount(1);
  return label.locator('xpath=..');
}

/**
 * That section's disclosure control. Scoped, because the six controls' names collide.
 *
 * `includeHidden: true`, AND IT IS NOT A LOOSENING — the same reasoning `e2e/dashboard.spec.ts`
 * already records for its own `includeHidden` use. Playwright's role engine defaults to
 * `includeHidden: false` and drops anything outside the accessibility tree. This helper is
 * called by BOTH halves of the invariant, and the 1280 case exists precisely to assert the
 * control is `lg:hidden` -> `display: none` -> out of the a11y tree. Without this flag that
 * case never reaches its own assertion: it dies here on `toHaveCount(1)` with a message about
 * the section's markup, which is not what failed. The visibility claim is made by
 * `toBeVisible()` / `toBeHidden()` at the call sites, which is where it belongs.
 */
async function controlIn(section: Locator, heading: string): Promise<Locator> {
  const control = section.getByRole('button', { includeHidden: true });
  await expect(
    control,
    `expected exactly one control inside ${heading}. The rows are <a> wrapping a NavLink ` +
      `rendered \`as="div"\`, so the disclosure is the section's only button; more than one ` +
      `means something else in the section became a button and this scope is now ambiguous.`,
  ).toHaveCount(1);
  return control;
}

/** Every nav row in a section, and the ones a reader can actually see right now. */
const rowsIn = (section: Locator): Locator => section.locator('a[href]');
const visibleRowsIn = (section: Locator): Locator => section.locator('a[href]:visible');

test.describe('following the nav to Continue anyway', () => {
  test('a phone reader reveals ADMINISTRATION and taps through to the notice', async ({
    page,
  }, testInfo) => {
    test.skip(
      !expectsNotice(testInfo),
      'the disclosure is lg:hidden at 1280; the desktop half of this claim is the next test',
    );

    // Start where a reader starts, on a route that is NOT ruled `desktop` — so nothing in
    // this walk is reached from a page that was already showing the notice.
    await open(page, NOT_DESKTOP);
    await assertBreakpointEmulation(page, testInfo);

    await page.getByRole('button', { name: OPEN_MENU }).click();
    const section = await sectionByHeading(page, ADMINISTRATION);
    const control = await controlIn(section, ADMINISTRATION);

    /**
     * THE SIGNPOST IS VISIBLE AND IT NAMES A NUMBER. This is done-when 1 at a real viewport:
     * `Sidebar.test.tsx` can say the button is in the DOM with `lg:hidden` on it; only a
     * browser at 390px can say it has a box.
     */
    await expect(
      control,
      `ADMINISTRATION rendered no VISIBLE disclosure at ${testInfo.project.name}. If it is in ` +
        `the DOM but boxless, \`lg:hidden\` is applying below lg — look at the class literal ` +
        `in Sidebar.tsx, not at the registry.`,
    ).toBeVisible();
    await expect(
      control,
      'the control must be collapsed on a fresh mount — the disclosure is a per-visit gesture ' +
        'and nothing is persisted',
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(
      control,
      `the control's accessible name must be the collapsed half of nav.sectionHiddenToggle. A ` +
        `bare key here means the catalog does not answer for it; "Show fewer" means the ` +
        `initial state is wrong.`,
    ).toHaveAccessibleName(SHOW_MORE);

    // The stated count, read off the same string the assertion above matched.
    const label = (await control.textContent())?.trim() ?? '';
    const stated = Number(SHOW_MORE.exec(label)?.[1]);
    expect(stated, `could not read a count out of ${JSON.stringify(label)}`).toBeGreaterThan(0);

    const total = await rowsIn(section).count();
    const visibleBefore = await visibleRowsIn(section).count();
    expect(
      total - visibleBefore,
      `the control says ${stated} but ${total - visibleBefore} of ${total} ADMINISTRATION rows ` +
        `are suppressed at ${testInfo.project.name}. The label counts phone.hidden.size; if the ` +
        `two disagree, the count is being computed off a different set than the one the class ` +
        `is applied from (ADR-0005 D7 — it is per-reader, post-RBAC, post-module).`,
    ).toBe(stated);

    // `includeHidden`, for the reason given on `controlIn` above: this row is asserted
    // hidden immediately below, so it is out of the a11y tree at this moment and the default
    // role query resolves to 0. Without the flag the failure reads "not in this session's
    // ADMINISTRATION section at all", pointing the next reader at RBAC and the seed rather
    // than at this query. The 1280 call site below deliberately does NOT carry this flag:
    // there the row really is visible, and the stricter default is the stronger assertion.
    const roleBuilder = section.getByRole('link', {
      name: ROLE_BUILDER,
      exact: true,
      includeHidden: true,
    });
    await expect(
      roleBuilder,
      `${ROLE_BUILDER} is not in this session's ADMINISTRATION section at all. The nav item ` +
        `requires admin.role.list; if the seeded e2e user lost it, this walk is measuring a ` +
        `fixture change and not the feature.`,
    ).toHaveCount(1);
    await expect(
      roleBuilder,
      'the whole point: /admin/roles is ruled `desktop`, so before the disclosure is used it ' +
        'must have no box below lg. A visible row here means the gate is gone, not that the ' +
        'discoverability problem is fixed.',
    ).toBeHidden();

    // ── The tap. ─────────────────────────────────────────────────────────────────────────
    await control.click();

    await expect(control, 'the control did not re-render expanded').toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(
      control,
      'the accessible name must follow the state — one name that re-renders with ' +
        '`aria-expanded` is why there is no second `aria-label` beside it',
    ).toHaveAccessibleName(SHOW_FEWER);

    const visibleAfter = await visibleRowsIn(section).count();
    expect(
      visibleAfter,
      `the disclosure revealed ${visibleAfter - visibleBefore} rows after promising ${stated}`,
    ).toBe(total);
    expect(visibleAfter - visibleBefore).toBe(stated);
    await expect(
      roleBuilder,
      `${ROLE_BUILDER} is still boxless after the disclosure was opened — the control is a ` +
        'no-op, or it toggles a class with no effect at this width',
    ).toBeVisible();
    await expect(
      roleBuilder,
      'the row must still point at the same destination — JavaScript may toggle a suppression ' +
        'class and nothing else about a nav item',
    ).toHaveAttribute('href', /\/admin\/roles$/);

    // ── Follow it. This is done-when 2, and it is the reason this file was appended to. ───
    await roleBuilder.click();
    await page.waitForURL(/\/admin\/roles$/);
    await expect(page.locator(MAIN), 'the app shell did not render after the tap').toHaveCount(1);

    await expect(
      page.locator(NOTICE),
      'a phone reader followed the nav to a `desktop`-ruled route and was not offered the ' +
        'notice. Either the ruling moved, or the reveal navigated somewhere else.',
    ).toBeVisible();

    await stepPastDesktopNotice(page, { expect: 'present' });

    const after = await readState(page);
    expect(after.contentDisplay).toBe('contents');
    expect(
      after.laidOutContent,
      'Continue anyway was reached by following the nav and revealed nothing',
    ).toBeGreaterThan(10);
  });

  test('the desktop nav needs no disclosure: every ADMINISTRATION page is already one click away', async ({
    page,
  }, testInfo) => {
    test.skip(
      expectsNotice(testInfo),
      'this is the 1280 half; below lg the disclosure is supposed to be visible',
    );

    await open(page, NOT_DESKTOP);
    await assertBreakpointEmulation(page, testInfo);

    // No hamburger: at lg the persistent sidebar is mounted and pinned, and needing to open
    // anything to reach ADMINISTRATION would itself be the regression this test exists for.
    const section = await sectionByHeading(page, ADMINISTRATION);
    const control = await controlIn(section, ADMINISTRATION);

    /**
     * PRESENT, AND BOXLESS. Present because the mechanism is CSS and not a conditional render
     * — the same reason the notice itself is in the server HTML in every project. Boxless
     * because `lg:hidden` is the whole of what keeps the desktop nav identical to what it was
     * before this feature existed: no extra control, no extra tab stop, no extra line.
     */
    await expect(
      control,
      `the disclosure has a box at ${testInfo.project.name}. It is \`lg:hidden\`; a visible ` +
        'control here is an extra tab stop in the desktop nav and a signpost pointing at ' +
        'pages that are already on screen.',
    ).toBeHidden();

    const total = await rowsIn(section).count();
    const visible = await visibleRowsIn(section).count();
    expect(
      total,
      'ADMINISTRATION rendered too few rows for this comparison to mean anything',
    ).toBeGreaterThan(1);
    expect(
      visible,
      `${total - visible} of ${total} ADMINISTRATION rows are suppressed at ` +
        `${testInfo.project.name}. \`max-lg:hidden\` compiles to ` +
        `\`@media (width < 64rem)\`, so nothing it is on may have any effect here — a ` +
        `suppression that reaches 1280 has lost its upper bound.`,
    ).toBe(total);

    const roleBuilder = section.getByRole('link', { name: ROLE_BUILDER, exact: true });
    await expect(roleBuilder).toBeVisible();
    await roleBuilder.click();
    await page.waitForURL(/\/admin\/roles$/);
    await expect(page.locator(MAIN)).toHaveCount(1);

    // The desktop reader followed the same row and must land on the PAGE, with no notice and
    // nothing to dismiss. This is the assertion that fails on a build which "fixed" the phone
    // by showing everyone the notice.
    await expect(
      page.locator(`${NOTICE}:visible`),
      `following ADMINISTRATION → ${ROLE_BUILDER} at ${testInfo.project.name} produced a ` +
        'visible desktop-only notice. The gate is unconditional, not a gate.',
    ).toHaveCount(0);

    const state = await readState(page);
    expect(state.contentDisplay).toBe('contents');
    expect(
      state.laidOutContent,
      'the desktop reader followed the nav to /admin/roles and got no page',
    ).toBeGreaterThan(10);
  });
});

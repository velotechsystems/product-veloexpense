import { expect, test } from '@playwright/test';
import { assertFinePointer, assertProject, censusOf } from './support/tap-targets';

/*
 * VeloExpense: ExpenseOS's `e2e/tap-targets-desktop.spec.ts` (1e682dd6), ported with the
 * phone projects (phone e2e 2). Claims 1 and 3 — the pointer is fine, and no tap-slop
 * `::after` exists under it — are ExpenseOS's, unchanged. CLAIM 2 AND ITS COROLLARY ARE NOT
 * HERE YET: their subject is an `xs` Button carrying `einc-tap-slop`, and VeloExpense's
 * screens use lib-ui-kit's Button, whose sizes carry no slop class (the gap the phone spec
 * pins on `/expenses`' Export). They come back with the kit change that gives the kit Button
 * ExpenseOS's slop classes. The route is `/dashboard` rather than `/users`, which VeloExpense
 * does not have as ExpenseOS's screen; the shell's hamburger is slopped there, and — as the
 * header below notes of ExpenseOS's run — it is checked although it is 0x0 at 1280, because
 * the rule is global.
 */

/**
 * The fine-pointer half of the tap-target claim: under a mouse the slop does not exist.
 *
 * ─── WHY THIS IS A SEPARATE FILE, AND WHY IT IS NOT `*.mobile` ───────────────────────────
 *
 * Done-when 5 has two halves that cannot share a file. The coarse half needs a project with
 * `hasTouch: true`; this half needs one without. `playwright.config.ts` decides that by
 * FILENAME — `*.mobile.spec.ts` is in `PHONE_ONLY_SPEC_PATTERNS`, which is both the phone
 * projects' `testMatch` and `chromium`'s `testIgnore` — so a single file could only ever run
 * on one side of the media query. This one is deliberately NOT named `*.mobile`, which drops
 * it into `chromium`'s default `.*\.spec\.ts$` bucket and nowhere else. No config change was
 * needed for either file, and none was made; the config's own spec-list note already
 * anticipates this filename.
 *
 * ─── THE THREE CLAIMS, AND WHICH ONE IS LOAD-BEARING ─────────────────────────────────────
 *
 *   1. The primary pointer is FINE. Everything below is about a build where the pseudo-element
 *      should not exist, and that is only meaningful if the engine agrees it is not a phone.
 *   2. An `xs` button still measures 28px. The slop changes no painted pixel — adding these
 *      classes did not resize anything, in either pointer mode.
 *   3. `getComputedStyle(el, '::after').content` is `none` on every control carrying a slop
 *      class.
 *
 * THE THIRD IS THE ONE THAT EARNS THE FILE. Claim 2 cannot see the failure that matters here:
 * the `::after` is `position: absolute`, paints nothing, and has no layout effect on its
 * originating element, so a rule accidentally written OUTSIDE `@media (pointer: coarse)` would
 * leave the `xs` button measuring exactly 28px and claim 2 green — while every mouse user got
 * an invisible 44px hit region overhanging their dense toolbars, stealing clicks from
 * neighbours that a phone layout has room for and a desktop one does not. A box measurement is
 * structurally blind to it. Reading `content` is not.
 *
 * Claim 3 also checks `position`, in the same breath rather than as a fourth claim, because it
 * is the same fact: `globals.css` puts `position: relative` INSIDE the media query too, so a
 * correctly-gated rule leaves the control `static` under a mouse. If `content` were `none` but
 * `position` were `relative`, half the rule escaped the media query and the other half did not.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH ─────────────────────────────────────────────────
 *
 * IT SAYS NOTHING ABOUT WHETHER THE SLOP WORKS. That is `e2e/tap-targets.mobile.spec.ts`, and
 * the two files are inverses on purpose: a build with the rule deleted outright passes THIS
 * file completely. Neither half is a gate on its own.
 *
 * IT IS EN-ONLY, for the reason set out at length in the mobile spec's header — a named bias,
 * and one pointing the dangerous way, since FR-CA's longer strings are the likelier trigger for
 * the overlap this pair of files exists to catch.
 *
 * IT DOES NOT COVER A HYBRID DEVICE. `(pointer: coarse)` is the PRIMARY pointer. A laptop with
 * a touchscreen reports `fine` primary and `coarse` for `any-pointer`, so it gets the desktop
 * behaviour asserted here and no slop. Whether that is the right product answer is a design
 * question nobody has asked yet; this file pins what the code currently does rather than
 * claiming it is correct.
 *
 * ─── FALSIFICATION: OBSERVED, NOT ASSUMED ────────────────────────────────────────────────
 *
 * RED — the media query neutralised in `packages/design-system/src/globals.css`
 * (`@media (pointer: coarse)` changed to `@media (min-width: 1px)`, the rules inside left
 * exactly as they are, which is the smallest possible spelling of "someone wrote this rule
 * without the media query"). Run in `chromium`:
 *     > the tap-slop ::after EXISTS under a fine pointer on einc-tap-slop-both "Open menu"
 *     > (0x0): content is """" and position is "relative", both of which should be inert
 *     > outside `@media (pointer: coarse)`.
 *     Expected "none", received "\"\"".
 *
 *   CLAIM 2 STAYED GREEN IN THAT RUN. The `xs` button still measured exactly 28px, because an
 *   absolutely positioned pseudo-element does not resize its originator. That is the pairing
 *   the file exists for, and it is why claim 2 asserts only the box and everything derived
 *   from the pseudo-element sits below claim 3.
 *
 *   `e2e/tap-targets.mobile.spec.ts` ALSO STAYED GREEN in the same broken build, in both phone
 *   projects — on a phone an ungated rule behaves identically to a gated one. Neither phone
 *   project can see this regression at all. That is the whole reason this file exists.
 *
 *   The control named in the message is 0x0 because the shell's hamburger is `lg:hidden` at
 *   1280. It is still checked, and deliberately: the rule is global, so its leaking is a fact
 *   about the stylesheet rather than about what happens to be on screen.
 *
 *   Restored and re-run green.
 */

/** Matches every other spec in this group. See the EN-only note in the header. */
// VeloExpense: no locale segment in a path, so ExpenseOS's `LOCALE` constant is gone.

/**
 * `/users` — the same route the mobile spec uses for its `xs` lane, and for the same reason:
 * `ViewsBar` renders the product's shortest slopped control here (`Button size="xs"`, `h-7`),
 * which is the one whose slop-to-box ratio is largest and therefore the one where an
 * ungated rule would do the most damage. Sharing the route with the mobile spec is
 * deliberate — the two files then make inverse claims about the same controls.
 */
// VeloExpense: `/dashboard` (see the note at the top).
const ROUTE = '/dashboard';

test.describe('tap targets, fine pointer', () => {
  test('the slop does not exist under a mouse', async ({ page }, testInfo) => {
    // Fails in ~0ms rather than after a navigation, and names the project.
    assertProject(testInfo, ['chromium']);

    const response = await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `GET ${ROUTE} did not answer 200`).toBe(200);
    await page.waitForLoadState('networkidle');

    const census = await censusOf(page);

    // ── Claim 1: the primary pointer is fine. ─────────────────────────────────────────
    await assertFinePointer(page, census);
    expect(
      census.fine,
      'the `chromium` project does not report a FINE primary pointer. The project moved, or a ' +
        'root-level `use` grew a touch option — see playwright.config.ts. Nothing about the app ' +
        'is implicated.',
    ).toBe(true);

    // VeloExpense: claim 2 is not here yet — see the note at the top.
    const slopped = await page.locator('.einc-tap-slop, .einc-tap-slop-both').all();
    expect(
      slopped.length,
      `${ROUTE} rendered no control carrying a tap-slop class at 1280, so claim 3 has no ` +
        'subject and this file would pass vacuously. The shell renders its hamburger with ' +
        '`einc-tap-slop-both` on every route (hidden at `lg`, still in the DOM).',
    ).toBeGreaterThan(0);

    /**
     * ── Claim 3: the ::after does not exist. The one the box measurement cannot make. ──
     *
     * ORDER MATTERS HERE, and it is the point of the file rather than a detail. Claim 2 above
     * asserts only the BOX, and in the falsification run — the media query neutralised, the
     * rules otherwise untouched — claim 2 stayed green while this went red. That pairing is
     * the argument. Anything derived from the pseudo-element belongs below this line, so that
     * the first thing a reader sees in a red run is `content`, and so that "the box
     * measurement could not see it" stays a demonstrated fact rather than a claim in a comment.
     */
    for (const handle of slopped) {
      const read = await handle.evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        return {
          content: after.content,
          position: getComputedStyle(el).position,
          label: (el.getAttribute('aria-label') || (el.textContent || '').trim()).slice(0, 40),
          cls: el.classList.contains('einc-tap-slop-both') ? 'einc-tap-slop-both' : 'einc-tap-slop',
          h: Math.round(el.getBoundingClientRect().height),
          w: Math.round(el.getBoundingClientRect().width * 100) / 100,
          // Does the control POSITION ITSELF, independently of the slop rule? The position
          // half of claim 3 has nothing to say about one that does.
          ownPositioning: ['relative', 'absolute', 'fixed', 'sticky'].some((p) =>
            el.classList.contains(p),
          ),
        };
      });
      const where = `${read.cls} "${read.label}" (${read.w}x${read.h})`;
      expect(
        read.content,
        `the tap-slop ::after EXISTS under a fine pointer on ${where}: content is ` +
          `"${read.content}" and position is "${read.position}", both of which should be inert ` +
          'outside `@media (pointer: coarse)`. A rule was written without the media query, or ' +
          'the query was widened. THE BOX MEASUREMENT CANNOT SEE THIS — the control is still ' +
          'exactly its design size, because an absolutely positioned pseudo-element does not ' +
          'resize its originator — so this assertion is the only thing standing between a mouse ' +
          'user and an invisible 44px hit region overhanging every dense toolbar in the product.',
      ).toBe('none');
      /**
       * The position half of claim 3, and it is narrower than it first looks.
       *
       * `globals.css` puts `position: relative` inside the same `@media (pointer: coarse)`
       * block as the `::after`, so a correctly gated rule leaves a control `static` under a
       * mouse — a second, independent witness that the media query is doing its job, and one
       * that would still fire if `content` were somehow reported as `none` on a live rule.
       *
       * But only for controls that do not position THEMSELVES. `NotificationBell.tsx` carries
       * its own `relative` so its unread-count badge has something to anchor to, and that has
       * nothing to do with the slop and must not be read as the rule leaking. The first
       * version of this assertion did not make the distinction and went red on the bell — a
       * false positive with a confidently wrong message, caught by running it.
       *
       * The exemption cannot hide the regression it is next to: `content` above is asserted on
       * EVERY slopped control including the bell, and an ungated rule sets `content` on all of
       * them. This is a corroborating witness losing one of its subjects, not a gap.
       */
      if (!read.ownPositioning) {
        expect(
          read.position,
          `${where} is \`position: ${read.position}\` under a fine pointer, and it declares no ` +
            'positioning utility of its own. `packages/design-system/src/globals.css` puts ' +
            '`position: relative` inside the same `@media (pointer: coarse)` block as the ' +
            '::after, so a correctly gated rule leaves this `static`. Half the rule escaped the ' +
            'media query.',
        ).toBe('static');
      }
    }

    // VeloExpense: the corollary rests on claim 2's subject — see the note at the top.
  });
});

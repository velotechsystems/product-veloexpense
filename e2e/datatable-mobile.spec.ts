import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/actors';
import { seedDraftTrip, seedEmployeeActivity } from './support/seed-activity';
import { closeTestDb } from './support/test-db';
import { reportTag } from './support/workbench';

/**
 * VeloExpense: ExpenseOS's `e2e/datatable-mobile.spec.ts` (1e682dd6), ported with its phone
 * specs. `/expenses`' list and the dashboard's cards are ExpenseOS's, and so is `DataTable`'s
 * card tree. One change, marked where it is made: VeloExpense has no QA activity seed, so
 * `seedEmployeeActivity` builds the rows the tests measure — and, since w6-02 turned travel on
 * for the demo tenant, `seedDraftTrip` the employee's trip, so the dashboard's third
 * `<DataTable>` ("My travel requests") has rows to measure, as ExpenseOS's does.
 *
 * Nothing may paint past the right edge of a phone.
 *
 * ── What this guards, and why it is geometry ────────────────────────────────────────
 *
 * `<DataTable>` grows a second render tree below Tailwind's `md`: the same rows, the same
 * order, the same state, drawn as cards instead of a grid. The promise the epic makes for
 * it is narrow and physical — at 360px and at 390px the page does not scroll sideways —
 * and it is a promise no unit test can keep. jsdom has no layout engine, so every card
 * test in `DataTableCards.test.tsx` asserts roles and class names; whether a card actually
 * fits is a question only a browser can answer.
 *
 * So this file asserts SIZES, never class names. `table-cell-overflow.spec.ts` makes the
 * same argument for the desktop grid and is worth reading: a test that pins "no `truncate`
 * here" passes just as happily on a layout that still overlaps.
 *
 * ── Two widths, and why both ────────────────────────────────────────────────────────
 *
 *   360×800 — the narrow floor the epic committed to. Android's most common logical width
 *             and the width every "does it fit" argument in the plan was made against.
 *   390×844 — iPhone 12/13/14/15. Done-when 1 names this width for `/expenses` by number,
 *             and the device pass in phase 9 runs on exactly it.
 *
 * A layout can pass one and fail the other in both directions: 390 gives a card 30px more
 * to fit a badge on the title's line, and 360 is where a `basis-56` title stops sharing.
 *
 * ── Resizing inside the one chromium project, on purpose ────────────────────────────
 *
 * `page.setViewportSize` rather than a second Playwright project with a device preset.
 * `table-cell-overflow.spec.ts:32` and `topbar-overlap.spec.ts` already do this, and it is
 * what lets this suite stand alone: a project would have to be declared in
 * `playwright.config.js`, which every other spec then runs under too.
 *
 * ── Poll for the ROWS ───────────────────────────────────────────────────────────────
 *
 * The hard-won lesson from `table-cell-overflow.spec.ts`, inherited verbatim. The shell
 * paints its frame before the rows arrive over tRPC, and a sweep that runs against the
 * empty shell finds nothing to measure and passes green over a page that overflows a
 * second later. Every measurement below is gated on real rows being on screen, and on the
 * sweep having actually looked at something.
 *
 * ── T03's DONE-WHEN 3 NO LONGER HAS A TESTABLE SUBJECT, AND THAT IS A DECISION ──────
 *
 * Read this before concluding the fallback claim is untested by oversight.
 *
 * Done-when 3 promised: "a table without [a `mobile` config] falls back to a horizontal
 * scroll container, never overflowing the page." Until this commit the `/dashboard` test
 * below was that claim's only browser-level evidence, because `/dashboard` was the one
 * route in the app mounting `<DataTable>`s that had NOT opted in. The three cards have now
 * opted in. So the fallback branch still exists in `DataTable.tsx` — `layout === 'auto' &&
 * isCompact && mobile.title !== undefined` is still the gate, and a table that names no
 * title still keeps its `<Scroll2D>` — but there is no route left that exercises it, and
 * the claim has real PRODUCTION subjects (every unconfigured `<DataTable>` a future page
 * mounts) and no testable one.
 *
 * The test below was INVERTED rather than deleted or left asserting the old behaviour. What
 * it asserts now is the mirror image: at these widths `/dashboard` renders cards and NO
 * table at all. That is the assertion with a live subject, and it is the one that catches
 * the realistic regression — a `mobile` prop wired to two of the three cards and forgotten
 * on the third, which leaves a table on the page and is invisible to every other gate.
 *
 * WHAT WAS NOT CARRIED OVER, deliberately: the old test's `unreachable` sweep, which walked
 * `document.querySelectorAll('table')` with no route anchor and demanded every wide table
 * have a scrolling ancestor. On a `/dashboard` that renders cards that loop iterates an
 * empty set and passes. A test that cannot fail, sitting where a real gate used to be, is
 * worse than removing the gate honestly — so it is gone, and this paragraph is what stops
 * its absence reading as an oversight. Restoring the fallback's coverage needs a route (or
 * a fixture page) that mounts an unconfigured `<DataTable>` on purpose; that is a task, not
 * an edit to this file.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 180_000 });

/**
 * VeloExpense: the rows ExpenseOS reads out of `qa-activity.json` — the employee's reports for
 * `/expenses` and "My expense reports", and one in the manager's queue for "Reports to
 * approve". Once per worker; every test below stays a read.
 */
test.beforeAll(async ({ browser }) => {
  await seedEmployeeActivity(browser, {
    draftTitle: reportTag('datatable draft'),
    queuedTitle: reportTag('datatable queue'),
  });
  // VeloExpense (w6-02): the employee's trip, so "My travel requests" draws rows (see header).
  await seedDraftTrip(reportTag('Datatable Trip'));
});
test.afterAll(closeTestDb);

/** The two widths the epic committed to. */
const PHONES = [
  { name: '360×800', width: 360, height: 800 },
  { name: '390×844', width: 390, height: 844 },
] as const;

/**
 * Every node painted past the viewport's right edge that nothing is clipping.
 *
 * ── Why the ancestor check ──────────────────────────────────────────────────────────
 *
 * A wide node is not automatically a defect. A table inside a horizontal scroller is
 * SUPPOSED to be wider than the screen — that is what the scroller is for, and the card
 * work deliberately leaves that fallback in place for pages that have not opted in. What
 * must never happen is a wide node with nothing between it and the document, because that
 * is the one that drags the whole page sideways.
 *
 * `auto` and `scroll` clip and offer a scrollbar; `hidden` and `clip` clip without one.
 * All four contain the overflow, so all four end the search. Only a node whose every
 * ancestor is `visible` is reported.
 *
 * 1px of tolerance for sub-pixel rounding, matching the document-level assertion.
 */
async function overflowingNodes(page: Page) {
  return page.evaluate(() => {
    const out: { tag: string; cls: string; right: number; text: string }[] = [];
    const limit = window.innerWidth + 1;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= limit) continue;
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').slice(0, 80),
        right: Math.round(rect.right),
        text: (el.innerText ?? '').replace(/\s+/g, ' ').slice(0, 60),
      });
    }
    return out;
  });
}

/** Assert the page does not scroll sideways, and that nothing escapes unclipped. */
async function expectNoSidewaysScroll(page: Page, where: string) {
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    doc.scrollWidth,
    `${where}: the document scrolls sideways (${doc.scrollWidth} > ${doc.innerWidth})`,
  ).toBeLessThanOrEqual(doc.innerWidth + 1);

  const spills = await overflowingNodes(page);
  expect(
    spills,
    `${where}: painted past the viewport with nothing clipping it:\n${spills
      .map((s) => `  ${s.tag}.${s.cls} right=${s.right}px "${s.text}"`)
      .join('\n')}`,
  ).toEqual([]);
}

/**
 * The sweep-proof and the per-slot containment check, for a page already known to be in card
 * mode.
 *
 * ── Why this is a helper rather than two copies ─────────────────────────────────────
 *
 * `/expenses` and `/dashboard` are now the same claim at two densities — one card list
 * filling the width, and three card lists nested inside `SectionCard`s that are each already
 * narrower than the viewport. They are mirrors, and a mirror that drifts is worse than no
 * mirror: the interesting comparison is "the same measurement, two containers", and that is
 * only true while the measurement is literally the same code. Both bodies were identical
 * before this commit; extracting them is what keeps that a fact instead of a convention.
 *
 * ── The two checks ──────────────────────────────────────────────────────────────────
 *
 * PAINTED — proof the sweep had something to sweep. Without it a test passes on a permission
 * bounce, an empty list, or a renamed route: every way of reaching a page WITHOUT rendering
 * it looks identical to a layout that fits.
 *
 * SLOT SPILLS — every card slot lives inside its card. A field that painted past its own
 * card's right edge is the compact equivalent of a cell running into the next column, and it
 * is invisible to the document-level check whenever the card itself is clipped. This is the
 * highest-value assertion on `/dashboard` specifically: three card lists inside narrow
 * `SectionCard`s at 360 is the tightest box any card list in this app renders into.
 */
async function expectCardSlotsContained(page: Page, where: string) {
  const painted = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('[data-dt-card-slot]')).filter(
        (el) => el.getBoundingClientRect().width > 0,
      ).length,
  );
  expect(painted, `${where}: no card slots were measured`).toBeGreaterThan(0);

  const slotSpills = await page.evaluate(() => {
    const bad: { column: string; spill: number; text: string }[] = [];
    for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[data-dt-card-slot]'))) {
      const card = slot.closest<HTMLElement>('[id^="data-card-"]');
      if (!card) continue;
      const spill = Math.round(
        slot.getBoundingClientRect().right - card.getBoundingClientRect().right,
      );
      if (spill > 2) {
        bad.push({
          column: slot.dataset.dtColumnId ?? '(unknown)',
          spill,
          text: (slot.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40),
        });
      }
    }
    return bad;
  });
  expect(
    slotSpills,
    `${where}: card content painting outside its own card:\n${slotSpills
      .map((s) => `  +${s.spill}px in "${s.column}" — "${s.text}"`)
      .join('\n')}`,
  ).toEqual([]);
}

for (const phone of PHONES) {
  test(`/expenses fits a ${phone.name} phone`, async ({ page }) => {
    await signIn(page, 'employee');
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto('/expenses');

    /**
     * Poll for the CARDS, not for the shell.
     *
     * `#main-content` is the app shell's own landmark and is painted immediately;
     * `data-card-<id>` is minted per row by `DataTableCards`, so its presence is proof the
     * tRPC response landed AND that the compact tree — not the table — is what mounted.
     */
    const cards = page.locator('#main-content [id^="data-card-"]');
    await expect.poll(() => cards.count(), { timeout: 60_000 }).toBeGreaterThan(0);

    await expectNoSidewaysScroll(page, `/expenses at ${phone.name}`);
    await expectCardSlotsContained(page, `/expenses at ${phone.name}`);
  });

  for (const actor of ['employee', 'manager'] as const) {
    test(`/dashboard fits a ${phone.name} phone as ${actor}`, async ({ page }) => {
      /**
       * THE MIRROR OF THE `/expenses` TEST ABOVE, AND THE INVERSE OF WHAT THIS TEST USED TO
       * ASSERT. See the "done-when 3" section of the file header before editing it — the
       * claim this replaced, and why its sweep was deleted rather than carried over, are
       * recorded there rather than here.
       *
       * `/dashboard` mounts three `<DataTable>`s — "Reports to approve", "My expense
       * reports", "My travel requests" — inside `SectionCard`s already narrower than the
       * viewport. All three now pass a `mobile` config, so below the compact breakpoint all
       * three render card lists and the page holds no table at all.
       *
       * ── BOTH ACTORS, BECAUSE NEITHER ONE ALONE SEES ALL THREE CARDS ─────────────────
       *
       * Being gated ON for a card is not the same as having rows in it. All three cards
       * short-circuit to `<SectionEmpty>` before they ever mount `<DataTable>` when
       * `rows.length === 0` (`MyExpenseReportsCard.tsx:279-285`; the two siblings are
       * identical), so a card with no rows renders neither a table nor cards and is
       * invisible to every assertion below. `seed-data/qa-activity.json` seeds its seven
       * expense reports and six travel requests ALL to `qa.employee`, and routes the six
       * approval tasks to `qa.manager`, who owns no report and no trip of its own
       * (`e2e/dashboard.mobile.spec.ts:468-473` states the same split in prose). So the
       * coverage is a union and not a single page:
       *
       *   employee — "My expense reports" and "My travel requests", both with rows. No
       *              approvals card at all: `selectDashboardCards` gates that one on
       *              `expense.report.approve`, which this actor does not hold.
       *   manager  — "Reports to approve", with rows. The two "mine" cards ARE gated on for
       *              this actor and render their empty copy, so they are measured under
       *              `employee` instead.
       *
       * Running both actors is what makes the table count below a claim about three card
       * lists. As one `manager`-only lane it measured exactly one — deleting
       * `mobile={MOBILE}` from `MyTravelRequestsCard` left it green, which is the regression
       * its own failure message says it catches. `e2e/dashboard.mobile.spec.ts` splits its
       * two tests across these same two actors for this same reason.
       */
      await signIn(page, actor);
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.goto('/dashboard');

      // Poll for the CARDS. The `SectionCard` frames and their skeletons paint before the
      // tRPC responses land, and a sweep over a skeleton finds nothing and passes green.
      const cards = page.locator('#main-content [id^="data-card-"]');
      await expect.poll(() => cards.count(), { timeout: 60_000 }).toBeGreaterThan(0);

      /**
       * NO TABLE ANYWHERE, and this is the assertion the test exists for.
       *
       * The poll above is satisfied by ONE card list. This line is what catches the
       * realistic regression: a `mobile` prop wired to two of the three cards and forgotten
       * on the third, which leaves that card rendering its off-screen grid while the page
       * looks finished. Counted over the whole of `#main-content` rather than per card,
       * because the defect is "a table survived somewhere" and naming which card would be a
       * second place to update every time the page's card set changes. What makes it cover
       * all three cards rather than this actor's own is the actor loop, not this line.
       */
      expect(
        await page.locator('#main-content table').count(),
        `/dashboard at ${phone.name} as ${actor}: a table is still rendered below the ` +
          'compact breakpoint. Every card that drew rows is supposed to pass a `mobile` ' +
          'config with a `title` — that is the opt-in `DataTable` gates the card tree on — ' +
          'so one table left standing means one card did not take its config, and its ' +
          'columns are off-screen again. Which cards drew rows here depends on the actor: ' +
          'see the comment at the top of this test.',
      ).toBe(0);

      await expectNoSidewaysScroll(page, `/dashboard at ${phone.name} as ${actor}`);
      await expectCardSlotsContained(page, `/dashboard at ${phone.name} as ${actor}`);
    });
  }
}

test('the compact chrome is reachable by thumb on /expenses', async ({ page }) => {
  /**
   * Done-when 2, measured rather than asserted in jsdom.
   *
   * Cards have no column headers, so sort and filter move into two bottom sheets whose
   * triggers sit above the list. `ExpenseReportsList.test.tsx` pins that they carry
   * catalog keys rather than the design system's English defaults; what only a browser can
   * confirm is the part a thumb cares about — that the rendered boxes are at least 44
   * CSS pixels on both axes, and that the card kebab is too.
   */
  await signIn(page, 'employee');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/expenses');

  const cards = page.locator('#main-content [id^="data-card-"]');
  await expect.poll(() => cards.count(), { timeout: 60_000 }).toBeGreaterThan(0);

  const small = await page.evaluate(() => {
    const undersized: { label: string; w: number; h: number }[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="button"]'),
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      /**
       * Only the compact chrome and the cards are in scope.
       *
       * The toolbar's export and settings buttons, the top bar and the app shell's own
       * controls are all pre-existing and all belong to T04's shared control-size fix.
       * Sweeping them here would fail this phase's spec on somebody else's gap, which is
       * the fastest way to get a guard ignored.
       */
      const inScope =
        el.closest('[id^="data-card-"]') !== null ||
        el.closest('#expenses-mobile-controls') !== null;
      if (!inScope) continue;
      if (r.width < 44 || r.height < 44) {
        undersized.push({
          label: (el.getAttribute('aria-label') ?? el.innerText ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    return undersized;
  });

  expect(
    small,
    `controls below the 44px floor inside the card list:\n${small
      .map((s) => `  ${s.w}×${s.h} "${s.label}"`)
      .join('\n')}`,
  ).toEqual([]);
});

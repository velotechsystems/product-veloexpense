/**
 * VX4-7 part 3 / IL-5 & IL-6 — is this string coming from a catalogue at all?
 *
 * Runs against a server booted with `PSEUDO_LOCALE=1`, so every string that
 * passes through `localizedFrom` or `renderPolicyMessage` comes back bracketed
 * and accented: `⟦Ŝûƀmîttéd⟧`. Text that never went through a catalogue is the
 * only plain English left on the page.
 *
 * `npm run e2e:crawl`, its own config, its own server. See
 * `playwright.pseudo.config.ts` for why it cannot share the normal one.
 *
 * ── WHAT THIS MEASURES, AND THE THING IT MADE VISIBLE ───────────────────────
 *
 * The product's UI CHROME is not localised. Headings, buttons, table columns,
 * empty states — they are English literals in JSX, and nothing in this repo ever
 * claimed otherwise. What was missing was a number: "some of it" is not a state
 * you can hold anybody to.
 *
 * So the assertions here are of two kinds:
 *
 *   1. AN EXACT CHECK on what IS catalogued. Every rendered status badge,
 *      severity badge and error banner must be bracketed on every page. These
 *      are what parts 2a–2c moved into catalogues, and this is the standing
 *      proof that they still go through them on every screen at once — the check
 *      `check:i18n` cannot make, because a badge rendering `row.status` directly
 *      is a valid program.
 *
 *   2. A RATCHET on what is not. The count of un-bracketed strings per page is
 *      measured against `CHROME_CEILING` below. It cannot grow: a new hardcoded
 *      heading fails this file. It is meant to come DOWN as the UI copy is
 *      catalogued (boarded as VX4-10), and the ceiling is meant to be edited
 *      downwards when it does — never upwards without a reason in the diff.
 *
 * A ceiling rather than zero because zero is a lie today and a failing suite is
 * worth less than a measured one. IL-7's lesson applies to this file too: a gate
 * that restates what it polices fails open, so the numbers below are per-page
 * observations, not a global fudge factor.
 */
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE } from './helpers';
import { installCrawlFixture } from './crawl-fixture';
import { PSEUDO_MARKERS } from '@/lib/i18n/pseudo';

const { open: OPEN, close: CLOSE } = PSEUDO_MARKERS;

/**
 * Un-bracketed visible strings each page is currently allowed.
 *
 * Measured, not guessed — the numbers came from the first green run and each is
 * the page's own chrome.
 *
 * AN UPPER BOUND, not an exact match, and the first draft had it the other way
 * round. Exact fails in both directions, which sounded better: cataloguing a
 * heading without lowering the ceiling would be as loud as adding one. Then the
 * crawl was run after a full e2e suite and `/notifications` failed — that page's
 * text count moves with how many notifications exist, and the e2e creates some.
 *
 * A gate that goes red because the suite before it did its job is a gate people
 * disable. This ticket has now landed on that three times (the raw-message check
 * widened to `lib/`, the params regex, and here), so: the bound catches growth,
 * which is the regression worth catching, and the actual count is printed on
 * every run so a drop is visible to anyone reading the output.
 */
/**
 * Where the ratchet measures, when that is not the page itself. See the note in
 * the ratchet test. The nonce matches no title and no EXP number, so the table is
 * empty and the count is chrome plus the empty state — all of it copy.
 */
const RATCHET_PATH: Record<string, string> = {
  '/expenses': '/expenses?q=zzz-no-report-has-this-in-its-title',
};

const CHROME_CEILING: Record<string, number> = {
  // Measured on the filtered, empty table — see RATCHET_PATH above. Was 44 while
  // report rows were being counted, and would have risen with every spec that
  // files one.
  // VX4-10 part 2 catalogued this screen: 19 → 1, measured through RATCHET_PATH's
  // empty-table filter as before. The ONE is the word "VeloExpense" in the shell
  // header — the product's NAME, which no catalogue should hold, because a product
  // name that changes language is a different product. It is this screen's floor
  // and it is on every page under /expenses.
  '/expenses': 1,
  // VX4-10 part 2: 31 → 10, and both numbers need their conditions attached.
  //
  // 31 was with `e2e/crawl-fixture.ts` installed; the ceiling of 15 this replaces
  // was the EMPTY inbox, which is what this screen showed before the fixture
  // existed. The file said such a page needs a RATCHET_PATH or a caveat and this
  // one had neither, so its ceiling passed only while nothing ahead of it left a
  // pending task for the crawl's admin.
  //
  // The 10 is five strings per fixture row, times two rows, and every one is
  // tenant DATA: the report title, its EXP number, the submitter's name, the
  // policy rung's name, and the submitted date. A catalogue holding any of them
  // would be a catalogue holding a customer's own words — VX5-4's argument about
  // starter categories, arriving on a different screen.
  //
  // So this is a floor of `5 × rows`, and the fixture is what fixes `rows` at two
  // no matter what ran first. Change the fixture's row count and change this.
  '/approvals': 10,
  // VX4-10 part 3 catalogued this screen: 30 → 3, and the 42 it replaces was
  // never a measurement of anything. It was taken on a fuller database and passed
  // on the HEADROOM between itself and whatever a given run happened to produce —
  // the note that used to sit here said as much ("STILL DATA-DEPENDENT … the
  // headroom is what keeps it green") and asked for a ticket rather than a clever
  // selector. This is that ticket.
  //
  // No filter empties this screen. `?unread=1` narrows the list and never empties
  // it, and pointing the ratchet at the unread-only view would leave the read-row
  // and everything-empty copy unmeasured — trading one blind spot for two. So it
  // is `e2e/crawl-fixture.ts` that fixes the row count, exactly as for
  // `/approvals`.
  //
  // The 3 is ONE STRING PER ROW: the `Intl` instant in the When column, at
  // `NOTIFICATION_COUNT` rows. Everything else on the screen is catalogued — the
  // chrome by part 3, and the row bodies and their two sub-labels long before it,
  // by `notification-templates` and by `EVENT_TYPE_COPY` /
  // `NOTIFICATION_WORDING_COPY` in `enums.ts`.
  //
  // So: `1 × NOTIFICATION_COUNT`. Change the fixture's count and change this.
  '/notifications': 3,
  // VX4-10 part 1 catalogued this screen: 10 → 1. The ONE that remains is
  // `Mar 4, 2026, 2:30 a.m.` — the formatting sample the page exists to show, and
  // `Intl` output rather than copy. No catalogue will ever contain it.
  //
  // So 1 is this page's FLOOR, not a residue of work left undone, and the reason
  // is worth knowing before somebody tries to reach zero: `visibleStrings` drops
  // purely numeric lines, but a formatted date carries a month name and an "a.m.",
  // so it survives the filter. Widening that filter to catch month names was
  // considered and rejected — it would hide a real heading containing the word
  // "March", which is a worse failure than a ceiling of one.
  //
  // Any page that shows a formatted date has the same irreducible floor.
  '/preferences': 1,
  // VX4-10 part 4 catalogued this screen: 46 → ZERO, and it is the only page in
  // this list that reaches zero. Worth saying why, because "0" invites the same
  // suspicion the other ceilings have earned.
  //
  // A policy ROW contributes no un-catalogued text node at all. Its rule name and
  // description now come from `RULE_KIND_COPY` / `RULE_DESCRIPTION_COPY`; its
  // severity, category and threshold currency are `<select>` contents, which
  // `visibleStrings` skips by design; its threshold and dates are input VALUES,
  // not text; and Save/Delete are catalogued. So unlike `/approvals` (5 × rows)
  // and `/notifications` (1 × rows), this screen's count does not move with its
  // data, and 0 is a property of the page rather than of the database it was
  // measured against.
  //
  // That also means this is the one ceiling here with no per-row term to keep in
  // step with a fixture. If it ever reads 1, something was added — which is what a
  // ratchet is for.
  '/admin/expense-policies': 0,
  // VX4-10 part 2: 19 → 5, and the five are the SAMPLES this screen exists to
  // show — `localeName()` output for two locales, their formatted instants, and a
  // formatted amount. Cataloguing them would defeat the screen: IL-1 is that
  // upstream shipped `en` for years believing it was Canadian because nothing
  // showed them the difference, and what is shown has to be real `Intl` output or
  // it shows nothing.
  '/admin/locale': 5,
  // Measured after VX4-10 part 1 catalogued the screen. See PAGES above.
  // VX4-10 part 2 CORRECTS PART 1'S CEILING, which was wrong and which I shipped.
  //
  // Part 1 measured 0 on a database where no tenant had a subscription, so the
  // whole subscription card had never rendered and two English sentences inside it
  // (`Trial ends …`, `Last confirmed with VeloTech …`) sat behind a ceiling that
  // said the screen was finished. With a subscription present the same page reads
  // 8. Both sentences are now catalogued, and `e2e/crawl-fixture.ts` makes sure
  // that branch is never measured absent again.
  //
  // The 4 that remain are data: the plan's name and its code — the PLATFORM's
  // words, not ours, and the same rule as a tenant's category — and two `Intl`
  // dates in the usage table. The trial and mirror dates that used to be counted
  // are gone from this list because they now sit INSIDE a catalogued sentence and
  // are bracketed with it.
  '/admin/billing': 4,
};

/**
 * 161 un-catalogued strings across six screens — 176 as first measured in part 3,
 * corrected in VX4-8 part 1 when `/expenses` turned out to be counting report
 * titles as though they were copy.
 *
 * That is the number the product's UI chrome was missing. Boarded as VX4-10 —
 * cataloguing it is a bigger job than all three of parts 2a–2c put together
 * (those covered 223 strings of enum labels, violation sentences and refusals;
 * this is every heading, button, column and empty state), and it is a job worth
 * doing deliberately rather than in the tail of a locale ticket.
 *
 * The point of the ceilings is that the number can only go down. It is a
 * measurement now, not "some of it".
 */

/**
 * Every text node a person can read, split into strings worth counting.
 *
 * TWO EXCLUSIONS, both because including them destroys the signal rather than
 * adding to it.
 *
 * `<select>` CONTENTS. `/preferences` and `/admin/locale` came back at 497 and
 * 498 on the first measurement — the IANA timezone list, ~500 `<option>`s from
 * `pg_timezone_names`. Those are DATA, and `America/Vancouver` is not a string
 * anybody translates. Counting them would have made those two pages' ceilings
 * meaningless and every real finding invisible next to them. Option labels that
 * SHOULD be catalogued (a locale name, a severity) are a separate surface and
 * belong to VX4-10 with the rest of the chrome; stated here so the exclusion is
 * a decision rather than a convenience.
 *
 * PURELY NUMERIC LINES. An amount, a date, a count — from `Intl` or from the
 * database. Part 1b and 2b are what make those correct; they are not copy.
 */
async function visibleStrings(page: Page): Promise<string[]> {
  const text: string[] = await page.evaluate(() => {
    const skip = new Set(['SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT']);
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (skip.has(el.tagName)) return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim() ?? '';
        if (t !== '') out.push(t);
        return;
      }
      node.childNodes.forEach(walk);
    };
    walk(document.body);
    return out;
  });
  return text
    .filter((line) => line.length > 1)
    .filter((line) => !/^[\d\s$.,:%/()+-]+$/.test(line));
}

function unbracketed(lines: string[]): string[] {
  return lines.filter((l) => !(l.includes(OPEN) || l.includes(CLOSE)));
}

const PAGES = [
  '/expenses',
  '/approvals',
  '/notifications',
  '/preferences',
  '/admin/expense-policies',
  '/admin/locale',
  // VX4-10. Added with its ceiling measured on the same run that catalogued it,
  // rather than inherited. `/admin/billing` shipped in VX5-11 and was outside
  // this ratchet entirely until now — a screen the gate could not see was a screen
  // whose chrome could grow without anybody noticing.
  '/admin/billing',
] as const;

test.use({ storageState: ADMIN_STATE });

/**
 * VX4-10 part 2. Every ceiling below is measured against this fixture, and is
 * meaningless without it — see `crawl-fixture.ts` for what part 1 got wrong by
 * measuring empty pages, and for the branches this still does not reach.
 */
test.beforeAll(async () => {
  await installCrawlFixture();
});

test.describe('the pseudo-locale crawl', () => {
  test('the server really is in pseudo mode', async ({ page }) => {
    /* THE GUARD ON THE WHOLE FILE. Every other assertion here is about how much
     * text is bracketed; if the flag were off nothing would be bracketed, every
     * "is it catalogued" check would have nothing to compare against, and the
     * ratchet below would read entire pages as chrome and pass. Pointed at a
     * server without the flag, this file must fail loudly rather than measure a
     * fiction.
     *
     * ── IT WAS ASKING THE RIGHT QUESTION OF THE WRONG EVIDENCE ─────────────
     *
     * It used to visit `/expenses` alone and look at `body.innerText()`. On a
     * freshly seeded database that page says "0 reports submitted by you" — the
     * seed creates no reports owned by the admin the e2e signs in as — so every
     * VISIBLE string on it is chrome, and none of it is catalogued. The guard
     * therefore failed on a clean database and passed in CI only because the
     * full Playwright suite runs first and leaves reports, with their catalogued
     * status labels, behind.
     *
     * That is the "assertion that holds only because something else ran first"
     * family `approval-flow.spec.ts` has a note about, and it was worth chasing
     * rather than pinning to a different page: the diagnosis showed the flag was
     * ON the whole time. There was exactly ONE marker in that page's HTML and
     * none in its `innerText` — pseudoized text that `innerText` does not
     * surface. The server was never the problem; the measurement was.
     *
     * ── SO IT ASKS THE DOCUMENT, ACROSS EVERY PAGE ─────────────────────────
     *
     * `page.content()` rather than `innerText`, because the question is about
     * the SERVER and a marker anywhere in what it sent answers it. Across all
     * the crawled pages rather than one, because any single page can be
     * legitimately empty. Both changes are about not letting the presence of
     * DATA decide whether the flag looks set.
     *
     * Note what this deliberately does NOT try to fix: the ratchet below still
     * counts fewer un-catalogued strings on a page with less data, so its
     * ceilings are an upper bound rather than a measurement. That is sound for
     * what it is for — refusing GROWTH — and this guard is what stops it being
     * read as anything more.
     */
    const withMarkers: string[] = [];
    for (const path of PAGES) {
      await page.goto(path);
      if ((await page.content()).includes(OPEN)) withMarkers.push(path);
    }
    expect(
      withMarkers.length,
      `no bracketed text in the HTML of ANY of ${PAGES.length} pages — ` +
        'is this server running with PSEUDO_LOCALE=1?',
    ).toBeGreaterThan(0);
  });

  /**
   * UD-16 — every crawled page's TITLE, checked here because nothing else can.
   *
   * `visibleStrings` walks `document.body`; a `<title>` lives in `<head>`, so the
   * ratchet below is structurally blind to it, and `scripts/check-page-titles.mjs`
   * can only see that a route DECLARES a title, not that one arrives. This is the
   * only place in the suite that renders these pages signed in, on a host the
   * tenancy resolver accepts, and can therefore ask a browser what the tab says.
   *
   * That last clause is not incidental. Checking this by curl against a
   * hand-started server returned 403 and the root layout's fallback title for
   * every /admin route — which reads exactly like a UD-16 regression and was not
   * one: the ad-hoc server had none of `playwright.config.ts`'s tenancy
   * environment. A title test that is not signed in the way a reader is signed in
   * measures the 403 page.
   *
   * Asserts pseudo-BRACKETING rather than the words, deliberately. The words are
   * `test/page-titles.test.ts`'s business; asking for them here would put a second
   * copy of the catalogue in a spec file. A bracketed title proves the string came
   * from a catalogue through `localizedFrom`, which is the one thing only a
   * rendered page can tell us.
   */
  for (const path of PAGES) {
    test(`${path} — the tab says what page this is`, async ({ page }) => {
      const response = await page.goto(path);
      // A 403 or a redirect renders the ROOT layout's fallback title, which would
      // pass a laxer assertion while proving nothing. Fail on the status first, so
      // the message names the real problem.
      expect(response?.status(), `${path} did not render`).toBeLessThan(400);

      const title = await page.title();
      // The page's own half comes FIRST, because a browser truncates the END of a
      // tab title. `Acme Inc \u00b7 VeloExpense \u00b7 \u27e6Billing\u27e7` would satisfy a
      // "contains" assertion and still be the defect UD-16 is about, so this
      // checks the position and not just the presence.
      expect(title, `${path} tab title: ${JSON.stringify(title)}`).toContain(OPEN);
      expect(
        title.startsWith(OPEN),
        `${path} title does not lead with its own name: ${JSON.stringify(title)}`,
      ).toBe(true);
    });
  }

  for (const path of PAGES) {
    test(`${path} — catalogued text is catalogued`, async ({ page }) => {
      await page.goto(path);

      // Every status and severity badge on the page. These are `enumLabel` call
      // sites from part 2a, so each one must be bracketed — a badge that is not
      // is a badge rendering the raw enum member, which is the defect 2a removed
      // from eleven screens and the one most likely to come back.
      for (const testid of ['status-badge', 'severity-badge']) {
        const badges = page.locator(`[data-testid="${testid}"]`);
        const n = await badges.count();
        for (let i = 0; i < n; i += 1) {
          const text = (await badges.nth(i).innerText()).trim();
          expect(text, `${path} ${testid}[${i}] is not from a catalogue`).toContain(OPEN);
        }
      }

      // And the error banner, if one is showing — part 2c's surface.
      const banner = page.getByTestId('error-banner');
      if ((await banner.count()) > 0) {
        expect((await banner.innerText()).trim(), `${path} error banner`).toContain(OPEN);
      }
    });

    test(`${path} — the un-catalogued count has not grown`, async ({ page }) => {
      // MEASURED ON A PAGE WITH NO ROWS, where the page has rows at all.
      //
      // VX4-8 part 1 is what found this, and the way it found it is the point:
      // that ticket added an e2e that approves two reports, and `/expenses` went
      // from 44 un-catalogued strings to 50 without a single string of copy
      // changing. Report titles, numbers and merchants are USER DATA — no
      // catalogue will ever contain them — so counting them made this ceiling a
      // measure of how many reports the suite happened to create, and every
      // future spec that files one would have pushed it up again.
      //
      // Excluding `<tbody>` wholesale was tried first and measured: it takes the
      // six-page total from 176 to 92, because 84 of those strings are genuine
      // un-catalogued CHROME living in table cells — `/admin/expense-policies`
      // alone drops 46 → 28. That is hiding 84 real findings to stabilise one
      // page, so it was rejected.
      //
      // Filtering to an empty table keeps every chrome string and drops only the
      // data. The sibling test above still loads the page UNFILTERED, because its
      // job is to check the badges that only exist when there are rows.
      //
      // WHAT THIS GIVES UP, stated rather than left to be found: a hardcoded
      // string that appears only inside a `/expenses` table ROW is now invisible
      // to this count. The trade is worth taking — the baseline drops from 44 to
      // 19, so the gate is TIGHTER on everything it can still see, and a
      // sabotage adding one hardcoded line to the page chrome fails it at 20 —
      // but a row-only string is a real hole, and `enumLabel` call sites inside
      // rows are covered by the badge test above rather than by this one.
      await page.goto(RATCHET_PATH[path] ?? path);
      const plain = unbracketed(await visibleStrings(page));
      const ceiling = CHROME_CEILING[path];
      expect(
        ceiling,
        `${path} has no measured ceiling — add one (it currently shows ${plain.length})`,
      ).toBeDefined();
      // Printed on every run, passing or failing: a count that has DROPPED is
      // how somebody notices the ceiling should come down, and an assertion
      // cannot tell them that without being flaky.
      console.log(`  ${path}: ${plain.length} un-catalogued (ceiling ${ceiling})`);
      expect(
        plain.length,
        `${path}: ${plain.length} un-catalogued strings, ceiling ${ceiling}.\n` +
          `Copy added to this page has to go through a catalogue. If you LOWERED the\n` +
          `count by cataloguing some, lower the ceiling here too.\n` +
          // 60, not the 12 this used to print. VX4-10 part 2 raised it because a
          // screen being CATALOGUED needs the whole list — twelve of nineteen is
          // enough to fix a regression and not enough to finish a page, and the
          // twelve it showed were the ones the walker happened to reach first.
          plain.slice(0, 60).map((l) => `    ${l}`).join('\n'),
      ).toBeLessThanOrEqual(ceiling);
    });
  }
});

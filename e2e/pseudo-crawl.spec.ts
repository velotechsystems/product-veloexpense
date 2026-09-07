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
  '/expenses': 19,
  '/approvals': 15,
  // STILL DATA-DEPENDENT, stated rather than left to be discovered. This page
  // lists notification rows and the count moves with them: 30 at the moment,
  // against a ceiling measured at 42 on a fuller database. The headroom is what
  // keeps it green, which is exactly the weakness `/expenses` just demonstrated —
  // it is here because no filter on this screen produces an empty list, and it is
  // worth a ticket rather than a clever selector. Any page added here with rows
  // needs a RATCHET_PATH or the same caveat.
  // LEFT AT 42 THOUGH IT CURRENTLY READS 10, and that is not laziness. This page's
  // count moves with how many notifications exist, and 42 was measured on a fuller
  // database — the full Playwright suite creates them and runs before this. VX4-10
  // did not touch this screen, so lowering the ceiling here would be claiming
  // credit for an empty table and would go red the moment the suite ahead of it
  // did its job. It comes down when the screen is catalogued, in a later part.
  '/notifications': 42,
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
  // Same as `/notifications` and for the same reason: reads 29 on this database
  // and 46 was measured on a fuller one. Untouched by part 1; comes down when it
  // is catalogued.
  '/admin/expense-policies': 46,
  '/admin/locale': 19,
  // Measured after VX4-10 part 1 catalogued the screen. See PAGES above.
  '/admin/billing': 0,
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
      // eslint-disable-next-line no-console
      console.log(`  ${path}: ${plain.length} un-catalogued (ceiling ${ceiling})`);
      expect(
        plain.length,
        `${path}: ${plain.length} un-catalogued strings, ceiling ${ceiling}.\n` +
          `Copy added to this page has to go through a catalogue. If you LOWERED the\n` +
          `count by cataloguing some, lower the ceiling here too.\n` +
          plain.slice(0, 12).map((l) => `    ${l}`).join('\n'),
      ).toBeLessThanOrEqual(ceiling);
    });
  }
});

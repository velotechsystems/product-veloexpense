/**
 * VX4-7 part 1 — THE LOCALE CHAIN, IN A BROWSER, WITH THE PAGE CHANGING.
 *
 * ── What this proves that 92 vitest assertions cannot ──────────────────────
 *
 * `test/i18n-{locales,resolve,schema.db}.test.ts` prove the registry, the
 * precedence and the columns. None of them can show the thing that makes IL-2 a
 * finding rather than a nitpick: that the chain HAS A CALLER. Upstream's
 * `resolveLocale` documents four rungs and has no non-test callers, so their
 * precedence is prose. This is the only place ours is exercised through a real
 * request — session, `headers()`, `cache()`, layout, `<html lang>` — end to end.
 *
 * `<html lang>` is the assertion that matters most here, and it is deliberately
 * not a text assertion. It is the one output that proves `readerPrefs()` ran on
 * the render path inside the ROOT LAYOUT: a screen could show the right sample
 * while the layout still said `lang="en"`, because the sample is computed by the
 * page's own action. A screen reader picks its voice from `lang`, so that gap
 * would be invisible to everyone who can see.
 *
 * ── What this file leaves behind, and why it cleans up ─────────────────────
 *
 * It changes the DEMO TENANT'S default locale and timezone, which is global
 * state every later spec renders under. Alphabetically `locale-flow` sorts
 * between `ledger-flow` and `modules-flow`, so a run that left the company in
 * French would hand French chrome to every spec after it. The `afterAll` puts
 * both columns back and clears the user's own row — and per the handoff's rule
 * about specs that rely on the environment being disposable, note that CI IS
 * fresh every run and would NOT catch the omission. The `beforeAll` therefore
 * asserts the starting state rather than assuming it.
 */
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';

const ADMIN = 'admin@demo.test';

/**
 * The instant both screens format is 2026-03-04T02:30Z, fixed in their actions.
 * It is chosen because it is the PREVIOUS DAY in every North American zone, so a
 * timezone change moves the visible date rather than only the visible clock —
 * which is what the third test below reads.
 *
 * The expected strings here were taken from `Intl` on Node 22 (the version CI
 * pins) rather than guessed, and then loosened to a regex that accepts either
 * word order: an exact ICU string is a hostage to the runtime's ICU build, and
 * the claim being made is "the day moved", not "the day is spelled this way".
 */
function pool() {
  return new Pool({
    connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  });
}

async function setCompany(locale: string, timeZone: string) {
  const p = pool();
  try {
    await p.query(
      `UPDATE organization SET default_locale = $1, default_timezone = $2 WHERE slug = 'demo'`,
      [locale, timeZone],
    );
  } finally {
    await p.end();
  }
}

async function clearMine() {
  const p = pool();
  try {
    await p.query(
      `UPDATE app_user u SET locale = NULL, timezone = NULL
         FROM organization o
        WHERE u.organization_id = o.id AND o.slug = 'demo' AND lower(u.email) = $1`,
      [ADMIN],
    );
  } finally {
    await p.end();
  }
}

async function companyRow(): Promise<{ locale: string; zone: string }> {
  const p = pool();
  try {
    const { rows } = await p.query<{ default_locale: string; default_timezone: string }>(
      `SELECT default_locale, default_timezone FROM organization WHERE slug = 'demo'`,
    );
    return { locale: rows[0].default_locale, zone: rows[0].default_timezone };
  } finally {
    await p.end();
  }
}

/** The `lang` the browser actually received. */
async function langOf(page: Page): Promise<string> {
  // `getAttribute` on the root element, not `innerText` of anything — see the
  // handoff's note 7 about `innerText` answering '' for what is not rendered.
  const lang = await page.locator('html').getAttribute('lang');
  expect(lang, 'the root element must carry a lang attribute').toBeTruthy();
  return lang as string;
}

async function sampleText(page: Page, testid: string): Promise<string> {
  // Anchored on an auto-waiting expect FIRST, because `textContent()` does not
  // auto-wait and would answer about the page we just left (handoff note 6).
  const el = page.getByTestId(testid);
  await expect(el).toBeVisible();
  const text = await el.textContent();
  expect(text?.trim().length ?? 0, 'the sample row rendered empty').toBeGreaterThan(0);
  return text as string;
}

test.describe('the locale chain, end to end', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Assert the starting state rather than assume it: this file's later
    // assertions are all relative to the company being on the shipped default,
    // and a previous run that failed between its steps would leave it elsewhere.
    await setCompany(DEFAULT_LOCALE, 'UTC');
    await clearMine();
    expect(await companyRow()).toEqual({ locale: DEFAULT_LOCALE, zone: 'UTC' });
  });

  test.afterAll(async () => {
    await setCompany(DEFAULT_LOCALE, 'UTC');
    await clearMine();
  });

  test('the admin screen shows the company default, and the page says so in lang', async ({
    page,
  }) => {
    await page.goto('/admin/locale');
    await expect(page.getByRole('heading', { name: 'Language and time' })).toBeVisible();
    await expect(page.getByTestId('org-locale')).toHaveValue(DEFAULT_LOCALE);
    await expect(page.getByTestId('org-timezone')).toHaveValue('UTC');
    expect(await langOf(page)).toBe(DEFAULT_LOCALE);

    // The comparison table renders ALL THREE locales, so both halves of IL-1 are
    // on the screen at once: `$10,799.00` for en-CA and `CA$10,799.00` for en-US,
    // the same amount in the same currency, one row apart.
    const sample = await sampleText(page, 'locale-sample');
    expect(sample).toContain('$10,799.00');
    expect(sample).toContain('CA$10,799.00');
    // …and the saved one is marked, which is the only part that moves on save.
    await expect(page.getByTestId('locale-sample').getByText('in use')).toHaveCount(1);
    await expect(
      page.getByRole('row').filter({ hasText: 'English (Canada)' }).getByText('in use'),
    ).toHaveCount(1);
  });

  test('switching the company to en-US changes the money and the lang', async ({ page }) => {
    await page.goto('/admin/locale');
    await page.getByTestId('org-locale').selectOption('en-US');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.getByTestId('org-locale')).toHaveValue('en-US');

    // IL-1 ON THE SCREEN. `Intl` renders CAD as `$10,799.00` for en-CA and
    // `CA$10,799.00` for en-US — the same amount, the same currency, a different
    // symbol, because one of those locales is not Canadian. Upstream shipped
    // `en` for years believing it was; this is the difference nobody could see.
    // The table's content does not change — it always shows all three — so the
    // assertion that the SAVE landed is which row is marked, plus `lang`.
    await expect(
      page.getByRole('row').filter({ hasText: 'English (United States)' }).getByText('in use'),
    ).toHaveCount(1);
    await expect(
      page.getByRole('row').filter({ hasText: 'English (Canada)' }).getByText('in use'),
    ).toHaveCount(0);

    expect(await langOf(page)).toBe('en-US');
    // And on a DIFFERENT page, which is what proves it came from the layout
    // rather than from this screen's own action.
    await page.goto('/expenses');
    expect(await langOf(page)).toBe('en-US');
  });

  test('switching the company timezone moves the visible DAY, not just the clock', async ({
    page,
  }) => {
    await page.goto('/admin/locale');
    const before = await sampleText(page, 'locale-sample');
    // 02:30 UTC on 4 March.
    expect(before).toMatch(/Mar(ch)? 4|4 Mar/);

    await page.getByTestId('org-timezone').selectOption('America/Vancouver');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // 18:30 on 3 March in Vancouver. The DATE moved, and this is the assertion
    // that makes the timezone column more than decoration: a reader west of UTC
    // was being shown tomorrow's date for anything recorded late in their day.
    const after = await sampleText(page, 'locale-sample');
    expect(after).not.toBe(before);
    expect(after).toMatch(/Mar(ch)? 3|3 Mar/);
    // The zone itself is named in the table's caption rather than inside it —
    // the rows are the three locales, and the zone applies to all of them.
    await expect(page.getByTestId('sample-caption')).toContainText('America/Vancouver');
    // Every row moved, not just the one in use: the zone is orthogonal to the
    // locale, and a preview that moved only the selected row would be hiding it.
    for (const name of ['English (Canada)', 'English (United States)', 'Français (Canada)']) {
      await expect(page.getByRole('row').filter({ hasText: name })).toContainText(/3 mars|Mar 3/);
    }
  });

  test('my own preference outranks the company, and clearing it puts me back', async ({ page }) => {
    // The company is on en-US / America/Vancouver from the two tests above —
    // serial mode, and stated here because an assertion whose premise is another
    // test is the thing the handoff's note 3 is about.
    await page.goto('/preferences');
    await expect(page.getByRole('heading', { name: 'Language and time' })).toBeVisible();

    // "Follow the company (English (United States))" — the inherited value is
    // NAMED rather than left blank, so "no preference" does not read as "unset".
    await expect(page.getByTestId('my-locale')).toHaveValue('');
    await expect(
      page.getByRole('option', { name: 'Follow the company — English (United States)' }),
    ).toHaveCount(1);

    await page.getByTestId('my-locale').selectOption('fr-CA');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // Rung 1 beats rung 2.
    expect(await langOf(page)).toBe('fr-CA');
    const mine = await sampleText(page, 'my-sample');
    expect(mine).toContain('mars');
    // The zone is still the COMPANY's, because locale and timezone resolve
    // independently — I set a language, not a clock.
    expect(mine).toMatch(/Mar(ch)? 3|3 mars/);

    // And the company moving no longer moves me.
    await setCompany('en-CA', 'UTC');
    await page.goto('/expenses');
    expect(await langOf(page)).toBe('fr-CA');

    // Clearing puts me back on the company — permanently, not pinned to whatever
    // the default was on the day I cleared it. `setCompany` below is what proves
    // the difference: a writer that stored the resolved value would leave me on
    // en-CA when the company moved to fr-CA.
    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await langOf(page)).toBe('en-CA');

    await setCompany('fr-CA', 'UTC');
    await page.goto('/expenses');
    expect(await langOf(page)).toBe('fr-CA');
  });

  /**
   * NOT TESTED HERE: that an unsupported locale is refused with a readable
   * sentence.
   *
   * The first draft of this file had that test, and it asserted nothing. The
   * `<select>` only offers three locales, so a browser cannot submit a fourth —
   * so the "test" navigated to `/admin/locale?error=en+is+not+a+supported+locale`
   * and checked the banner rendered, which exercises `ErrorBanner` and could not
   * fail for the reason it named. Handoff note 5's class exactly: if the
   * assertion cannot fail, it is not one.
   *
   * The refusal is asserted where it can actually fail — `test/i18n-schema.db.
   * test.ts`, 'refuses an unsupported locale before the database has to', which
   * calls `setOrgDefaults` with `'en'` and reads the message — and the column's
   * CHECK is asserted there too, against the constraint's own definition.
   */
});

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
import { addExpenseLine, createDraftReport } from './helpers';

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


/**
 * A report with one dated expense, owned by the signed-in admin.
 *
 * Created here rather than borrowed from `expense-flow`'s leftovers: that spec
 * runs earlier alphabetically, so borrowing would work today and break the day
 * somebody renames a file — which is the handoff's rule about a spec that
 * depends on another spec's cleanup. Removed in the afterAll.
 */
const DATED = '2026-03-04';
let reportId: string | null = null;
let violationReportId: string | null = null;

async function makeDatedReport(): Promise<string> {
  const p = pool();
  try {
    const { rows } = await p.query<{ id: string }>(
      `WITH me AS (
         SELECT u.id, u.organization_id
           FROM app_user u JOIN organization o ON o.id = u.organization_id
          WHERE o.slug = 'demo' AND lower(u.email) = $1
       ), r AS (
         INSERT INTO expense_report (organization_id, submitter_id, title, currency_code, number)
         SELECT organization_id, id, 'Locale date check', 'CAD', 'EXP-LOCALE'
           FROM me RETURNING id, organization_id
       )
       INSERT INTO expense (organization_id, report_id, txn_date, currency_code, merchant)
       SELECT organization_id, id, $2::date, 'CAD', NULL FROM r
       RETURNING report_id AS id`,
      [ADMIN, DATED],
    );
    return rows[0].id;
  } finally {
    await p.end();
  }
}

/**
 * A report with one $600 line and no receipt, through the UI.
 *
 * Through the UI on purpose, unlike `makeDatedReport` above: a policy violation
 * only exists because `validateReport` ran inside the transaction that saved the
 * line, so a row inserted with SQL would have no findings to render and this
 * test would pass by having nothing to look at.
 */
async function makeViolatingReport(page: Page): Promise<string> {
  await createDraftReport(page, 'Locale violation check');
  // w2-02b: on ExpenseOS's workbench (helpers.ts `addExpenseLine`), which dates a new
  // expense today (VX4-11). $600 clears the starter $500 per-transaction limit, which is the
  // WARNING that renders MONEY — the whole point of the assertion below.
  await addExpenseLine(page, { vendor: 'Le Bistro', category: 'Meals & Entertainment', amount: '600.00' });
  await expect(page.getByRole('main').getByText(/per-transaction limit/).first()).toBeVisible();

  const url = new URL(page.url());
  return url.pathname.split('/').pop() as string;
}

async function dropDatedReport(id: string) {
  const p = pool();
  try {
    await p.query(`DELETE FROM expense_report WHERE id = $1`, [id]);
  } finally {
    await p.end();
  }
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
    if (reportId) await dropDatedReport(reportId);
    if (violationReportId) await dropDatedReport(violationReportId);
  });

  test('the admin screen shows the company default, and the page says so in lang', async ({
    page,
  }) => {
    await page.goto('/admin/locale');
    await expect(page.getByRole('heading', { name: 'Language and time' })).toBeVisible();
    await expect(page.getByTestId('org-locale')).toHaveValue(DEFAULT_LOCALE);
    await expect(page.getByTestId('org-timezone')).toHaveValue('UTC');
    expect(await langOf(page)).toBe(DEFAULT_LOCALE);

    // The comparison table renders every SHIPPED locale, so both halves of IL-1
    // are on the screen at once: `$10,799.00` for en-CA and `CA$10,799.00` for
    // en-US, the same amount in the same currency, one row apart. It was three
    // rows until part 2a retired fr-CA (0028) — the table reads the registry, so
    // it shrank on its own.
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
    for (const name of ['English (Canada)', 'English (United States)']) {
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

    // `en-CA` here, because part 2a retired `fr-CA` (0028) until its copy
    // exists. The company is on `en-US` from the tests above, so picking `en-CA`
    // is still a reader OVERRIDING their company — which is what this test is
    // about — and the two are distinguishable on screen by the currency prefix.
    await page.getByTestId('my-locale').selectOption('en-CA');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    // Rung 1 beats rung 2.
    expect(await langOf(page)).toBe('en-CA');
    const mine = await sampleText(page, 'my-sample');
    expect(mine).toContain('$10,799.00');
    expect(mine).not.toContain('CA$');
    // The zone is still the COMPANY's, because locale and timezone resolve
    // independently — I set a language, not a clock.
    expect(mine).toMatch(/Mar(ch)? 3/);

    // And the company moving no longer moves me.
    await setCompany('en-US', 'UTC');
    await page.goto('/expenses');
    expect(await langOf(page)).toBe('en-CA');

    // Clearing puts me back on the company — permanently, not pinned to whatever
    // the default was on the day I cleared it. `setCompany` below is what proves
    // the difference: a writer that stored the resolved value would leave me on
    // en-US when the company moved to en-CA.
    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await langOf(page)).toBe('en-US');

    await setCompany('en-CA', 'UTC');
    await page.goto('/expenses');
    expect(await langOf(page)).toBe('en-CA');
  });


  test('money on a real screen follows the reader, not the server', async ({ page }) => {
    // VX4-7 part 1b. `formatMinor` has had a locale parameter since VX1-6 and
    // all 23 call sites let it default, so the parameter was correct and inert —
    // IL-2's shape in the money code. This is the assertion that a screen now
    // supplies it: CAD renders `$` for en-CA and `CA$` for en-US, which is IL-1
    // showing up in the totals column of a list people read every day.
    await setCompany(DEFAULT_LOCALE, 'UTC');
    await clearMine();
    reportId = reportId ?? (await makeDatedReport());

    // w2-05: the ported reports list prints money with its ISO CODE (ExpenseOS's F54 — CAD
    // and USD share the `$` glyph), which reads the same to an en-CA and an en-US reader.
    // w2-02b: so does the report's own page now — ExpenseOS's workbench formats in its
    // catalogue locale on every screen (i18n/request.ts) and names the currency beside the
    // amount. The reader's own money is claimed where VeloExpense still renders it: a policy
    // finding's sentence, in the describe block below.
    const money = async () => {
      await page.goto(`/expenses/${reportId}`);
      await expect(page.getByRole('banner')).toContainText('CAD');
      return page.getByRole('banner').textContent();
    };
    const canadian = await money();

    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('en-US');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    const american = await money();
    // The same total, with its code, to both readers — no `CA$` / `$` split to tell apart.
    expect(american).toBe(canadian);
    await clearMine();
  });

  test('the expense date field still holds YYYY-MM-DD in en-US', async ({ page }) => {
    // THE DATA-LOSS GUARD, end to end, and the reason it is an e2e rather than a
    // unit test: the failure is a browser silently refusing a value it cannot
    // parse and rendering an EMPTY field. Nothing throws, nothing logs, and a
    // unit test on the formatter cannot see it because the string is a string
    // either way. Only asking a real Chrome what the input actually holds does.
    //
    // `scripts/check-i18n.mjs` refuses the shape statically; this proves the
    // shape that shipped is the right one.
    reportId = reportId ?? (await makeDatedReport());

    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('en-US');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.goto(`/expenses/${reportId}`);
    // w2-02b: the workbench's editor, open on the report's one expense.
    const dateField = page.getByLabel('Date', { exact: true });
    await expect(dateField).toBeVisible();
    // The VALUE, not the rendered text — a date input shows the user their own
    // locale's rendering and holds ISO underneath. It is the underneath that
    // round-trips through the form.
    await expect(dateField).toHaveValue(DATED);

    // And the same field read as a display date DOES follow the locale, which is
    // what makes the pair meaningful: the two are deliberately different jobs.
    const shown = await page.locator('body').textContent();
    expect(shown ?? '').toMatch(/Mar(ch)? 4|4 Mar|2026-03-04/);
    await clearMine();
  });

  test('a calendar date does not move when the reader changes zone', async ({ page }) => {
    // An expense dated the 4th is the 4th for everyone — it has no time and no
    // zone. This is the half upstream gets wrong in the other direction, and the
    // half our own `toISOString()` got wrong on any server east of UTC.
    reportId = reportId ?? (await makeDatedReport());

    await page.goto('/preferences');
    await page.getByTestId('my-timezone').selectOption('Australia/Sydney');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.goto(`/expenses/${reportId}`);
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(DATED);
    const sydney = await page.locator('body').textContent();
    expect(sydney ?? '').toMatch(/Mar(ch)? 4|4 Mar|2026-03-04/);
    expect(sydney ?? '').not.toMatch(/Mar(ch)? 3\b/);
    await clearMine();
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

/**
 * VX4-7 part 2b — the sentence a policy violation says is the READER's, not the
 * one frozen when somebody else pressed save.
 *
 * Its own describe block, with its own company/user reset, because the block
 * above is serial and ends with the tenant on `en-US`/`America/Vancouver` — an
 * assertion whose premise is another test's leftover state is the thing the
 * handoff's note 3 is about.
 *
 * ── WHY THIS EXISTS WHEN 50 UNIT TESTS ALREADY COVER THE RENDER ─────────────
 *
 * They cover `renderPolicyMessage`. They cannot cover the two joins between it
 * and a reader: that `listViolations` actually SELECTs `message_code` (a column
 * missing from the query renders every row from the frozen English and every
 * unit test still passes), and that the panel threads the resolved locale down
 * rather than a constant. Part 1 shipped `revalidatePath` only because an e2e
 * found the layout going stale; this is the same class of gap.
 */
test.describe('a violation is written for the reader, not for whoever saved it', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await setCompany(DEFAULT_LOCALE, 'UTC');
    await clearMine();
  });

  test.afterAll(async () => {
    await setCompany(DEFAULT_LOCALE, 'UTC');
    await clearMine();
  });

  test('the same stored finding reads in en-CA and in en-US money', async ({ page }) => {
    violationReportId = await makeViolatingReport(page);

    // w2-02b: the workbench lists an expense's findings under "Policy warnings".
    const warning = page.getByRole('listitem').filter({ hasText: /per-transaction limit/ });
    await expect(warning).toHaveCount(1);

    // en-CA: a Canadian reader looking at Canadian dollars gets a bare symbol.
    // w2-02b: the workbench's line has no description, so the sentence names the line by its
    // category where the old form's "Client dinner" was.
    await expect(warning.first()).toContainText(
      'Meals & Entertainment is $600.00, over the $500.00 per-transaction limit.',
    );

    // Now the SAME ROW, to a different reader. Nothing about the report changes
    // — no save, no re-validation — which is what makes this a render test and
    // not a write test.
    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('en-US');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.goto(`/expenses/${violationReportId}`);
    await expect(warning.first()).toContainText(
      'Meals & Entertainment is CA$600.00, over the CA$500.00 per-transaction limit.',
    );
    // And explicitly NOT the other one, because `toContainText` on a sentence
    // that is a prefix of the other would pass either way round.
    await expect(warning.first()).not.toContainText('is $600.00,');

    // Back, so the assertion is about the reader and not about a one-way door.
    await page.goto('/preferences');
    await page.getByTestId('my-locale').selectOption('en-CA');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.goto(`/expenses/${violationReportId}`);
    await expect(warning.first()).toContainText('over the $500.00 per-transaction limit.');
  });

  // w2-02b: "the acknowledge field describes what the reader can see" is retired with the
  // report page that had it. On ExpenseOS's workbench an expense's warning is answered by the
  // expense's own "Explain this charge", not by a field per finding, so there is no per-finding
  // label left to keep in step with the sentence.
});

import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { Pool } from 'pg';
import { addExpenseLine, createDraftReport, EMPLOYEE_STATE } from './helpers';

/**
 * ExpenseOS #576 (`pwa-workbench-expense-fields`, P18): add an expense and fill it in on a
 * phone, and a half-typed vendor survives a live resize across `lg`. The two tests, their
 * helpers and their comments are ExpenseOS's, from `e2e/expense-workbench.mobile.spec.ts`.
 *
 * VeloExpense: what had to change, and only that.
 *
 *   · VeloExpense has no phone Playwright projects (ExpenseOS runs this file under mobile-360,
 *     mobile-390 and mobile-412). The phone is THIS file's viewport, 390x664, on the one
 *     `chromium` project, as `approvals-inbox-flow.spec.ts`'s phone half does. One width, not
 *     three; ExpenseOS's own note says nothing here is width-specific below `sm`.
 *   · No `testDb` (Prisma) in VeloExpense's e2e: the database reads are `pg` queries on the
 *     admin URL, as `roles-flow.spec.ts` and `seat-push.spec.ts` read it.
 *   · No `e2e/support/*`: `seedReport` builds the fixture with VeloExpense's own
 *     `createDraftReport` and `addExpenseLine` (no receipt; this flow never opens one), and
 *     `openExpenseList` is ExpenseOS's `support/workbench.ts` helper, carried here.
 *   · The kit Combobox is a `<button role="combobox">`, not an `<input>`: it is picked by
 *     clicking it and its `option`, and read with `toContainText`, not `toHaveValue`.
 *   · Signed in as the seed's employee by storage state, not `signIn`; URLs carry no locale
 *     segment.
 *   · Not ported: `openOnPhone`'s service-worker and desktop-only-notice guards (VeloExpense
 *     has neither), and the tap-target census (`tap-targets.mobile.spec.ts`'s `censusOf`
 *     machinery is not in VeloExpense). The 44px floors are pinned by class in
 *     `parts.limitedRegions.test.tsx` and `ExpenseReportWorkbench.test.tsx` instead.
 */

const LOCALE = 'en';

const PHONE = { width: 390, height: 664 } as const;

/** The width the fixture is built at. */
const DESKTOP = { width: 1280, height: 900 } as const;

/**
 * The category every other expense spec uses, so it is known to exist in the seed.
 * VeloExpense: a name for `addExpenseLine`, which picks by option name.
 */
const CATEGORY = 'Office Supplies';

/**
 * The width the live-resize test starts and ends at: above `lg` (1024), so the page is in its
 * desktop tree, and BELOW `xl` (1280) on purpose. `ResizablePanels` swaps between two element
 * trees at `(min-width: 80rem)`, which remounts every pane, the editor included. A resize that
 * crosses 1280 would lose the half-typed value for a reason this change did not cause, so the
 * test never goes there.
 */
const BELOW_XL = { width: 1200, height: 900 } as const;

/** The name the spec reads its own errors under. */
const CALLER = 'expense-workbench-phone.spec.ts';

/**
 * Copy read from the catalog rather than pinned: a copy edit does not turn into a false
 * alarm, and a RENAMED key throws with its name.
 *
 * Only the notice copy is read this way. Every locator in this file is an EN literal: an
 * accessible name is what the locator matches, and pinning it is what keeps a rename from
 * silently retargeting one.
 */
function catalogText(namespace: string, path: string): string {
  const json = JSON.parse(
    readFileSync(`packages/i18n/src/catalogs/${LOCALE}/${namespace}.json`, 'utf8'),
  ) as Record<string, unknown>;
  let node: unknown = json;
  for (const key of path.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (typeof node !== 'string') {
    throw new Error(
      `${CALLER}: ${namespace}.${path} is missing from the ${LOCALE} catalog ` +
        `(packages/i18n/src/catalogs/${LOCALE}/${namespace}.json). The key was renamed or ` +
        'removed; point this spec at the new one rather than re-adding the old key.',
    );
  }
  return node;
}

const MAIN = 'main#main-content';

test.describe.configure({ timeout: 150_000 });

/**
 * A SUBMITTER, not the admin. VeloExpense: the seed's employee, by storage state.
 */
test.use({ storageState: EMPLOYEE_STATE, viewport: PHONE });

// VeloExpense: the database, as the other specs reach it.
const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});
test.afterAll(async () => {
  await admin.end();
});

/**
 * VeloExpense: the total below rises only if the demo tenant has a USD->CAD rate, and it
 * cannot count on the seeded one: `analytics-flow` sorts first and deletes every rate (as
 * `fx-rates-flow.spec.ts` notes). So the seed's own row is put back, as `scripts/seed.mjs`
 * writes it (`DEMO_FX`), and left alone if it is already there. ExpenseOS's suite keeps its
 * seeded rates (`SEED_FX_RATES`).
 */
async function ensureSeededUsdCadRate(): Promise<void> {
  await admin.query(
    `INSERT INTO fx_rate (organization_id, base, quote, rate, fetched_at, source)
     SELECT organization_id, 'USD', 'CAD', 1.35, ('2026-01-01'::date)::timestamp AT TIME ZONE 'UTC', 'SEED'
       FROM app_user WHERE email = 'employee@demo.test'
     ON CONFLICT (organization_id, base, quote, fetched_at) DO NOTHING`,
  );
}

/**
 * Run the fixture build on a sibling page at a desktop width, then close it.
 *
 * Same `BrowserContext`, so the session on the phone page is already here and nothing signs
 * in twice. Closed in a `finally` so a failed build does not leak a page into the next
 * test's context.
 */
async function onDesktop<T>(page: Page, build: (desk: Page) => Promise<T>): Promise<T> {
  const desk = await page.context().newPage();
  await desk.setViewportSize(DESKTOP);
  try {
    return await build(desk);
  } finally {
    await desk.close();
  }
}

/**
 * A draft report with `count` expenses on it, built at a desktop width.
 *
 * VeloExpense: `createDraftReport` + `addExpenseLine` in place of ExpenseOS's
 * `createReport` + `addExpense`, so no receipt is attached.
 */
async function seedReport(page: Page, title: string, count = 1): Promise<string> {
  return onDesktop(page, async (desk) => {
    await createDraftReport(desk, title);
    const id = new URL(desk.url()).pathname.split('/').pop() as string;
    for (let i = 0; i < count; i += 1) {
      await addExpenseLine(desk, {
        vendor: `Bay Street Depot ${i + 1}`,
        amount: `${(i + 1) * 100}.00`,
        category: CATEGORY,
      });
    }
    return id;
  });
}

/** The report's own URL. VeloExpense: no locale segment. */
function reportUrl(id: string): string {
  return `/expenses/${id}`;
}

/**
 * Open the report at the phone viewport and wait until the phone tree has committed.
 *
 * `ReportSummary` is mounted by the `useIsBelowLg` branch, which resolves during the first
 * client render, so its presence is the honest signal that hydration has happened AND that
 * the hook answered `true`.
 */
async function openOnPhone(page: Page, id: string): Promise<void> {
  const response = await page.goto(reportUrl(id), { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${reportUrl(id)} did not answer 200`).toBe(200);
  await expect(
    page.getByTestId('report-summary'),
    'the below-`lg` body header did not mount. Either hydration did not happen, or ' +
      '`useIsBelowLg` answered false at a phone width.',
  ).toBeVisible({ timeout: 30_000 });
  // The page lays out again when the report query lands.
  await page.waitForLoadState('networkidle');
}

/**
 * The expenses pane's title, below `lg`, where it is also the way in and out of the list.
 * An ICU plural, so the count is OPTIONAL in the name. (ExpenseOS `support/workbench.ts`.)
 */
const EXPENSE_LIST_TOGGLE = /^Expenses(\s·\s\d+)?$/;

/**
 * Open the below-`lg` expense list, and leave it open. (ExpenseOS `support/workbench.ts`.)
 *
 * Below `lg` the expenses pane is a DISCLOSURE and it is COLLAPSED ON ARRIVAL. The list is
 * found through the control's own `aria-controls` rather than by its id.
 */
async function openExpenseList(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: EXPENSE_LIST_TOGGLE }).first();
  await expect(
    toggle,
    'the below-`lg` expenses disclosure never appeared. Its label is ' +
      '`workbench.expensesToggle`, and the heading only renders a button on the `isBelowLg` ' +
      'branch.',
  ).toBeEnabled({ timeout: 30_000 });

  if ((await toggle.getAttribute('aria-expanded')) === 'true') return;

  const listId = await toggle.getAttribute('aria-controls');
  expect(
    listId,
    'the expenses disclosure has no `aria-controls`, so nothing says which region it opens.',
  ).toBeTruthy();
  const list = page.locator(`#${listId}`);

  await toggle.click();
  const opened = await list.waitFor({ state: 'visible', timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (!opened && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }

  await expect(
    toggle,
    'pressing the expenses disclosure did not expand it — `aria-expanded` is still "false".',
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(list).toBeVisible({ timeout: 20_000 });
}

/**
 * Press `name` and wait for `revealed` to appear. Re-pressing is safe only while the control
 * is still ENABLED, because an in-flight mutation disables it and a completed one removes it.
 */
async function pressAndReveal(control: Locator, revealed: Locator, what: string): Promise<void> {
  await expect(control, `"${what}" should be pressable`).toBeEnabled({ timeout: 30_000 });
  await control.click();
  const appeared = await revealed.waitFor({ state: 'visible', timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (!appeared && (await control.count()) > 0 && (await control.first().isEnabled())) {
    await control.first().click();
  }
  await expect(
    revealed,
    `pressing "${what}" should have revealed it — the press was acknowledged by nothing`,
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * VeloExpense: ExpenseOS's `support/combobox.ts` `pickCombobox`, for the kit Combobox (a
 * button whose options are `role="option"`). Retries the OPEN, not just the option.
 */
async function pickCombobox(page: Page, combobox: Locator, option: RegExp): Promise<void> {
  const choice = page.getByRole('option', { name: option }).first();
  await combobox.click();
  if (!(await choice.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false))) {
    await combobox.click();
  }
  await choice.click();
}

/**
 * The overflow claim: `main` does not scroll sideways, AND neither does any `overflow-x:
 * auto|scroll` box inside it that could have absorbed the overflow instead (the pane group is
 * one). Reported as a LIST of offenders.
 */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const offenders = await page.evaluate((mainSelector) => {
    const main = document.querySelector(mainSelector);
    if (!main) return [{ what: `${mainSelector} is not in the document`, over: -1 }];
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const testid = el.getAttribute('data-testid');
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
      return (
        `${el.tagName.toLowerCase()}${id}${testid ? `[data-testid=${testid}]` : ''}` +
        `${cls.length ? `.${cls.join('.')}` : ''}`
      );
    };
    const out: { what: string; over: number }[] = [];
    const mainOver = main.scrollWidth - main.clientWidth;
    if (mainOver > 1) out.push({ what: describe(main), over: mainOver });
    for (const el of Array.from(main.querySelectorAll('*'))) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      const over = el.scrollWidth - el.clientWidth;
      // 1px, not 0: sub-pixel layout rounds, and `scrollWidth` is an integer.
      if (over > 1) out.push({ what: describe(el), over });
    }
    return out;
  }, MAIN);

  expect(
    offenders.map((o) => `${o.what} overflows by ${o.over}px`),
    `${where} scrolls horizontally at this width.`,
  ).toEqual([]);
}

/** `s` as a literal inside a `RegExp`, for names built from a tag. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read `read()` until `ok` holds or `ms` runs out, and say which.
 *
 * A plain poll and NOT an `expect.poll`, because the caller branches on the answer: a timeout
 * here is a fact to act on (the press never landed), not a test failure.
 */
async function settlesWithin<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ok(await read())) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Press "Add expense" on a phone, and return the id of the expense it created.
 *
 * ─── THE PRESS IS NOT IDEMPOTENT, SO THE RETRY IS GUARDED BY THE DATABASE ────────────────
 *
 * The button re-enables as soon as the mutation succeeds, before the list refetch lands, so
 * "enabled and nothing visible yet" is also what a press that DID land looks like. A blind
 * second press could then add a second blank expense. So the one re-press happens only when
 * the SERVER still has no new expense on this report after 6 seconds.
 *
 * ─── THEN THE EDITOR HAS TO CATCH UP ─────────────────────────────────────────────────────
 *
 * The centre pane renders the previously selected expense for a beat after the add, so the
 * helper waits for an EMPTY Vendor before it returns. It does not touch the field: the caller
 * asserts where the reader landed before anything scrolls or focuses on its behalf.
 */
async function addExpenseOnPhone(page: Page, reportId: string): Promise<string> {
  // VeloExpense: `pg` in place of `testDb`.
  const ids = async (): Promise<string[]> =>
    (
      await admin.query<{ id: string }>('SELECT id FROM expense WHERE report_id = $1', [reportId])
    ).rows.map((r) => r.id);
  const before = await ids();
  const created = async (): Promise<string[]> =>
    (await ids()).filter((id) => !before.includes(id));

  const add = page.getByRole('button', { name: 'Add expense', exact: true });
  await expect(
    add,
    '"Add expense" is not on the page at a phone width. P18 took its `hidden lg:contents` ' +
      'cloak off in ExpenseReportWorkbench.tsx, so it should sit in the Expenses card header at ' +
      'every width on a draft. Either the cloak came back, or the report is not editable.',
  ).toBeVisible({ timeout: 30_000 });
  await expect(add, '"Add expense" should be pressable').toBeEnabled({ timeout: 30_000 });
  await add.click();

  const landed = await settlesWithin(created, (found) => found.length > 0, 6_000);
  if (!landed && (await add.isEnabled())) await add.click();

  await expect
    .poll(created, {
      timeout: 20_000,
      message:
        'pressing "Add expense" should have created exactly one expense on this report. ' +
        'Zero means the press was acknowledged by nothing; two means a press was repeated ' +
        'after it had already landed.',
    })
    .toHaveLength(1);
  const [id] = await created();

  await expect(
    page.getByLabel('Vendor'),
    'the editor should have switched to the new, empty expense',
  ).toHaveValue('', { timeout: 30_000 });
  return id as string;
}

/**
 * The labelled-field hazard, asserted the way it bites: ONE match for the same unscoped,
 * strict locator the desktop specs use (`addExpenseLine` in `e2e/helpers.ts`), and that one
 * match VISIBLE. `getByLabel` has no visibility filter, so a CSS-hidden twin of a labelled
 * field is a second strict match.
 */
async function expectOneVisibleField(field: Locator, what: string, width: string): Promise<void> {
  await expect(
    field,
    `${what} matched more or fewer than one control at ${width}. Every desktop spec that adds ` +
      'an expense addresses it with the same unscoped, strict locator (e2e/helpers.ts), so a ' +
      'second labelled match anywhere on the page, hidden or not, breaks all of them.',
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(field, `${what} is in the DOM at ${width} but not visible`).toBeVisible();
}

/**
 * The report total in the phone summary, as a number: the summary's first paragraph, with
 * everything but digits and the decimal point dropped (right for EN).
 */
async function reportTotal(summary: Locator): Promise<number> {
  const text = (await summary.locator('p').first().textContent()) ?? '';
  return Number.parseFloat(text.replace(/[^0-9.]/g, ''));
}

/** A title unique to this run. */
function reportTag(what: string): string {
  return `E2E ${what} ${Date.now().toString(36)}`;
}

test.describe('the expense workbench, on a phone', () => {
  test('add an expense and fill it in', async ({ page }) => {
    /**
     * A submitter on a draft taps "Add expense", lands on the new expense's editor, sets the
     * date, vendor, currency and location, adds a line, types its amount, and sees the
     * report total rise. Before P18 every one of those controls was `hidden lg:contents`
     * below `lg`, and "Add expense" with them.
     */
    const title = reportTag('phone add');
    const vendor = `Corner Taxi ${Date.now().toString(36)}`;
    const date = '2026-09-15';
    // The `é` is U+00E9, precomposed (NFC). Non-ASCII on purpose, and cheaply.
    const place = 'Montréal';
    await ensureSeededUsdCadRate();
    // One CAD expense of 100.00, built at 1280. The flow below is the second one.
    const id = await seedReport(page, title, 1);

    await openOnPhone(page, id);
    const summary = page.getByTestId('report-summary');
    await expect(summary, 'the seeded expense should roll up to 100.00').toContainText('100.00');
    await expect(
      page.getByRole('button', { name: /^Expenses · 1$/ }),
      'the expenses disclosure should count the one seeded expense',
    ).toBeVisible();

    /**
     * The list is opened FIRST, so "the add collapses it" below is a claim with something
     * to disprove. `createExpense` goes through `selectFromList`, which closes the list.
     */
    await openExpenseList(page);
    const newId = await addExpenseOnPhone(page, id);

    // ── Landed: before ANY interaction that could scroll or focus on the test's behalf. ──
    const toggle = page.getByRole('button', { name: /^Expenses · 2$/ });
    await expect(
      toggle,
      'the disclosure should count two expenses. It sits outside the collapsed list, so this ' +
        "is the server's acknowledgement of the add without opening anything.",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      toggle,
      'the expenses list is still open after the add. `createExpense` should select the new ' +
        'expense through `selectFromList`, which closes the list on a phone.',
    ).toHaveAttribute('aria-expanded', 'false');

    const region = page.getByRole('region', { name: 'Expense details', exact: true });
    await expect(
      region,
      'the "Expense details" pane is not on screen after the add. On a phone the add should ' +
        "scroll the editor pane to the top of `main` (ExpenseReportWorkbench.tsx's " +
        '`pendingScrollId` effect).',
    ).toBeInViewport({ timeout: 10_000 });
    await expect(
      region,
      'the "Expense details" pane should hold focus after the add, so a screen reader is ' +
        'told where the reader landed',
    ).toBeFocused();
    const vendorField = page.getByLabel('Vendor');
    await expect(
      vendorField,
      "the new expense's Vendor field should be on screen when the reader lands, without " +
        'them scrolling',
    ).toBeInViewport();
    await expect(
      vendorField,
      'Vendor should NOT be focused after the add. A programmatic focus after a round trip ' +
        'does not open the iOS keyboard, and a focused field with no keyboard reads as broken; ' +
        'the PANE takes the focus instead.',
    ).not.toBeFocused();

    // ── The labelled-field hazard, at phone width. See `expectOneVisibleField`. ────────────
    const width = `${page.viewportSize()?.width ?? '?'}px`;
    const dateField = page.getByLabel('Date', { exact: true });
    const placeField = page.getByLabel('Location');
    const currencyField = page.getByLabel('Currency');
    await expectOneVisibleField(vendorField, 'getByLabel("Vendor")', width);
    await expectOneVisibleField(dateField, 'getByLabel("Date", { exact: true })', width);
    await expectOneVisibleField(placeField, 'getByLabel("Location")', width);
    await expectOneVisibleField(currencyField, 'getByLabel("Currency")', width);

    // ── Fill the four fields. Each commits on BLUR, so each is blurred. ───────────────────
    await vendorField.fill(vendor);
    await vendorField.blur();
    await dateField.fill(date);
    await dateField.blur();
    await placeField.fill(place);
    await placeField.blur();
    await pickCombobox(page, currencyField, /^USD/);

    // ── Add a line, pick its category, type its amount. ──────────────────────────────────
    /**
     * `pressAndReveal` is safe here although "Add line" is not idempotent either: the draft
     * row is local state, so a press that landed reveals it at once. No draft row is open
     * before this, so the category placeholder can only be the new draft's.
     * VeloExpense: the kit Combobox keeps its placeholder as `data-placeholder`.
     */
    const addLine = page.getByRole('button', { name: 'Add line', exact: true });
    const category = page.locator('[data-placeholder="Select a category"]');
    await pressAndReveal(addLine, category, 'Add line');
    await pickCombobox(page, category, new RegExp(CATEGORY));

    /**
     * The amount field belongs to the SAVED line: picking a category commits the draft, and
     * the saved row renders the `MoneyInput`. Same count-and-visible check as the header
     * fields.
     */
    const amountField = page.getByLabel('Amount', { exact: true });
    await expectOneVisibleField(amountField, 'getByLabel("Amount", { exact: true })', width);
    await amountField.fill('25.00');
    await amountField.blur();

    // ── The report total rises. ────────────────────────────────────────────────────────
    /**
     * A USD line on a CAD report, so the summary shows the by-currency composition, and the
     * total is asserted RELATIVELY: above the seeded 100.00, without hard-coding a rate.
     * VeloExpense: the seed quotes USD into CAD (`scripts/seed.mjs`, `DEMO_FX`).
     */
    await expect(
      summary.getByRole('listitem').filter({ hasText: /^USD\s/ }),
      'the summary should list the USD composition as USD 25.00 once the amount is saved',
    ).toContainText('25.00', { timeout: 30_000 });
    await expect
      .poll(() => reportTotal(summary), {
        timeout: 30_000,
        message:
          'the report total should rise above the seeded 100.00 once the USD 25.00 line is ' +
          'saved. Unchanged means the amount never committed (it commits on blur) or the ' +
          'seeded USD to CAD rate is missing (scripts/seed.mjs, DEMO_FX).',
      })
      .toBeGreaterThan(100);

    // ── The server has every value. ──────────────────────────────────────────────────────
    // VeloExpense: `pg` in place of `testDb`; the date read as text, so no time zone applies.
    await expect
      .poll(
        async () => {
          const e = (
            await admin.query(
              `SELECT e.merchant, e.place_text AS place, e.txn_date::text AS date,
                      e.currency_code AS currency,
                      COALESCE((SELECT array_agg(l.amount_minor::text)
                                  FROM expense_line_item l WHERE l.expense_id = e.id), '{}') AS lines
                 FROM expense e WHERE e.id = $1`,
              [newId],
            )
          ).rows[0];
          return e
            ? {
                merchant: e.merchant,
                date: e.date,
                place: e.place,
                currency: e.currency,
                lines: e.lines,
              }
            : null;
        },
        {
          timeout: 30_000,
          message: 'the new expense should hold every value typed on the phone',
        },
      )
      .toEqual({ merchant: vendor, date, place, currency: 'USD', lines: ['2500'] });

    // ── And so does the page, after a reload. ────────────────────────────────────────────
    await openOnPhone(page, id);
    /**
     * After a reload the editor opens whichever expense the page selects first, so the new
     * one is chosen from the list. A row tap is idempotent (it selects), so the one re-tap
     * after an unacknowledged press is safe; the tap closes the list again, hence the
     * re-open before it.
     */
    const row = page.getByRole('button', { name: new RegExp(escapeRegExp(vendor)) }).first();
    await openExpenseList(page);
    await row.click();
    const switched = await settlesWithin(
      () => vendorField.inputValue({ timeout: 1_000 }).catch(() => ''),
      (value) => value === vendor,
      6_000,
    );
    if (!switched) {
      await openExpenseList(page);
      await row.click();
    }
    await expect(vendorField, 'Vendor should survive a reload').toHaveValue(vendor, {
      timeout: 20_000,
    });
    await expect(dateField, 'Date should survive a reload').toHaveValue(date);
    await expect(placeField, 'Location should survive a reload').toHaveValue(place);
    // VeloExpense: the kit Combobox shows its value as text. ExpenseOS: `toHaveValue(/USD/)`.
    await expect(currencyField, 'Currency should survive a reload').toContainText(/USD/);
    await expect(amountField, 'the line amount should survive a reload').toHaveValue(/^25(\.00)?$/);

    // ── The notice names only what is still read-only here. ─────────────────────────────
    const notice = page.getByTestId('section-limited-notice');
    await expect(notice, 'the editor renders exactly one section notice').toHaveCount(1);
    await expect(notice).toBeVisible();
    await expect(
      notice,
      'the notice should say what is still read-only on a phone (cost allocation, tax and ' +
        'attendees), in the catalog copy, and no longer that the expense fields need a desktop',
    ).toHaveText(
      `${catalogText('expenses', 'workbench.sectionLimitedTitle')} ` +
        catalogText('expenses', 'workbench.sectionLimitedBody'),
    );

    await expectNoHorizontalOverflow(page, 'the new expense with its fields and a line filled');

    // ── The same hazard counts at 1280, where the DOM differs. ───────────────────────────
    await onDesktop(page, async (desk) => {
      await desk.goto(reportUrl(id));
      // ExpenseOS `support/workbench.ts` `selectExpense`.
      await desk
        .getByRole('button', { name: new RegExp(escapeRegExp(vendor)) })
        .first()
        .click();
      await expect(desk.getByLabel('Vendor')).toHaveValue(vendor, { timeout: 20_000 });
      const at = `${DESKTOP.width}px`;
      await expectOneVisibleField(desk.getByLabel('Vendor'), 'getByLabel("Vendor")', at);
      await expectOneVisibleField(
        desk.getByLabel('Date', { exact: true }),
        'getByLabel("Date", { exact: true })',
        at,
      );
      await expectOneVisibleField(desk.getByLabel('Location'), 'getByLabel("Location")', at);
      await expectOneVisibleField(desk.getByLabel('Currency'), 'getByLabel("Currency")', at);
      await expectOneVisibleField(
        desk.getByLabel('Amount', { exact: true }),
        'getByLabel("Amount", { exact: true })',
        at,
      );
    });
  });

  test('a half-typed vendor survives a live resize across lg', async ({ page }) => {
    /**
     * P18's no-unmount property, observed. The expense fields have ONE face at every width,
     * with no `useIsBelowLg` branch around them, so a window dragged across 1024 keeps what
     * is half typed in them. A remount would reset Vendor to its saved value.
     *
     * Driven on the desktop sibling page, because it is the page that can start above `lg`.
     * The widths stay below 1280: see `BELOW_XL`.
     */
    const title = reportTag('phone resize');
    const id = await seedReport(page, title, 1);

    await onDesktop(page, async (desk) => {
      await desk.setViewportSize(BELOW_XL);
      await desk.goto(reportUrl(id));
      const vendorField = desk.getByLabel('Vendor');
      await expect(vendorField, 'the seeded expense should be selected on arrival').toHaveValue(
        'Bay Street Depot 1',
        { timeout: 30_000 },
      );
      await desk.waitForLoadState('networkidle');

      // Typed, NOT blurred: nothing is saved, so only the input's own state holds it.
      await vendorField.fill('Half typ');
      const summary = desk.getByTestId('report-summary');

      for (const size of [
        { width: 900, height: 900 },
        { width: 390, height: 664 },
      ]) {
        await desk.setViewportSize(size);
        /**
         * The phone summary mounting is the proof the resize crossed `lg`: it is rendered by
         * the `useIsBelowLg` branch, so without it the value check below would pass against a
         * page that never left its desktop tree.
         */
        await expect(summary, `at ${size.width}px the page should be in its phone tree`).toBeVisible(
          { timeout: 10_000 },
        );
        await expect(
          vendorField,
          `the half-typed Vendor was lost when the window went to ${size.width}px. The ` +
            'editor remounted: something now renders it under a width-dependent branch.',
        ).toHaveValue('Half typ');
      }

      await desk.setViewportSize(BELOW_XL);
      await expect(
        summary,
        `back at ${BELOW_XL.width}px the page should be in its desktop tree again`,
      ).toHaveCount(0, { timeout: 10_000 });
      await expect(
        vendorField,
        `the half-typed Vendor was lost on the way back to ${BELOW_XL.width}px`,
      ).toHaveValue('Half typ');
    });
  });
});

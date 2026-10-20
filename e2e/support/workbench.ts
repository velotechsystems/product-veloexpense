import { expect, type Page } from '@playwright/test';
import { receiptFile } from '../fixtures/receiptImage';
import { pickCombobox } from './combobox';

/**
 * VeloExpense: ExpenseOS's `e2e/support/workbench.ts` (1e682dd6), ported with its phone specs.
 * One change, marked below: the category picker is found by `data-placeholder`. VeloExpense's
 * older desktop specs keep their own `createDraftReport` / `addExpenseLine` in
 * `e2e/helpers.ts`.
 *
 * Driving the expense workbench, for the specs that are about what the ENGINES do.
 *
 * `e2e/expense-lifecycle.spec.ts` keeps its own local versions of these on purpose: it is
 * about the state machine, and the shape of the flow is part of what it asserts. The tax,
 * FX, policy and per-diem specs are about the arithmetic and the refusals, so the flow
 * itself is scaffolding — and duplicating scaffolding across four files is how four files
 * end up drifting from the product one at a time.
 *
 * Nothing here is a shortcut past the UI. Every field is filled the way a person fills it,
 * because the traps are all in the filling:
 *
 *   · **The editor lags the click.** "Add expense" creates a row and selects it, but the
 *     centre pane is still rendering the PREVIOUS expense for a beat. Typing into `Vendor`
 *     straight away writes the vendor onto the wrong expense — which is not a crash, it is
 *     a report where the $100 USD dinner is called "Home Depot" and the assertion two steps
 *     later blames FX. Waiting for the field to be EMPTY is the only signal that the editor
 *     has caught up.
 *   · **The amount field does not exist until a category is chosen**, because it is
 *     rendered by that category's own line-kind strategy.
 *   · **The amount commits on BLUR.** Filled and not blurred, the line stays at $0.00 while
 *     the screen shows the number that was typed.
 */

/** Unique per test, so rows never collide across specs, workers or reruns. */
export function reportTag(what: string): string {
  return `E2E ${what} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** Create a draft report and land on its workbench. Returns its id. */
export async function createReport(page: Page, title: string, currency?: RegExp): Promise<string> {
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'New report' }).first().click();
  // `.first()`: a closed drawer elsewhere in the tree also matches `dialog`.
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  /**
   * The currency is left alone unless a spec needs it. It defaults to the filer's
   * (`expenses.defaultCurrency`, ExpenseOS 67db2e33 #581: their legal entity's, else the
   * tenant's main entity's, else CAD — CAD for every seeded QA account), and the only
   * reason to touch it is the FX spec's
   * missing-rate case — a report denominated in USD holding a CAD expense, which is the
   * one direction the seeded rate table cannot answer.
   */
  if (currency) await pickCombobox(page, dialog.getByLabel(/currency/i), currency);
  await dialog.getByRole('button', { name: 'Create report' }).click();

  await page.waitForURL(/\/expenses\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Submit report' })).toBeVisible();
  const id = page.url().match(/expenses\/([0-9a-f-]{36})/)?.[1];
  if (!id) throw new Error(`could not read a report id out of ${page.url()}`);
  return id;
}

export interface ExpenseSpec {
  vendor: string;
  amount: string;
  /** Matched against the option text in the category combobox, e.g. /Office Supplies/. */
  category: RegExp;
  /** ISO `YYYY-MM-DD`. Omitted leaves today, which is what the server defaults. */
  date?: string;
  /** Free text; this is what per-diem city matching reads. */
  place?: string;
  /** Matched against the currency combobox option, e.g. /USD/. */
  currency?: RegExp;
  /**
   * Attach one. Every seeded category inherits `receiptRequired`, so an expense WITHOUT a
   * receipt carries two BLOCKING violations — which is a deliberate scenario for the
   * refusal spec and an accident everywhere else.
   */
  receipt?: boolean;
}

/** Add one expense with one line to the open report. */
export async function addExpense(page: Page, spec: ExpenseSpec): Promise<void> {
  await page.getByRole('button', { name: 'Add expense' }).first().click();

  const vendor = page.getByLabel('Vendor');
  await expect(vendor, 'the editor should have switched to the new expense').toHaveValue('', {
    timeout: 30_000,
  });
  await vendor.fill(spec.vendor);
  await vendor.blur();

  if (spec.date) {
    const date = page.getByLabel('Date', { exact: true });
    await date.fill(spec.date);
    await date.blur();
  }
  if (spec.place) {
    const place = page.getByLabel('Location');
    await place.fill(spec.place);
    await place.blur();
  }
  if (spec.currency) await pickCombobox(page, page.getByLabel('Currency'), spec.currency);

  await page.getByRole('button', { name: 'Add line', exact: true }).first().click();
  // VeloExpense: the kit Combobox is a button that keeps its placeholder as
  // `data-placeholder` (ExpenseOS: an input with a `placeholder`).
  await pickCombobox(page, page.locator('[data-placeholder="Select a category"]').last(), spec.category);

  const amount = page.getByLabel('Amount', { exact: true });
  await amount.fill(spec.amount);
  await amount.blur();

  if (spec.receipt !== false) {
    /**
     * The LAST file input is the expense's own "Attach receipt". The first is the
     * report-level uploader, which creates a NEW expense from the receipt instead.
     *
     * THIS ORDINAL RESTS ON A POINTER-TYPE ASSUMPTION AS OF P04. Each of the four
     * receipt-upload entry points renders a SECOND file input — a
     * `capture="environment"` camera control — whenever the primary pointer is
     * coarse. Playwright's desktop Chromium reports a fine pointer, so today every
     * entry point renders exactly one input and every ordinal in the suite means
     * what it says.
     *
     * BE PRECISE ABOUT WHAT A COARSE POINTER WOULD ACTUALLY BREAK HERE, because
     * the obvious guess is wrong and sends you hunting a bug that does not exist.
     * The camera control is emitted BEFORE its picker, so the page-wide LAST file
     * input is the last entry point's *library* control at either pointer type —
     * `.last()` survives a coarse-pointer pair, and would have survived a
     * CSS-hidden one too. What is at risk is a `.first()` or an `nth()` ordinal on
     * a page that carries a receipt entry point, and there are none today: this
     * suite's nine file-input locators are eight `.last()` calls (this one plus
     * `expense-lifecycle.spec.ts:96`, `no-manager-approval.spec.ts:63`,
     * `qa-extraction.spec.ts:94`, `expense-policy-refusals.spec.ts:183`,
     * `assistant-actions.spec.ts:73`, `card-operations.spec.ts:522`,
     * `topbar-overlap.spec.ts:474`) plus one `.first()` at
     * `card-operations.spec.ts:290`, which uploads an `.xlsx` card workbook on the
     * admin card-import route and so has no receipt entry point anywhere near it.
     * That is reasoned from DOM order, not observed: the Playwright specs did not
     * run in the build that landed P04.
     *
     * None of that is a reason to relax the invariant that the camera control is
     * absent from the DOM at a fine pointer rather than hidden. Keeping it in JS
     * buys a global property — no page-wide ordinal anywhere in this suite can
     * shift, whatever ordinal a spec happens to use — instead of a per-call-site
     * audit of which ordinals survive by accident of DOM order. It holds without
     * anyone re-deriving `.first()`-versus-`.last()` reasoning at nine sites, and
     * it keeps holding when the tenth is written by someone who has never read
     * this file. See
     * `docs/adr/0003-coarse-pointer-affordances-are-js-gated-css-sized.md`.
     *
     * Re-anchoring these locators onto something that is not an ordinal belongs to
     * whoever adds the mobile project; it is not P04's work.
     */
    await page.locator('input[type=file]').last().setInputFiles(receiptFile());
  }

  /**
   * Wait until the SIDEBAR carries the amount, which means the server does.
   *
   * Everything above is fire-and-forget from the browser's point of view: the amount
   * commits on blur and the next `Add expense` click swaps the editor out from under the
   * request. Returning here without waiting made a three-expense trip come out as two
   * expenses and a $0.00 one — and the arithmetic that followed was wrong by exactly one
   * day's spend, which reads as a per-diem bug rather than as a line that never saved.
   *
   * The row is the right acknowledgement rather than the input's own value: the input
   * shows what was typed whether or not anything was written, and the list re-renders off
   * the report query.
   */
  const shown = Number(spec.amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  await expect(
    page.getByRole('button', { name: new RegExp(spec.vendor) }).first(),
    `the ${spec.vendor} row should show ${shown} once the line is saved`,
  ).toContainText(shown, { timeout: 30_000 });
}

/** Open an expense in the centre pane by the vendor shown on its row. */
export async function selectExpense(page: Page, vendor: string): Promise<void> {
  await page
    .getByRole('button', { name: new RegExp(vendor) })
    .first()
    .click();
  await expect(page.getByLabel('Vendor')).toHaveValue(vendor, { timeout: 20_000 });
}

/**
 * The expenses pane's title, below `lg`, where it is also the way in and out of the list.
 *
 * `workbench.expensesToggle` is an ICU plural with three arms — `=0 {Expenses}`,
 * `one {Expenses · #}`, `other {Expenses · #}` — so the count is OPTIONAL in the name and the
 * zero arm is a different string rather than "· 0". Anchored at both ends so it cannot also
 * match the `drawer.expenses` heading text a desktop renders, which is the plain word.
 */
const EXPENSE_LIST_TOGGLE = /^Expenses(\s·\s\d+)?$/;

/**
 * Open the below-`lg` expense list, and leave it open.
 *
 * ─── WHY ANY OF THIS IS NEEDED ──────────────────────────────────────────────────────────
 *
 * Below `lg` the expenses pane is a DISCLOSURE and it is COLLAPSED ON ARRIVAL
 * (`ExpenseReportWorkbench.tsx:969`, `useState(false)`). Every row, every row checkbox and
 * the paperclip that opens the receipt sheet live inside a container the branch gives
 * `hidden` to (`:2614-2618`), so on a phone none of them is in the accessibility tree, none
 * of them is hit-testable, and none of them can be censused — until this runs. A spec written
 * against the pre-disclosure page addresses controls that are `display: none`, which reads as
 * "the row never rendered" and points at the query rather than at the pane.
 *
 * AND IT SHUTS AGAIN THE MOMENT SOMETHING IS PICKED. `selectFromList` (`:979-982`) is the one
 * path both row affordances take and it calls `setExpensesListOpen(false)` unconditionally —
 * a tap selects the expense AND collapses the list, deliberately, so the editor a phone has
 * just been sent to is not underneath a list. So this is not a once-per-test call: anything
 * that needs a SECOND row has to re-open first, and that is what makes this idempotent rather
 * than a bare press.
 *
 * ─── IDEMPOTENT, AND ON THE CONTROL'S OWN STATE ─────────────────────────────────────────
 *
 * `aria-expanded` is read rather than remembered, so a caller that does not know whether the
 * last tap collapsed the list can call this unconditionally.
 *
 * WHAT IT IS NOT is tolerant of the button being ABSENT, and that distinction cost a red run.
 * An earlier version returned quietly when the toggle was not on the page, on the reasoning
 * that above `lg` the heading is plain text and there is no button to press. But both callers
 * are phone-only specs, and the state that actually hit was the PRE-HYDRATION tree: the server
 * render always emits the desktop shape (`useIsBelowLg`'s `getServerSnapshot` is `() => false`),
 * so a call made before the client tree commits found no button, returned having done nothing,
 * and its caller then censused a list that was still shut — reported as the pane having no
 * controls in it. So the toggle is WAITED FOR instead. That is the same wait `openOnPhone`
 * makes on `report-summary` and for the same reason, and a caller that reaches a desktop width
 * with this has a bug rather than a case to accommodate.
 *
 * ─── THE ACKNOWLEDGEMENT, BECAUSE THE PHONE PROJECTS RUN `retries: 0` ───────────────────
 *
 * Neither settle helper fits this press. `pressAndSettle` waits for the control to DETACH and
 * this one stays on screen; the list is only ever suppressed, never unmounted, so waiting for
 * it to ATTACH would be satisfied before the first tap. Both halves are therefore asserted —
 * the control's own `aria-expanded` AND the list being visible — because either alone is
 * satisfied by a build where the button toggles state and the class never comes off, or the
 * reverse.
 *
 * The one retry is `pressAndSettle`'s rule, for its reason: React re-renders this pane as the
 * report query settles, so a click can land on a node that has already been replaced and the
 * browser reports a successful click on a detached listener. Re-pressing is safe only while
 * the control still reads `aria-expanded="false"` — if it flipped, the press landed and a
 * second one would CLOSE the list again.
 */
export async function openExpenseList(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: EXPENSE_LIST_TOGGLE }).first();
  await expect(
    toggle,
    'the below-`lg` expenses disclosure never appeared. Its label is ' +
      '`workbench.expensesToggle`, and the heading only renders a button on the `isBelowLg` ' +
      'branch — so this is either a page that has not hydrated yet (the server tree is always ' +
      'the desktop one), a phone width at which `useIsBelowLg` answered false, or a build that ' +
      'reverted the disclosure to a plain heading. See ExpenseReportWorkbench.tsx:2418-2444.',
  ).toBeEnabled({ timeout: 30_000 });

  if ((await toggle.getAttribute('aria-expanded')) === 'true') return;

  /**
   * The list is found through the control's own `aria-controls` rather than by its id.
   * The relationship is the thing the product maintains for a screen reader; addressing it
   * here means a renamed `EXPENSE_LIST_ID` moves both ends at once, and a DROPPED
   * `aria-controls` fails right here with the accessibility defect named, instead of as a
   * mystery timeout on a selector nothing points at any more.
   */
  const listId = await toggle.getAttribute('aria-controls');
  expect(
    listId,
    'the expenses disclosure has no `aria-controls`, so nothing says which region it opens — ' +
      'a screen-reader defect in its own right, and this helper has no list to wait for.',
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
    'pressing the expenses disclosure did not expand it — `aria-expanded` is still "false". ' +
      'The press was acknowledged by nothing.',
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(
    list,
    'the expenses disclosure reports itself expanded and the list it controls is still not ' +
      'visible. `aria-expanded` and the `hidden` class on the list container have come apart ' +
      '— they are two reads of the same `expensesListOpen` state and must agree.',
  ).toBeVisible({ timeout: 20_000 });
}

import { expect, type Locator, type Page, test } from '@playwright/test';
import { pressAndSettle } from './support/actions';
import { signIn, switchTo } from './support/actors';
import { expectRowEventually, rowFor } from './support/rows';
import { trpcOk, trpcQueryOk } from './support/trpc';

/**
 * The travel request, from nothing to decided — and every way it can end instead.
 *
 * Three things here only exist end to end, and none of them had any coverage:
 *
 *   · **the budget, which is now advice and not a gate.** Per-diem pricing reads
 *     `PerDiemRate` and matches the destination as a substring; three pieces have to line
 *     up before a trip prices at all, and until this spec existed nothing checked that
 *     they did. (They didn't: the table was seeded empty, so nothing priced in a fresh
 *     environment — and back then that ALSO meant nothing could be submitted, because
 *     `Submit for approval` was disabled without budget lines. It is not any more: the
 *     panel warns and the press still works.)
 *   · **planned items.** Anything no provider can price — a department meal, a rental car
 *     (there is no car engine anywhere on the travel integration) — is entered by hand
 *     against an EXPENSE CATEGORY and lands in the same budget as a `Planned` line.
 *   · **the handoff.** A trip is submitted by the traveller and decided by their manager.
 *   · **the state machine.** DRAFT → SUBMITTED → {APPROVED, REJECTED, RETURNED}, plus the
 *     traveller's own withdrawal.
 *
 * The destination is deliberately free text with a unique suffix — "Toronto <tag>".
 * Per-diem matching is a substring, so `Toronto` still prices while the suffix keeps every
 * row identifiable in a shared database.
 *
 * This used to say the city picker "needs a Maps integration that a local or CI environment
 * does not have". That stopped being true the moment `GOOGLE_PLACES_API_KEY` was read from
 * the environment, and three tests here went red — not because free text stopped being
 * accepted, but because the autocomplete branch of `CityPicker` discarded anything typed
 * that was never picked from the list. An assumption about the environment had been holding
 * a real bug out of reach; the fix is in the component, and free text still works.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Longer than the 45s default, because these flows are long by nature: create, price,
 * submit, sign out, sign in as the approver, decide, sign back. Six navigations and two
 * authentications before the assertion that matters, and the default budget left no room
 * for the polling that makes them deterministic.
 */
test.describe.configure({ timeout: 150_000 });

/** Unique per test, so rows never collide across specs, workers, or reruns. */
function tripTag(what: string): string {
  return `E2E-${what}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/**
 * Create a draft trip and open it.
 *
 * `destination` is what decides whether it can be priced at all: "Toronto" matches a
 * seeded `PerDiemRate` city as a substring, anything else matches nothing. `includeCar`
 * ticks the rental-car box, which is the flag the drawer warns about — nothing quotes car
 * hire, so it produces no budget line on its own.
 */
/**
 * Set a native date field: click it first, then fill.
 *
 * The CLICK is the part that matters. `fill()` alone assigns `.value` and dispatches no
 * click, which is how this suite stayed green for four months while every date field in
 * the product was unusable by mouse — the shared `Input` stretched WebKit's
 * calendar-picker indicator across the whole field as an invisible overlay.
 *
 * Typing the digits instead was tried and does not work: `pressSequentially` does not
 * populate a native date input's segments in headless Chromium, so it emptied every trip
 * in this file. And it would not have guarded the bug anyway — with the overlay back,
 * `fill()` succeeds regardless, because it never goes near the pointer.
 *
 * The overlay itself is asserted directly in "the date field is not covered by an
 * invisible overlay" below, which reads the pseudo-element's COMPUTED STYLE in a real
 * browser. That is the only check that can see it: jsdom does not implement
 * `::-webkit-calendar-picker-indicator` at all.
 */
/**
 * A date relative to today, never a literal.
 *
 * `2026-10-01` was comfortably in the future when it was written and expires on its own.
 * Travel pricing REFUSES a departure that has already passed — that is the point of
 * `isPastDate` — so a literal here is a suite that goes green until the date arrives and
 * then fails for a reason with nothing to do with the code under test. The same literals
 * in `travelOptions.test.ts` failed twelve unit tests the day that guard landed.
 */
const dayFromNow = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function setDate(field: Locator, iso: string): Promise<void> {
  await field.click();
  await field.fill(iso);
  await expect(field).toHaveValue(iso);
}

async function createTrip(
  page: Page,
  tag: string,
  opts: { destination?: string; includeCar?: boolean } = {},
): Promise<void> {
  await page.goto('/travel');
  await page.getByRole('button', { name: 'New travel request' }).first().click();

  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Why this trip is necessary').fill(`Trip for ${tag}`);

  // "Toronto" is what per-diem matches; the tag is what makes the row findable.
  const cities = dialog.getByLabel('Search for a city');
  await cities.nth(0).fill(`${opts.destination ?? 'Toronto'} ${tag}`);
  await cities.nth(1).fill('Vancouver');

  const dates = dialog.locator('input[type=date]');
  await setDate(dates.nth(0), dayFromNow(30));
  await setDate(dates.nth(1), dayFromNow(34));

  /**
   * Clicked by its LABEL TEXT, not `getByLabel(...).check()`.
   *
   * The control is a Base UI checkbox — a `<button role=checkbox>` inside a wrapping
   * `<label>` — so there is no `for`/`id` pair and no input for `.check()` to act on.
   * Clicking the label toggles it, which is what a person does.
   */
  if (opts.includeCar) await dialog.getByText('Include a rental car').click();

  /**
   * The create is AWAITED before anything navigates.
   *
   * `expectRowEventually` below starts with `page.goto('/travel')`. Fired the instant after
   * the click, that navigation tears down the page while `travelRequests.create` is still
   * in flight; the browser aborts the fetch, the fetch adapter cancels the procedure, and
   * the server logs `[tRPC] travelRequests.create: aborted` under a `200` — no row is ever
   * written. It came down to request latency against navigation timing, and it lost often
   * enough to reproduce in isolation. So: arm the response wait BEFORE the click (after is a
   * race of its own), then require the drawer to close, which is what `onSuccess` does and
   * the only signal the UI itself gives that the request landed.
   *
   * `httpBatchLink` is not a streaming link, so a completed response means the procedure
   * completed — the commit is done by the time the body arrives.
   */
  const created = page.waitForResponse(
    (r) => r.url().includes('/api/trpc/travelRequests.create') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create' }).click();
  const response = await created;
  expect(response.ok(), `travelRequests.create answered HTTP ${response.status()}`).toBe(true);
  await expect(dialog, 'the create drawer did not close after the request landed').toBeHidden();
  /**
   * Polled with reloads, not asserted once.
   *
   * A bare `toBeVisible` here reads the page that was rendered BEFORE the create, and the
   * travel list only fetches on navigation — so as the shared database accumulated trips
   * from earlier runs this became a race it eventually lost, reporting "element(s) not
   * found" for a trip that had been created perfectly well.
   */
  await expectRowEventually(page, '/travel', tag, /Draft/i);

  await openTrip(page, tag);
}

/** A priced draft trip, left open in its drawer. Returns nothing — the tag identifies it. */
async function createPricedTrip(page: Page, tag: string): Promise<void> {
  await createTrip(page, tag);
  await priceTrip(page);
}

/**
 * Add a planned item, and wait for it to be IN the budget.
 *
 * ## The form strip is gone
 *
 * There used to be one pinned above the list — `#trv-planned-category`, an amount, a note
 * and an "Add to budget" button — and this file still addressed it by those ids after the
 * strip was replaced, so every planned-item test here was addressing elements that no
 * longer render.
 *
 * A row is added the way an expense line is: press the button, a DRAFT row appears already
 * shaped like the row it will become, and **picking the category is the save**. So the
 * amount and the note are typed FIRST — they ride along with the create — and the category
 * comes last.
 *
 * ## Addressing the draft rather than a saved row
 *
 * The draft renders after the saved stack, and its fields are labelled differently on
 * purpose: a draft's amount is "Amount", a saved line's is "Override amount". Notes share
 * a label, so the draft's is the LAST one on screen.
 *
 * Waits on the LINE, not on the press. The drawer re-reads the request from the list query
 * after the mutation, so the row appearing is the only thing that says the write landed;
 * asserting straight after the click passes against the pre-write render.
 */
async function addPlannedItem(
  page: Page,
  category: RegExp,
  amount: string,
  note: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Add a planned budget item' }).click();
  const draft = page.getByLabel('Amount', { exact: true }).last();
  await expect(draft, 'the draft row should be open').toBeVisible({ timeout: 30_000 });
  await draft.fill(amount);
  await page.getByLabel('Notes', { exact: true }).last().fill(note);
  await pickPlannedCategory(page, category);

  await expect(lineDetail(page, note), 'the line should be in the budget').toHaveCount(1, {
    timeout: 30_000,
  });
}

/**
 * The saved line whose notes say `note`, addressed by INPUT VALUE.
 *
 * `getByText` used to find it, because the traveller's note was rendered as a caption. It
 * is an editable field now — the notes are the traveller's own words, and a policy rule
 * can require it — and `getByText` does not see an input's value, so the old assertion
 * timed out for 30 seconds on a line that had been added perfectly well.
 *
 * A locator rather than a boolean so callers can count it: 0 after a removal, 1 after an
 * add, which is what makes both directions assertable.
 *
 * No draft to exclude: a draft is discarded the moment its create succeeds, so the only
 * row left holding this text is the saved one.
 */
function lineDetail(page: Page, note: string) {
  return page
    .locator('input[aria-label="Notes"]')
    .and(page.locator(`[value="${note.replace(/"/g, '\\"')}"]`));
}

/**
 * Choose a category on the open draft row — which is what CREATES the line.
 *
 * This is the fix for a real flake — roughly one run in six, reproducible serially on a
 * freshly reset database, so neither parallel contention nor accumulated data. The options
 * render in a portal from a Base UI Select, so a click that arrives before the option has
 * its handler attached is swallowed silently and nothing at all happens.
 *
 * So the signal is the DRAFT DISAPPEARING: the row is replaced by the saved line the
 * moment the create succeeds, and no stale state can satisfy that. A swallowed click costs
 * one retry instead of the whole test's timeout.
 */
async function pickPlannedCategory(page: Page, category: RegExp): Promise<void> {
  const trigger = page.getByLabel('Category', { exact: true }).last();
  const draftAmount = page.getByLabel('Amount', { exact: true });
  const before = await draftAmount.count();

  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await trigger.click();
    const option = page.getByRole('option', { name: category });
    await expect(option.first(), `the picker should offer ${category}`).toBeVisible({
      timeout: 20_000,
    });
    await option.first().click();
    try {
      // Short on purpose. The create is in flight once the click lands, so a few seconds
      // of grace distinguishes "slow" from "swallowed" — and waiting 30s here would just
      // reinstate the timeout this helper exists to avoid.
      await expect(draftAmount).toHaveCount(before - 1, { timeout: 5_000 });
      return;
    } catch (e) {
      if (attempt === ATTEMPTS) {
        throw new Error(
          `the ${category} option was clicked ${ATTEMPTS} times and the draft row never ` +
            `became a line — the Select's portal is swallowing the click: ${String(e)}`,
        );
      }
    }
  }
}

/**
 * Open a trip from the list.
 *
 * Anchored on "Add a planned budget item", which the drawer offers only on an EDITABLE
 * trip.
 *
 * Three earlier anchors are gone: "Recalculate per diem" (phase 8 removed the re-price),
 * "Get live prices" (the bulk quote path went when the per-line pickers replaced it) and
 * "Add to budget" (the add-line form strip became a draft ROW). This one is the button
 * that opens a row, which is where a traveller starts on every trip.
 */
async function openTrip(page: Page, tag: string): Promise<void> {
  const row = rowFor(page, tag);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByRole('button', { name: 'Add a planned budget item' })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Put a priced line on the open trip.
 *
 * Phase 8 removed the auto-built budget: a new trip has NO lines, and pricing one means
 * adding a line and letting the SERVER derive its amount. Which is the assertion this
 * helper carries for every test that uses it — the amount field is left BLANK, so a line
 * that comes back with a figure on it proves the per-diem derivation ran end to end.
 *
 * Per diem rather than live prices on purpose: a provider search spends a SerpApi credit
 * and needs a key no test environment has, while per-diem is arithmetic over seeded rates.
 */
async function priceTrip(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add a planned budget item' }).click();
  // Deliberately no amount typed: the server derives the allowance for the destination.
  // Picking the category is what files the line.
  await pickPlannedCategory(page, /Meals/);
  await expect(page.getByRole('button', { name: 'Submit for approval' }).first()).toBeEnabled({
    timeout: 30_000,
  });
}

/**
 * Submit the open trip, and wait for the press to have LANDED.
 *
 * Not belt-and-braces. The drawer re-renders as pricing settles, so a click can arrive at
 * a node React has already replaced — the click reports success, nothing is submitted, and
 * the failure surfaces 20 seconds later as "the list still says Draft", which looks like a
 * broken mutation rather than a lost click. Observed exactly once in four runs.
 *
 * The signal is the button itself: once the request is SUBMITTED the drawer stops offering
 * to submit it.
 */
async function submitTrip(page: Page): Promise<void> {
  await pressAndSettle(page, 'Submit for approval');
}

/** What the travel list says about a trip, once the server agrees. */
async function expectStatus(page: Page, tag: string, status: RegExp): Promise<void> {
  await expectRowEventually(page, '/travel', tag, status);
}

/** Decide a trip as its approver. */
async function decide(page: Page, tag: string, action: 'Approve' | 'Reject'): Promise<void> {
  await page.goto('/travel');
  const row = rowFor(page, tag);
  await expect(row, `${tag} should be waiting on the manager`).toBeVisible({ timeout: 30_000 });
  await row.click();
  await pressAndSettle(page, action);
  /**
   * Polled with RELOADS, and that is the whole point.
   *
   * The decision commits server-side; this page was fetched before it did. A plain
   * `expect(row).not.toContainText('Submitted')` re-queries the same stale DOM for its
   * entire timeout and then reports the approval as not having taken — which it had,
   * immediately. Half an hour went into that diagnosis; `expectRowEventually` reloads.
   */
  await expectRowEventually(page, '/travel', tag, /Approved|Rejected|Returned/i);
}

test.describe('the normal path', () => {
  test('a traveller submits a priced trip and their manager approves', async ({ page }) => {
    const tag = tripTag('approve');

    await signIn(page, 'employee');
    await createPricedTrip(page, tag);
    await submitTrip(page);
    await expectStatus(page, tag, /Submitted/i);

    await switchTo(page, 'manager');
    await decide(page, tag, 'Approve');

    await switchTo(page, 'employee');
    await expectStatus(page, tag, /Approved/i);
  });
});

test.describe('the ways it ends instead', () => {
  test('a manager rejects the trip', async ({ page }) => {
    const tag = tripTag('reject');

    await signIn(page, 'employee');
    await createPricedTrip(page, tag);
    await submitTrip(page);
    await expectStatus(page, tag, /Submitted/i);

    await switchTo(page, 'manager');
    await decide(page, tag, 'Reject');

    await switchTo(page, 'employee');
    await expectStatus(page, tag, /Rejected/i);
  });

  test('the traveller withdraws it', async ({ page }) => {
    /** The traveller's own exit. A trip that is no longer happening should not sit in
     *  somebody's queue waiting to be approved. */
    const tag = tripTag('withdraw');

    await signIn(page, 'employee');
    await createPricedTrip(page, tag);
    await pressAndSettle(page, 'Withdraw');
    await expectStatus(page, tag, /Cancelled/i);
  });

  test('an unpriced trip warns, and is submitted anyway', async ({ page }) => {
    /**
     * DELIBERATELY INVERTED. This test used to be `an unpriced trip cannot be submitted`
     * and asserted that `Submit for approval` was DISABLED without budget lines. That was
     * the old rule, and it is the rule this change removes.
     *
     * The gate was defending something real — an approver shown a total of zero is being
     * asked to authorise an unknown amount — but with the wrong remedy. Its usual cause
     * is a destination no seeded `PerDiemRate` matches and no route can be quoted for,
     * which is nothing the traveller can fix: the button was dead, no sentence said why,
     * and their only remaining move was to invent a different destination.
     *
     * So the budget explains itself and the press still works. Both halves are asserted
     * here, because either one alone is the wrong product: a warning with a dead button
     * is what we had, and a live button with no warning is a silent zero.
     */
    const tag = tripTag('unpriced');

    await signIn(page, 'employee');
    // A destination no per-diem rate can match, so pricing genuinely yields nothing.
    await createTrip(page, tag, { destination: 'Nowhere' });

    await expect(page.getByText(/Nothing has been priced for this trip yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for approval' }).first()).toBeEnabled();

    // And it stays standing: there is nothing to press that would make it go away, which
    // is the point — the warning explains what is missing instead of gating the submit.
    await expect(page.getByText(/Nothing has been priced for this trip yet/)).toBeVisible();

    await submitTrip(page);
    await expectStatus(page, tag, /Submitted/i);
  });
});

test.describe('the populated allowance', () => {
  /**
   * Picking a per-diem category in the CREATE drawer fills the amount in, and typing over
   * it asks for a note before anything is sent.
   *
   * End to end because that is the only place all of it meets: the seeded Toronto meals
   * rate, the traveller's tier, the preview query that prices a trip nobody has saved yet,
   * the drawer's gate, and the server rule the gate mirrors — which records what the typed
   * figure displaced and shows it on the saved line afterwards. A unit test can assert each
   * half against a stub; only this proves the two halves agree on the number.
   *
   * Five days at the seeded $80.00 with the travel days halved: 4 × 80 = $320.00. The
   * figure is asserted exactly, because "some amount appeared" would pass against a preview
   * priced for the wrong trip.
   */
  test('picking a per-diem category fills the amount in, and typing over it needs a note', async ({
    page,
  }) => {
    const tag = tripTag('prefill');
    const note = `Hotel restaurant, no cheaper option ${tag}`;

    await signIn(page, 'employee');
    await page.goto('/travel');
    await page.getByRole('button', { name: 'New travel request' }).first().click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Why this trip is necessary').fill(`Trip for ${tag}`);
    const cities = dialog.getByLabel('Search for a city');
    await cities.nth(0).fill(`Toronto ${tag}`);
    await cities.nth(1).fill('Vancouver');
    const dates = dialog.locator('input[type=date]');
    await setDate(dates.nth(0), dayFromNow(30));
    await setDate(dates.nth(1), dayFromNow(34));

    await dialog.getByRole('button', { name: 'Add a planned budget item' }).click();
    const amount = dialog.getByLabel('Amount', { exact: true }).last();
    await expect(amount).toBeVisible();

    /**
     * The same retry `pickPlannedCategory` makes, for the same reason — a Base UI option
     * clicked before its handler attaches is swallowed silently. The signal differs: this
     * row does not disappear on pick, so it is the trigger showing the picked category.
     */
    const trigger = dialog.getByLabel('Category', { exact: true }).last();
    for (let attempt = 1; ; attempt++) {
      await trigger.click();
      const option = page.getByRole('option', { name: /Meals/ }).first();
      await expect(option, 'the picker should offer Meals').toBeVisible({ timeout: 20_000 });
      await option.click();
      try {
        await expect(trigger).toContainText(/Meals/, { timeout: 5_000 });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
      }
    }

    // Populated by the server's own derivation, before anything is saved.
    await expect(amount).toHaveValue('320.00', { timeout: 30_000 });
    await expect(dialog.getByText(/Per diem · 5 days/)).toBeVisible();
    const create = dialog.getByRole('button', { name: 'Create' });
    await expect(create).toBeEnabled();

    // Typed over: the warning names the figure being displaced, the notes field says it
    // is waiting, and Create waits with it.
    await amount.fill('400');
    await expect(dialog.getByText(/Overrides the policy amount of .*320\.00/)).toBeVisible();
    await expect(create).toBeDisabled();
    const notes = dialog.getByLabel('Notes', { exact: true }).last();
    await expect(notes).toHaveAttribute('aria-required', 'true');
    await expect(dialog.getByText('Say why you are overriding the policy amount')).toBeVisible();

    await notes.fill(note);
    await expect(create).toBeEnabled();

    // Awaited before navigating, for the reason `createTrip` records.
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/trpc/travelRequests.create') && r.request().method() === 'POST',
    );
    await create.click();
    const response = await created;
    expect(response.ok(), `travelRequests.create answered HTTP ${response.status()}`).toBe(true);
    await expect(dialog).toBeHidden();
    await expectRowEventually(page, '/travel', tag, /Draft/i);
    await openTrip(page, tag);

    // The saved line carries the typed figure AND what it displaced — in edit mode, where
    // the traveller can still change their mind.
    const block = page
      .locator('div.rounded-md')
      .filter({ has: lineDetail(page, note) })
      .last();
    await expect(block.getByLabel('Override amount', { exact: true })).toHaveValue('400.00');
    await expect(block.getByText(/Overrode the policy amount of .*320\.00/)).toBeVisible();
  });
});

test.describe('what nobody can price', () => {
  test('a department meal is planned from an expense category', async ({ page }) => {
    /**
     * The case this exists for. A trip's budget used to be whatever a provider could
     * sell — flights and hotels — and a department dinner the team is going to have is
     * real money the approver is about to authorise with no idea it is coming.
     *
     * Asserted end to end because that is the only place the pieces meet: the category
     * comes from `TravelCategory` and maps to an expense category (so budget-vs-actual
     * can later match a receipt to it), the amount is typed in major units and stored in
     * minor, and the line lands in the same budget as the derived ones, labelled as a
     * person's typed figure rather than a market price.
     *
     * Then removed again, because a plan you cannot take back is a plan you have to
     * cancel the whole request to change.
     */
    const tag = tripTag('planned');
    const note = `Department dinner ${tag}`;

    await signIn(page, 'employee');
    await createPricedTrip(page, tag);
    await addPlannedItem(page, /Department Meal/, '250.00', note);

    /**
     * In the budget, in its own BLOCK rather than a table row — phase 8 replaced the
     * three-column table, because a line can now be a flight with a number on it or a
     * meal with people at it and three columns cannot hold that.
     *
     * Located from the detail FIELD upwards, since the note lives in an input now.
     */
    const block = page
      .locator('div.rounded-md')
      .filter({ has: lineDetail(page, note) })
      .last();
    // `toHaveValue`, not `toContainText`: the amount is an editable override box now, and
    // an input's value is not text content — the old assertion could only ever fail.
    // `exact`, because the row also carries a live region called "Override amount you are
    // entering" — the preview of what is being typed — and a substring match finds both.
    await expect(block.getByLabel('Override amount', { exact: true })).toHaveValue('250.00');
    // A typed figure is labelled as one, so an approver can tell it from a market price.
    await expect(block).toContainText(/Typed|Manual|Planned/i);

    await page
      .getByRole('button', { name: /^Remove .* from the budget$/ })
      .last()
      .click();
    await expect(lineDetail(page, note)).toHaveCount(0, { timeout: 30_000 });
  });

  test('a rental car has to be planned, because nothing quotes one', async ({ page }) => {
    /**
     * `travelCarRental` has been one of travel's four declared budget buckets since the
     * module was written, and nothing has ever produced a line for it. That is not an
     * oversight to fix with a search: SerpApi's travel surface is Google Flights, Google
     * Hotels, Google Travel Explore, TripAdvisor and OpenTable — there is no car-rental
     * engine, and no Google car-rental results page for one to scrape either.
     *
     * So "Include a rental car" used to be a checkbox that did nothing at all, silently.
     * It now says so, and the remedy is the planned item — which is what this asserts,
     * in both directions: the warning appears, and it goes away once the car is budgeted.
     */
    const tag = tripTag('car');
    const note = `Compact, five days ${tag}`;

    await signIn(page, 'employee');
    await createTrip(page, tag, { includeCar: true });

    await expect(page.getByText(/This trip includes a rental car/)).toBeVisible();
    await addPlannedItem(page, /Car Rental/, '410.00', note);
    await expect(page.getByText(/This trip includes a rental car/)).toHaveCount(0);
  });
});

test.describe('the policy gate', () => {
  /**
   * A travel line the traveller has not explained, and a rule that refuses it.
   *
   * The estimate was purely advisory until now: every panel on the drawer was a
   * `role="status"` note beside a live Submit button. This is the one thing that actually
   * stops a submit, so it is worth asserting through the browser and not only in a unit
   * test — the FE gate and the server gate are separate decisions, and a screen that lets
   * you press a button the server then refuses is a worse experience than either.
   *
   * ISOLATION. Every other travel spec runs against this same database, concurrently, and
   * a global BLOCK rule would break all of them. So the rule's threshold is set just under
   * the router's own per-line ceiling ($900,000) and this test's line is above it: no other
   * spec's figures — $250, $410, a per-diem in the hundreds — come close, so the rule is
   * inert everywhere except here. That is why the threshold is absurd; it is a scoping
   * device, not a plausible policy.
   */
  const THRESHOLD_MINOR = '90000000'; // $900,000.00
  const BIG_LINE = '950000.00';

  /**
   * Arm the rule, idempotently.
   *
   * Created once and left in place, like `enableAttendeeRule` in the expense-policy spec —
   * and for the reason recorded there: a second instance on a second run produces two
   * findings, and an assertion written for one goes red forever after in a way that is not
   * reproducible from a fresh database.
   */
  async function armDetailRule(page: Page): Promise<void> {
    const rules = await trpcQueryOk<{ id: string; kindCode: string; params: unknown }[]>(
      page,
      'policies.policyRule.list',
      undefined,
    );
    const existing = rules.find(
      (r) =>
        r.kindCode === 'TRAVEL_LINE_DETAIL_REQUIRED' &&
        (r.params as { thresholdMinor?: string } | null)?.thresholdMinor === THRESHOLD_MINOR,
    );
    if (existing) return;
    await trpcOk(page, 'policies.policyRule.create', {
      kindCode: 'TRAVEL_LINE_DETAIL_REQUIRED',
      severity: 'BLOCK',
      messageKey: 'travelLineDetailRequired',
      params: { thresholdMinor: THRESHOLD_MINOR },
      effectiveFrom: '2024-01-01T00:00:00.000Z',
      enabled: true,
    });
  }

  test('an unexplained line blocks the submit until it is explained', async ({ page }) => {
    const tag = tripTag('policy');

    await signIn(page, 'admin');
    await armDetailRule(page);

    await switchTo(page, 'employee');
    await createTrip(page, tag);
    // No notes typed: the whole point. The amount clears the rule's threshold, and
    // picking the category is what files the line.
    await page.getByRole('button', { name: 'Add a planned budget item' }).click();
    await page.getByLabel('Amount', { exact: true }).last().fill(BIG_LINE);
    /*
     * VeloExpense (w6-02): Conference & Registration, not Department Meal. ExpenseOS's
     * Department Meal maps to its own `employeeMeetings` expense category, which carries no
     * per-diem, so a typed figure there is not an override. VeloExpense's starter categories
     * have one `meals`, which Department Meal maps to (0077) and which the demo seeds a
     * per-diem on, so a typed figure IS an override and the draft demands a note before it
     * saves — which is a different gate from the one under test. Conference & Registration
     * maps to nothing, so it prices nothing and the line saves unexplained, as ExpenseOS's
     * Department Meal did.
     */
    await pickPlannedCategory(page, /Conference & Registration/);

    /**
     * The refusal, and the sentence explaining it.
     *
     * Both are asserted because the previous gate on this button — disabled while the
     * budget was empty — had no sentence at all, and a traveller's only remaining move was
     * to guess. A dead button with no reason is the failure being avoided, not just the
     * missing block.
     */
    const submit = page.getByRole('button', { name: 'Submit for approval' }).first();
    await expect(submit).toBeDisabled({ timeout: 30_000 });
    await expect(page.getByText(/blocking policy violation/i)).toBeVisible({ timeout: 30_000 });

    // Explain it on the line itself, which is where the demand is anchored.
    const detail = page.getByLabel('Notes', { exact: true }).last();
    await detail.fill('Chartered aircraft, whole team, no scheduled service that week');
    await detail.blur();

    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText(/blocking policy violation/i)).toHaveCount(0, { timeout: 30_000 });

    await submitTrip(page);
    await expectStatus(page, tag, /Submitted/i);
  });
});

test('the date field is not covered by an invisible overlay', async ({ page }) => {
  /**
   * The regression guard for the bug that made a travel request impossible to create.
   *
   * `baseInputClasses` styled WebKit's calendar-picker indicator `absolute inset-0 …
   * opacity-0`, which does not hide it — it stretches it across the entire field as an
   * invisible, clickable overlay, so every click landed on the picker button instead of on
   * the day / month / year segment aimed at.
   *
   * This reads the pseudo-element's COMPUTED STYLE in a real browser, which is the only
   * place the bug is visible: jsdom does not implement
   * `::-webkit-calendar-picker-indicator`, `next build` never renders it, and `fill()`
   * bypasses the pointer entirely. Four months of green CI is the evidence for that.
   */
  // This file runs signed OUT by default (`test.use({ storageState: … })` at the top),
  // so the trip drawer is only reachable after an explicit sign-in like every other
  // test here.
  await signIn(page, 'employee');
  await page.goto('/travel');
  await page.getByRole('button', { name: 'New travel request' }).first().click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  const field = dialog.locator('input[type=date]').first();

  const indicator = await field.evaluate((el) => {
    const s = getComputedStyle(el, '::-webkit-calendar-picker-indicator');
    return { display: s.display, position: s.position, inset: s.inset, opacity: s.opacity };
  });

  /**
   * The exact failure shape, named rather than inferred: `position: absolute` with
   * `inset: 0px` is what stretched the indicator over the whole field. Either alone is
   * harmless; together they are the bug.
   *
   * The mutation-proven guard for this is the CLASS LIST assertion in
   * `packages/design-system/…/input.dates.test.tsx` — reverting the CSS there fails that
   * test immediately. This is its browser-level companion, and it is worth knowing that
   * proving it by mutation HERE is unreliable: `next dev` does not always recompile a
   * workspace package before the run starts, so a mutated design system can be served
   * from cache and the check passes on stale CSS.
   */
  expect(
    indicator.position === 'absolute' && indicator.inset === '0px',
    `the picker indicator must not be a full-bleed overlay (got ${JSON.stringify(indicator)})`,
  ).toBe(false);

  // And the field must still accept a value set through the segments.
  await field.click();
  const someDate = dayFromNow(30);
  await field.fill(someDate);
  await expect(field).toHaveValue(someDate);
});

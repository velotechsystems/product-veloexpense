import { expect, type Locator, type Page, test } from '@playwright/test';
import { signIn } from './support/actors';
import { pickCombobox } from './support/combobox';
import { escapeRegExp, proceduresIn } from './support/mileage';
import { testDb } from './support/test-db';
import { trpcOk, trpcQueryOk } from './support/trpc';
import { createReport, reportTag } from './support/workbench';

/**
 * A saved mileage line is LOCKED, and only an explicit Save writes to it — with Google off.
 *
 * ─── WHAT THIS PINS (TR-17 / FR-6) ──────────────────────────────────────────────────────
 *
 * Before `mileage-route-pick-on-map`, a saved mileage row was a live form: the distance
 * field committed on BLUR and the KM/MI toggle committed on CLICK, each one an
 * `expenses.lineItemUpdate`. A traveller who clicked into the field to read it and tabbed
 * away, or who tapped MI to see what the figure would be in miles, re-priced a claim they
 * never meant to touch — and there was no way back, because the old value was gone the
 * moment focus left the box.
 *
 * The row is now locked once saved: the distance and the unit render disabled beside an
 * "Edit route" button. Edit route opens the row; Cancel puts the stored values back and
 * writes NOTHING; Save sends exactly ONE `expenses.lineItemUpdate` and locks the row again.
 * Two tests, one per exit, and a third for a line that already carries a route:
 *
 *   · **Cancel writes nothing**, even after the two gestures that used to write: a blur of
 *     the distance field and a unit switch. Proved three ways, because each alone has a
 *     hole — the API copy of the line is byte-identical, the database row's `updatedAt` has
 *     not moved (Prisma stamps `@updatedAt` on EVERY update, even one that writes the same
 *     values, so an unchanged stamp means no update ran at all), and the request recorder
 *     saw no `expenses.lineItemUpdate`.
 *   · **Save writes once**, carrying the distance and the unit and NO route key (only the
 *     route workspace's Use this route writes a route; an absent key leaves the stored one
 *     alone), and the row locks again on the server's figure.
 *   · **A carried route asks nothing** (`mileage-route-no-stored-geometry` FR-3 1.B): a line
 *     whose stored route passes through a point (`via`) is served back with exactly the
 *     keys it was written with, shows locked with no map, and makes no route or map call.
 *
 * Every test also records each `mileageRoute.*` procedure that routes, places, draws or
 * looks up (`ROUTE_OR_MAP`) and asserts, last, that the page sent none: with lookup off
 * there is nothing to ask Google, and nothing that would bill it may go out.
 *
 * ─── WHY "LOOKUP OFF", AND THE GUARD ON IT ──────────────────────────────────────────────
 *
 * With address lookup OFF the distance is TYPED into a plain "Distance" box; with it ON the
 * distance is measured by a route and the box is not rendered at all (`MileageFields.tsx`
 * branches on `mileageRoute.status`). This file is the lookup-off half and needs no Google:
 * locally and in CI there is no `GOOGLE_PLACES_API_KEY` and nothing installs the
 * `google-maps` integration. If the environment ever DOES report lookup available, every
 * locator below addresses a box that is not there and the failure would read as "the lock
 * is broken". So the first thing each test does is ask the server, and fail with the real
 * reason. A FAIL rather than a skip on purpose: a skip goes green in CI, and green here
 * would mean the lock went unmeasured.
 *
 * ─── HOW THE NEGATIVE ASSERTIONS ARE ORDERED ────────────────────────────────────────────
 *
 * "No request was sent" is only true as of some moment, and asserting it straight after
 * the Cancel click would race a write the blur fired a few milliseconds earlier. So the
 * recorder is read LAST: after Cancel, the spec reads the line back through
 * `expenses.report` (a request the page issues, so it queues behind anything the page
 * already sent) and through the database, and only then asserts the recorder is empty.
 * The same ordering backs the positive "exactly one" in the Save test.
 *
 * ─── THE RECORDER, AND tRPC BATCHING ────────────────────────────────────────────────────
 *
 * The workbench's tRPC client is an `httpBatchLink` (`apps/web/src/lib/trpc/client.tsx`).
 * A batch joins its procedure names with commas in the PATH — `/api/trpc/a,b?batch=1` —
 * and sends a POST body keyed by position, `{"0": {"json": …}, "1": {"json": …}}`
 * (`@trpc/client`'s `getUrl` / `arrayToDict`). So a `lineItemUpdate` can ride in a batch
 * whose URL does not END in its name, and matching the whole path would miss it. The
 * recorder splits the path on commas and pulls each matching procedure's input out of the
 * body by its index.
 *
 * ─── DATA ────────────────────────────────────────────────────────────────────────────────
 *
 * Signs in as `employee` (`qa.employee`, country CA). The seed gives CA a mileage rule in
 * force from 2026-01-01 ($0.72/km, then $0.66/km past 5,000 km in the year —
 * `packages/db/prisma/seed.ts`, `MILEAGE_RULES`), and an expense dates itself today, so
 * "Add line" is priced rather than refused. The figure is never hard-coded: the YTD basis
 * that picks the band is per person, and `employee` is shared across the suite, so every
 * amount asserted is the one the server returned. Each test files its own report and
 * expense under a unique tag.
 *
 * Desktop only (`chromium`): the file name carries no `.mobile`, so the phone projects do
 * not collect it (see the spec-list note in `playwright.config.ts`).
 */

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * `retries: 0` overrides the root `retries: process.env.CI ? 2 : 1`. A write that fires on
 * blur only when the click lands in a particular frame is the intermittent case, and a
 * fail-then-pass is reported as FLAKY with exit 0 — which would hide the very regression
 * this file exists for. Longer than the 45s default: two sign-in-to-saved-line flows, each
 * with a database read.
 */
test.describe.configure({ timeout: 150_000, retries: 0 });

/** The name `testDb` reports a missing `DATABASE_URL` under. */
const CALLER = 'mileage-route-lookup-off.spec.ts';

/** The seeded mileage category (`travelMileage`, `isMileage: true`). */
const MILEAGE_CATEGORY = /Travel - Mileage/;

const PROCEDURE = 'expenses.lineItemUpdate';

/**
 * The `mileageRoute.*` procedures that ask Google something, or read the map key. With
 * lookup off the page has no business sending any of them; `status` (the question the form
 * asks to decide which fields to draw) is the one it does send.
 */
const ROUTE_OR_MAP = [
  'computeRoutes',
  'lineRoutePath',
  'pointToPlace',
  'viaLocations',
  'searchPlaces',
  'mapConfig',
].map((p) => `mileageRoute.${p}`);

/** Record every `ROUTE_OR_MAP` procedure the page sends from now on, batched or not. */
function recordRouteOrMap(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    for (const name of proceduresIn(request.url())) {
      if (ROUTE_OR_MAP.includes(name)) seen.push(name);
    }
  });
  return seen;
}

/** The line as `expenses.report` returns it to its own submitter. */
interface ReportLine {
  id: string;
  categoryId: string;
  kind: string;
  amountMinor: string;
  mileageDistance: string | null;
  mileageUnit: 'KM' | 'MI' | null;
  mileageYtdBefore: string | null;
  mileageBreakdown: unknown;
  mileageRoute: unknown;
  routeDistance: unknown;
  mileageRouteUnavailable: boolean;
}

interface ReportView {
  expenses: { id: string; merchant: string | null; lineItems: ReportLine[] }[];
}

/** One `lineItemUpdate` the page sent, with the input it carried. */
interface RecordedCall {
  url: string;
  input: Record<string, unknown> | undefined;
}

/**
 * Record every `expenses.lineItemUpdate` the page sends from now on, batched or not.
 *
 * A `request` listener rather than `page.route`: nothing is intercepted or answered, the
 * app talks to the real server, and this only watches. Installed AFTER the line is saved
 * and locked, so the create flow's own writes are not counted.
 */
function recordLineItemUpdates(page: Page): RecordedCall[] {
  const calls: RecordedCall[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const at = url.pathname.indexOf('/api/trpc/');
    if (at === -1) return;
    const procedures = decodeURIComponent(url.pathname.slice(at + '/api/trpc/'.length)).split(',');
    if (!procedures.includes(PROCEDURE)) return;

    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const batched = url.searchParams.get('batch') === '1';
    procedures.forEach((name, index) => {
      if (name !== PROCEDURE) return;
      const envelope = batched
        ? (body as Record<string, { json?: unknown }> | null)?.[String(index)]
        : (body as { json?: unknown } | null);
      calls.push({
        url: request.url(),
        input: envelope?.json as Record<string, unknown> | undefined,
      });
    });
  });
  return calls;
}

/** Whether a response is for a request whose comma-separated path names `procedure`. */
function carries(url: string, procedure: string): boolean {
  const path = new URL(url).pathname;
  const at = path.indexOf('/api/trpc/');
  if (at === -1) return false;
  return decodeURIComponent(path.slice(at + '/api/trpc/'.length))
    .split(',')
    .includes(procedure);
}

/**
 * Fail, with the reason, if address lookup is ON in this environment. See the header.
 *
 * `mileageRoute.status` is the same query `MileageFields` reads to decide between the typed
 * box and the measured figure, so this asks exactly the question the screen asks.
 */
async function requireLookupOff(page: Page): Promise<void> {
  const status = await trpcQueryOk<{ available: boolean; mapAvailable: boolean }>(
    page,
    'mileageRoute.status',
    undefined,
  );
  expect(
    status.available,
    'mileageRoute.status reports address lookup AVAILABLE in this environment, so the ' +
      'mileage form renders a measured route instead of the typed Distance box this spec ' +
      'drives. This file proves the lookup-OFF lock (TR-17 / FR-6) and cannot run here: ' +
      'uninstall the google-maps integration (or unset GOOGLE_PLACES_API_KEY) on the ' +
      'target, or run it against the local stack.',
  ).toBe(false);
}

/**
 * The expense editor's "Line items" block: the saved rows, any open new-line form, and the
 * "Add line" opener. Everything below is scoped to it, so a Cancel or a Save elsewhere on
 * the workbench can never be the one clicked.
 *
 * The innermost `div` holding both the heading and the opener. Only ancestors of an element
 * can contain it, so every match lies on one chain and `.last()` — document order — is the
 * deepest: the block itself.
 */
function lineItemsBlock(page: Page): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText('Line items', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Add line', exact: true }) })
    .last();
}

/** The controls of the ONE mileage line, inside the block. */
function mileageControls(lines: Locator) {
  return {
    distance: lines.getByLabel('Distance', { exact: true }),
    km: lines.getByRole('button', { name: 'KM', exact: true }),
    mi: lines.getByRole('button', { name: 'MI', exact: true }),
    editRoute: lines.getByRole('button', { name: 'Edit route', exact: true }),
    cancel: lines.getByRole('button', { name: 'Cancel', exact: true }),
    save: lines.getByRole('button', { name: 'Save', exact: true }),
    /** `<output aria-label="Amount">` — implicit role `status`. */
    amount: lines.getByRole('status', { name: 'Amount', exact: true }),
  };
}

/** Minor units as the plain two-place figure every locale's currency format contains. */
function majorFigure(amountMinor: string): string {
  return (Number(amountMinor) / 100).toFixed(2);
}

/**
 * The line through the API, as its submitter reads it. Issued from the page (same session,
 * same origin), which is what makes it the "later read" the negative assertions wait on.
 */
async function readLine(page: Page, reportId: string, lineId: string): Promise<ReportLine> {
  const report = await trpcQueryOk<ReportView>(page, 'expenses.report', { reportId });
  const line = report.expenses.flatMap((e) => e.lineItems).find((li) => li.id === lineId);
  if (!line) throw new Error(`line ${lineId} is missing from expenses.report for ${reportId}`);
  return line;
}

/** The API's mileage fields, serialised — compared byte for byte. */
function apiMileageJson(line: ReportLine): string {
  return JSON.stringify({
    categoryId: line.categoryId,
    kind: line.kind,
    amountMinor: line.amountMinor,
    mileageDistance: line.mileageDistance,
    mileageUnit: line.mileageUnit,
    mileageYtdBefore: line.mileageYtdBefore,
    mileageBreakdown: line.mileageBreakdown,
    mileageRoute: line.mileageRoute,
    routeDistance: line.routeDistance,
    mileageRouteUnavailable: line.mileageRouteUnavailable,
  });
}

/**
 * The stored row, serialised, plus its `updatedAt`.
 *
 * Read from the database because the API does not send a line's `updatedAt`, and the stamp
 * is the one field that moves on a write of identical values. BigInts are stringified;
 * Prisma's `Decimal` and `Date` serialise through their own `toJSON`.
 */
async function dbSnapshot(lineId: string): Promise<{ json: string; updatedAt: string }> {
  const db = await testDb(CALLER);
  // VeloExpense: SQL through the e2e pool (`testDb`) in place of ExpenseOS's Prisma read —
  // the same fields, as text, so a write of identical values still compares equal.
  const { rows } = await db.query(
    `SELECT category_id, kind, amount_minor::text AS amount_minor,
            mileage_distance::text AS mileage_distance, mileage_unit, mileage_rate_id,
            mileage_ytd_before::text AS mileage_ytd_before, mileage_breakdown, mileage_route,
            mileage_distance_override::text AS mileage_distance_override, updated_at
       FROM expense_line_item WHERE id = $1`,
    [lineId],
  );
  const row = rows[0];
  if (!row) throw new Error(`line ${lineId} is not in the database`);
  return {
    json: JSON.stringify(row),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/** Assert the row is LOCKED and showing `distance` in `unit`. */
async function expectLocked(
  lines: Locator,
  distance: string,
  unit: 'KM' | 'MI',
  amountMinor: string,
): Promise<void> {
  const c = mileageControls(lines);
  await expect(c.editRoute, 'a saved mileage line should offer "Edit route"').toBeVisible({
    timeout: 30_000,
  });
  await expect(c.distance, 'the locked distance is rendered').toBeVisible();
  await expect(c.distance, 'the locked distance must not be editable').toBeDisabled();
  await expect(c.distance).toHaveValue(distance);
  await expect(c.km, 'the unit toggle is locked with the distance').toBeDisabled();
  await expect(c.mi, 'the unit toggle is locked with the distance').toBeDisabled();
  await expect(unit === 'KM' ? c.km : c.mi).toHaveAttribute('aria-pressed', 'true');
  await expect(unit === 'KM' ? c.mi : c.km).toHaveAttribute('aria-pressed', 'false');
  await expect(c.save, 'a locked row has nothing to save').toHaveCount(0);
  // The button names WHAT it opens: its description is the visible summary ("120 km").
  await expect(c.editRoute).toHaveAccessibleDescription(new RegExp(distance));
  await expect(c.amount).toContainText(majorFigure(amountMinor));
}

/**
 * File a report with one expense carrying one typed mileage line, and return its ids once
 * the line is saved and locked.
 *
 * Driven through the UI the way a person adds it: "Add expense", a vendor, "Add line", the
 * mileage category, a distance, the form's own "Add line".
 */
async function addLockedMileageLine(
  page: Page,
  what: string,
  distance: string,
): Promise<{ reportId: string; vendor: string; lineId: string; line: ReportLine }> {
  const reportId = await createReport(page, reportTag(what));
  const vendor = `Mileage ${what} ${Date.now().toString(36)}`;

  await page.getByRole('button', { name: 'Add expense' }).first().click();
  // The editor lags the click; an empty Vendor is the signal it has switched to the new
  // expense (see `e2e/support/workbench.ts`).
  const vendorField = page.getByLabel('Vendor');
  await expect(vendorField).toHaveValue('', { timeout: 30_000 });
  await vendorField.fill(vendor);
  await vendorField.blur();
  await expect(page.getByRole('button', { name: new RegExp(vendor) }).first()).toBeVisible({
    timeout: 30_000,
  });

  const lines = lineItemsBlock(page);
  await lines.getByRole('button', { name: 'Add line', exact: true }).click();
  // VeloExpense: the kit's category picker is a button carrying `data-placeholder`.
  await pickCombobox(page, lines.locator('[data-placeholder="Select a category"]'), MILEAGE_CATEGORY);

  /**
   * The open new-line form: the innermost `div` holding both its Distance box and its
   * Cancel. Needed because the form's submit is ALSO named "Add line" (`addLine.save`),
   * beside the opener (`drawer.addLine`) — two buttons, one name.
   */
  const form = lines
    .locator('div')
    .filter({ has: page.getByLabel('Distance', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Cancel', exact: true }) })
    .last();
  const submit = form.getByRole('button', { name: 'Add line', exact: true });
  const field = form.getByLabel('Distance', { exact: true });

  await expect(field, 'lookup is off, so the new mileage line takes a typed distance').toBeEditable(
    { timeout: 30_000 },
  );
  await expect(submit, '"Add line" waits for a valid distance').toBeDisabled();
  await field.fill(distance);
  await expect(form.getByRole('button', { name: 'KM', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(submit).toBeEnabled();
  await submit.click();

  // The draft form closes on success only, leaving the opener as the one "Add line".
  await expect(lines.getByRole('button', { name: 'Add line', exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });

  const report = await trpcQueryOk<ReportView>(page, 'expenses.report', { reportId });
  const expense = report.expenses.find((e) => e.merchant === vendor);
  expect(expense, `the ${vendor} expense should be on report ${reportId}`).toBeTruthy();
  expect(expense?.lineItems, 'exactly the one mileage line').toHaveLength(1);
  const line = expense?.lineItems[0] as ReportLine;
  expect(line).toMatchObject({ kind: 'MILEAGE', mileageDistance: distance, mileageUnit: 'KM' });
  expect(line.mileageRoute, 'lookup is off, so no route is stored').toBeNull();
  expect(Number(line.amountMinor), 'the seeded CA rule should have priced it').toBeGreaterThan(0);

  await expectLocked(lines, distance, 'KM', line.amountMinor);
  return { reportId, vendor, lineId: line.id, line };
}

test('Cancel after a blur and a unit switch writes nothing', async ({ page }) => {
  const routeOrMap = recordRouteOrMap(page);
  await signIn(page, 'employee');
  await requireLookupOff(page);

  const { reportId, lineId, line } = await addLockedMileageLine(page, 'route cancel', '120');
  const lines = lineItemsBlock(page);
  const c = mileageControls(lines);

  const apiBefore = apiMileageJson(line);
  const dbBefore = await dbSnapshot(lineId);
  const calls = recordLineItemUpdates(page);

  await c.editRoute.click();
  await expect(c.distance, 'Edit route opens the distance').toBeEnabled();
  await expect(c.km).toBeEnabled();
  await expect(c.mi).toBeEnabled();
  await expect(c.cancel).toBeVisible();
  await expect(c.save, 'nothing has changed yet, so nothing to save').toBeDisabled();

  // The two gestures that used to write: a changed distance that loses focus …
  await c.distance.fill('95');
  await c.distance.press('Tab');
  await expect(c.save).toBeEnabled();
  // … and a unit switch.
  await c.mi.click();
  await expect(c.mi).toHaveAttribute('aria-pressed', 'true');
  await expect(c.distance, 'a typed distance is reinterpreted, not converted').toHaveValue('95');

  await c.cancel.click();

  // The stored values are back on screen, locked.
  await expectLocked(lines, '120', 'KM', line.amountMinor);

  // The LATER reads — through the page, then the database — and only then the recorder.
  const apiAfter = apiMileageJson(await readLine(page, reportId, lineId));
  const dbAfter = await dbSnapshot(lineId);
  expect(apiAfter, 'the API copy of the line must be byte-identical after Cancel').toBe(apiBefore);
  expect(dbAfter.json, 'the stored row must be byte-identical after Cancel').toBe(dbBefore.json);
  expect(dbAfter.updatedAt, 'no update may have touched the row (@updatedAt)').toBe(
    dbBefore.updatedAt,
  );
  expect(
    calls,
    `Cancel, a blur and a unit switch must send no ${PROCEDURE}; saw ${JSON.stringify(calls)}`,
  ).toEqual([]);
  expect(routeOrMap, 'lookup is off: no route or map procedure is sent').toEqual([]);
});

test('Save sends exactly one update and locks on the server figure', async ({ page }) => {
  const routeOrMap = recordRouteOrMap(page);
  await signIn(page, 'employee');
  await requireLookupOff(page);

  const { reportId, lineId, line } = await addLockedMileageLine(page, 'route save', '120');
  const lines = lineItemsBlock(page);
  const c = mileageControls(lines);
  const dbBefore = await dbSnapshot(lineId);
  const calls = recordLineItemUpdates(page);

  await c.editRoute.click();
  await expect(c.distance).toBeEnabled();
  await c.distance.fill('75');
  await expect(c.save).toBeEnabled();

  const saved = page.waitForResponse(
    (r) => carries(r.url(), PROCEDURE) && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await c.save.click();
  const response = await saved;
  expect(response.ok(), `${PROCEDURE} should succeed`).toBe(true);

  const after = await readLine(page, reportId, lineId);
  expect(after).toMatchObject({ mileageDistance: '75', mileageUnit: 'KM', mileageRoute: null });
  expect(after.amountMinor, 'a shorter trip is re-priced').not.toBe(line.amountMinor);
  expect((await dbSnapshot(lineId)).updatedAt, 'the row was written').not.toBe(dbBefore.updatedAt);

  // Locked again, on the figure the server just returned.
  await expectLocked(lines, '75', 'KM', after.amountMinor);

  // After the later read: one call, carrying distance and unit, and no route key.
  expect(
    calls,
    `Save should send exactly one ${PROCEDURE}; saw ${JSON.stringify(calls)}`,
  ).toHaveLength(1);
  expect(calls[0].input).toMatchObject({ id: lineId, mileageDistance: '75', mileageUnit: 'KM' });
  expect(
    calls[0].input,
    'a typed-distance Save never carries the route: only Use this route writes one',
  ).not.toHaveProperty('mileageRoute');
  expect(routeOrMap, 'lookup is off: no route or map procedure is sent').toEqual([]);
});

test('A line that carries a route through a point shows no map and asks nothing', async ({
  page,
}) => {
  const routeOrMap = recordRouteOrMap(page);
  await signIn(page, 'employee');
  await requireLookupOff(page);

  const { reportId, vendor, lineId } = await addLockedMileageLine(page, 'route carried', '120');
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const from = { placeId: `e2e-place-${tag}-from`, description: `100 Front St W (e2e ${tag})` };
  const to = { placeId: `e2e-place-${tag}-to`, description: `111 Wellington St (e2e ${tag})` };
  // The stored shape (`mileageRouteSchema.ts`): stops, legs that chain through them, and one
  // point the route passes through, as a place ID on its leg. Written as a route would be
  // by a session where lookup was on; nothing here asks Google for it.
  const route = {
    stops: [from, to],
    legs: [{ fromPlaceId: from.placeId, toPlaceId: to.placeId, meters: 120_000 }],
    routeLabel: 'Hwy 401',
    routeIndex: 0,
    routeCount: 1,
    via: [{ placeId: `e2e-point-${tag}-1`, leg: 0 }],
  };
  await trpcOk(page, PROCEDURE, {
    id: lineId,
    mileageDistance: '120',
    mileageUnit: 'KM',
    mileageRoute: route,
  });
  const written = await readLine(page, reportId, lineId);
  expect(written.mileageRoute, 'served back as written: its via, and nothing added').toEqual(route);

  // The line as the writer opens it again, from what the server serves.
  await page.reload();
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(vendor)) })
    .first()
    .click();
  const lines = lineItemsBlock(page);
  await expectLocked(lines, '120', 'KM', written.amountMinor);
  await expect(
    lines.getByText(new RegExp(escapeRegExp(from.description))).first(),
    'the locked summary names the carried route',
  ).toBeVisible();
  await expect(
    lines.getByRole('img', { name: /^(Map of the route|Loading the map)/ }),
    'lookup is off: no line map',
  ).toHaveCount(0);
  await expect(lines.getByRole('combobox', { name: 'Route', exact: true })).toHaveCount(0);

  // The later read, and only then the recorder.
  const after = await readLine(page, reportId, lineId);
  expect(after.mileageRoute, 'a view writes nothing').toEqual(route);
  expect(routeOrMap, 'lookup is off: no route or map procedure is sent').toEqual([]);
});

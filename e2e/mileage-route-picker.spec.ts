import { expect, type Locator, type Page, test } from '@playwright/test';
import type { Result } from 'axe-core';
import { signIn } from './support/actors';
import { describeViolation, runAxe, wcagAaIncomplete, wcagAaViolations } from './support/axe';
import { pickCombobox } from './support/combobox';
import {
  abortGoogleMaps,
  addBlankExpense,
  callsTo,
  carries,
  escapeRegExp,
  type FakePlace,
  fakePlace,
  fill,
  type GoogleWatch,
  holdGoogleMaps,
  linePathHandler,
  type MileageHandlers,
  type MileageStub,
  MileageStubError,
  metersToDistance,
  openWorkspace,
  pickPlace,
  placesHandler,
  type RecentRouteAnswer,
  type RouteSpec,
  recordProcedure,
  routeBlockLayout,
  routePickerCopy,
  routesFor,
  routeVersion,
  type StubVia,
  storedRoute,
  stubMileageRoute,
  verticalGap,
  viaLocationsHandler,
} from './support/mileage';
import { trpcOk, trpcQueryOk } from './support/trpc';
import { createReport, reportTag } from './support/workbench';

/**
 * The route dropdown → the route workspace → Use this route, with Google stubbed.
 *
 * ─── WHAT THIS PINS ──────────────────────────────────────────────────────────────────────
 *
 * A new mileage line is ONE dropdown: New route, then the person's previous routes. Any
 * entry opens the workspace, which asks for routes by itself once every stop is a picked
 * place — one request, no Calculate — selects the SHORTEST, and creates the line in one
 * `expenses.lineItemCreate` when Use this route is pressed. A stored route is its stops,
 * its legs and the place IDs it passes through (`via`), and nothing Google drew: no path,
 * no stamp, no coordinate. One test per claim:
 *
 *   · **a** — the happy path, keyboard included: the line shows the dropdown alone; New
 *     route opens on From, with no Previous routes block when there are none; From and To
 *     make ONE `computeRoutes`; the shorter second route is selected; Use this route makes
 *     ONE create; the route filed is the card, with no path, no stamp and no `via` key.
 *   · **b** — a stop in between, one route back: it is selected; the place ids go in order.
 *   · **c** — no route, then an error, then Try again: said in the panel, nothing to accept;
 *     Cancel writes nothing and the draft goes.
 *   · **d** — the TR-16 round trip on a route through two points (spec FR-3, FR-4): filed
 *     from a previous route, the line's map asks for its path once, Change route reopens it
 *     (its map shown, loading: Google held) with ONE `computeRoutes` carrying `via` and ONE
 *     `viaLocations`, the point Google cannot place is listed as not on the map, and Use
 *     this route unchanged is ONE update that leaves `md5("mileageRoute"::text)` equal.
 *   · **e** — a browser key but Google unreachable: no map is asked for before the workspace
 *     opens, and when its script fails the panel says "Map unavailable" and still works.
 *   · **f** — a previous route from the REAL list (no points): reopened by ONE request with
 *     no `via` and no location lookup, and filed exactly as the route it reuses.
 *   · **g** — the line map (spec FR-3): each view of a saved line is ONE `lineRoutePath` and
 *     no `computeRoutes`, the box shows the busy spinner with no summary under it, a reload
 *     is one more, and a refused path is the text summary with no error and no retry.
 *   · **h** — a reopened route's points, its map shown (FR-4 3.A / 3.B, NFR-10): one placed
 *     and one the per-person limit stopped, both listed with a named remove control, the
 *     unplaced one saying so; ONE axe scan of the dialog in that state; each removal — the
 *     first by keyboard — is ONE `computeRoutes` with the points that remain, the last
 *     brings the three routes back, and the line filed has no `via`.
 *   · **i** — the 25-stop total: From, To and 23 points refuse Add stop with the `maxStops`
 *     message; one point fewer and Add stop is offered again. With no map shown, the points
 *     are never looked up: no `viaLocations` at all.
 *   · **j** — six routed lines (spec FR-3 1.A): five maps and ONE "Map not shown" sentence
 *     while Google's script is held; with it aborted, no `lineRoutePath` at all once the
 *     started maps have fallen back to their summaries, and no sentence.
 *   · **k** — the layout boxes (spec FR-6, FR-7): the 380 px panel left and the map right,
 *     the panel first in the DOM, the close button above the map, the modal's spinner, 20 px
 *     from the Previous routes block to From, no "New route" in the modal's dropdown, and
 *     12 px above the route dropdown on a new line and on a saved one.
 *
 * ─── WHAT NO SPEC HERE CAN SHOW: THE DRAG, THE MARKERS, THE TILES ───────────────────────
 *
 * Every Google host is aborted (or held) below, with no key to load the script with anyway:
 * there is no polyline to press, no marker drawn and no tile loaded. So "a drop is one
 * `pointToPlace` and then one route", "a placed point is drawn and draggable", "an unplaced
 * point has no marker" and "the spinner gives way to the tiles" are pinned in component
 * tests (`_workbench/RoutePickerModal.points.test.tsx`, `RouteMap.test.tsx`,
 * `RouteLine.test.tsx`), and on a real map they are operator checks. Test d starts where a
 * drag ends: a route that already passes through two place IDs.
 *
 * ─── ORDER, AND THE SHARED PERSON ────────────────────────────────────────────────────────
 *
 * In order, in one worker (`mode: 'default'`): f reads the REAL list of the shared
 * `employee`'s five newest routes, and every other test files lines under that same person.
 * Run beside each other, two tests of this file could push f's route out of the five
 * between its filing and its pick.
 *
 * ─── WHY GOOGLE IS STUBBED, AND WHAT IS STILL REAL ──────────────────────────────────────
 *
 * There is no Google key locally or in CI, so the real `mileageRoute.status` says lookup is
 * OFF and none of this UI renders. Every `mileageRoute.*` call is therefore answered by
 * `stubMileageRoute` (`e2e/support/mileage.ts`) with fake place ids unique to the test.
 * Everything else is the real server: the line is created, priced against the seeded CA
 * mileage rule and stored by `expenses.lineItemCreate` / `lineItemUpdate`, and read back
 * through `expenses.report` — and, in d, straight from the database (`routeVersion`, so
 * `DATABASE_URL` must be in the Playwright process). A stub with no handler for a procedure
 * refuses it and names it in `unexpected`, which every test asserts empty last. Every Google
 * host is also aborted at the context level (`abortGoogleMaps`), so no test can reach Google
 * whatever the page does.
 *
 * ─── HOW THE NEGATIVE AND "EXACTLY ONE" ASSERTIONS ARE ORDERED ──────────────────────────
 *
 * As in `mileage-route-lookup-off.spec.ts`: a count is only true as of some moment, so the
 * recorders are read LAST, after a later read through the page (`expenses.report`, which
 * queues behind anything the page already sent) or after the screen has acknowledged the
 * answer being counted.
 *
 * ─── DATA ────────────────────────────────────────────────────────────────────────────────
 *
 * Signs in as `employee` (country CA, $0.72/km in force from 2026-01-01). The amount is never
 * hard-coded — the YTD band is per person and `employee` is shared across the suite — only
 * that one was priced. Each test files its own report and expense under a unique tag.
 *
 * Desktop only (`chromium`, 1280 px wide): the file name carries no `.mobile`. The phone
 * layout of the same dialog is `mileage-route-picker.mobile.spec.ts`.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * `retries: 0`, as in the lookup-off spec: a fail-then-pass is reported FLAKY with exit 0, and
 * a second `computeRoutes` that only fires on a fast double press is exactly the intermittent
 * case. In order, in one worker: see the header.
 */
test.describe.configure({ mode: 'default', timeout: 150_000, retries: 0 });

/** The name `testDb` reports a missing `DATABASE_URL` under. */
const CALLER = 'mileage-route-picker.spec.ts';

/** The seeded mileage category (`travelMileage`, `isMileage: true`). */
const MILEAGE_CATEGORY = /Travel - Mileage/;

const COPY = routePickerCopy('en');
const CALCULATE = COPY.calculate;
const PICKER = COPY.title;
const USE = COPY.useRoute;
const MAP_UNAVAILABLE = COPY.mapUnavailable;
const MAP_REGION = COPY.mapLabel;
const NO_ROUTE =
  'No driving route found between these stops. Check the addresses or choose different stops.';
const STORED_ONLY = 'Change a stop to see other routes.';
const TRY_AGAIN = 'Try again';
/** The dialog's close button (`packages/design-system` `DialogContent`, an `sr-only` name). */
const CLOSE = 'Close';
/** A browser key the stub hands out. Google is aborted or held, so it is never checked. */
const FAKE_KEY = 'e2e-not-a-key';
/**
 * `MAP_WATCHDOG_MS` in `RoutePickerModal.tsx`: a map not drawn by then is given up on. Every
 * assertion on a HELD map's loading state is made well inside it.
 */
const WATCHDOG_MS = 10_000;

/** FR-7: the gap above a line's route dropdown, new or saved (UX arbitration U5). */
const LINE_GAP_PX = 12;
/** VeloExpense: a saved line that carries a route, after ExpenseOS #595 (see test k). */
const SAVED_ROUTE_GAP_PX = 18;
/** FR-6 step 4: Previous routes block to From/To, 12 px `gap-3` + 8 px `mb-2`. */
const PANEL_GAP_PX = 20;
/** FR-6: the panel column's fixed width. */
const PANEL_PX = 380;

/**
 * Three routes, in the order Google might list them: the FIRST is not the shortest, so the
 * selection is proved to follow the distance, not the order. Metres chosen so each distance
 * has two non-zero decimals: the stored `Decimal` reads back as "187.43". The third has no
 * label and no drive time, which is what names it "Route 3" with no time.
 */
const THREE_ROUTES: readonly RouteSpec[] = [
  { label: 'Hwy 7 and Hwy 115', totalMeters: 201_670, durationSeconds: 9_000 },
  { label: 'Hwy 401', totalMeters: 187_430, durationSeconds: 7_500 },
  { label: null, totalMeters: 215_380, durationSeconds: null },
];
/** The shortest of `THREE_ROUTES`, and its position. */
const SHORTEST = THREE_ROUTES[1] as RouteSpec;
const SHORTEST_AT = 1;
const SHORTEST_KM = metersToDistance(SHORTEST.totalMeters, 'KM');

/** The line as `expenses.report` returns it to its own writer. */
interface ReportLine {
  id: string;
  kind: string;
  categoryId: string;
  amountMinor: string;
  mileageDistance: string | null;
  mileageUnit: 'KM' | 'MI' | null;
  mileageRoute: unknown;
}

interface ReportView {
  expenses: { id: string; merchant: string | null; lineItems: ReportLine[] }[];
}

/** Two stops, unique to the test, and the text typed to find each. */
interface Trip {
  tag: string;
  from: FakePlace;
  to: FakePlace;
  via: FakePlace;
}

function tripFor(what: string): Trip {
  const tag = `${what.replace(/\W+/g, '-')}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  return {
    tag,
    from: fakePlace(tag, 'from', `100 Front St W, Toronto, ON (e2e ${tag})`),
    via: fakePlace(tag, 'via', `1 Water St E, Cobourg, ON (e2e ${tag})`),
    to: fakePlace(tag, 'to', `111 Wellington St, Ottawa, ON (e2e ${tag})`),
  };
}

/**
 * `n` points on the trip's one leg, as a drag would leave them: Google place IDs, unique to
 * the test. (A real one is a Roads or Geocoding place ID; the stub never resolves them.)
 */
function pointsOf(trip: Trip, n: number): StubVia[] {
  return Array.from({ length: n }, (_, i) => ({
    placeId: `e2e-point-${trip.tag}-${i + 1}`,
    leg: 0,
  }));
}

/**
 * A previous route over the trip's two stops: Google's shortest, chosen as the one route on
 * offer, through `via` when given. What `recentRoutes` serves for it: no path, no stamp.
 */
function previousRoute(trip: Trip, via: readonly StubVia[] = []): RecentRouteAnswer {
  return {
    stops: [trip.from, trip.to],
    legs: [
      {
        fromPlaceId: trip.from.placeId,
        toPlaceId: trip.to.placeId,
        meters: SHORTEST.totalMeters,
      },
    ],
    ...(SHORTEST.label ? { routeLabel: SHORTEST.label } : {}),
    routeIndex: 0,
    routeCount: 1,
    distance: {
      KM: SHORTEST_KM,
      MI: metersToDistance(SHORTEST.totalMeters, 'MI'),
    },
    ...(via.length > 0 ? { via: via.map((v) => ({ ...v })) } : {}),
  };
}

/** Lookup on, no map, the trip's places, three routes, and no previous routes. */
function defaultHandlers(trip: Trip): MileageHandlers {
  return {
    status: () => ({ available: true, mapAvailable: false }),
    searchPlaces: placesHandler([trip.from, trip.via, trip.to]),
    computeRoutes: routesFor(THREE_ROUTES),
    recentRoutes: () => ({ routes: [] }),
  };
}

/** Lookup on WITH a map: a browser key, and the line map's path. Google stays aborted. */
function withMap(handlers: MileageHandlers): MileageHandlers {
  handlers.status = () => ({ available: true, mapAvailable: true });
  handlers.mapConfig = () => ({ browserApiKey: FAKE_KEY, region: null });
  handlers.lineRoutePath = linePathHandler();
  return handlers;
}

/** Every Google host aborted, the stub installed, the employee signed in. Before any goto. */
async function setUp(
  page: Page,
  handlers: MileageHandlers,
): Promise<{ stub: MileageStub; google: GoogleWatch }> {
  const google = await abortGoogleMaps(page.context());
  const stub = await stubMileageRoute(page, handlers);
  await signIn(page, 'employee');
  return { stub, google };
}

/**
 * The expense editor's "Line items" block: the saved rows, any open new-line form and the
 * "Add line" opener. The innermost `div` holding the heading and the opener — see the
 * lookup-off spec for why `.last()` is the block itself.
 */
function lineItemsBlock(page: Page): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText('Line items', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Add line', exact: true }) })
    .last();
}

/** The open new-line form: the innermost `div` holding the route dropdown. */
function newLineForm(page: Page): Locator {
  return lineItemsBlock(page)
    .locator('div')
    .filter({ has: page.getByRole('combobox', { name: COPY.routeDropdown, exact: true }) })
    .last();
}

/** Every route dropdown in the block: one per saved line with a route, plus a new line's. */
function routeDropdowns(scope: Locator): Locator {
  return scope.getByRole('combobox', { name: COPY.routeDropdown, exact: true });
}

/** A line map still loading: the busy box, named by the loading text (UX ruling U1). */
function loadingMaps(scope: Locator): Locator {
  return scope.getByRole('img', { name: COPY.mapLoading, exact: true });
}

/**
 * A line's text summary (`RouteSummary`, a `<p>`): its stops joined by arrows. A `<p>` and
 * matched whole, so the closed dropdown — the same words, in `<span>`s — never counts.
 */
function summaryOf(scope: Locator, trip: Pick<Trip, 'from' | 'to'>): Locator {
  return scope.locator('p').filter({
    hasText: new RegExp(`^${escapeRegExp(`${trip.from.description} → ${trip.to.description}`)}$`),
  });
}

/** The workspace's Use this route: focusable throughout, `aria-disabled` until it can act. */
/** VeloExpense: ExpenseOS's `useButton`, renamed — ESLint's hooks rule reads a `use…` name
 *  as a React hook. */
function thisRouteButtonIn(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: USE, exact: true });
}

/**
 * Open a report with one blank expense, open a new mileage line on it and return the form.
 * Lookup is ON only because the stub says so: the dropdown rendering is the stub working.
 */
async function openMileageForm(
  page: Page,
  what: string,
): Promise<{ reportId: string; vendor: string; form: Locator }> {
  const reportId = await createReport(page, reportTag(what));
  const vendor = `Mileage ${what} ${Date.now().toString(36)}`;
  await addBlankExpense(page, vendor);
  const form = await openNewLine(page);
  return { reportId, vendor, form };
}

/**
 * Press the block's "Add line" opener and choose the mileage category.
 *
 * The category box is the LAST one with the placeholder: a saved line's category box carries
 * the same placeholder (`parts.tsx`), and the new-line form renders below the saved lines.
 */
async function openNewLine(page: Page): Promise<Locator> {
  const lines = lineItemsBlock(page);
  await lines.getByRole('button', { name: 'Add line', exact: true }).click();
  // VeloExpense: the kit's category picker is a button carrying `data-placeholder`.
  await pickCombobox(page, lines.locator('[data-placeholder="Select a category"]').last(), MILEAGE_CATEGORY);
  const form = newLineForm(page);
  await expect(
    form.getByRole('combobox', { name: COPY.routeDropdown, exact: true }),
    'the stubbed status says lookup is on, so the mileage line should offer its route dropdown',
  ).toBeVisible({ timeout: 30_000 });
  return form;
}

/**
 * Load the report at `url` on `page` (a reload when it is already there) and open the
 * vendor's expense, so its saved lines render from what the server serves now.
 */
async function openExpense(page: Page, url: string, vendor: string): Promise<Locator> {
  await page.goto(url);
  await page
    .getByRole('button', { name: new RegExp(escapeRegExp(vendor)) })
    .first()
    .click();
  const lines = lineItemsBlock(page);
  await expect(routeDropdowns(lines).first(), 'the expense opens on its routed lines').toBeVisible({
    timeout: 30_000,
  });
  return lines;
}

/**
 * Bring each route dropdown in the block into the viewport, in turn. A line asks for its
 * map only once it has been on screen (`useOnScreen`); the editor column scrolls, and
 * `toBeVisible` does not, so this is the writer scrolling down to each line.
 */
async function scrollThroughLines(lines: Locator): Promise<void> {
  const all = routeDropdowns(lines);
  const count = await all.count();
  for (let i = 0; i < count; i += 1) await all.nth(i).scrollIntoViewIfNeeded();
}

/** The ids-in-order the stop inputs were filled with. */
const idsOf = (stops: readonly FakePlace[]) => stops.map((s) => s.placeId);

/** The inputs one procedure was called with, from position `from` of the stub's record. */
function inputsTo(stub: MileageStub, procedure: keyof MileageHandlers, from = 0): unknown[] {
  return callsTo(stub, procedure)
    .slice(from)
    .map((c) => c.input);
}

/** Find a radio's card name, the way the contract states it. */
function cardName(spec: RouteSpec, position: number): string {
  const name = spec.label ? `via ${spec.label}` : `Route ${position + 1}`;
  const distance = `${metersToDistance(spec.totalMeters, 'KM')} km`;
  if (spec.durationSeconds == null) return `${name} ${distance}`;
  const total = Math.max(1, Math.round(spec.durationSeconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const time = `Drive time without live traffic: about ${hours > 0 ? `${hours} h ` : ''}${minutes} min`;
  return `${name} ${distance} ${time}`;
}

/** The expense through the API. Issued from the page, so it is the "later read". */
async function readExpense(
  page: Page,
  reportId: string,
  vendor: string,
): Promise<ReportView['expenses'][number]> {
  const report = await trpcQueryOk<ReportView>(page, 'expenses.report', { reportId });
  const expense = report.expenses.find((e) => e.merchant === vendor);
  if (!expense) throw new Error(`the ${vendor} expense is not on report ${reportId}`);
  return expense;
}

/** The expense's lines through the API — the "later read". */
async function readLine(page: Page, reportId: string, vendor: string): Promise<ReportLine[]> {
  return (await readExpense(page, reportId, vendor)).lineItems;
}

/**
 * The footer has priced the selected route, Use this route is ready: press it, and wait for
 * the workspace to close and the saved line to show `distance`, with no Edit route lock
 * (FR-6: a line measured by its route changes only through its dropdown).
 */
async function acceptRoute(page: Page, dialog: Locator, distance: string): Promise<void> {
  await expect(
    dialog.locator('output'),
    'the footer states the distance with its unit spelled out, and the seeded CA price',
  ).toContainText(new RegExp(`${escapeRegExp(distance)} kilometres · .*\\d\\.\\d{2}`), {
    timeout: 30_000,
  });
  const use = thisRouteButtonIn(dialog);
  await expect(use).not.toHaveAttribute('aria-disabled', 'true');
  await use.click();
  await expect(dialog, 'Use this route closes the workspace once the line exists').toHaveCount(0, {
    timeout: 30_000,
  });
  const lines = lineItemsBlock(page);
  await expect(
    lines.getByText(distance, { exact: true }).last(),
    'the saved line shows the distance its route measured',
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    lines.getByRole('button', { name: 'Edit route', exact: true }),
    'a line measured by its route has no Edit route lock',
  ).toHaveCount(0);
}

/** New route, From and To, the shortest accepted. Shared by f, g; a asserts every step. */
async function addRoutedLine(page: Page, form: Locator, trip: Trip): Promise<void> {
  const dialog = await openWorkspace(page, form, COPY);
  await pickPlace(dialog, 'From', trip.from, '100 Front St W');
  await pickPlace(dialog, 'To', trip.to, '111 Wellington St');
  await expect(dialog.getByRole('radio')).toHaveCount(3, { timeout: 15_000 });
  await acceptRoute(page, dialog, SHORTEST_KM);
}

/** A point's remove control, by the accessible name the catalog gives it. */
function removePoint(scope: Locator | Page, trip: Trip, n: number): Locator {
  return scope.getByRole('button', {
    name: fill(COPY.removePoint, { n, from: trip.from.description, to: trip.to.description }),
    exact: true,
  });
}

/**
 * The panel's list of points. `has` is matched INSIDE each list, so it is rooted at the
 * page, not at the dialog: a dialog-rooted locator would look for a dialog inside the list
 * and match nothing.
 */
function pointsList(page: Page, dialog: Locator, trip: Trip): Locator {
  return dialog.getByRole('list').filter({ has: removePoint(page, trip, 1) });
}

/**
 * A stored route reopened (spec FR-4 steps 2–4), as the panel shows it and as the stub saw
 * it: ONE card — the stored route, selected, saying how to get alternatives — and ONE
 * `computeRoutes` carrying the stops and every `via`; then, after that answer, ONE
 * `viaLocations` for the points' place IDs. Each point is listed with a remove control, and
 * the ones in `unplaced` (1-based) say they are not on the map.
 */
async function expectReopened(
  page: Page,
  dialog: Locator,
  stub: MileageStub,
  trip: Trip,
  via: readonly StubVia[],
  unplaced: readonly number[],
  before: { computes: number; locates: number },
): Promise<void> {
  const radios = dialog.getByRole('radio');
  await expect(radios, 'a reopened route is its one card').toHaveCount(1, { timeout: 15_000 });
  await expect(radios.first()).toBeChecked();
  await expect(dialog.getByText(STORED_ONLY, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('From', { exact: true })).toHaveValue(trip.from.description);
  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue(trip.to.description);

  const items = pointsList(page, dialog, trip).getByRole('listitem');
  await expect(items, 'every stored point is listed').toHaveCount(via.length);
  for (let n = 1; n <= via.length; n += 1) {
    await expect(removePoint(dialog, trip, n), `point ${n} has its remove control`).toBeVisible();
    const note = items.nth(n - 1).getByText(COPY.pointUnplaced, { exact: true });
    if (unplaced.includes(n)) {
      await expect(
        note,
        `point ${n} could not be placed: it says it is not on the map`,
      ).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(note, `point ${n} was placed`).toHaveCount(0);
    }
  }

  await expect.poll(() => callsTo(stub, 'viaLocations').length - before.locates).toBe(1);
  expect(
    inputsTo(stub, 'computeRoutes', before.computes),
    'the open is ONE route request, through every stored point',
  ).toEqual([{ placeIds: idsOf([trip.from, trip.to]), unit: 'KM', via }]);
  expect(
    inputsTo(stub, 'viaLocations', before.locates),
    "ONE location lookup for all the points' place IDs",
  ).toEqual([{ placeIds: via.map((v) => v.placeId) }]);
  const order = stub.calls.map((c) => c.procedure);
  expect(
    order.lastIndexOf('mileageRoute.computeRoutes'),
    'the points are placed only once their route is drawn',
  ).toBeLessThan(order.lastIndexOf('mileageRoute.viaLocations'));
}

test('a: the dropdown, the workspace, the shortest route, one create', async ({ page }) => {
  const trip = tripFor('pick');
  const { stub, google } = await setUp(page, defaultHandlers(trip));
  const { reportId, vendor, form } = await openMileageForm(page, 'route pick');

  // FR-1: the dropdown is the whole new line.
  for (const name of [CALCULATE, 'Add line', 'Cancel', 'KM', 'MI']) {
    await expect(
      form.getByRole('button', { name, exact: true }),
      `no ${name} on the line`,
    ).toHaveCount(0);
  }
  await expect(form.getByLabel('From', { exact: true })).toHaveCount(0);

  const dialog = await openWorkspace(page, form, COPY);
  const from = dialog.getByLabel('From', { exact: true });
  await expect(from, 'a new route opens in From (NFR-12)').toBeFocused();
  await expect(
    dialog.getByText(COPY.previousRoutes, { exact: true }),
    'no previous routes: neither the dropdown nor its label is rendered (FR-6 step 3)',
  ).toHaveCount(0);
  await expect(
    dialog.getByText(MAP_UNAVAILABLE, { exact: true }),
    'no browser key, so no map: the panel says so',
  ).toBeVisible();
  await expect(dialog.getByRole('region', { name: MAP_REGION })).toHaveCount(0);
  await expect(thisRouteButtonIn(dialog), 'nothing to accept yet').toHaveAttribute('aria-disabled', 'true');
  await expect(dialog.getByRole('button', { name: CALCULATE })).toHaveCount(0);

  await pickPlace(dialog, 'From', trip.from, '100 Front St W');
  expect(callsTo(stub, 'computeRoutes'), 'nothing is asked while To is empty').toEqual([]);
  await pickPlace(dialog, 'To', trip.to, '111 Wellington St');

  const group = dialog.getByRole('radiogroup', { name: PICKER });
  const radios = group.getByRole('radio');
  await expect(radios).toHaveCount(3, { timeout: 15_000 });
  for (const [i, spec] of THREE_ROUTES.entries()) {
    await expect(
      radios.nth(i),
      `card ${i + 1} is named by label, distance and time`,
    ).toHaveAccessibleName(cardName(spec, i));
  }
  await expect(
    radios.nth(SHORTEST_AT),
    'Google listed a longer route first; the shortest is selected',
  ).toBeChecked();

  // Keyboard: the radio group moves the selection, and back.
  await radios.nth(SHORTEST_AT).focus();
  await page.keyboard.press('ArrowDown');
  await expect(radios.nth(2)).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(radios.nth(SHORTEST_AT)).toBeChecked();

  const creates = recordProcedure(page, 'expenses.lineItemCreate');
  await acceptRoute(page, dialog, SHORTEST_KM);

  // The later read: the route as filed — the card, and nothing Google drew.
  const [line, ...others] = await readLine(page, reportId, vendor);
  expect(others, 'exactly the one mileage line').toEqual([]);
  expect(line).toMatchObject({ kind: 'MILEAGE', mileageDistance: SHORTEST_KM, mileageUnit: 'KM' });
  expect(Number(line?.amountMinor), 'the seeded CA rule should have priced it').toBeGreaterThan(0);
  expect(
    line?.mileageRoute,
    'the stored route is the selected card, 2 of 3: no path, no stamp, no via key',
  ).toEqual(storedRoute([trip.from, trip.to], SHORTEST, SHORTEST_AT, 3));
  expect(line, 'the line carries no geometry state any more').not.toHaveProperty('routeGeometry');

  // Only now the recorders.
  expect(creates, `Use this route is ONE create; saw ${JSON.stringify(creates)}`).toHaveLength(1);
  expect(creates[0]?.input).toMatchObject({
    mileageDistance: SHORTEST_KM,
    mileageUnit: 'KM',
    mileageRoute: { routeIndex: SHORTEST_AT, routeCount: 3 },
  });
  const computes = callsTo(stub, 'computeRoutes');
  expect(
    computes,
    `one complete set of stops is ONE computeRoutes; saw ${JSON.stringify(computes)}`,
  ).toHaveLength(1);
  expect(computes[0]?.input, 'the place ids go in stop order, and no via key').toEqual({
    placeIds: idsOf([trip.from, trip.to]),
    unit: 'KM',
  });
  expect(callsTo(stub, 'mapConfig'), 'no map, so its config is never asked for').toEqual([]);
  expect(callsTo(stub, 'lineRoutePath'), 'no map, so the line asks for no path').toEqual([]);
  expect(google.requests(), 'no map, so nothing is asked of Google').toEqual([]);
  expect(stub.unexpected, 'mileageRoute procedures the page called with no handler').toEqual([]);
});

test('b: a stop in between and a single route — it is selected', async ({ page }) => {
  const trip = tripFor('one route');
  const handlers = defaultHandlers(trip);
  const only = THREE_ROUTES[0] as RouteSpec;
  handlers.computeRoutes = routesFor([only]);
  const { stub } = await setUp(page, handlers);
  const { form } = await openMileageForm(page, 'route single');

  const dialog = await openWorkspace(page, form, COPY);
  await dialog.getByRole('button', { name: 'Add stop', exact: true }).click();
  await expect(dialog.getByLabel('Stop', { exact: true })).toBeVisible();
  await pickPlace(dialog, 'From', trip.from, '100 Front St W');
  await pickPlace(dialog, 'Stop', trip.via, '1 Water St E');
  await pickPlace(dialog, 'To', trip.to, '111 Wellington St');

  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(1, { timeout: 15_000 });
  await expect(radios.first(), 'the only route there is is selected').toBeChecked();
  await acceptRoute(page, dialog, metersToDistance(only.totalMeters, 'KM'));

  const computes = callsTo(stub, 'computeRoutes');
  expect(computes, 'only the last place completes the set').toHaveLength(1);
  expect(computes[0]?.input, 'three stops, in the order they appear').toEqual({
    placeIds: idsOf([trip.from, trip.via, trip.to]),
    unit: 'KM',
  });
  expect(stub.unexpected).toEqual([]);
});

test('c: no route, then an error, then Try again — and Cancel writes nothing', async ({ page }) => {
  const trip = tripFor('no route');
  const handlers = defaultHandlers(trip);
  handlers.computeRoutes = () => ({ routes: [] });
  const { stub } = await setUp(page, handlers);
  const { form } = await openMileageForm(page, 'route none');
  const creates = recordProcedure(page, 'expenses.lineItemCreate');

  const dialog = await openWorkspace(page, form, COPY);
  await pickPlace(dialog, 'From', trip.from, '100 Front St W');
  await pickPlace(dialog, 'To', trip.to, '111 Wellington St');
  await expect(
    dialog.getByRole('alert').filter({ hasText: NO_ROUTE }),
    'zero routes is said in the panel, as an alert',
  ).toBeVisible({ timeout: 15_000 });
  await expect(thisRouteButtonIn(dialog)).toHaveAttribute('aria-disabled', 'true');

  const refusal = 'Route lookup failed: e2e stub refusal';
  handlers.computeRoutes = () => {
    throw new MileageStubError('INTERNAL_SERVER_ERROR', refusal);
  };
  // A changed stop is a new set of places: one new request.
  await pickPlace(dialog, 'To', trip.via, '1 Water St E');
  await expect(
    dialog.getByRole('alert').filter({ hasText: refusal }),
    "a failed lookup shows the server's own sentence",
  ).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(NO_ROUTE), 'the earlier message is replaced').toHaveCount(0);

  handlers.computeRoutes = routesFor(THREE_ROUTES);
  await dialog.getByRole('button', { name: TRY_AGAIN, exact: true }).click();
  await expect(dialog.getByRole('radio'), 'Try again asks once more').toHaveCount(3, {
    timeout: 15_000,
  });

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    lineItemsBlock(page).getByRole('combobox', { name: COPY.routeDropdown, exact: true }),
    'Cancel takes the draft line away',
  ).toHaveCount(0);
  await expect(
    lineItemsBlock(page).getByRole('button', { name: 'Add line', exact: true }),
    'focus goes to the control that stays',
  ).toBeFocused();

  // Each request was acknowledged on screen above, so the counts are final.
  expect(callsTo(stub, 'computeRoutes'), 'one per complete set, plus Try again').toHaveLength(3);
  expect(creates, 'Cancel writes nothing').toEqual([]);
  expect(stub.unexpected).toEqual([]);
});

test('d: a route through two points — filed, drawn on view, reopened as stored, accepted unchanged', async ({
  page,
}) => {
  const trip = tripFor('change');
  const via = pointsOf(trip, 2);
  const refused = via[1] as StubVia;
  const handlers = withMap(defaultHandlers(trip));
  handlers.recentRoutes = () => ({ routes: [previousRoute(trip, via)] });
  // Place Details refuses the second point's ID (FR-4 3.A): it is listed, with no marker.
  handlers.viaLocations = viaLocationsHandler({ [refused.placeId]: 'unresolved' });
  const { stub } = await setUp(page, handlers);
  // Google's script is HELD: each map stays loading (shown) until the watchdog, so a reopened
  // route's points are looked up — with no map shown, none would be (nobody sees a marker).
  await holdGoogleMaps(page);
  try {
    const { reportId, vendor, form } = await openMileageForm(page, 'route change');

    // 1. The detour, filed. A drag cannot be driven here (see the header), so the route
    //    through two place IDs comes from the person's previous routes, reopened and accepted
    //    unchanged — the same write a drag's Use this route makes.
    const filing = await openWorkspace(
      page,
      form,
      COPY,
      new RegExp(escapeRegExp(trip.from.description)),
    );
    await expectReopened(page, filing, stub, trip, via, [2], { computes: 0, locates: 0 });
    await acceptRoute(page, filing, SHORTEST_KM);
    const [line] = await readLine(page, reportId, vendor);
    if (!line) throw new Error('the line was not filed');
    expect(
      line.mileageRoute,
      "an unchanged previous route is filed as that entry: its stops, legs, label and via — the STORED distance, not the fresh answer's",
    ).toEqual(storedRoute([trip.from, trip.to], SHORTEST, 0, 1, via));
    expect(line).toMatchObject({ mileageDistance: SHORTEST_KM, mileageUnit: 'KM' });

    // 2. The detour on the line map: the line asks the server for its path by its id alone —
    //    the server routes the stored stops and via — and asks the page nothing else.
    const lines = lineItemsBlock(page);
    const dropdown = routeDropdowns(lines);
    await dropdown.scrollIntoViewIfNeeded();
    await expect
      .poll(() => callsTo(stub, 'lineRoutePath').length, {
        message: 'the saved line on screen, with a browser key, asks for its path',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await readLine(page, reportId, vendor);
    for (const input of inputsTo(stub, 'lineRoutePath')) {
      expect(input, 'the line map asks for its path by the line id alone').toEqual({
        lineItemId: line.id,
      });
    }
    expect(
      callsTo(stub, 'computeRoutes'),
      'the line map makes no route call of its own',
    ).toHaveLength(1);
    expect(
      callsTo(stub, 'viaLocations'),
      'and no location lookup: no via marker on a line map',
    ).toHaveLength(1);

    // 3. Change route on the same route: reopened as stored, through both points.
    const version = await routeVersion(CALLER, line.id);
    expect(version, 'the filed line has a stored route').not.toBeNull();
    const updates = recordProcedure(page, 'expenses.lineItemUpdate');
    const dialog = await openWorkspace(page, lines, COPY, COPY.changeRoute);
    await expectReopened(page, dialog, stub, trip, via, [2], { computes: 1, locates: 1 });

    // 4. Use this route, nothing changed: the stored value goes back exactly.
    const saved = page.waitForResponse(
      (r) => carries(r.url(), 'expenses.lineItemUpdate') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await acceptRoute(page, dialog, SHORTEST_KM);
    expect((await saved).ok(), 'expenses.lineItemUpdate should succeed').toBe(true);
    await expect(dropdown, "focus returns to the line's dropdown (NFR-12)").toBeFocused();

    const [after] = await readLine(page, reportId, vendor);
    expect(after, 'the claim is untouched').toMatchObject({
      mileageDistance: line.mileageDistance,
      mileageUnit: 'KM',
      amountMinor: line.amountMinor,
    });
    expect(after?.mileageRoute, 'the same stops, legs, label, position, count and via').toEqual(
      line.mileageRoute,
    );
    expect(
      await routeVersion(CALLER, line.id),
      'an unchanged accept leaves md5("mileageRoute"::text) equal: the same JSONB value',
    ).toBe(version);
    expect(updates, `accept sends exactly one update; saw ${JSON.stringify(updates)}`).toHaveLength(
      1,
    );
    expect(
      updates[0]?.input?.mileageRoute,
      "the write carries the stored route, not the reopen's fresh answer",
    ).toEqual(line.mileageRoute);
    expect(callsTo(stub, 'computeRoutes'), 'one route request per open, and no more').toHaveLength(
      2,
    );
    expect(stub.unexpected).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('e: Google unreachable — no map asked for early, then the panel without it', async ({
  page,
}, testInfo) => {
  const trip = tripFor('map down');
  const handlers = withMap(defaultHandlers(trip));
  const { stub, google } = await setUp(page, handlers);
  const { form } = await openMileageForm(page, 'route map down');

  expect(
    callsTo(stub, 'mapConfig'),
    'the browser key is not fetched before the workspace opens',
  ).toEqual([]);
  expect(google.requests(), 'nothing is asked of Google before the workspace opens').toEqual([]);
  const dialog = await openWorkspace(page, form, COPY);
  const sawRegion = await dialog.getByRole('region', { name: MAP_REGION }).isVisible();
  testInfo.annotations.push({
    type: 'map region',
    description: sawRegion ? 'seen before the fallback' : 'already gone when first looked at',
  });

  await expect(
    dialog.getByText(MAP_UNAVAILABLE, { exact: true }),
    'the script failed to load (aborted), so the panel says "Map unavailable" — on the ' +
      "script's load error, or at worst its 10 s watchdog",
  ).toBeVisible({ timeout: 15_000 });
  expect(callsTo(stub, 'mapConfig'), 'the workspace asked for the browser key once').toHaveLength(
    1,
  );
  expect(
    google.requests().length,
    'the map tried to load Google and was aborted. None at all means the workspace never ' +
      'tried, and the fallback above was measured without the failure it exists for.',
  ).toBeGreaterThan(0);

  // The panel still does the whole job.
  await pickPlace(dialog, 'From', trip.from, '100 Front St W');
  await pickPlace(dialog, 'To', trip.to, '111 Wellington St');
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(3, { timeout: 15_000 });
  await radios.nth(0).click();
  await acceptRoute(page, dialog, metersToDistance(THREE_ROUTES[0]?.totalMeters ?? 0, 'KM'));
  expect(stub.unexpected).toEqual([]);
});

test('f: a previous route is reopened by one request and filed exactly as it was', async ({
  page,
}) => {
  const trip = tripFor('previous');
  const handlers = defaultHandlers(trip);
  // The real list: the line filed below is read back from the database.
  handlers.recentRoutes = 'passthrough';
  const { stub } = await setUp(page, handlers);
  const { reportId, vendor, form } = await openMileageForm(page, 'route previous');
  await addRoutedLine(page, form, trip);
  const [first] = await readLine(page, reportId, vendor);

  const computesBefore = callsTo(stub, 'computeRoutes').length;
  const searchesBefore = callsTo(stub, 'searchPlaces').length;

  const second = await openNewLine(page);
  const dialog = await openWorkspace(
    page,
    second,
    COPY,
    new RegExp(escapeRegExp(trip.from.description)),
  );
  const radios = dialog.getByRole('radio');
  await expect(radios, 'a previous route is its one card').toHaveCount(1, { timeout: 15_000 });
  await expect(radios.first()).toBeChecked();
  await expect(dialog.getByText(STORED_ONLY, { exact: true })).toBeVisible();
  await expect(thisRouteButtonIn(dialog), 'a loaded route opens on Use this route (NFR-12)').toBeFocused();
  await expect(dialog.getByLabel('From', { exact: true })).toHaveValue(trip.from.description);
  await acceptRoute(page, dialog, SHORTEST_KM);

  const lines = await readLine(page, reportId, vendor);
  expect(lines, 'the first line and the reused one').toHaveLength(2);
  const reused = lines.find((l) => l.id !== first?.id);
  expect(reused).toMatchObject({ mileageDistance: SHORTEST_KM, mileageUnit: 'KM' });
  expect(reused?.mileageRoute, 'the stored route, reused as filed').toEqual(first?.mileageRoute);

  expect(
    inputsTo(stub, 'computeRoutes', computesBefore),
    'reopened by ONE route request over its stops, with no via key (it has no points)',
  ).toEqual([{ placeIds: idsOf([trip.from, trip.to]), unit: 'KM' }]);
  expect(callsTo(stub, 'viaLocations'), 'no points, so nothing to place').toEqual([]);
  expect(callsTo(stub, 'searchPlaces').length, 'nor are its addresses looked up').toBe(
    searchesBefore,
  );
  expect(callsTo(stub, 'recentRoutes').length).toBeGreaterThan(0);
  expect(stub.unexpected).toEqual([]);
});

test('g: a saved line asks for its path once per view — and a refused path is its summary', async ({
  page,
}) => {
  const trip = tripFor('line path');
  const handlers = defaultHandlers(trip);
  const { stub } = await setUp(page, handlers);
  const { reportId, vendor, form } = await openMileageForm(page, 'route line path');
  const url = page.url();
  await addRoutedLine(page, form, trip);
  const [filed] = await readLine(page, reportId, vendor);
  if (!filed) throw new Error('the line was not filed');
  expect(callsTo(stub, 'lineRoutePath'), 'no browser key yet: no map, so no path').toEqual([]);

  // Now with a browser key. Google's script is HELD, so each map stays in its loading
  // state until the watchdog — every assertion below is made well inside it.
  withMap(handlers);
  await holdGoogleMaps(page);
  try {
    const computes = callsTo(stub, 'computeRoutes').length;
    for (const view of ['the first view', 'a reload']) {
      const before = callsTo(stub, 'lineRoutePath').length;
      const lines = await openExpense(page, url, vendor);
      await scrollThroughLines(lines);
      await expect
        .poll(() => callsTo(stub, 'lineRoutePath').length - before, {
          message: `${view} of the line on screen asks for its path`,
          timeout: WATCHDOG_MS - 2_000,
        })
        .toBe(1);
      const map = loadingMaps(lines);
      await expect(map, 'the map box, named by its loading text, while it loads').toBeVisible();
      await expect(map, 'and busy: the spinner, with no live region (UX U1)').toHaveAttribute(
        'aria-busy',
        'true',
      );
      await expect(summaryOf(lines, trip), 'no text summary under a map').toHaveCount(0);
      await expect(lines.getByText(COPY.lineMapCapped, { exact: true })).toHaveCount(0);

      await readLine(page, reportId, vendor);
      expect(
        callsTo(stub, 'lineRoutePath').slice(before),
        `${view} is exactly ONE path request, by the line id`,
      ).toEqual([{ procedure: 'mileageRoute.lineRoutePath', input: { lineItemId: filed.id } }]);
      await expect(
        map,
        'the map fell back before the assertions ended, so its loading state was not what ' +
          `was measured (the ${WATCHDOG_MS / 1000} s watchdog)`,
      ).toBeVisible();
    }
    expect(
      callsTo(stub, 'computeRoutes').length,
      'the path is the server’s route call: the page asks computeRoutes nothing',
    ).toBe(computes);

    // A refused path (here the per-person limit) is the summary: no error, no spinner,
    // and never asked again.
    const refusal = 'e2e: the line path was refused';
    handlers.lineRoutePath = () => {
      throw new MileageStubError('TOO_MANY_REQUESTS', refusal);
    };
    const before = callsTo(stub, 'lineRoutePath').length;
    const lines = await openExpense(page, url, vendor);
    await scrollThroughLines(lines);
    await expect(summaryOf(lines, trip), 'a refused path falls back to the summary').toBeVisible({
      timeout: 15_000,
    });
    await expect(loadingMaps(lines), 'and leaves no spinner').toHaveCount(0);
    await expect(lines.getByText(refusal), 'and says nothing of the refusal').toHaveCount(0);
    await expect(lines.getByText(COPY.lineMapCapped, { exact: true })).toHaveCount(0);

    const [after] = await readLine(page, reportId, vendor);
    expect(after, 'a view writes nothing: the claim is as filed').toMatchObject({
      mileageDistance: filed.mileageDistance,
      amountMinor: filed.amountMinor,
    });
    expect(after?.mileageRoute).toEqual(filed.mileageRoute);
    expect(callsTo(stub, 'lineRoutePath').length - before, 'a refused path is never retried').toBe(
      1,
    );
    expect(stub.unexpected).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

/**
 * Collapse a result list to the nodes inside the open dialog. The page behind a modal is
 * under its backdrop, so axe cannot work out its contrast and would report every line of it
 * as incomplete; and what this test owns is the dialog.
 */
async function inDialog(page: Page, results: Result[]): Promise<Result[]> {
  const kept: Result[] = [];
  for (const result of results) {
    const nodes = [];
    for (const node of result.nodes) {
      const selector = node.target.flat().at(-1);
      const inside =
        typeof selector === 'string' &&
        (await page.evaluate(
          (s) => document.querySelector(s)?.closest('[role="dialog"]') != null,
          selector,
        ));
      if (inside) nodes.push(node);
    }
    if (nodes.length > 0) kept.push({ ...result, nodes });
  }
  return kept;
}

test('h: a reopened route’s points — one placed, one not; each removal one request; then the alternatives', async ({
  page,
}, testInfo) => {
  const trip = tripFor('points');
  const via = pointsOf(trip, 2);
  const [kept, stopped] = via as [StubVia, StubVia];
  const handlers = withMap(defaultHandlers(trip));
  handlers.recentRoutes = () => ({ routes: [previousRoute(trip, via)] });
  // The per-person limit stops the second lookup (FR-4 3.B): unplaced, like a refusal.
  handlers.viaLocations = viaLocationsHandler({ [stopped.placeId]: 'throttled' });
  const { stub } = await setUp(page, handlers);
  // A map is shown (loading: Google's script is HELD), so the points are looked up — with no
  // map, none would be. Every assertion below is well inside the map's watchdog.
  await holdGoogleMaps(page);
  try {
    const { reportId, vendor, form } = await openMileageForm(page, 'route points');
    const dialog = await openWorkspace(
      page,
      form,
      COPY,
      new RegExp(escapeRegExp(trip.from.description)),
    );
    await expectReopened(page, dialog, stub, trip, via, [2], { computes: 0, locates: 0 });

    // NFR-10: the one axe scan, with the points listed and one of them unplaced — once the
    // dialog has finished fading in (`animate-in fade-in-0`, 200 ms). Mid-fade it is still
    // part-transparent over the backdrop, so axe would measure every colour in it blended
    // with the dimmed page, not as anyone reads it.
    await expect
      .poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity), {
        message: 'the dialog has finished fading in',
      })
      .toBe('1');
    // The points list sits below the panel's fold beside an 80vh map: scrolled into view, as
    // a reader reaches it, or axe cannot see the text it is asked to judge (partly clipped).
    //
    // VeloExpense: TWO scans. The kit's Dialog lays the panel out taller than ExpenseOS's, so
    // scrolling the points list into view clips From off the top of the panel, and axe then
    // reports From's label, dropdown and field as checks it "could not decide" — clipped,
    // not failing. So the panel is scanned as it opens (everything but the points list),
    // then again with the list scrolled into view (the points list alone): every node in
    // the dialog is judged once, while a reader can see it.
    const list = pointsList(page, dialog, trip);
    await list.evaluate((el) => el.setAttribute('data-axe-points', ''));
    const inPoints = async (results: Result[], wanted: boolean): Promise<Result[]> => {
      const kept: Result[] = [];
      for (const result of results) {
        const nodes = [];
        for (const node of result.nodes) {
          const selector = node.target.flat().at(-1);
          const inside =
            typeof selector === 'string' &&
            (await page.evaluate(
              (sel) => document.querySelector(sel)?.closest('[data-axe-points]') != null,
              selector,
            ));
          if (inside === wanted) nodes.push(node);
        }
        if (nodes.length > 0) kept.push({ ...result, nodes });
      }
      return kept;
    };
    const top = await runAxe(page);
    await list.getByRole('listitem').last().scrollIntoViewIfNeeded();
    const scrolled = await runAxe(page);
    const violations = [
      ...(await inPoints(wcagAaViolations(top), false)),
      ...(await inPoints(wcagAaViolations(scrolled), true)),
    ];
    const incomplete = [
      ...(await inPoints(wcagAaIncomplete(top), false)),
      ...(await inPoints(wcagAaIncomplete(scrolled), true)),
    ];
    testInfo.annotations.push({
      type: 'axe, whole page',
      description: `${violations.length} WCAG 2.1 AA violation(s), ${incomplete.length} incomplete`,
    });
    expect(
      (await inDialog(page, violations)).map(describeViolation),
      'the route dialog has no WCAG 2.1 AA violation',
    ).toEqual([]);
    expect(
      (await inDialog(page, incomplete)).map(describeViolation),
      'and no WCAG 2.1 AA check axe could not decide inside it',
    ).toEqual([]);

    // The unplaced point, removed by keyboard: it has no marker, so the panel is the only way.
    const items = pointsList(page, dialog, trip).getByRole('listitem');
    await removePoint(dialog, trip, 2).focus();
    await page.keyboard.press('Enter');
    await expect(items).toHaveCount(1);
    await expect(removePoint(dialog, trip, 1), 'focus stays in the list').toBeFocused();
    await expect(dialog.getByRole('radio'), 'one route through the point left').toHaveCount(1, {
      timeout: 15_000,
    });
    await expect.poll(() => callsTo(stub, 'computeRoutes').length).toBe(2);
    expect(inputsTo(stub, 'computeRoutes', 1), 'the remaining point, on its leg').toEqual([
      { placeIds: idsOf([trip.from, trip.to]), unit: 'KM', via: [kept] },
    ]);

    await removePoint(dialog, trip, 1).click();
    await expect(
      dialog.getByRole('radio'),
      'with no point left, the alternatives come back',
    ).toHaveCount(3, { timeout: 15_000 });
    await expect(
      dialog.getByRole('radio', { name: cardName(SHORTEST, SHORTEST_AT) }),
    ).toBeChecked();
    await expect(removePoint(dialog, trip, 1), 'the list goes with its last point').toHaveCount(0);
    expect(inputsTo(stub, 'computeRoutes', 2), 'no points left to send: no via key').toEqual([
      { placeIds: idsOf([trip.from, trip.to]), unit: 'KM' },
    ]);

    await acceptRoute(page, dialog, SHORTEST_KM);
    const [line] = await readLine(page, reportId, vendor);
    expect(line?.mileageRoute, 'the line filed has no points').not.toHaveProperty('via');
    expect(callsTo(stub, 'computeRoutes'), 'the open, then one per removal').toHaveLength(3);
    expect(
      callsTo(stub, 'viaLocations'),
      'the points are looked up once, never again',
    ).toHaveLength(1);
    expect(stub.unexpected).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('i: From, To and 23 points are 25 stops — Add stop is refused', async ({ page }) => {
  const trip = tripFor('limit');
  const via = pointsOf(trip, 23);
  const handlers = defaultHandlers(trip);
  handlers.recentRoutes = () => ({ routes: [previousRoute(trip, via)] });
  handlers.viaLocations = viaLocationsHandler();
  const { stub } = await setUp(page, handlers);
  const { form } = await openMileageForm(page, 'route limit');
  const dialog = await openWorkspace(
    page,
    form,
    COPY,
    new RegExp(escapeRegExp(trip.from.description)),
  );
  const addStop = dialog.getByRole('button', { name: COPY.addStop, exact: true });
  await expect(removePoint(dialog, trip, 23)).toBeVisible();
  await expect(addStop, 'stops and points share the 25').toBeDisabled();
  await expect(
    dialog.getByText(fill(COPY.maxStops, { max: 25 }), { exact: true }),
    'the existing message, unchanged',
  ).toBeVisible();
  await expect(dialog.getByRole('radio'), 'reopened as its one card').toHaveCount(1, {
    timeout: 15_000,
  });
  // No browser key, so no map: nobody would see a marker, so no point is looked up — each
  // is listed plainly, neither placed nor "not on the map" (counted last, below).
  await expect(dialog.getByText(COPY.pointUnplaced, { exact: true })).toHaveCount(0);
  expect(inputsTo(stub, 'computeRoutes'), 'the open is ONE request, through all 23').toEqual([
    { placeIds: idsOf([trip.from, trip.to]), unit: 'KM', via },
  ]);

  await removePoint(dialog, trip, 23).click();
  await expect(addStop, 'one point fewer: room for a stop').toBeEnabled();
  await expect.poll(() => callsTo(stub, 'computeRoutes').length).toBe(2);
  expect(inputsTo(stub, 'computeRoutes', 1)).toEqual([
    { placeIds: idsOf([trip.from, trip.to]), unit: 'KM', via: via.slice(0, 22) },
  ]);
  expect(callsTo(stub, 'viaLocations'), 'no map shown: no location lookup at all').toEqual([]);
  expect(stub.unexpected).toEqual([]);
});

/**
 * File one routed line per trip on the vendor's expense, straight through the real
 * `expenses.lineItemCreate` — the page only has to reach its assertions, not build six
 * routes by hand. Returns the lines' ids.
 */
async function seedRoutedLines(
  page: Page,
  reportId: string,
  vendor: string,
  trips: readonly Trip[],
): Promise<string[]> {
  const categories = await trpcQueryOk<{ id: string; isMileage: boolean; label: unknown }[]>(
    page,
    'expenses.categories',
    undefined,
  );
  const mileage =
    categories.find((c) => c.isMileage && MILEAGE_CATEGORY.test(JSON.stringify(c.label))) ??
    categories.find((c) => c.isMileage);
  if (!mileage) throw new Error('no mileage category is seeded');
  const expense = await readExpense(page, reportId, vendor);
  for (const trip of trips) {
    await trpcOk(page, 'expenses.lineItemCreate', {
      expenseId: expense.id,
      categoryId: mileage.id,
      mileageDistance: SHORTEST_KM,
      mileageUnit: 'KM',
      mileageRoute: storedRoute([trip.from, trip.to], SHORTEST, SHORTEST_AT, 3),
    });
  }
  const ids = (await readExpense(page, reportId, vendor)).lineItems.map((l) => l.id);
  expect(ids, 'one line per trip').toHaveLength(trips.length);
  return ids;
}

test('j: six routed lines — five maps and one sentence; with the map library down, no path once the summaries show', async ({
  page,
}) => {
  const trips = Array.from({ length: 6 }, (_, i) => tripFor(`cap ${i + 1}`));
  const handlers = withMap(defaultHandlers(trips[0] as Trip));
  const { google } = await setUp(page, handlers);
  const reportId = await createReport(page, reportTag('route cap'));
  const url = page.url();
  const vendor = `Mileage route cap ${Date.now().toString(36)}`;
  await addBlankExpense(page, vendor);
  const ids = await seedRoutedLines(page, reportId, vendor, trips);

  // 1. Google's script HELD, on a page of its own: every map that starts stays loading, so
  //    five hold their slots and the sixth line shows its summary and the sentence.
  const held = await page.context().newPage();
  const heldStub = await stubMileageRoute(held, handlers);
  await holdGoogleMaps(held);
  try {
    const lines = await openExpense(held, url, vendor);
    await expect(routeDropdowns(lines)).toHaveCount(6);
    await scrollThroughLines(lines);
    await expect
      .poll(() => callsTo(heldStub, 'lineRoutePath').length, {
        message: 'five line maps on the page, each asking for its path once',
        timeout: WATCHDOG_MS - 2_000,
      })
      .toBe(5);
    await expect(loadingMaps(lines), 'five maps, loading').toHaveCount(5);
    await expect(
      lines.getByText(COPY.lineMapCapped, { exact: true }),
      'the sixth line says why it shows no map — once',
    ).toHaveCount(1);

    await trpcQueryOk(held, 'expenses.report', { reportId });
    const asked = inputsTo(heldStub, 'lineRoutePath').map(
      (i) => (i as { lineItemId: string }).lineItemId,
    );
    expect(asked, 'exactly five path requests').toHaveLength(5);
    expect(new Set(asked).size, 'one per mapped line').toBe(5);
    for (const id of asked) expect(ids, 'each for one of the six lines').toContain(id);
    await expect(
      loadingMaps(lines),
      'the maps fell back before the assertions ended, so the five-map state was not what ' +
        `was measured (the ${WATCHDOG_MS / 1000} s watchdog)`,
    ).toHaveCount(5);
    expect(heldStub.unexpected).toEqual([]);
  } finally {
    await held.unrouteAll({ behavior: 'ignoreErrors' });
    await held.close();
  }

  // 2. Google ABORTED (the context route): the first map to load its script fails, which
  //    is a failure of the map library — from then on no line asks for a path.
  const down = await page.context().newPage();
  const downStub = await stubMileageRoute(down, handlers);
  try {
    const googleBefore = google.requests().length;
    const lines = await openExpense(down, url, vendor);
    await expect(routeDropdowns(lines)).toHaveCount(6);
    // The lines open below the fold, and a line asks for its map only once it has been on
    // screen (`useOnScreen`): bring the FIRST one into view, so its map is the one that
    // loads Google's script and fails — the rest are scrolled to only after that.
    await routeDropdowns(lines).first().scrollIntoViewIfNeeded();
    await expect
      .poll(
        async () =>
          callsTo(downStub, 'lineRoutePath').length > 0 && (await loadingMaps(lines).count()) === 0,
        {
          message: 'the maps on screen asked for their paths and fell back to their summaries',
          timeout: 20_000,
        },
      )
      .toBe(true);
    const asked = callsTo(downStub, 'lineRoutePath').length;

    await scrollThroughLines(lines);
    for (const [i, trip] of trips.entries()) {
      await expect(summaryOf(lines, trip), `line ${i + 1} shows its summary`).toBeVisible();
    }
    await trpcQueryOk(down, 'expenses.report', { reportId });
    expect(
      callsTo(downStub, 'lineRoutePath').length,
      'once the summaries show, scrolling the other lines into view asks for no path',
    ).toBe(asked);
    await expect(loadingMaps(lines), 'no map is left loading').toHaveCount(0);
    await expect(
      lines.getByText(COPY.lineMapCapped, { exact: true }),
      'no "five maps" sentence: the map library is down, not the slots full',
    ).toHaveCount(0);
    expect(
      google.requests().length,
      'the line map tried to load Google and was aborted',
    ).toBeGreaterThan(googleBefore);
    expect(downStub.unexpected).toEqual([]);
  } finally {
    await down.close();
  }
});

test('k: the layout — panel left, map right, the close button off the map, the gaps', async ({
  page,
}) => {
  const trip = tripFor('layout');
  const earlier = tripFor('layout earlier');
  const handlers = withMap(defaultHandlers(trip));
  handlers.recentRoutes = () => ({ routes: [previousRoute(earlier)] });
  const { stub } = await setUp(page, handlers);
  const held = await holdGoogleMaps(page);
  try {
    const { reportId, vendor, form } = await openMileageForm(page, 'route layout');

    // FR-7: a new line's dropdown, full width under the category row, 12 px below it.
    const fresh = await routeBlockLayout(routeDropdowns(form));
    const freshAt = JSON.stringify(fresh);
    expect(
      Math.abs(fresh.gap - LINE_GAP_PX),
      `a new line's dropdown sits ${LINE_GAP_PX} px under its row (${freshAt})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(fresh.left - fresh.rowLeft),
      `it starts at the form's left edge (${freshAt})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(fresh.width - fresh.rowWidth),
      `and spans the form's width (${freshAt})`,
    ).toBeLessThanOrEqual(1);

    // FR-6: the workspace, its map held in its loading state.
    const dialog = await openWorkspace(page, form, COPY);
    const map = dialog.getByRole('region', { name: MAP_REGION });
    await expect(map, 'a browser key: the map area shows while Google loads').toBeVisible();
    await expect
      .poll(() => held.requests().length, {
        message: 'the map never asked Google for its script, so nothing is being held',
      })
      .toBeGreaterThan(0);
    await expect(
      map.getByRole('status'),
      "the modal's spinner is its one loading status, read by its text (FR-6 step 5)",
    ).toHaveText(COPY.mapLoading);
    await expect(dialog.getByLabel('From', { exact: true })).toBeFocused();

    const panel = dialog.getByRole('region', { name: COPY.panelLabel, exact: true });
    const column = await panel.locator('xpath=..').boundingBox();
    const mapBox = await map.boundingBox();
    const close = await dialog.getByRole('button', { name: CLOSE, exact: true }).boundingBox();
    if (!column || !mapBox || !close) throw new Error('the panel, the map or the X has no box');
    const boxes = JSON.stringify({ column, mapBox, close });
    expect(
      Math.abs(column.width - PANEL_PX),
      `the panel column is ${PANEL_PX} px (${boxes})`,
    ).toBeLessThanOrEqual(1);
    expect(
      column.x + column.width,
      `the panel is on the left, the map on the right (${boxes})`,
    ).toBeLessThanOrEqual(mapBox.x + 1);
    const overlaps =
      close.x < mapBox.x + mapBox.width &&
      close.x + close.width > mapBox.x &&
      close.y < mapBox.y + mapBox.height &&
      close.y + close.height > mapBox.y;
    expect(overlaps, `the close button sits on the dialog, not on the map (${boxes})`).toBe(false);
    const panelFirst = await panel.evaluate(
      (p, m) => Boolean(m && p.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING),
      await map.elementHandle(),
    );
    expect(panelFirst, 'the panel comes before the map in the DOM, so Tab reaches it first').toBe(
      true,
    );

    // FR-6 step 4: 20 px from the Previous routes block to From/To.
    const block = dialog.locator('label', { hasText: COPY.previousRoutes }).locator('xpath=..');
    const gap = await verticalGap(block, block.locator('xpath=following-sibling::*[1]'));
    expect(
      Math.abs(gap - PANEL_GAP_PX),
      `Previous routes to From is ${PANEL_GAP_PX} px (measured ${gap})`,
    ).toBeLessThanOrEqual(2);
    await expect(
      map,
      'the map fell back before the measurement ended, so the loading layout was not what ' +
        `was measured (the ${WATCHDOG_MS / 1000} s watchdog)`,
    ).toBeVisible();

    // FR-6 step 2: the modal's dropdown offers previous routes only.
    await dialog.getByRole('combobox', { name: COPY.previousRoutes, exact: true }).click();
    const entry = page.getByRole('option', {
      name: new RegExp(escapeRegExp(earlier.from.description)),
    });
    await expect(entry, 'the previous route is offered').toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('option', { name: COPY.newRoute, exact: true }),
      'and no "New route": the workspace is where a route is made',
    ).toHaveCount(0);
    await entry.click();
    await expect(dialog.getByRole('radio'), 'the previous route, as its one card').toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(dialog.getByLabel('From', { exact: true })).toHaveValue(earlier.from.description);
    await acceptRoute(page, dialog, SHORTEST_KM);

    // FR-7: the saved line's dropdown.
    //
    // VeloExpense: ExpenseOS #595 (`mileage-route-line`) moved a saved line that HAS a route
    // to 18 px (6 px row gap + `mt-3`, "more space around them"), and pinned that in
    // `MileageFields.test.tsx`, but left this check at #593's 12 px and "the same gap as a
    // new line" — so it fails against ExpenseOS's own code. Ported against #595's rule.
    const lines = lineItemsBlock(page);
    const saved = await routeBlockLayout(routeDropdowns(lines));
    expect(
      Math.abs(saved.gap - SAVED_ROUTE_GAP_PX),
      `a saved line with a route has its dropdown ${SAVED_ROUTE_GAP_PX} px under its row (${JSON.stringify(saved)})`,
    ).toBeLessThanOrEqual(1);

    const [line] = await readLine(page, reportId, vendor);
    expect(line?.mileageRoute).toEqual(storedRoute([earlier.from, earlier.to], SHORTEST, 0, 1));
    expect(
      inputsTo(stub, 'computeRoutes'),
      'the previous route picked in the modal is one request',
    ).toEqual([{ placeIds: idsOf([earlier.from, earlier.to]), unit: 'KM' }]);
    expect(stub.unexpected).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

import { expect, type Locator, type Page, test } from '@playwright/test';
import { signIn } from './support/actors';
import { pickCombobox } from './support/combobox';
import {
  abortGoogleMaps,
  addBlankExpense,
  callsTo,
  dialogSettled,
  escapeRegExp,
  fakePlace,
  type GoogleWatch,
  holdGoogleMaps,
  type MileageHandlers,
  metersToDistance,
  openWorkspace,
  pickPlace,
  placesHandler,
  type RecentRouteAnswer,
  type RoutePickerCopy,
  type RouteSpec,
  routePickerCopy,
  routesFor,
  stubMileageRoute,
  verticalGap,
} from './support/mileage';
import { PHONE_PROJECTS } from './support/phone-projects';
import {
  assertCoarsePointer,
  assertProject,
  censusOf,
  EPS,
  HIT_FLOOR_PX,
} from './support/tap-targets';
import { createReport, reportTag } from './support/workbench';

/**
 * "Choose a route" on a phone: the phone sheet (FR-2 1.A as amended for Paralegal B5), the
 * action in reach, nothing wider than the screen, and nothing over the map's corners.
 *
 * ─── WHAT THIS PINS ─────────────────────────────────────────────────────────────────────
 *
 * At 767 px and below the workspace is a full-screen sheet (`RoutePickerModal.tsx`,
 * `RouteWorkspacePanel.tsx`): the title, the inputs on top, the map below them, the route
 * list DOCKED BELOW the map behind a handle, and "Use this route" pinned to the bottom.
 * The list is in normal flow after the map and never laid over it, because a sheet over
 * the map's bottom edge would cover exactly the corners where Google draws its logo and
 * attribution. So, on THREE routes with LONG labels:
 *
 *   · the order on screen and in the DOM: From and To above the map, the docked list (its
 *     handle and cards) after the map, a sibling of it and not positioned over it;
 *   · the CORNER PROBE: `document.elementFromPoint` just inside the map's two bottom
 *     corners resolves to an element inside the map's own region — nothing else is there —
 *     with the list open and closed. Google's script is held here, so the logo itself is
 *     not drawn; what is proven is that nothing of ours covers or clips the place it goes;
 *   · the handle: a button whose `aria-expanded` follows a tap, the list it controls
 *     (`aria-controls`) shown and hidden with it, 44 px tall under a coarse pointer;
 *   · "Use this route" is in the viewport, before and after a card is chosen and with the
 *     list open or closed; neither the page nor the dialog scrolls sideways
 *     (`scrollWidth <= clientWidth` on `documentElement` and on the dialog), and no card's
 *     or the handle's right edge passes the viewport;
 *   · the pointer is coarse (`assertCoarsePointer`, the guard every phone spec takes), and
 *     the footer's two buttons and each card reach the 44 px floor (`HIT_FLOOR_PX`);
 *   · 20 px from the Previous routes block to From (spec FR-6 step 4: the sheet's 12 px
 *     `gap-3` plus the block's 8 px `mb-2`), so the person has ONE previous route here —
 *     with none the block is not rendered at all;
 *   · with the map held, the modal's spinner is the map area's one `role="status"`, read by
 *     the catalog's loading text (spec FR-6 step 5).
 *
 * Twice per locale: with no map (`mapAvailable: false`, the "Map unavailable" line, and the
 * cards in flow with no handle), and with a map whose Google script is HELD unanswered
 * (`holdGoogleMaps`), so the map area stays in its loading state for the whole
 * measurement. The picker falls back to the list after a 10 s watchdog, so the held case
 * asserts the map area is still there AFTER measuring — a measurement taken after the
 * fallback would be the no-map case twice.
 *
 * What only a real phone shows — that a finger raises Google's polyline `mousedown`, that
 * the pointer survives the 450 ms long-press, that no callout appears — is the operator's
 * check, not this file's: Google is never answered here, so there is no line to press.
 *
 * ─── BOTH LOCALES ────────────────────────────────────────────────────────────────────────
 *
 * EN and FR-CA, at 360, 390 and 412 px (the three phone projects), with the same
 * `E2E_LOCALE` knob as `e2e/expenses.mobile.spec.ts`. French copy runs longer ("Utiliser
 * cet itinéraire", the drive-time sentence), which is where a pinned footer wraps first.
 * Every string — the map area's name (`route.picker.mapLabel`) included — is read from the
 * catalog the app renders (`routePickerCopy`), so the FR-CA half is a real French run.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 150_000 });

/**
 * VeloExpense: EN ONLY, as `e2e/dashboard.mobile.spec.ts` explains — VeloExpense serves no
 * French yet (its locales are en-CA and en-US, and every screen renders the `en` catalog),
 * so there is no FR-CA page to run against, and its URLs carry no locale segment.
 * `LOCALES` keeps ExpenseOS's shape with one entry; the day French is offered, its second
 * entry comes back.
 */
type Locale = 'en' | 'fr-CA';
const LOCALES: Locale[] = ['en'];

/** The width the fixture is built at, as in `expense-workbench.mobile.spec.ts`. */
const DESKTOP = { width: 1280, height: 900 } as const;

/**
 * Three routes with LONG labels: the width problem, at its worst realistic case. The second
 * carries a long run with no spaces, which only wraps if the card allows a break anywhere.
 */
const LONG_ROUTES: readonly RouteSpec[] = [
  {
    label:
      'Trans-Canada Hwy 401 Express Collector Lanes and Queen Elizabeth Way eastbound via Mississauga',
    totalMeters: 187_430,
    durationSeconds: 13_500,
  },
  {
    label: 'Autoroute-Jean-Lesage/Autoroute-Félix-Leclerc/QC-138-Chemin-du-Roy-Saint-Augustin',
    totalMeters: 201_670,
    durationSeconds: 14_100,
  },
  {
    label: 'County Road 2 and King’s Highway 401 through Belleville, Napanee and Kingston',
    totalMeters: 215_380,
    durationSeconds: null,
  },
];

/** FR-6 step 4: Previous routes block to From/To, on the sheet as on desktop. */
const PANEL_GAP_PX = 20;

/** One previous route, so the panel renders its Previous routes block. */
function previousRoute(from: { placeId: string; description: string }, to: typeof from) {
  const spec = LONG_ROUTES[0] as RouteSpec;
  return {
    stops: [from, to],
    legs: [{ fromPlaceId: from.placeId, toPlaceId: to.placeId, meters: spec.totalMeters }],
    routeIndex: 0,
    routeCount: 1,
    distance: {
      KM: metersToDistance(spec.totalMeters, 'KM'),
      MI: metersToDistance(spec.totalMeters, 'MI'),
    },
  } satisfies RecentRouteAnswer;
}

test.beforeEach(async ({ page }, testInfo) => {
  void page;
  assertProject(testInfo, PHONE_PROJECTS);
});

/** Build on a sibling desktop page in the same context, then close it. */
async function onDesktop<T>(page: Page, build: (desk: Page) => Promise<T>): Promise<T> {
  const desk = await page.context().newPage();
  await desk.setViewportSize(DESKTOP);
  try {
    return await build(desk);
  } finally {
    await desk.close();
  }
}

/** Fail with the measurement when anything scrolls sideways. */
async function expectNoSidewaysScroll(page: Page, dialog: Locator, when: string): Promise<void> {
  const doc = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    doc.scroll,
    `the page scrolls sideways ${when} (${JSON.stringify(doc)})`,
  ).toBeLessThanOrEqual(doc.client);
  const box = await dialog.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(
    box.scroll,
    `the dialog scrolls sideways ${when} (${JSON.stringify(box)})`,
  ).toBeLessThanOrEqual(box.client);
  const width = page.viewportSize()?.width ?? 0;
  const radios = dialog.getByRole('radio');
  for (let i = 0; i < (await radios.count()); i += 1) {
    const card = radios.nth(i).locator('xpath=ancestor::label[1]');
    const b = await card.boundingBox();
    expect(b, `card ${i + 1} has no box`).not.toBeNull();
    expect(
      (b?.x ?? 0) + (b?.width ?? 0),
      `card ${i + 1} runs past the ${width}px viewport ${when}: a long route name did not wrap`,
    ).toBeLessThanOrEqual(width + EPS);
  }
}

/**
 * The footer's two buttons reach 44 px under a coarse pointer, and so does each card.
 *
 * The buttons are found in the census by their own box rather than by name, because the
 * new-line form's Cancel is still in the DOM behind the sheet and has the same name. A card
 * is a `<label>` around its radio, so the label is what a finger aims at.
 *
 * Call it with a card CHOSEN and its price in, once "Use this route" has lost its
 * `aria-disabled`: the target measured is then one a finger can actually use.
 */
async function expectTapTargets(page: Page, dialog: Locator, copy: RoutePickerCopy): Promise<void> {
  await assertCoarsePointer(page);
  const census = await censusOf(page);
  for (const name of [copy.useRoute, copy.cancel]) {
    const b = await dialog.getByRole('button', { name, exact: true }).boundingBox();
    expect(b, `"${name}" has no box`).not.toBeNull();
    const found = census.candidates.find(
      (c) => Math.abs(c.box.l - (b?.x ?? -1)) < 1 && Math.abs(c.box.t - (b?.y ?? -1)) < 1,
    );
    expect(
      found,
      `"${name}" is not in the tap census: it is off-screen or something covers it`,
    ).toBeTruthy();
    expect(
      found ? found.hit.b - found.hit.t : 0,
      `"${name}" is under 44px tall`,
    ).toBeGreaterThanOrEqual(HIT_FLOOR_PX - EPS);
    expect(
      found ? found.hit.r - found.hit.l : 0,
      `"${name}" is under 44px wide`,
    ).toBeGreaterThanOrEqual(HIT_FLOOR_PX - EPS);
  }
  const radios = dialog.getByRole('radio');
  for (let i = 0; i < (await radios.count()); i += 1) {
    const b = await radios.nth(i).locator('xpath=ancestor::label[1]').boundingBox();
    expect(b?.height ?? 0, `card ${i + 1} is under 44px tall`).toBeGreaterThanOrEqual(
      HIT_FLOOR_PX - EPS,
    );
  }
}

/** Everything this file asserts about the open sheet, in the state it is in now. */
async function measure(page: Page, dialog: Locator, copy: RoutePickerCopy, when: string) {
  const use = dialog.getByRole('button', { name: copy.useRoute, exact: true });
  await expect(use, `"${copy.useRoute}" is out of reach ${when}`).toBeInViewport();
  await expectNoSidewaysScroll(page, dialog, when);
  const handle = dialog.getByTestId('route-sheet-toggle');
  if ((await handle.count()) > 0) {
    const b = await handle.boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(
      (b?.x ?? 0) + (b?.width ?? 0),
      `the route list's handle runs past the ${width}px viewport ${when}`,
    ).toBeLessThanOrEqual(width + EPS);
    expect(b?.height ?? 0, `the handle is under 44px tall ${when}`).toBeGreaterThanOrEqual(
      HIT_FLOOR_PX - EPS,
    );
  }
}

/** How far inside each bottom corner the probe looks: past the region's 1 px border and radius. */
const CORNER_INSET_PX = 8;

/**
 * The corner probe (B5): just inside the map's bottom-left and bottom-right corners —
 * where Google draws its logo and its attribution — the topmost element must belong to the
 * map's own region. A route list, a footer or a scroll edge laid over the map's bottom
 * would answer with itself here. Brought into view first: the sheet's body scrolls when the
 * open list does not fit, and a corner scrolled out of sight is not a corner covered.
 */
async function expectMapCornersClear(map: Locator, when: string): Promise<void> {
  await map.scrollIntoViewIfNeeded();
  const probe = await map.evaluate((region, inset) => {
    const r = region.getBoundingClientRect();
    const name = (el: Element | null) =>
      el
        ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
            typeof el.className === 'string' && el.className
              ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
              : ''
          }`
        : 'nothing';
    const at = (corner: string, x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return {
        corner,
        x,
        y,
        inside: hit !== null && region.contains(hit),
        hit: name(hit),
      };
    };
    return {
      box: { left: r.left, right: r.right, bottom: r.bottom, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      corners: [
        at('bottom-left', r.left + inset, r.bottom - inset),
        at('bottom-right', r.right - inset, r.bottom - inset),
      ],
    };
  }, CORNER_INSET_PX);
  expect(probe.box.height, `the map has no height ${when}`).toBeGreaterThan(2 * CORNER_INSET_PX);
  for (const c of probe.corners) {
    expect(
      c.y,
      `the map's ${c.corner} corner is below the viewport ${when} (${JSON.stringify(probe)})`,
    ).toBeLessThanOrEqual(probe.viewport.height);
    expect(
      c.inside,
      `something covers the map's ${c.corner} corner, where Google's logo and attribution go, ` +
        `${when}: ${c.hit} at (${c.x}, ${c.y})`,
    ).toBe(true);
  }
}

/**
 * The phone sheet's order: the inputs above the map, and the docked list a sibling AFTER
 * the map in the DOM and below it on screen — in flow, not positioned over it.
 */
async function expectDockedBelowMap(dialog: Locator, map: Locator, copy: RoutePickerCopy) {
  const sheet = dialog.getByTestId('route-sheet');
  await expect(sheet, 'the route list is docked on the sheet').toHaveCount(1);
  const order = await map.evaluate((region) => {
    const docked = region.parentElement?.querySelector('[data-testid="route-sheet"]') ?? null;
    return {
      sibling: docked !== null && docked.parentElement === region.parentElement,
      after:
        docked !== null &&
        Boolean(region.compareDocumentPosition(docked) & Node.DOCUMENT_POSITION_FOLLOWING),
      position: docked ? getComputedStyle(docked).position : null,
    };
  });
  expect(order.sibling, 'the docked list is not a sibling of the map').toBe(true);
  expect(order.after, 'the docked list comes before the map in the DOM').toBe(true);
  expect(['static', 'relative'], 'the docked list is positioned out of flow').toContain(
    order.position,
  );

  const mapBox = await map.boundingBox();
  const sheetBox = await sheet.boundingBox();
  const toBox = await dialog.getByLabel(copy.to, { exact: true }).boundingBox();
  expect(mapBox && sheetBox && toBox, 'the map, the list or To has no box').toBeTruthy();
  expect(
    (toBox?.y ?? 0) + (toBox?.height ?? 0),
    'To is not above the map: the inputs belong on top',
  ).toBeLessThanOrEqual((mapBox?.y ?? 0) + EPS);
  expect(
    sheetBox?.y ?? 0,
    "the route list starts above the map's bottom edge",
  ).toBeGreaterThanOrEqual((mapBox?.y ?? 0) + (mapBox?.height ?? 0) - EPS);
}

for (const locale of LOCALES) {
  for (const map of ['none', 'loading'] as const) {
    test(`${locale}: the route picker fits a phone — map ${map}`, async ({ page }) => {
      const copy = routePickerCopy(locale);
      const tag = `${locale}-${map}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
      const from = fakePlace(tag, 'from', `100 Front St W, Toronto, ON (e2e ${tag})`);
      const to = fakePlace(tag, 'to', `111 Wellington St, Ottawa, ON (e2e ${tag})`);
      const earlierFrom = fakePlace(tag, 'earlier-from', `1 Yonge St, Toronto, ON (e2e ${tag})`);
      const earlierTo = fakePlace(tag, 'earlier-to', `1 Rideau St, Ottawa, ON (e2e ${tag})`);

      const handlers: MileageHandlers = {
        status: () => ({ available: true, mapAvailable: map === 'loading' }),
        searchPlaces: placesHandler([from, to]),
        computeRoutes: routesFor(LONG_ROUTES),
        recentRoutes: () => ({ routes: [previousRoute(earlierFrom, earlierTo)] }),
        ...(map === 'loading'
          ? { mapConfig: () => ({ browserApiKey: 'e2e-not-a-key', region: null }) }
          : {}),
      };

      await signIn(page, 'employee');
      // Aborted context-wide as a safety net; the held case holds them on this page instead
      // (a page route wins over a context route).
      const aborted = await abortGoogleMaps(page.context());
      const held: GoogleWatch | null = map === 'loading' ? await holdGoogleMaps(page) : null;
      const stub = await stubMileageRoute(page, handlers);

      try {
        const id = await onDesktop(page, async (desk) => {
          const reportId = await createReport(desk, reportTag(`phone route ${locale}`));
          await addBlankExpense(desk, `Mileage phone ${tag}`);
          return reportId;
        });

        // VeloExpense: no locale segment in the URL (see `LOCALES`).
        const url = `/expenses/${id}`;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        expect(response?.status(), `GET ${url} did not answer 200`).toBe(200);
        expect(
          await page.locator('[data-testid="offline-page"]').count(),
          'the service worker served the offline fallback in place of the report',
        ).toBe(0);
        await expect(
          page.getByTestId('report-summary'),
          'the phone tree never mounted (hydration, or `useIsBelowLg` answered false)',
        ).toBeVisible({ timeout: 30_000 });
        await assertCoarsePointer(page);

        await page.getByRole('button', { name: copy.addLineOpener, exact: true }).first().click();
        // VeloExpense: the kit's category picker is a button carrying `data-placeholder`.
        await pickCombobox(
          page,
          page.locator(`[data-placeholder="${copy.categoryPlaceholder}"]`),
          new RegExp(escapeRegExp(copy.mileageCategory)),
        );
        // The new line is one route dropdown; New route opens the workspace, which routes
        // the stops by itself once both are picked places (FR-1, FR-3).
        const dialog = await openWorkspace(page, page.locator('body'), copy);

        // FR-6 step 4, measured before anything moves the sheet's top half.
        const block = dialog.locator('label', { hasText: copy.previousRoutes }).locator('xpath=..');
        await expect(block, 'one previous route: the Previous routes block shows').toBeVisible();
        // Not mid-open: the sheet zooms in from 0.95, and two boxes read during it disagree.
        await dialogSettled(dialog);
        const gap = await verticalGap(block, block.locator('xpath=following-sibling::*[1]'));
        expect(
          Math.abs(gap - PANEL_GAP_PX),
          `Previous routes to From is ${PANEL_GAP_PX} px on the sheet (measured ${gap})`,
        ).toBeLessThanOrEqual(2);

        await pickPlace(dialog, copy.from, from, '100 Front St W');
        await pickPlace(dialog, copy.to, to, '111 Wellington St');
        await expect(dialog.getByRole('radio')).toHaveCount(3, { timeout: 15_000 });

        const region = dialog.getByRole('region', { name: copy.mapLabel, exact: true });
        const handle = dialog.getByTestId('route-sheet-toggle');
        if (map === 'loading') {
          await expect(region, 'the map area shows while Google loads').toBeVisible();
          await expect
            .poll(() => held?.requests().length ?? 0, {
              message: 'the map never asked Google for its script, so nothing is being held',
            })
            .toBeGreaterThan(0);
          await expect(
            region.getByRole('status'),
            "the spinner is the map area's one loading status, read by its text",
          ).toHaveText(copy.mapLoading);

          await expectDockedBelowMap(dialog, region, copy);
          // Three routes: the list opened by itself, once.
          await expect(handle).toHaveAttribute('aria-expanded', 'true');
          const listId = await handle.getAttribute('aria-controls');
          expect(listId, 'the handle names the list it controls').toBeTruthy();
          const list = page.locator(`[id="${listId}"]`);
          await expect(list.getByRole('radio')).toHaveCount(3);
          await expectMapCornersClear(region, 'with the route list open');
          await measure(page, dialog, copy, 'with the route list open');

          // Closed: the cards go, the map and the footer stay, the corners stay clear.
          await handle.click();
          await expect(handle).toHaveAttribute('aria-expanded', 'false');
          await expect(list).toBeHidden();
          await expectMapCornersClear(region, 'with the route list closed');
          await measure(page, dialog, copy, 'with the route list closed');

          await handle.click();
          await expect(handle).toHaveAttribute('aria-expanded', 'true');
          await expect(list).toBeVisible();
        } else {
          await expect(dialog.getByText(copy.mapUnavailable, { exact: true })).toBeVisible();
          await expect(region).toHaveCount(0);
          // No map: nothing to dock below, so the cards are in the panel with no handle.
          await expect(handle).toHaveCount(0);
          await expect(dialog.getByRole('radio').first()).toBeVisible();
        }

        await measure(page, dialog, copy, 'with the shortest route selected');

        // Choose the last card by tapping it: its check icon and heavier border must fit too.
        const last = dialog.getByRole('radio').nth(2);
        await last.click();
        await expect(last).toBeChecked();
        await expect(
          dialog.getByRole('button', { name: copy.useRoute, exact: true }),
        ).not.toHaveAttribute('aria-disabled', 'true', { timeout: 30_000 });
        await measure(page, dialog, copy, 'with the last card chosen');
        // Only now: an enabled "Use this route" is one a finger can land on.
        await expectTapTargets(page, dialog, copy);
        if (map === 'loading') {
          await expectMapCornersClear(region, 'with the last card chosen');
          await expect(
            region,
            'the map area fell back before the measurement ended, so the loading state was ' +
              'not what was measured',
          ).toBeVisible();
        }

        expect(
          callsTo(stub, 'mapConfig').length,
          map === 'loading' ? 'the dialog asked for the key once' : 'no map, no key asked for',
        ).toBe(map === 'loading' ? 1 : 0);
        if (map === 'none') {
          expect(aborted.requests(), 'no map, so nothing is asked of Google').toEqual([]);
        }
        expect(stub.unexpected, 'mileageRoute procedures called with no handler').toEqual([]);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });
  }
}

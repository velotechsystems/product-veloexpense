import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { pressAndSettle } from './support/actions';
import { signIn, switchTo } from './support/actors';
import { pickCombobox } from './support/combobox';
import { PHONE_PROJECTS } from './support/phone-projects';
import { expectAnyRowEventually, expectAnyRowGone, rowFor } from './support/rows';
import { assertProject } from './support/tap-targets';
import { closeTestDb, testDb } from './support/test-db';
import {
  addExpense,
  createReport,
  openExpenseList,
  reportTag,
  selectExpense,
} from './support/workbench';

/**
 * VeloExpense: ExpenseOS's `e2e/expense-workbench.mobile.spec.ts` (1e682dd6), ported with the
 * phone projects. It replaces `e2e/expense-workbench-phone.spec.ts`, which carried only
 * #576's two tests at one width on `chromium`. What changed is the plumbing, each marked
 * "VeloExpense:" below:
 *   · URLs carry no locale segment (`reportUrl`, the list and queue paths);
 *   · `testDb` is an admin `pg` pool (`e2e/support/test-db.ts` says why), so the four
 *     reads and writes ExpenseOS makes through Prisma are SQL here, and `clearReceiptScans`
 *     names the receipt's tenant on the row it writes;
 *   · the kit Combobox is a button, found by `data-placeholder` and read as text;
 *   · the seed's USD->CAD rate is put back before the add flow, because `analytics-flow`
 *     deletes every rate (as `fx-rates-flow.spec.ts` notes);
 *   · the line numbers ExpenseOS cites in its comments are ExpenseOS's files, not these.
 *
 * The primary flows of `/expenses/[reportId]`, on a phone — read, see the receipt, submit,
 * respond to a return, and (P18) add an expense and fill it in — plus the live-resize check
 * that the editor survives a window crossing `lg`. This is also the file that replaces the
 * P06 ticket's done-criterion 1, which was unsatisfiable as written.
 *
 * ─── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────
 *
 * The criterion said "the mobile crawl passes for `/expenses/[reportId]` at 360 and 390".
 * The crawl never visits this route and could not have: `e2e/support/routes.ts:60` is
 * `STATIC_ROUTES = ALL_ROUTES.filter((r) => !r.includes('['))`, so the route is filtered out
 * of the corpus before a browser starts. There is no seeded id, no discovery walk and no
 * skip branch — it is not "the crawl is green on this route", it is "the crawl has never
 * heard of this route".
 *
 * AND IT WOULD NOT HAVE HELPED IF IT DID VISIT, which is the half that matters for what is
 * measured below. The crawl's gate is `scrollWidth - clientWidth` on `main#main-content`
 * (`e2e/support/mobile-census.ts:190`). This page's three panes live inside
 * `<ResizablePanels className="overflow-x-auto">`, and an `overflow-x: auto` box CONTAINS
 * its own overflow — its `scrollWidth` grows and its parent's never learns about it. An
 * 1100px pane group inside that box is green to the census by construction, at any width.
 * So the overflow claim has to be made about the scroll container itself, and that is what
 * `expectNoHorizontalOverflow` below does.
 *
 * ─── THE FILENAME IS A CONTRACT ──────────────────────────────────────────────────────────
 *
 * `expense-workbench.mobile.spec.ts` — a DOT before `mobile`, not a hyphen.
 * `playwright.config.ts:101` sweeps `.*\.mobile\.spec\.ts` into `PHONE_ONLY_SPEC_PATTERNS`,
 * which is both the phone projects' `testMatch` and `chromium`'s `testIgnore`. A hyphen puts
 * this file in the chromium bucket silently, where every assertion below is about a viewport
 * that is not there. NO CONFIG EDIT IS NEEDED OR WANTED: the subset invariant holds by
 * construction, and the epic's § 5 criterion-2 warning that somebody must "widen that
 * testMatch" is stale — that widening already shipped, as a convention rather than a list.
 * `assertProject` in `beforeEach` is the runtime half of the same claim.
 *
 * ─── SETUP HAPPENS AT A DESKTOP WIDTH, AND THAT IS THE POINT RATHER THAN A DODGE ──────────
 *
 * Every flow needs a report with real data in it, and the fixture is built at 1280 even though
 * P18 put the expense fields and the line block back on a phone. Two reasons, neither of them
 * a ruling any more. `e2e/support/workbench.ts`'s `addExpense` acknowledges each expense
 * through its LIST ROW, and below `lg` that row is inside the collapsed expenses disclosure, so
 * the acknowledgement resolves nothing there; and the fixture attaches a receipt, which the
 * receipt pane does differently on a phone. The phone add flow is driven by
 * `addExpenseOnPhone` in this file instead, and it is the flow under test, not fixture. The tax
 * panel, the cost allocation and the attendees are still `hidden lg:contents` below `lg`.
 *
 * So the fixture is built on a SIBLING PAGE in the same browser context, sized 1280,
 * and the phone `page` never leaves phone metrics. Same cookies (`signIn` clears and sets
 * them on the CONTEXT), same server, same data — and the thing under test is only ever
 * driven at the project's own viewport. `onDesktop` is where that happens and it is named so
 * a reader can see at a glance which half of a test is scaffolding.
 *
 * ─── DETERMINISM, BECAUSE THE PHONE PROJECTS RUN `retries: 0` ─────────────────────────────
 *
 * `playwright.config.ts:278` sets `retries: 0` on both phone projects deliberately: a gate
 * whose failures are classified FLAKY exits 0, and for an overflow gate that is backwards.
 * There is no retry to hide behind here, so every interaction in this file goes through a
 * helper whose success condition is an observable state change:
 *
 *   · `pressAndSettle`      — a press whose acknowledgement is the control DETACHING.
 *   · `pressAndReveal`      — a press whose acknowledgement is something APPEARING. Written
 *                             here because `pressAndSettle` cannot express it: the paperclip
 *                             that opens the receipt sheet is still in the DOM afterwards, so
 *                             waiting for it to detach would time out on a working sheet.
 *   · `expectAnyRowEventually` / `expectAnyRowGone` — reload-polled, so what is polled is the
 *                             SERVER's answer and not a DOM with no reason to change.
 *   · `pickCombobox`        — retries the OPEN, not just the option.
 *   · `addExpenseOnPhone`   — a press that is NOT idempotent, so its one retry is guarded by
 *                             the DATABASE rather than by the control's state.
 *
 * There is no `waitForTimeout` and no bare `click()` on anything whose effect is asserted.
 *
 * ─── WHAT THIS FILE DOES NOT ESTABLISH ───────────────────────────────────────────────────
 *
 * IT IS EN-ONLY, the same named bias `tap-targets.mobile.spec.ts` records, and biased in the
 * dangerous direction: FR-CA strings run ~20% longer, so FR-CA is the likelier overflow
 * trigger and nothing here looks at it.
 *
 * IT PROVES PRESENCE AND GEOMETRY, NOT LEGIBILITY. That the receipt is IN the sheet is
 * asserted below; that it can be READ at 390x664 is a human observation and is on the
 * operator round's checklist.
 *
 * IT DOES NOT RUN PER PHASE. `ci.yml` runs unit tests only; this file runs at ship and on the
 * nightly, which is exactly why every helper above had to be chosen rather than discovered.
 */

/**
 * ─── THE PROJECT LIST IS IMPORTED, AND THIS FILE IS WHY THAT RULE EXISTS ─────────────────
 *
 * `PHONE_PROJECTS` comes from `e2e/support/phone-projects`, which is the single place the
 * phone-project names live and the list `scripts/check-phone-projects.mjs` holds to
 * `playwright.config.ts` by text. It was a hand-kept `['mobile-360', 'mobile-390']` here, and
 * that copy is exactly the failure that file was created to end: `mobile-412` was added by
 * P02 (`pwa-pages-everyday`) AFTER this file was written, it collects the same derived
 * `PHONE_ONLY_SPECS` the other two do (`playwright.config.ts:394-396`), so it picked this
 * file up on the first run it existed for and failed all four flows in `beforeEach` with a
 * spec-list message about a product that was fine. Every other `*.mobile.spec.ts` in the
 * suite already imported the shared list; this one had been missed.
 *
 * DO NOT RESTATE IT HERE, whatever the reason looks like. A local copy cannot be checked by
 * that script, and the next project to be added would land in the same place.
 *
 * Nothing below is width-specific, which is what makes the wider list correct rather than
 * merely quiet: 412 is still far under `sm` (640) and `lg` (1024), so the disclosure, the
 * two-column editor grid and the phone action bar are in the same shape at all three widths,
 * and the assertions that read a number — the overflow measurement, the top-bar ration and
 * the report total — are stated relative to the viewport or to the seeded figure.
 */

/** Matches `tap-targets.mobile.spec.ts`, `safe-area.mobile.spec.ts` and the crawl. */
const LOCALE = 'en';

/**
 * The width the fixture is built at.
 *
 * Above `lg` (1024) so the editor's field grid has a box, and at/above `xl` (1280) so
 * `ResizablePanels` is in its three-column mode — the shape the desktop suite has always
 * built reports in.
 */
const DESKTOP = { width: 1280, height: 900 } as const;

/** The category every other expense spec uses, so it is known to exist in the seed. */
const CATEGORY = /Office Supplies/;

/**
 * The width the live-resize test starts and ends at: above `lg` (1024), so the page is in its
 * desktop tree, and BELOW `xl` (1280) on purpose. `ResizablePanels` swaps between two element
 * trees at `(min-width: 80rem)` (`packages/design-system/src/components/ui/resizable-panels.tsx`),
 * which remounts every pane, the editor included. A resize that crosses 1280 would lose the
 * half-typed value for a reason this change did not cause, so the test never goes there.
 */
const BELOW_XL = { width: 1200, height: 900 } as const;

/** The name the spec reads its own errors under, for `testDb`'s missing-variable message. */
const CALLER = 'expense-workbench.mobile.spec.ts';

/**
 * Copy read from the catalog rather than pinned, the pattern `analytics.mobile.spec.ts` uses
 * locally for the same reason: a copy edit does not turn into a false alarm, and a RENAMED key
 * throws with its name. Kept local because this phase's diff is two spec files;
 * `e2e/support/catalog.ts` has no expenses-workbench accessor to reuse.
 *
 * Only the notice copy is read this way. Every locator in this file is an EN literal (the
 * file's convention, see the EN-only note in the header): an accessible name is what the
 * locator matches, and pinning it is what keeps a rename from silently retargeting one.
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

/**
 * `main`'s own id, and the census's subject. Named here because the claim this file makes is
 * "and everything INSIDE it too".
 */
const MAIN = 'main#main-content';

test.describe.configure({ timeout: 150_000 });

// VeloExpense: the admin pool `testDb` opens, closed once the file is done.
test.afterAll(async () => {
  await closeTestDb();
});

/**
 * NO INHERITED SESSION.
 *
 * Every phone project runs with `storageState: 'e2e/.auth/user.json'`, which is the admin.
 * These flows are about a SUBMITTER and, in the last one, about the handoff to an approver —
 * doing both as one admin proves nothing about either. Cleared here and adopted explicitly
 * per test, the pattern `e2e/safe-area.mobile.spec.ts:374` already proves works inside a
 * phone project and `e2e/expense-lifecycle.spec.ts:29` uses for the same reason.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }, testInfo) => {
  void page;
  assertProject(testInfo, PHONE_PROJECTS);
});

/**
 * Run the fixture build on a sibling page at a desktop width, then close it.
 *
 * Same `BrowserContext`, so the session established on the phone page is already here and
 * nothing signs in twice. Closed in a `finally` so a failed build does not leak a page into
 * the next test's context — Playwright would otherwise carry it to the end of the test and
 * its console noise with it.
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

/** A draft report with `count` receipted expenses on it, built at a desktop width. */
async function seedReport(page: Page, title: string, count = 1): Promise<string> {
  return onDesktop(page, async (desk) => {
    const id = await createReport(desk, title);
    for (let i = 0; i < count; i += 1) {
      await addExpense(desk, {
        vendor: `Bay Street Depot ${i + 1}`,
        amount: `${(i + 1) * 100}.00`,
        category: CATEGORY,
      });
    }
    return id;
  });
}

/**
 * Clear the AV scan on this report's receipts, the way the worker would.
 *
 * ─── WHY A FIXTURE STEP AND NOT AN ASSERTION ────────────────────────────────────────────
 *
 * The receipt VIEWER is blocked until the malware scan clears — `scanCleared(ext)` is
 * `ext != null && ext.scanStatus === 'CLEAN'` (`_workbench/parts.tsx:264`), and until then the
 * pane paints "Scanning…" instead of the document. That is correct and deliberate: un-scanned
 * bytes must not be rendered.
 *
 * WHAT WRITES THE CLEAN ROW IS THE WORKER, AND THE WORKER IS NOT IN THIS ENVIRONMENT. The
 * upload enqueues `expense.extractReceipt`; `apps/worker` is what drains that queue and writes
 * the `DocumentExtraction` row, and the E2E stack runs the web server alone. Measured on this
 * database rather than assumed: every `Receipt` the suite has ever uploaded has NO extraction
 * row at all. So the placeholder is permanent here — `parts.tsx:200-210` records the same
 * finding from the GA readiness audit ("with extraction not configured at all it never
 * clears"), and its 3-minute `PIPELINE_REPORT_GRACE_MS` only changes which placeholder.
 *
 * This is therefore an ENVIRONMENT fact and not a defect, and it is not width-specific — the
 * desktop pane is locked by the same condition. The flow below is about the RELOCATION (the
 * receipt pane became a bottom sheet on a phone) and it cannot make that claim about a pane
 * showing a spinner, so the fixture supplies the one row production would already have.
 *
 * `EXTRACTED` at a high confidence rather than `PENDING`: a CLEAN scan with a still-running
 * extraction leaves the EDITOR locked (`receiptLockState`), and a low confidence would raise
 * the "mark reviewed" nudge — both are other people's surfaces and neither belongs in this
 * test's page. No `data`, so nothing is prefilled over the vendor and amount seeded above.
 */
async function clearReceiptScans(reportId: string): Promise<void> {
  const db = await testDb('expense-workbench.mobile.spec.ts');
  // VeloExpense: SQL on the admin pool, in place of `db.receipt.findMany`.
  const receipts = (
    await db.query<{ id: string; organization_id: string }>(
      `SELECT r.id, r.organization_id FROM receipt r JOIN expense e ON e.id = r.expense_id
        WHERE e.report_id = $1`,
      [reportId],
    )
  ).rows;
  expect(
    receipts.length,
    `no Receipt rows on report ${reportId}. \`addExpense\` attaches one per expense unless ` +
      '`receipt: false` is passed, so a zero here means the upload silently failed and the ' +
      'flow below would be measuring a sheet with nothing in it.',
  ).toBeGreaterThan(0);
  for (const r of receipts) {
    // VeloExpense: in place of `db.documentExtraction.upsert`, naming the tenant — the row's
    // `organization_id` defaults from the session's `app.current_org`, and this pool has none.
    await db.query(
      `INSERT INTO document_extraction (organization_id, receipt_id, scan_status, status, confidence)
       VALUES ($1, $2, 'CLEAN', 'EXTRACTED', 0.99)
       ON CONFLICT (receipt_id) DO UPDATE
         SET scan_status = 'CLEAN', status = 'EXTRACTED', confidence = 0.99, updated_at = now()`,
      [r.organization_id, r.id],
    );
  }
}

/** The report's own URL, locale-prefixed the way every other phone spec navigates. */
function reportUrl(id: string): string {
  // VeloExpense: no locale segment in a path.
  return `/expenses/${id}`;
}

/**
 * Open the report at the project's own viewport and wait until the phone tree has committed.
 *
 * `ReportSummary` and `PhoneActionBar` are mounted by the `useIsBelowLg` branch, which
 * resolves during the first client render — so their presence is the honest signal that
 * hydration has happened AND that the hook answered `true`. Asserting on it here means every
 * flow below starts from a page that is definitely in its phone shape, rather than racing the
 * pre-hydration server render (which always emits the desktop tree — `getServerSnapshot` is
 * `() => false`).
 */
async function openOnPhone(page: Page, id: string): Promise<void> {
  const response = await page.goto(reportUrl(id), { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${reportUrl(id)} did not answer 200`).toBe(200);
  // The service worker's offline fallback also answers 200. Same guard the tap-target and
  // safe-area gates use, and for the same reason: it would otherwise be measured as the page.
  expect(
    await page.locator('[data-testid="offline-page"]').count(),
    'the service worker served the offline fallback in place of the report',
  ).toBe(0);
  // A route ruled `desktop` renders the notice instead of its page. `/expenses/[reportId]` is
  // ruled `limited`, so this must never fire — but if P05 ever rules `/expenses` `desktop`,
  // longest-prefix matching hands that ruling to every report and everything below would
  // measure the notice. That is a live open item in the plan, so it is asserted, not assumed.
  expect(
    await page.locator('[data-testid="desktop-only-notice"]:visible').count(),
    `${reportUrl(id)} rendered the desktop-only notice. If /expenses was ruled \`desktop\`, ` +
      'longest-prefix matching gave that ruling to this route too — see the P05 coordination ' +
      'note in docs/design/pwa.md.',
  ).toBe(0);
  await expect(
    page.getByTestId('report-summary'),
    'the below-`lg` body header did not mount. Either hydration did not happen, or ' +
      '`useIsBelowLg` answered false at a phone width — check the polarity of BELOW_LG_QUERY ' +
      'in apps/web/src/lib/useIsBelowLg.ts, which is `max-width` and must stay `max-width`.',
  ).toBeVisible({ timeout: 30_000 });
  // The page lays out again when the report query lands; measuring before that pairs a
  // rectangle from before the reflow with one from after.
  await page.waitForLoadState('networkidle');
}

/**
 * Press `name` and wait for `revealed` to appear.
 *
 * The other half of `pressAndSettle`, and needed because half the phone chrome does NOT
 * detach on success: the paperclip that opens the receipt sheet is still on its row while the
 * sheet is up, so `pressAndSettle` would wait for a detachment that correctly never comes and
 * report a working sheet as a 20-second failure.
 *
 * The retry rule is `pressAndSettle`'s, unchanged and for its reason: React re-renders these
 * panes as their queries settle, so a click can land on a node that has already been replaced
 * — the browser reports a successful click on a detached listener and nothing happens.
 * Re-pressing is safe only while the control is still ENABLED, because an in-flight mutation
 * disables it and a completed one removes it, so "still enabled" means nothing has started.
 *
 * `rearm` is what makes that retry legal on a control the FIRST press hides. The paperclip
 * lives inside the below-`lg` expenses disclosure, and tapping it runs `selectFromList`, which
 * collapses that disclosure — so after an unacknowledged press the control is still attached
 * and still `enabled`, but `display: none`, and a bare second `click()` would wait out its
 * actionability timeout on an element that is never coming back on its own. A caller whose
 * control is behind an interaction passes the interaction here; everyone else passes nothing
 * and the retry is exactly what it was.
 */
async function pressAndReveal(
  control: Locator,
  revealed: Locator,
  what: string,
  rearm?: () => Promise<void>,
): Promise<void> {
  await expect(control, `"${what}" should be pressable`).toBeEnabled({ timeout: 30_000 });
  await control.click();
  const appeared = await revealed.waitFor({ state: 'visible', timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (!appeared) {
    if (rearm) await rearm();
    if ((await control.count()) > 0 && (await control.first().isEnabled())) {
      await control.first().click();
    }
  }
  await expect(
    revealed,
    `pressing "${what}" should have revealed it — the press was acknowledged by nothing`,
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * The overflow claim the crawl cannot make: `main` does not scroll sideways, AND neither does
 * anything inside it that could have absorbed the overflow instead.
 *
 * THE SECOND HALF IS THE WHOLE POINT. The census measures `scrollWidth - clientWidth` on
 * `main` alone, and this page puts its three panes inside `<ResizablePanels
 * className="overflow-x-auto">` (`ExpenseReportWorkbench.tsx:2218`). A scroll container's
 * overflow is its own: `main.scrollWidth` never grows, the census reports 0, and a reader at
 * 360 is dragging a pane group sideways. Every `overflow-x: auto|scroll` descendant is
 * therefore measured on its own terms, which names the pane group without depending on a
 * class name that a refactor would move — and generalises to whatever the next such box is.
 *
 * Reported as a LIST of offenders rather than as a number, because "expected 0, received 214"
 * on a route with four nested scrollers tells a reader nothing about which one.
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
    // `main` itself: the census's own subject, restated here so a failure on it is reported
    // beside the ones the census structurally cannot see.
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
    `${where} scrolls horizontally at this width. The FIRST entry may be \`main\` itself, ` +
      'which is what the mobile crawl gates; any entry after it is a scroll container that ' +
      'ABSORBED the overflow, which the crawl is structurally blind to — see the header of ' +
      'this file. The pane group is `<ResizablePanels className="overflow-x-auto">` in ' +
      'ExpenseReportWorkbench.tsx.',
  ).toEqual([]);
}

/**
 * ADR-0002's below-`lg` ration, asserted on the one route that had the most to lose by it.
 *
 * "Below `lg`, a route may publish into the `right` slot AT MOST ONE ICON-ONLY CONTROL, at
 * 32x32 visual with a 44x44 hit area — or nothing." (ADR-0002:320-321). This route's
 * published row was measured at 532.8px (EN) / 677.2px (fr-CA) min-content against a ~238px
 * budget at 360, which is why Phase 3 relocated its actions into the body at all.
 *
 * ── THIS IS THE ONLY ASSERTION IN THE SUITE THAT CAN CATCH THE RELOCATION NOT HAPPENING ──
 *
 * `topbar-overlap.spec.ts` runs `chromium` at 1280 and structurally cannot observe a
 * below-`lg` branch. The mobile census measures `main`, and the TopBar is `main`'s SIBLING,
 * not its child — nothing it measures moves when the top bar overflows. So if Phase 3 were
 * reverted, or if the `max-lg:hidden` cloak were dropped, or if `useIsBelowLg` were inverted
 * to `min-width` (which `tests/setup.ts`'s `matches: false` polyfill would hide from every
 * unit test in the repo), every other gate in this suite would stay green.
 *
 * Both halves are required and neither is sufficient. The COUNT alone is satisfied by a page
 * that renders nothing at all, so the phone bar's own Submit control is asserted beside it;
 * the BAR alone is satisfied by a build that mounts the body header and forgets to cloak the
 * published row, which is two Submit buttons and the overflow back.
 *
 * `data-zone` / `data-chrome` are the seams `TopBar.tsx:433-437` maintains for exactly this,
 * and `data-chrome="page"` is what separates what the ROUTE published from the shell's own
 * hamburger and bell, which are rationed separately and stay.
 */
async function expectTopBarRationHeld(page: Page): Promise<void> {
  const published = page.locator('[data-zone="right"] [data-chrome="page"]');
  const controls = published.locator('button:visible, a[href]:visible, [role="button"]:visible');

  const names = await controls.allTextContents();
  expect(
    names.length,
    "the workbench is publishing more than one control into the top bar's `right` slot at a " +
      `phone width: ${JSON.stringify(names)}. ADR-0002 rations that slot to one icon-only ` +
      'control or nothing below `lg`, and this row was measured at 532.8px against a 238px ' +
      'budget — which is why Phase 3 moved it into the body. Either the `max-lg:hidden` cloak ' +
      'on the published row went away, or the `isBelowLg ? null : <TopBarActions/>` branch in ' +
      'ExpenseReportWorkbench.tsx did.',
  ).toBeLessThanOrEqual(1);

  // "ICON-only". Whatever survives may carry an accessible name (it must), but it may not
  // paint a label — a labelled control is what the 532.8px measurement was made of.
  for (const text of names) {
    expect(
      text.trim(),
      'the one control the ration allows must be ICON-ONLY below `lg`. This one paints ' +
        `visible text (${JSON.stringify(text)}), which is the shape ADR-0002 measured and ` +
        'refused.',
    ).toBe('');
  }

  await expect(
    page.getByTestId('phone-action-bar').getByRole('button', { name: 'Submit report' }),
    'the top bar is correctly empty, but there is no Submit control in the body either — so ' +
      'this report cannot be submitted on a phone at all. The count assertion above passes ' +
      'vacuously on a build that mounts neither destination, which is why this one is here.',
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * VeloExpense: the total in the add flow rises only if the demo tenant has a USD->CAD rate,
 * and it cannot count on the seeded one: `analytics-flow` deletes every rate (as
 * `fx-rates-flow.spec.ts` notes). So the seed's own row is put back, as `scripts/seed.mjs`
 * writes it (`DEMO_FX`), and left alone if it is already there. ExpenseOS's suite keeps its
 * seeded rates.
 */
async function ensureSeededUsdCadRate(): Promise<void> {
  const db = await testDb(CALLER);
  await db.query(
    `INSERT INTO fx_rate (organization_id, base, quote, rate, fetched_at, source)
     SELECT organization_id, 'USD', 'CAD', 1.35, ('2026-01-01'::date)::timestamp AT TIME ZONE 'UTC', 'SEED'
       FROM app_user WHERE email = 'employee@demo.test'
     ON CONFLICT (organization_id, base, quote, fetched_at) DO NOTHING`,
  );
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
 * ─── WHY NOT `addExpense` FROM `e2e/support/workbench.ts` ────────────────────────────────
 *
 * Its last step acknowledges the save through the new expense's LIST ROW, and below `lg` that
 * row is inside the expenses disclosure, which the add itself collapses (`createExpense` goes
 * through `selectFromList`). The row resolves nothing there. It also attaches a receipt, and
 * the case here is the expense with none (a tip, a cash fare). `workbench.ts` stays untouched:
 * its strict, unscoped `getByLabel('Vendor')` is the hazard the counts below model.
 *
 * ─── THE PRESS IS NOT IDEMPOTENT, SO THE RETRY IS GUARDED BY THE DATABASE ────────────────
 *
 * `pressAndReveal`'s rule ("still enabled means nothing started") does not hold for this
 * button: it re-enables as soon as the mutation succeeds, before the list refetch lands, so
 * "enabled and nothing visible yet" is also what a press that DID land looks like. A blind
 * second press could then add a second blank expense. (`createExpense` hands back a blank
 * expense the report already has, so it would usually be the same row. That is the server's
 * rule, and this helper does not lean on it.) So the one re-press happens only when the
 * SERVER still has no new expense on this report after 6 seconds, which is the only state in
 * which the first press certainly did nothing.
 *
 * ─── THEN THE EDITOR HAS TO CATCH UP ─────────────────────────────────────────────────────
 *
 * The centre pane renders the previously selected expense for a beat after the add, so the
 * helper waits for an EMPTY Vendor, the same signal `workbench.ts` uses, before it returns.
 * It does not touch the field: the caller asserts where the reader landed before anything
 * scrolls or focuses on its behalf.
 */
async function addExpenseOnPhone(page: Page, reportId: string): Promise<string> {
  const db = await testDb(CALLER);
  // VeloExpense: SQL on the admin pool, in place of `db.expense.findMany`.
  const ids = async (): Promise<string[]> =>
    (
      await db.query<{ id: string }>('SELECT id FROM expense WHERE report_id = $1', [reportId])
    ).rows.map((e) => e.id);
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

  const landed = await settlesWithin(created, (ids) => ids.length > 0, 6_000);
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
  return id;
}

/**
 * The labelled-field hazard, asserted the way it bites: ONE match for the same unscoped,
 * strict locator `e2e/support/workbench.ts` uses, and that one match VISIBLE.
 *
 * Playwright's `getByLabel` matches a case-insensitive SUBSTRING across the whole page and has
 * no visibility filter, so a CSS-hidden twin of a labelled field is a second strict match. The
 * jsdom audit in `parts.limitedRegions.test.tsx` renders the editor alone and matches catalog
 * keys exactly; it cannot see the page-wide case, and this can.
 */
async function expectOneVisibleField(field: Locator, what: string, width: string): Promise<void> {
  await expect(
    field,
    `${what} matched more or fewer than one control at ${width}. Every desktop spec that adds ` +
      'an expense addresses it with the same unscoped, strict locator ' +
      '(e2e/support/workbench.ts), so a second labelled match anywhere on the page, hidden or ' +
      'not, breaks all of them.',
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(field, `${what} is in the DOM at ${width} but not visible`).toBeVisible();
}

/**
 * The report total in the phone summary, as a number.
 *
 * The figure is the summary's first paragraph: the report currency's code in a `<span>`, then
 * `formatMinor`'s output. Everything but digits and the decimal point is dropped, which is
 * right for the EN locale this file runs in (a `,` is a thousands separator there).
 */
async function reportTotal(summary: Locator): Promise<number> {
  const text = (await summary.locator('p').first().textContent()) ?? '';
  return Number.parseFloat(text.replace(/[^0-9.]/g, ''));
}

test.describe('the expense workbench, on a phone', () => {
  test('read the report and its totals', async ({ page }) => {
    /**
     * FLOW 1 of 5. The one that carries the overflow measurement and the top-bar ration,
     * because both are claims about a report with real data ON SCREEN — an empty report
     * cannot overflow anything and publishes a shorter row.
     */
    const title = reportTag('phone read');
    await signIn(page, 'employee');
    const id = await seedReport(page, title, 2);

    await openOnPhone(page, id);

    // ── The totals are RENDERED, not disclosed. ───────────────────────────────────────────
    /**
     * The defect this flow exists to close was not a width problem: the total's by-currency
     * composition and the reconciliation panel were `group-hover` only, and `hover` does not
     * exist under a finger. "Read the totals" was not inconvenient on a phone, it was
     * unreachable. `ReportSummary` is the re-presentation that fixes it — same
     * `trpc.expenses.report.useQuery` result, no new procedure.
     */
    const summary = page.getByTestId('report-summary');
    await expect(summary).toContainText('Report total');
    /**
     * The currency and the figure, asserted separately rather than as one pattern.
     *
     * They are two nodes — a `<span>` for the ISO code and `formatMinor`'s locale-formatted
     * amount beside it — so a single regex would be asserting the formatter's symbol and
     * spacing choices as well as the number, and would go red on a currency-display change
     * that is nobody's bug.
     */
    await expect(
      summary,
      'the summary should name the report currency. It comes off the same query the rest of ' +
        'the page reads; missing means the roll-up did not land, not that the block is gone.',
    ).toContainText('CAD');
    await expect(
      summary,
      'two expenses of 100.00 and 200.00 should roll up to 300.00 in the report currency',
    ).toContainText('300.00');
    await expect(summary, 'a draft report should say so in the summary').toContainText('Draft');

    /**
     * Both expenses are readable in the left pane — once the pane is OPEN.
     *
     * At this width that card is a disclosure and it arrives COLLAPSED, so neither row is in
     * the accessibility tree until the header is tapped. Reading the rows is the flow, so the
     * tap is part of the flow rather than setup: what this asserts is that the list a phone
     * reader opens holds both expenses, not that they are painted on arrival. Nothing is
     * tapped after this, so one open is enough — see `openExpenseList` for why a flow that
     * touches a row needs another.
     */
    await openExpenseList(page);
    await expect(page.getByRole('button', { name: /Bay Street Depot 1/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Bay Street Depot 2/ }).first()).toBeVisible();

    // ── The relocation happened. See `expectTopBarRationHeld`. ───────────────────────────
    await expectTopBarRationHeld(page);

    // ── And nothing scrolls sideways, including the box that would have hidden it. ───────
    await expectNoHorizontalOverflow(page, 'the report workbench with two expenses on it');
  });

  test('see the receipt', async ({ page }) => {
    /**
     * FLOW 2 of 5. Below `lg` the receipt pane is not a pane — it is a bottom sheet opened
     * from the paperclip on the expense row, which is a relocation into a shipped component
     * (`DrawerContent side="bottom"`, as `FilterSheet` and `SortSheet` already use) rather
     * than a new one.
     */
    const title = reportTag('phone receipt');
    await signIn(page, 'employee');
    const id = await seedReport(page, title, 1);
    // The one row the worker would have written. See `clearReceiptScans` — without it the
    // sheet opens onto "Scanning…" for the length of the run and this flow measures a
    // placeholder rather than the relocation.
    await clearReceiptScans(id);

    await openOnPhone(page, id);

    /**
     * The paperclip is ON A ROW, so the list has to be open before it exists. It is also the
     * control whose own press CLOSES that list again (`selectFromList` — one tap selects the
     * expense and collapses the pane, so the editor it has just sent the reader to is not
     * underneath a list), which is why `openExpenseList` is handed to `pressAndReveal` as its
     * re-arm rather than merely called before it.
     */
    await openExpenseList(page);

    /**
     * The paperclip is addressed by its ACCESSIBLE NAME, which says the whole sentence
     * ("View 1 receipt") rather than showing a bare count — that wording is what a screen
     * reader and iOS voice control both read, and addressing it here is what keeps the two
     * from drifting apart.
     */
    const paperclip = page.getByRole('button', { name: 'View 1 receipt' });
    const sheet = page.getByRole('dialog').filter({ hasText: 'Receipt' }).first();
    await pressAndReveal(paperclip, sheet, 'View 1 receipt', () => openExpenseList(page));

    await expect(
      sheet.getByRole('img', { name: 'receipt.png' }),
      'the receipt itself should be in the sheet. That it is LEGIBLE at 390x664 is a human ' +
        'observation and is on the operator round, not here.',
    ).toBeVisible({ timeout: 30_000 });

    /**
     * SEC-2 and SEC-3, asserted as ABSENCE rather than as invisibility, because that is what
     * was built and the difference is the security property.
     *
     * A presigned receipt URL is a bearer credential to a financial document, live for up to
     * an hour with no second factor. On iOS a `target="_blank"` out of a standalone PWA hands
     * it to Safari — history, tab list, share sheet, for the rest of its hour. `toHaveCount(0)`
     * rather than `not.toBeVisible()` is deliberate: a CSS-hidden link still has a real
     * presigned `href` sitting in the DOM, reachable by long-press, by any "copy link" path and
     * by anything reading the document. SEC-3 says the string must not be there.
     */
    await expect(
      sheet.getByRole('link', { name: 'Full screen' }),
      'the "Full screen" link is present in the receipt sheet on a phone. SEC-2 says the ' +
        'in-window sheet IS the full-screen viewer here; SEC-3 says the presigned URL must ' +
        'not exist as a copyable string. A `max-lg:hidden` would satisfy neither.',
    ).toHaveCount(0);
    await expect(
      sheet.getByRole('link', { name: 'Download' }),
      'the "Download" link is present in the receipt sheet on a phone — same SEC-3 reasoning ' +
        'as "Full screen" above.',
    ).toHaveCount(0);

    // The sheet is `dismissible`, so Esc is a real exit and not an assumption.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden({ timeout: 10_000 });

    await expectNoHorizontalOverflow(page, 'the report workbench after the receipt sheet closed');
  });

  test('submit a report', async ({ page }) => {
    /**
     * FLOW 3 of 5, and the one the whole task is for. Before Phase 3 there was no Submit
     * control on this route below `lg` at all: the chrome was published into a top-bar slot
     * rationed to one icon-only control, so a submitter on a phone could read the report and
     * do nothing about it.
     */
    const title = reportTag('phone submit');
    await signIn(page, 'employee');
    const id = await seedReport(page, title, 1);

    await openOnPhone(page, id);

    const bar = page.getByTestId('phone-action-bar');
    await expect(
      bar,
      'no body-level action bar. Phase 3 mounts one below `lg`; without it there is nothing ' +
        'to press, because the top-bar row is cloaked at this width.',
    ).toBeVisible();

    /**
     * Scoped to the bar, and that scope is load-bearing rather than tidy: if the relocation
     * regressed to publishing the row AND mounting the bar, an unscoped locator would find
     * whichever came first and pass on a build with two Submit buttons.
     *
     * `pressAndSettle` because this one DOES detach — a submitted report's action set has no
     * Submit in it, it has Recall. The detachment is the server's acknowledgement, not the
     * click's.
     */
    await pressAndSettle(page, 'Submit report', bar);

    /**
     * And the SERVER agrees. Reload-polled through the list, which is also the only place in
     * this file that exercises the card tree — see `anyRowFor` in `e2e/support/rows.ts` for
     * why `rowFor` cannot be used at this width.
     */
    await expectAnyRowEventually(page, `/expenses`, title, /Submitted/i);

    // Back on the report, the phone summary tells the submitter the same thing.
    await openOnPhone(page, id);
    await expect(page.getByTestId('report-summary')).toContainText('Submitted');
    await expect(
      bar.getByRole('button', { name: /^Recall/ }),
      'a submitted report offers Recall in the phone bar — the action array is one list with ' +
        'two renderers, so an action that reaches the top bar and not the body means the ' +
        'array was forked.',
    ).toBeVisible();
  });

  test('respond to a returned report', async ({ page }) => {
    /**
     * FLOW 4 of 5. A returned report comes back to the submitter EDITABLE — that is the whole
     * difference from a rejection, and it is the transition most likely to break under a
     * change to the status guard, because from the approver's side both look like "no".
     *
     * THE APPROVER DECIDES AT A DESKTOP WIDTH, ON PURPOSE. The flow under test is the
     * SUBMITTER's phone response; `/expenses/approvals` is P05's route and is still `unruled`,
     * so driving a decision through it at 360 would make this test's colour depend on a
     * surface nobody has assessed yet. The decision is fixture, so it is built like fixture.
     */
    const title = reportTag('phone returned');
    await signIn(page, 'employee');
    const id = await seedReport(page, title, 1);

    await onDesktop(page, async (desk) => {
      await desk.goto(`/expenses/${id}`);
      await pressAndSettle(desk, 'Submit report');
      await expectAnyRowEventually(desk, `/expenses`, title, /Submitted/i);

      // The handoff. Everything above this line is one person's view of the report.
      await switchTo(desk, 'manager');
      await desk.goto(`/expenses/approvals`);
      const row = rowFor(desk, title);
      await expect(row, `${title} should be waiting in the approver's inbox`).toBeVisible({
        timeout: 30_000,
      });
      await row.click();
      /**
       * Two presses, not one — ON THE REPORT PAGE. At this desktop width a queue row opens
       * `/expenses/<id>` in approver mode, not the review drawer, and the presses below wait
       * for its controls to render. "Return for edits" opens a note field and a differently
       * labelled confirm; pressing only the first leaves the panel open with nothing decided,
       * and the failure surfaces three steps later on the phone as "still Submitted", which
       * points at the wrong half of the flow.
       */
      await desk.getByRole('button', { name: 'Return for edits' }).first().click();
      // The union regex the drawer-era `decide` used. The two refusals share one note field
      // with two placeholders, and guessing which is a rename away from a 30-second timeout
      // that reads as "the decide panel never opened".
      await desk
        .getByPlaceholder(/Reason for rejection|What needs to change/)
        .fill('Returned by the P06 phone gate.');
      await pressAndSettle(desk, 'Confirm return');
      /**
       * Re-navigated before checking it left the queue. A successful return sends the
       * approver back to the queue on its own, but a list read in that same moment can still
       * be the one fetched before the decision — and an absence assertion against a page that
       * is mid-navigation passes whether or not the decision landed. Reloading between
       * attempts makes what is polled the server's queue.
       */
      await expectAnyRowGone(desk, `/expenses/approvals`, title);
      await switchTo(desk, 'employee');
    });

    // ── And now the flow: the submitter, on a phone, meets a returned report. ────────────
    await expectAnyRowEventually(page, `/expenses`, title, /Returned/i);

    await openOnPhone(page, id);
    await expect(
      page.getByTestId('report-summary'),
      'the phone summary should say the report came back. This is the only status surface on ' +
        "a phone — the top bar's copy is cloaked at this width.",
    ).toContainText('Returned');

    const bar = page.getByTestId('phone-action-bar');
    /**
     * RETURNED shares `EDITABLE_STATUSES` with DRAFT, so the report is resubmittable and the
     * phone bar must offer it. A build that let the relocation see only `isDraft` would render
     * a bar with nothing in it here and this is what catches that.
     */
    await expect(
      bar.getByRole('button', { name: 'Submit report' }),
      'a RETURNED report is editable and resubmittable exactly as a draft is, so the phone ' +
        'action bar owes a Submit. An empty bar here means the action array is gated on ' +
        '`isDraft` somewhere instead of on `canEditStatus`.',
    ).toBeVisible({ timeout: 30_000 });

    await expectNoHorizontalOverflow(page, 'a returned report on a phone');

    // And it goes back, which is what "returned" is FOR.
    await pressAndSettle(page, 'Submit report', bar);
    await expectAnyRowEventually(page, `/expenses`, title, /Submitted/i);
  });

  test('add an expense and fill it in', async ({ page }) => {
    /**
     * FLOW 5 of 5 (P18). A submitter on a draft taps "Add expense", lands on the new
     * expense's editor, sets the date, vendor, currency and location, adds a line, types its
     * amount, and sees the report total rise. Before P18 every one of those controls was
     * `hidden lg:contents` below `lg`, and "Add expense" with them.
     */
    const title = reportTag('phone add');
    const vendor = `Corner Taxi ${Date.now().toString(36)}`;
    const date = '2026-09-15';
    // The `é` is U+00E9, precomposed (NFC): a decomposed `e` + combining acute looks the
    // same in a source file and never equals what the DOM and the database hold. Non-ASCII
    // on purpose, and cheaply.
    const place = 'Montréal';
    await signIn(page, 'employee');
    await ensureSeededUsdCadRate();
    // One receipted CAD expense of 100.00, built at 1280. The flow below is the second one.
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
     * to disprove. `createExpense` goes through `selectFromList`, which closes the list: a
     * reader who tapped "+" wants the new row's editor, not the list they were done with.
     */
    await openExpenseList(page);
    const newId = await addExpenseOnPhone(page, id);

    // ── Landed: before ANY interaction that could scroll or focus on the test's behalf. ──
    /**
     * Playwright scrolls a field into view before it fills it, so every assertion about
     * where the reader is has to come before the first fill, or it proves nothing.
     */
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
     * row is local state, so a press that landed reveals it at once, and the one re-press
     * only happens when nothing appeared in 6 seconds. No draft row is open before this, so
     * the category placeholder can only be the new draft's.
     */
    const addLine = page.getByRole('button', { name: 'Add line', exact: true });
    // VeloExpense: the kit Combobox keeps its placeholder as `data-placeholder`.
    const category = page.locator('[data-placeholder="Select a category"]');
    await pressAndReveal(addLine, category, 'Add line');
    await pickCombobox(page, category, CATEGORY);

    /**
     * The amount field belongs to the SAVED line: picking a category commits the draft, and
     * the saved row renders the `MoneyInput`. Same count-and-visible check as the header
     * fields: a second `Amount` anywhere would break `workbench.ts:103` in every desktop spec.
     */
    const amountField = page.getByLabel('Amount', { exact: true });
    await expectOneVisibleField(amountField, 'getByLabel("Amount", { exact: true })', width);
    await amountField.fill('25.00');
    await amountField.blur();

    // ── The report total rises. ────────────────────────────────────────────────────────
    /**
     * A USD line on a CAD report, so the summary shows the by-currency composition, and the
     * total is asserted RELATIVELY: above the seeded 100.00, without hard-coding a rate. The
     * seeded rate table quotes USD into CAD (`e2e/support/workbench.ts`, `createReport`), so
     * a total that stays at 100.00 means the line never saved or the rate is missing.
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
          'seeded USD to CAD rate is missing (VeloExpense: scripts/seed.mjs, DEMO_FX; ' +
          '`ensureSeededUsdCadRate` puts it back).',
      })
      .toBeGreaterThan(100);

    // ── The server has every value. ──────────────────────────────────────────────────────
    const db = await testDb(CALLER);
    await expect
      .poll(
        async () => {
          // VeloExpense: SQL on the admin pool, in place of `db.expense.findUnique`; the date
          // read as text, so no time zone applies (`txn_date` may also be unset).
          const e = (
            await db.query(
              `SELECT e.merchant, e.place_text, e.txn_date::text AS date, e.currency_code,
                      COALESCE((SELECT array_agg(l.amount_minor::text ORDER BY l.created_at)
                                  FROM expense_line_item l WHERE l.expense_id = e.id), '{}') AS lines
                 FROM expense e WHERE e.id = $1`,
              [newId],
            )
          ).rows[0] as
            | {
                merchant: string | null;
                place_text: string | null;
                date: string | null;
                currency_code: string;
                lines: string[];
              }
            | undefined;
          return e
            ? {
                merchant: e.merchant,
                date: e.date,
                place: e.place_text,
                currency: e.currency_code,
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
    /**
     * Every `useIsBelowLg` branch (the list heading, the summary, the phone action bar, the
     * receipt pane) renders differently at 1280, so the phone counts above say nothing about
     * the desktop page. The desktop specs drive these exact locators there.
     */
    await onDesktop(page, async (desk) => {
      await desk.goto(reportUrl(id));
      await selectExpense(desk, vendor);
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
     * with no `useIsBelowLg` branch around them, so a window dragged across 1024 keeps
     * what is half typed in them. A remount would reset Vendor to its saved value.
     *
     * Driven on the desktop sibling page, because it is the page that can start above `lg`.
     * The widths stay below 1280: see `BELOW_XL`.
     */
    const title = reportTag('phone resize');
    await signIn(page, 'employee');
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
         * The phone summary mounting is the proof the resize crossed `lg`: it is rendered
         * by the `useIsBelowLg` branch, so without it the value check below would pass
         * against a page that never left its desktop tree.
         */
        await expect(
          summary,
          `at ${size.width}px the page should be in its phone tree`,
        ).toBeVisible({ timeout: 10_000 });
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

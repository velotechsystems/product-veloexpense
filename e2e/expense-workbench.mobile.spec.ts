import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { pressAndSettle } from './support/actions';
import { signIn, switchTo } from './support/actors';
import { pickCombobox } from './support/combobox';
import { PHONE_PROJECTS } from './support/phone-projects';
import { expectAnyRowEventually, expectAnyRowGone, rowFor } from './support/rows';
import { assertProject, HIT_FLOOR_PX } from './support/tap-targets';
import { closeTestDb, testDb } from './support/test-db';
import { trpcQueryOk } from './support/trpc';
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
 * respond to a return, (P18) add an expense and fill it in, (P13) set the expense's tax,
 * code it across a split allocation and name its attendees, and (P16) read how a
 * mixed-currency total adds up — plus the live-resize check that the editor survives a
 * window crossing `lg`. This is also the file that replaces the P06 ticket's
 * done-criterion 1, which was unsatisfiable as written.
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
 * `addExpenseOnPhone` in this file instead, and it is the flow under test, not fixture. Since
 * P13 the tax panel, the cost allocation and the attendees have one editable face at every
 * width too, with no notice left on the pane; flows 6 to 8 drive each of them on a phone.
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
 * The category the attendee flow codes a line to.
 *
 * VeloExpense: ExpenseOS turns `requiresAttendees` on for its seeded Golf Expense category,
 * shared with `expense-policy-refusals.spec.ts`. VeloExpense's seed has no such category and
 * no such spec, and flipping the flag on a starter category (Meals) would put an attendees
 * block into every other spec that codes a meal. So the flow creates its OWN category in the
 * demo tenant, idempotently (`ensureAttendeeCategory`), that nothing else in `e2e/` uses.
 * The line still stays at 150.00, as ExpenseOS's does.
 */
const ATTENDEE_CATEGORY_CODE = 'e2eHospitality';
const ATTENDEE_CATEGORY_LABEL = 'E2E Hospitality';
const ATTENDEE_CATEGORY = /E2E Hospitality/;

/** The vendor `seedReport` below gives its first expense, the one a page opens on arrival. */
const SEEDED_VENDOR = 'Bay Street Depot 1';

/** The 44px floor a coarse pointer gets on every editing control P13 un-cloaked. */
const TAP_FLOOR_PX = 44;

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
 * throws with its name. Kept local: `e2e/support/catalog.ts` has no expenses-workbench
 * accessor to reuse.
 *
 * Only catalog copy the P16 flow asserts on is read this way. Every locator in this file is an
 * EN literal (the file's convention, see the EN-only note in the header): an accessible name is
 * what the locator matches, and pinning it is what keeps a rename from silently retargeting one.
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

/**
 * Every labelled name the desktop suite addresses unscoped and strict on this page, counted the
 * way `expectOneVisibleField` counts: P18's five (Vendor, Date, Location, Currency, Amount), the
 * three tax names P13 un-cloaked, and the allocation's Percent.
 *
 * `amounts` is the number of saved lines on the selected expense: `Amount` is one field per
 * saved line, so an expense with two lines legitimately has two, and that is asserted as a
 * count rather than forced through `expectOneVisibleField`.
 *
 * CALL IT ONLY WITH ONE ALLOCATION ROW ON SCREEN. "Remove allocation" is an `aria-label`, and
 * `getByLabel('Location')` is a case-insensitive SUBSTRING match over every element's label,
 * so from the second row on it matches the Location field plus one remove button per row.
 * That collision exists at 1280 too and predates P13; the allocation flow below counts these
 * names before it adds a row, and counts `Percent` per row afterwards instead.
 */
async function expectWorkbenchHazards(
  p: Page,
  width: string,
  { amounts = 1 }: { amounts?: number } = {},
): Promise<void> {
  await expectOneVisibleField(p.getByLabel('Vendor'), 'getByLabel("Vendor")', width);
  await expectOneVisibleField(
    p.getByLabel('Date', { exact: true }),
    'getByLabel("Date", { exact: true })',
    width,
  );
  await expectOneVisibleField(p.getByLabel('Location'), 'getByLabel("Location")', width);
  await expectOneVisibleField(p.getByLabel('Currency'), 'getByLabel("Currency")', width);
  const amount = p.getByLabel('Amount', { exact: true });
  if (amounts === 1) {
    await expectOneVisibleField(amount, 'getByLabel("Amount", { exact: true })', width);
  } else {
    await expect(
      amount,
      `getByLabel("Amount", { exact: true }) should match one field per saved line (${amounts}) ` +
        `at ${width}; any other count is a twin or a dropped label`,
    ).toHaveCount(amounts, { timeout: 30_000 });
    for (let i = 0; i < amounts; i += 1) await expect(amount.nth(i)).toBeVisible();
  }
  await expectOneVisibleField(p.getByLabel('GST/HST'), 'getByLabel("GST/HST")', width);
  await expectOneVisibleField(p.getByLabel('QST'), 'getByLabel("QST")', width);
  await expectOneVisibleField(p.getByLabel('PST'), 'getByLabel("PST")', width);
  await expectOneVisibleField(p.getByLabel('Percent'), 'getByLabel("Percent")', width);
}

/**
 * Open the seeded report on the phone and wait for its one expense's editor.
 *
 * With a single expense the page selects it on arrival, so its Vendor reading the seeded value
 * is the signal that the editor below it — tax, allocation, lines, attendees — is the right one.
 */
async function openSeededOnPhone(page: Page, id: string): Promise<void> {
  await openOnPhone(page, id);
  await expect(
    page.getByLabel('Vendor'),
    "the seeded expense's editor should be open on arrival",
  ).toHaveValue(SEEDED_VENDOR, { timeout: 30_000 });
}

/** The same report on the 1280 sibling page, with the seeded expense's editor open. */
async function openSeededOnDesktop(desk: Page, id: string): Promise<void> {
  await desk.goto(reportUrl(id));
  await expect(
    desk.getByLabel('Vendor'),
    "the seeded expense's editor should be open on arrival at 1280",
  ).toHaveValue(SEEDED_VENDOR, { timeout: 30_000 });
  await desk.waitForLoadState('networkidle');
}

/** The id of the one expense `seedReport(…, 1)` put on the report. */
async function seededExpenseId(reportId: string): Promise<string> {
  const db = await testDb(CALLER);
  // VeloExpense: SQL on the admin pool, in place of `db.expense.findFirst`.
  const expense = (
    await db.query(`SELECT id FROM expense WHERE report_id = $1 ORDER BY created_at LIMIT 1`, [
      reportId,
    ])
  ).rows[0] as { id: string } | undefined;
  expect(expense, `seedReport left no expense on report ${reportId}`).toBeTruthy();
  return expense?.id ?? '';
}

/**
 * The control's rendered box is at least `TAP_FLOOR_PX` tall, and wide too when `both`.
 *
 * Measured, not read off a class: the tap-target census in `tap-targets.mobile.spec.ts` finds
 * its subjects by `pointer-coarse:min-h-11` / `min-w-11`, and the inputs here are floored with
 * `pointer-coarse:h-11` (or the combobox's `[&_input]:h-11`), which that census never reads.
 * The phone projects emulate a touch device, so `(pointer: coarse)` is what applies here.
 */
async function expectTapBox(control: Locator, what: string, both = false): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, `${what} has no box to measure`).not.toBeNull();
  const height = Math.round(box?.height ?? 0);
  expect(
    height,
    `${what} renders ${height}px tall at a coarse pointer; P13 floors it at ${TAP_FLOOR_PX}px ` +
      'with a `pointer-coarse:` utility (_workbench/parts.tsx).',
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  if (both) {
    const width = Math.round(box?.width ?? 0);
    expect(
      width,
      `${what} renders ${width}px wide at a coarse pointer; it is a 14px glyph whose 44px comes ` +
        'from `pointer-coarse:min-w-11` alone.',
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
  }
}

/**
 * Press `control`, and wait until `landed` holds.
 *
 * For a press that is NOT idempotent and does not detach its control — removing one row of
 * several, or picking a directory result — so neither `pressAndSettle` nor `pressAndReveal`
 * fits. The one re-press happens only when `untouched` still holds after 6 seconds, which the
 * caller defines as "nothing on the page changed", the one state in which the first press
 * certainly did nothing. The final wait is on `landed`: a DATABASE read wherever the press
 * writes, and the page's own row count where it deliberately writes nothing.
 */
async function pressUntil(
  control: Locator,
  what: string,
  landed: () => Promise<boolean>,
  untouched: () => Promise<boolean>,
): Promise<void> {
  await expect(control, `"${what}" should be pressable`).toBeEnabled({ timeout: 30_000 });
  await control.click();
  const done = await settlesWithin(landed, (ok) => ok, 6_000);
  if (!done && (await untouched()) && (await control.isEnabled())) await control.click();
  await expect
    .poll(landed, {
      timeout: 20_000,
      message: `pressing "${what}" should have reached the server; it was acknowledged by nothing`,
    })
    .toBe(true);
}

/** The cost-allocation card: the direct parent of its own "Add allocation" button. */
function allocationCard(p: Page): Locator {
  return p.getByRole('button', { name: 'Add allocation', exact: true }).locator('xpath=..');
}

/**
 * QA's Percent invariant: one `Percent` per rendered allocation row, never two, never none.
 *
 *   1. the page-wide count equals the count inside the allocation card, so no `Percent` exists
 *      outside it;
 *   2. that count equals the card's `Business unit` count, one per row, so a hidden twin (2×)
 *      or a dropped label (0) both fail;
 *   3. it equals `rows`, which the caller derives from what it did or from the database;
 *   4. every match is visible.
 *
 * "Count equals rows" rather than a fixed 1, because a legitimately split expense has two.
 */
async function expectOnePercentPerRow(p: Page, rows: number, where: string): Promise<void> {
  const card = allocationCard(p);
  const all = p.getByLabel('Percent');
  await expect(all, `${where}: one "Percent" per allocation row (${rows})`).toHaveCount(rows, {
    timeout: 30_000,
  });
  await expect(
    card.getByLabel('Percent'),
    `${where}: every "Percent" on the page should be inside the allocation card`,
  ).toHaveCount(rows);
  // VeloExpense: the kit Combobox is a button that keeps its placeholder as `data-placeholder`.
  await expect(
    card.locator('[data-placeholder="Business unit"]'),
    `${where}: one business-unit picker per row, so one row per "Percent"`,
  ).toHaveCount(rows);
  for (let i = 0; i < rows; i += 1) {
    await expect(all.nth(i), `${where}: "Percent" ${i + 1} should be visible`).toBeVisible();
  }
}

/**
 * Pick the FIRST option a combobox offers, once no other listbox is open.
 *
 * The allocation flow does not hard-code a business unit or a department: the E2E database may
 * run either business-unit source, and the NetSuite one lists NetSuite paths. ⚠️ ASSUMPTION:
 * any offered option is a valid pick for this employee. `/./` would also match an option of a
 * listbox still closing from the previous pick, so the wait for none comes first.
 */
async function pickFirstOption(page: Page, control: Locator): Promise<void> {
  await expect(page.getByRole('option'), 'no listbox should be open before a pick').toHaveCount(0, {
    timeout: 10_000,
  });
  await pickCombobox(page, control, /./);
}

/**
 * The slice of `expenses.report` the P16 flow reads as its oracle. Local, like
 * `expense-tax-fx.spec.ts`'s own `Rollup`, and deliberately NOT shared with it: extracting
 * that file's `rollupOf` would pull its pre-existing red ("AP pins the rate") into this
 * file's tier.
 */
interface ReportOracle {
  status: string;
  rollup: {
    homeCurrency: string;
    homeTotalMinor: string;
    recoverableTotalMinor: string;
    multiCurrency: boolean;
    byCurrency: {
      code: string;
      grossMinor: string;
      convertedMinor: string | null;
      rate: string | null;
    }[];
    missingRates: string[];
  };
}

/** The server's answer, read as whoever the context is signed in as. */
async function reportOracle(page: Page, reportId: string): Promise<ReportOracle> {
  return trpcQueryOk<ReportOracle>(page, 'expenses.report', { reportId });
}

/**
 * A money figure on screen, in integer minor units: every digit, in order, and nothing else.
 *
 * Exact rather than parsed as a float, so a sum compared against it is compared in cents.
 * Correct ONLY for a two-decimal currency printed by `formatMinor` in EN — two fraction digits,
 * `,` as a grouping separator, no other digit anywhere in the node. The P16 flow asserts that
 * every currency it reads is CAD or USD before it calls this.
 */
async function minorOnScreen(figure: Locator): Promise<number> {
  const text = (await figure.textContent()) ?? '';
  return Number(text.replace(/[^0-9]/g, ''));
}

/**
 * Open the phone summary's "Conversion details" disclosure, leave it open, and return the
 * region it controls.
 *
 * `openExpenseList`'s rules, for its reasons, on a different control: idempotent on the
 * control's OWN `aria-expanded` (a second blind press would CLOSE it, which is why
 * `pressAndReveal` does not fit), the region found through `aria-controls` rather than by
 * a guessed id, and the one retry only while the control still reads `"false"`.
 *
 * Addressed by attribute rather than `#id`: the id is React's `useId()`, and its format is
 * React's business — an attribute selector matches whatever characters it uses.
 *
 * Scoped to the summary, because "Conversion details" is a name nothing else on the page
 * should carry, and an unscoped match would pass on a build that moved it out of the body.
 */
async function openConversionDetails(summary: Locator): Promise<Locator> {
  const toggle = summary.getByRole('button', { name: 'Conversion details', exact: true });
  await expect(
    toggle,
    'the "Conversion details" disclosure is not in the phone summary. It renders only on a ' +
      '`rollup.multiCurrency` report, inside `ReportSummary` in ExpenseReportWorkbench.tsx — ' +
      'either the fixture is single-currency or the toggle moved.',
  ).toBeEnabled({ timeout: 30_000 });

  const regionId = await toggle.getAttribute('aria-controls');
  expect(
    regionId,
    'the "Conversion details" toggle has no `aria-controls`, so nothing says which region it ' +
      'opens — a screen-reader defect in its own right, and there is no region to wait for.',
  ).toBeTruthy();
  const region = summary.locator(`[id="${regionId}"]`);
  await expect(
    region,
    '`aria-controls` names an id that is not inside the summary. The region is meant to stay ' +
      'MOUNTED under `hidden` while closed, so the reference always resolves.',
  ).toHaveCount(1);

  if ((await toggle.getAttribute('aria-expanded')) === 'true') return region;

  await toggle.click();
  const opened = await region.waitFor({ state: 'visible', timeout: 6_000 }).then(
    () => true,
    () => false,
  );
  if (!opened && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }

  await expect(
    toggle,
    'pressing "Conversion details" did not expand it — `aria-expanded` is still "false". ' +
      'The press was acknowledged by nothing.',
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });
  await expect(
    region,
    'the disclosure reports itself expanded and the region it controls is still not visible. ' +
      '`aria-expanded` and the `hidden` class on the region are two reads of one ' +
      '`detailsOpen` state and must agree.',
  ).toBeVisible({ timeout: 20_000 });
  return region;
}

/** One animation frame, so a layout read after a disclosure opens sees the opened layout. */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test.describe('the expense workbench, on a phone', () => {
  test('read the report and its totals', async ({ page }) => {
    /**
     * FLOW 1 of 8. The one that carries the overflow measurement and the top-bar ration,
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
     * FLOW 2 of 8. Below `lg` the receipt pane is not a pane — it is a bottom sheet opened
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
     * FLOW 3 of 8, and the one the whole task is for. Before Phase 3 there was no Submit
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
     * FLOW 4 of 8. A returned report comes back to the submitter EDITABLE — that is the whole
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
     * FLOW 5 of 8 (P18). A submitter on a draft taps "Add expense", lands on the new
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

    // ── No notice: nothing on this pane is read-only on a phone any more (P13). ─────────
    await expect(
      page.getByTestId('section-limited-notice'),
      'the editor rendered a section notice. P13 gave the cost allocation, the tax and the ' +
        'attendees an editor at every width, so a notice would call editable regions ' +
        'read-only. Its call site and catalog keys were deleted; something brought one back.',
    ).toHaveCount(0);

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
      // P18's five, plus GST/HST, QST, PST and Percent (P13). One allocation row here.
      await expectWorkbenchHazards(desk, at);
      await expect(
        desk.getByTestId('section-limited-notice'),
        `the editor rendered a section notice at ${at}`,
      ).toHaveCount(0);
    });
  });

  test('set the expense tax on a phone', async ({ page }) => {
    /**
     * FLOW 6 of 8 (P13). A submitter on a draft sets the expense's GST/HST on a phone, sees a
     * figure the server refuses come back with the reason beside it, and finds the saved
     * figure after a reload. Before P13 the three tax inputs were `hidden lg:contents` below
     * `lg` and a phone saw the figures as prose only.
     */
    const title = reportTag('phone tax');
    await signIn(page, 'employee');
    // One receipted CAD expense of 100.00 (one Office Supplies line), built at 1280.
    const id = await seedReport(page, title, 1);
    const expenseId = await seededExpenseId(id);
    await openSeededOnPhone(page, id);
    const width = `${page.viewportSize()?.width ?? '?'}px`;

    // ── The labelled-field hazard, at phone width. One allocation row on this expense. ────
    await expectWorkbenchHazards(page, width);
    await expect(page.getByTestId('section-limited-notice')).toHaveCount(0);

    // ── Each tax input is a 44px target on a coarse pointer. ─────────────────────────────
    const gst = page.getByLabel('GST/HST');
    await expectTapBox(gst, 'the GST/HST input');
    await expectTapBox(page.getByLabel('QST'), 'the QST input');
    await expectTapBox(page.getByLabel('PST'), 'the PST input');

    // ── Save: the figure commits on BLUR, as a manual override. ──────────────────────────
    const db = await testDb(CALLER);
    const taxOnServer = async () => {
      // VeloExpense: SQL on the admin pool, in place of `db.expense.findUnique`.
      const e = (
        await db.query(
          `SELECT tax_gst_hst_minor::text AS gst, tax_source FROM expense WHERE id = $1`,
          [expenseId],
        )
      ).rows[0] as { gst: string | null; tax_source: string } | undefined;
      return e ? { gst: String(e.gst), source: e.tax_source } : null;
    };
    await gst.fill('5.00');
    await gst.blur();
    await expect
      .poll(taxOnServer, {
        timeout: 30_000,
        message: 'GST/HST 5.00 typed on the phone should be saved as a manual 500',
      })
      .toEqual({ gst: '500', source: 'MANUAL' });

    // ── A figure the server refuses: the reason is visible, the field reverts. ───────────
    /**
     * Paid tax is bounded by the gross (`expenseTaxUpdate`), so 5,000.00 of GST on a 100.00
     * expense is refused. The reader has to be able to SEE why, at this width, beside the
     * field it is about: `toBeInViewport` after the scroll, not only `toBeVisible`.
     */
    await gst.fill('5000.00');
    await gst.blur();
    const taxCard = page
      .locator('div.rounded-md.border')
      .filter({ has: page.getByText('Taxes', { exact: true }) })
      .filter({ has: gst })
      .last();
    const refusal = taxCard.getByRole('alert');
    await expect(
      refusal,
      'the server refused 5,000.00 of GST on a 100.00 expense; the tax panel should say why ' +
        'under the fields, at this width',
    ).toBeVisible({ timeout: 30_000 });
    await refusal.scrollIntoViewIfNeeded();
    await expect(refusal, 'the refusal should be on screen, not only in the DOM').toBeInViewport();
    await expect(gst, 'the refused figure should give way to the saved one').toHaveValue(
      /^5(\.00)?$/,
      { timeout: 20_000 },
    );
    expect(await taxOnServer(), 'the refused figure must not have reached the server').toEqual({
      gst: '500',
      source: 'MANUAL',
    });

    // ── And the saved figure survives a reload. ──────────────────────────────────────────
    await openSeededOnPhone(page, id);
    await expect(gst, 'GST/HST should survive a reload').toHaveValue(/^5(\.00)?$/, {
      timeout: 20_000,
    });
    await expectNoHorizontalOverflow(page, 'the tax panel, edited');

    // ── The same hazard counts at 1280. ──────────────────────────────────────────────────
    await onDesktop(page, async (desk) => {
      await openSeededOnDesktop(desk, id);
      await expectWorkbenchHazards(desk, `${DESKTOP.width}px`);
    });
  });

  test('code the expense across two allocations on a phone', async ({ page }) => {
    /**
     * FLOW 7 of 8 (P13). A submitter splits the expense 60/40 across two fully coded allocation
     * rows on a phone, reloads, then takes the split back to one row. Before P13 the rows and
     * "Add allocation" were `hidden lg:contents` below `lg`, and a phone was shown the saved
     * coding as prose.
     *
     * VeloExpense: NO CLASS. ExpenseOS seeds a NetSuite class per project here because its
     * editor saves only rows with a business unit, a department AND a class. VeloExpense has
     * no classes (`dimensionOptions` sends none, w2-03; `allocationSet` takes none), so the
     * picker is not drawn and a row is complete with a business unit and a department.
     */
    const title = reportTag('phone allocation');
    const db = await testDb(CALLER);

    await signIn(page, 'employee');
    const id = await seedReport(page, title, 1);
    const expenseId = await seededExpenseId(id);
    await openSeededOnPhone(page, id);
    const width = `${page.viewportSize()?.width ?? '?'}px`;

    // ── Before the second row: the hazard counts, while `Location` is still countable. ────
    /**
     * Order matters. From the second allocation row on, `getByLabel('Location')` also matches
     * each "Remove allocation" button (see `expectWorkbenchHazards`), so the names are
     * counted here, on one row, and only `Percent` is counted per row after.
     */
    await expectWorkbenchHazards(page, width);
    // VeloExpense: SQL on the admin pool, in place of `db.expenseAllocation.count`.
    const savedCount = async () =>
      Number(
        (
          await db.query(`SELECT count(*)::int AS n FROM expense_allocation WHERE expense_id = $1`, [
            expenseId,
          ])
        ).rows[0].n,
      );
    const savedAtStart = await savedCount();
    // The editor seeds one 100% row when nothing is saved; coding defaults may have saved one.
    await expectOnePercentPerRow(page, Math.max(1, savedAtStart), 'on arrival');
    expect(savedAtStart, 'this flow expects to start from at most one saved row').toBeLessThan(2);

    // ── "Add allocation": local state, no write. ─────────────────────────────────────────
    const card = allocationCard(page);
    const addAllocation = page.getByRole('button', { name: 'Add allocation', exact: true });
    const percents = card.getByLabel('Percent');
    // VeloExpense: the kit Combobox is a button that keeps its placeholder as `data-placeholder`.
    const businessUnits = card.locator('[data-placeholder="Business unit"]');
    const departments = card.locator('[data-placeholder="Department"]');
    await pressAndReveal(addAllocation, businessUnits.nth(1), 'Add allocation');
    await expectOnePercentPerRow(page, 2, 'after "Add allocation"');

    // ── 60/40, each committed on blur, then every dimension picked. ──────────────────────
    await percents.nth(0).fill('60');
    await percents.nth(0).blur();
    await percents.nth(1).fill('40');
    await percents.nth(1).blur();
    for (const row of [0, 1]) {
      await pickFirstOption(page, businessUnits.nth(row));
      await pickFirstOption(page, departments.nth(row));
      await expect(page.getByRole('option')).toHaveCount(0, { timeout: 10_000 });
    }

    // VeloExpense: SQL on the admin pool, in place of `db.expenseAllocation.findMany`; no
    // NetSuite business unit and no class, so coded is a business unit and a department.
    const savedRows = async () =>
      (
        (
          await db.query(
            `SELECT percent_bp, business_unit_id, department_id FROM expense_allocation
              WHERE expense_id = $1 ORDER BY percent_bp DESC`,
            [expenseId],
          )
        ).rows as {
          percent_bp: number;
          business_unit_id: string | null;
          department_id: string | null;
        }[]
      ).map((a) => ({
        percentBp: a.percent_bp,
        coded: Boolean(a.business_unit_id && a.department_id),
      }));
    await expect
      .poll(savedRows, {
        timeout: 30_000,
        message:
          'the 60/40 split should be saved once both rows are fully coded and sum to 100. ' +
          'Nothing saved means a pick or a blur never committed; the editor writes only a ' +
          'complete, balanced set (_workbench/parts.tsx, `AllocationEditor`).',
      })
      .toEqual([
        { percentBp: 6000, coded: true },
        { percentBp: 4000, coded: true },
      ]);

    // ── Tap size: every allocation control is a 44px target on a coarse pointer. ─────────
    for (const row of [0, 1]) {
      await expectTapBox(percents.nth(row), `the Percent input on row ${row + 1}`);
      await expectTapBox(businessUnits.nth(row), `the Business unit picker on row ${row + 1}`);
      await expectTapBox(departments.nth(row), `the Department picker on row ${row + 1}`);
    }
    const removes = card.getByRole('button', { name: 'Remove allocation', exact: true });
    await expect(removes, 'two rows carry two remove buttons').toHaveCount(2);
    for (const row of [0, 1]) {
      await expectTapBox(removes.nth(row), `"Remove allocation" on row ${row + 1}`, true);
    }
    await expectTapBox(addAllocation, '"Add allocation"');

    // ── Overflow: the rows, and the portalled listbox outside `main`. ────────────────────
    await expectNoHorizontalOverflow(page, 'two allocation rows, both coded');
    /**
     * The combobox's listbox is portalled to the body, outside `main`, so
     * `expectNoHorizontalOverflow` cannot see it. The document's own scroll width can.
     */
    // VeloExpense: the Department list, row 2's last picker (no Class here).
    await departments.nth(1).click();
    await expect(page.getByRole('option').first(), 'the Department list should open').toBeVisible({
      timeout: 10_000,
    });
    const documentOver = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(
      documentOver,
      `with the Department list open the document scrolls sideways by ${documentOver}px`,
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0, { timeout: 10_000 });

    // ── Phone geometry: each row is a stacked card, percent above its business unit. ─────
    const percentTop = (await percents.nth(0).boundingBox())?.y ?? 0;
    const businessUnitTop = (await businessUnits.nth(0).boundingBox())?.y ?? 0;
    expect(
      percentTop,
      'below `lg` the row should stack: the percent on its own line above the business unit',
    ).toBeLessThan(businessUnitTop);

    // ── Reload: the split is what the server holds. ──────────────────────────────────────
    await openSeededOnPhone(page, id);
    await expect(percents.nth(0), 'row 1 should read 60 after a reload').toHaveValue('60', {
      timeout: 20_000,
    });
    await expect(percents.nth(1), 'row 2 should read 40 after a reload').toHaveValue('40');
    await expectOnePercentPerRow(page, 2, 'after a reload');

    // ── Remove a row: the UI drops it at once, the server keeps the balanced pair. ───────
    /**
     * 60 alone does not make 100, so removing row 2 writes NOTHING, by design: the editor
     * persists only a balanced set. The page shows one row while the server still holds two
     * until the remaining row is set to 100. Asserted rather than left to surprise a reader.
     */
    await pressUntil(
      removes.nth(1),
      'Remove allocation',
      async () => (await percents.count()) === 1,
      async () => (await percents.count()) === 2,
    );
    await expectOnePercentPerRow(page, 1, 'after removing row 2');
    await page.waitForLoadState('networkidle');
    expect(
      await savedCount(),
      'removing a row from a 60/40 split leaves 60, which is not balanced, so nothing is saved',
    ).toBe(2);
    await percents.nth(0).fill('100');
    await percents.nth(0).blur();
    await expect
      .poll(savedRows, {
        timeout: 30_000,
        message: 'one row at 100 is balanced and complete, so it should replace the pair',
      })
      .toEqual([{ percentBp: 10000, coded: true }]);

    // ── At 1280: the hazard counts, the invariant, and the restored one-line row. ────────
    await onDesktop(page, async (desk) => {
      await openSeededOnDesktop(desk, id);
      const at = `${DESKTOP.width}px`;
      // One saved row now, so `Location` is countable again.
      await expectWorkbenchHazards(desk, at);
      await expectOnePercentPerRow(desk, 1, `at ${at}`);

      /**
       * From `lg` up the row is the pre-P13 one-line row: the percent and the pickers
       * (VeloExpense: two, no Class) share one top, and the percent keeps its `w-20` (80px).
       */
      const deskCard = allocationCard(desk);
      const boxes = await Promise.all(
        [
          deskCard.getByLabel('Percent'),
          deskCard.locator('[data-placeholder="Business unit"]'),
          deskCard.locator('[data-placeholder="Department"]'),
        ].map((l) => l.boundingBox()),
      );
      const tops = boxes.map((b) => Math.round(b?.y ?? -1));
      expect(
        Math.max(...tops) - Math.min(...tops),
        `at ${at} the allocation row should be one line; the tops were ${tops.join(', ')}`,
      ).toBeLessThanOrEqual(2);
      const percentWidth = Math.round(boxes[0]?.width ?? 0);
      expect(
        Math.abs(percentWidth - 80),
        `at ${at} the percent should keep its 80px (\`w-20\`); it is ${percentWidth}px`,
      ).toBeLessThanOrEqual(2);
    });
  });

  test('name an attendee on a phone', async ({ page }) => {
    /**
     * FLOW 8 of 8 (P13). A submitter adds a golf line on a phone, which makes the expense require
     * attendees and names the submitter as the first attendee, removes that prefilled row, then
     * names an external guest, picks a colleague from the directory, and removes the guest again. Before P13 the attendees block was `hidden lg:contents` below
     * `lg`, so a phone could create a line that needed attendees and not name them.
     */
    const title = reportTag('phone attendees');
    const db = await testDb(CALLER);
    // VeloExpense: a category of its own, created once and left on. See the constant.
    await db.query(
      `INSERT INTO expense_category (organization_id, code, label, requires_attendees)
       SELECT o.id, $1, jsonb_build_object('en', $2::text, 'fr-CA', $2::text), true
         FROM organization o WHERE o.slug = 'demo'
       ON CONFLICT (organization_id, code)
         DO UPDATE SET requires_attendees = true, active = true`,
      [ATTENDEE_CATEGORY_CODE, ATTENDEE_CATEGORY_LABEL],
    );

    await signIn(page, 'employee');
    const id = await seedReport(page, title, 1);
    const expenseId = await seededExpenseId(id);
    await openSeededOnPhone(page, id);
    const width = `${page.viewportSize()?.width ?? '?'}px`;

    // ── Add a golf line on the phone. ────────────────────────────────────────────────────
    /**
     * The seeded Office Supplies line is a saved row with the same category placeholder, so
     * the new draft's picker is the SECOND one, which does not exist until the press lands.
     */
    // VeloExpense: the kit Combobox keeps its placeholder as `data-placeholder`.
    const categories = page.locator('[data-placeholder="Select a category"]');
    await expect(categories, 'the seeded line is the only category picker').toHaveCount(1, {
      timeout: 30_000,
    });
    await pressAndReveal(
      page.getByRole('button', { name: 'Add line', exact: true }),
      categories.nth(1),
      'Add line',
    );
    await pickCombobox(page, categories.nth(1), ATTENDEE_CATEGORY);
    // Lines render in creation order, so the new one is second. 150.00, under the 200.00 rule.
    const amounts = page.getByLabel('Amount', { exact: true });
    await expect(amounts, 'two saved lines, two amounts').toHaveCount(2, { timeout: 30_000 });
    await amounts.nth(1).fill('150.00');
    await amounts.nth(1).blur();
    await expect
      .poll(
        async () =>
          // VeloExpense: SQL on the admin pool, in place of `db.expenseLineItem.findMany`.
          (
            (
              await db.query(
                `SELECT amount_minor::text AS a FROM expense_line_item
                  WHERE expense_id = $1 ORDER BY created_at`,
                [expenseId],
              )
            ).rows as { a: string }[]
          ).map((l) => l.a),
        { timeout: 30_000, message: 'the golf line should be saved at 150.00' },
      )
      .toEqual(['10000', '15000']);

    // ── The attendees block renders from the SAVED line, so wait for it by condition. ────
    const heading = page.getByText('Attendees', { exact: true });
    await expect(
      heading,
      'a saved golf line should make the expense require attendees, and the attendees block ' +
        'should render on a phone',
    ).toBeVisible({ timeout: 30_000 });
    const block = heading.locator('xpath=..');
    await expectWorkbenchHazards(page, width, { amounts: 2 });

    const attendeesOnServer = async () =>
      // VeloExpense: SQL on the admin pool, in place of `db.expenseAttendee.findMany`.
      (
        (
          await db.query(
            `SELECT name, company, is_external FROM expense_attendee
              WHERE expense_id = $1 ORDER BY name`,
            [expenseId],
          )
        ).rows as { name: string; company: string | null; is_external: boolean }[]
      ).map((a) => `${a.name}|${a.company ?? ''}|${a.is_external ? 'external' : 'internal'}`);

    // ── The prefill: the golf line named the claimant; remove them before the guest. ─────
    /**
     * The golf line is this expense's first line in a category that requires attendees, so the
     * server named the claimant — Demo Employee, the seeded `employee` (VeloExpense; ExpenseOS's
     * is QA Employee) — in the same write, and the block mounted with that row (#588). It is
     * removed here so the steps below start from the empty roster they were written against.
     */
    await expect
      .poll(attendeesOnServer, {
        timeout: 30_000,
        message: 'the golf line should have named the claimant as the first attendee',
      })
      .toEqual(['Demo Employee||internal']);
    await expect(
      block.getByText('Demo Employee', { exact: true }),
      'the prefilled claimant should be shown on the phone',
    ).toBeVisible({ timeout: 30_000 });
    await pressUntil(
      block.getByRole('button', { name: 'Remove attendee', exact: true }),
      'Remove attendee (claimant)',
      async () => (await attendeesOnServer()).length === 0,
      async () =>
        (await block.getByRole('button', { name: 'Remove attendee', exact: true }).count()) === 1,
    );

    // ── An external guest: name and company, each committed on blur. ─────────────────────
    const name = block.getByPlaceholder('Name', { exact: true });
    const company = block.getByPlaceholder('Company', { exact: true });
    await pressAndReveal(
      block.getByRole('button', { name: 'Add external', exact: true }),
      name,
      'Add external',
    );
    await name.fill('Dana Whitfield');
    await name.blur();
    /**
     * Wait for the name's save to land before typing the company. Each blur sends the whole
     * roster, and the server writes it as delete-then-create; two saves milliseconds apart
     * both commit, and the guest is stored twice. A person is never that fast; Playwright is.
     */
    await expect
      .poll(attendeesOnServer, {
        timeout: 30_000,
        message: 'the external guest should be saved by name before the company is typed',
      })
      .toEqual(['Dana Whitfield||external']);
    await company.fill('Northbridge');
    await company.blur();
    await expect
      .poll(attendeesOnServer, {
        timeout: 30_000,
        message: 'the external guest typed on the phone should be saved with their company',
      })
      .toEqual(['Dana Whitfield|Northbridge|external']);

    // ── A colleague from the directory: it matches on email, after a 250ms debounce. ─────
    const search = block.getByPlaceholder('Search employees');
    // VeloExpense: the demo tenant's manager, Demo Manager <manager@demo.test>.
    await search.fill('manager@demo');
    const result = block.getByRole('button', { name: /manager@demo\.test/ });
    await expect(result, 'the directory should offer Demo Manager by email').toBeVisible({
      timeout: 20_000,
    });

    // ── Tap size, with a guest row, the directory open and the result on screen. ─────────
    await expectTapBox(search, 'the attendee search input');
    await expectTapBox(name, "the guest's Name input");
    await expectTapBox(company, "the guest's Company input");
    await expectTapBox(result, 'the directory result');
    await expectTapBox(
      block.getByRole('button', { name: 'Add external', exact: true }),
      '"Add external"',
    );
    await expectNoHorizontalOverflow(page, 'the attendees block, with the directory open');

    const hasColleague = async () => (await attendeesOnServer()).includes('Demo Manager||internal');
    await pressUntil(result, 'Demo Manager (directory result)', hasColleague, async () =>
      result.isVisible(),
    );
    const removes = block.getByRole('button', { name: 'Remove attendee', exact: true });
    await expect(removes, 'a guest and a colleague, two remove buttons').toHaveCount(2);
    for (const i of [0, 1]) await expectTapBox(removes.nth(i), `"Remove attendee" ${i + 1}`, true);
    await expectNoHorizontalOverflow(page, 'the attendees block, with two attendees');

    // ── Remove the guest: rows render in the order they were added, so the guest is first. ──
    await pressUntil(
      removes.first(),
      'Remove attendee',
      async () => (await attendeesOnServer()).join() === 'Demo Manager||internal',
      async () => (await removes.count()) === 2,
    );

    // ── Reload: the colleague is still named. ────────────────────────────────────────────
    await openSeededOnPhone(page, id);
    await expect(
      page.getByText('Attendees', { exact: true }).locator('xpath=..').getByText('Demo Manager', {
        exact: true,
      }),
      'the colleague should still be named after a reload',
    ).toBeVisible({ timeout: 30_000 });

    // ── At 1280: two saved lines, so two amounts; every other name once. ─────────────────
    await onDesktop(page, async (desk) => {
      await openSeededOnDesktop(desk, id);
      await expectWorkbenchHazards(desk, `${DESKTOP.width}px`, { amounts: 2 });
    });
  });

  test('read how a mixed-currency total adds up', async ({ page }) => {
    /**
     * P16. On a CAD report holding a USD expense, a phone reader can see what each currency
     * contributed, open "Conversion details", and check that the converted figures add up to
     * the total to the cent. Then an FX-override holder opens the same report once it is
     * submitted, and is told in words where the override is, while its control stays cloaked.
     *
     * THE ORACLE IS THE SERVER, NEVER ARITHMETIC. Every figure on screen is compared with
     * `expenses.report`'s roll-up, and the sum is compared with `homeTotalMinor`. Gross × rate
     * is never asserted: the roll-up converts each EXPENSE and sums the results, so per-expense
     * rounding makes "gross × rate = converted" false in general.
     */
    const title = reportTag('phone fx');
    await signIn(page, 'employee');
    // One CAD and one USD expense, built at 1280 as every fixture here is (see the header).
    const id = await onDesktop(page, async (desk) => {
      const reportId = await createReport(desk, title);
      await addExpense(desk, { vendor: 'Bay Street Depot', amount: '50.00', category: CATEGORY });
      await addExpense(desk, {
        vendor: 'Buffalo Office Mart',
        amount: '100.00',
        category: CATEGORY,
        currency: /^USD/,
      });
      return reportId;
    });

    // ── The oracle, once the USD expense is converted on the server. ─────────────────────
    await expect
      .poll(
        async () =>
          (await reportOracle(page, id)).rollup.byCurrency.find((c) => c.code === 'USD')
            ?.convertedMinor ?? null,
        {
          timeout: 30_000,
          message:
            'the USD expense never got a converted amount on the server. Either the line did ' +
            'not save, or the seeded USD to CAD rate is missing (packages/db/prisma/seed.ts, ' +
            'SEED_FX_RATES).',
        },
      )
      .not.toBeNull();
    const { rollup } = await reportOracle(page, id);
    expect(rollup.homeCurrency, 'the fixture report should be in CAD').toBe('CAD');
    expect(rollup.multiCurrency, 'a CAD report with a USD expense is mixed-currency').toBe(true);
    expect(rollup.missingRates, 'both currencies have a rate to CAD').toEqual([]);
    // `minorOnScreen` reads every digit as a cent, which is only right for two-decimal
    // currencies. Pinned here so a fixture change cannot quietly break that.
    expect(
      rollup.byCurrency.map((c) => c.code).sort(),
      'the fixture should hold exactly a CAD and a USD expense',
    ).toEqual(['CAD', 'USD']);

    await openOnPhone(page, id);
    const summary = page.getByTestId('report-summary');

    // ── The composition is RENDERED, and it tells the truth. ─────────────────────────────
    /**
     * Read BEFORE the disclosure opens. While it is closed its region is `display: none`, so
     * `getByRole('listitem')` sees only the composition rows, and the count below is also
     * the proof that the reconciliation's rows are not exposed until asked for.
     */
    const toggle = summary.getByRole('button', { name: 'Conversion details', exact: true });
    await expect(toggle, 'the disclosure should start closed').toHaveAttribute(
      'aria-expanded',
      'false',
      { timeout: 30_000 },
    );
    const composition = summary.getByRole('listitem');
    await expect(
      composition,
      'the composition should show one row per currency, without a tap',
    ).toHaveCount(rollup.byCurrency.length);
    for (const c of rollup.byCurrency) {
      const row = composition.filter({ hasText: new RegExp(`^${c.code}\\s`) });
      await expect(row, `the ${c.code} composition row`).toHaveCount(1);
      await expect
        .poll(() => minorOnScreen(row.locator('span').first()), {
          message: `the ${c.code} row should show its gross, ${c.grossMinor} minor units`,
        })
        .toBe(Number(c.grossMinor));
      /**
       * The right-hand note. The home row says nothing: there is nothing to convert, and
       * printing "No rate" beside the report's own currency was the false statement P16
       * fixed. A converted row names its one rate, or says it was converted at several.
       */
      const note =
        c.code === rollup.homeCurrency
          ? ''
          : c.rate
            ? catalogText('expenses', 'workbench.fxRate').replace('{rate}', c.rate)
            : catalogText('expenses', 'workbench.fxRatesVary');
      await expect(
        row.locator('span').last(),
        c.code === rollup.homeCurrency
          ? `the ${c.code} row is the report's own currency and should carry no rate note`
          : `the ${c.code} row should say what it was converted at`,
      ).toHaveText(note);
    }

    // ── The trigger is a full tap target. ────────────────────────────────────────────────
    const box = await toggle.boundingBox();
    expect(box, 'the "Conversion details" toggle has no box').not.toBeNull();
    expect(
      box?.height ?? 0,
      `the "Conversion details" toggle is under the ${HIT_FLOOR_PX}px tap floor`,
    ).toBeGreaterThanOrEqual(HIT_FLOOR_PX);

    // ── Open it, and the figures add up. ─────────────────────────────────────────────────
    const details = await openConversionDetails(summary);
    const converted = details.getByRole('listitem');
    await expect(
      converted,
      'the reconciliation should list one converted row per currency',
    ).toHaveCount(rollup.byCurrency.length);
    let shownSum = 0;
    for (const c of rollup.byCurrency) {
      // The code is the row's own first cell, so it is matched exactly, not as a prefix.
      const row = converted.filter({ has: page.getByText(c.code, { exact: true }) });
      await expect(row, `the ${c.code} converted row`).toHaveCount(1);
      const figure = row.locator('span').last();
      await expect
        .poll(() => minorOnScreen(figure), {
          message: `the ${c.code} row should show ${c.convertedMinor} CAD minor units`,
        })
        .toBe(Number(c.convertedMinor));
      shownSum += await minorOnScreen(figure);
    }
    await expect(
      details.getByText(catalogText('expenses', 'workbench.fxNotIncluded')),
      'no currency is missing a rate, so nothing should be flagged as left out',
    ).toHaveCount(0);

    const sumRow = details.getByTestId('report-summary-sum');
    await expect(sumRow).toContainText(catalogText('expenses', 'workbench.fxReportTotal'));
    const shownTotal = await minorOnScreen(sumRow.locator('span').last());
    expect(
      shownSum,
      'the converted rows on screen should add up to the "Report total" row, to the cent',
    ).toBe(shownTotal);
    expect(shownTotal, "the total should be the server's homeTotalMinor").toBe(
      Number(rollup.homeTotalMinor),
    );
    expect(
      await minorOnScreen(summary.locator('p').first()),
      'the headline total and the reconciliation total should be the same figure',
    ).toBe(shownTotal);

    // The recoverable line follows the server: there when it is not zero, absent when it is.
    await expect(details.getByText(catalogText('expenses', 'workbench.fxRecoverable'))).toHaveCount(
      BigInt(rollup.recoverableTotalMinor) === 0n ? 0 : 1,
    );

    // ── The opened disclosure fits, and the top bar still holds its ration. ──────────────
    await nextFrame(page);
    await expectNoHorizontalOverflow(page, 'the phone summary with "Conversion details" open');
    await expectTopBarRationHeld(page);

    // ── The holder stage: submitted, then opened by someone who may override the rate. ───
    /**
     * `expenseAdmin` is the seeded holder of `expense.report.fxOverride` (it spreads all of
     * `P.expense`, packages/rbac/src/systemRoles.ts). It can open somebody else's report
     * because it also holds `expense.report.readAll`, which `canViewReport` lets straight in.
     */
    await onDesktop(page, async (desk) => {
      await desk.goto(reportUrl(id));
      await pressAndSettle(desk, 'Submit report');
      await expectAnyRowEventually(desk, `/expenses`, title, /Submitted/i);
    });
    await switchTo(page, 'expenseAdmin');
    await openOnPhone(page, id);
    await expect(summary).toContainText('Submitted');

    /**
     * MOUNTED and HIDDEN, asserted separately. A CSS locator rather than a role one, because
     * `getByRole` skips hidden nodes: `toBeHidden()` on it would pass on a page that never
     * mounted the control at all. The count of one says the shared predicate offered it to
     * this holder; `toBeHidden()` says the `hidden lg:contents` cloak kept it off a phone.
     */
    const override = page.locator('button').filter({ hasText: /^FX override/ });
    await expect(
      override,
      'the FX override control should be mounted for a holder on a SUBMITTED mixed-currency ' +
        'report. Zero means `isFxOverrideOffered` answered false for this actor.',
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      override,
      'the FX override control is visible on a phone. Its `hidden lg:contents` wrapper in the ' +
        'expense-list header is what keeps it desktop-only.',
    ).toBeHidden();

    const holderDetails = await openConversionDetails(summary);
    await expect(
      holderDetails.getByText(catalogText('expenses', 'workbench.fxOverridePhoneNote'), {
        exact: true,
      }),
      'a holder should be told, in words, that the override is on a larger screen',
    ).toBeVisible();
    await expect(
      holderDetails.getByRole('button'),
      'the region names the override; it must not hold a second control for it',
    ).toHaveCount(0);
    await expect(holderDetails.getByRole('link')).toHaveCount(0);

    await nextFrame(page);
    await expectNoHorizontalOverflow(page, "a holder's phone summary with the details open");
    // No `expectTopBarRationHeld` here: it also demands a Submit button in the phone bar, and
    // a SUBMITTED report gives this actor none.
  });

  test('a half-typed vendor and tax figure survive a live resize across lg', async ({ page }) => {
    /**
     * P18's no-unmount property, observed. The expense fields have ONE face at every width,
     * with no `useIsBelowLg` branch around them, so a window dragged across 1024 keeps
     * what is half typed in them. A remount would reset Vendor to its saved value.
     *
     * P13 gave the tax panel the same one face, so a second cycle holds a half-typed GST/HST
     * figure across the same resize. ONE UNBLURRED FIELD PER CYCLE: Playwright's `fill` on a
     * second field blurs the first, and a blur commits, so the vendor cycle finishes before
     * the tax figure is typed. `7.50` is a figure that is valid on its own, so the commit
     * that typing it causes later is harmless rather than a null written through `7.`.
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

      // ── Cycle 2: a half-typed tax figure (P13). Typing it blurs Vendor, which commits. ──
      const expenseId = await seededExpenseId(id);
      const db = await testDb(CALLER);
      const gstField = desk.getByLabel('GST/HST');
      await gstField.fill('7.50');
      for (const size of [{ width: 900, height: 900 }, { width: 390, height: 664 }, BELOW_XL]) {
        await desk.setViewportSize(size);
        if (size.width < 1024) {
          await expect(
            summary,
            `at ${size.width}px the page should be in its phone tree`,
          ).toBeVisible({ timeout: 10_000 });
        } else {
          await expect(
            summary,
            `back at ${size.width}px the page should be in its desktop tree again`,
          ).toHaveCount(0, { timeout: 10_000 });
        }
        await expect(
          gstField,
          `the half-typed GST/HST was lost at ${size.width}px. The tax panel remounted: ` +
            'something now renders it under a width-dependent branch.',
        ).toHaveValue('7.50');
      }
      /**
       * Unsaved, which is what makes the cycle mean anything: had a resize blurred the field,
       * the figure would have been committed as a manual override and the value check above
       * would be reading the server's copy rather than the input's own state.
       */
      // VeloExpense: SQL on the admin pool, in place of `db.expense.findUnique`.
      const saved = (
        await db.query(`SELECT tax_source FROM expense WHERE id = $1`, [expenseId])
      ).rows[0] as { tax_source: string } | undefined;
      expect(
        saved?.tax_source,
        'the half-typed GST/HST reached the server during the resize, so the field was blurred',
      ).not.toBe('MANUAL');
    });
  });
});

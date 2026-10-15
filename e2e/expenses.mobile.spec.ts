import { readFileSync } from 'node:fs';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { receiptFile } from './fixtures/receiptImage';
import { signIn } from './support/actors';
import { navCatalog } from './support/catalog';
import { PHONE_PROJECTS } from './support/phone-projects';
import { assertCoarsePointer, assertProject } from './support/tap-targets';
import { seedEmployeeActivity } from './support/seed-activity';
import { closeTestDb, testDb as sharedTestDb } from './support/test-db';
import { reportTag } from './support/workbench';

/**
 * VeloExpense: ExpenseOS's `e2e/expenses.mobile.spec.ts` (1e682dd6), ported with its phone
 * specs. `/expenses`' list is ExpenseOS's (`ExpenseReportsList.tsx`, 9 lines apart). The changes
 * are marked `VeloExpense:` where they are made:
 *
 *   · EN ONLY. VeloExpense offers no French (`i18n/request.ts`), so there is no FR-CA page
 *     for the half this header calls the one that matters. `LOCALES` keeps one entry.
 *   · NO LOCALE SEGMENT in any URL.
 *   · THE DRAFT IS BUILT, NOT SEEDED: `seedEmployeeActivity` makes the employee's draft (and a
 *     submitted report) once per worker, and the filter test looks for that draft by title.
 *   · THE DATABASE READS ARE SQL on the admin pool (`e2e/support/test-db.ts` says why), and
 *     the account is `employee@demo.test`.
 *
 * `/expenses` on a phone: FIND MY REPORT, OPEN IT, and START ONE FROM RECEIPTS.
 *
 * ─── THIS ROUTE IS RULED `limited`, AND THE ROUGH EDGE IS IN THE TOP BAR ─────────────────
 *
 * P05 rules both `/expenses` and `/expenses/approvals` `limited` rather than the `ready` the
 * ticket proposed, and for `/expenses` the substance of that ruling is a measurement this
 * file makes and DOES NOT ENFORCE. Read the split before reading any assertion below:
 *
 *   · THE CARD TREE WORKS. T03 already shipped `/expenses`' `DataTableMobileConfig`, so the
 *     ~920px desktop grid is a stacked card list below 768px with a filter sheet and a sort
 *     sheet in `expenses-mobile-controls`. That half is what the assertions here prove.
 *   · THE TOP BAR IS OVER-SUBSCRIBED, AND IT IS **NAMED, NOT REPAIRED**. At a coarse pointer
 *     this page publishes THREE interactive controls into the top bar's `[data-chrome="page"]`
 *     slot — "Take photo", "Choose file" and "New report" (`ExpenseReportsList.tsx:397-407`,
 *     with the camera/picker pair coming from `ReceiptFileInput`'s coarse branch). That is
 *     the `/delegations` hazard `docs/design/pwa.md:626` recorded — one published control
 *     "painted over the route title, worst in FR-CA" — TRIPLED, against a route title that is
 *     itself longer in both locales ("My Expense Reports" / "Mes rapports de dépenses" vs
 *     "Delegations" / "Délégations").
 *
 * AT `limited` THE REPAIR IS OUT OF SCOPE BY CONSTRUCTION, and naming it is not. So the
 * geometry block below MEASURES the overlap, the spill and the title clipping, ATTACHES the
 * numbers to the run and ANNOTATES the test with them — and asserts nothing about any of the
 * three. A red here about the top bar would be reporting a recorded gap as a regression,
 * which is the mistake `e2e/dashboard.mobile.spec.ts` and `e2e/delegations.mobile.spec.ts`
 * both refuse in their own headers. `e2e/tap-targets.mobile.spec.ts:50-55` records the same
 * doctrine for `/delegations`' pinned horizontal shortfall: recorded in the docs, remedy at
 * the container, not fixed in the branch that found it.
 *
 * WHEN SOMEBODY DOES REPAIR IT, the remedy goes at the container INSIDE THE PAGE FILE — the
 * ruling `docs/design/pwa.md:619` records for exactly this case — and never in `TopBar.tsx`.
 * Reaching into `TopBar.tsx` is also what would drag `crawl.spec.ts` and `crawl-roles.spec.ts`
 * into this task's E2E scope; keeping the diff out of it is why they are not in it.
 *
 * ─── IT RUNS BOTH LOCALES, AND FR-CA IS THE HALF THAT MATTERS HERE ──────────────────────
 *
 * `e2e/crawl-mobile.spec.ts:274` is `const LOCALE = 'en';` and `e2e/support/routes.ts:14-18`
 * records that hoisting it was deliberately refused, so for any route whose phone risk is
 * LABEL LENGTH the crawl provides no French coverage at all and a flow spec is the only place
 * it can exist. Both of this route's risks are label length: the three published controls
 * share one pool with the title, and "Nouveau rapport" / "Prendre une photo" / "Choisir un
 * fichier" are materially longer than their English counterparts. An en-only run passes over
 * exactly the screen the `limited` ruling is about.
 *
 * Every string is read out of the next-intl catalogs rather than pinned, for the reason
 * `e2e/support/catalog.ts:76-86` records: hardcoded French has to be precomposed NFC to match
 * what the DOM renders, and a decomposed `e` + combining acute looks identical in a source
 * file and never matches.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * At 360, 390 and 412, in EN and in FR-CA, with a coarse primary pointer proven before
 * anything is tapped, signed in as `qa.employee` (seven seeded reports,
 * `seed-data/qa-activity.json` → `expected.qaEmployee.reportCount: 7`):
 *
 *   · the page renders itself and not the desktop-only notice;
 *   · the CARD tree mounted — not the desktop grid — and the tRPC response landed;
 *   · nothing paints past the right edge of the viewport unclipped, and no card field paints
 *     outside its own card;
 *   · the compact chrome row holds exactly the two sheet triggers, both at the 44px tier;
 *   · the FILTER SHEET narrows the list from a phone: `Status equals Draft` is added through
 *     the sheet's own form, and afterwards EVERY card on screen badges Draft and the seeded
 *     draft is one of them;
 *   · the SORT SHEET offers this route's two sortable fields (Report, Status) — the contrast
 *     with `/expenses/approvals`, which offers none and says so;
 *   · a TAP on a card's title navigates to that report's own URL;
 *   · a RECEIPT UPLOADED FROM THE TOP BAR creates a report on the SERVER and lands the
 *     reader on it — read out of the database, not inferred from a row appearing.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ BEFORE CITING THIS FILE ─────────────────
 *
 * IT IS NOT THE `ready` EVIDENCE PACK and cannot become it by growing. The top-bar block
 * below is a MEASUREMENT, not a gate; promoting this route needs that defect repaired and
 * the three recorded figures — spill, overlap, title clipping — turned into assertions, which
 * is a product change in a later task and not an edit to this one.
 *
 * IT SAYS NOTHING ABOUT `/expenses/[reportId]`. Step 3 asserts the URL and stops there, and
 * step 4 asserts the URL and the database row and stops there. That workbench is P06 and
 * unassessed; after P05 it resolves `limited` BY INHERITANCE from the `/expenses` registry
 * row (`mobileReadiness.ts:494`, longest prefix on a segment boundary), which is the same
 * disposition it resolves to today with no key at all. Asserting anything about its layout
 * from here would be P05 claiming P06's ruling.
 *
 * IT DOES NOT MEASURE TAP TARGETS. The 44px arithmetic for the card kebab, the two sheet
 * triggers and the three published controls belongs to `e2e/tap-targets.mobile.spec.ts`,
 * which takes it off the rendered `::after` — and where the SKIP hazard lives: a control with
 * no pseudo-element reports `floored.vertical === false` and leaves the floor lane rather
 * than failing it. Nothing here reads a hit box. The column-chooser trigger
 * (`TableSettingsButton.tsx:61`, 40px with no slop class) is a separately parked finding and
 * is deliberately untouched by this file.
 *
 * IT DOES NOT ASSERT A ROW COUNT, EVER. `e2e/expense-lifecycle.spec.ts` creates reports as
 * `qa.employee` and never deletes them, so a fixed count is an assertion about what else has
 * run today — the lesson `e2e/dashboard.spec.ts` records. The filter assertion is written as
 * "every card on screen is a draft" for the same reason: the list paginates, so an absence
 * assertion about a report near the tail would be satisfied by pagination rather than by the
 * filter.
 */

/**
 * Both locales, always. `E2E_LOCALE` narrows it so one can be run on its own — the same knob,
 * spelled the same way, as `e2e/delegations.mobile.spec.ts`, `e2e/topbar-overlap.spec.ts`,
 * `e2e/combobox-popup-width.spec.ts` and `e2e/crawl-roles.spec.ts`.
 */
type Locale = 'en' | 'fr-CA';
// VeloExpense: EN only — VeloExpense offers no French (`i18n/request.ts`). See the header.
const LOCALES: Locale[] = ['en'];

/**
 * Longer than the 45s default, and matching `e2e/datatable-mobile.spec.ts`.
 *
 * Step 4 is the expensive one: `expenses.startFromReceipts`, then a presign, then a real PUT
 * into MinIO, then `receipts.create`, then `startExtraction`, then a client-side navigation —
 * all on one `next dev` server shared by three phone projects running concurrently.
 */
test.describe.configure({ timeout: 180_000 });

/**
 * THERE IS DELIBERATELY NO `TOLERANCE` CONSTANT IN THIS FILE, and its absence is the design.
 *
 * `e2e/delegations.mobile.spec.ts` and `e2e/topbar-overlap.spec.ts` both carry one, because
 * both COMPARE a top-bar overlap against a 1px sub-pixel allowance. This file compares
 * nothing: the overlap, the spill and the title clipping are recorded, and a threshold with
 * no comparison behind it is a claim the file is not making. If a later task repairs the top
 * bar and turns `recordTopBar` into a gate, that is when the constant comes back.
 */

/**
 * The copy, read per locale off the catalogs.
 *
 * NOT added to `e2e/support/catalog.ts`, which exports accessors for `common`, `nav` and
 * `delegations` only. Widening it is a real follow-up and it is parked as one; doing it
 * inside a page task is the risk `e2e/delegations.mobile.spec.ts` already declined when it
 * copied `extent` out of `topbar-overlap.spec.ts` rather than promoting it — "extending
 * `e2e/support/` for thirty lines during a page task is the wrong risk". `navCatalog` IS
 * imported, because the accessor this route's title needs already exists there.
 *
 * `tsconfig.e2e.json` sets neither `paths` nor `resolveJsonModule`, hence `readFileSync` +
 * `JSON.parse`, exactly as `e2e/support/catalog.ts` does. Paths are repo-relative because
 * Playwright runs from the repo root.
 */
function text(locale: string, namespace: string, path: string): string {
  const root = JSON.parse(
    readFileSync(`packages/i18n/src/catalogs/${locale}/${namespace}.json`, 'utf8'),
  ) as Record<string, unknown>;
  let node: unknown = root;
  for (const key of path.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (typeof node !== 'string') {
    throw new Error(`${namespace}.${path} is missing from the ${locale} catalog`);
  }
  return node;
}

/** Everything this file asserts on, per locale. A renamed key throws with its name. */
function copyFor(locale: Locale) {
  return {
    /** The TopBar `h1` for `/expenses` — `ROUTE_TITLE_KEYS['/expenses']` is `expenseReports`. */
    title: navCatalog(locale).items.expenseReports,
    /** The three controls this page publishes at a COARSE pointer. */
    published: {
      takePhoto: text(locale, 'expenses', 'capture.takePhoto'),
      chooseFile: text(locale, 'expenses', 'capture.chooseFile'),
      newReport: text(locale, 'expenses', 'list.newReport'),
    },
    /** The title `expenses.startFromReceipts` gives a report created from an upload. */
    untitledReport: text(locale, 'expenses', 'list.untitledReport'),
    status: {
      draft: text(locale, 'expenses', 'status.draft'),
    },
    columns: {
      report: text(locale, 'expenses', 'columns.report'),
      status: text(locale, 'expenses', 'columns.status'),
      total: text(locale, 'expenses', 'columns.total'),
      updated: text(locale, 'expenses', 'columns.updated'),
    },
    /** The compact chrome, from the already-bilingual `table.*` namespace. */
    sheet: {
      filtersTrigger: text(locale, 'table', 'mobile.filtersTrigger'),
      filtersTitle: text(locale, 'table', 'mobile.filtersTitle'),
      sortTrigger: text(locale, 'table', 'mobile.sortTrigger'),
      sortTitle: text(locale, 'table', 'mobile.sortTitle'),
      sortField: text(locale, 'table', 'mobile.sortField'),
      done: text(locale, 'table', 'mobile.done'),
    },
    /** `AddFilterPill`'s form, which is how a filter is added from a phone. */
    filters: {
      addFilter: text(locale, 'table', 'filters.addFilter'),
      field: text(locale, 'table', 'filters.field'),
      operator: text(locale, 'table', 'filters.operator'),
      value: text(locale, 'table', 'filters.value'),
      add: text(locale, 'table', 'filters.add'),
    },
  };
}

/**
 * The seeded draft this file finds, verbatim from
 * `packages/db/prisma/seed-data/qa-activity.json` (`$.expenseReports[1].title`).
 *
 * THE DASH IS U+2014 EM DASH with a space on each side, which is what the fixture carries and
 * what the DOM renders. It is the same character in both locales — the title is data, not
 * copy, so it is pinned here rather than read from a catalog.
 */
// VeloExpense: built per worker by `seedEmployeeActivity` (see the `beforeAll` below), with
// ExpenseOS's seeded title as its prefix and a unique tag after it.
let SEEDED_DRAFT_TITLE = '';

/** Lazily, through `e2e/support/test-db.ts`, so a missing `DATABASE_URL` in the PLAYWRIGHT
 *  process fails with the fix in the message rather than pointing at the server. */
const testDb = () => sharedTestDb('expenses.mobile');

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Geometry
 *
 * COPIED from `e2e/datatable-mobile.spec.ts` rather than imported, and the reason is the one
 * `e2e/delegations.mobile.spec.ts` states about `topbar-overlap.spec.ts`: that file declares
 * its own `test()` calls, so importing from it would run its whole suite a second time inside
 * this one. Promoting the pair into `e2e/support/` is the right long-term shape and is a
 * different task's diff.
 *
 * What is NOT copied is the resizing: `datatable-mobile.spec.ts` is chromium-only and calls
 * `setViewportSize` itself (`:30-35` argues for exactly that), so it is not in
 * `npm run test:e2e:mobile` at all. This file runs in the three real phone projects, under
 * `isMobile` emulation, which is where `document.documentElement.clientWidth` can actually
 * disagree with the viewport.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every node painted past the viewport's right edge that nothing is clipping.
 *
 * A wide node is not automatically a defect — a table inside a horizontal scroller is
 * supposed to be wider than the screen. What must never happen is a wide node with nothing
 * between it and the document, because that is the one that drags the whole page sideways.
 * `auto`/`scroll` clip and offer a scrollbar; `hidden`/`clip` clip without one. All four end
 * the search.
 */
async function overflowingNodes(page: Page) {
  return page.evaluate(() => {
    const out: { tag: string; cls: string; right: number; text: string }[] = [];
    const limit = window.innerWidth + 1;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= limit) continue;
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').slice(0, 80),
        right: Math.round(rect.right),
        text: (el.innerText ?? '').replace(/\s+/g, ' ').slice(0, 60),
      });
    }
    return out;
  });
}

/** The page does not scroll sideways, and nothing escapes unclipped. */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    doc.scrollWidth,
    `${where}: the document scrolls sideways (${doc.scrollWidth} > ${doc.innerWidth})`,
  ).toBeLessThanOrEqual(doc.innerWidth + 1);

  const spills = await overflowingNodes(page);
  expect(
    spills,
    `${where}: painted past the viewport with nothing clipping it:\n${spills
      .map((s) => `  ${s.tag}.${s.cls} right=${s.right}px "${s.text}"`)
      .join('\n')}`,
  ).toEqual([]);
}

/**
 * No card field paints outside its own card, and the sweep actually swept something.
 *
 * Invisible to the document-level check whenever the card itself clips, which is the whole
 * reason it is a second measurement rather than a stronger first one.
 */
async function expectNoCardSlotSpill(page: Page, where: string): Promise<void> {
  const painted = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('[data-dt-card-slot]')).filter(
        (el) => el.getBoundingClientRect().width > 0,
      ).length,
  );
  expect(
    painted,
    `${where}: no card slots were measured, so the sweep asserts nothing`,
  ).toBeGreaterThan(0);

  const slotSpills = await page.evaluate(() => {
    const bad: { column: string; spill: number; text: string }[] = [];
    for (const slot of Array.from(document.querySelectorAll<HTMLElement>('[data-dt-card-slot]'))) {
      const card = slot.closest<HTMLElement>('[id^="data-card-"]');
      if (!card) continue;
      const spill = Math.round(
        slot.getBoundingClientRect().right - card.getBoundingClientRect().right,
      );
      if (spill > 2) {
        bad.push({
          column: slot.dataset.dtColumnId ?? '(unknown)',
          spill,
          text: (slot.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40),
        });
      }
    }
    return bad;
  });
  expect(
    slotSpills,
    `${where}: card content painting outside its own card:\n${slotSpills
      .map((s) => `  +${s.spill}px in "${s.column}" — "${s.text}"`)
      .join('\n')}`,
  ).toEqual([]);
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * The top bar — MEASURED, NOT ENFORCED
 * ──────────────────────────────────────────────────────────────────────────────────────── */

interface TopBarGeometry {
  /** How many interactive controls the page published into `[data-chrome="page"]`. */
  publishedControls: number;
  /** Their accessible names, as the DOM reports them, in document order. */
  publishedNames: string[];
  /** How far the published group's painted extent reaches outside its own zone box. */
  spilledOutOfZone: number;
  /** The route title's rendered width, and whether its own text is clipped by `truncate`. */
  title: { text: string; width: number; scrollWidth: number; clientWidth: number } | null;
  /** Horizontal overlap between the published group's extent and the title's box. */
  overlapWithTitle: number;
  headerContentRight: number;
  zoneRight: { left: number; right: number } | null;
}

/**
 * Read the top bar's geometry: what this page published, and the route title it is sharing a
 * row with.
 *
 * `extent` is copied from `e2e/topbar-overlap.spec.ts` by way of
 * `e2e/delegations.mobile.spec.ts`, and for the policy reason both of them state. What
 * "painted over the title" means mechanically, and why an OVERLAP is the right thing to
 * measure rather than a width: NOTHING IN `TopBar.tsx` CLIPS, on purpose. The header is a
 * three-track grid whose right track is `minmax(0, auto)`, and `[data-chrome="page"]` carries
 * `min-w-0` — so the zone shrinks happily while the `whitespace-nowrap` button inside it
 * cannot, and with `justify-end` the group overflows its own box LEFTWARD, across the title.
 * The title's `truncate` then makes the damage look like a shortened title rather than like a
 * collision, which is why the clipping figure is recorded alongside the overlap: they are two
 * views of one defect and a test that watched only one of them would miss half the cases.
 */
async function measureTopBar(page: Page): Promise<TopBarGeometry> {
  const measured = await page.evaluate(() => {
    const rendered = (el: Element) => el.getClientRects().length > 0;
    const inFlow = (el: Element) => {
      const p = getComputedStyle(el).position;
      return p !== 'absolute' && p !== 'fixed';
    };

    /**
     * Where an element's content is actually PAINTED: its own border box, unioned with its
     * own text runs and its in-flow descendants' extents. Descent stops at anything that
     * clips — such a box IS its own boundary, and `Range.getClientRects()` would otherwise
     * report text a `truncate` span hides.
     */
    const extent = (el: Element): { left: number; right: number } => {
      const rect = el.getBoundingClientRect();
      let left = rect.left;
      let right = rect.right;
      if (getComputedStyle(el).overflowX !== 'visible') return { left, right };
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        if (!(node.textContent ?? '').trim()) continue;
        const range = document.createRange();
        range.selectNode(node);
        for (const r of Array.from(range.getClientRects())) {
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        }
      }
      for (const child of Array.from(el.children)) {
        if (!inFlow(child) || !rendered(child)) continue;
        const e = extent(child);
        left = Math.min(left, e.left);
        right = Math.max(right, e.right);
      }
      return { left, right };
    };
    const round = (n: number) => Math.round(n * 10) / 10;

    const zone = document.querySelector('[data-zone="right"]');
    const leftZone = document.querySelector('[data-zone="left"]');
    const header = zone?.parentElement ?? null;
    if (!zone || !leftZone || !header) return null;

    const headerStyle = getComputedStyle(header);
    const headerRect = header.getBoundingClientRect();

    /** `:scope >`, not a document-wide lookup: a seam added to another zone later must not
     *  have this file measuring the title while reporting the shell's own controls. */
    const pageBox = zone.querySelector(':scope > [data-chrome="page"]');

    /**
     * What counts as an interactive control. The ration is on CONTROLS, not on elements — a
     * wrapper `div` and a label `span` are not over budget, a second button is. Note that the
     * two receipt controls are `<label>`s wrapping a `hidden` `<input type="file">`, so it is
     * the LABEL that is the control a finger operates; the hidden inputs are not rendered and
     * are filtered out by `rendered()`.
     */
    const CLICKABLE =
      'button, a[href], input, select, textarea, label, [role="button"], [role="link"], ' +
      '[tabindex]:not([tabindex="-1"])';
    const controls = pageBox
      ? Array.from(pageBox.querySelectorAll(CLICKABLE)).filter(rendered)
      : [];

    const titleEl = leftZone.querySelector('h1');
    const title = titleEl
      ? {
          text: (titleEl.textContent ?? '').trim(),
          width: round(titleEl.getBoundingClientRect().width),
          scrollWidth: titleEl.scrollWidth,
          clientWidth: titleEl.clientWidth,
        }
      : null;

    let spilledOutOfZone = 0;
    let overlapWithTitle = 0;
    if (pageBox) {
      const zoneRect = pageBox.getBoundingClientRect();
      const e = extent(pageBox);
      spilledOutOfZone = round(
        Math.max(0, zoneRect.left - e.left) + Math.max(0, e.right - zoneRect.right),
      );
      if (titleEl) {
        const t = titleEl.getBoundingClientRect();
        // Horizontal only: the two boxes share the header's single row by construction, so a
        // vertical test would always be true and would say nothing.
        overlapWithTitle = round(Math.min(t.right, e.right) - Math.max(t.left, e.left));
      }
    }

    return {
      publishedControls: controls.length,
      /**
       * `textContent` and not `innerText`: both receipt labels carry an `sr-only` span, i.e.
       * clipped to 1px rather than `display: none`, and `innerText` is defined in terms of
       * RENDERING. `textContent` is a fact about the DOM. Reported rather than claimed either
       * way — the accessible names are asserted HARD below by `getByRole`, using Playwright's
       * own name computation.
       */
      publishedNames: controls.map((c) =>
        (c.getAttribute('aria-label') ?? c.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
      spilledOutOfZone,
      title,
      overlapWithTitle,
      headerContentRight: round(headerRect.right - Number.parseFloat(headerStyle.paddingRight)),
      zoneRight: pageBox
        ? {
            left: round(pageBox.getBoundingClientRect().left),
            right: round(pageBox.getBoundingClientRect().right),
          }
        : null,
    };
  });

  expect(measured, 'the top bar had no [data-zone] children to measure').not.toBeNull();
  return measured as TopBarGeometry;
}

/** Rendered as a block into the annotation, the attachment and the run log. */
function describeTopBar(m: TopBarGeometry): string {
  return [
    `    published controls   ${m.publishedControls}  (${m.publishedNames.join(' | ') || 'none'})`,
    `    page zone            ${m.zoneRight ? `[${m.zoneRight.left}, ${m.zoneRight.right}]` : 'absent'}`,
    `    spilled out of zone  ${m.spilledOutOfZone}px`,
    `    route title          ${
      m.title
        ? `"${m.title.text}" width ${m.title.width}  scroll ${m.title.scrollWidth} / client ${m.title.clientWidth}`
        : 'absent'
    }`,
    `    clipped by           ${(m.title?.scrollWidth ?? 0) - (m.title?.clientWidth ?? 0)}px`,
    `    overlap with title   ${m.overlapWithTitle}px`,
    `    header content ends  ${m.headerContentRight}`,
  ].join('\n');
}

/**
 * RECORD the top bar, and assert only what `limited` actually owes.
 *
 * ─── WHAT IS ASSERTED ───────────────────────────────────────────────────────────────────
 *
 *   · the three controls are PRESENT and carry their accessible names. This is the
 *     anti-vacuity guard for the whole block: `canCreate` is `expense.report.createOwn`, and
 *     without it the slot publishes `null`, every number below reads 0, and the record would
 *     be a clean sheet for a page that never rendered the thing being measured. It is also a
 *     real claim of its own — the coarse-pointer pair is icon-only with an `sr-only` label,
 *     which is exactly the arrangement that regresses into an unlabelled icon the day
 *     somebody swaps `sr-only` for `hidden`, and looks identical on screen when they do.
 *   · the route title RENDERS and is the one this route's `ROUTE_TITLE_KEYS` entry names.
 *
 * ─── WHAT IS ONLY RECORDED, AND WHY THAT IS THE RIGHT ANSWER HERE ──────────────────────
 *
 * The spill, the overlap and the title clipping. At `limited` a rough edge the build finds is
 * RECORDED, NOT A PHASE BLOCKER, and this one is named in the plan's triage as measured and
 * deliberately unrepaired. Asserting it would make every run of this file red about a defect
 * the branch is not allowed to fix, which is the fastest way to get a spec ignored. Three
 * channels, so the number survives however the run is read: an ANNOTATION (the HTML report's
 * test detail), an ATTACHMENT (machine-readable, for a later task that wants a baseline), and
 * a CONSOLE line (the terminal, where a `--reporter=list` run ends).
 */
async function recordTopBar(
  page: Page,
  testInfo: TestInfo,
  locale: Locale,
  copy: ReturnType<typeof copyFor>,
): Promise<void> {
  const published = page.locator('[data-zone="right"] > [data-chrome="page"]');
  await expect(
    published,
    'the page published nothing into the top bar. Either this actor does not hold ' +
      '`expense.report.createOwn` (`ExpenseReportsList.tsx:397-407` gates all three controls ' +
      'on `canCreate`), or the slot effect stopped running — and every figure recorded below ' +
      'would then be a clean sheet for a page that never rendered what is being measured.',
  ).toBeVisible({ timeout: 30_000 });

  /**
   * TWO of the three are `<label>`s, not buttons, and that is why this is a text assertion
   * rather than a `getByRole('button')` one.
   *
   * `ReceiptFileInput` renders each control as a `<label>` wrapping a `hidden`
   * `<input type="file">` — the label is what a finger operates and a bare `<label>` carries
   * no implicit ARIA role, so `getByRole('button', …)` would never match either of them and a
   * count assertion built on it would fail for the wrong reason. Their name lives in an
   * `sr-only` span, which `getByText` finds and `hidden` would not — which is exactly the
   * regression this line is here to catch.
   */
  for (const name of [copy.published.takePhoto, copy.published.chooseFile]) {
    /**
     * `toBeVisible`, not `toHaveCount` — and the choice is what makes this assertion bite.
     *
     * A locator is not visibility-filtered, so a `display: none` label would still be FOUND by
     * text and a count assertion would pass over the exact regression this line exists for.
     * Playwright's visibility test is a non-empty box plus `visibility !== hidden`, and
     * `sr-only` is a 1x1 clipped box — visible by that definition, and `hidden` is not. So
     * this passes today and fails the day somebody swaps the one for the other, which looks
     * identical on screen. `.first()` because the `<label>`'s own text content equals its
     * `sr-only` child's, and which of the two a text engine returns is not worth depending on.
     */
    await expect(
      published.getByText(name, { exact: true }).first(),
      `the top bar publishes no receipt control named "${name}" in ${locale}. At a coarse ` +
        'pointer both are icon-only and carry their name in an `sr-only` span; swapping that ' +
        'for `hidden` drops them out of the accessibility tree and looks identical on screen.',
    ).toBeVisible({ timeout: 20_000 });
  }
  await expect(
    published.getByRole('button', { name: copy.published.newReport, exact: true }),
    `the top bar publishes no "${copy.published.newReport}" button in ${locale}. ` +
      '`e2e/expense-lifecycle.spec.ts:55` matches this control by that accessible name at a ' +
      'desktop width — if it moved, that spec moved with it.',
  ).toHaveCount(1);

  const m = await measureTopBar(page);
  const block = describeTopBar(m);
  const note =
    `${locale} @ ${testInfo.project.name} — /expenses top bar, RECORDED not asserted ` +
    `(this route is ruled \`limited\`; the repair is out of scope by construction and the ` +
    `remedy, when it comes, goes at the container inside the page file — never TopBar.tsx):\n` +
    `${block}`;

  testInfo.annotations.push({ type: 'pwa:top-bar (recorded, not asserted)', description: note });
  await testInfo.attach(`top-bar-${locale}-${testInfo.project.name}.json`, {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ locale, project: testInfo.project.name, ...m }, null, 2)),
  });
  console.log(`[expenses.mobile] ${note}`);

  // The one title claim that IS owed: it rendered, and it is this route's own title. A left
  // track squeezed to nothing is recorded above as `clipped by`, not failed here.
  expect(m.title?.text, `the top bar rendered no route title at all\n${block}`).toBe(copy.title);
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * The page
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Sign in, open `/expenses` at a phone width, and get to the point where measuring means
 * something.
 *
 * The offline check is not defensive noise: the service worker's fallback answers 200 under
 * whatever URL failed and carries no top bar and no list, so without it the next assertion
 * fails with a message about a missing control instead of about the network.
 */
async function openExpenses(page: Page, locale: Locale, testInfo: TestInfo): Promise<string> {
  await signIn(page, 'employee');
  // VeloExpense: no locale segment.
  void locale;
  const route = '/expenses';
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${route} did not answer 200`).toBe(200);
  expect(
    await page.locator('[data-testid="offline-page"]').count(),
    `the service worker served the offline fallback in place of ${route}`,
  ).toBe(0);

  // Under a fine pointer this would be a desktop test running in a small window: the coarse
  // branch of `ReceiptFileInput` would not render at all, so the top bar would publish TWO
  // controls and the record below would describe a screen nobody has.
  await assertCoarsePointer(page);

  /**
   * A `limited` route that suppressed its own page.
   *
   * `DesktopOnlyNotice` renders for `disposition === 'desktop'`; `limited` and `ready` both
   * render the page untouched. So a registry row typed `desktop` by mistake, or a glob ruling
   * widened across this route, replaces this page with a notice at every phone width — and
   * `mobileReadiness.test.ts` would stay GREEN, because the markdown and the registry would
   * agree with each other about the wrong answer.
   */
  expect(
    await page.locator('[data-testid="desktop-only-notice"]:visible').count(),
    `${route} rendered the desktop-only notice at ${testInfo.project.name}. This route is ` +
      'ruled `limited`, which suppresses nothing — so either the row was changed to ' +
      '`desktop`, or a glob ruling now covers it. The registry/markdown parity check cannot ' +
      'see this: both sides would agree about the wrong disposition.',
  ).toBe(0);

  /**
   * Poll for the CARDS, not for the shell.
   *
   * `#main-content` is the app shell's own landmark and is painted immediately;
   * `data-card-<id>` is minted per row by `DataTableCards`, so its presence is proof that the
   * tRPC response landed AND that the compact tree — not the desktop grid — is what mounted
   * AND that hydration has happened at all, which the compact chrome row depends on
   * (`useIsCompact`'s SSR snapshot is `false`, so that row is absent from the server HTML).
   * Exactly the gate `e2e/datatable-mobile.spec.ts:215-223` argues for.
   */
  const cards = page.locator('#main-content [id^="data-card-"]');
  await expect
    .poll(() => cards.count(), {
      timeout: 60_000,
      message:
        'no cards mounted on /expenses. Either the tRPC list never landed, or the DESKTOP ' +
        'grid mounted instead — which is what a removed `mobile` config on ' +
        // VeloExpense: the employee's rows are `seedEmployeeActivity`'s.
        'ExpenseReportsList.tsx looks like from here. The employee has at least the two ' +
        'reports `seedEmployeeActivity` built in `beforeAll`.',
    })
    .toBeGreaterThan(0);

  // Settle before measuring: the list arrives over tRPC and the header lays out again when
  // `canCreate` lands, so reading a box mid-flight pairs a rectangle from before the reflow
  // with one from after. Animations off for the same reason.
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.waitForLoadState('networkidle');

  return route;
}

/** The compact chrome row, and exactly what it is allowed to hold. */
async function assertCompactChrome(page: Page, copy: ReturnType<typeof copyFor>): Promise<void> {
  const controls = page.locator('#expenses-mobile-controls');
  await expect(
    controls,
    'the compact chrome row is not on screen. It is JS-gated on `useIsCompact()` ' +
      '(`max-width: 767.98px`) whose SSR snapshot is `false`, so it exists only after ' +
      'hydration — and it is `md:hidden`, so a project whose emulation did not apply would ' +
      'also land here.',
  ).toBeVisible({ timeout: 30_000 });

  await expect(
    controls.getByRole('button'),
    'the compact chrome row holds something other than the two sheet triggers',
  ).toHaveCount(2);

  // The trigger names carry a count/field suffix once either sheet has state, so both are
  // matched by prefix rather than exactly. `/expenses` opens with NO filter clause, so the
  // filter trigger starts bare — unlike `/expenses/approvals`, which opens on `Filters · 1`.
  await expect(controls.getByRole('button').first()).toContainText(copy.sheet.filtersTrigger);
  await expect(controls.getByRole('button').last()).toContainText(copy.sheet.sortTrigger);
}

/**
 * The sheet a trigger inside the compact row opens, addressed by its own title.
 *
 * `.first()` for the reason `e2e/expense-lifecycle.spec.ts:57-58` records: a closed drawer
 * elsewhere in the tree also matches `dialog`, and a strict locator then waits on something
 * that will never become visible. The titles are distinct per sheet ("Filters" vs "Sort by"),
 * so the filter chosen here is what identifies the sheet; `.first()` only spares the run a
 * strict-mode violation about a sibling that is not open.
 */
function sheetTitled(page: Page, title: string) {
  return page.getByRole('dialog').filter({ hasText: title }).first();
}

for (const locale of LOCALES) {
  test.describe(`/expenses on a phone — ${locale}`, () => {
    /** Torn down even when the test failed, and nulled so a failure in the setup itself
     *  cannot throw on top of the real error. */
    let createdReportId: string | null = null;

    // VeloExpense: the draft (and a queued report) ExpenseOS reads from `qa-activity.json`.
    test.beforeAll(async ({ browser }) => {
      SEEDED_DRAFT_TITLE = `QA — Draft ready to submit ${reportTag('expenses')}`;
      await seedEmployeeActivity(browser, {
        draftTitle: SEEDED_DRAFT_TITLE,
        queuedTitle: reportTag('expenses queue'),
      });
    });

    // VeloExpense: the admin pool `testDb` opens, closed once the file is done.
    test.afterAll(async () => {
      await closeTestDb();
    });

    test.beforeEach(async ({ page }, testInfo) => {
      // Fails in ~0ms and names the project, rather than after a sign-in and a navigation.
      // `page` is destructured only so `beforeEach` receives `testInfo` in the second
      // position.
      void page;
      assertProject(testInfo, PHONE_PROJECTS);
    });

    /**
     * Take the uploaded report back out.
     *
     * By id, so it can never reach another cell's concurrent fixture — three phone projects
     * and two locales run this file six times at once against one `expenseos_e2e`, and
     * `test.describe.configure({ mode: 'serial' })` would order the pair inside a project and
     * say nothing about the other two.
     *
     * Best-effort and never throwing, for the reason `e2e/support/authPageFixtures.ts` gives:
     * a cleanup error that replaced the test's own failure would hide what actually went
     * wrong. A leaked row is greppable — it is the only report this account owns titled with
     * the `list.untitledReport` string.
     */
    test.afterEach(async () => {
      const id = createdReportId;
      createdReportId = null;
      if (!id) return;
      try {
        const db = await testDb();
        // VeloExpense: SQL on the admin pool; expenses and receipts cascade.
        await db.query('DELETE FROM expense_report WHERE id = $1', [id]);
      } catch (e) {
        console.warn(`[expenses.mobile] could not remove the uploaded report ${id}:`, e);
      }
    });

    test('the card list is legible, the filter sheet narrows it, and a report opens', async ({
      page,
    }, testInfo) => {
      const copy = copyFor(locale);
      const route = await openExpenses(page, locale, testInfo);

      // ── The top bar: measured, recorded, not enforced. See `recordTopBar`. ────────────
      await recordTopBar(page, testInfo, locale, copy);

      // ── The card tree fits ───────────────────────────────────────────────────────────
      await expectNoSidewaysScroll(page, `${route} at ${testInfo.project.name}`);
      await expectNoCardSlotSpill(page, `${route} at ${testInfo.project.name}`);

      /**
       * The card anatomy this route committed to: title + badge + two fields, no subtitle.
       *
       * Asserted off the `<dt>` terms, which are the column LABELS the card renderer prints
       * beside each value — so this is simultaneously a check that the field list is
       * `['total','updated']` and that both labels came through the catalog in this locale. A
       * card that lost a field would still pass every geometry sweep above.
       */
      const firstCard = page.locator('#main-content [id^="data-card-"]').first();
      await expect(firstCard.locator('[data-dt-card-slot="title"]')).toHaveCount(1);
      await expect(firstCard.locator('[data-dt-card-slot="badge"]')).toHaveCount(1);
      await expect(
        firstCard.locator('dt'),
        `the card's field terms are not [${copy.columns.total}, ${copy.columns.updated}] in ` +
          `${locale}`,
      ).toHaveText([copy.columns.total, copy.columns.updated]);

      await assertCompactChrome(page, copy);

      /**
       * ── The sort sheet: this route HAS sortable columns, and that contrast is the point ──
       *
       * `report` and `status` both declare `sortable` (`ExpenseReportsList.tsx:457`, `:482`),
       * and `sortSheetOptions` keeps a column only if `resolveSortField` returns non-null —
       * which for a `sortable` column additionally needs at least one of the first 20 rows to
       * yield a comparable value. So with rows on screen the sheet offers exactly two fields.
       * `/expenses/approvals` declares none and renders the honest empty state instead; the
       * two specs assert opposite sides of the same mechanism on purpose.
       *
       * Opened and read, NOT driven. Applying a sort and asserting the resulting order would
       * be an assertion about which reports exist today, and `e2e/expense-lifecycle.spec.ts`
       * leaves rows behind on this very account.
       */
      await page.locator('#expenses-mobile-controls').getByRole('button').last().tap();
      const sortSheet = sheetTitled(page, copy.sheet.sortTitle);
      await expect(sortSheet, 'the sort trigger did not open the sort sheet').toBeVisible({
        timeout: 20_000,
      });
      const sortFields = sortSheet.getByRole('radiogroup', { name: copy.sheet.sortField });
      await expect(
        sortFields.getByRole('radio'),
        "the sort sheet does not offer this route's two sortable fields. `report` and " +
          '`status` declare `sortable`, and `sortSheetOptions` drops a column whose first 20 ' +
          'rows yield no comparable value — so an empty sheet here means either the columns ' +
          'lost `sortable` or the rows lost their `exportValue`.',
      ).toHaveText([copy.columns.report, copy.columns.status]);
      await sortSheet.getByRole('button', { name: copy.sheet.done, exact: true }).tap();
      await expect(sortSheet).toBeHidden({ timeout: 20_000 });

      /**
       * ── Find my report: narrow to drafts through the filter sheet ───────────────────
       *
       * This is the only way to filter this list from a phone. The `FilterPillBar` is
       * `TABLE_ONLY` (`hidden md:block`) and `/expenses` reads NO query parameter for filters
       * — `useDeepLink('report')` is the page's only search-param reader, and it navigates
       * away rather than filtering — so `goto('?status=DRAFT')` would be ignored and the
       * assertion below would be measuring nothing.
       *
       * Driven through `AddFilterPill`'s form, whose three controls are native `<select>`s
       * inside `<label>`s. The popover is PORTALLED (it positions against the viewport, so
       * the horizontally-scrolling bar cannot clip it), which is why the selects are located
       * page-wide and asserted to be singular rather than scoped to the sheet.
       *
       * SUBSTRING, NOT `exact`. The `<label>` WRAPS its `<select>` rather than pairing with
       * it through `for`/`id`, and the label text Playwright matches on then includes the
       * options the select renders — `FilterBlock.tsx:398-417` puts "FIELD" and every option
       * in one element, so the string to match exactly is "FIELDReportStatus", which no
       * catalog key spells. `exact: true` here matched zero elements in BOTH locales and was
       * a defect in this spec, not in the form: the association is real and a screen reader
       * announces it. The singularity that `exact` was reaching for is asserted outright
       * below instead, which is the stronger statement anyway.
       */
      await page.locator('#expenses-mobile-controls').getByRole('button').first().tap();
      const filterSheet = sheetTitled(page, copy.sheet.filtersTitle);
      await expect(filterSheet, 'the filter trigger did not open the filter sheet').toBeVisible({
        timeout: 20_000,
      });

      await filterSheet.getByRole('button', { name: copy.filters.addFilter, exact: true }).tap();

      const fieldSelect = page.getByLabel(copy.filters.field);
      await expect(
        fieldSelect,
        `the add-filter form did not open, or "${copy.filters.field}" is ambiguous on this page`,
      ).toHaveCount(1);
      // By VALUE, which is the `ColumnId`, not the label — the label is what the catalog
      // translates and the value is what the code keys on.
      await fieldSelect.selectOption('status');
      // Already `equals` (`OPS_BY_KIND.enum[0]`, re-applied on every field change). Selected
      // anyway, because `ExpenseReportsList.tsx:580-594` narrows rows for `status equals` and
      // for nothing else, so the operator is load-bearing and stating it documents that.
      await page.getByLabel(copy.filters.operator).selectOption('equals');
      await page.getByLabel(copy.filters.value).selectOption('DRAFT');
      await page.getByRole('button', { name: copy.filters.add, exact: true }).tap();

      // No Apply: `FilterSheet` writes straight through to the host's clause array, so the
      // list has already narrowed behind the sheet. `Done` only closes it.
      await filterSheet.getByRole('button', { name: copy.sheet.done, exact: true }).tap();
      await expect(filterSheet).toBeHidden({ timeout: 20_000 });

      const cards = page.locator('#main-content [id^="data-card-"]');
      const draftCard = cards.filter({
        has: page.locator('[data-dt-card-slot="title"]', { hasText: SEEDED_DRAFT_TITLE }),
      });
      await expect(
        draftCard,
        // VeloExpense: the draft is `seedEmployeeActivity`'s.
        `"${SEEDED_DRAFT_TITLE}" is not in the filtered list. It is the DRAFT ` +
          '`seedEmployeeActivity` built for the employee in `beforeAll`.',
      ).toHaveCount(1, { timeout: 30_000 });

      /**
       * And EVERY card on screen is a draft — the assertion that makes the filter mean
       * something, and the one shape that survives pagination.
       *
       * A "the reimbursed report is gone" assertion would have been satisfied just as well by
       * the list having paginated it off the bottom, and `e2e/expense-lifecycle.spec.ts`
       * leaves reports on this account, so what is above the fold is not fixed.
       *
       * POLLED, because the assertion above does not gate it: the seeded draft is on screen
       * BEFORE the filter is applied as well as after, so `draftCard` going green says nothing
       * about the list having re-rendered yet. A single read here would be a race against the
       * narrowing, and `retries: 0` means losing it once is a red run.
       */
      await expect
        .poll(
          async () =>
            (await cards.locator('[data-dt-card-slot="badge"]').allInnerTexts())
              .map((b) => b.replace(/\s+/g, ' ').trim())
              .filter((b) => b !== copy.status.draft),
          {
            timeout: 30_000,
            message:
              '`status equals DRAFT` left non-draft cards on screen in ' +
              `${locale} — every badge should read "${copy.status.draft}"`,
          },
        )
        .toEqual([]);
      /** Anti-vacuity: the sweep above is satisfied by an empty list too. */
      expect(
        await cards.count(),
        'the filtered list has no cards at all, so the badge sweep asserted nothing',
      ).toBeGreaterThan(0);

      await expectNoSidewaysScroll(page, `${route} filtered at ${testInfo.project.name}`);
      await expectNoCardSlotSpill(page, `${route} filtered at ${testInfo.project.name}`);

      /**
       * ── Open it ─────────────────────────────────────────────────────────────────────
       *
       * The TITLE is the button, not the `<li>`: `DataTableCards` wraps the title slot in a
       * `min-h-11` `<button>` wired to `onRowClick`, and tapping the badge, the subtitle or a
       * field does nothing at all. A spec that tapped the card would be red about its own
       * gesture.
       *
       * THE URL, AND THEN STOP. `/expenses/[reportId]` is P06 and unassessed; after P05 it
       * resolves `limited` by inheritance, which is what it already resolves to today. One
       * word here about how that page lays out would be P05 claiming P06's ruling.
       */
      await draftCard.locator('[data-dt-card-slot="title"]').tap();
      // VeloExpense: no locale segment.
      await page.waitForURL(/\/expenses\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    });

    test('a report starts from a receipt uploaded in the top bar', async ({ page }, testInfo) => {
      const copy = copyFor(locale);
      await openExpenses(page, locale, testInfo);

      /**
       * The LIBRARY control's input, addressed by the absence of `capture`.
       *
       * At a coarse pointer `ReceiptFileInput` renders TWO controls — the camera first, then
       * the picker — and only the camera's input carries `capture="environment"`. Selecting
       * on `:not([capture])` is therefore exact in both pointer worlds, where `.last()` would
       * be an assertion about render order. `count()` is checked first so a page that grew a
       * third file input fails here rather than silently uploading somewhere else.
       *
       * `setInputFiles` on a `hidden` input: the control a finger operates is the `<label>`,
       * and the input is plumbing that is `className="hidden"` by design
       * (`ReceiptFileInput.tsx:269-278` records that the keyboard-reachability this costs is a
       * pre-existing gap on its own ticket). Driving the label would open the OS file picker,
       * which Playwright cannot answer.
       */
      const libraryInput = page.locator('input[type=file]:not([capture])');
      await expect(
        libraryInput,
        'expected exactly one non-camera file input in the top bar. Two would mean a second ' +
          'uploader mounted on this page; zero means `canCreate` is false for this actor.',
      ).toHaveCount(1);

      // The camera control exists too, and only at a coarse pointer — recorded as an
      // assertion because it is the phone-only half of this flow and nothing else covers it.
      await expect(
        page.locator('input[type=file][capture="environment"]'),
        'the camera control did not render at a coarse pointer, so the phone half of ' +
          'receipt-first entry is absent',
      ).toHaveCount(1);

      await libraryInput.setInputFiles(receiptFile());

      /**
       * `startFromReceipts` creates the report and one expense per file, then each file is
       * presigned, PUT into object storage and recorded, and only then does the page navigate.
       * So this wait spans a real upload; it is the reason this describe runs at 180s.
       */
      // VeloExpense: no locale segment.
      await page.waitForURL(/\/expenses\/[0-9a-f-]{36}$/, { timeout: 90_000 });

      const matched = /\/expenses\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname);
      expect(matched, `could not read a report id out of ${page.url()}`).not.toBeNull();
      const reportId = (matched as RegExpExecArray)[1] as string;
      createdReportId = reportId;

      /**
       * WRITTEN ON THE SERVER, and read back rather than looked at.
       *
       * Landing on a URL proves the client routed; it does not prove `expenses.startFromReceipts`
       * reached the database with a report this reader owns. Polled, because the navigation and
       * the write do not wait on each other.
       */
      const db = await testDb();
      // VeloExpense: SQL on the admin pool, and the demo tenant's employee.
      const {
        rows: [row],
      } = await db.query<{ title: string; status: string; email: string }>(
        `SELECT r.title, r.status::text AS status, u.email
           FROM expense_report r JOIN app_user u ON u.id = r.submitter_id
          WHERE r.id = $1`,
        [reportId],
      );
      if (!row) throw new Error(`report ${reportId} is not in the database`);
      expect(row.email, 'the uploaded report was filed against somebody else').toBe(
        'employee@demo.test',
      );
      expect(row.status, 'a report started from receipts begins as a draft').toBe('DRAFT');
      /**
       * The title is the locale's own `list.untitledReport`, passed by the client, so this is
       * also the proof that `/fr-CA` really served French rather than falling back to English
       * — the same second liveness check `e2e/delegations.mobile.spec.ts` takes off a status
       * badge.
       */
      expect(row.title, `the uploaded report was not titled in ${locale}`).toBe(
        copy.untitledReport,
      );

      await expect
        // VeloExpense: SQL on the admin pool.
        .poll(
          async () =>
            Number(
              (
                await db.query<{ n: string }>(
                  `SELECT count(*) AS n FROM receipt rc JOIN expense e ON e.id = rc.expense_id
                    WHERE e.report_id = $1`,
                  [reportId],
                )
              ).rows[0]?.n ?? 0,
            ),
          {
          timeout: 30_000,
          message:
            'the report was created but no receipt landed against its expense — the presign, ' +
            'the PUT into object storage, or `receipts.create` failed. Check that MinIO is up ' +
            '(`npm run dev:up`); the page swallows this into an inline alert.',
        })
        .toBe(1);
    });
  });
}

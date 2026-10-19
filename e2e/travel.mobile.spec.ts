import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { ACTORS, signIn, stateFileFor } from './support/actors';
import { PHONE_PROJECTS } from './support/phone-projects';
import { assertCoarsePointer, assertProject } from './support/tap-targets';
import { closeTestDb, testDb as sharedTestDb } from './support/test-db';
import { trpcOk } from './support/trpc';

/**
 * `/travel` on a phone: read the three sections, open a decision, create a request, and
 * follow a deep link — with a DRAWER OPEN on two of the three, because the drawer is the
 * only place this route's defect ever lived.
 *
 * ─── THIS ROUTE IS RULED `limited`, AND NOT BECAUSE A DEFECT WAS LEFT STANDING ──────────
 *
 * `docs/design/pwa.md` and `mobileReadiness.ts` both rule it `limited`, and the reason is
 * unusual enough to read before reading any assertion here: **no clause of the `ready` bar
 * has been EVALUATED on this branch.** Every defect P09 found lands in the same diff as this
 * file. What does not exist is a run.
 *
 *   · The mobile crawl is structurally blind to both primary flows. `DrawerContent` mounts
 *     through `DrawerPortal` (`packages/design-system/src/components/ui/drawer.tsx:88`,
 *     `:266`), so the panel is outside `main#main-content` and `crawl-mobile.spec.ts`'s only
 *     overflow gate — `mainScrollWidth - mainClientWidth` — measured `/travel` at 0px before
 *     this branch and measures 0px after it.
 *   · This file and the two `/travel` lanes in `e2e/tap-targets.mobile.spec.ts` are the other
 *     two clauses, they are authored on this branch, and NEITHER HAS RUN. Playwright browsers
 *     do not install on the authoring machine and `ci.yml` runs no E2E at all.
 *
 * So the row carries a written, countable promotion trigger instead of a revisit, and it is
 * in that row's Notes cell. Do not promote `/travel` to `ready` by citing this file's
 * existence — cite a nightly run id.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * At 360, 390 and 412, in EN and in FR-CA, with a coarse primary pointer proven before
 * anything is tapped, signed in as the seeded `manager` (who is `employee`'s manager, which
 * is what routes a trip to them — `seedTravelApprovalWorkflow` in
 * `packages/db/prisma/seed.ts` publishes `travel-default` with a single
 * `approver: { kind: 'manager' }` node):
 *
 *   · the page renders itself and not the desktop-only notice;
 *   · all three section headings render and none is clipped inside `main#main-content` —
 *     this is where FR-CA's "En attente de votre approbation" (31 chars against EN's 22) and
 *     "Votre équipe et décisions passées" (33 against 26) land;
 *   · a seeded row is listed in EACH of the three sections, states its destination, its dates
 *     and its status, names the traveller where the section is about somebody else's trip,
 *     and nothing on the page escapes `main#main-content` horizontally WITH ALL THREE
 *     SECTIONS POPULATED — which the crawl cannot claim, because the crawl seeds nothing and
 *     measures whatever the shared database happens to hold that day;
 *   · tapping the approvals row opens `TravelRequestDrawer`, it offers a decision, and THE
 *     OPENED PANEL IS CONTAINED BY THE LAYOUT VIEWPORT;
 *   · the top bar publishes exactly one interactive control, it keeps its full accessible
 *     name, it is painted inside its own `[data-chrome="page"]` box and it does not overlap
 *     the route title — the +8-character FR-CA label lands here;
 *   · a tap on it opens `NewTravelRequestDrawer`, THAT PANEL IS ALSO CONTAINED, the flow
 *     completes from a phone, and the request EXISTS IN THE DATABASE with the purpose,
 *     destination and dates the form was driven with — read from the server rather than
 *     inferred from a row appearing;
 *   · a deep link to a request opens that request's drawer at this width and clears the
 *     params from the address bar.
 *
 * THE TWO CONTAINMENT ASSERTIONS ARE THE ONLY THING IN P09 THAT IS RED ON `origin/main`.
 * Both travel drawers shipped `<DrawerContent width="50vw" className="min-w-[42rem]
 * max-w-full">`. `DrawerContent` writes `width` into an INLINE STYLE for a side panel
 * (`drawer.tsx:272-273`), and `min-width` is resolved after both `width` and `max-width`
 * (CSS 2.1 §10.4), so the 672px floor beat the `max-w-full` sitting next to it. The panel is
 * `fixed top-0 right-0` (`drawer.tsx:303`), so a 672px box in a 360px viewport is not a
 * scrollbar anywhere — it is 312px of the panel PAINTED OFF THE LEFT OF THE SCREEN, 282px at
 * 390 and 260px at 412, on BOTH primary flows. That is why the left-edge assertion below is
 * what catches it and why no document-level or `main`-level measure can. Both lines now read
 * `min-w-full max-w-full md:min-w-[42rem]`. Two instances and not one — `TravelRequestDrawer`
 * and `NewTravelRequestDrawer` are separate files and a fix to one is not a fix to the other.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ BEFORE CITING THIS FILE ─────────────────
 *
 * IT IS NOT THE `ready` EVIDENCE PACK ON ITS OWN. `ready` is three clauses together and this
 * file is one of them. See the promotion trigger in `docs/design/pwa.md`'s `/travel` row.
 *
 * IT SAYS NOTHING ABOUT THE POPULATED QUOTE COMPARISON. `travel/_lines/OptionPicker.tsx`
 * renders live fares in its own `DialogContent`, and its populated state is UNREACHABLE here:
 * `searchFlightOptions` returns `EMPTY('no-plan')` when the SerpApi config is null
 * (`apps/web/src/server/lib/travelOptions.ts:212`), and on a box that DOES carry a key the
 * same spec would hit a live, paid, non-deterministic API. Nobody has seen that surface at
 * any width, there is no fixture that would let them, and this file does not pretend
 * otherwise. It is also reached only from `LineBlock` ← `TravelRequestDrawer.tsx:515`, so it
 * sits on NEITHER primary flow and is not what made this route `limited`.
 *
 * IT DOES NOT MEASURE TAP GEOMETRY. That the create drawer's controls and the card list's
 * title button reach 44px is `e2e/tap-targets.mobile.spec.ts`'s claim, taken off rendered
 * boxes and `::after` rectangles. Here they are only DRIVEN — worth having on its own,
 * because a control can meet the floor and still be unreachable, and the inverse.
 *
 * IT DOES NOT PROVE THE APPROVAL ENGINE HONOURS ANYTHING. The approvals row is opened and
 * the decision controls are asserted PRESENT; nothing is decided. `e2e/travel-request.spec.ts`
 * owns deciding, at desktop, and re-asserting it here would double ownership of one contract.
 *
 * IT SAYS NOTHING ABOUT FR-CA TRANSLATION CORRECTNESS. It asserts LAYOUT UNDER THE FRENCH
 * STRINGS. A mistranslated but correctly-sized string passes here, and should.
 */

/**
 * Both locales, always — and the FR-CA run is not a second copy of the EN one.
 *
 * `/delegations` set this precedent on a +5-character control label with a wash on the route
 * title. `/travel` is the same seam and strictly worse: `travel.new` is "New travel request"
 * (18) against "Nouvelle demande de voyage" (26), and the route title `nav.items.travelRequests`
 * (`pageTitle.ts:12`) is "Travel Requests" (15) against "Demandes de voyage" (18). +8 and +3,
 * into the one pool the top bar rations below `lg`. The three section headings add two more
 * spreads INSIDE `main`, where the crawl could see them if the crawl were not EN-only
 * (`crawl-mobile.spec.ts:274`).
 *
 * `E2E_LOCALE` narrows it for iteration. Same knob and same spelling as
 * `delegations.mobile.spec.ts`, `topbar-overlap.spec.ts` and `crawl-roles`. LEAVE IT UNSET ON
 * A NIGHTLY: the promotion trigger counts 6 results per project, and one locale halves that.
 */
type Locale = 'en' | 'fr-CA';
// VeloExpense (w6-02): EN only. VeloExpense offers no French (`i18n/request.ts`), so the
// FR-CA half has no page to run on — the same cut `expenses.mobile.spec.ts` makes.
const LOCALES: Locale[] = ['en'];

/** Sub-pixel rounding at fractional grid-track widths. The overflow this file is about is
 *  hundreds of pixels. Same value and same reason as `e2e/delegations.mobile.spec.ts:105`. */
const TOLERANCE = 1;

/**
 * These flows are long: sign in, seed three rows through the engine, navigate, open a
 * drawer, drive a create, read the row back off the server. The 45s default left no room for
 * the polling that makes the last step deterministic. Same reason `travel-request.spec.ts`
 * raises its own.
 */
test.describe.configure({ timeout: 150_000 });

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * THE CATALOG, READ RATHER THAN PINNED — AND READ HERE RATHER THAN IN `e2e/support/catalog.ts`.
 *
 * The strings must come out of the next-intl catalogs and not out of a literal: every
 * accented character would have to be precomposed NFC to match what the DOM renders, and a
 * decomposed `e` + combining acute looks identical in a source file and never matches. That
 * argument is `e2e/support/catalog.ts`'s own and it is why this reader exists at all.
 *
 * WHY NOT ADD A `travelCatalog` THERE. `delegations.mobile.spec.ts:317-321` states the policy
 * this follows, for its copy of `extent()`: extending `e2e/support/` during a page task is the
 * wrong risk, because every phone spec in the suite imports from those files and a page task
 * has no reason to put them in its blast radius. The two helpers below are thirty lines, they
 * are used by one file, and a missing key throws with its own name either way.
 * ────────────────────────────────────────────────────────────────────────────────────────── */

/** `catalog.a.b.c` as a string, or a named failure. Repo-relative, as Playwright runs from
 *  the repo root. `tsconfig.e2e.json` has no `resolveJsonModule`, hence `readFileSync`. */
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

interface TravelCopy {
  /** The top bar's published control, AND the create drawer's title — the same key. */
  new: string;
  /** The route title, per `ROUTE_TITLE_KEYS` in `apps/web/src/app/[locale]/(app)/pageTitle.ts:12`. */
  routeTitle: string;
  sections: { mine: string; approvals: string; oversight: string };
  form: {
    purposePlaceholder: string;
    searchCity: string;
    submit: string;
  };
  detail: { approve: string; reject: string };
}

function travelCopy(locale: Locale): TravelCopy {
  return {
    new: text(locale, 'travel', 'new'),
    routeTitle: text(locale, 'nav', 'items.travelRequests'),
    sections: {
      mine: text(locale, 'travel', 'sections.mine'),
      approvals: text(locale, 'travel', 'sections.approvals'),
      oversight: text(locale, 'travel', 'sections.oversight'),
    },
    form: {
      purposePlaceholder: text(locale, 'travel', 'form.purposePlaceholder'),
      searchCity: text(locale, 'travel', 'form.searchCity'),
      submit: text(locale, 'travel', 'form.submit'),
    },
    detail: {
      approve: text(locale, 'travel', 'detail.approve'),
      reject: text(locale, 'travel', 'detail.reject'),
    },
  };
}

/**
 * The Prisma client, lazily, through `e2e/support/test-db.ts`. A top-level import of
 * `@expenseos/db` pulls it into Playwright's config load; that helper says out loud when
 * `DATABASE_URL` is missing from the TEST process, which is a different process from the
 * server's and a separate requirement.
 */
const testDb = () => sharedTestDb('travel.mobile');

/** A date relative to today, never a literal — travel pricing REFUSES a departure that has
 *  already passed (`isPastDate`), so a hardcoded date is a suite that goes green until the
 *  day it arrives. Same reasoning and same helper shape as `travel-request.spec.ts:88`. */
const dayFromNow = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The per-cell destination prefix, and it is the load-bearing isolation in this file.
 *
 * THERE ARE TWO CONCURRENCY AXES HERE AND THEY NEED DIFFERENT THINGS SAID ABOUT THEM.
 *
 * ACROSS THE FILE — project × locale. Three phone projects share one `expenseos_e2e` and
 * Playwright runs them concurrently under `fullyParallel`, and the two locale describes inside
 * each project run concurrently too. That is SIX CELLS, the same count
 * `delegations.mobile.spec.ts:115` records. `test.describe.configure({ mode: 'serial' })`
 * orders the tests inside ONE describe and says nothing about the other five cells, so on this
 * axis it is not the mitigation — keying every row and every drain on this prefix is.
 *
 * WITHIN ONE DESCRIBE — test × test, and this is the axis `delegations.mobile.spec.ts` never
 * met. `fullyParallel` distributes tests within a FILE and not merely files across workers
 * (`playwright.config.ts:183`, `workers: 3` at `:195`), so the three tests of one locale
 * describe can be in flight at the same time; the precedent file declares exactly one `test()`
 * per describe and so could never see it. Two of the three tests here seed the SAME three
 * destinations, and every one of them drains on entry and again in `afterEach`. A prefix keyed
 * on project and locale alone would therefore have each test's drain deleting a sibling's
 * fixture mid-flight, and duplicate `destinationLabel`s would make the by-name card locators
 * ambiguous under strict mode. SO THE TEST ID IS PART OF THE PREFIX: each test owns its own
 * rows and its own drain scope, and the one mechanism then covers both axes. `mode: 'serial'`
 * is the alternative on this second axis only; it was declined because it also skips the rest
 * of a describe after the first failure — turning one red into three unknowns — and it would
 * serialise three tests that have no reason to be ordered.
 *
 * Unlike `/delegations`, this file CANNOT isolate by actor: the seeded travel workflow routes
 * a trip to the traveller's own manager, and `qa.employee` → `qa.manager` is the one seeded
 * pair that produces a pending decision. So all six cells share one reader, and every one of
 * their rows is visible in every other one's three sections.
 *
 * THE CONSEQUENCE, AND IT IS A RULE RATHER THAN A CAUTION: **no assertion in this file may
 * count rows, and every row query is keyed on this prefix.** A count would be a different
 * number depending on which of the other five cells happened to be mid-flight. Teardown is
 * scoped to the prefix for the same reason, so a crashed cell can never drain another's.
 *
 * `destinationLabel` is ALSO the card's accessible name below `lg` — `MOBILE_MINE.title` is
 * the `destination` column (`TravelRequests.tsx:76`) and `DataTableCards` renders the title
 * cell inside the row's only navigation affordance (`DataTableCards.tsx:404-412`). Destination
 * is not unique in the data model, so two trips to the same city give two cards with the same
 * accessible name and an ambiguous `getByRole('button', { name })`. Hence one distinct
 * destination per seeded row, not merely one per cell.
 *
 * `testId` is a short, stable slug per `test()` — never `testInfo.title`, which is a sentence
 * and would put spaces and punctuation into a `startsWith` key.
 */
const cellPrefix = (projectName: string, locale: Locale, testId: string): string =>
  `P09-${projectName}-${locale}-${testId}`;

interface SeededTrips {
  /** Submitted by the READER. Lands in "My requests", and is the deep-link subject. */
  mine: { id: string; destination: string };
  /** Submitted by the direct report and routed. Lands in "Awaiting your approval". */
  queue: { id: string; destination: string; instanceId: string };
  /** Submitted by the direct report and NOT routed. Lands in "Your team & past decisions". */
  oversight: { id: string; destination: string };
}

/**
 * Take every row this cell created back out, best-effort, in dependency order.
 *
 * Scoped to the cell prefix, so it can never reach another project's or another locale's
 * concurrent fixture. Run BEFORE the flow as well as after it: that is what repairs a
 * database an earlier crashed run polluted, and it is the same drain-first doctrine
 * `e2e/support/notification-inbox.ts` uses.
 *
 * `ApprovalInstance` is deleted through its own id rather than through the request, because
 * `TravelRequest.approvalInstanceId` is a LOOSE FK by design (`schema.prisma:3924-3926`: a
 * relation there would close a cycle between the engine and its subjects), so nothing
 * cascades from the request side. `ApprovalTask.instanceId` DOES cascade, so deleting the
 * instance takes the parked task with it.
 */
async function clearCell(prefix: string): Promise<void> {
  // VeloExpense (w6-02): SQL on the admin pool — VeloExpense's generated Prisma client cannot
  // load in the Playwright process (`e2e/support/test-db.ts`). Same order and same reasons:
  // the instance by its own id (its tasks cascade), then the request (its lines cascade).
  const db = await testDb();
  const rows = (
    await db.query(
      `SELECT id, approval_instance_id FROM travel_request WHERE destination_label LIKE $1 || '%'`,
      [prefix],
    )
  ).rows as { id: string; approval_instance_id: string | null }[];
  if (rows.length === 0) return;
  const instanceIds = rows
    .map((r) => r.approval_instance_id)
    .filter((id): id is string => id != null);
  const ids = rows.map((r) => r.id);
  if (instanceIds.length > 0) {
    await db.query('DELETE FROM approval_instance WHERE id = ANY($1::uuid[])', [instanceIds]);
  }
  await db.query('DELETE FROM travel_request WHERE id = ANY($1::uuid[])', [ids]);
}

/** A seeded actor's `User.id`, or a named failure naming the setup script. */
async function userIdFor(actor: keyof typeof ACTORS): Promise<string> {
  const db = await testDb();
  const email = ACTORS[actor];
  // VeloExpense (w6-02): SQL on the admin pool, and the seed is `scripts/seed.mjs`.
  const user = (await db.query('SELECT id FROM app_user WHERE lower(email) = lower($1)', [email]))
    .rows[0] as { id: string } | undefined;
  if (!user) {
    throw new Error(
      `travel.mobile: no seeded user "${email}" (actor "${actor}"). Seed the e2e database ` +
        '(`STAGE=test npm run seed`) — the demo people come from scripts/seed.mjs.',
    );
  }
  return user.id;
}

/**
 * Seed one row into each of the three sections, through the database and the real engine.
 *
 * WHY THE DATABASE AND NOT THE UI. Driving create-and-submit through the product to build a
 * fixture would be measuring nothing at three widths and would roughly triple the runtime of
 * a file whose subject is geometry. The one flow this file is actually ABOUT — creating a
 * request from a phone — is still driven through the UI, in `test` 2.
 *
 * WHY `startInstance` AND NOT A HAND-WRITTEN `ApprovalInstance`. An instance written by hand
 * needs a pinned `workflowVersionId`, a graph position and a correctly-assigned parked task,
 * and a fixture that guesses those proves something about the fixture rather than about the
 * product. `e2e/support/authPageFixtures.ts:509` reaches for the same seam for the same
 * reason. The seeded `travel-default` workflow is a single `approver: { kind: 'manager' }`
 * node (`packages/db/prisma/seed.ts:2128-2137`), so a trip filed by `employee` parks on
 * `manager` — which is what makes the "awaiting my decision" half provable at all.
 *
 * THE THIRD ROW IS A DRAFT ON PURPOSE. `TravelRequests.tsx:293` renders the oversight Section
 * only when `oversightRows.length > 0`, and `oversightRows` EXCLUDES anything in the
 * approvals queue (`:189`) so one request cannot populate both. A DRAFT filed by the same
 * direct report is in `listOversight`'s first `OR` branch (`travelRequests.ts:1156`, which
 * carries no status filter) and in no task, so it lands in oversight and nowhere else.
 */
async function seedTrips(browser: Browser, prefix: string): Promise<SeededTrips> {
  /*
   * VeloExpense (w6-02): ExpenseOS writes the three rows with Prisma and calls the engine's
   * `startInstance` in the Playwright process. VeloExpense's generated client cannot load
   * here (`e2e/support/test-db.ts`), so the rows are written with SQL and the queued one is
   * SUBMITTED BY ITS TRAVELLER through `travelRequests.submit`, from the employee's own
   * session — the real submit starts the real workflow, which is the property the engine
   * call was there for. The parked task is then read with SQL, as ExpenseOS asserts it.
   */
  const db = await testDb();

  const managerId = await userIdFor('manager');
  const employeeId = await userIdFor('employee');

  const trip = async (submitterId: string, what: string, status: 'DRAFT' | 'SUBMITTED') => {
    const destination = `${prefix} ${what}`;
    // VeloExpense (w6-02): the tenant is the submitter's, and the currency is its ISO code.
    const row = (
      await db.query(
        `INSERT INTO travel_request
             (organization_id, submitter_id, purpose, destination_label, destination_city,
              depart_date, return_date, status, submitted_at, currency_code)
         SELECT u.organization_id, u.id, $2, $3, $3, $4, $5, $6,
                CASE WHEN $6 = 'SUBMITTED' THEN now() END, 'CAD'
           FROM app_user u WHERE u.id = $1
         RETURNING id`,
        [
          submitterId,
          `P09 phone fixture — ${what}`,
          destination,
          `${dayFromNow(30)}T00:00:00.000Z`,
          `${dayFromNow(34)}T00:00:00.000Z`,
          status,
        ],
      )
    ).rows[0] as { id: string };
    return { id: row.id, destination };
  };

  const mine = await trip(managerId, 'mine', 'SUBMITTED');
  const oversight = await trip(employeeId, 'team', 'DRAFT');
  const queueRow = await trip(employeeId, 'decide', 'DRAFT');

  const context = await browser.newContext({
    storageState: stateFileFor('employee'),
    viewport: { width: 1280, height: 900 },
  });
  try {
    const desk = await context.newPage();
    await desk.goto('/');
    await trpcOk(desk, 'travelRequests.submit', { id: queueRow.id });
  } finally {
    await context.close();
  }

  const instanceId = (
    await db.query('SELECT approval_instance_id FROM travel_request WHERE id = $1', [queueRow.id])
  ).rows[0]?.approval_instance_id as string | null;
  if (!instanceId) {
    throw new Error(
      'travel.mobile: submitting the seeded trip started no approval. Every tenant is seeded ' +
        'a default travel flow (`travel-request-default`, migration 0077) routing to the ' +
        "traveller's manager, and VeloExpense refuses a submit nothing governs (d58), so a " +
        'missing instance means the seed did not run.',
    );
  }

  const parked = (
    await db.query(
      `SELECT assignee_user_id FROM approval_instance_task
        WHERE instance_id = $1 AND status = 'PENDING'`,
      [instanceId],
    )
  ).rows as { assignee_user_id: string | null }[];
  expect(
    parked.map((p) => p.assignee_user_id),
    'the seeded trip did not park exactly one PENDING task on the reader this file signs in ' +
      `as. The default travel flow approves through \`{ kind: "manager" }\` and ${ACTORS.employee} ` +
      `is seeded reporting to ${ACTORS.manager}, so a different assignee means the reporting ` +
      'line moved in scripts/seed.mjs or the workflow graph was edited.',
  ).toEqual([managerId]);

  return { mine, oversight, queue: { ...queueRow, instanceId } };
}

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO MEASUREMENTS.
 * ────────────────────────────────────────────────────────────────────────────────────────── */

interface DrawerReading {
  width: number;
  height: number;
  left: number;
  right: number;
  /** The LAYOUT viewport, as the page itself computes it. */
  edge: number;
}

/**
 * Read the open drawer's own box against the layout viewport.
 *
 * `[role="dialog"]` IS THE ONLY STABLE HANDLE. `DrawerContent` renders
 * `DialogPrimitive.Popup` inside `DrawerPortal` (`drawer.tsx:265-268`) and there is no
 * `data-slot` and no `data-testid` anywhere in that file, so the ARIA role is what there is.
 * Do not swap it for a class — the classes are exactly what this measurement is about.
 *
 * `document.documentElement.clientWidth` AND NEVER `page.viewportSize()?.width`. Under
 * `isMobile: true` the layout viewport is derived from the page's own `<meta name="viewport">`,
 * so a broken meta tag fails here too instead of being measured away. Same basis
 * `e2e/auth-pages.mobile.spec.ts:231` and `e2e/support/mobile-census.ts:242` use.
 */
async function readDrawer(page: Page): Promise<DrawerReading | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="dialog"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      left: r.left,
      right: r.right,
      edge: document.documentElement.clientWidth,
    };
  });
}

/**
 * The drawer is contained by the layout viewport — the ONE assertion in P09 that is red on
 * `origin/main` and green here.
 *
 * ─── WHY THE DOCUMENT-LEVEL MEASURE WILL NOT DO, AND THIS IS THE LOAD-BEARING BIT ───────
 *
 * The popup is `position: fixed` and anchored `top-0 right-0` (`drawer.tsx:303`), so it
 * extends neither `document.documentElement.scrollWidth` nor `main#main-content` — a 672px
 * panel in a 360px viewport is not a scrollbar at all, it is 312px of the panel painted OFF
 * THE LEFT OF THE SCREEN, where only the dialog's own box can be asked about it. The first
 * instinct of whoever sees this go red will be to reach for the mobile crawl; the crawl is
 * green on this route today and was green on it while both drawers were hanging 312px off
 * the left edge at 360.
 *
 * ─── THE ANTI-HOLLOWING GUARD, AND THE THIRD PART IS THE ONE THAT MATTERS ───────────────
 *
 * Containment is a `<=` against a bound it can satisfy VACUOUSLY: `0 <= 360` is true, so a
 * drawer that never opened, or opened at zero area, passes every inequality below while
 * proving nothing. `width > 0` and `height > 0` are what close that, and they are not
 * optional decoration on this helper. The caller supplies the other two guards — a visible
 * title inside the drawer, and exactly one `[role="dialog"]` on the page — before calling.
 */
async function expectDrawerContained(page: Page, which: string): Promise<void> {
  expect(
    await page.getByRole('dialog').count(),
    `${which}: more than one [role="dialog"] is open, so the box measured below is whichever ` +
      'portal the selector happened to reach first. The quote-comparison modal in ' +
      'travel/_lines/OptionPicker.tsx is a second one; nothing in this file opens it, so if ' +
      'this is red something else on the page did.',
  ).toBe(1);

  const reading = await readDrawer(page);
  expect(reading, `${which}: no [role="dialog"] in the page at all`).not.toBeNull();
  if (!reading) return;

  /**
   * THE NON-DEGENERATE GUARD. Read the paragraph above before deleting either line: without
   * them the three inequalities that follow are satisfied by a drawer that never opened.
   */
  expect(
    reading.width,
    `${which}: the drawer's box is ${reading.width}px wide, i.e. it has NO AREA. The ` +
      'containment inequalities below would all pass on this reading — 0 is less than every ' +
      'viewport — so this guard is the only thing standing between "contained" and "never ' +
      'opened". Something closed the drawer, or it is mid-transition and animations were not ' +
      'disabled.',
  ).toBeGreaterThan(0);
  expect(reading.height, `${which}: the drawer's box has no height`).toBeGreaterThan(0);

  const describe =
    `    panel   [${Math.round(reading.left)}, ${Math.round(reading.right)}]  ` +
    `width ${Math.round(reading.width)}\n` +
    `    layout viewport  ${reading.edge}`;

  expect(
    Math.round(reading.width),
    [
      `${which}: the panel is ${Math.round(reading.width)}px wide inside a ${reading.edge}px ` +
        'layout viewport.',
      '    This is the P09 defect. `DrawerContent` writes its `width` prop into an INLINE ' +
        'STYLE (drawer.tsx:272-273) and `min-width` is resolved after both `width` and ' +
        '`max-width` (CSS 2.1 §10.4), so a bare `min-w-[42rem]` beats the `max-w-full` beside ' +
        'it and lays a 672px panel out at every phone width. The shipped class list is ' +
        '`min-w-full max-w-full md:min-w-[42rem]`; check it has not been simplified back.',
      '    The mobile crawl CANNOT report this — the panel portals out of main#main-content ' +
        'and is `position: fixed`, so neither mainScrollWidth nor documentElement.scrollWidth ' +
        'includes it. Do not go looking there.',
      describe,
    ].join('\n'),
  ).toBeLessThanOrEqual(reading.edge + TOLERANCE);

  expect(
    Math.round(reading.right),
    `${which}: the panel's right edge is at ${Math.round(reading.right)}, past the ` +
      `${reading.edge}px layout viewport\n${describe}`,
  ).toBeLessThanOrEqual(reading.edge + TOLERANCE);

  expect(
    Math.round(reading.left),
    `${which}: the panel's left edge is at ${Math.round(reading.left)}, i.e. off the left of ` +
      `the screen\n${describe}`,
  ).toBeGreaterThanOrEqual(-TOLERANCE);
}

interface TopBarGeometry {
  publishedControls: number;
  publishedName: string | null;
  spilledOutOfZone: number;
  title: { text: string; width: number; scrollWidth: number; clientWidth: number } | null;
  overlapWithTitle: number;
}

/**
 * Read the top bar's geometry: the one control this route publishes, and the route title it
 * must not be painted over.
 *
 * `extent` is COPIED from `e2e/delegations.mobile.spec.ts` (which copied it from
 * `e2e/topbar-overlap.spec.ts`) rather than imported, and that file states the policy: both
 * of those declare their own `test()` calls, so importing from either would run its whole
 * suite a second time inside this one.
 *
 * What "painted over the title" means mechanically, and why an OVERLAP is the right thing to
 * measure rather than a width: nothing in the top bar clips, on purpose. The header is a
 * three-track grid whose right track is `minmax(0, auto)` and `[data-chrome="page"]` carries
 * `min-w-0` — so the ZONE shrinks happily while a `whitespace-nowrap` labelled button inside
 * it cannot, and with `justify-end` it overflows its own box LEFTWARD, across the title. The
 * title's own `truncate` then makes the damage look like a shortened title rather than like a
 * collision, which is why both are asserted.
 */
async function measureTopBar(page: Page): Promise<TopBarGeometry> {
  const measured = await page.evaluate(() => {
    const rendered = (el: Element) => el.getClientRects().length > 0;
    const inFlow = (el: Element) => {
      const p = getComputedStyle(el).position;
      return p !== 'absolute' && p !== 'fixed';
    };

    /** Where an element's content is actually PAINTED: its own border box, unioned with its
     *  own text runs and its in-flow descendants' extents. Descent stops at anything that
     *  clips — such a box IS its own boundary, and `Range.getClientRects()` would otherwise
     *  report text a `truncate` span hides. */
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
    if (!zone || !leftZone) return null;

    /** `:scope >`, not a document-wide lookup: a seam added to another zone later must not
     *  have this file measuring the title while reporting the actions. */
    const pageBox = zone.querySelector(':scope > [data-chrome="page"]');

    /** The ration is on CONTROLS, not on elements — a wrapper `div` and a label `span` are
     *  not over budget, a second button is. */
    const CLICKABLE =
      'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
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
      /** `textContent` and not `innerText`: the label is `max-lg:sr-only`, i.e. clipped to
       *  1px rather than `display: none`, and `innerText` is defined in terms of RENDERING.
       *  Reported rather than claimed, either way — the accessible name is asserted HARD by
       *  the `getByRole` locator in the caller, using Playwright's own name computation. */
      publishedName:
        controls.length > 0
          ? (controls[0].getAttribute('aria-label') ?? controls[0].textContent ?? '')
              .replace(/\s+/g, ' ')
              .trim()
          : null,
      spilledOutOfZone,
      title,
      overlapWithTitle,
    };
  });

  expect(measured, 'the top bar had no [data-zone] children to measure').not.toBeNull();
  return measured as TopBarGeometry;
}

/** Rendered as a block in every geometry failure below, so a red reads as the defect. */
function describeTopBar(m: TopBarGeometry): string {
  return [
    `    published controls   ${m.publishedControls}  (${m.publishedName ?? 'none'})`,
    `    spilled out of zone  ${m.spilledOutOfZone}px`,
    `    route title          ${
      m.title
        ? `"${m.title.text}" width ${m.title.width}  scroll ${m.title.scrollWidth} / client ${m.title.clientWidth}`
        : 'absent'
    }`,
    `    overlap with title   ${m.overlapWithTitle}px`,
  ].join('\n');
}

/**
 * Everything in `main` fits the width it was given.
 *
 * DELIBERATELY REDUNDANT WITH THE MOBILE CRAWL, and the redundancy is the point. The crawl
 * seeds nothing, so `/travel`'s 0px reading was taken against whatever the shared database
 * held that day — quite possibly a page with two empty sections and one row. This runs with a
 * seeded row in EVERY section, at every width, in BOTH locales, which is the only
 * deterministic overflow reading this route will ever have.
 */
async function expectMainContained(page: Page, where: string): Promise<void> {
  const main = await page.evaluate(() => {
    const el = document.querySelector('main#main-content');
    if (!el) return null;
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(main, `${where}: no main#main-content to measure`).not.toBeNull();
  if (!main) return;
  expect(
    main.scroll - main.client,
    `${where}: main#main-content overflows by ${main.scroll - main.client}px with a seeded row ` +
      'in all three sections. The crawl seeds nothing and reads this route at 0px, so this is ' +
      'the only measurement of the populated page — a section heading, a card field or a badge ' +
      'is wider than the room it has.',
  ).toBeLessThanOrEqual(TOLERANCE);
}

/** The three section headings, rendered and not clipped. `travel.sections.approvals` is 22
 *  chars in EN and 31 in FR-CA; `oversight` is 26 and 33. This is where that lands. */
async function expectSectionHeadings(page: Page, copy: TravelCopy): Promise<void> {
  for (const [key, heading] of Object.entries(copy.sections)) {
    const el = page.getByText(heading, { exact: false }).first();
    await expect(
      el,
      `the "${key}" section heading ("${heading}") is not on the page. All three sections ` +
        'need a seeded row — the oversight Section is rendered only when it has rows ' +
        '(TravelRequests.tsx:293) — so this is either a missing fixture row or a renamed ' +
        'catalog key.',
    ).toBeVisible({ timeout: 30_000 });

    /**
     * AGAINST THE HEADER ROW'S CONTENT BOX, AND DELIBERATELY NOT AGAINST THE `h2` ITSELF.
     *
     * `scrollWidth - clientWidth` on the heading cannot fail here and would be a green line
     * pretending to be a measurement: the `h2` is `font-medium text-foreground text-sm`
     * (`TravelRequests.tsx:344`) with no `truncate`, no `overflow-hidden` and no width cap,
     * and it is a flex item at the default `min-width: auto`. Long FR-CA text makes it WIDER;
     * it never clips itself, so `scrollWidth === clientWidth` by construction.
     *
     * Where the overflow actually lands is one level up. The heading sits in the section's
     * header row (`:343`, `flex items-center justify-between px-4`) and the SECTION is
     * `overflow-hidden` (`:342`) — so a heading too wide for that row is clipped by the
     * section and never reaches `main#main-content`'s scroll width either. That makes this the
     * only assertion in the suite that can see it: `expectMainContained` is blind to it for
     * the `overflow-hidden`, and the crawl is EN-only (`crawl-mobile.spec.ts:274`) so it never
     * renders the FR-CA strings this is about at all.
     */
    const past = await el.evaluate((node) => {
      const e = node as HTMLElement;
      const row = e.parentElement;
      if (!row) return null;
      const s = getComputedStyle(row);
      const rowContentRight =
        row.getBoundingClientRect().right -
        Number.parseFloat(s.paddingRight || '0') -
        Number.parseFloat(s.borderRightWidth || '0');
      return e.getBoundingClientRect().right - rowContentRight;
    });
    expect(
      past,
      `the "${key}" section heading has no parent row to measure against`,
    ).not.toBeNull();
    expect(
      past ?? 0,
      `the "${key}" section heading runs ${past}px past its header row's content box. In ` +
        'FR-CA it is the longest string on this page, the section is `overflow-hidden` so ' +
        'nothing downstream of it can see the overflow, and the crawl is EN-only ' +
        '(crawl-mobile.spec.ts:274) — so this assertion is the only thing in the suite that ' +
        'can see it.',
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

/** Navigate, and refuse the three ways this route can look fine while being something else. */
async function arrive(page: Page, locale: Locale): Promise<string> {
  // VeloExpense (w6-02): no locale segment in any URL.
  void locale;
  const route = '/travel';
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${route} did not answer 200`).toBe(200);

  /** The service worker's offline fallback also answers 200, under whatever URL failed. It
   *  carries no top bar and no list, so without this the next assertions would fail with a
   *  message about a missing heading instead of about the network. */
  expect(
    await page.locator('[data-testid="offline-page"]').count(),
    `the service worker served the offline fallback in place of ${route}`,
  ).toBe(0);

  /**
   * A `limited` route that suppressed its own page.
   *
   * `DesktopOnlyNotice` renders for `disposition === 'desktop'`; `limited` and `ready` both
   * render the page untouched. So a registry row typed `desktop` by mistake — or P10's
   * `/admin/*` ruling widening across this route — replaces this page with a notice at every
   * phone width, and `mobileReadiness.test.ts` would stay GREEN, because the markdown and the
   * registry would agree with each other about the wrong answer.
   */
  expect(
    await page.locator('[data-testid="desktop-only-notice"]:visible').count(),
    `${route} rendered the desktop-only notice. This route is ruled \`limited\` in ` +
      'mobileReadiness.ts, which suppresses nothing — so either the row was changed to ' +
      '`desktop`, or a glob ruling now covers it. The registry/markdown parity check cannot ' +
      'see this: both sides would agree about the wrong disposition.',
  ).toBe(0);

  // Everything below is a tap at a coarse pointer. Under a fine pointer this is a desktop
  // test running in a small window.
  await assertCoarsePointer(page);
  // The lists arrive over tRPC and the header lays out again when they land, so a box read
  // mid-flight pairs a rectangle from before the reflow with one from after.
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
  await page.waitForLoadState('networkidle');
  return route;
}

// VeloExpense (w6-02): the admin pool `testDb` opens, closed once the file is done.
test.afterAll(async () => {
  await closeTestDb();
});

for (const locale of LOCALES) {
  test.describe(`/travel on a phone — ${locale}`, () => {
    let prefix: string | null = null;

    test.beforeEach(async ({ page }, testInfo) => {
      // Fails in ~0ms and names the project, rather than after a sign-in and a navigation.
      // `page` is destructured only so `beforeEach` receives `testInfo` in the second
      // position.
      void page;
      assertProject(testInfo, PHONE_PROJECTS);
    });

    test.afterEach(async () => {
      if (prefix) await clearCell(prefix);
      prefix = null;
    });

    test('sees the three sections and opens a decision, from a phone', async ({
      page,
      browser,
    }, testInfo) => {
      const copy = travelCopy(locale);
      const cell = cellPrefix(testInfo.project.name, locale, 'sections');
      // Drain first, so a crashed earlier run of this same cell cannot leave a duplicate
      // destination behind and make the by-name queries below ambiguous.
      await clearCell(cell);
      prefix = cell;
      const trips = await seedTrips(browser, cell);

      await signIn(page, 'manager');
      await arrive(page, locale);

      // ── 1. the three headings render, and none is clipped ────────────────────────────
      await expectSectionHeadings(page, copy);

      // ── 2. my own request is listed, with its destination, its dates and its status ───
      /**
       * By the CARD, not by the row. Below `lg` these three tables render through
       * `DataTableCards` (T03's `DataTableMobileConfig`, wired at `TravelRequests.tsx:275`,
       * `:288`, `:302`), so there is no `role="row"` to filter — the card's title button
       * carries the destination as its accessible name and everything else is a labelled
       * field beneath it.
       *
       * A DROPPED FIELD IS WORSE THAN A WIDE ONE, and this is the only place it can be
       * caught: `MOBILE_MINE` puts all six columns somewhere (title `destination`, badge
       * `status`, fields `dates` / `budget` / `number`), and a card config that quietly
       * stopped carrying the dates would look tidy and be unusable.
       */
      const mineCard = page.getByRole('button', { name: trips.mine.destination, exact: true });
      await expect(
        mineCard,
        `my own seeded request ("${trips.mine.destination}") is not in the list. The card's ` +
          'accessible name is the `destination` column, because that is `MOBILE_MINE.title` ' +
          "(TravelRequests.tsx:76) and DataTableCards puts the title cell inside the row's " +
          'only navigation affordance (DataTableCards.tsx:404-412).',
      ).toBeVisible({ timeout: 30_000 });

      /**
       * The card is addressed by `data-dt-row-key`, which `DataTableCards` maintains on the
       * `<li>` as the scroll anchor's handle (`DataTableCards.tsx:364`) — a seam the
       * component already owns, rather than a DOM shape this spec guessed at. Every slot is
       * then read by its `data-dt-column-id`, so a config that quietly stopped carrying one
       * names WHICH one.
       */
      const mineCardBox = page.locator(`[data-dt-row-key="${trips.mine.id}"]`);
      for (const field of ['dates', 'budget', 'number'] as const) {
        await expect(
          mineCardBox.locator(`[data-dt-card-slot="field"][data-dt-column-id="${field}"]`),
          `the card dropped the "${field}" field. \`MOBILE_MINE\` lands all six columns ` +
            '(TravelRequests.tsx:75-79) — title `destination`, badge `status`, fields ' +
            '`dates` / `budget` / `number` — and a config that drops one renders a tidy card ' +
            'nobody can triage from, which DataTable.tsx:136-141 names as worse than an ' +
            'overflowing table.',
        ).toHaveCount(1);
      }
      await expect(
        mineCardBox.locator('[data-dt-card-slot="badge"]'),
        'the card carries no status badge. `MOBILE_MINE.badge` is the `status` column, and ' +
          'status is the thing most readers open this page for.',
      ).toHaveCount(1);

      // ── 3. the request awaiting my decision is listed, and names the traveller ────────
      const queueCard = page.getByRole('button', { name: trips.queue.destination, exact: true });
      await expect(
        queueCard,
        `the request awaiting my decision ("${trips.queue.destination}") is not listed. ` +
          '`myTasks` filters on PENDING tasks assigned to me with a RUNNING TRAVEL_REQUEST ' +
          'instance (travelRequests.ts:1212-1221); the fixture asserted the task parked on ' +
          'this actor, so a miss here is the page and not the seed.',
      ).toBeVisible({ timeout: 30_000 });

      /**
       * The traveller. `MOBILE_WITH_TRAVELLER` puts it in the card's `subtitle` slot rather
       * than in `fields` (`TravelRequests.tsx:106-109`), and `TravelRequests.test.tsx:242`
       * makes the same claim in jsdom, at no width at all.
       */
      await expect(
        page
          .locator(`[data-dt-row-key="${trips.queue.id}"]`)
          .locator('[data-dt-card-slot="subtitle"]'),
        'the approvals card carries no subtitle, so the traveller is not on it. ' +
          "`MOBILE_WITH_TRAVELLER` carries `subtitle: 'traveller'` (TravelRequests.tsx:106-109) " +
          'for exactly the two sections that are about somebody else’s trip, and ' +
          'TravelRequests.test.tsx:242 makes the same claim in jsdom at no width at all.',
      ).toHaveCount(1);

      // ── 4. my team's row is listed under oversight ───────────────────────────────────
      await expect(
        page.getByRole('button', { name: trips.oversight.destination, exact: true }),
        `my team's request ("${trips.oversight.destination}") is not listed. The oversight ` +
          'Section renders only when it has rows (TravelRequests.tsx:293), and a request in ' +
          'the approvals queue is excluded from it (:189) so one row cannot populate both.',
      ).toBeVisible({ timeout: 30_000 });

      // ── 5. nothing escapes `main`, with a row in every section ───────────────────────
      await expectMainContained(page, `${locale} /travel, all three sections populated`);

      // ── 6. tapping the approvals row opens the drawer, and it offers a decision ──────
      await queueCard.tap();

      const drawer = page.getByRole('dialog');
      await expect(
        drawer.getByText(trips.queue.destination, { exact: false }),
        'tapping the approvals card did not open the detail drawer. `DrawerTitle` is ' +
          '`<number> · <destinationLabel>` (TravelRequestDrawer.tsx:336-338), so this is ' +
          'keyed on the destination this fixture chose and not on a class.',
      ).toBeVisible({ timeout: 30_000 });

      /**
       * The drawer was opened CARRYING ITS TASK ID, which is what the decision controls are
       * gated on (`TravelRequestDrawer.tsx:702`, `:755`). Offered, never pressed: deciding is
       * `e2e/travel-request.spec.ts`'s claim at desktop, and re-asserting it here would give
       * one contract two owners.
       */
      await expect(
        drawer.getByRole('button', { name: copy.detail.approve, exact: true }),
        "the drawer opened without a decision. The approvals section passes the row's " +
          '`taskId` (TravelRequests.tsx:289) and the panel gates Approve/Reject on it, so a ' +
          'miss here means the card list opened the row through the wrong handler.',
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        drawer.getByRole('button', { name: copy.detail.reject, exact: true }),
      ).toBeVisible();

      // ── 7. THE NEWLY-RED ASSERTION: the opened panel fits the screen ─────────────────
      await page.waitForLoadState('networkidle');
      await expectDrawerContained(page, `${locale} TravelRequestDrawer`);
    });

    test('creates a travel request from a phone', async ({ page }, testInfo) => {
      const copy = travelCopy(locale);
      const cell = cellPrefix(testInfo.project.name, locale, 'create');
      await clearCell(cell);
      prefix = cell;

      await signIn(page, 'manager');
      await arrive(page, locale);

      // ── 8. the top bar publishes exactly one control, named, inside its own box ──────
      /**
       * Found by its ACCESSIBLE NAME and deliberately not by its geometry — and this locator
       * is also the second half of the fix under test. The control is icon-only below `lg`
       * with a `max-lg:sr-only` label (`TravelRequests.tsx:190-197`), never `max-lg:hidden`,
       * so the name stays in the accessibility tree at every width. If this stops matching at
       * a phone width the control has become an unlabelled icon, and that is a defect rather
       * than a naming change.
       */
      const control = page.getByRole('button', { name: copy.new, exact: true });
      await expect(
        control,
        `no "${copy.new}" control in the top bar. Either the label was dropped from the ` +
          'accessibility tree — `max-lg:hidden` in place of `max-lg:sr-only` does exactly ' +
          'that and looks identical on screen — or this actor lost `travel.request.createOwn`.',
      ).toBeVisible({ timeout: 30_000 });

      /**
       * The claims are SOFT, so one run reports all of them: they are four views of one
       * layout, and the interesting question on a red is which of them broke and by how much.
       * A hard assertion would abort at the first and hide the rest. Same house style as
       * `e2e/delegations.mobile.spec.ts` and `e2e/topbar-overlap.spec.ts`.
       */
      const m = await measureTopBar(page);

      expect
        .soft(
          m.publishedControls,
          [
            'the top bar accepts ONE control below `lg` — 32x32 visual, 44px vertical hit ' +
              `area — or nothing at all, and this route published ${m.publishedControls}`,
            '    A responsive PAIR (`max-lg:hidden` beside `lg:hidden`) is the wrong fix and ' +
              "is refused: jsdom applies no stylesheet, so both are in the page's own unit " +
              'test accessibility tree and its singular getByRole throws there.',
            describeTopBar(m),
          ].join('\n'),
        )
        .toBe(1);

      expect
        .soft(
          m.publishedName,
          [
            'the published control carries no label text at all, so at a phone width it is ' +
              'an unlabelled icon',
            `    expected to contain "${copy.new}"`,
            describeTopBar(m),
          ].join('\n'),
        )
        .toContain(copy.new);

      expect
        .soft(
          m.spilledOutOfZone,
          [
            `the published control is painted ${m.spilledOutOfZone}px outside its own ` +
              '`[data-chrome="page"]` box',
            '    Nothing in the top bar clips, on purpose, so this is not a truncated label ' +
              '— it is the row laid out at full width over whatever sits to its left.',
            describeTopBar(m),
          ].join('\n'),
        )
        .toBeLessThanOrEqual(TOLERANCE);

      // ── 9. no part of it overlaps the route title, and the title is legible ──────────
      expect
        .soft(
          m.overlapWithTitle,
          [
            `the published control overlaps the route title by ${m.overlapWithTitle}px. This ` +
              'is worst in FR-CA: `travel.new` is 26 characters against 18, and the route ' +
              'title is 18 against 15, into one pool.',
            describeTopBar(m),
          ].join('\n'),
        )
        .toBeLessThanOrEqual(TOLERANCE);

      expect
        .soft(
          m.title?.text,
          ['the top bar rendered no route title at all', describeTopBar(m)].join('\n'),
        )
        .toBe(copy.routeTitle);
      expect
        .soft(
          (m.title?.scrollWidth ?? 0) - (m.title?.clientWidth ?? 0),
          [
            `the route title is clipped by ${(m.title?.scrollWidth ?? 0) - (m.title?.clientWidth ?? 0)}px`,
            "    The `h1` carries `truncate`, so a left track squeezed by the page's own " +
              'chrome shows as a shortened title rather than as an overlap. Both are the ' +
              'same defect and this is the half no overlap test can see.',
            describeTopBar(m),
          ].join('\n'),
        )
        .toBeLessThanOrEqual(TOLERANCE);

      // ── 10. a tap opens the create drawer ────────────────────────────────────────────
      await control.tap();
      const drawer = page.getByRole('dialog');
      await expect(
        drawer.getByText(copy.new, { exact: true }),
        'tapping the top bar control did not open the create drawer. `DrawerTitle` is ' +
          '`travel.new` (NewTravelRequestDrawer.tsx:175) — the same catalog key the control ' +
          'itself uses.',
      ).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState('networkidle');

      // ── 11. THE SECOND NEWLY-RED ASSERTION ───────────────────────────────────────────
      /** `NewTravelRequestDrawer.tsx:173` and `TravelRequestDrawer.tsx:334` are separate
       *  lines in separate files. One fix is not both, which is why this is asserted twice in
       *  this file rather than factored into one test. */
      await expectDrawerContained(page, `${locale} NewTravelRequestDrawer`);

      // ── 12. the flow completes: purpose, destination, a departure, a return ──────────
      const destination = `${cell} create`;
      const purpose = `P09 phone create — ${cell}`;

      await drawer.getByPlaceholder(copy.form.purposePlaceholder).fill(purpose);

      /**
       * The city fields, by their `aria-label`, which `CityPicker` sets to the `placeholder`
       * PROP in both of its branches (`CityPicker.tsx:75` free-text, `:96` search) — so this
       * locator works whether or not a Maps key is configured on the box. Two of them, in
       * `TravelRequests`' order: destination then origin (`NewTravelRequestDrawer.tsx:195-209`).
       *
       * `fill` commits in both branches: the free-text branch writes straight through
       * `onChange`, and the search branch keeps typed text on BLUR (`CityPicker.tsx:99-116`),
       * which the next `fill` triggers. Nothing here depends on a suggestion arriving, which
       * matters because the suggestion list is a live third-party lookup.
       */
      const cities = drawer.getByLabel(copy.form.searchCity);
      await cities.nth(0).fill(destination);
      await cities.nth(1).fill(`${cell} origin`);

      /**
       * Dates are CLICKED before they are filled. `fill()` alone assigns `.value` and
       * dispatches no click, which is how this suite stayed green for four months while every
       * date field in the product was covered by an invisible calendar-picker overlay —
       * `travel-request.spec.ts:60-77` records the whole sequence. Below `sm` the pair is
       * stacked (`NewTravelRequestDrawer.tsx:215`), which is precisely what P09 changed, so
       * they are addressed by ORDER within the drawer and never by position on screen.
       */
      const dates = drawer.locator('input[type=date]');
      for (const [i, iso] of [dayFromNow(30), dayFromNow(34)].entries()) {
        const field = dates.nth(i);
        await field.click();
        await field.fill(iso);
        await expect(field).toHaveValue(iso);
      }

      /**
       * No currency is driven, and that is correct rather than an omission: `currency` falls
       * back to `options.data?.defaultCurrencyId` (`NewTravelRequestDrawer.tsx:87`), so the
       * enabling set is purpose + destination + a departure + a return (the default trip type
       * is ROUND_TRIP, which requires one). `NewTravelRequestDrawer.test.tsx:235` pins the
       * same set in jsdom.
       */
      const submit = drawer.getByRole('button', { name: copy.form.submit, exact: true });
      await expect(
        submit,
        'Create is still disabled with a purpose, a destination and both dates set. The ' +
          '`ready` guard (NewTravelRequestDrawer.tsx:131-138) also requires a currency, which ' +
          'defaults from `formOptions` — so a red here is usually that query failing rather ' +
          'than the form.',
      ).toBeEnabled({ timeout: 30_000 });
      await submit.tap();

      await expect(
        drawer,
        'the drawer stayed open, so the write was refused. `onSuccess` is the only thing that ' +
          'closes it.',
      ).toBeHidden({ timeout: 30_000 });

      // ── 13. it EXISTS ON THE SERVER, with what the form was driven with ──────────────
      /**
       * Read from the database and not inferred from a row appearing. A row appearing proves
       * the client re-rendered; it does not prove `travelRequests.create` reached Postgres
       * with the trip this form was driven with. Polled, because the list invalidation and
       * the drawer's close do not wait on each other.
       */
      // VeloExpense (w6-02): SQL on the admin pool (see `clearCell`).
      const db = await testDb();
      await expect
        .poll(
          async () =>
            Number(
              (
                await db.query(
                  'SELECT count(*)::int AS n FROM travel_request WHERE destination_label = $1',
                  [destination],
                )
              ).rows[0].n,
            ),
          { timeout: 30_000 },
        )
        .toBe(1);
      const found = (
        await db.query(
          `SELECT purpose, depart_date, return_date, status
             FROM travel_request WHERE destination_label = $1`,
          [destination],
        )
      ).rows[0] as { purpose: string; depart_date: Date; return_date: Date | null; status: string };
      const row = {
        purpose: found.purpose,
        departDate: found.depart_date,
        returnDate: found.return_date,
        status: found.status,
      };
      expect(row.purpose, 'the purpose did not survive the write').toBe(purpose);
      expect(row.departDate.toISOString().slice(0, 10), 'the departure did not survive').toBe(
        dayFromNow(30),
      );
      expect(row.returnDate?.toISOString().slice(0, 10), 'the return did not survive').toBe(
        dayFromNow(34),
      );
      /** Created, not submitted — the drawer files a DRAFT and submission is its own act. */
      expect(row.status).toBe('DRAFT');

      // ── 14. and it is on screen, in this locale, without a manual reload ─────────────
      await expect(
        page.getByRole('button', { name: destination, exact: true }),
        'the created request is not in "My requests". `onCreated` invalidates the three ' +
          'queries (NewTravelRequestDrawer.tsx:90) — a miss here means the list did not ' +
          'refetch, which on a phone reads as "it did not save".',
      ).toBeVisible({ timeout: 30_000 });
    });

    test('opens a request from a deep link, and clears the params', async ({
      page,
      browser,
    }, testInfo) => {
      const cell = cellPrefix(testInfo.project.name, locale, 'deeplink');
      await clearCell(cell);
      prefix = cell;
      const trips = await seedTrips(browser, cell);

      await signIn(page, 'manager');

      /**
       * The deep link the dashboard's travel card and every travel notification produce —
       * `/travel?request=<uuid>`. `e2e/dashboard.mobile.spec.ts:146` pins
       * `/^(\/en)?\/travel\?request=[0-9a-f-]{36}$/` as that card's destination, so this is a
       * cross-route coupling neither suite owns on its own: the phone list changed how a row
       * is opened, and the deep-link path must still reach the same drawer.
       *
       * Navigated rather than tapped, which is why it is its own `test` rather than a step
       * inside flow (a).
       */
      // VeloExpense (w6-02): no locale segment.
      const route = `/travel?request=${trips.mine.id}`;
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `GET ${route} did not answer 200`).toBe(200);
      await assertCoarsePointer(page);
      await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });
      await page.waitForLoadState('networkidle');

      const drawer = page.getByRole('dialog');
      await expect(
        drawer.getByText(trips.mine.destination, { exact: false }),
        'the deep link did not open the request. `useDeepLink("request", { uuid: true })` ' +
          'matches against the three LOADED lists only (TravelRequests.tsx:236-246), so a ' +
          'miss means either the lists had not arrived or the id is not in any of them — and ' +
          'a malformed id reads as absent by design, with no distinct face.',
      ).toBeVisible({ timeout: 30_000 });

      // The panel is contained here too. Same drawer, different arrival — and the arrival is
      // the half `TravelRequests.deepLink.test.tsx` cannot measure, because jsdom has no
      // viewport at all.
      await expectDrawerContained(page, `${locale} TravelRequestDrawer via deep link`);

      /**
       * And the params are gone. `deepLink.clear()` runs in the same effect that opens the
       * drawer (`TravelRequests.tsx:254`), so a reader who shares the URL from here shares
       * the list and not somebody's trip id.
       * `TravelRequests.deepLink.test.tsx:173` makes the same claim with no viewport behind it.
       */
      await expect.poll(() => new URL(page.url()).search, { timeout: 15_000 }).toBe('');
      expect(
        new URL(page.url()).pathname,
        'the address bar left /travel entirely after the drawer opened',
      ).toMatch(/^(\/(en|fr-CA))?\/travel$/);
    });
  });
}

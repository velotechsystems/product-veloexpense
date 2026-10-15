import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type Actor, signIn } from './support/actors';
import { PHONE_PROJECTS } from './support/phone-projects';
import { seedEmployeeActivity } from './support/seed-activity';
import { assertCoarsePointer, assertProject } from './support/tap-targets';
import { reportTag } from './support/workbench';

/**
 * VeloExpense: ExpenseOS's `e2e/dashboard.mobile.spec.ts` (1e682dd6), ported with its phone
 * specs. The page and its two cards are ExpenseOS's (`ReportsToApproveCard` and
 * `MyExpenseReportsCard` are byte-identical). The changes are marked `VeloExpense:` where they
 * are made, and are these:
 *
 *   · EN ONLY. VeloExpense has no locale segment: the reader's locale is their stored
 *     preference, else their company's (`lib/i18n/request.ts`), so an FR-CA run means writing
 *     `app_user.locale` on a seeded person that every other spec is reading concurrently.
 *     `LOCALES` keeps ExpenseOS's shape and holds one entry; the catalog reads are unchanged.
 *   · NO TRAVEL. VeloExpense ships no travel module, so the "My travel requests" assertions
 *     are gone; the card's gate is still read, and must say `false` with no card on screen.
 *   · `/preferences` IS `/profile`, as the identity band's own comment records.
 *   · IT CREATES TWO REPORTS. VeloExpense has no QA activity seed, so `seedEmployeeActivity`
 *     builds the employee's draft and a submitted report in the manager's queue once per
 *     worker. Every assertion stays a read and a shape claim, as ExpenseOS's are, so the
 *     concurrency argument below holds for everything after that.
 *
 * `/dashboard` on a phone: see my own activity, and reach my reports, my approvals and my
 * trips from the cards that summarise them.
 *
 * ─── THE REDUCTION THIS FILE USED TO RECORD IS CLOSED, AND THAT IS WHAT CHANGED HERE ─────
 *
 * The version of this header before this commit said, at length, that no assertion here may
 * claim the approvals queue's submitter or total is readable, because both sat at x >= 260
 * inside `ReportsToApproveCard`'s table and were off-screen at every width in
 * `PHONE_PROJECTS`. That was true and it is no longer: T03's `DataTableMobileConfig` landed,
 * the three cards took it, and below the compact breakpoint the table is replaced by a card
 * list whose slots put the submitter under the report's name and the total in a labelled
 * field row. The assertion that was forbidden is now the assertion that is REQUIRED — it is
 * in `shows an approver the queue waiting on them` below, and the old header's own closing
 * sentence ("when T03 lands, the assertion to ADD is that the queue's amounts are legible")
 * is what it discharges.
 *
 * WHAT THIS FILE STILL DOES NOT DO IS RE-RULE THE ROUTE. `mobileReadiness.ts` rules
 * `/dashboard` `limited` on this commit, deliberately, and this file being green is not what
 * changes that — the `ready` bar is three clauses and one of them is a nightly run id that
 * does not exist while this is being written. Do not promote the registry row by citing the
 * existence of the assertions below; cite the run.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * At 360, 390 and 412, in EN and in FR-CA, with a coarse primary pointer proven before
 * anything is tapped, for two of the nine seeded actors:
 *
 *   · the reader's own name is the one `h1` inside `<main>`, and the identity chips resolved
 *     from the FRESH profile rather than degrading to the session snapshot;
 *   · every card the SERVER's own gating decision says should be there IS there and every
 *     card it excluded is absent, all three are out of their loading skeletons, no panel
 *     fell back to `PanelBoundary` and the app error boundary did not fire;
 *   · each card links at the record it names and at the listing it summarises: a row goes to
 *     its own report or trip, and "view all" goes to `/expenses`, `/expenses/approvals` or
 *     `/travel`;
 *   · THE APPROVALS QUEUE CARRIES ITS TWO DECISION INPUTS. On the approver's first queued
 *     report, the `submitter` subtitle slot and the `total` field slot each exist exactly
 *     once and carry text, and the total carries a figure and an ISO currency code. This is
 *     the flow the route's `limited` ruling was about;
 *   · that card carries NO badge slot, which is the other half of the same claim — the money
 *     did not get promoted into the loudest slot on the card to make it visible;
 *   · a TAP on a row at a coarse pointer actually gets there — which is worth more than the
 *     `href` on its own, because a control can carry the right target and still be covered
 *     by something at a phone width.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ BEFORE CITING THIS FILE ─────────────────
 *
 * IT IS NOT THE `ready` EVIDENCE PACK, and cannot become it by growing. `ready` is defined in
 * `mobileReadiness.ts` as three clauses together: the mobile crawl, this file, and the
 * tap-target lanes. This file is one of them, and the promotion is a separate, later,
 * deliberate act taken against a recorded nightly run.
 *
 * THE DESTINATIONS ARE NOT IN SCOPE. `/expenses`, `/expenses/approvals`, `/travel` and
 * `/profile` belong to P03, P05 and P09. Every assertion about them here is about the URL
 * this page sends the reader to, and there is deliberately not one word about what those
 * pages then lay out — a red here must never be a report about somebody else's route.
 *
 * IT DOES NOT MEASURE GEOMETRY. Nothing here reads a box. The card title's 44px tap target —
 * which on this route is the caller's `<a>` stretched inside the frame's floored title slot,
 * not a row-open `<button>` — is measured in `e2e/tap-targets.mobile.spec.ts`, which carries
 * a `/dashboard` lane for exactly that subject and explains there why the universal floor
 * lane structurally cannot see it.
 *
 * IT DOES NOT RE-PROVE THE ABSENCE OF THE DESKTOP NOTICE, unlike
 * `e2e/notifications.mobile.spec.ts`, and the difference is not an oversight. That route had
 * no other spec that would catch its row being mistyped `desktop`. This one does:
 * `e2e/desktop-notice.spec.ts` uses `/dashboard` as its NEGATIVE case in every phone
 * project, and P02 rewrote that file's framing so the claim is now "a route not ruled
 * `desktop` is structurally untouched" rather than "an unruled route is". Duplicating it
 * here would add a second place to update and no coverage.
 *
 * IT SAYS NOTHING ABOUT FR-CA TRANSLATION CORRECTNESS. Every French string it compares
 * against is READ OUT OF THE CATALOG, so a mistranslated message passes here and should —
 * what the FR-CA pass buys is the layout and the card slots under the longer strings.
 *
 * ─── IT CREATES NOTHING, WHICH IS A CONCURRENCY REQUIREMENT AND NOT A STYLE ─────────────
 *
 * Three phone projects share one `expenseos_e2e` under `fullyParallel`, so this file now runs
 * SIX times at once — three projects times two locales — and `mode: 'serial'` would order the
 * copies within a project and nothing across them. Every assertion below is a read against
 * `seed-data/qa-activity.json`, so there is no fixture to key off `testInfo.project.name`,
 * nothing to clean up, and no ordering dependency on any other spec. The two taps navigate
 * and mutate nothing.
 *
 * THE NEW QUEUE ASSERTIONS ARE WHAT THAT PROPERTY COST, AND THEY WERE WRITTEN TO PRESERVE IT.
 * They assert the SHAPE of the money — a digit, and an ISO code — rather than a seeded value,
 * because the lifecycle specs create reports as `qa.employee` and never delete them, so any
 * assertion naming a figure would be an assertion about what else has run today. The row the
 * shape is read off is the queue's FIRST, and the card sorts by `submittedAt` ASCENDING
 * (`ReportsToApproveCard.tsx:146-158`), so it is the longest-waiting report — a seeded one —
 * rather than whatever another spec submitted a minute ago.
 *
 * It does REQUIRE that fixture: re-run `npm run test:e2e:setup` if the reports and trips are
 * missing. And it deliberately does not assert a row COUNT, for the same reason.
 * See `e2e/dashboard.spec.ts`, which records learning that.
 */

/**
 * Both locales, always.
 *
 * The version of this file before this commit ran EN only, and said so under a heading that
 * called the omission "biased in the dangerous direction: FR-CA strings run about 20% longer,
 * which is what makes a card header wrap and a column narrower still". The justification it
 * gave for keeping the bias was specific and is now spent: the recorded reduction was a
 * COLUMN GEOMETRY that did not depend on locale. There are no columns on a phone here any
 * more. What there is instead is a card whose title, subtitle, badge and field slots share a
 * `flex-wrap` row inside a `SectionCard` that is already narrower than the viewport — the
 * shape where +20% of string length is exactly what decides whether a slot wraps or spills.
 *
 * `E2E_LOCALE` narrows it for iteration. Same knob and same spelling as
 * `delegations.mobile.spec.ts`, `travel.mobile.spec.ts` and `crawl-roles`. LEAVE IT UNSET ON
 * A NIGHTLY: the `ready` bar counts 12 results for this file (2 tests × 2 locales × 3
 * projects), and one locale halves that. A recorded 6 means the locale axis did not run.
 */
type Locale = 'en' | 'fr-CA';
// VeloExpense: EN only — the locale is a stored preference, not a URL segment. See the header.
const LOCALES: Locale[] = ['en'];

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * THE CATALOG, READ RATHER THAN PINNED — AND READ HERE RATHER THAN IN `e2e/support/catalog.ts`.
 *
 * Lifted from `e2e/travel.mobile.spec.ts:149-163`, whose header states the argument this
 * follows in full and is worth reading once: the strings must come out of the next-intl
 * catalogs and not out of a literal, because every accented character would have to be
 * precomposed NFC to match what the DOM renders, and a decomposed `e` + combining acute looks
 * identical in a source file and never matches. "Rapports à approuver" is precisely that
 * shape. The reader THROWS on a missing key rather than returning `undefined`, so a key that
 * exists in EN and not in FR-CA fails by name here instead of silently asserting against
 * `undefined`.
 *
 * WHY NOT ADD A `dashboardCatalog` TO `e2e/support/`. `delegations.mobile.spec.ts:292-295`
 * states the policy, and `travel.mobile.spec.ts` follows it for its own copy: extending
 * `e2e/support/` during a page task is the wrong risk, because every phone spec in the suite
 * imports from those files and a page task has no reason to put them in its blast radius.
 * Two helpers, thirty lines, one consumer.
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

interface DashboardCopy {
  /** `dashboard.cards.*.title` */
  approvalsTitle: string;
  expensesTitle: string;
  travelTitle: string;
  /** `common.panelUnavailable` — `PanelBoundary`'s fallback. */
  panelFailed: string;
  /** `common.errorBoundary` — `(app)/error.tsx`, i.e. the whole page went down. */
  errorBoundary: string;
}

/**
 * What the app says, read off the catalogs rather than guessed — a renamed key has to fail.
 *
 * RESTATED FROM `e2e/dashboard.spec.ts` RATHER THAN SHARED, and only the subset this file
 * asserts. Sharing it would mean a new `e2e/support/` module and an edit to that spec, which
 * this phase does not own; the two tables are checked against the same catalog and the
 * catalog is the contract either way.
 */
function dashboardCopy(locale: Locale): DashboardCopy {
  return {
    approvalsTitle: text(locale, 'dashboard', 'cards.approvals.title'),
    expensesTitle: text(locale, 'dashboard', 'cards.expenses.title'),
    travelTitle: text(locale, 'dashboard', 'cards.travel.title'),
    panelFailed: text(locale, 'common', 'panelUnavailable'),
    errorBoundary: text(locale, 'common', 'errorBoundary'),
  };
}

/** Full names from `seed-data/test-users.json`, for the two actors this file signs in as.
 *  The band prints the SESSION's name (`auth.ts` recomposes it from first + last), and the
 *  seed holds those same two fields, so the two agree by construction. Not locale-dependent:
 *  a person's name is not translated. */
const FULL_NAME: Partial<Record<Actor, string>> = {
  // VeloExpense: the demo tenant's display names (`scripts/seed.mjs`).
  employee: 'Demo Employee',
  manager: 'Demo Manager',
};

interface LinkShapes {
  record: { report: RegExp; approval: RegExp; trip: RegExp };
  listing: { reports: RegExp; approvals: RegExp; trips: RegExp; profile: RegExp };
}

/**
 * The link shapes, as `@/i18n/navigation`'s `Link` writes them, for one locale.
 *
 * THE `$` ANCHOR IS THE LOAD-BEARING CHARACTER, for the reason `e2e/dashboard.spec.ts`
 * records: each card footers to a LISTING (`/expenses`, `/travel`) and each row links to a
 * RECORD, so a row that fell back to linking at its own list — the defect `subjectLinks.ts`
 * was written against — has to land here as a missing record link rather than as a pass.
 *
 * The locale prefix is OPTIONAL in every pattern even though `routing.ts` sets
 * `localePrefix: 'always'`, because it is the `Link` that decides whether to write one, not
 * the card — and a href that dropped the prefix is `Link`'s business to fail on, not this
 * file's. It is built PER LOCALE rather than hardcoded so that the FR-CA run cannot pass by
 * matching an `/en` href that should never have been rendered there.
 */
function linkShapes(locale: Locale): LinkShapes {
  // VeloExpense: no locale segment, so no prefix to allow.
  void locale;
  const prefix = '';
  return {
    record: {
      /** A row of "My expense reports". */
      report: new RegExp(`^${prefix}\\/expenses\\/[0-9a-f-]{36}$`),
      /** A row of "Reports to approve" — the approvals inbox's deep link, not `/expenses`. */
      approval: new RegExp(`^${prefix}\\/expenses\\/approvals\\?report=[0-9a-f-]{36}$`),
      /** A row of "My travel requests". */
      trip: new RegExp(`^${prefix}\\/travel\\?request=[0-9a-f-]{36}$`),
    },
    listing: {
      reports: new RegExp(`^${prefix}\\/expenses$`),
      approvals: new RegExp(`^${prefix}\\/expenses\\/approvals$`),
      trips: new RegExp(`^${prefix}\\/travel$`),
      /** The identity band's action, which is not a card footer but is the band's only link.
       *  VeloExpense: `/preferences` is ExpenseOS's `/profile`. */
      profile: new RegExp(`^${prefix}\\/preferences$`),
    },
  };
}

/**
 * The dashboard's own root, and nothing else on screen.
 *
 * `data-dashboard-approvals` is stamped on the page's outermost div, so this is the shell
 * minus the sidebar, the top bar and both popovers. Scoping to it is what keeps a card
 * assertion off the sidebar's profile trigger — which carries the reader's name and role
 * too, and on a phone lives in the off-canvas copy of that same nav.
 */
function home(page: Page): Locator {
  return page.locator('[data-dashboard-approvals]');
}

/**
 * Wait until no card is still loading.
 *
 * `SectionCard`'s pending face is the page's only `aria-busy` region, so zero of them means
 * all three cards have committed to rows, empty copy or an error face. Every "nothing went
 * wrong" assertion has to come after this: `not.toContainText` passes instantly against a
 * page that has not rendered the thing yet, so asserting the absence of the panel fallback
 * while the panels are skeletons asserts nothing at all.
 */
async function settled(page: Page): Promise<void> {
  await expect(
    home(page).locator('[aria-busy="true"]'),
    'a dashboard card never left its loading skeleton',
  ).toHaveCount(0, { timeout: 30_000 });
}

/** Every anchor the dashboard rendered, as hrefs. ONE SNAPSHOT, and only safe after
 *  `settled()` — nothing is in flight by then to change the answer. */
async function hrefsOf(root: Locator): Promise<string[]> {
  return root
    .locator('a[href]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
}

/**
 * Sign in, open the page at a phone width, and prove the pointer before anything is tapped.
 *
 * The offline check is not defensive noise: the service worker's fallback answers 200 under
 * whatever URL failed, carries no cards and no identity band, so without it the next
 * assertion fails with a message about a missing heading instead of about the network.
 */
async function openDashboard(page: Page, actor: Actor, locale: Locale): Promise<Locator> {
  // VeloExpense: no locale segment.
  void locale;
  const route = '/dashboard';
  await signIn(page, actor);
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `GET ${route} did not answer 200 for ${actor}`).toBe(200);
  expect(
    await page.locator('[data-testid="offline-page"]').count(),
    `the service worker served the offline fallback in place of ${route}`,
  ).toBe(0);
  // Under a fine pointer this would be a desktop test running in a small window: the slop on
  // the band's action does not exist at all, and a `.tap()` is not the gesture under test.
  await assertCoarsePointer(page);

  /**
   * THE ANTI-VACUITY ASSERTION, and it has to be here rather than left implicit.
   *
   * Every check below is scoped to this root, and two of them are counts of its descendants
   * — `settled()`'s `toHaveCount(0)` on `[aria-busy]` and the `toHaveCount(0)` branch of the
   * card gate. A page whose root never rendered at all satisfies both by having nothing in
   * it, so without this line a completely blank dashboard would read as a clean run.
   */
  const root = home(page);
  await expect(
    root,
    `the dashboard root never rendered for ${actor} at ${route} — nothing scoped to it below ` +
      'is measuring anything',
  ).toBeVisible({ timeout: 30_000 });
  return root;
}

/**
 * The identity band, which is the "see my activity" half and the only part of this page that
 * cannot half-render.
 *
 * The band draws from the session, which has already resolved before the page renders, so it
 * sits above every boundary — a card failure can never leave `<main>` with no heading. Two
 * things are worth asserting rather than one: that the `h1` is the reader's own name, and
 * that the chips came from the FRESH profile. `session` for the second means `IdentityChips`
 * caught its own `users.get` failure and drew the JWT's English-only role label instead —
 * invisible to a reader at any width, which is exactly why a test has to say it, and doubly
 * so on the FR-CA run where an English-only label is the observable symptom of it.
 */
async function assertIdentityBand(page: Page, root: Locator, actor: Actor): Promise<void> {
  const mainHeading = page.locator('#main-content').getByRole('heading', { level: 1 });
  await expect(
    mainHeading,
    `main does not hold exactly one h1 for ${actor} at a phone width. The band renders from ` +
      'the session above every boundary, so zero means it regressed to a div and two means ' +
      'a card grew an h1.',
  ).toHaveCount(1);
  await expect(mainHeading, `the dashboard h1 does not name ${actor}`).toHaveText(
    FULL_NAME[actor] as string,
  );
  await expect(
    root.locator('[data-dashboard-identity]'),
    `the identity chips fell back to the session for ${actor} — users.get threw`,
  ).toHaveAttribute('data-dashboard-identity', 'fresh');
}

/**
 * Every card the server gated ON is present and has said something; every card it gated OFF
 * is absent. Asserted against the server's own decision rather than a per-role table, which
 * is what catches both halves of a gating mistake — a card missing that should be there, and
 * a card rendered for a reader the server excluded.
 *
 * `permissions.spec.ts` owns which role SHOULD get which card, with an expected table. This
 * would still pass if the gate were wrong for everybody in the same direction, and that
 * division of labour is deliberate.
 */
async function assertCardsSettled(
  page: Page,
  root: Locator,
  actor: Actor,
  locale: Locale,
  copy: DashboardCopy,
): Promise<void> {
  const gates = {
    approvals: [await root.getAttribute('data-dashboard-approvals'), copy.approvalsTitle],
    expenses: [await root.getAttribute('data-dashboard-expenses'), copy.expensesTitle],
    travel: [await root.getAttribute('data-dashboard-travel'), copy.travelTitle],
  } as const;

  for (const [name, [gate, title]] of Object.entries(gates)) {
    expect(
      gate,
      `the server published no gating decision for the ${name} card — selectDashboardCards ` +
        'is not being read, so nothing below is comparing the page against anything',
    ).toMatch(/^(true|false)$/);
    await expect(
      root.getByRole('heading', { name: title, exact: true }),
      `data-dashboard-${name}=${gate} for ${actor} but the card says otherwise. The heading ` +
        `looked for is the ${locale} catalog's "${title}" — a miss in ONE locale only is a ` +
        'catalog problem rather than a gating one.',
    ).toHaveCount(gate === 'true' ? 1 : 0);
  }

  // Both directions of "nothing went wrong", and only meaningful after `settled()`: one
  // panel caught its own failure, or the page went down as a whole.
  await expect(root, `a panel fell back to PanelBoundary for ${actor}`).not.toContainText(
    copy.panelFailed,
  );
  await expect(
    page.locator('body'),
    `the app error boundary fired on /dashboard (${locale}) for ${actor}`,
  ).not.toContainText(copy.errorBoundary);
}

for (const locale of LOCALES) {
  const copy = dashboardCopy(locale);
  const { record: RECORD, listing: LISTING } = linkShapes(locale);

  test.describe(`the dashboard on a phone — ${locale}`, () => {
    // VeloExpense: the employee's reports and the manager's queued one, which ExpenseOS reads
    // out of `qa-activity.json`. See the header.
    test.beforeAll(async ({ browser }) => {
      await seedEmployeeActivity(browser, {
        draftTitle: reportTag('dashboard draft'),
        queuedTitle: reportTag('dashboard queue'),
      });
    });

    // Fails in ~0ms and names the project, rather than after a sign-in and a navigation.
    // `page` is destructured only so `beforeEach` receives `testInfo` in the second position.
    test.beforeEach(async ({ page }, testInfo) => {
      void page;
      assertProject(testInfo, PHONE_PROJECTS);
    });

    test('shows an employee their own activity, and reaches a report from it', async ({ page }) => {
      /**
       * `qa.employee` owns everything `qa-activity.json` seeds that a reader can call theirs:
       * seven expense reports and all six travel requests. So this actor is the one that can
       * assert the "my things" half with ROWS in it rather than with empty copy — which is
       * the assertion that separates a working query from a broken one.
       */
      const root = await openDashboard(page, 'employee', locale);
      await assertIdentityBand(page, root, 'employee');
      await settled(page);
      await assertCardsSettled(page, root, 'employee', locale, copy);

      const hrefs = await hrefsOf(root);

      /**
       * The band's action, asserted here rather than tapped: `/profile` is P03's route and
       * its layout is none of this file's business. The geometry of that control lives in
       * `e2e/tap-targets.mobile.spec.ts`, which already censuses `/dashboard`.
       */
      expect(
        hrefs.filter((h) => LISTING.profile.test(h)),
        'the identity band offers no way to the reader’s own profile',
      ).toHaveLength(1);

      // ── My reports, and my trips: rows that name records, and a footer to the listing. ──
      const reportRows = hrefs.filter((h) => RECORD.report.test(h));
      expect(
        reportRows.length,
        // VeloExpense: the rows are `seedEmployeeActivity`'s, not a QA seed's.
        `no row of "${copy.expensesTitle}" links at a report for the employee, who has two ` +
          'from `seedEmployeeActivity`. Either the card printed its empty copy where rows were ' +
          'expected — the fixture did not land — or a row is linking at the listing instead ' +
          'of at the record, which is the defect the `$`-anchored pattern above exists to catch.',
      ).toBeGreaterThan(0);
      expect(
        hrefs.filter((h) => LISTING.reports.test(h)),
        `"${copy.expensesTitle}" drew rows but offers no way to the full list`,
      ).toHaveLength(1);

      // VeloExpense: ExpenseOS's "My travel requests" rows and footer are not asserted — no
      // travel module. `assertCardsSettled` above still requires that card to be ABSENT.

      /**
       * And a TAP gets there, which is the part an `href` cannot establish.
       *
       * The row link is the card's title slot, and a control can carry a perfectly correct
       * target while something else covers it at 360. The URL is all that is asserted on
       * arrival — `/expenses` is P05's route.
       */
      const firstReport = reportRows[0] as string;
      await root.locator(`a[href="${firstReport}"]`).first().tap();
      await page.waitForURL((url) => RECORD.report.test(url.pathname), { timeout: 30_000 });
    });

    test('shows an approver the queue waiting on them, and reaches a report from it', async ({
      page,
    }) => {
      /**
       * `qa.manager` is the approver the fixture routes to: six tasks land there because that
       * account is the direct manager of all three submitters and every total sits under the
       * workflow's first amount tier. It owns no reports and no trips of its own, so this
       * test asserts the QUEUE and the employee test above asserts the "my things" cards —
       * between them all three cards are seen with rows rather than with empty copy.
       *
       * ─── WHAT THIS TEST MUST ASSERT, AND WHY IT IS THE INVERSE OF WHAT IT ONCE SAID ────
       *
       * This block used to FORBID any assertion that the submitter or the total is readable,
       * because both lived in table columns starting at x >= 260 and were off every phone
       * screen. That is the reduction T03 closed. The card list puts the submitter in the
       * `subtitle` slot and the total in a `field` slot, both inside the card's own width,
       * so the two decision inputs of a triage flow — WHOSE report, and HOW MUCH — are on
       * screen. Asserting them is now the point of this test rather than the thing it was
       * written to avoid, and a red on either is a report about this route rather than a
       * recorded gap being re-reported as a regression.
       *
       * THE SHAPE OF THE MONEY, NEVER A VALUE. A digit and an ISO code, on the queue's
       * longest-waiting row. That is deliberate and is what keeps this file write-free: the
       * lifecycle specs submit reports as `qa.employee` and never delete them, so a spec
       * naming a figure would be asserting what else has run today. See the header.
       */
      const root = await openDashboard(page, 'manager', locale);
      await assertIdentityBand(page, root, 'manager');
      await settled(page);
      await assertCardsSettled(page, root, 'manager', locale, copy);

      const hrefs = await hrefsOf(root);

      const queueRows = hrefs.filter((h) => RECORD.approval.test(h));
      expect(
        queueRows.length,
        // VeloExpense: the queued row is `seedEmployeeActivity`'s, not a QA seed's.
        `no row of "${copy.approvalsTitle}" links at a report for the manager, whose queue ` +
          "holds at least the employee's report `seedEmployeeActivity` submitted. A queue that " +
          'renders empty here is a fixture problem or an eligibility one, not a phone layout ' +
          'problem.',
      ).toBeGreaterThan(0);
      expect(
        hrefs.filter((h) => LISTING.approvals.test(h)),
        `"${copy.approvalsTitle}" drew rows but offers no way to the full queue`,
      ).toHaveLength(1);

      const firstQueueHref = queueRows[0] as string;
      const firstQueueRow = root.locator(`a[href="${firstQueueHref}"]`).first();
      await expect(
        firstQueueRow,
        'a queue row rendered with no text at all, which leaves the approver nothing to ' +
          'navigate by',
      ).toHaveText(/\S/);

      /**
       * ── THE CARD, SCOPED BY THE ROW KEY THE HREF ALREADY CARRIES ──────────────────────
       *
       * `ReportsToApproveCard` passes `rowKey={(row) => row.report.id}` and `DataTableCards`
       * stamps that key on the card's `<li>` as `data-dt-row-key`
       * (`DataTableCards.tsx:364`). The same uuid is the `?report=` parameter of the href
       * just matched, so the card can be addressed with NO NEW FIXTURE and no read against
       * the database — which is what lets this file keep its "creates nothing" property
       * while gaining per-row assertions.
       *
       * It is the FIRST queue row, which is the longest-waiting one: the card sorts by
       * `submittedAt` ascending with nulls last and takes five. A report submitted by
       * another spec during this run is newer than every seeded one and therefore lands at
       * the BACK of that sort, so the subject here is a seeded row in practice — the
       * assertions below are still written as shape claims rather than value ones, because
       * "in practice" is not a guarantee.
       */
      const reportId = firstQueueHref.split('report=')[1] as string;
      const card = root.locator(`[data-dt-row-key="${reportId}"]`);
      await expect(
        card,
        `the queue's first row links at report ${reportId} but no card carries that row key. ` +
          'Either the list is not in card mode at this width — `useIsCompact` plus the ' +
          "`mobile` prop on the card's `DataTable` are what select the card tree, and the " +
          'table tree stamps `data-row-` instead — or `rowKey` stopped being the report id.',
      ).toHaveCount(1);

      /**
       * WHOSE REPORT. The submitter is the card's `subtitle`, matching the inbox one screen
       * deeper (`ExpenseApprovalsInbox.tsx:398-407`). Asserted by SLOT AND COLUMN together,
       * because "the submitter is somewhere in the card" was already true of the table —
       * what is new is that it is in a slot rendered inside the card's own width. `subtitle`
       * is also the slot that is NOT exempt from the column-visibility intersection
       * (`DataTableCards.tsx:229-243`), so this is the assertion a future toolbar hiding
       * that column would break.
       */
      const submitter = card.locator(
        '[data-dt-card-slot="subtitle"][data-dt-column-id="submitter"]',
      );
      await expect(
        submitter,
        'the queued report names no submitter on a phone. The approver is being asked to ' +
          'triage a report with nobody attached to it, which is the flow this route was ' +
          'ruled `limited` over.',
      ).toHaveCount(1);
      await expect(submitter, 'the submitter slot rendered blank').toHaveText(/\S/);

      /**
       * HOW MUCH. The total is a labelled `field` row and deliberately NOT the badge — a
       * badge is where a reader looks for state, and a total is not a state
       * (`ReportsToApproveCard.tsx:49-57`).
       *
       * TWO SEPARATE REGEX CLAIMS, NOT ONE COMBINED PATTERN, so a red says which half broke.
       * A digit: the figure rendered at all. An ISO code: `formatMinor(…, { withCode: true })`
       * is still asking for the code rather than the glyph, which is the F54 fix — CAD and
       * USD both print `$`, and this card is the one place on the page that holds several
       * submitters' currencies at once. `en` leads with the code and `fr-CA` trails it
       * (`packages/money/src/format.test.ts:242-253`), so an unanchored match is the only
       * form that can be the same assertion in both locales.
       *
       * `(CAD|USD)` and not `[A-Z]{3}`: every SUBMITTED report in `qa-activity.json` is one
       * of those two — the JPY one is a DRAFT and never reaches a queue — so naming them is
       * a tighter claim than "some three letters", which also matches a stray word. If a
       * future fixture routes a third currency to `qa.manager` AND it sorts to the front of
       * the queue, widen this deliberately rather than loosening the pattern.
       */
      const total = card.locator('[data-dt-card-slot="field"][data-dt-column-id="total"]');
      await expect(
        total,
        'the queued report carries no total on a phone. With the submitter, this is the ' +
          'second of the two decision inputs a triage flow needs, and its absence is what ' +
          'the `limited` ruling was about.',
      ).toHaveCount(1);
      await expect(total, 'the total slot rendered blank').toHaveText(/\S/);
      await expect(total, 'the total carries no figure at all').toContainText(/\d/);
      await expect(
        total,
        'the total prints no ISO currency code. `formatMinor` is being called without ' +
          '`withCode: true`, or the column stopped asking for it — and CAD and USD both ' +
          'print `$`, so on this card that is two different amounts of money rendered ' +
          'identically (GA readiness report F54).',
      ).toContainText(/(CAD|USD)/);

      /**
       * AND NO BADGE, which is the same decision seen from the other side.
       *
       * This card has no status COLUMN — every row in a pending queue is by definition
       * awaiting the reader, so five identical "Submitted" pills are noise — and the money
       * was deliberately not promoted into the empty slot to make it visible. A badge
       * appearing here means somebody did exactly that, and without this assertion the
       * change would read as an improvement.
       *
       * `submitted` is asserted NOWHERE, and that is deliberate rather than an omission: a
       * report with a null `submittedAt` legally renders an em dash in that field, so a
       * `/\d/` on it would be a test that fails on correct behaviour.
       */
      await expect(
        card.locator('[data-dt-card-slot="badge"]'),
        "the approvals card grew a badge slot. `ReportsToApproveCard`'s `MOBILE` config " +
          'names no `badge` on purpose — see its comment. If the total was moved there to ' +
          'make it louder, that is the F54 shape and the remedy is the field row it already ' +
          'had.',
      ).toHaveCount(0);

      await firstQueueRow.tap();
      await page.waitForURL(
        (url) => url.pathname.endsWith('/expenses/approvals') && url.searchParams.has('report'),
        { timeout: 30_000 },
      );

      /**
       * ── AND A PHONE KEEPS THE DRAWER ──────────────────────────────────────────────────
       *
       * The wait above is not this. It is satisfied the moment the card's link lands, and
       * stays satisfied for the one frame before the queue's deep-link effect runs — which
       * at 768px and up `router.replace`s to `/expenses/<id>`, the report page. A phone
       * that wrongly took that branch would pass the URL wait and leave nothing behind it
       * to fail.
       *
       * The trap that would cause it is specific. `useIsCompact` reports DESKTOP on the
       * hydration render (its server snapshot is `false`), and the effect that runs straight
       * after hydration is exactly the deep-link effect — so if it read the hook rather than
       * `matchMedia`, every phone arriving from this card would be sent to the workbench.
       *
       * So two claims, in this order: the review drawer is OPEN — addressed by its footer's
       * test id, which only `ApproverReportDrawer` carries, so another dialog on the page
       * cannot stand in for it — and only then, the pathname is STILL the queue. The drawer
       * first, because a redirect is async: asserting the path straight after the tap could
       * read it before the navigation it is meant to rule out.
       */
      const drawer = page
        .getByRole('dialog')
        .filter({ has: page.getByTestId('approver-drawer-footer') })
        .first();
      await expect(
        drawer,
        'tapping a queue row on a phone did not open the review drawer. Below 768px the deep ' +
          'link opens the drawer; at a desktop width it replaces the URL with the report ' +
          "page. If this phone was sent there, the queue's deep-link effect read the " +
          "hydration render's DESKTOP answer instead of asking `matchMedia` itself.",
      ).toBeVisible({ timeout: 20_000 });
      expect(
        new URL(page.url()).pathname,
        'a phone left the queue for the report page — the desktop redirect fired at phone width',
      ).toMatch(/\/expenses\/approvals$/);
    });
  });
}

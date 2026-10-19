import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { type Actor, signIn as signInAs } from './support/actors';
import { approvalsCatalog, commonCatalog } from './support/catalog';
import { submitQueuedReport } from './support/seed-activity';
import { reportTag } from './support/workbench';

/*
 * VeloExpense: ExpenseOS's `e2e/permissions.spec.ts` (1e682dd6), ported with the role-matrix
 * people (`scripts/seed.mjs`). What changed is marked `VeloExpense:` where it is made; in
 * short:
 *   · sign-in adopts each role's minted session (`e2e/auth.setup.ts`) — there is no password
 *     form to drive;
 *   · no locale in a URL, and `PROBES` are VeloExpense's routes for the same boundaries;
 *   · `card-administrator` has no person (no virtual-card screens), so its row, the
 *     `/virtual-cards` probe and the AP-clerk card test are not here;
 *   · the travel module is on for the demo tenant (w6-02's seed), as in ExpenseOS's;
 *   · the AP clerk's report is one the employee really submits (`submitQueuedReport`), where
 *     ExpenseOS opens a QA-seeded one;
 *   · the open-redirect test is not here — see the note where it stood.
 */

/**
 * Sign in as each system role and record what it can actually reach.
 *
 * The point is to check the permission matrix by BEING each role rather than reading the
 * registry and believing it. UI gating is cosmetic — the server is authoritative — so
 * this asserts on what the server does with a direct request to a gated route, not only
 * on what the sidebar chooses to render.
 *
 * Depends on the seeded test users (`packages/db/prisma/seed-data/test-users.json`),
 * which exist in local and dev and never in prod.
 */

test.use({ storageState: { cookies: [], origins: [] } });


// VeloExpense: each role is a seeded actor (`e2e/support/actors.ts`), signed in by session.
const ROLES = [
  { kind: 'admin', actor: 'admin' },
  { kind: 'expense-administrator', actor: 'expenseAdmin' },
  { kind: 'manager', actor: 'manager' },
  { kind: 'employee', actor: 'employee' },
  // Shipped with #223 and seeded in test-users.json, but never exercised here — so the role
  // whose whole purpose is a NARROWER reach than an admin's was one nobody checked the reach of.
  // VeloExpense: ExpenseOS's `card-administrator` row is not here (no virtual-card screens).
  { kind: 'ap-clerk', actor: 'apClerk' },
] as const satisfies readonly { kind: string; actor: Actor }[];

/** Routes chosen to straddle the interesting boundaries. */
// VeloExpense: VeloExpense's routes for the same boundaries — `/admin/analytics` for ExpenseOS's
// `/analytics`. `/users` is ExpenseOS's own since People 3 (`/admin/employees` retired in
// People 4). `/virtual-cards` and `/admin/api-keys` are not VeloExpense routes.
const PROBES = [
  '/dashboard',
  '/expenses',
  '/expenses/approvals',
  '/users',
  '/admin/roles',
  '/admin/policies',
  '/admin/analytics',
] as const;

/**
 * ── The dashboard's three cards, as a permission fact ───────────────────────────────
 *
 * `dashboard/page.tsx` stamps its gating decision onto the page root:
 *
 *     data-dashboard-travel={String(cards.showTravel)}
 *     data-dashboard-approvals={String(cards.showApprovals)}
 *     data-dashboard-expenses={String(cards.showExpenses)}
 *
 * READ OFF THE RESPONSE BODY, NOT THE DOM. Those attributes and the card's own heading are
 * both in the HTML the server sent — the card is a client component, so Next server-renders
 * its shell — and reading them off `response.text()` catches them at the moment the server
 * answered rather than after however much client hydration a `toBeVisible()` would have
 * waited through.
 *
 * WHY THE ATTRIBUTE IS NOT ENOUGH ON ITS OWN, AND WHY THE HEADING IS NOT EITHER. The
 * attribute proves the DECISION was the server's, including in the negative case where there
 * is no card to find and "absent" and "not yet loaded" look identical. The heading proves a
 * card actually came out the other end. Asserting both, against the same read, is what makes
 * a mismatch between them — gate open, card missing — a failure rather than a silence.
 *
 * ── WHY THE NEEDLE IS HEADING MARKUP AND NOT THE BARE CARD TITLE ────────────────────
 *
 * This is a correction. The instrument here used to be `html.includes('Reports to approve')`,
 * and it failed for exactly the two roles whose whole purpose is a narrower reach — while the
 * GATE half passed, which is what named the defect: the server had correctly published
 * `data-dashboard-approvals="false"` and rendered no card, and the string was in the document
 * anyway. A bare catalog string CANNOT distinguish "the card rendered" from "the catalog
 * shipped":
 *
 *   · `[locale]/layout.tsx:33` mounts `<NextIntlClientProvider>` with NO `messages` prop. In
 *     that configuration next-intl serialises the WHOLE message catalog into the RSC payload,
 *     and that payload is inlined in the document — so every `dashboard.cards.*.title` string
 *     is in the HTML of every page, for every reader, gated or not.
 *   · Measured on this branch rather than assumed: an UNAUTHENTICATED GET of `/en/login`,
 *     which sits inside the same `[locale]` layout, carries
 *     `\"cards\":{\"approvals\":{\"title\":\"Reports to approve\"` in its 163 kB of HTML. So
 *     the old negative was green for a reader who has the card, and equally green for a
 *     visitor who is not signed in at all.
 *
 * The needle therefore has to be something only the RENDER emits. `SectionCard` stamps no
 * `data-*` attribute of its own, and adding one would be an application change this phase
 * does not get to make — so the instrument is the card title INSIDE ITS OWN HEADING TAG:
 * `<h2 …>Reports to approve</h2>`. A JSON-serialised catalog entry can carry the string but
 * never the element around it. Measured the same way: false on `/en/login`, false for
 * `card-administrator` and `ap-clerk`, true for `admin`, `expense-administrator`, `manager`
 * and `employee` — which is the expected table below, exactly.
 *
 * `My expense reports` used to make the point harder still, by a second route that is now
 * closed: it was ALSO the title of a section on `/my-info`, and that page, its catalog and
 * its nav entry were deleted. The instrument is unchanged, because the reason above never
 * depended on the second route — ONE serialised catalog entry is already enough to make a
 * plain-text match meaningless on every page in the app, signed in or not.
 *
 * The narrower hazard that DOES survive is worth naming, since it is why the needle is
 * built the way it is rather than loosely. `nav.items.expenseReports` is `My Expense
 * Reports`, and `TopBar.tsx:121` renders the route title inside an `<h1>` — so on
 * `/expenses` a heading element really does carry that text. It does not collide here only
 * because the needle is CASE-SENSITIVE and the two catalog strings capitalise differently.
 * Do not add an `i` flag to `renderedCardHeading`, and do not let the two strings converge.
 *
 * The TAG is matched loosely (`h1`–`h6`, any attributes) on purpose: `SectionCard`'s
 * `headingLevel` is the page's choice and `dashboard.spec.ts` owns the assertion on it. The
 * TEXT is not loose — it is the exact catalog string, so a renamed key still fails here. One
 * limit worth knowing: if a card title ever gains an `&`, a `<` or an apostrophe, this needle
 * must compare against React's ESCAPED output rather than the catalog value.
 */
const APPROVALS_CARD = 'Reports to approve'; // dashboard.cards.approvals.title, EN catalog
const TRAVEL_CARD = 'My travel requests'; // dashboard.cards.travel.title, EN catalog
const EXPENSES_CARD = 'My expense reports'; // dashboard.cards.expenses.title, EN catalog

/** Regex-escape a catalog string before it goes inside the heading needle. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<h2 …>Reports to approve</h2>` — true only when a heading with that title was RENDERED,
 * and immune to the serialised catalog that carries the same string on every page.
 */
function renderedCardHeading(title: string): RegExp {
  return new RegExp(`<h([1-6])[^>]*>${escapeRe(title)}</h\\1>`);
}

/**
 * What each role must get, decided from `packages/rbac/src/systemRoles.ts` and NOT from
 * running the app and writing down what happened.
 *
 * `showApprovals` = expense-management active AND `expense.report.approve`. Two surprises
 * live in that one line, and both are deliberate:
 *
 *   · EVERY EMPLOYEE GETS THE CARD. `collectEmployee()` carries `expense.report.approve`
 *     since the manager fold — a manager is an employee with reports, and the permission
 *     was never what authorizes a decision (`canDecide` authorizes on the task assignment).
 *     So `employee` is NOT the negative control here, however much it reads like one.
 *
 *   · THE AP CLERK IS THE NEGATIVE CONTROL, and its row is the sharpest assertion in this
 *     file: `reimburse` + `readAll` get it through the door at `/expenses/approvals` (that
 *     page admits all three), while the card needs `approve`, which `collectApClerk()`
 *     deliberately withholds for segregation of duties. Inbox yes, card no. That asymmetry
 *     is intended — do not "fix" it by widening the card.
 *
 * `showTravel` = travel active AND (`travel.request.createOwn` OR `approve`). Every seeded
 * role spreads `collectEmployeeBase()`, which carries `createOwn`, so the travel column is
 * `true` for all six. Its `false` branch is only reachable with the module off, which
 * CANNOT be tested here — `bootstrapModuleInstallations()` never re-activates a module an
 * admin turned off, so a spec that deactivated travel and died before its cleanup would
 * leave this database with travel off forever. `selectDashboardCards.test.ts` owns it.
 *
 * `showExpenses` = expense-management active AND `expense.report.readOwn`. The column is
 * `true` for all six, and BOTH of its false branches are structurally out of reach here:
 *
 *   · `collectEmployeeBase()` grants `expense.report.readOwn`, and `card-administrator`,
 *     `ap-clerk` and `employee` all spread it — `qa.manager` holds the `employee` role
 *     after the manager fold. `admin` and `expense-administrator` get it from
 *     `flatten(P.expense)`. There is no seeded role WITHOUT it, so this column can never
 *     go false for a permission reason no matter which actor signs in.
 *   · The module half is unreachable for the same reason travel's is.
 *
 * That is precisely why the gate is worth asserting here and cannot be PROVEN here: the
 * reader it protects is a Role Builder role composed without `readOwn`, and this matrix is
 * a matrix of SYSTEM roles. What these six rows do is catch the gate closing on somebody it
 * was never meant to close on — the regression a widened predicate would cause — while
 * `selectDashboardCards.test.ts` owns the false branches themselves.
 */
const EXPECTED_CARDS: Record<string, { travel: boolean; approvals: boolean; expenses: boolean }> = {
  admin: { travel: true, approvals: true, expenses: true },
  'expense-administrator': { travel: true, approvals: true, expenses: true },
  manager: { travel: true, approvals: true, expenses: true },
  employee: { travel: true, approvals: true, expenses: true },
  'ap-clerk': { travel: true, approvals: false, expenses: true },
};

/** What the dashboard's HTML said about itself, for one reader. */
interface Cards {
  /** `data-dashboard-travel` — the server's decision, or null when it stamped nothing. */
  travelGate: string | null;
  approvalsGate: string | null;
  expensesGate: string | null;
  /**
   * Whether the card's OWN HEADING MARKUP is in the document the server sent. Emphatically
   * not a bare substring search for the title — see `renderedCardHeading`, which records why
   * that could never be a negative assertion on this app.
   */
  travelRendered: boolean;
  approvalsRendered: boolean;
  expensesRendered: boolean;
}

async function readDashboardCards(page: import('@playwright/test').Page): Promise<Cards> {
  // VeloExpense: no locale segment.
  const res = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const html = (await res?.text()) ?? '';
  const attr = (name: string) =>
    html.match(new RegExp(`data-dashboard-${name}="(true|false)"`))?.[1] ?? null;
  return {
    travelGate: attr('travel'),
    approvalsGate: attr('approvals'),
    expensesGate: attr('expenses'),
    travelRendered: renderedCardHeading(TRAVEL_CARD).test(html),
    approvalsRendered: renderedCardHeading(APPROVALS_CARD).test(html),
    expensesRendered: renderedCardHeading(EXPENSES_CARD).test(html),
  };
}

type Row = {
  kind: string;
  sections: string[];
  reach: Record<string, number | 'redirected'>;
  cards: Cards;
};
const matrix: Row[] = [];

// VeloExpense: adopt the actor's minted session (`e2e/auth.setup.ts`) — there is no password
// form. `signInAs` lands on `/dashboard` and fails loudly if the session is refused, which is
// what ExpenseOS's `waitForURL('**/dashboard')` was for.
async function signIn(page: import('@playwright/test').Page, actor: Actor) {
  await signInAs(page, actor);
}

for (const role of ROLES) {
  test(`${role.kind} can sign in, and reaches only what it should`, async ({ page }) => {
    await signIn(page, role.actor);

    // What the shell offers. Uppercase section headers come from the nav catalog.
    const sections = await page
      .locator('nav, aside')
      .first()
      .evaluateAll((els) => {
        const text = els.map((el) => el.textContent ?? '').join(' ');
        return [
          'HOME',
          'EXPENSE MANAGEMENT',
          'VIRTUAL CARDS',
          'APPROVALS',
          'FINANCE & REPORTING',
          'COMPLIANCE & AUDIT',
          'ADMINISTRATION',
          'NETSUITE',
        ].filter((s) => text.includes(s));
      })
      .catch(() => [] as string[]);

    const reach: Record<string, number | 'redirected'> = {};
    for (const probe of PROBES) {
      // VeloExpense: no locale segment.
      const res = await page.goto(probe, { waitUntil: 'domcontentloaded' });
      // A server-side refusal may 403/404 OR bounce to the dashboard; both are a
      // refusal, and conflating them with a 200 would make this test meaningless.
      reach[probe] = page.url().includes(probe) ? (res?.status() ?? 0) : 'redirected';
    }
    const cards = await readDashboardCards(page);
    matrix.push({ kind: role.kind, sections, reach, cards });

    // The dashboard's cards, as a permission fact. See EXPECTED_CARDS.
    const want = EXPECTED_CARDS[role.kind];
    expect(
      { travel: cards.travelGate, approvals: cards.approvalsGate, expenses: cards.expensesGate },
      `${role.kind}: the server's own gating decision on the dashboard`,
    ).toEqual({
      travel: String(want.travel),
      approvals: String(want.approvals),
      expenses: String(want.expenses),
    });
    expect(
      cards.approvalsRendered,
      `${role.kind}: data-dashboard-approvals=${cards.approvalsGate} but the rendered approvals card heading says otherwise — the gate and the render disagree`,
    ).toBe(want.approvals);
    expect(
      cards.travelRendered,
      `${role.kind}: data-dashboard-travel=${cards.travelGate} but the rendered travel card heading says otherwise${
        cards.travelGate === 'false'
          ? ' — check that the `travel` module is still active in this database; bootstrap never re-activates one'
          : ''
      }`,
    ).toBe(want.travel);
    expect(
      cards.expensesRendered,
      `${role.kind}: data-dashboard-expenses=${cards.expensesGate} but the rendered expenses card heading says otherwise — the gate and the render disagree${
        cards.expensesGate === 'false'
          ? '. A seeded role has lost `expense.report.readOwn`, or expense management was switched off in this database; bootstrap never re-activates a module'
          : ''
      }`,
    ).toBe(want.expenses);

    // The invariant worth failing on: role separation exists at all. If an employee can
    // load the Role Builder, the matrix is broken no matter what the sidebar shows.
    if (role.kind === 'employee') {
      expect(
        reach['/admin/roles'],
        'an employee reached /admin/roles — permission gating is not being enforced',
      ).not.toBe(200);
    }
    if (role.kind === 'admin') {
      expect(reach['/admin/roles'], 'an admin could not reach /admin/roles').toBe(200);
    }
    // Every role owns its own expenses.
    expect(reach['/expenses'], `${role.kind} could not reach its own expenses`).toBe(200);

    /**
     * The asymmetry, asserted as one statement rather than two.
     *
     * An AP clerk holds `reimburse` + `readAll`, which `expenses/approvals/page.tsx` admits
     * (`if (!canApprove && !canReimburse && !canReadAll) notFound()`), and does NOT hold
     * `approve`, which the dashboard card requires. Inbox reachable, card absent. Written
     * here, in the same test, because the interesting failure is one of them changing
     * without the other.
     */
    if (role.kind === 'ap-clerk') {
      expect(
        reach['/expenses/approvals'],
        'an AP clerk could not reach the approvals inbox — reimburse/readAll no longer admit them',
      ).toBe(200);
      expect(
        cards.approvalsRendered,
        'an AP clerk got the dashboard approvals card — the card was widened to match the inbox, which removes the segregation of duties collectApClerk() exists to create',
      ).toBe(false);
    }
  });
}

/**
 * ── The positive control ─────────────────────────────────────────────────────────────
 *
 * THIS TEST IS NOT OPTIONAL, and it is not redundant with the loop above.
 *
 * `expect(html).not.toContain('Reports to approve')` is green when the string is
 * misspelled, when the catalog key moved, when the page 500s, and when the request never
 * reached the app at all. Every one of those is a broken product reported as a passing
 * permission assertion. The only defence is to prove the needle FINDS something first, in
 * the same run, through the same read — so this signs in as an approver, asserts the card
 * is there, then swaps identity to the one seeded role that may work the inbox but may not
 * decide, and asserts it is not.
 *
 * Both halves are one test on purpose. Split across two, a suite that skipped or failed
 * the positive half would still report the negative half as passing.
 */
test('the approvals card: a positive control, then the negative', async ({ page }) => {
  // qa.manager holds the `employee` system role, which carries `expense.report.approve`,
  // and `qa-activity.json` puts six pending tasks in their queue.
  await signIn(page, 'manager');
  const approver = await readDashboardCards(page);
  expect(
    approver.approvalsGate,
    'the approver was not granted the card — every assertion below this line would be vacuous',
  ).toBe('true');
  expect(
    approver.approvalsRendered,
    `no rendered "${APPROVALS_CARD}" heading was found in an approver's dashboard. Until one is, the negative assertion below proves nothing: check the EN catalog key dashboard.cards.approvals.title, and check that SectionCard still renders its title in a heading element — the needle is the heading markup, not the string`,
  ).toBe(true);

  // Same page, same read, different person. `test.use` at the top of this file gives every
  // test an empty storage state, so clearing cookies returns this context to anonymous.
  await page.context().clearCookies();
  await signIn(page, 'apClerk');
  const clerk = await readDashboardCards(page);
  expect(clerk.approvalsGate, 'the AP clerk was granted the approvals card').toBe('false');
  expect(
    clerk.approvalsRendered,
    'the AP clerk got the approvals card — and the positive control above proves this needle finds a real card, so this is the gate, not the needle',
  ).toBe(false);
});

/**
 * ── The report page: an AP clerk may READ a report, and may not DECIDE it ────────────
 *
 * `/expenses/<id>` admits exactly the `canViewReport` audience. `ap-clerk` is in it by
 * permission — it holds `expense.report.read.all` and `expense.report.reimburse`, either of
 * which admits it — and it is the one seeded role that may work every report while holding
 * no approval grant at all (`systemRoles.ts`, `collectApClerk`: "`reimburse` but NOT
 * `approve`"). So it is the role that tells "may read" from "may decide" apart on this page.
 *
 * Two halves, in one test for the reason the approvals-card test gives:
 *
 *   · REACH: the page answers 200 and renders the report — its title in the top bar, and not
 *     the `(app)` not-found face. A page that turned the clerk away would fail here.
 *   · NO DECISION: none of Approve, Reject, Return for edits is offered. The report is
 *     SUBMITTED and pending on `qa.manager`; the clerk holds no task on it and no
 *     `decide.any`, so the page must not take approver mode. Cosmetic in the UI — the server
 *     refuses the decide regardless — but a control offered and then refused is the defect
 *     this asserts the absence of.
 *
 * The negatives wait on the title first: the title and the action list come from the same
 * report read and render in the same pass (`useTopBarSlots`), so once the title is on screen
 * a decide control that was going to render has rendered.
 *
 * The report is `qa-activity.json`'s submitted one, the same fixture `dashboard.spec.ts` and
 * `approval-deeplink.spec.ts` open. This test creates nothing.
 */
test('the AP clerk opens a report it may read, and is offered no decision on it', async ({
  page,
  browser,
}) => {
  // VeloExpense: a report the employee really submits, pending on the manager — ExpenseOS opens
  // `qa-activity.json`'s. Like the seed's, it is left in place.
  const title = `QA — Submitted ${reportTag('ap clerk')}`;
  const report = { id: await submitQueuedReport(browser, title), title } as const;
  const copy = approvalsCatalog('en');

  await signIn(page, 'apClerk');
  // VeloExpense: no locale segment.
  const res = await page.goto(`/expenses/${report.id}`);
  expect(res?.status(), 'the report page refused a reader `canViewReport` admits').toBe(200);

  await expect(
    page.getByText(report.title).first(),
    'the AP clerk reached the report page but the report did not load',
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText(commonCatalog('en').notFound.title);

  for (const label of [copy.approve, copy.reject, copy.return]) {
    await expect(
      page.getByRole('button', { name: label, exact: true }),
      `the AP clerk was offered "${label}" on a report they hold no task on — the page took approver mode for a reader who may only read`,
    ).toHaveCount(0);
  }
});

/*
 * VeloExpense: ExpenseOS's "a signed-in visitor cannot be redirected off-site by ?callbackUrl"
 * is not here. It rests on ExpenseOS's `/login` sending a SIGNED-IN visitor on to `?callbackUrl`;
 * VeloExpense's `/login` renders its form for everybody and only uses the value after an SSO
 * sign-in, which this suite cannot drive (`e2e/auth.setup.ts` mints sessions). The guard itself
 * — the same hostile inputs, `//`, `/\` and an absolute URL — is pinned in
 * `test/callback-url.test.ts`. Likewise ExpenseOS's AP-clerk virtual-card test and its helpers:
 * VeloExpense has no virtual cards.
 */

test.afterAll(() => {
  if (!matrix.length) return;
  // Widened on purpose: `Row.kind` is a plain string, so indexing a readonly tuple of
  // literals with it does not typecheck. The order is data here, not a constraint.
  const order: string[] = ROLES.map((r) => r.kind);
  matrix.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const lines = [
    '# Permission matrix (observed, by signing in)',
    '',
    '`200` reached it · `404`/`403` refused by the server · `redirected` bounced away',
    '',
    `| Route | ${matrix.map((m) => m.kind).join(' | ')} |`,
    `|---|${matrix.map(() => '---').join('|')}|`,
    ...PROBES.map(
      (p) => `| \`${p}\` | ${matrix.map((m) => String(m.reach[p] ?? '—')).join(' | ')} |`,
    ),
    '',
    '## Dashboard cards',
    '',
    "The server's own decision (`data-dashboard-*`) and whether the card's own heading was",
    'actually rendered, both read off the same response body. A row where the two disagree is',
    'a bug in the page, not in the permission set.',
    '',
    `| Card | ${matrix.map((m) => m.kind).join(' | ')} |`,
    `|---|${matrix.map(() => '---').join('|')}|`,
    `| travel (gate) | ${matrix.map((m) => m.cards.travelGate ?? '—').join(' | ')} |`,
    `| travel (rendered) | ${matrix.map((m) => String(m.cards.travelRendered)).join(' | ')} |`,
    `| approvals (gate) | ${matrix.map((m) => m.cards.approvalsGate ?? '—').join(' | ')} |`,
    `| approvals (rendered) | ${matrix.map((m) => String(m.cards.approvalsRendered)).join(' | ')} |`,
    `| expenses (gate) | ${matrix.map((m) => m.cards.expensesGate ?? '—').join(' | ')} |`,
    `| expenses (rendered) | ${matrix.map((m) => String(m.cards.expensesRendered)).join(' | ')} |`,
    '',
    '## Sidebar sections offered',
    '',
    ...matrix.map((m) => `- **${m.kind}**: ${m.sections.join(', ') || '(none)'}`),
    '',
  ];
  writeFileSync('e2e-permission-matrix.md', `${lines.join('\n')}\n`);
  console.log('\npermission matrix → e2e-permission-matrix.md');
});

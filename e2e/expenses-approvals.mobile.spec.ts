import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { ACTORS, type Actor, signIn } from './support/actors';
import { PHONE_PROJECTS } from './support/phone-projects';
import { QUEUED_VENDOR, submitQueuedReport } from './support/seed-activity';
import { assertCoarsePointer, assertProject } from './support/tap-targets';
import { closeTestDb, testDb as sharedTestDb } from './support/test-db';
import { reportTag } from './support/workbench';

/**
 * VeloExpense: ExpenseOS's `e2e/expenses-approvals.mobile.spec.ts` (1e682dd6), ported with its
 * phone specs. The inbox and the drawer are ExpenseOS's (w4-05/w4-07, #573). The changes are
 * marked `VeloExpense:` where they are made:
 *
 *   · EN ONLY. VeloExpense offers no French (`i18n/request.ts`), so the FR-CA footer this
 *     header argues for has no page to run on. `LOCALES` keeps one entry.
 *   · THE SUBJECT IS SUBMITTED THROUGH THE WORKBENCH, NOT MINTED. ExpenseOS's
 *     `mintDisposableApproval` runs Prisma and `startInstance` in the Playwright process, and
 *     VeloExpense's generated client cannot load there (`e2e/support/test-db.ts`). So the
 *     employee files and submits a report of this test's own (`submitQueuedReport`), and the
 *     real submit starts the real workflow — the same property the mint was built for: a
 *     task nobody else reads, decided once and disposed of. Two consequences, each marked
 *     below: the approver and the task status are read with SQL, and the report CARRIES one
 *     expense, so the drawer's anti-vacuity check is that expense's vendor rather than
 *     `drawer.noExpenses`.
 *   · NO LOCALE SEGMENT in any URL.
 *
 * `/expenses/approvals` on a phone: SEE THE QUEUE, OPEN A REPORT, DECIDE IT WITH A COMMENT —
 * and prove the card geometry of all three queues while doing it.
 *
 * ─── THIS ROUTE IS RULED `limited`, AND THE ROUGH EDGES ARE NAMED RATHER THAN BUILT ─────
 *
 * P05 adopts T03's `DataTableMobileConfig` here (Phase 1) and reflows `ApproverReportDrawer`
 * at 360 (Phase 2), then rules the route `limited` rather than the `ready` the ticket
 * proposed. `mobileReadiness.ts:183-185` is the authority for this file existing at all:
 *
 *   > That split is why the row is `limited` and not `ready`, and it is also why `limited`
 *   > here carries a flow spec even though a `limited` row owes none: the half that works is
 *   > worth proving, and the half that does not is worth naming.
 *
 * WHAT WORKS, and is what every assertion below is about: the queue renders as cards, a card
 * opens the approver drawer, and the drawer decides the report — comment and all — at 360px.
 *
 * WHAT DOES NOT, and is deliberately asserted about in the NEGATIVE only:
 *
 *   · BULK APPROVE IS UNREACHABLE. `mobile.selectable` is off, so no card carries a
 *     checkbox, so `DataTableToolbar`'s bulk-approve trigger has nothing to act on at a
 *     phone width. `ExpenseApprovalsInbox.tsx` states the reason at the call site —
 *     "ticking rows nothing can act on is worse than not ticking them". This file asserts
 *     the checkbox's ABSENCE and says nothing about how bulk approve might be reached; an
 *     assertion that drove it would be asserting a flow the ruling explicitly names as
 *     missing.
 *   · THERE IS NO CARD KEBAB. `rowActions` is refused, not omitted: a kebab offering a quick
 *     Approve would let somebody decide a financial approval without ever seeing the policy
 *     violations or the missing-receipt state, which live inside the drawer. This file
 *     asserts the kebab's absence for the same reason and in the same shape. Note the
 *     contrast with `/expenses`, whose cards DO carry one — `e2e/expenses.mobile.spec.ts`
 *     does not assert an absence there, and must not be copied across.
 *
 * Both absences are asserted structurally — exactly one `<button>` per card, zero
 * `checkbox` roles — rather than by hunting for a named control. A count is the one form
 * that cannot rot when somebody renames a label.
 *
 * ─── THE SUBJECT IS MINTED, AND THAT IS A BUILD PRECONDITION, NOT A PREFERENCE ──────────
 *
 * This spec NEVER decides one of the six seeded tasks. Deciding a seeded task is a one-way,
 * shared, cross-project mutation: `playwright.config.ts` puts this file in `mobile-360`,
 * `mobile-390` and `mobile-412`, all four projects share one `expenseos_e2e`, and the two
 * locale tests inside each project run concurrently under `fullyParallel` — so one decision
 * written here is SIX per `npm run test:e2e:mobile`. Six seeded tasks would not survive a
 * second run, `reassertApprovalInstance` only restores at re-seed time, and every phone
 * project sets `retries: 0` on purpose, so there is no retry to paper over it. The queue
 * would go empty and the failure would read as a defect in a page that is fine.
 *
 * `mintDisposableApproval()` is the alternative and it already exists: it copies a
 * currently-routing seeded report's header facts, creates its own `ExpenseReport` under the
 * `E2E act-once ` marker, runs the real `startInstance`, asserts the parked task is exactly
 * one and is assigned to somebody other than the submitter, and hands back `readTaskStatus()`
 * and `dispose()`. Read the `DISPOSABLE_TITLE_PREFIX` block in
 * `e2e/support/authPageFixtures.ts` before touching any of this — it documents a live
 * cross-worker window in which one worker's template search finds another worker's
 * throwaway, and why the lookup in that file skips the marker.
 *
 * TWO CONSEQUENCES OF THE MINT SHAPE, both load-bearing here:
 *
 *   1. The copy carries NO EXPENSES, so the drawer renders `drawer.noExpenses`. The decide
 *      controls are what is asserted, never an expense list.
 *   2. The approver is READ OUT OF THE DATABASE, not assumed. The fixture routes through the
 *      real workflow, so who it parks on is the seeded org chart's answer, not this file's.
 *      `whoApproves()` below resolves it to a named actor and fails loudly if it resolves to
 *      somebody with no stored session — which is strictly better than signing in as
 *      `manager` and reading an empty queue as a layout bug.
 *
 * ─── THE DECISION DRIVEN IS *REJECT*, AND THAT CHOICE IS WHAT MAKES `decided` MEASURABLE ─
 *
 * All four idle-footer controls are asserted PRESENT and on-screen. Exactly one is driven,
 * because one minted subject carries one task, and it is Reject:
 *
 *   · `myDecided` selects tasks with `status IN ('APPROVED','REJECTED')` and
 *     `decidedById = me`. RETURN does not qualify — it skips the pending tasks and flips the
 *     report to RETURNED — so a spec that returned would leave the `decided` queue EMPTY on a
 *     fresh seed (`qa.manager` has decided nothing) and its card-geometry assertion would
 *     have nothing to measure. Rejecting puts a card this test owns into that queue.
 *   · Reject's note is REQUIRED (`disabled={pending || (mode === 'reject' && !note.trim())}`),
 *     so driving it proves the comment path is a gate rather than a decoration. Return's is
 *     optional and would have proved less.
 *   · Approve was the other candidate that populates `decided`, and it is the wrong one to
 *     leave behind: an approved report advances toward reimbursement and posting. Reject is
 *     terminal and inert, and `dispose()` removes it either way.
 *
 * ─── IT RUNS BOTH LOCALES, AND THE DRAWER FOOTER IS WHY ─────────────────────────────────
 *
 * Four controls on one row at 360px, and the French labels are materially longer:
 * "Retourner pour modification" against "Return for edits", "Approuver" against "Approve".
 * That row is precisely what Phase 2's `flex-wrap` was added for, and jsdom cannot lay it
 * out — `ApproverReportDrawer.test.tsx` pins the CLASS and says so. An en-only run passes
 * over the exact screen this ruling is supposed to certify. `e2e/crawl-mobile.spec.ts:274` is
 * `const LOCALE = 'en';` and `e2e/support/routes.ts:14-18` records that hoisting it was
 * refused, so for a route whose phone risk is label length the flow spec is the only place
 * French coverage can exist.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * At 360, 390 and 412, in EN and in FR-CA, with a coarse primary pointer proven first, signed
 * in as the approver the workflow actually chose:
 *
 *   · the page renders itself and not the desktop-only notice;
 *   · the CARD tree mounted, nothing paints past the viewport unclipped, and no card field
 *     paints outside its own card — in ALL THREE QUEUES, each with its own field pair
 *     (`total`+`submitted`, `total`+`decision`, `total`+`with`);
 *   · no card carries a checkbox and no card carries a kebab;
 *   · the compact chrome row holds the two sheet triggers, and the SORT sheet renders the
 *     honest `table.mobile.sortEmpty` state because no column here declares `sortable`;
 *   · a TAP on a card's title opens `ApproverReportDrawer`, whose panel is clamped inside the
 *     viewport by `max-w-full` despite a `width={600}` request — the assertion that exists
 *     because nothing else can make it (see below);
 *   · all four decide controls are visible and INSIDE the viewport, i.e. the footer wrapped
 *     rather than pushing the primary action off the right edge;
 *   · Confirm reject is DISABLED with an empty note and enabled once one is typed;
 *   · the decision reached the SERVER — `ApprovalTask.status` read out of the database, not a
 *     drawer that closed;
 *   · the queue can be SWITCHED from a phone, through the filter sheet, which is the only
 *     mechanism there is below `md`.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH — READ BEFORE CITING THIS FILE ─────────────────
 *
 * IT IS NOT THE `ready` EVIDENCE PACK and cannot become it by growing. Two flows are named as
 * missing above and neither is a test problem.
 *
 * THE MOBILE CRAWL CANNOT MAKE THE DRAWER CLAIM, WHICH IS WHY IT IS HERE.
 * `e2e/crawl-mobile.spec.ts:40-47` states in terms that its measurement is
 * `main#main-content.scrollWidth` against its `clientWidth`, and that dialogs and drawers
 * portal to `<body>` and are therefore structurally invisible to it — "a drawer 80px wider
 * than the screen … all green here". `DrawerContent` asks for 600px and carries `max-w-full`
 * on its `side='right'` branch; that clamp is what is being proved, and nothing else in the
 * suite proves it.
 *
 * IT DOES NOT MEASURE TAP TARGETS. `e2e/tap-targets.mobile.spec.ts` rules `arrive` is
 * "DELIBERATELY RARE" and that driving controls open "would put an interaction on the
 * critical path of a geometry gate", so the drawer's four buttons are not censused there
 * either. What this file asserts is that they are ON SCREEN and REACHABLE — a different claim
 * from 44px, and one a control can fail while meeting the floor.
 *
 * IT DOES NOT TOUCH THE SEEDED QUEUE'S COUNT. `e2e/no-manager-approval.spec.ts` and
 * `e2e/permissions.spec.ts` read the same six tasks; nothing here may change them. The
 * `pending` sweep therefore asserts "at least the minted card, and every card is well formed"
 * and never a number.
 *
 * IT SAYS NOTHING ABOUT THE READ-ALL-WITHOUT-APPROVE APPROVER. `approvals/page.tsx:28` admits
 * `approve || reimburse || readAll`, so a read-all viewer reaches this inbox and must not see
 * decide controls — and on a card "the actions are absent" and "the actions are off the
 * bottom of a 360px drawer" look identical. No seeded actor holds that combination, so
 * covering it needs a seed change, which is outside a page task by the
 * `docs/design/pwa.md:622` precedent. Named here so the absence is a decision.
 */

/**
 * Both locales, always. `E2E_LOCALE` narrows it so one can be run on its own — the same knob,
 * spelled the same way, as `e2e/delegations.mobile.spec.ts` and `e2e/topbar-overlap.spec.ts`.
 */
type Locale = 'en' | 'fr-CA';
// VeloExpense: EN only — VeloExpense offers no French (`i18n/request.ts`). See the header.
const LOCALES: Locale[] = ['en'];

/**
 * Longer than the 45s default. One test mints a real approval through the real engine, drives
 * a decision, and then walks all three queues switching between them through a bottom sheet —
 * on one `next dev` server shared by three phone projects running concurrently.
 *
 * ONE TEST PER LOCALE RATHER THAN SEVERAL, and that is a concurrency decision. Each test
 * needs its own minted subject, and the `decided` assertion needs the subject THIS test
 * rejected; splitting would mean two or three subjects per cell, i.e. twelve to eighteen
 * concurrent mints per mobile run, all competing for the same twenty-candidate template
 * window in `mintDisposableApproval`.
 */
test.describe.configure({ timeout: 180_000 });

/** The copy, read per locale off the catalogs. Same reasoning, verbatim, as
 *  `e2e/expenses.mobile.spec.ts`: `e2e/support/catalog.ts` exports no approvals accessor,
 *  widening it is a parked follow-up, and doing it inside a page task is the risk
 *  `e2e/delegations.mobile.spec.ts` already declined. `tsconfig.e2e.json` sets neither
 *  `paths` nor `resolveJsonModule`, hence `readFileSync` + `JSON.parse`. */
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

function copyFor(locale: Locale) {
  return {
    /** The TopBar `h1` — `ROUTE_TITLE_KEYS['/expenses/approvals']` is `approvalsQueue`.
     *  Read locally rather than through `navCatalog`, which exposes `expenseReports` and
     *  `delegations` only. */
    title: text(locale, 'nav', 'items.approvalsQueue'),
    /** The `<dt>` terms the card prints beside each field value, per queue. */
    columns: {
      total: text(locale, 'expenses', 'columns.total'),
      submitted: text(locale, 'expenses', 'approvals.submitted'),
      decided: text(locale, 'expenses', 'approvals.decidedColumn'),
      with: text(locale, 'expenses', 'approvals.withColumn'),
    },
    /** The `queue` clause: its field label and its three enum option labels. */
    queue: {
      label: text(locale, 'expenses', 'approvals.queue'),
      pending: text(locale, 'expenses', 'approvals.viewPending'),
      decided: text(locale, 'expenses', 'approvals.viewDecided'),
      team: text(locale, 'expenses', 'approvals.viewTeam'),
    },
    /** The drawer's idle footer, plus the reject two-step. */
    drawer: {
      noExpenses: text(locale, 'expenses', 'drawer.noExpenses'),
      close: text(locale, 'expenses', 'drawer.close'),
      approve: text(locale, 'expenses', 'approvals.approve'),
      reject: text(locale, 'expenses', 'approvals.reject'),
      return: text(locale, 'expenses', 'approvals.return'),
      rejectNotePlaceholder: text(locale, 'expenses', 'approvals.rejectNotePlaceholder'),
      confirmReject: text(locale, 'expenses', 'approvals.confirmReject'),
    },
    /** The compact chrome, from the already-bilingual `table.*` namespace. */
    sheet: {
      filtersTrigger: text(locale, 'table', 'mobile.filtersTrigger'),
      filtersTitle: text(locale, 'table', 'mobile.filtersTitle'),
      sortTrigger: text(locale, 'table', 'mobile.sortTrigger'),
      sortTitle: text(locale, 'table', 'mobile.sortTitle'),
      sortEmpty: text(locale, 'table', 'mobile.sortEmpty'),
      clearSort: text(locale, 'table', 'mobile.clearSort'),
      done: text(locale, 'table', 'mobile.done'),
    },
    /** `FilterBlock`'s per-value controls, which are how the queue is switched. */
    filters: {
      addValue: text(locale, 'table', 'filters.addValue'),
      removeValue: text(locale, 'table', 'filters.removeValue'),
    },
  };
}

/** Lazily, through `e2e/support/test-db.ts`, so a missing `DATABASE_URL` in the PLAYWRIGHT
 *  process fails with the fix in the message rather than pointing at the server. */
const testDb = () => sharedTestDb('expenses-approvals.mobile');

/**
 * VeloExpense: the shape ExpenseOS's `mintDisposableApproval` hands back
 * (`e2e/support/authPageFixtures.ts`), built from a report the employee really submitted.
 */
interface DisposableApproval {
  title: string;
  assigneeUserId: string;
  readTaskStatus: () => Promise<string>;
  dispose: () => Promise<void>;
}

/**
 * VeloExpense: in place of ExpenseOS's `mintDisposableApproval`. See the header.
 *
 * The title carries ExpenseOS's `E2E act-once ` marker and a unique tag, so the card is this
 * test's by construction. The task is read back once it is PENDING — polled, because the
 * workflow starts on the submit and the queue is what the test then reads — and exactly one
 * must exist, assigned to somebody other than the employee, as the mint asserts.
 */
async function mintDisposableApproval(browser: Browser): Promise<DisposableApproval> {
  const title = `E2E act-once ${reportTag('phone approvals')}`;
  const reportId = await submitQueuedReport(browser, title);
  const db = await testDb();

  const pendingTasks = async () =>
    (
      await db.query<{ id: string; assignee: string | null; submitter: string }>(
        `SELECT t.id, t.assignee_user_id AS assignee, r.submitter_id AS submitter
           FROM approval_instance_task t
           JOIN approval_instance i ON i.id = t.instance_id
           JOIN expense_report r ON r.id = i.subject_id
          WHERE i.subject_id = $1 AND t.status = 'PENDING'`,
        [reportId],
      )
    ).rows;
  await expect
    .poll(async () => (await pendingTasks()).length, {
      timeout: 30_000,
      message: `the submitted report "${title}" parked no PENDING approval task`,
    })
    .toBe(1);
  const [task] = await pendingTasks();
  if (!task?.assignee || task.assignee === task.submitter) {
    throw new Error(
      `expenses-approvals.mobile: the task for "${title}" is unassigned or assigned to its own ` +
        'submitter, so no approver can see it',
    );
  }
  const taskId = task.id;

  return {
    title,
    assigneeUserId: task.assignee,
    readTaskStatus: async () =>
      (
        await db.query<{ status: string }>(
          'SELECT status FROM approval_instance_task WHERE id = $1',
          [taskId],
        )
      ).rows[0]?.status ?? '(gone)',
    // Never throws, as ExpenseOS's does not: a cleanup error must not replace the test's own.
    dispose: async () => {
      try {
        await db.query('DELETE FROM approval_instance WHERE subject_id = $1', [reportId]);
        await db.query('DELETE FROM expense_report WHERE id = $1', [reportId]);
      } catch (e) {
        console.warn(`[expenses-approvals.mobile] could not remove "${title}":`, e);
      }
    },
  };
}

/**
 * Which seeded actor the minted task actually parked on.
 *
 * READ, NOT ASSUMED, and this is the difference between a green run that means something and
 * one that measures an empty queue. `mintDisposableApproval` copies a template report and
 * runs the REAL `startInstance`, so the approver is whatever the seeded org chart and the
 * seeded workflow decide. Four of the nine seeded accounts report to `qa.manager`
 * (`seed-data/test-users.json`) and every routed seed report parks on them, so `manager` is
 * the expected answer — but "expected" is not "asserted", and signing in as the wrong person
 * would show a queue with no card in it, which reads as a layout defect rather than as a
 * fixture mismatch.
 *
 * Throws with the address in the message if the assignee is not one of the nine, because
 * `signIn` loads a stored session from `e2e/.auth/<actor>.json` and there is none to load.
 */
async function whoApproves(assigneeUserId: string): Promise<Actor> {
  const db = await testDb();
  // VeloExpense: SQL on the admin pool.
  const user = (
    await db.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [
      assigneeUserId,
    ])
  ).rows[0];
  if (!user) {
    throw new Error(
      `expenses-approvals.mobile: the minted task is assigned to user ${assigneeUserId}, which ` +
        'does not exist. The database changed under the fixture; rebuild it with ' +
        '`npm run test:e2e:setup`.',
    );
  }
  const actor = (Object.keys(ACTORS) as Actor[]).find((a) => ACTORS[a] === user.email);
  if (!actor) {
    throw new Error(
      `expenses-approvals.mobile: the minted approval parked on ${user.email}, which is not ` +
        'one of the seeded QA actors, so `e2e/setup/actors.setup.ts` recorded no session for ' +
        'it and this spec cannot become that person. Either the seeded org chart moved, or ' +
        'the expense-report workflow now routes somewhere new — both are findings about the ' +
        'approval engine rather than about this page.',
    );
  }
  return actor;
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * Geometry
 *
 * COPIED from `e2e/datatable-mobile.spec.ts` rather than imported, and the reason is the one
 * `e2e/delegations.mobile.spec.ts` states about `topbar-overlap.spec.ts`: that file declares
 * its own `test()` calls, so importing from it would run its whole suite a second time inside
 * this one. `e2e/expenses.mobile.spec.ts` carries the same pair for the same reason; promoting
 * them into `e2e/support/` is the right long-term shape and is a different task's diff.
 *
 * What is NOT copied is the resizing: `datatable-mobile.spec.ts` is chromium-only and sizes
 * its own viewport, so it never runs under `isMobile` emulation and is not in
 * `npm run test:e2e:mobile` at all. It also only ever sweeps `/expenses`; this route is
 * measured here or nowhere.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** Every node painted past the viewport's right edge that nothing is clipping. A wide node
 *  inside a scroller is not a defect; a wide node with nothing between it and the document
 *  is the one that drags the page sideways. */
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

/** No card field paints outside its own card, and the sweep actually swept something. */
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
 * The queue
 * ──────────────────────────────────────────────────────────────────────────────────────── */

const cardsIn = (page: Page) => page.locator('#main-content [id^="data-card-"]');

/**
 * The sheet a trigger inside the compact row opens, addressed by its own title.
 *
 * `.first()` for the reason `e2e/expense-lifecycle.spec.ts:57-58` records: a closed drawer
 * elsewhere in the tree also matches `dialog`, and a strict locator then waits on something
 * that will never become visible. On this page the approver drawer is a third `dialog`, so
 * the title filter is doing real work rather than tidying.
 */
function sheetTitled(page: Page, title: string) {
  return page.getByRole('dialog').filter({ hasText: title }).first();
}

/**
 * One queue's card geometry, for whichever queue is currently mounted.
 *
 * `expectedTerms` is the `<dt>` list the card renderer prints beside each field value, and it
 * is the whole reason all three queues are walked: `fields` is VIEW-DEPENDENT
 * (`['total','submitted']` / `['total','decided']` / `['total','with']`), so a card config
 * validated against `pending` alone can be silently wrong for the other two — more content in
 * the same card width. Asserting the terms is simultaneously a check that the right columns
 * were named for this view and that both labels came through the catalog in this locale.
 *
 * Also the place both capability refusals are asserted, structurally:
 *
 *   · ZERO `checkbox` roles. `mobile.selectable` is off, so `DataTableCards` never renders
 *     its 44x44 slot or the `Checkbox` inside it.
 *   · EXACTLY ONE `<button>` per card — the title button that opens the drawer. A kebab would
 *     be a second one and a checkbox slot would not be a button at all, so the pair of counts
 *     pins both refusals without naming either control. That matters: a label-based assertion
 *     would start passing the day somebody renamed the control it was watching for.
 */
async function assertQueueCards(page: Page, where: string, expectedTerms: string[]): Promise<void> {
  const cards = cardsIn(page);
  await expect
    .poll(() => cards.count(), {
      timeout: 60_000,
      message:
        `${where}: no cards mounted. Either the queue's tRPC query never landed, or the ` +
        'DESKTOP grid mounted instead — which is what a removed `mobile` config on ' +
        'ExpenseApprovalsInbox.tsx looks like from here.',
    })
    .toBeGreaterThan(0);

  await expectNoSidewaysScroll(page, where);
  await expectNoCardSlotSpill(page, where);

  const first = cards.first();
  await expect(first.locator('[data-dt-card-slot="title"]')).toHaveCount(1);
  await expect(first.locator('[data-dt-card-slot="subtitle"]')).toHaveCount(1);
  await expect(first.locator('[data-dt-card-slot="badge"]')).toHaveCount(1);
  await expect(
    first.locator('dt'),
    `${where}: the card's field terms are not [${expectedTerms.join(', ')}] — this queue's ` +
      '`fields` entry names different columns than the card is printing',
  ).toHaveText(expectedTerms);

  await expect(
    cards.getByRole('checkbox'),
    `${where}: a card carries a selection checkbox. \`mobile.selectable\` is deliberately ` +
      'off — bulk approve has no 360px layout, and ticking rows nothing can act on is worse ' +
      'than not ticking them. Turning it on is a product decision, not a test fix.',
  ).toHaveCount(0);

  /**
   * Exactly one `<button>` per card — the title button — taken as ONE atomic snapshot.
   *
   * Two separate locator counts (cards, then buttons) would be two reads of a list that is
   * still settling, and the difference between them would read as a kebab. One
   * `page.evaluate` closes that window and reports WHICH card and HOW MANY, which is what a
   * reader of the failure needs.
   */
  const extraButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#main-content [id^="data-card-"]'))
      .map((card) => ({
        id: card.id,
        buttons: card.querySelectorAll('button').length,
        text: (card.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40),
      }))
      .filter((c) => c.buttons !== 1),
  );
  expect(
    extraButtons,
    `${where}: a card does not carry exactly one button. The title button is the only one ` +
      'there should be: `rowActions` is REFUSED on this page, not omitted — a kebab offering ' +
      'a quick Approve would let somebody decide a financial approval without ever seeing ' +
      'the policy violations or the missing-receipt state, which live inside the drawer. Do ' +
      `not "close the gap" here.\n${extraButtons
        .map((c) => `  ${c.id} has ${c.buttons} — "${c.text}"`)
        .join('\n')}`,
  ).toEqual([]);
}

/**
 * Switch queues from a phone — the ONLY mechanism there is below `md`.
 *
 * `FilterPillBar` carries both the `queue` pill and the saved-views dropdown, and it is
 * `TABLE_ONLY` (`hidden md:block`); the page reads no `?view=` parameter (`useDeepLink('report')`
 * is its only search-param reader). So the filter sheet is it, and
 * `ExpenseApprovalsInbox.tsx` says so at the mount site: "THIS is how the queue is switched on
 * a phone."
 *
 * ADD THEN REMOVE, AND THE ORDER IS LOAD-BEARING. `view` is derived with
 * `tableState.filters.find((c) => c.field === 'queue')` — the FIRST matching clause — and
 * `addClause` appends. So adding the new value while the old one is still first changes
 * nothing, and the removal is what commits the switch. Doing it the other way round is also
 * legal (an absent queue clause falls back to `pending`) but it costs a trip through
 * `AddFilterPill`'s four-control popover instead of two taps inside a block already on
 * screen.
 */
async function switchQueue(
  page: Page,
  copy: ReturnType<typeof copyFor>,
  from: string,
  to: 'decided' | 'team',
  toLabel: string,
): Promise<void> {
  await page.locator('#approvals-mobile-controls').getByRole('button').first().tap();
  const sheet = sheetTitled(page, copy.sheet.filtersTitle);
  await expect(sheet, 'the filter trigger did not open the filter sheet').toBeVisible({
    timeout: 20_000,
  });
  await expect(
    sheet.getByText(copy.queue.label, { exact: true }).first(),
    `the filter sheet has no "${copy.queue.label}" block, so there is no way to change queue ` +
      'from a phone at all. The clause is seeded on mount in `ExpenseApprovalsInbox.tsx`; if ' +
      'it is gone, the three queues are unreachable below `md`.',
  ).toBeVisible({ timeout: 20_000 });

  // The `+` on the queue block. `enum` + a non-text op means the value chip itself is inert,
  // so a second value has to be added before the first can be taken away.
  await sheet.getByRole('button', { name: copy.filters.addValue, exact: true }).first().tap();

  const valueSelect = sheet.locator('select');
  await expect(
    valueSelect,
    "expected exactly one native <select> in the open filter sheet — the queue block's " +
      '"add another value" picker',
  ).toHaveCount(1);
  // By VALUE (`decided` / `team`), which is what `view` keys on; the label is only what the
  // catalog translates.
  await valueSelect.selectOption(to);

  /**
   * Now drop the outgoing value, which is what actually commits the switch.
   *
   * `.last()`, not `.first()`, and it matters: THREE nested `<span>`s contain the outgoing
   * value's button — the `FilterBlock` root, the per-clause wrapper, and the chip itself —
   * and `locator('span')` yields ancestors before descendants. The two outer ones now hold
   * TWO value chips (the incoming value was just added), so each holds two "remove value"
   * buttons and a strict locator inside either would be ambiguous. `.last()` is the chip.
   */
  const outgoing = sheet
    .locator('span')
    .filter({ has: page.getByRole('button', { name: from, exact: true }) })
    .last();
  await outgoing.getByRole('button', { name: copy.filters.removeValue, exact: true }).tap();

  /**
   * The outgoing value is GONE from the sheet — and this is the assertion that has to be
   * here rather than on the trigger's count.
   *
   * `groupClauses` groups by (field, op), so `queue equals pending` and `queue equals decided`
   * are ONE group and the trigger would read `Filters · 1` either way. A count assertion would
   * therefore pass over a failed removal, and `view` — which reads the FIRST matching clause —
   * would still be answering with the old queue. The card `<dt>` terms asserted by the caller
   * are the second, independent proof that the switch landed.
   */
  await expect(
    sheet.getByRole('button', { name: from, exact: true }),
    `"${from}" is still a value on the queue clause after switching to "${toLabel}". ` +
      '`view` reads the FIRST `queue` clause it finds, so the page is still showing the old ' +
      'queue.',
  ).toHaveCount(0, { timeout: 20_000 });

  await sheet.getByRole('button', { name: copy.sheet.done, exact: true }).tap();
  await expect(sheet).toBeHidden({ timeout: 20_000 });
}

for (const locale of LOCALES) {
  test.describe(`/expenses/approvals on a phone — ${locale}`, () => {
    /** Torn down even when the test failed, and nulled so a failure in the mint itself cannot
     *  throw on top of the real error. `dispose()` never throws by design. */
    let subject: DisposableApproval | null = null;

    test.beforeEach(async ({ page }, testInfo) => {
      // Fails in ~0ms and names the project, rather than after a mint and a sign-in.
      // `page` is destructured only so `beforeEach` receives `testInfo` in the second
      // position.
      void page;
      assertProject(testInfo, PHONE_PROJECTS);
    });

    test.afterEach(async () => {
      const current = subject;
      subject = null;
      if (current) await current.dispose();
    });

    // VeloExpense: the admin pool `testDb` opens, closed once the file is done.
    test.afterAll(async () => {
      await closeTestDb();
    });

    test('the queue reads, a report opens, and it is rejected with a comment', async ({
      page,
      browser,
    }, testInfo) => {
      const copy = copyFor(locale);

      // ── A subject of this test's own, and the person the engine routed it to ─────────
      // VeloExpense: submitted through the workbench rather than minted. See the header.
      const mint = await mintDisposableApproval(browser);
      subject = mint;
      const approver = await whoApproves(mint.assigneeUserId);
      await signIn(page, approver);

      // VeloExpense: no locale segment.
      const route = '/expenses/approvals';
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `GET ${route} did not answer 200 for ${approver}`).toBe(200);
      expect(
        await page.locator('[data-testid="offline-page"]').count(),
        `the service worker served the offline fallback in place of ${route}`,
      ).toBe(0);
      // Under a fine pointer this is a desktop test in a small window: the compact tree would
      // not mount and `.tap()` is not the gesture under test.
      await assertCoarsePointer(page);

      /**
       * A `limited` route that suppressed its own page.
       *
       * `DesktopOnlyNotice` renders for `disposition === 'desktop'` alone; `limited` and
       * `ready` both render the page untouched. A row typed `desktop` by mistake, or a glob
       * ruling widened across this route, replaces the page with a notice at every phone
       * width — and `mobileReadiness.test.ts` stays GREEN, because the markdown and the
       * registry would agree with each other about the wrong answer.
       */
      expect(
        await page.locator('[data-testid="desktop-only-notice"]:visible').count(),
        `${route} rendered the desktop-only notice at ${testInfo.project.name}.`,
      ).toBe(0);

      // ── The compact chrome, and the honest empty sort sheet ──────────────────────────
      const controls = page.locator('#approvals-mobile-controls');
      await expect(
        controls,
        'the compact chrome row is not on screen. It is JS-gated on `useIsCompact()` ' +
          '(`max-width: 767.98px`) whose SSR snapshot is `false`, so it exists only after ' +
          'hydration — and it is `md:hidden`, so a project whose emulation did not apply ' +
          'would also land here.',
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        controls.getByRole('button'),
        'the compact chrome row holds something other than the two sheet triggers',
      ).toHaveCount(2);
      /**
       * The filter trigger opens at `Filters · 1`, never bare: this page seeds a `queue`
       * clause on mount and the trigger counts clause GROUPS. `/expenses` opens bare, which
       * is the visible difference between the two routes' chrome.
       */
      await expect(controls.getByRole('button').first()).toContainText(copy.sheet.filtersTrigger);
      await expect(controls.getByRole('button').first()).toContainText('1');
      await expect(controls.getByRole('button').last()).toContainText(copy.sheet.sortTrigger);

      /**
       * The sort sheet MOUNTS UNCONDITIONALLY and says there is nothing to sort.
       *
       * No column on this page declares `sortable`, so `sortSheetOptions` returns an empty
       * list and `SortSheet` renders `table.mobile.sortEmpty` rather than offering a control
       * that would move an indicator and reorder nothing. That is the behaviour under test —
       * not a gap — and it is built off the sort RESOLVER rather than off `sortable: true` so
       * that the day a column here gains sorting, the card surface and the desktop header
       * gain it together. `/expenses` is the other side of this assertion: it offers two
       * fields, and `e2e/expenses.mobile.spec.ts` asserts exactly that.
       */
      await controls.getByRole('button').last().tap();
      const sortSheet = sheetTitled(page, copy.sheet.sortTitle);
      await expect(sortSheet, 'the sort trigger did not open the sort sheet').toBeVisible({
        timeout: 20_000,
      });
      /**
       * `.first()` and `toBeVisible`, not a count: a text engine may return the paragraph or
       * the body that holds only that paragraph, and which of the two is not worth depending
       * on — while visibility is the claim actually being made.
       */
      await expect(
        sortSheet.getByText(copy.sheet.sortEmpty, { exact: true }).first(),
        `the sort sheet did not render its empty state in ${locale}. If a column here gained ` +
          '`sortable`, this assertion is the one to REPLACE with the field list — not to delete.',
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        sortSheet.getByRole('radiogroup'),
        'the sort sheet rendered a field picker, so `sortOptions` is no longer empty',
      ).toHaveCount(0);
      await expect(
        sortSheet.getByRole('button', { name: copy.sheet.clearSort, exact: true }),
        'Clear sort is offered as live with nothing sorted',
      ).toBeDisabled();
      await sortSheet.getByRole('button', { name: copy.sheet.done, exact: true }).tap();
      await expect(sortSheet).toBeHidden({ timeout: 20_000 });

      // ── Queue 1 of 3: `pending` ──────────────────────────────────────────────────────
      await assertQueueCards(page, `${route} [pending] at ${testInfo.project.name}`, [
        copy.columns.total,
        copy.columns.submitted,
      ]);

      /**
       * My own subject, located by its marker title.
       *
       * Not by position and not by count: the seeded queue holds six other tasks and up to
       * five other cells of this same file are minting concurrently, so "the first card" is
       * whatever `myTasks` ordered today. The `E2E act-once ` prefix makes this row unique by
       * construction.
       */
      const mine = cardsIn(page).filter({
        has: page.locator('[data-dt-card-slot="title"]', { hasText: mint.title }),
      });
      await expect(
        mine,
        `the minted approval "${mint.title}" is not in the queue for ${approver}. The ` +
          'fixture asserted the task parked and was assigned before returning, so this is ' +
          'either `myTasks` not selecting it or the page not rendering it.',
      ).toHaveCount(1, { timeout: 30_000 });

      // ── Open the report ─────────────────────────────────────────────────────────────
      /**
       * The TITLE is the button, not the `<li>`: `DataTableCards` wraps the title slot in a
       * `min-h-11` `<button>` wired to `onRowClick`, and tapping the badge, the subtitle or a
       * field does nothing at all.
       */
      await mine.locator('[data-dt-card-slot="title"]').tap();

      const drawer = page.getByRole('dialog').filter({ hasText: mint.title }).first();
      await expect(drawer, 'tapping the card did not open the approver drawer').toBeVisible({
        timeout: 30_000,
      });

      // Animations off before any box is read: the panel slides in, and a rectangle taken
      // mid-transition is a rectangle from neither end of it.
      await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}' });

      /**
       * THE CLAMP. `DrawerContent` is given `width={600}` and carries `max-w-full` on its
       * `side='right'` branch, so on a 360px viewport the panel must be the viewport and not
       * 600px of it.
       *
       * THIS IS THE ASSERTION NOTHING ELSE IN THE SUITE MAKES. `e2e/crawl-mobile.spec.ts:40-47`
       * measures `main#main-content` and states that portalled dialogs and drawers are
       * structurally invisible to it — "a drawer 80px wider than the screen … all green here".
       * A second hazard lives behind the same box: the panel is `resizable` with a persisted
       * width under `localStorage['expenseos.drawerWidth.expenses.approver.detail']`, read in
       * an effect, and `e2e/setup/actors.setup.ts` captures full `storageState`. If a stored
       * width ever outlived a run, this is where it would surface.
       */
      const box = await drawer.boundingBox();
      expect(box, 'the drawer has no box to measure').not.toBeNull();
      const viewport = page.viewportSize();
      expect(viewport, 'the project declares no viewport').not.toBeNull();
      const b = box as NonNullable<typeof box>;
      const v = viewport as NonNullable<typeof viewport>;
      expect(
        Math.round(b.width),
        `the approver drawer is ${Math.round(b.width)}px wide inside a ${v.width}px viewport. ` +
          '`DrawerContent` asks for 600 and relies on `max-w-full` to clamp it; a panel wider ' +
          'than the screen puts its right-hand controls — including Approve — out of reach ' +
          'with nothing to scroll.',
      ).toBeLessThanOrEqual(v.width + 1);
      expect(
        Math.round(b.x),
        'the approver drawer starts off the left edge of the viewport',
      ).toBeGreaterThanOrEqual(-1);

      /**
       * The minted report carries NO EXPENSES — `mintDisposableApproval` copies header facts
       * only — so the drawer renders `drawer.noExpenses`. Asserted rather than tolerated,
       * because it is the anti-vacuity guard for everything below: a drawer that opened on
       * somebody else's report would be a different screen entirely.
       */
      // VeloExpense: the submitted subject carries one expense, so the guard is its vendor
      // rather than `drawer.noExpenses`. See the header.
      await expect(
        drawer.getByText(QUEUED_VENDOR, { exact: true }).first(),
        `the drawer does not show the subject's one expense ("${QUEUED_VENDOR}") in ${locale}, ` +
          'so this is not the submitted subject',
      ).toBeVisible({ timeout: 20_000 });

      /**
       * ── The footer, at 360, in this locale ──────────────────────────────────────────
       *
       * Four controls on one `justify-end flex-wrap` row. Phase 2 added the `flex-wrap`
       * unconditionally — `DrawerContent` here is `resizable` with `minWidth = 360`, so a
       * desktop reader can drag the panel to exactly the width the fix targets, and a
       * `max-lg:` variant keys off the viewport and would miss them. jsdom cannot lay this
       * out; `ApproverReportDrawer.test.tsx` pins the class and says so. This is where the
       * class is proved to have done anything.
       *
       * REACHABLE, not 44px. `e2e/tap-targets.mobile.spec.ts` rules `arrive` deliberately
       * rare and refuses to drive a drawer open on the critical path of a geometry gate, so
       * the hit-box arithmetic is nobody's — named here so the absence is a decision. What is
       * asserted is the failure the wrap was added to prevent: a control pushed outside the
       * panel, which `justify-end` makes the RIGHT-most one, i.e. Approve, the primary action.
       */
      /**
       * SCOPED TO THE FOOTER, and that is not fussiness. `DrawerContent` renders its own
       * dismiss X **after** `{children}`, with a HARDCODED English `aria-label="Close"`, so
       * in EN the drawer holds TWO controls named "Close" and the decoration is the LATER of
       * the two in document order. A `.first()` or a `.last()` on the drawer would silently
       * pick one of them and the choice would flip between locales. The X is a SIBLING of
       * `DrawerFooter`, so scoping to the footer excludes it in both locales.
       *
       * BY TEST ID, not by DOM shape. This was first written as "the innermost `div` that
       * contains Approve" and that locator could never match: `filter({ has })` embeds the
       * inner locator's WHOLE selector chain and re-runs it relative to each candidate, so a
       * `has` built off `drawer` asked for a `<div>` containing a *dialog* containing Approve
       * — nothing. Rebuilding it off `page` would have matched, but it would still be a bet
       * on how the row happens to nest, and this row's nesting is exactly what Phase 2
       * changed. `ApproverReportDrawer.tsx` carries the id for this assertion.
       */
      const footer = drawer.getByTestId('approver-drawer-footer');
      await expect(
        footer,
        `the drawer has no footer row holding "${copy.drawer.approve}" in ${locale}`,
      ).toBeVisible({ timeout: 20_000 });

      for (const name of [
        copy.drawer.close,
        copy.drawer.return,
        copy.drawer.reject,
        copy.drawer.approve,
      ]) {
        const control = footer.getByRole('button', { name, exact: true });
        await expect(
          control,
          `the drawer footer has no "${name}" control in ${locale}. Approve/Reject/Return are ` +
            'gated on `canDecide` — `status === SUBMITTED` AND a task id — so all three ' +
            'missing at once means the row was opened without its task, which is what the ' +
            '`team` view does on purpose and what this queue must not.',
        ).toBeVisible({ timeout: 20_000 });
        const cb = await control.boundingBox();
        expect(cb, `"${name}" has no box`).not.toBeNull();
        const r = cb as NonNullable<typeof cb>;
        expect(
          Math.round(r.x + r.width),
          `"${name}" is painted past the right edge of the ${v.width}px viewport in ${locale}. ` +
            'This is what the footer `flex-wrap` exists to prevent, and because the row is ' +
            '`justify-end` the control an overflow pushes out of reach is the right-most one — ' +
            'Approve, the primary action.',
        ).toBeLessThanOrEqual(v.width + 1);
        expect(
          Math.round(r.x),
          `"${name}" starts off the left edge of the viewport in ${locale}`,
        ).toBeGreaterThanOrEqual(-1);
      }

      // ── Reject, with a comment ──────────────────────────────────────────────────────
      await footer.getByRole('button', { name: copy.drawer.reject, exact: true }).tap();

      /**
       * The note field's ONLY accessible handle is its placeholder — it carries no `<label>`
       * and no `aria-label`. That is a real a11y gap and it is somebody else's to close; here
       * it simply dictates the locator.
       */
      const note = drawer.getByPlaceholder(copy.drawer.rejectNotePlaceholder);
      await expect(note, `tapping Reject did not reveal the note field in ${locale}`).toBeVisible({
        timeout: 20_000,
      });

      const confirm = drawer.getByRole('button', { name: copy.drawer.confirmReject, exact: true });
      /**
       * The note is REQUIRED, and that is a gate rather than a hint:
       * `disabled={pending || (mode === 'reject' && !note.trim())}`. Asserting the disabled
       * state BEFORE typing is what makes the fill below mean something — otherwise the test
       * would pass identically on a build where the reason was optional.
       */
      await expect(
        confirm,
        'Confirm reject is live with an empty reason — the required-note gate is gone',
      ).toBeDisabled();
      await note.fill('E2E phone reject');
      await expect(confirm, 'Confirm reject stayed disabled with a reason typed').toBeEnabled({
        timeout: 20_000,
      });
      await confirm.tap();

      await expect(
        drawer,
        'the drawer stayed open, so the decision was refused server-side',
      ).toBeHidden({ timeout: 30_000 });

      /**
       * DECIDED ON THE SERVER, read straight out of the database.
       *
       * A drawer closing proves the client re-rendered; it does not prove
       * `expenseApprovals.decide` reached the task. Polled, because the mutation's success
       * handler and the queue invalidation do not wait on each other.
       */
      await expect
        .poll(() => mint.readTaskStatus(), {
          timeout: 30_000,
          message:
            'the approval task did not move off PENDING. The drawer closed, so the client ' +
            'thought it succeeded — this is the gap between a screen that is polite and a ' +
            'server that is not.',
        })
        .toBe('REJECTED');

      // ── Queue 2 of 3: `decided` ──────────────────────────────────────────────────────
      /**
       * Reachable only because this test just rejected its own subject. `myDecided` selects
       * tasks with `status IN ('APPROVED','REJECTED')` and `decidedById = me`, and on a fresh
       * seed `qa.manager` has decided nothing — so a spec that returned instead of rejecting
       * would arrive here with an empty queue and nothing to measure. See the header.
       */
      await switchQueue(page, copy, copy.queue.pending, 'decided', copy.queue.decided);
      await expect(
        cardsIn(page).filter({
          has: page.locator('[data-dt-card-slot="title"]', { hasText: mint.title }),
        }),
        'the report this test just rejected is not in "decided by me"',
      ).toHaveCount(1, { timeout: 30_000 });
      await assertQueueCards(page, `${route} [decided] at ${testInfo.project.name}`, [
        copy.columns.total,
        copy.columns.decided,
      ]);

      // ── Queue 3 of 3: `team` ─────────────────────────────────────────────────────────
      /**
       * Every report from a direct report, whoever the workflow routed it to. Its rows come
       * from a differently-shaped mapper — team rows have no task of their own and are keyed
       * by REPORT id — so a card config validated against the other two can still be wrong
       * here.
       *
       * No per-row assertion: four of the nine seeded accounts report to `qa.manager` and all
       * of their submitted reports land in this view, so what is above the fold is not fixed.
       * The geometry and the `<dt>` terms are the claim.
       */
      await switchQueue(page, copy, copy.queue.decided, 'team', copy.queue.team);
      await assertQueueCards(page, `${route} [team] at ${testInfo.project.name}`, [
        copy.columns.total,
        copy.columns.with,
      ]);
    });
  });
}

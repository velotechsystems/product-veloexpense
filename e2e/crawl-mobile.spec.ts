import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
// VeloExpense: the registry at VeloExpense's path (ExpenseOS: `apps/web/src/app/[locale]/(app)`).
import { dispositionFor, MOBILE_READINESS } from '../app/(app)/mobileReadiness';
import { IGNORED_CONSOLE } from './support/console-noise';
import {
  assertSlugsAreInjective,
  desktopRuledRoutes,
  expectedClassificationFor,
  type MobileClassification,
  type MobileSidecar,
  mayBeGated,
  mobileRoutes,
  projectDir,
  screenshotPathFor,
  slugFor,
  writeSidecar,
} from './support/mobile-census';

/*
 * VeloExpense: ExpenseOS's `e2e/crawl-mobile.spec.ts` (1e682dd6), ported with the phone projects
 * (phone e2e 3). Every static route under `app/` that renders in the shell, at all three phone
 * widths, against the readiness registry VeloExpense's shell reads. Changed, each marked
 * "VeloExpense:": the registry's path; no locale segment; the desktop-ruled floor (15, of 18);
 * and no manifest assertion, because VeloExpense ships no web app manifest (ExpenseOS's PWA
 * install is not ported). VeloExpense's own pages carry no ruling and are measured as phone
 * pages — the reason `/admin/compliance` is now ruled `desktop` in `mobileReadiness.ts`.
 */

/**
 * Every page in the app, on a phone, measured for horizontal overflow.
 *
 * ─── WHAT A GREEN RUN ESTABLISHES ────────────────────────────────────────────────────────
 *
 * For each of the 52 crawlable routes, in each of the two phone projects: the page answered
 * < 400 — or answered 404 AND is one of the few routes an ALLOWLIST permits to be
 * module-gated (`MAY_BE_GATED` in `support/mobile-census.ts`; a 404 anywhere else FAILS the
 * run, because `notFound()` is also this app's RBAC-denial path and its no-session path);
 * the session survived (it is not 50 login pages measured 50 times); the service worker did
 * not serve the offline fallback in its place; the LAYOUT viewport is exactly the width the
 * project declared — which is the assertion that makes everything after it mean anything;
 * the shell's scrolling box does not scroll sideways; there is exactly one web app manifest
 * and it is not locale-prefixed; and the console is clean. Plus one screenshot per phone
 * surface, as evidence a person can look at.
 *
 * ─── WHAT A GREEN RUN DOES NOT ESTABLISH ─────────────────────────────────────────────────
 *
 * `position: fixed` LAYERS ARE INVISIBLE TO THIS MEASUREMENT. This is the biggest honest
 * gap and it is structural, not an oversight. The measurement is
 * `main#main-content.scrollWidth` vs its `clientWidth` — so it sees only what is in that
 * box's flow. `AppShell` renders the mobile sidebar as `fixed inset-0 z-40`, outside
 * `main` entirely, and dialogs portal to `<body>` for the same reason. A drawer 80px wider
 * than the screen, a dialog that cannot be dismissed at 360px, a sheet that paints off the
 * right edge: all green here. Those need their own spec with their own geometry, and this
 * file must not be read as covering them.
 *
 * Nor does it establish that anything is USABLE: not tap-target size, not reading order,
 * not contrast, not whether the layout is any good. It says the page does not scroll
 * sideways, which is the single most common phone defect and the one worth a gate.
 *
 * NO AXE PASS HERE, per UX's ruling — "No axe pass in T02", escalated as a proposed
 * separate `T05 a11y-baseline`. Do not add one to this file on the reasoning that the
 * browser is already open: 52 routes × 2 projects × an axe injection is a different task
 * with a different failure budget, and folding it in here means one red run cannot be read.
 *
 * THE SCREENSHOTS ARE NOT SNAPSHOT-COMPARED, deliberately, and this must stay true. UX:
 * "every one of the eleven P-tasks *intentionally* changes phone layout — a
 * visual-regression gate would be red by design on every task that uses it." They are
 * evidence for a human reviewer, not a baseline. `toHaveScreenshot` does not belong here.
 *
 * ─── WHY `main#main-content` AND NOT `documentElement` ───────────────────────────────────
 *
 * The document-level form of this gate — `documentElement.scrollWidth > clientWidth` — is
 * the one everybody writes first, and in this app it is STRUCTURALLY IMPOSSIBLE TO TRIP, at
 * any width, before or after the viewport meta tag landed. The shell clips X at two levels:
 * its root is `flex h-screen` (so the document never scrolls at all), the wrapper below it
 * is `overflow-hidden`, and `main` itself carries `overflow-x-hidden`. Anything too wide is
 * clipped before it can reach the document. So the document-level assertion passes green on
 * a page whose content is 200px off the right edge, which is worse than no gate: it is a
 * gate somebody will cite.
 *
 * `main#main-content` is the innermost box that can actually report the condition, because
 * `overflow-x-hidden` makes it a scroll container — it clips visually while still reporting
 * the true content width through `scrollWidth`. That is the only place the number survives.
 *
 * CONSEQUENCE: `main#main-content` AND ITS `overflow-x-hidden` ARE NOW A TEST CONTRACT.
 * Renaming that id, or moving the overflow to another element, must update this spec in the
 * SAME PR or this gate goes quiet rather than red. It is partially self-protecting — the id
 * is also addressed by `smoke.spec.ts`, `dashboard.spec.ts` and `AppShell.test.tsx`, and
 * `npm run e2e:check-ids` fails on a `#id` this suite reaches for that no longer exists in
 * `apps/web/src`. That last one is why `#main-content` is the ONE `#id` selector allowed in
 * this file: it buys the selector rename protection. Everything else here is a role, a
 * testid or an attribute selector, because `e2e:check-ids` exits 1 on any id it cannot find
 * and an invented one would break a blocking CI step.
 *
 * WHY INTENTIONAL HORIZONTAL SCROLLING STAYS GREEN, and must: several surfaces scroll
 * sideways on purpose (the wide data tables above all). Each of those is ITSELF a scroll
 * container, so its overflow self-contains — its own `scrollWidth` grows while its
 * `clientWidth` stays at the width its parent gave it, and `main`'s `scrollWidth` never
 * learns about it. The ruled table fallback in the tables task therefore does not go red
 * here, and that is by construction rather than by an exemption list.
 *
 * ─── THE 1px TOLERANCE ──────────────────────────────────────────────────────────────────
 *
 * `TOLERANCE_PX = 1`, and the number is EMPIRICAL, not principled. Sub-pixel layout at a
 * fractional device scale factor can leave a clean page reporting a 1px delta, and a gate
 * that fires on that is a gate that gets disabled.
 *
 * WHAT WOULD MOVE IT TO 2: one real run at 390 / DSF 3 in which a route believed to be
 * genuinely clean measures a delta of 1 or 2. At that point it becomes 2, WITH THE FORCING
 * ROUTE NAMED IN A COMMENT HERE, never silently. If you are raising this number and cannot
 * name the route that made you, you are hiding a defect rather than calibrating an
 * instrument. Nothing above 2 is a tolerance — 3px of overflow is a layout bug.
 *
 * THAT RUN HAS NOW HAPPENED, and the answer was no. Measured against the dev database on
 * both projects, the distribution is strictly bimodal — a route is either exactly 0 or it is
 * badly broken, with nothing in between:
 *
 *     mobile-390:  39 routes at 0px,  then /admin/api-keys at 70px and /expenses/all at 97px
 *     mobile-360:  38 routes at 0px,  then /admin/control-evaluation at 21px,
 *                                          /admin/api-keys at 100px, /expenses/all at 127px
 *
 * Not one route in 82 measured 1 or 2. So the 1px tolerance is not doing any work today, and
 * that is the desired state: it is headroom against sub-pixel rounding on data this run did
 * not happen to contain, not an allowance anything is currently spending. The data would
 * support 0, and 0 was not chosen because a tolerance that has never absorbed anything is
 * cheap while a gate that fires on a rounding artifact gets switched off.
 *
 * THE THREE FAILURES ABOVE WERE REAL, AND P10 REMOVED THEM FROM MEASUREMENT BY RULING
 * RATHER THAN BY REPAIR. When this comment was written they were left failing deliberately,
 * as the falsification that this gate is not a decoration. All three routes —
 * `/expenses/all`, `/admin/api-keys` and `/admin/control-evaluation` — are now ruled
 * `desktop` in `mobileReadiness.ts`, so each renders `DesktopOnlyNotice` below `lg`, each
 * classifies `desktop-notice` here, and each skips the overflow gate. This file no longer
 * measures any of them.
 *
 * NOT ONE LINE OF THEIR LAYOUT CHANGED. The figures above are the record and they stand:
 * `/expenses/all` is still 127px over at 360 and 97px at 390, `/admin/api-keys` still 100px
 * and 70px, `/admin/control-evaluation` still 21px at 360 and clean at 390. Anyone bringing
 * one of those pages back to a phone inherits that overflow entire, and re-ruling the route
 * away from `desktop` turns its measurement back on in this file with no edit here. Read
 * `docs/design/pwa.md`'s Page-readiness rows, which say the same thing in the same words —
 * a row that reads as "fixed" is a row that loses the debt.
 *
 * WHAT IS LOST WITH THEM is this gate's own falsification: with the three widest overflows
 * out of measurement, a green run over the remaining phone surfaces no longer demonstrates
 * that the instrument can go red. The replacement is the per-route ruling assertion below
 * and the census's reconciliation, which fail on a ruling that stopped being true — but
 * neither is an overflow, and nobody should read them as one.
 *
 * `/admin/control-evaluation` overflowing at 360 but NOT at 390 remains the clearest possible
 * justification for there being two projects, ruled or not.
 *
 * ─── HOW TO RUN IT ──────────────────────────────────────────────────────────────────────
 *
 *     npm run test:e2e:mobile          # both projects — playwright test
 *                                      #   --project=mobile-360 --project=mobile-390
 *
 * One project, which is what you want while iterating on a layout:
 *
 *     npx playwright test --project=mobile-390
 *
 * One route, in one project. `--grep` matches the test TITLE, which is the route path:
 *
 *     npx playwright test --project=mobile-390 --grep "/admin/roles"
 *     npx playwright test --project=mobile-390 --grep "/expenses fits"   # exact, not /expenses/all
 *
 * Note `--project=mobile` does NOT work — there is no project by that name, there are two,
 * and Playwright errors rather than prefix-matching. Note also that `--project` drags in
 * the `setup` dependency chain (11 sign-in tests), which is why a listing of one mobile
 * project reports more tests than it owns.
 *
 * ─── IN THE NIGHTLY: THE PROJECTS RUN, AND A FAILURE DOES KEEP ITS SCREENSHOT ───────────
 *
 * Both mobile projects DO run in the nightly, and nothing had to be added to make that
 * true: the workflow invokes `npx playwright test` with NO `--project` filter, so every
 * project the config declares is swept in automatically. That is also the standing argument
 * against ever converting it to an allowlist — an allowlist replaces one silent-failure
 * mode (a project that breaks the nightly) with its exact mirror: a project that silently
 * NEVER RUNS, because someone forgot to add it to a YAML list.
 *
 * A FAILING MOBILE ROUTE'S CAPTURES ARE UPLOADED. Neither mobile project overrides the
 * root `use` block's `screenshot: 'only-on-failure'` / `video: 'retain-on-failure'` /
 * `trace: 'on-first-retry'` (their `use:` blocks set only `browserName`, viewport,
 * `isMobile`, `hasTouch` and `storageState`), so Playwright writes `test-failed-1.png`,
 * `video.webm` and `error-context.md` into `test-results/<test>/` for each red route — and
 * `.github/workflows/e2e-nightly.yml`'s "Upload the report" step uploads BOTH
 * `playwright-report/` and `test-results/` on `always()`, retention 14 days. So the first
 * place to look at a red nightly is that `playwright-report` artifact, whose failed-test
 * entry carries the screenshot of the route as it broke. An earlier version of this comment
 * said in its loudest voice that there were no screenshots to retrieve; that was simply
 * wrong, and it would have sent a reader hunting locally for something already attached to
 * the run.
 *
 * WHAT IS ACTUALLY LOST IS THE PASSING-ROUTE CORPUS — the ~82 PNGs, their sidecars and
 * `census.md` that this file writes under `e2e/.artifacts/mobile/` for the routes that
 * PASSED. That is the evidence a person browses to see what the app looks like on a phone,
 * and it is gitignored, is not inside `test-results/`, and is discarded with the runner.
 * The upload step that would have preserved it was dropped from this task because the
 * repository is under a security freeze on `.github/` after a workflow was planted via a
 * compromised token, so this task shipped no workflow diff at all. Reproduce it locally
 * with `npm run test:e2e:mobile`.
 *
 * AND WHEN THE FREEZE LIFTS, THE OBVIOUS FIX IS STILL WRONG. `e2e/.artifacts/` is a DOT
 * DIRECTORY, and `actions/upload-artifact` treats hidden paths as excluded by default — so
 * a step pointed straight at it SUCCEEDS AND PRODUCES AN EMPTY ARTIFACT, with nothing but a
 * warning in the log. It needs `include-hidden-files: true`. A step that goes green while
 * uploading nothing is worse than no step at all, for exactly the reason the document-level
 * overflow assertion above is worse than no gate.
 *
 * ─── THE CENSUS, AND THE ONE THING IT ASSERTS ───────────────────────────────────────────
 *
 * Counts are PRINTED by `globalTeardown`. When this file shipped they were asserted on
 * NOTHING, over a live dissent from UX and QA whose shared principle is "never trade an
 * assertion for a report", and the hole that left was real:
 *
 *     An inverted layout condition renders the desktop-only notice on EVERY route; every
 *     route then skips the overflow gate; and the run is green and empty. Nothing in this
 *     file notices.
 *
 * CLOSED BY T04, in QA's form: `globalTeardown` now asserts
 * `expect(phoneSurfaces).toBeGreaterThan(0)` per project. It could not be closed here and it
 * could not be closed earlier — from inside a test the skip is correct behaviour, and until
 * T04 shipped the readiness registry there was no mechanism that could invert. See the
 * `collateMobileCensus` doc comment in `support/mobile-census.ts` for why the detector is a
 * floor rather than a count, and for the transcript of it being watched to fail.
 *
 * What is still only PRINTED: everything else — per-route classification, deltas, screenshot
 * counts, the gated list. Do not read a green run as a claim about those.
 *
 * ─── THE NUMBERS ────────────────────────────────────────────────────────────────────────
 *
 * 52 routes, discovered not listed, × 2 projects = 104 tests. That 52 is stable. The split
 * underneath it IS NOT, and it is now a THREE-way split rather than a two-way one — which is
 * the correction this section most needed, because it used to conflate two different numbers.
 *
 * A route 404s when the platform module that owns it has no active installation — the
 * server-side half of menu gating, working correctly, not a break. Ten of those are the
 * `/netsuite/*` routes. READ THE SLUG CAREFULLY, because this comment named the wrong registry
 * until P10: `netsuite` is the INTEGRATION; the MODULE is `netsuite-gl`, all ten pages call
 * `requireActiveModule('netsuite-gl')`, and `netsuite-gl` is the slug absent from
 * `DEFAULT_ACTIVE_MODULES`. They are gated on every environment. `/admin/assistant-feedback`
 * is the eleventh, and it is gated on the `assistant` MODULE (`ASSISTANT_MODULE_SLUG`) — not
 * on the `anthropic` integration, which is what the module REQUIRES and what bootstraps from
 * `ANTHROPIC_API_KEY`. The practical consequence is what it always was: it is gated on a
 * developer box without that key and reachable on one with it.
 *
 * Measured on this machine AFTER P10: 11 gated, 29 desktop-notice, 12 phone surfaces. On a
 * box with the key set: 10 gated, 30 desktop-notice, 12 phone — `/admin/assistant-feedback`
 * is ruled `desktop`, so activating its module moves it from `gated` to `desktop-notice` and
 * never to `phone`. Where the phone surfaces went, in two steps rather than one: this comment
 * was written at T02, before any registry existed, and its 11 gated / 41 phone had no third
 * bucket to have. T04 then ruled `/admin/roles` and took it to 11 / 1 / 40. P10 ruled 39 more
 * keys; 39 of the 40 `desktop`-ruled routes this crawl walks are P10's and 11 of those 40 were
 * already gated, so 28 routes moved from `phone` to `desktop-notice` and 40 − 28 = 12 remain.
 * The inherited `/admin/approval-workflows/[id]` is ruled `desktop` too but is not in this
 * count: `crawlableRoutes` filters to `STATIC_ROUTES`, which drops any path containing `[`.
 *
 * NOW THE PART THAT WAS ACTUALLY WRONG, AND IT WAS WRONG EVEN BEFORE P10 — it just could not
 * show while the two numbers happened to be equal. THE SCREENSHOT COUNT IS NOT THE
 * PHONE-SURFACE COUNT. `page.screenshot()` runs at `stage: 'screenshot'`, BEFORE the notice
 * is located at `stage: 'notice'`, so a route that turns out to be `desktop-notice` has
 * already had its PNG written. ONE SCREENSHOT PER ROUTE THAT REACHED A LAYOUT — that is
 * 52 minus the gated ones, so 41 here and 42 on a box with the key, unchanged by P10 — and
 * NOT one per phone surface, which is now 12. A gated route emits NO PNG, by ruling: "a 404
 * screenshot is noise a reader will misfile as a broken page." It is recorded in its sidecar
 * and counted in the census instead. Do not add a `.404.png`, and do not assert a screenshot
 * count — count them from the census, which classifies against the run that actually
 * happened. And do not repair a disagreement between the PNG count and the phone count by
 * moving the screenshot: capturing the notice is deliberate. The notice IS what a phone
 * reader sees on those 29 routes, and a corpus that omitted it would omit the majority of
 * what this crawl is now looking at.
 *
 * Two routes the desktop crawlers walk are absent here for reasons worth knowing: `/` is
 * never discovered at all (`discoverRoutes` only emits a route for a SUBDIRECTORY holding
 * `page.tsx`, so `[locale]/page.tsx` at the walk root is invisible to it), which is
 * convenient — every route measured here renders inside the `(app)` clipping shell, which
 * is what makes the measurement target above correct. And `/enroll-mfa` is excluded by the
 * security mitigation; see `MOBILE_EXCLUDED` in `support/mobile-census.ts`.
 */

// VeloExpense: no locale segment in a path, so ExpenseOS's `const LOCALE = 'en'` is gone; the
// crawl still runs in English (the EN-only note below holds).

/**
 * Route discovery is shared with the three desktop crawlers — `support/routes.ts` carries
 * the reasoning for every excluded route. LOCALE stays hardcoded here, matching
 * `crawl.spec.ts` rather than the role crawlers' `E2E_LOCALE`: overflow is a layout
 * property and fr-CA's longer strings are a real second dimension, but 104 tests is already
 * the budget and a locale axis would double it. fr-CA phone layout is a follow-up.
 */
const ROUTES = mobileRoutes();

/**
 * Proven at collection time, before a browser starts. See `assertSlugsAreInjective` — the
 * scheme is only sound while no path segment contains an underscore, and a silent slug
 * collision costs a route's PNG and sidecar with no error anywhere.
 */
assertSlugsAreInjective(ROUTES);

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE COLLECTION-TIME FLOORS ON THE READINESS REGISTRY.
 *
 * Proven before a browser starts, for the same reason `assertSlugsAreInjective` is: a
 * registry this file cannot see is a registry whose every per-route assertion below passes
 * vacuously, and the failure has to be loud at collection rather than distributed over 104
 * quietly-agreeable tests.
 *
 * THE VACUOUS PASS THESE FLOORS EXIST AGAINST, spelled out because it is not the obvious
 * direction. If `MOBILE_READINESS` emptied — a bad merge, a renamed export, a module that
 * failed to resolve and left every lookup on `DEFAULT_DISPOSITION` — then every route would
 * be predicted `phone`. `DesktopOnlyNotice` reads the SAME registry, so it would render
 * nowhere, every route would OBSERVE `phone`, and the per-route assertion below would agree
 * with itself on all 52 routes and report green. Forty rulings would have evaporated and
 * nothing in this suite would have an opinion. A floor on the registry's reach is the only
 * thing that notices, and it has to be here rather than in the assertion.
 *
 * WHY THE FLOOR COUNTS CRAWLED ROUTES AND NOT REGISTRY KEYS. `Object.keys(MOBILE_READINESS)`
 * would be satisfied by forty-five keys that resolve to nothing this crawl walks — a
 * normalisation change, a locale segment creeping back into the keys, or the five P01 rows
 * for unshelled routes that this crawl never visits. Resolving the ACTUAL route set through
 * `dispositionFor` is the same lookup the app performs, so a floor over it fails on exactly
 * the breakages that would also silently un-rule the product.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * BOTH SIDES OF THE ASSERTION MUST HAVE SOMETHING TO BITE ON.
 *
 * The per-route check below is one equality covering two claims — a `desktop` ruling owes a
 * notice, anything else owes none — and each half is untested if no crawled route is on that
 * side. This is the anti-vacuity floor in its purest form and it is derived entirely, so it
 * never needs editing when a legitimate ruling changes.
 */
const DESKTOP_RULED = desktopRuledRoutes(ROUTES);
const PHONE_RULED = ROUTES.filter((route) => expectedClassificationFor(route) === 'phone');
if (DESKTOP_RULED.length === 0 || PHONE_RULED.length === 0) {
  throw new Error(
    `crawl-mobile: of the ${ROUTES.length} crawled routes, ${DESKTOP_RULED.length} resolve ` +
      `\`desktop\` and ${PHONE_RULED.length} do not. Both sides of the ruling assertion need ` +
      `at least one route or half of it is untested — and a zero on the \`desktop\` side ` +
      `means the readiness registry is not reaching this crawl at all, in which case every ` +
      `route below would agree with an empty ruling and the suite would report green. Check ` +
      `the import of app/(app)/mobileReadiness at the top of this file.`,
  );
}

/**
 * THE SIZE FLOOR, AND THE NUMBER.
 *
 * Thirty. It is a FLOOR and not a count, for the reason the census's phone-surface floor is
 * one: a count would have to be revised by every task that rules or un-rules a route, and a
 * number edited that often is a number edited to whatever the run produced.
 *
 * WHERE THIRTY COMES FROM. Forty crawled routes resolve `desktop` today — P10's thirty-nine
 * (less `/admin/approval-workflows/[id]`, which is dynamic and outside the crawl's static
 * route set) plus T04's `/admin/roles`. Thirty-three of those forty are structurally durable
 * within this epic: the eleven module-gated rows, which nothing here can un-rule because
 * nothing here can even reach them, plus the twenty-two dense `/admin/*` tables. Thirty sits
 * below that, so a later task legitimately returning a handful of routes to a phone layout
 * does not trip it, and sits far enough above zero to fail on the shapes that matter — a
 * batch reverted, the registry emptied, the module renamed, or `normalizePath` changed so
 * that keys stop matching route paths.
 *
 * WHAT WOULD MOVE IT, and it may only ever move DOWN: a named task that deliberately brings
 * ruled routes back to a phone layout, with that task named here in a comment, exactly as
 * TOLERANCE_PX may only move with the forcing route named. Raising it to track the current
 * number converts a floor back into a count.
 */
// VeloExpense: fifteen. Eighteen crawled routes resolve `desktop` here today — ExpenseOS's
// rulings for the `/admin/*` screens VeloExpense ported (`/admin/roles`, the lookups, the
// policy screens, `/admin/approval-workflows`, …) and `/expenses/all`. VeloExpense's own
// `/admin/*` pages carry no ruling and are crawled as phone surfaces. Fifteen keeps the floor's
// purpose (a registry that shrank or stopped resolving fails here) with ExpenseOS's margin.
const DESKTOP_RULED_FLOOR = 15;
if (DESKTOP_RULED.length < DESKTOP_RULED_FLOOR) {
  throw new Error(
    `crawl-mobile: only ${DESKTOP_RULED.length} of the ${ROUTES.length} crawled routes ` +
      `resolve \`desktop\` against mobileReadiness.ts, and the floor is ` +
      `${DESKTOP_RULED_FLOOR}. Eighteen did when this floor was written (VeloExpense). This is a registry ` +
      `that shrank, an import that resolved to something else, or a matcher change that ` +
      `stopped keys matching route paths — all of which un-rule product surfaces silently, ` +
      `because DesktopOnlyNotice reads the same table. If a task DELIBERATELY returned ` +
      `routes to a phone layout, lower this floor and name that task in the comment above ` +
      `it; do not raise it to whatever this run produced.`,
  );
}

/**
 * A registry key is not a promise that the route exists — `mobileReadiness.test.ts` owns
 * that check, against the App Router tree, and it is not duplicated here. What IS asserted
 * here is that the table this crawl resolved against is the frozen shipped one, so a spec
 * that somehow got hold of a mutated copy fails at collection instead of measuring against
 * it.
 */
if (!Object.isFrozen(MOBILE_READINESS)) {
  throw new Error(
    'crawl-mobile: MOBILE_READINESS is not frozen, so the table this run measured against ' +
      'is not the one the app ships. mobileReadiness.ts freezes it at module scope.',
  );
}

/** The gate. Empirical. Read the tolerance section of the header before changing it. */
const TOLERANCE_PX = 1;

/**
 * Settle budget.
 *
 * `crawl.spec.ts` uses a bare `waitForTimeout(1200)`, which is both too short for a slow
 * tRPC page and wasted on a static one. This polls the widths until they stop changing —
 * but NOT before `SETTLE_FLOOR_MS`, and that floor is the important half. A page whose
 * table arrives over tRPC at t=1500ms has a perfectly stable width at t=0, 200 and 400,
 * so a naive "three stable samples" declares victory on the empty shell and measures
 * nothing. `table-cell-overflow.spec.ts` documents that exact failure costing a green run
 * over a page that was overflowing a second and a half later. The floor keeps the 1200ms
 * the other crawlers converged on and adds stability on top of it.
 *
 * HONEST RESIDUAL LIMIT: content arriving after the floor AND after the stable window can
 * still be missed. The wide data tables are the likely case, and they are their own scroll
 * containers so they could not trip this gate anyway (see the header). Cell-level overflow
 * belongs to the tables task.
 */
const SETTLE_FLOOR_MS = 1_200;
const SETTLE_BUDGET_MS = 8_000;
const SETTLE_INTERVAL_MS = 200;
const SETTLE_STABLE_SAMPLES = 3;

/**
 * `crawl.spec.ts`'s double-report carve-out, carried forward.
 *
 * A gated route's 404 is already recorded as its classification, and the browser ALSO logs
 * the same 404 as a failed resource load. One cause must not produce two entries in the
 * census. Applied at record time rather than in the console listener, because the listener
 * can fire before the response status is known.
 */
const carveOutDoubleReport = (status: number, details: string[]) =>
  status === 404 ? details.filter((d) => !/Failed to load resource.*404/i.test(d)) : details;

interface Measurement {
  documentClientWidth: number;
  mainFound: boolean;
  mainClientWidth: number | null;
  mainScrollWidth: number | null;
}

/**
 * One reading, in the page.
 *
 * `main#main-content` — the one `#id` selector this file is allowed, and a deliberate one:
 * it buys `e2e:check-ids` rename protection over the element this whole gate depends on.
 * Returns nulls rather than throwing when the shell is absent, so the CALLER decides
 * whether that is legitimate (a gated 404) or a failure (anything else). No `?.` swallowing
 * it — a missing shell on a shell route must be loud.
 */
async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const main = document.querySelector('main#main-content');
    return {
      documentClientWidth: document.documentElement.clientWidth,
      mainFound: main !== null,
      mainClientWidth: main === null ? null : main.clientWidth,
      mainScrollWidth: main === null ? null : main.scrollWidth,
    };
  });
}

const sameWidths = (a: Measurement, b: Measurement) =>
  a.documentClientWidth === b.documentClientWidth &&
  a.mainClientWidth === b.mainClientWidth &&
  a.mainScrollWidth === b.mainScrollWidth;

/** Poll until the widths hold still — see the settle-budget note. */
async function settle(page: Page): Promise<Measurement & { settled: boolean }> {
  const started = Date.now();
  let previous = await measure(page);
  let stableFor = 1;
  for (;;) {
    const elapsed = Date.now() - started;
    const stable = stableFor >= SETTLE_STABLE_SAMPLES && elapsed >= SETTLE_FLOOR_MS;
    if (stable || elapsed >= SETTLE_BUDGET_MS) {
      return { ...previous, settled: stable };
    }
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const next = await measure(page);
    stableFor = sameWidths(previous, next) ? stableFor + 1 : 1;
    previous = next;
  }
}

test.describe('mobile crawl', () => {
  for (const route of ROUTES) {
    test(`${route} fits the viewport`, async ({ page }, testInfo) => {
      const project = testInfo.project.name;
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];

      /**
       * The sidecar is built up as the test advances and written in a `finally`, so a RED
       * route is recorded too — with `stage` naming how far it got. A report that only
       * contains the routes that passed is a report that cannot explain a failure.
       */
      const sidecar: MobileSidecar = {
        project,
        route,
        slug: slugFor(route),
        classification: 'phone',
        status: 0,
        documentClientWidth: -1,
        expectedWidth: -1,
        mainClientWidth: null,
        mainScrollWidth: null,
        overflow: null,
        settled: false,
        screenshot: null,
        stage: 'goto',
        consoleErrors: [],
        pageErrors: [],
      };

      try {
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const text = m.text();
          if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
          consoleErrors.push(text.slice(0, 300));
        });
        page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));

        /**
         * The expected width comes from the PROJECT, never from a hardcoded 360/390. Two
         * projects share this file and a third would too; a literal here would be right for
         * one of them and a silent lie for the others.
         *
         * A narrowing `throw` rather than `viewportSize()!` — `noNonNullAssertion` is an
         * error in this repo's Biome config, with no e2e override, and there are zero `!`
         * assertions in this suite. Same semantics, and a better message.
         */
        const viewport = page.viewportSize();
        if (viewport === null) {
          throw new Error(
            `project ${project} declares no viewport, so there is nothing to measure ` +
              `against — this file may only run under a project with an explicit viewport`,
          );
        }
        sidecar.expectedWidth = viewport.width;

        // VeloExpense: no locale segment in a path.
        const url = route;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const status = response?.status() ?? 0;
        sidecar.status = status;

        /**
         * THE OFFLINE FALLBACK, first and for every route including gated ones.
         *
         * The service worker serves `/<locale>/offline` under whatever URL failed, so if it
         * stands in for a real page the navigation still reports 200 and the DOM still has a
         * `<main>` — and everything after this point would measure the fallback's layout and
         * report it green. The fallback carries `data-testid="offline-page"` (added on
         * `apps/web/src/app/[locale]/offline/page.tsx` for exactly this assertion) so the
         * two are distinguishable. Checked before the gated branch returns, because a route
         * being module-gated does not make a substituted fallback acceptable.
         *
         * THIS ASSERTION IS NEGATIVE 104 TIMES OVER, so on its own it cannot notice the
         * attribute being deleted or mistyped — every count would still be 0 and this whole
         * detector would switch off silently. `pwa-offline.spec.ts` therefore pins the
         * attribute POSITIVELY on the served fallback; see the note at that assertion.
         */
        sidecar.stage = 'offline-fallback';
        expect(
          await page.locator('[data-testid="offline-page"]').count(),
          `${url} served the OFFLINE FALLBACK instead of the page — the service worker ` +
            `answered from cache, so every measurement below would describe the fallback`,
        ).toBe(0);

        if (status === 404) {
          /**
           * GATED — BUT ONLY IF THIS ROUTE IS ALLOWED TO BE.
           *
           * Pages are gated on their platform module, and a route whose module has no
           * active installation returns 404 on purpose: `netsuite-gl` is not in
           * `DEFAULT_ACTIVE_MODULES`, so all ten `/netsuite/*` routes answer 404 on a stock
           * seed and are behaving correctly. Recorded and counted; NO SCREENSHOT, by ruling
           * — "a 404 screenshot is noise a reader will misfile as a broken page". This is
           * why the deliverable is one PNG per phone surface rather than one per route; see
           * the numbers section of the header, and do not put a count here.
           *
           * The allowlist is the whole point. Everything that makes this file a gate sits
           * BELOW this branch — the session guard, the layout-viewport guard, the shell
           * check, the screenshot, the overflow gate, the manifest invariants, the console
           * check — so an unchecked `return` here is a path to a green, empty run.
           * `notFound()` is not only the module gate in this app: it is also the
           * RBAC-denial path and the no-session path, and a deferred platform bootstrap
           * 404s `/dashboard`. `mayBeGated` and its reasoning live in
           * `support/mobile-census.ts`.
           */
          // Set before the assertion, so a route that dies here is recorded as dying here
          // rather than back at `offline-fallback`.
          sidecar.stage = 'gated-allowlist';
          expect(
            mayBeGated(route),
            `${url} answered HTTP 404, and ${route} is NOT a route allowed to be ` +
              `module-gated (see MAY_BE_GATED in e2e/support/mobile-census.ts). A 404 here ` +
              `means a BROKEN SESSION (every notFound() below an auth check), an RBAC ` +
              `change (notFound() is this app's permission-denied path too), or a platform ` +
              `bootstrap that deferred and left the module uninstalled — NOT a gate. If it ` +
              `really is a new gate, add the route to MAY_BE_GATED with the module that ` +
              `gates it; do not widen the pattern to make this pass.`,
          ).toBe(true);
          sidecar.classification = 'gated';
          sidecar.stage = 'gated';
          return;
        }
        expect(status, `${url} returned HTTP ${status}`).toBeLessThan(400);

        /**
         * The session actually loaded, rather than passing green on 50 login pages.
         *
         * `storageState` can be stale, empty, or written by a `setup` project that failed
         * upstream, and the symptom is not an error — it is 52 routes that all render the
         * login form, all fit the viewport perfectly, and all report clean. The gate would
         * be green and would be measuring nothing.
         */
        sidecar.stage = 'session';
        expect(
          page.url(),
          `${url} redirected to the login page — the stored session did not load, so ` +
            `nothing below is measuring the app`,
        ).not.toMatch(/\/login(\/|\?|#|$)/);

        sidecar.stage = 'settle';
        const measured = await settle(page);
        sidecar.documentClientWidth = measured.documentClientWidth;
        sidecar.mainClientWidth = measured.mainClientWidth;
        sidecar.mainScrollWidth = measured.mainScrollWidth;
        sidecar.settled = measured.settled;

        /**
         * THE VIEWPORT GUARD — the difference between a gate and a decoration.
         *
         * `document.documentElement.clientWidth` is the LAYOUT viewport, which is derived
         * from the page's own `<meta name="viewport">` under `isMobile: true`. Without a
         * correct meta tag it is 980 CSS px on a 390px screen: the page then lays out as a
         * shrunken desktop, `main` fits its 980px box exactly, and the overflow gate below
         * passes green having measured a desktop layout on a phone. Every assertion after
         * this line is conditional on this line.
         *
         * PERMANENT, HARD, and with no `test.skip` or named-skip fallback. It is also the
         * tripwire for anyone deleting the `viewport` export from
         * `apps/web/src/app/[locale]/layout.tsx`, which would otherwise silently un-gate
         * this entire file.
         */
        expect(
          measured.documentClientWidth,
          `${url} laid out at ${measured.documentClientWidth}px in a ${sidecar.expectedWidth}px ` +
            `viewport. The layout viewport comes from the page's <meta name="viewport">, so ` +
            `this is that tag missing, wrong, or overridden — NOT a CSS bug. Nothing below ` +
            `this line means anything until it is fixed.`,
        ).toBe(sidecar.expectedWidth);

        /**
         * A shell route with no shell is a failure, not a shrug. Every route here renders
         * inside `(app)`, so a missing `main#main-content` means the id was renamed, the
         * shell threw, or the page rendered something else entirely — all of which must be
         * loud. Asserted before the screenshot so a shell-less route yields no PNG.
         */
        sidecar.stage = 'shell';
        expect(
          measured.mainFound,
          `${url} rendered no main#main-content. Every crawled route lives inside the (app) ` +
            `shell, so this is a renamed id (update this spec in the same PR — see the test ` +
            `contract note in the header) or a shell that failed to render.`,
        ).toBe(true);

        /**
         * The screenshot, AFTER both guards.
         *
         * Deliberate ordering: a regressed viewport or a missing shell must yield ZERO PNGs
         * rather than a directory called `mobile/` full of desktop layouts, which is the
         * most misleading artifact this file could possibly produce.
         *
         * `scale: 'css'` is MANDATORY and is not settable in the config (`use.screenshot`
         * has no `scale` key). `mobile-390` runs at DSF 3, so omitting it is 9× the pixels
         * and 9× the bytes for a layout image where the extra pixels carry nothing. It is a
         * no-op under `mobile-360`, whose DSF is 1, and is passed unconditionally so the two
         * projects do not need different code.
         *
         * Viewport-only, not `fullPage`: the shell root is `h-screen` and `main` scrolls
         * internally, so the document has nothing below the fold for `fullPage` to reach —
         * it would return the same image with a more confusing name. What lands is what a
         * phone reader actually sees.
         */
        sidecar.stage = 'screenshot';
        mkdirSync(projectDir(project), { recursive: true });
        const screenshot = screenshotPathFor(project, route);
        await page.screenshot({ path: screenshot, scale: 'css' });
        sidecar.screenshot = screenshot;

        /**
         * THE DESKTOP-ONLY NOTICE — a plain conditional, never `test.skip`.
         *
         * `test.skip` would be the idiomatic reflex and it is wrong twice: a skipped test
         * emits no screenshot, and one screenshot per phone surface is a deliverable of this
         * task; and a suite that reports "31 passed, 21 skipped" trains a reader to stop
         * asking which 21.
         *
         * Read as RENDERED DOM, never imported. The notice's route registry does not exist
         * yet — it belongs to a later task — and importing from `apps/web/src` into a spec
         * would couple a blocking CI step to that module's own resolution. Reading the DOM
         * means this branch is simply inert until the notice ships, and starts working the
         * day it does, with no edit here.
         *
         * Until then every route is crawled as a phone surface, which is the correct
         * pre-notice behaviour. `DesktopOnlyNotice` rendering exactly one VISIBLE
         * `[data-testid="desktop-only-notice"]` is a contract that task owes this one; the
         * singular-and-visible assertions below are where it gets checked.
         */
        sidecar.stage = 'notice';
        const notice = page.locator('[data-testid="desktop-only-notice"]');
        const noticeCount = await notice.count();
        let classification: MobileClassification = 'phone';
        if (noticeCount > 0) {
          expect(
            noticeCount,
            `${url} rendered ${noticeCount} desktop-only notices; the contract is exactly one`,
          ).toBe(1);
          await expect(
            notice,
            `${url}'s desktop-only notice is in the DOM but not visible`,
          ).toBeVisible();
          classification = 'desktop-notice';
        }
        sidecar.classification = classification;

        /**
         * ─── THE RULING, CHECKED AGAINST THE REGISTRY THE PRODUCT READS ─────────────────
         *
         * One equality, two claims, both directions: a route `mobileReadiness.ts` rules
         * `desktop` must have rendered the notice, and a route it does not rule `desktop`
         * must not have. Before this line the classification was merely RECORDED — the DOM
         * was read, a number was written into a sidecar, and nothing anywhere said whether
         * that number was the right one. Forty routes are ruled `desktop` today and a
         * missing notice on any of them looked exactly like a route that was never ruled.
         *
         * IMPORTED, NEVER TRANSCRIBED. The list of ruled routes lives in one place and this
         * file is not it. A copy in the e2e tree goes stale silently and then lies about
         * which pages a phone can reach, which is the standing rule behind `MAY_BE_GATED`
         * and `MOBILE_EXCLUDED` both. `dispositionFor` is used rather than a raw key lookup
         * so `/admin/approval-workflows/[id]`-shaped paths resolve through
         * longest-prefix-on-a-segment-boundary inheritance exactly as the app resolves them
         * — forty routes are ruled by thirty-nine keys, and a key lookup would miss the
         * fortieth.
         *
         * GATED ROUTES ARE EXCLUDED BY WHAT THIS RUN OBSERVED, NOT BY A LIST — and the
         * exclusion is structural rather than written: the 404 branch above `return`s before
         * reaching this line, so the only routes that get here are the ones that reached a
         * layout. There is nothing to transcribe, nothing to go stale, and a route whose
         * module gate is removed tomorrow starts being checked the same day with no edit
         * here. An exclusion list would have been the same defect as a route list, and would
         * also have gone on excluding a route that stopped being gated.
         *
         * AND IT SITS BELOW THE STATUS CHECK, DELIBERATELY. The ordering of this file is
         * status first, notice second, and it must stay that way: a genuine RBAC 404 or a
         * broken session must fail loudly at the allowlist above rather than arrive here and
         * be reconciled as though it were a gate. Do not hoist this.
         *
         * WHAT IT STILL DOES NOT PROVE: that the notice is USABLE, or that "Continue anyway"
         * works. `e2e/desktop-notice.spec.ts` owns both.
         */
        sidecar.stage = 'ruling';
        const ruling = dispositionFor(route).disposition;
        expect(
          classification,
          `${url} is ruled \`${ruling}\` in mobileReadiness.ts, so it owes ` +
            `\`${expectedClassificationFor(route)}\`, and it reported \`${classification}\`. ` +
            (ruling === 'desktop'
              ? 'A route ruled `desktop` must render the desktop-only notice below `lg`. No ' +
                "notice means the ruling is no longer reaching the page: check the route's " +
                'registry row, remembering that rulings are INHERITED by longest prefix so a ' +
                'parent row moving changes children that carry no row of their own, and check ' +
                'that DesktopOnlyNotice is still mounted by the (app) layout.'
              : 'This route is NOT ruled `desktop` and it rendered the notice anyway, so a ' +
                'page a phone reader is entitled to is being suppressed. Either a registry ' +
                'row is wrong or a prefix is claiming more than it should — the match is on ' +
                'segment boundaries, so check for a row that is a prefix of this path.'),
        ).toBe(expectedClassificationFor(route));

        /**
         * THE GATE.
         *
         * Skipped only for a notice-bearing route, where there is no phone layout to measure
         * by design. That conditional is the hole the census dissent named; it is now backstopped
         * whole-suite by the phone-surface floor in `globalTeardown` — see the header.
         */
        sidecar.stage = 'overflow';
        if (classification === 'phone') {
          const overflow = (measured.mainScrollWidth ?? 0) - (measured.mainClientWidth ?? 0);
          sidecar.overflow = overflow;
          expect(
            overflow,
            `${url} overflows horizontally by ${overflow}px inside main#main-content ` +
              `(scrollWidth ${measured.mainScrollWidth}, clientWidth ${measured.mainClientWidth}, ` +
              `viewport ${sidecar.expectedWidth}). Something in the page is wider than the ` +
              `screen. Tolerance is ${TOLERANCE_PX}px — read the tolerance section of this ` +
              `file's header before raising it.`,
          ).toBeLessThanOrEqual(TOLERANCE_PX);
        }

        /**
         * VeloExpense: ExpenseOS's manifest assertion (exactly one `<link rel="manifest">`,
         * not locale-prefixed) is not here. VeloExpense ships no web app manifest — ExpenseOS's
         * PWA install (`manifest.ts`, `pwa.spec.ts`, `profile-install.mobile.spec.ts`) is not
         * ported — so the assertion would fail every route for a feature VeloExpense has not
         * taken. It comes back with that port.
         */
        /** Console and pageerror last: they accumulate across everything above. */
        sidecar.stage = 'console';
        expect(pageErrors, `${url} threw: ${pageErrors.join(' | ')}`).toHaveLength(0);
        expect(
          consoleErrors,
          `${url} logged console errors: ${consoleErrors.join(' | ')}`,
        ).toHaveLength(0);
        sidecar.stage = 'done';
      } finally {
        sidecar.consoleErrors = carveOutDoubleReport(sidecar.status, consoleErrors);
        sidecar.pageErrors = pageErrors;
        writeSidecar(sidecar);
      }
    });
  }
});

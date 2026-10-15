import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
// VeloExpense: the registry at VeloExpense's path (ExpenseOS: `apps/web/src/app/[locale]/(app)`).
import { dispositionFor } from '../../app/(app)/mobileReadiness';
import { crawlableRoutes } from './routes';

/**
 * Sidecar plumbing and the census for `crawl-mobile.spec.ts`, plus the `globalTeardown`
 * that collates it.
 *
 * WHY THIS FILE EXISTS AT ALL, since the phase that added it was scoped to the spec:
 * because the aggregation pattern the other crawlers use does not work, and does not work
 * for them either. `crawl.spec.ts` and `crawl-roles.spec.ts` push findings into a
 * module-scope array and write the report from `test.afterAll`. That is sound only under
 * `--workers=1`. Under the config's `workers: 3` each worker is a separate PROCESS with
 * its own copy of the module, its own array, and its own `afterAll` — so three reports are
 * written to one path in sequence and the last one wins. Roughly one third of findings
 * retained, nondeterministically. `crawl.spec.ts` says "Run with --workers=1 so the
 * findings below aggregate in one process" and nothing enforces it; the mobile crawl is
 * not going to inherit a reporting mechanism that is already quietly lossy.
 *
 * So: each test writes its OWN file (no shared mutable state, no cross-process
 * assumption), and this module's default export — wired as `globalTeardown`, which runs
 * once in the parent process after every worker has exited — reads them back and prints
 * the census. That is the only place in a parallel Playwright run where a whole-suite view
 * legitimately exists.
 */

/**
 * Routes the mobile crawl drops that the desktop crawlers still walk.
 *
 * `/enroll-mfa` is excluded because THIS CRAWL SCREENSHOTS EVERY ROUTE IT MEASURES, and
 * that page paints a scannable authenticator QR for the crawling account's own TOTP secret:
 * `enroll-mfa/EnrollMfaForm.tsx:13` fires `trpc.auth.startMfaEnrollment` on mount with no
 * `enabled` gate, and `EnrollMfaForm.tsx:45-51` renders the returned `uri` as a 240×240 QR
 * image (with the secret itself one `<details>` toggle away). A capture of that route is a
 * machine-decodable second factor sitting in `e2e/.artifacts/mobile/` — and, on a failure,
 * in the `test-results/` directory the nightly workflow uploads and keeps for 14 days.
 *
 * NOT because crawling it leaves state to undo. An earlier version of this comment said
 * that, and it was disprovable, which matters: a control whose written justification is
 * false is a control the next reader deletes. `startMfaEnrollment` is a
 * `protectedProcedure.query` that mints a throwaway secret and writes NOTHING —
 * `apps/web/src/server/routers/auth.test.ts:250` pins exactly that
 * (`expect(db.user.update).not.toHaveBeenCalled()`) — and the secret becomes a real factor
 * only through `confirmMfaEnrollment` with a valid code. Visiting the route is side-effect
 * free, which is why the three desktop crawlers still walk it and must keep doing so: they
 * take no screenshot, so they have nothing to leak.
 *
 * Lives here rather than in the spec so the teardown classifies against exactly the set the
 * spec walked — two copies of this list is a census that disagrees with the run it describes.
 */
// VeloExpense: empty — VeloExpense has no `/enroll-mfa` (sign-in is SSO). The list stays, so a
// route that must not be photographed has the one place to go.
export const MOBILE_EXCLUDED: readonly string[] = [];

/** The routes the mobile crawl walks. 52 today; discovered, never listed. */
export function mobileRoutes(): string[] {
  return crawlableRoutes(MOBILE_EXCLUDED);
}

/**
 * THE ONLY ROUTES WHOSE 404 MAY BE READ AS "MODULE GATE" RATHER THAN AS A FAILURE.
 *
 * Without this list the spec's gated branch is a path to a green, empty run. It classified
 * ANY 404 as `gated` and returned — before the session guard, the layout-viewport guard,
 * the shell check, the screenshot, the overflow gate, the manifest invariants and the
 * console check. But `notFound()` is not only the module gate in this app; it is also the
 * RBAC-denial path and the no-session path. `(app)/expenses/page.tsx:18` calls it for a
 * missing session and `:25` for a missing permission; `(app)/netsuite/_page.tsx:17` and
 * `:24` do the same. And `server/platform/bootstrap.ts:213` returns early ("no admin user
 * to attribute installs to; deferring") when the seed has not produced an admin yet, which
 * leaves `expense-management`, `virtual-credit-cards` and `travel` uninstalled and 404s
 * about eight crawled routes INCLUDING `/dashboard`. So a stale `e2e/.auth/user.json`, an
 * RBAC regression or a deferred bootstrap would have reclassified route after route as
 * `gated`: exit 0, no PNGs, nothing measured. That is strictly weaker than
 * `crawl.spec.ts`, which records a 404 as a `gated` FINDING and keeps crawling the page.
 *
 * MAY, NOT MUST. A route on this list that answers < 400 is measured as an ordinary phone
 * surface, and that is the common case for one of them: `/admin/assistant-feedback` is
 * gated on the `anthropic` module, which bootstraps only when `ANTHROPIC_API_KEY` is set,
 * so it is a live phone surface on a box with the key. Same for `/netsuite/*` the day
 * someone activates `netsuite-gl`. Nothing here asserts a gated COUNT — that number is 11
 * or 10 by environment and is not to be hardcoded anywhere.
 *
 * Anchored patterns, not `includes`: `/^\/netsuite\//` must not match a future
 * `/admin/netsuite/…`, which would be a different page with a different gate.
 */
export const MAY_BE_GATED: readonly RegExp[] = [
  // VeloExpense: none yet. ExpenseOS's two — the NetSuite reference-cache pages and
  // `/admin/assistant-feedback` — are not VeloExpense routes. A VeloExpense module gate that
  // answers 404 joins here with the module that gates it, as the header says.
];

/** Whether a 404 on this route is allowed to mean "module gate". See `MAY_BE_GATED`. */
export function mayBeGated(route: string): boolean {
  return MAY_BE_GATED.some((pattern) => pattern.test(route));
}

/** Root of the mobile crawl's output. Already covered by `.gitignore`'s `e2e/.artifacts/`. */
export const MOBILE_ARTIFACT_DIR = path.join('e2e', '.artifacts', 'mobile');

/** Where the collated census is written. Inside `.artifacts/` on purpose — it is generated
 *  output, and putting it there means no new `.gitignore` entry can be forgotten. */
export const CENSUS_PATH = path.join(MOBILE_ARTIFACT_DIR, 'census.md');

/**
 * ─── RUN IDENTITY: WHY ONE RUN'S CENSUS DESCRIBES ONE RUN ────────────────────────────────
 *
 * This whole mechanism exists because it once did not, and the evidence was corrupt. The
 * artifacts on disk when this was written were an AGGREGATE OF TWO SEPARATE RUNS —
 * `mobile-390` at 13:06 and `mobile-360` at 13:08 — while `test-results/.last-run.json`
 * recorded three failures from `mobile-360` alone. The "11 gated / 41 phone" figure for
 * both projects was only combinable because nothing ever cleaned up. A stale sidecar for a
 * route still in the current set was counted as `live`, so the census reported coverage, a
 * classification, a delta and a PNG for a route the run never visited. The earlier version
 * of `censusFor` mitigated only the DELETED-route case, which is the rarer half.
 *
 * Two mechanisms, and both are wanted:
 *
 *   1. `resetMobileArtifacts()`, wired as `globalSetup`, empties the directory once per
 *      `playwright test` invocation before any project starts. That is what makes the PNG
 *      corpus, the sidecars and `census.md` describe this run and nothing else.
 *   2. Every sidecar is stamped with this run's id and the teardown counts only its own.
 *      Not redundant: it is what keeps the guarantee if the reset ever fails, is unwired,
 *      or is bypassed (someone running Playwright with `--global-setup` off, or a config
 *      the `globalSetup` line was dropped from). A missing stamp makes the census go
 *      SILENT and say so, rather than quietly counting last week's numbers.
 *
 * TWO CONSEQUENCES A READER SHOULD EXPECT, both correct and neither an accident:
 *
 *   · `npx playwright test --project=mobile-360` clears `mobile-390/` too. One invocation
 *     produces one census, and the census says what ran. If you want both, run both — that
 *     is what `npm run test:e2e:mobile` does.
 *   · Any other Playwright invocation clears the corpus as well, including a single desktop
 *     spec. `globalSetup` cannot know which projects the run will select, and the honest
 *     failure direction is "the evidence is gone, reproduce it" rather than "the evidence
 *     is a mixture of runs and reads as one". Reproducing is one command.
 */
const RUN_ID_ENV = 'MOBILE_CRAWL_RUN_ID';

/**
 * The declaration that this run was deliberately narrowed, and so is not the gate.
 *
 * Read by the reported-count companion in the teardown; see the note there for why a
 * declaration is the only mechanism available (Playwright's CLI `--grep` never reaches the
 * `FullConfig` a `globalTeardown` is handed). Set it on a `--grep` run you want to end
 * green; never set it in CI, and nothing in `package.json` or `.github/` sets it.
 */
const PARTIAL_ENV = 'MOBILE_CRAWL_PARTIAL';

/** Whether this run has declared itself partial. Any non-empty value counts. */
function partialRunDeclared(): boolean {
  return (process.env[PARTIAL_ENV] ?? '') !== '';
}

/** This invocation's run id, or `''` when `globalSetup` did not run. */
function currentRunId(): string {
  return process.env[RUN_ID_ENV] ?? '';
}

/**
 * Empty the mobile artifact directory and open a new run. Wired as `globalSetup` via
 * `mobile-reset.ts` — see the run-identity note above for why, and for what it clears.
 *
 * `force: true` so a first-ever run (no directory yet) is not an error, and the id is
 * published through the environment because Playwright spawns its workers AFTER
 * `globalSetup` returns, so they inherit it; `globalTeardown` runs in this same process and
 * reads it directly.
 */
export function resetMobileArtifacts(): string {
  rmSync(MOBILE_ARTIFACT_DIR, { recursive: true, force: true });
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  process.env[RUN_ID_ENV] = runId;
  return runId;
}

/**
 * How a route was classified, which decides what it owes.
 *
 * · `gated`    — answered 404. Recorded and counted; emits NO screenshot (see below).
 * · `phone`    — a real phone surface. Measured, gated on overflow, screenshotted.
 * · `desktop-notice` — rendered the desktop-only notice instead of the page. Screenshotted,
 *                but NOT overflow-gated: there is no phone layout to measure, by design.
 *                Nothing produces this classification yet; see the spec's notice note.
 */
export type MobileClassification = 'gated' | 'phone' | 'desktop-notice';

/**
 * WHAT THE REGISTRY SAYS A ROUTE OWES, for a route the crawl actually reached.
 *
 * ─── WHY THE READINESS REGISTRY IS IMPORTED INTO THE e2e TREE ────────────────────────────
 *
 * `crawl-mobile.spec.ts` shipped reading the notice as RENDERED DOM and nothing else, with a
 * note saying the registry "does not exist yet" and that importing from `apps/web/src` into a
 * spec would couple a blocking CI step to that module's resolution. Both halves of that note
 * are now spent: the registry shipped in T04, and P10 rules forty routes through it. What the
 * DOM-only reading cannot do is tell a MISSING notice from a route that was never meant to
 * have one — it classifies `phone` in both cases and reports green. Forty routes whose ruling
 * nothing checks is forty rulings that can silently stop being true.
 *
 * So the registry is imported, by relative path, and it is imported rather than TRANSCRIBED.
 * A route list copied into the e2e tree is the failure this whole support module exists to
 * avoid (see `MOBILE_EXCLUDED`'s closing note and `MAY_BE_GATED`'s): a second copy goes stale
 * silently and then lies about which pages a phone can reach. `e2e/pwa.spec.ts` and
 * `e2e/pwa-offline.spec.ts` already import `apps/web/src/sw/workerSource` the same way, so the
 * shape is not new here.
 *
 * ─── GATED ROUTES ARE NOT THIS FUNCTION'S BUSINESS ───────────────────────────────────────
 *
 * A route that answered 404 never reached a layout, so it can neither carry a notice nor be a
 * phone surface, and the registry's ruling for it is unobservable — `mobileReadiness.ts`'s
 * header says so in those words for the eleven module-gated rows. This function therefore
 * returns only the two classifications a REACHED route can have, and every caller excludes
 * `gated` by what the run OBSERVED rather than by a list of routes it believes to be gated.
 * That distinction is the point: a transcribed exclusion list would be the same defect as a
 * transcribed route list, and it would also go on excluding a route whose gate was removed.
 */
export function expectedClassificationFor(route: string): 'phone' | 'desktop-notice' {
  return dispositionFor(route).disposition === 'desktop' ? 'desktop-notice' : 'phone';
}

/**
 * The routes the crawl walks that the registry rules `desktop`. Used by the crawl spec's
 * collection-time floor; exported from here so the registry has ONE import site per file
 * rather than a second spelling of the same filter in the spec.
 */
export function desktopRuledRoutes(routes: readonly string[] = mobileRoutes()): string[] {
  return routes.filter((route) => expectedClassificationFor(route) === 'desktop-notice');
}

/** One route, as one project measured it. Written by the test, read by the teardown. */
export interface MobileSidecar {
  project: string;
  route: string;
  slug: string;
  classification: MobileClassification;
  /** HTTP status of the navigation. */
  status: number;
  /** `document.documentElement.clientWidth` — the LAYOUT viewport, not the project's. */
  documentClientWidth: number;
  /** The project's declared viewport width, which the above must equal exactly. */
  expectedWidth: number;
  /** `main#main-content` geometry. `null` when the shell was not present (gated routes). */
  mainClientWidth: number | null;
  mainScrollWidth: number | null;
  /** `scrollWidth - clientWidth` on `main`. The number the gate is about. `null` if unmeasured. */
  overflow: number | null;
  /** Did the width readings stop changing before the settle budget ran out? */
  settled: boolean;
  /** Whether a PNG was written, and where. */
  screenshot: string | null;
  /** How far through the assertion order this route got — tells you where a red route died. */
  stage: string;
  consoleErrors: string[];
  pageErrors: string[];
}

/**
 * A sidecar as it exists ON DISK: what the test built, plus the run stamp `writeSidecar`
 * adds. Separate from `MobileSidecar` so the spec never has to thread a run id through
 * fifteen fields it does not care about — the stamp is plumbing, not a measurement.
 */
interface StoredSidecar extends MobileSidecar {
  runId: string;
}

/**
 * Route → filename: drop the leading `/`, turn every remaining `/` into `__`. So
 * `/admin/roles` → `admin__roles` and `/dashboard` → `dashboard`.
 *
 * (`/` itself would yield the empty string, not `__` as an earlier version of this comment
 * claimed — and it could never get here anyway: `assertSlugsAreInjective` rejects an empty
 * segment, and `/` is not in the crawl set at all because `discoverRoutes` only emits a
 * route for a subdirectory holding `page.tsx`. See `routes.ts:30-34`.)
 *
 * NOT `/` → `-`. That is the obvious scheme and it is not injective: `/a/b` and `/a-b`
 * both become `a-b`. Measured honestly: that scheme has NO collision across the 52 routes as
 * they stand today, so `__` is a choice made against a FUTURE route rather than a fix for a
 * present bug. It is one route away though — the tree already holds `/virtual-cards/import`
 * and `/virtual-cards/import-cards`, so adding a hyphenated sibling of any existing
 * directory (`/virtual-cards-import/cards`) collides. Two routes sharing a filename means one
 * silently overwrites the other's PNG and sidecar, and the census reports 51 of 52 with no
 * error anywhere — worth ruling out by construction rather than by luck.
 *
 * `__` is injective GIVEN that no path segment contains an underscore, which
 * `assertSlugsAreInjective` below proves rather than assumes. That is the whole reason the
 * check is a structural one on segments and not just a duplicate count: a duplicate count
 * passes today and starts failing on the day someone adds the colliding route, which is
 * the worst possible time to discover the scheme was never sound.
 *
 * The `<project>` directory above the slug is load-bearing too — `mobile-360` and
 * `mobile-390` walk the same 52 routes, so without it two projects race on one path and
 * the surviving PNG is whichever finished last.
 */
export function slugFor(route: string): string {
  return route.replace(/^\//, '').replace(/\//g, '__');
}

/** Directory holding one project's artifacts. */
export function projectDir(project: string): string {
  return path.join(MOBILE_ARTIFACT_DIR, project);
}

export function sidecarPathFor(project: string, route: string): string {
  return path.join(projectDir(project), `${slugFor(route)}.json`);
}

export function screenshotPathFor(project: string, route: string): string {
  return path.join(projectDir(project), `${slugFor(route)}.png`);
}

/**
 * Prove the slug scheme is collision-free for the routes actually being walked, and throw
 * if it is not.
 *
 * Called at module scope in the spec, so a violation fails the whole file at collection
 * time — loudly, before a single browser starts — rather than corrupting one pair of
 * artifacts halfway through a run. Deliberately NOT a test: the spec's test count is
 * asserted elsewhere (52 routes × 2 projects = 104), and a 105th test that is really an
 * invariant check would make that number mean less.
 */
export function assertSlugsAreInjective(routes: readonly string[]): void {
  /** No `_` and no `.`: the first makes `__` ambiguous, the second is filename trouble. */
  const SAFE_SEGMENT = /^[A-Za-z0-9-]+$/;
  const unsafe = routes.filter((route) =>
    route
      .replace(/^\//, '')
      .split('/')
      .some((segment) => !SAFE_SEGMENT.test(segment)),
  );
  if (unsafe.length) {
    throw new Error(
      `crawl-mobile: these routes have a path segment that breaks the slug scheme ` +
        `(a segment may only contain letters, digits and '-', because '__' encodes '/'): ` +
        `${unsafe.join(', ')}. Change the slug encoding in e2e/support/mobile-census.ts — ` +
        `do not weaken this check.`,
    );
  }

  const bySlug = new Map<string, string[]>();
  for (const route of routes) {
    const slug = slugFor(route);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), route]);
  }
  const collisions = [...bySlug.entries()].filter(([, rs]) => rs.length > 1);
  if (collisions.length) {
    throw new Error(
      `crawl-mobile: slug collision — ${collisions
        .map(([slug, rs]) => `${slug} <- ${rs.join(' + ')}`)
        .join('; ')}`,
    );
  }
}

/**
 * Write one route's sidecar. Called in a `finally`, so a RED route is recorded too.
 *
 * The run stamp is added here rather than by the caller, so there is exactly one place a
 * sidecar can be born and no way for the spec to forget it.
 */
export function writeSidecar(sidecar: MobileSidecar): void {
  const stored: StoredSidecar = { ...sidecar, runId: currentRunId() };
  mkdirSync(projectDir(sidecar.project), { recursive: true });
  writeFileSync(sidecarPathFor(sidecar.project, sidecar.route), JSON.stringify(stored, null, 2));
}

/**
 * Is this parsed JSON actually a sidecar this version of the code can read?
 *
 * NOT a formality. The previous version `JSON.parse`d straight into the `MobileSidecar`
 * type — a cast with no check behind it — so the day a field is added or renamed, an older
 * sidecar surviving on disk would satisfy the compiler and then make `censusFor`
 * dereference `undefined.length` inside `globalTeardown`. A throwing teardown fails the
 * whole run, which means a REPORTING bug would turn an otherwise-green suite red and point
 * the reader at the wrong file. Validated and skipped-with-a-warning instead: a sidecar
 * that cannot be read is one route short in the census, which is a visible symptom that
 * blames nothing innocent.
 */
function isStoredSidecar(value: unknown): value is StoredSidecar {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  const isStr = (v: unknown) => typeof v === 'string';
  const isNum = (v: unknown) => typeof v === 'number';
  const isNumOrNull = (v: unknown) => v === null || typeof v === 'number';
  const isStrArray = (v: unknown) => Array.isArray(v) && v.every(isStr);
  const CLASSIFICATIONS: readonly string[] = ['gated', 'phone', 'desktop-notice'];
  return (
    [s.runId, s.project, s.route, s.slug, s.stage].every(isStr) &&
    isStr(s.classification) &&
    CLASSIFICATIONS.includes(s.classification as string) &&
    [s.status, s.documentClientWidth, s.expectedWidth].every(isNum) &&
    [s.mainClientWidth, s.mainScrollWidth, s.overflow].every(isNumOrNull) &&
    typeof s.settled === 'boolean' &&
    (s.screenshot === null || isStr(s.screenshot)) &&
    isStrArray(s.consoleErrors) &&
    isStrArray(s.pageErrors)
  );
}

function readSidecars(): StoredSidecar[] {
  let projects: string[];
  try {
    projects = readdirSync(MOBILE_ARTIFACT_DIR).filter((entry) =>
      statSync(path.join(MOBILE_ARTIFACT_DIR, entry)).isDirectory(),
    );
  } catch {
    return []; // No mobile run in this invocation — see the no-op note in the teardown.
  }
  const out: StoredSidecar[] = [];
  for (const project of projects) {
    for (const file of readdirSync(projectDir(project))) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(projectDir(project), file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        // A truncated sidecar from a killed worker. Skipped, and the census's
        // "reported" count will be short of 52, which is the visible symptom.
        console.warn(`  mobile census: ${full} is not readable JSON; skipped`);
        continue;
      }
      if (!isStoredSidecar(parsed)) {
        console.warn(
          `  mobile census: ${full} is not a sidecar this version can read (a field was ` +
            `added, renamed or retyped since it was written); skipped`,
        );
        continue;
      }
      out.push(parsed);
    }
  }
  return out;
}

function censusFor(project: string, sidecars: StoredSidecar[], current: Set<string>): string[] {
  const mine = sidecars.filter((s) => s.project === project);
  /**
   * Every sidecar reaching here is from THIS run — the directory was emptied by
   * `resetMobileArtifacts()` and the caller has already filtered on the run stamp (see the
   * run-identity note). So `stale` should now be empty by construction, and it is kept as a
   * TRIPWIRE rather than as the mitigation it used to be: the one way it can still fill is
   * the discovered route set changing between the spec's collection and this teardown, and
   * if that ever happens a reader needs to be told rather than shown a quietly short count.
   */
  const live = mine.filter((s) => current.has(s.route));
  const stale = mine.filter((s) => !current.has(s.route));
  const of = (k: MobileClassification) => live.filter((s) => s.classification === k);
  const phone = of('phone');
  const missing = [...current].filter((r) => !live.some((s) => s.route === r));

  const withOverflow = phone.filter((s) => s.overflow !== null);
  const worst = withOverflow.reduce<MobileSidecar | null>(
    (acc, s) => (acc === null || (s.overflow ?? 0) > (acc.overflow ?? 0) ? s : acc),
    null,
  );

  const lines = [
    `## ${project}`,
    '',
    `| Measure | Count |`,
    `|---|---|`,
    `| Routes discovered for the mobile crawl | ${current.size} |`,
    `| Reported (a sidecar landed) | ${live.length} |`,
    `| Phone surfaces | ${phone.length} |`,
    `| Gated (404, module inactive — no screenshot by ruling) | ${of('gated').length} |`,
    `| Desktop-only notice | ${of('desktop-notice').length} |`,
    `| Screenshots written | ${live.filter((s) => s.screenshot !== null).length} |`,
    // Gated routes return before the settle loop runs, so `settled` is still false on them
    // by construction. Counting those would report every gated route as an unsettled width
    // on a perfectly clean run, and teach the reader to ignore the row.
    `| Widths that never settled | ${
      live.filter((s) => s.classification !== 'gated' && !s.settled).length
    } |`,
    '',
  ];

  if (missing.length) {
    lines.push(
      `Not reported (${missing.length}) — expected when a run is filtered with \`--grep\`, ` +
        `a finding when it is not: ${missing.map((r) => `\`${r}\``).join(', ')}`,
      '',
    );
  }
  if (stale.length) {
    lines.push(
      `Stale sidecars from an earlier run, ignored above (${stale.length}): ` +
        `${stale.map((s) => `\`${s.route}\``).join(', ')}`,
      '',
    );
  }

  lines.push(
    `Worst overflow on a phone surface: ${
      worst === null ? 'nothing measured' : `${worst.overflow}px on \`${worst.route}\``
    }`,
    '',
    '### Per-route overflow (`main#main-content` scrollWidth − clientWidth)',
    '',
    '| Route | Slug | Class | Status | Layout vw | main cw | main sw | Δ | Settled | PNG |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const s of [...live].sort((a, b) => a.route.localeCompare(b.route))) {
    lines.push(
      `| \`${s.route}\` | \`${s.slug}\` | ${s.classification} | ${s.status} | ` +
        `${s.documentClientWidth} | ${s.mainClientWidth ?? '—'} | ${s.mainScrollWidth ?? '—'} | ` +
        `${s.overflow ?? '—'} | ${s.settled ? 'yes' : 'NO'} | ${s.screenshot ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');

  const noisy = live.filter((s) => s.consoleErrors.length || s.pageErrors.length);
  if (noisy.length) {
    lines.push('### Console / pageerror', '', '| Route | Kind | Detail |', '|---|---|---|');
    for (const s of noisy) {
      for (const detail of s.pageErrors) {
        lines.push(`| \`${s.route}\` | pageerror | ${detail.replace(/\|/g, '\\|')} |`);
      }
      for (const detail of s.consoleErrors) {
        lines.push(`| \`${s.route}\` | console | ${detail.replace(/\|/g, '\\|')} |`);
      }
    }
    lines.push('');
  }
  return lines;
}

/**
 * Collate the sidecars, PRINT the census, and assert the one thing a printed census cannot:
 * that the run measured any phone surfaces at all. Wired as `globalTeardown`.
 *
 * THE ONE ASSERTION, AND WHY IT IS HERE. T02 shipped this function asserting nothing, over a
 * live dissent from UX and QA whose shared principle is "never trade an assertion for a
 * report". Both named the same cheap detector — UX's `desktop-classified < 52`, QA's
 * `expect(phoneSurfaces).toBeGreaterThan(0)` — and both agreed it belonged to the task that
 * ships the desktop-only notice, because until then there was no mechanism that could invert.
 * T04 ships it (ADR-0005), so the debt is paid here in QA's form.
 *
 * The failure mode it closes: `crawl-mobile.spec.ts` skips its overflow gate on any route
 * classified `desktop-notice`, because a notice-bearing route has no phone layout to measure.
 * Invert the notice's condition — flip `lg:hidden` and `hidden lg:contents`, or make
 * `dispositionFor` return `desktop` by default — and EVERY route reports `desktop-notice`,
 * EVERY route skips the gate, and 104 tests pass having measured nothing. Nothing in the spec
 * notices, because from inside a test the skip is correct behaviour. Only a whole-suite view
 * can tell "no route overflowed" from "no route was looked at", and this teardown is the only
 * place in a parallel run where that view legitimately exists.
 *
 * It is deliberately a FLOOR (`> 0`) and not a count. A count would have to be revised by
 * every one of the eleven page tasks that rules a route `desktop`, and a number that has to be
 * edited eleven times is a number that gets edited to whatever the run produced. `> 0` fails
 * only on the shape the dissent named, and no page task can legitimately drive it to zero:
 * ruling all 41 non-gated routes `desktop` is not a thing this epic can do.
 *
 * WATCHED TO FAIL, not reasoned about. `DesktopOnlyNotice`'s early return was inverted
 * (`disposition === 'desktop'` for `!==`) so the notice renders on every route, and
 * `--project=mobile-360` over three routes reported:
 *
 *     mobile-360: 3/52 reported — 0 phone, 0 gated, 3 desktop-notice, 3 png; max overflow —px
 *     Error: mobile-360: 0 phone surfaces reported. ...
 *     expect(received).toBeGreaterThan(expected)  Expected: > 0  Received: 0
 *     14 passed
 *     1 error was not a part of any test, see above for details
 *
 * READ THE LAST TWO LINES TOGETHER — that is the whole argument for this assertion living in
 * a teardown. Every single test passed. The suite had no opinion, because from inside a test
 * a skipped gate on a notice-bearing route is correct behaviour. Only the whole-suite view
 * could tell that nothing had been measured. Restored, and the same three routes went back to
 * `3 phone, 0 desktop-notice` and green.
 *
 * A NO-OP WHEN THIS RUN WROTE NO SIDECARS, and that guarantee is now real rather than
 * merely stated. This is a GLOBAL teardown, so it also runs after a single-spec desktop
 * run like `npx playwright test e2e/smoke.spec.ts`, where the mobile projects match no
 * tests. It used to be silent there only on a machine that had never run the mobile crawl:
 * once the corpus existed, every later desktop run printed a full census with the LAST
 * run's numbers. `resetMobileArtifacts()` and the run stamp fix that from both ends — see
 * the run-identity note above. A desktop run that prints a mobile census is a reader taught
 * to ignore the census.
 */
export default async function collateMobileCensus(): Promise<void> {
  const runId = currentRunId();
  const onDisk = readSidecars();
  const sidecars = runId === '' ? [] : onDisk.filter((s) => s.runId === runId);
  if (sidecars.length === 0) {
    /**
     * Sidecars exist but none are this run's: either `globalSetup` did not run (no run id
     * to match) or every file predates it. Both mean the census cannot honestly describe
     * the run, and both are configuration problems rather than test failures — so this
     * says so and returns, rather than printing numbers it cannot vouch for.
     */
    if (onDisk.length > 0) {
      console.warn(
        `\nmobile crawl census: ${onDisk.length} sidecar(s) on disk, none from this run` +
          `${runId === '' ? ` (no ${RUN_ID_ENV} — is the config's globalSetup line still wired to e2e/support/mobile-reset.ts?)` : ''}.` +
          ` Nothing collated; delete ${MOBILE_ARTIFACT_DIR} and re-run.\n`,
      );
    }
    return;
  }

  const current = new Set(mobileRoutes());
  const projects = [...new Set(sidecars.map((s) => s.project))].sort();
  const lines = [
    '# Mobile crawl census',
    '',
    'Collated by `globalTeardown` from the per-route sidecars in this directory, because',
    'module-scope `afterAll` aggregation does not survive parallel workers. Printed, not',
    'asserted — see the note in `e2e/support/mobile-census.ts`.',
    '',
  ];
  for (const project of projects) lines.push(...censusFor(project, sidecars, current));

  mkdirSync(MOBILE_ARTIFACT_DIR, { recursive: true });
  writeFileSync(CENSUS_PATH, `${lines.join('\n')}\n`);

  // The short form on stdout, so a CI log carries the counts without the report file.
  console.log('\nmobile crawl census');
  const phoneSurfacesByProject = new Map<string, number>();
  /** The same `live` slice the loop below prints, kept for the companion assertions. */
  const liveByProject = new Map<string, StoredSidecar[]>();
  for (const project of projects) {
    const live = sidecars.filter((s) => s.project === project && current.has(s.route));
    liveByProject.set(project, live);
    const phone = live.filter((s) => s.classification === 'phone');
    phoneSurfacesByProject.set(project, phone.length);
    const deltas = phone.map((s) => s.overflow ?? 0);
    console.log(
      `  ${project}: ${live.length}/${current.size} reported — ` +
        `${phone.length} phone, ${live.filter((s) => s.classification === 'gated').length} gated, ` +
        `${live.filter((s) => s.classification === 'desktop-notice').length} desktop-notice, ` +
        `${live.filter((s) => s.screenshot !== null).length} png; ` +
        `max overflow ${deltas.length ? Math.max(...deltas) : '—'}px`,
    );
  }
  console.log(`  ${CENSUS_PATH}\n`);

  /**
   * THE FLOOR. Printed first, above, so a red teardown still hands the reader the census it
   * was asserting against — the counts are the diagnosis, and losing them to the failure
   * would be the worst possible trade.
   *
   * Per project rather than summed: two phone projects with one of them silently collecting
   * nothing is exactly as broken as both collecting nothing, and a sum hides it.
   */
  for (const project of projects) {
    const phoneSurfaces = phoneSurfacesByProject.get(project) ?? 0;
    expect(
      phoneSurfaces,
      `${project}: 0 phone surfaces reported. The crawl measured horizontal overflow on ` +
        'NOTHING, and every one of its tests still passed, because the overflow gate is ' +
        'skipped on any route classified `gated` or `desktop-notice`. The likely cause is an ' +
        'inverted layout condition in `DesktopOnlyNotice.tsx` or a `mobileReadiness.ts` ' +
        'default of `desktop`, either of which makes every route report as notice-bearing. ' +
        `Read ${CENSUS_PATH} for the per-route classifications.`,
    ).toBeGreaterThan(0);
  }

  /**
   * ─── THE COMPANION: THE HALF THE FLOOR ABOVE CANNOT SEE ──────────────────────────────
   *
   * `phoneSurfaces > 0` answers "was ANYTHING measured". It does not answer "was EVERYTHING
   * looked at", and after P10 the gap between those two questions is forty routes wide. A
   * run that walked three routes, found one phone surface among them and never reached the
   * other forty-nine satisfies the floor completely. Two assertions close that, and they are
   * deliberately different in kind.
   */
  for (const project of projects) {
    const live = liveByProject.get(project) ?? [];

    /**
     * (a) THE REPORTED COUNT. Every discovered route must have landed a sidecar.
     *
     * The census has printed a "Not reported (N) — expected when a run is filtered with
     * `--grep`, a finding when it is not" line since T02, and that sentence was unenforceable
     * as long as nothing could tell the two cases apart. Nothing still can: Playwright applies
     * a CLI `--grep` through the run OPTIONS and never writes it into the `FullConfig` this
     * teardown is handed (`node_modules/playwright/lib/runner/index.js:6392` calls the hook
     * with `config.config`, whose `grep` stays the config file's own default `/.*\/`, while
     * the filter is applied at `:6459` from `testRun.options.grep`). So the RUN has to say so,
     * and `MOBILE_CRAWL_PARTIAL` is how it says so.
     *
     * DEFAULT-STRICT, AND THE WAIVER IS LOUD. An opt-out that defaults to "waived" is the
     * silent no-op this file refuses everywhere else; an opt-out that waives without printing
     * is the same thing one CI log away. Neither `npm run test:e2e:mobile` nor the nightly
     * sets it, and neither may: a partial run is not this gate.
     */
    if (partialRunDeclared()) {
      console.warn(
        `  mobile census: ${PARTIAL_ENV} is set, so ${project}'s reported-count check is ` +
          `WAIVED (${live.length}/${current.size} reported). This run is not the gate.`,
      );
    } else {
      const notReported = [...current].filter((r) => !live.some((s) => s.route === r)).sort();
      expect(
        notReported,
        `${project} reported ${live.length} of ${current.size} discovered routes. The ` +
          'crawl is a gate over EVERY route it discovers, and a route that never reported ' +
          'is a route nothing checked — the floor above cannot see this, because one phone ' +
          'surface out of fifty-two satisfies it. If the run was deliberately narrowed ' +
          `(\`--grep\`, \`--last-failed\`, a single test id), re-run it with ${PARTIAL_ENV}=1 ` +
          'to say so — Playwright does not put a CLI filter anywhere this teardown can read. ' +
          `Otherwise this is worker death, a collection error, or a route removed from the ` +
          `app between collection and teardown. Read ${CENSUS_PATH}.`,
      ).toEqual([]);
    }

    /**
     * (b) THE WHOLE-RUN RECONCILIATION against the readiness registry.
     *
     * `crawl-mobile.spec.ts` makes this claim per route, inside the test, and that is the
     * right place for it — it fails on the route that broke it, with that route's URL. What
     * a per-test assertion CANNOT do is notice a route whose test died BEFORE reaching it.
     * The sidecar is written in a `finally`, so a route that threw at `stage: 'settle'`
     * still lands on disk carrying the DEFAULT classification `phone`; if that route is
     * ruled `desktop`, the spec's assertion never ran and only a whole-suite view can say
     * the ruling went unchecked. This is that view. It is the reason the registry is
     * imported into this module as well as into the spec, rather than only into the spec:
     * module-scope aggregation does not survive parallel workers, so the reconciliation
     * cannot live in the spec's own `afterAll` (see this file's opening note).
     *
     * GATED ROUTES ARE EXCLUDED BY WHAT THE RUN OBSERVED, never by a list. A 404 route never
     * reached a layout, so its ruling is unobservable — `mobileReadiness.ts` says exactly
     * that of its eleven module-gated rows. Filtering on `s.classification !== 'gated'` is
     * the whole exclusion: no route names, nothing to go stale, and a route whose gate is
     * removed tomorrow starts being reconciled the same day without an edit here.
     */
    const reached = live.filter((s) => s.classification !== 'gated');
    const disagreed = reached
      .filter((s) => s.classification !== expectedClassificationFor(s.route))
      .map(
        (s) =>
          `${s.route}: registry rules it \`${dispositionFor(s.route).disposition}\`, so it ` +
          `owes \`${expectedClassificationFor(s.route)}\`, but the run reported ` +
          `\`${s.classification}\` (stage ${s.stage})`,
      )
      .sort();
    expect(
      disagreed,
      `${project}: these reached routes did not classify the way mobileReadiness.ts rules ` +
        'them. A route ruled `desktop` must render exactly one visible desktop-only notice ' +
        'and anything else must render none. `crawl-mobile.spec.ts` asserts this per route ' +
        'too; a route reaching THIS message and not that one died before its own assertion ' +
        `ran, so read its \`stage\` above and its sidecar in ${MOBILE_ARTIFACT_DIR}. Routes ` +
        'that answered 404 are excluded here by their OBSERVED classification, because a ' +
        'gated route never reaches a layout and its ruling cannot be seen.',
    ).toEqual([]);
  }
}

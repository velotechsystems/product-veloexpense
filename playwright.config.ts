/**
 * VX1-9 — Playwright config for the Phase-1 happy path.
 *
 * THREE web servers, all started by Playwright so `npm run e2e` is the whole
 * command on a laptop and in CI:
 *   - scripts/e2e-storage.mjs — an S3 surface for the presigned receipt upload
 *   - scripts/e2e-mail.mjs    — a real SMTP server, added by VX2-10 (see below)
 *   - the built Next app, pointed at both and at the test database
 *
 * WHY A REAL MAIL SERVER (VX2-10). Every VX2-8 unit test runs on the in-memory
 * transport, which proves a message was composed and nothing about whether mail
 * works — the same trap VX1-9 recorded for MemoryStorage, and the only thing
 * that can catch quoted-printable breaking an approve token across two lines.
 * `smtp-server` is one Node process, same argument as s3rver over MinIO.
 *
 * The app runs the STANDALONE build — `npm run start:standalone`, not
 * `npm run start`. next.config.ts sets `output: 'standalone'` (the Docker
 * runner copies `.next/standalone`), and with that setting `next start` warns
 * that it does not work and serves something other than what ships. The
 * standalone server needs `public/` and `.next/static` copied beside it, which
 * is what the script does. `npm run e2e` builds first.
 *
 * Auth: the `setup` project mints a session cookie (e2e/auth.setup.ts) and the
 * spec project reuses it via storageState. SSO is invite-only and redirects to
 * Google/Entra, which cannot run in CI.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;
// 9401, not 9000. 9000 is MinIO's default and a dozen other things' — and on one
// developer's machine something held it, so Playwright's port probe found an
// answer, decided the sink was already up, never started s3rver, and left the app
// presigning receipt uploads against a stranger. Three specs then failed on a
// drawer that never listed the file, pointing at the upload code. The absent
// "e2e storage listening on…" line in the log was the only clue, and it is an
// absence, which is the hardest kind of clue to notice.
//
// A quieter port does not FIX that class of bug — `reuseExistingServer: false`
// below is what fixes it — but it removes the collision that is actually likely.
const STORAGE_PORT = Number(process.env.E2E_STORAGE_PORT ?? 9401);
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 2525);
// Playwright waits on a PORT for readiness and cannot probe SMTP, so the sink
// also serves its captured inbox over HTTP — which is how the spec reads it.
const MAIL_HTTP_PORT = Number(process.env.E2E_MAIL_HTTP_PORT ?? 2526);
// VX3-9a — the ledger sink. Two ports for the same reason the mail sink has two:
// Playwright waits on a port for readiness, and the port the app POSTs bills to is
// not the port a spec should be able to read (or write) evidence on.
// 9411/9412 rather than anything round, per the 9401 note above.
const LEDGER_PORT = Number(process.env.E2E_LEDGER_PORT ?? 9411);
const LEDGER_CONTROL_PORT = Number(process.env.E2E_LEDGER_CONTROL_PORT ?? 9412);
// VX5-20. The platform sink: the seat push has to leave the process to be
// checkable at all (scripts/e2e-platform.mjs explains why a mock cannot do it).
const PLATFORM_PORT = Number(process.env.E2E_PLATFORM_PORT ?? 9521);
const PLATFORM_CONTROL_PORT = Number(process.env.E2E_PLATFORM_CONTROL_PORT ?? 9522);
// The entity the sink answers for. The spec configures the VeloLedger connection
// with this value, so `testConnection`'s "is this entity one this key can see"
// check passes against the sink's `list_entities`.
const LEDGER_ENTITY_ID =
  process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

const APP_ENV = {
  // `E2E_PORT` chose the port Playwright PROBES but never the one the server
  // LISTENS on, so it only looked configurable — `node .next/standalone/server.js`
  // reads `PORT` and defaulted to 3000 either way. Latent until part 3 needed a
  // second server on a second port for the pseudo crawl, at which point the
  // webServer just timed out.
  PORT: String(PORT),
  AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-test-only-not-a-real-secret',
  AUTH_URL: BASE_URL,
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  STORAGE_DRIVER: 's3',
  STORAGE_BUCKET: process.env.STORAGE_BUCKET ?? 'veloexpense-receipts',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ENDPOINT: `http://127.0.0.1:${STORAGE_PORT}`,
  STORAGE_FORCE_PATH_STYLE: 'true',
  // s3rver accepts any credentials; these just have to be present and stable
  // so the presigned signature verifies.
  STORAGE_ACCESS_KEY_ID: 'S3RVER',
  STORAGE_SECRET_ACCESS_KEY: 'S3RVER',

  // VX2-8's three settings, all of which have an off state that would make the
  // e2e pass while proving less:
  //   APP_URL        unset -> mail goes out with NO links at all (NT-14)
  //   SMTP_HOST      unset -> the console transport, so nothing is sent
  //   WORKER_SECRET  unset -> the drain route refuses everything, fail-closed
  APP_URL: BASE_URL,

  // VX5-20. BOTH are required or the seat push reports `disabled` and every
  // assertion about it passes by the feature being off — the same trap as an
  // unset SMTP_HOST making the mail tests prove nothing.
  PLATFORM_API_URL: `http://127.0.0.1:${PLATFORM_PORT}`,
  PLATFORM_SERVICE_TOKEN: 'e2e-platform-token-not-a-real-secret',

  // VX5-20 part 2. The INBOUND token, and a different string from the outbound
  // one above: one secret for both directions means a leak in either grants
  // both. Unset, `POST /api/platform/provision` answers 503 to everything and
  // every assertion in `e2e/platform-provision.spec.ts` would pass by the route
  // being off.
  PLATFORM_INBOUND_TOKEN: 'e2e-inbound-token-not-a-real-secret',

  // 18 Oct 2026: /signup is CLOSED unless this is set (lib/onboarding/signupGate.ts) —
  // production runs closed. The e2e drives the open flow (e2e/signup-flow.spec.ts), as dev.
  SIGNUP_ENABLED: 'true',

  // w6-03: the assistant reads its key from the environment (d40, d90). Passed through only
  // when the shell has one, so the real-model specs (assistant-actions, assistant-new-journeys)
  // can run; without it the server answers "not configured" and those specs skip, while
  // assistant-panel.spec.ts drives the not-configured panel.
  ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),

  // w6-04: a personal API key is rate-limited, and the guard counts that in Redis
  // (server/lib/rateLimit.ts, as ExpenseOS's). Passed through only when the shell has one,
  // as the key above: CI's job has no Redis service, so e2e/api-keys-mcp.spec.ts runs a
  // personal key's CALLS only where it is set; every other step runs either way.
  ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),

  // VX5-5. The apex tenant subdomains live under, which `lib/tenant/host.ts`
  // reads from this one variable — the same one that makes a session usable
  // across subdomains at all (`auth.ts` has the measurement).
  //
  // `velo.test` and not `localhost`, because browsers will not scope a cookie to
  // `localhost` and a probe confirmed it: `demo.localhost:3000` bounced to
  // `/login` while the apex rendered. `e2e/host-tenancy.spec.ts` resolves
  // `*.velo.test` inside its own browser.
  //
  // The other 150 specs are UNAFFECTED and that is checked rather than assumed:
  // they talk to `localhost:3000`, which is not under this apex, so
  // `candidateSlugFromHost` returns null for every one of their requests and the
  // mismatch guard never engages.
  AUTH_COOKIE_DOMAIN: 'velo.test',

  // VX4-7 part 3. Off here and ON in `playwright.pseudo.config.ts`, which is
  // the whole reason that second config exists: `lib/i18n/pseudo.ts` reads this
  // ONCE at boot, deliberately, so one server cannot serve both the normal
  // specs and the pseudo-locale crawl. Passed explicitly rather than inherited
  // from the shell so that a developer with it exported does not silently turn
  // the normal suite into a pseudo run.
  PSEUDO_LOCALE: process.env.E2E_PSEUDO === '1' ? '1' : '0',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(SMTP_PORT),
  SMTP_FROM: 'veloexpense@e2e.test',
  WORKER_SECRET,

  // VX3-9a. Two settings, both with an off state that would make the run pass
  // while proving less:
  //   INTEGRATIONS_ENABLE_STUB   unset -> `stub-ledger` is not registered, so the
  //                              second tenant has no ledger to connect and the
  //                              two-tenant assertion is vacuous.
  //   INTEGRATIONS_STUB_LEDGER_URL unset -> the stub records in module state,
  //                              which a browser test cannot read.
  INTEGRATIONS_ENABLE_STUB: '1',
  INTEGRATIONS_STUB_LEDGER_URL: `http://127.0.0.1:${LEDGER_PORT}`,
  //   INTEGRATIONS_STUB_AUTHORIZE_URL unset -> `stub-oauth` sends the browser to
  //     `https://stub.invalid`, which no browser can reach. VX3-9b points it at the
  //     sink's consent screen so the redirect can actually be walked.
  INTEGRATIONS_STUB_AUTHORIZE_URL: `http://127.0.0.1:${LEDGER_PORT}/oauth/authorize`,
  // The app encrypts integration credentials on write, so a connect form without
  // this key fails with a message about the key rather than about the ledger.
  SECRET_ENCRYPTION_KEY:
    process.env.SECRET_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

/*
 * VeloExpense: ExpenseOS's phone projects (1e682dd6 `playwright.config.ts`), ported with its
 * phone specs. The lists, the three projects and their reasons are ExpenseOS's; what changed
 * is marked "VeloExpense:" — the stored session (`e2e/.auth/state.json`, the admin, as
 * `chromium` uses) and `chromium`'s `testIgnore`, which also keeps this config's pseudo crawl
 * out (a project's `testIgnore` replaces the root one).
 */
/**
 * ─── THE PHONE SPEC LISTS ────────────────────────────────────────────────────────────────
 *
 * Four projects share one `e2e/` directory, so every spec file lands in one of three
 * buckets — and two of those buckets are expressed as regexes that MUST agree:
 *
 *   · phone-only    — collected by every phone project, and ignored by `chromium`.
 *   · all projects  — collected by every project, desktop included.
 *   · chromium-only — collected by `chromium`, named by neither pattern list below. Needs no
 *                     entry below: `chromium`'s `.*\.spec\.ts$` is the default bucket, and
 *                     the phone projects only ever collect what these lists name.
 *                     `e2e/tap-targets-desktop.spec.ts` is deliberately in this bucket —
 *                     it is the counterpart assertion, that the desktop layout does NOT get
 *                     the coarse-pointer tap targets, so putting it in a phone project
 *                     would invert its meaning.
 *
 * WHY THESE ARE DERIVED AND NOT TWO HAND-KEPT REGEXES. The dangerous edit is a half-edit:
 * widening the phone `testMatch` to pick up a new phone spec WITHOUT widening `chromium`'s
 * `testIgnore` to drop it. The symptom is not a missing test — it is `chromium` running a
 * phone spec at 1280×720, and in particular running `e2e/support/safe-area.ts`'s forced
 * insets in the project where `e2e/topbar-overlap.spec.ts` asserts
 * `headerPaddingLeft === 32`. That spec goes red for a reason that has nothing to do with
 * the top bar, several files from the edit that caused it. So both regexes are built from
 * one array of patterns each, and the phone-only array is a literal prefix of the
 * phone-project array — the subset invariant holds BY CONSTRUCTION, not by review.
 */

/**
 * Phone-only: the phone projects collect these, `chromium` must not.
 *
 * Patterns are end-anchored fragments matched against the absolute spec path, exactly as
 * the hand-written `/crawl-mobile\.spec\.ts$/` they replace was.
 */
const PHONE_ONLY_SPEC_PATTERNS = [
  // T02's inherited overflow crawl. It measures a phone layout viewport; running it at
  // 1280×720 would either pass vacuously or fail for reasons that say nothing about a
  // phone. See the `mobile-360` block below.
  String.raw`crawl-mobile\.spec\.ts`,
  // The `*.mobile.spec.ts` family — a naming CONVENTION rather than a file list, so a new
  // phone spec joins both phone projects and leaves `chromium` by adding a file, with no
  // edit here at all. That is the half-edit closed off at the source. Note the literal
  // `\.mobile\.` does not match `crawl-mobile.spec.ts` (hyphen, not dot), so the two
  // patterns are disjoint and the alternation cannot double-count.
  String.raw`.*\.mobile\.spec\.ts`,
] as const;

/**
 * Collected by the phone projects AND by `chromium` — one behaviour asserted at a phone
 * viewport and at a desktop one.
 *
 * It holds exactly one entry, `desktop-notice.spec.ts`, and that is the entire reason the
 * two arrays are separate: the desktop-only notice has a claim to make in every project
 * (rendered on the phone, suppressed on the desktop), so a pattern HERE widens the phone
 * `testMatch` while deliberately leaving `chromium`'s `testIgnore` alone. A pattern in the
 * array above would do both, and `chromium` would stop collecting the desktop half.
 */
const PHONE_SHARED_SPEC_PATTERNS: readonly string[] = [
  // The desktop-only notice (ADR-0005). In the phone projects it asserts the notice IS shown and
  // the page is not; in `chromium` at 1280 it asserts the exact inverse. Both halves are the
  // same claim, and a one-sided version of it passes on a build where the suppression is
  // unconditional. Hence here and not in `PHONE_ONLY_SPEC_PATTERNS`.
  // VeloExpense: kept although `desktop-notice.spec.ts` is not ported yet — the pattern
  // matches nothing until it is, and the list stays ExpenseOS's so the spec joins both
  // buckets by being added.
  String.raw`desktop-notice\.spec\.ts`,
];

/** Everything the phone projects collect. A superset of the phone-only list by shape. */
const PHONE_PROJECT_SPEC_PATTERNS: readonly string[] = [
  ...PHONE_ONLY_SPEC_PATTERNS,
  ...PHONE_SHARED_SPEC_PATTERNS,
];

/**
 * Join basename fragments into one end-anchored alternation.
 *
 * Throws on an empty list rather than returning `/(?:)$/`, which matches EVERY path: as a
 * `testMatch` that sweeps the whole desktop suite into a 360px project, and as a
 * `testIgnore` it collects nothing at all. Both are silent, and a config that refuses to
 * load is strictly better than either.
 */
function phoneSpecPattern(patterns: readonly string[]): RegExp {
  if (patterns.length === 0) {
    throw new Error('phoneSpecPattern: an empty pattern list would match every path');
  }
  return new RegExp(`(?:${patterns.join('|')})$`);
}

/** `chromium`'s `testIgnore`. */
const PHONE_ONLY_SPECS = phoneSpecPattern(PHONE_ONLY_SPEC_PATTERNS);

/**
 * VeloExpense: ExpenseOS's role-matrix specs, which walk every page as every seeded role
 * (`crawl-roles`, `interact-roles`) and probe what each role reaches (`permissions`). About
 * fourteen minutes together, so they run as their own project — and in CI as their own job,
 * beside `quality` and `phones` — rather than inside `chromium`, whose job would not fit its
 * ceiling with them. ExpenseOS runs every browser project nightly; VeloExpense runs these on
 * every PR, as it does the phone projects.
 */
const ROLE_MATRIX_SPECS = /(^|\/)(crawl-roles|interact-roles|permissions)\.spec\.ts$/;
/**
 * EVERY phone project's `testMatch` — a superset of `PHONE_ONLY_SPECS` by construction.
 *
 * Shared, not copied: `mobile-360`, `mobile-390` and `mobile-412` all name THIS constant.
 * A fourth phone project written with its own regex would break the subset invariant above
 * silently, so `scripts/check-phone-projects.mjs` asserts by text that every phone project's
 * `testMatch` is one shared identifier and never a regex literal.
 */
const PHONE_PROJECT_SPECS = phoneSpecPattern(PHONE_PROJECT_SPEC_PATTERNS);

export default defineConfig({
  testDir: './e2e',
  /**
   * Empties `e2e/.artifacts/mobile/` and stamps a fresh run id, once, before any project
   * starts — so ONE invocation's PNGs, sidecars and census describe THAT invocation and
   * nothing else. (ExpenseOS's, ported with the mobile crawl; see `e2e/support/mobile-census.ts`.)
   */
  globalSetup: './e2e/support/mobile-reset.ts',
  /**
   * Collates the mobile crawl's per-route JSON sidecars and prints its census. A no-op when
   * this run wrote no mobile sidecars. (ExpenseOS's, as above.)
   */
  globalTeardown: './e2e/support/mobile-census.ts',
  // The pseudo crawl needs a server booted with PSEUDO_LOCALE=1, so it has its
  // own config and is excluded here. Without this line it would run against a
  // normal server and pass by finding nothing bracketed anywhere — a spec that
  // reports success because it was pointed at the wrong build, which is the
  // failure mode part 2b's sabotage discipline exists for.
  testIgnore: /pseudo-crawl\.spec\.ts/,
  // The DB suites and the e2e share one database; never interleave them.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      // ... minus the phone-only specs, which the default `testMatch` would otherwise sweep
      // in. Derived from `PHONE_ONLY_SPEC_PATTERNS`, so this can never fall out of step with
      // what the phone projects collect — see the spec-list note above the config.
      // VeloExpense: and the pseudo crawl, as the root `testIgnore` says — a project's
      // `testIgnore` REPLACES the root one rather than adding to it.
      // VeloExpense: and the role-matrix specs, which are the `roles` project's.
      testIgnore: [PHONE_ONLY_SPECS, /pseudo-crawl\.spec\.ts/, ROLE_MATRIX_SPECS],
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
    // VeloExpense: the role-matrix specs, at `chromium`'s desktop settings. See
    // `ROLE_MATRIX_SPECS`.
    {
      name: 'roles',
      testMatch: ROLE_MATRIX_SPECS,
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
    /**
     * mobile-360 — the narrow end of the phone field, spelled out rather than borrowed.
     *
     * Deliberately NOT a `devices[...]` spread, and deliberately not named for a handset:
     * Android is unverified here, so a project called `Pixel 7` would be a coverage claim
     * nothing in this repo backs. Every key below is load-bearing, and a descriptor would
     * hide which:
     *
     *   · `viewport: { width: 360, height: 800 }` — 360 is the narrowest width we care
     *     about, so it is where a fixed-width table or an unwrapped toolbar shows first.
     *   · `isMobile: true` — this is the line that makes the overflow gate mean anything.
     *     Without it Chromium applies NO meta-viewport emulation, so
     *     `document.documentElement.clientWidth` is always exactly 360 whatever the page's
     *     own `<meta name="viewport">` does or fails to do. The measurement could never
     *     disagree with the viewport, and the gate would report green on a page that
     *     overflows in a real browser. With it, the layout viewport is derived from the
     *     page's meta tag, so a missing or broken tag surfaces as a clientWidth ≠ 360.
     *   · `hasTouch: true` — hover-gated affordances behave as they do under a finger
     *     rather than under a mouse, which is the difference between a control being
     *     reachable on a phone and only looking reachable.
     *
     * `deviceScaleFactor` is deliberately left unset, so it defaults to 1: this project's
     * job is layout, and DSF 1 keeps its PNGs a ninth the size of mobile-390's. See the
     * screenshot note in that block — `scale: 'css'` is mandatory there, and a no-op here
     * precisely because DSF is 1.
     */
    {
      name: 'mobile-360',
      // The phone specs and nothing else. If this project swept `*.spec.ts` it would
      // re-run the entire desktop suite at 360px — hundreds of tests written for a
      // desktop viewport, failing for reasons that are not the thing being gated.
      testMatch: PHONE_PROJECT_SPECS,
      /**
       * Zero retries, overriding the root `retries: process.env.CI ? 2 : 1`.
       *
       * Not a preference. Playwright classifies a test that fails and then passes on retry
       * as FLAKY, and a run whose only problems are flaky exits 0. An overflow that depends
       * on the data in one row — a long vendor name, a wide currency amount — is exactly
       * the intermittent case, so with retries enabled the interesting failure is reported
       * as flaky and CI goes green. For an overflow gate that is precisely backwards.
       */
      retries: 0,
      use: {
        // Stated rather than inherited from the default. `isMobile` below is NOT supported
        // on firefox, and the other engine that does support it — webkit — is the one
        // DevOps ruled out of this pipeline (see mobile-390). Naming the engine at the
        // lines that depend on it is the point: a root-level `use.browserName` added later
        // would otherwise move this project onto an engine where `isMobile` silently stops
        // applying, and the gate would go quiet rather than fail. (`--browser` cannot do
        // that — Playwright refuses the flag outright once a config declares projects.)
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
        // Same stored session as `chromium`. Without it every route 302s to /login and the
        // crawl measures the login page 52 times over, green and worthless.
        // VeloExpense: the admin's session, as `chromium` uses (ExpenseOS: `user.json`).
        storageState: 'e2e/.auth/state.json',
      },
      dependencies: ['setup'],
    },
    /**
     * mobile-390 — iPhone 14 metrics, running on Blink.
     *
     * This one DOES spread the descriptor, because what is wanted is the metric set
     * Playwright ships and keeps current rather than nine numbers copied out of it:
     * `viewport: { width: 390, height: 664 }`, `screen: { width: 390, height: 844 }`,
     * `deviceScaleFactor: 3`, `isMobile: true`, `hasTouch: true`. Note 844 is the SCREEN
     * height and 664 the viewport — 664 is what is left once Safari's chrome is accounted
     * for, and it is the number a layout actually gets.
     *
     * `browserName: 'chromium'` overrides the descriptor's own
     * `defaultBrowserType: 'webkit'`, and it is the single most important line in this
     * block. Per DevOps: webkit is not installable on the nightly runner as configured —
     * `playwright install --with-deps` only implements host-dependency installation for
     * Debian/Ubuntu, and on Amazon Linux it does not resolve. Deleting this line costs
     * nothing locally on macOS, where webkit is already installed, and breaks the nightly.
     * Do not put webkit in this pipeline.
     *
     * SCREENSHOTS: every `page.screenshot()` taken under this project MUST pass
     * `scale: 'css'`. At DSF 3 the device-pixel default is 9× the pixels and roughly 9×
     * the bytes of the CSS-pixel image, per screenshot, and this is the only high-DPR
     * project left in the config — so nothing else here would absorb the mistake. `scale`
     * is NOT a `use.screenshot` key (that option takes only a mode plus `fullPage` /
     * `omitBackground`); it is an argument to the explicit `page.screenshot({ path, scale })`
     * call, which is where the mobile crawl takes its captures and is also why the captures
     * are explicit rather than `screenshot: 'on'` — the automatic mode would route the
     * whole corpus into the uploaded `test-results/`.
     *
     * OPEN QUESTION, recorded so the next reader knows it is live and not an oversight:
     * spreading the descriptor also inherits its iOS Safari `userAgent`, which is untrue of
     * the Blink engine actually running. Whether to override it was deliberately left
     * unruled, to be settled alongside the platform-branching install section. It is
     * inherited as-is until then.
     */
    {
      name: 'mobile-390',
      // As mobile-360, from the same derived list: every phone project collects the SAME
      // files and they differ only in the viewport they emulate — that is the whole point of
      // there being more than one, and it is why this is the identical constant rather than a
      // second regex.
      testMatch: PHONE_PROJECT_SPECS,
      // Zero for the same reason as mobile-360 — see the retries note there. A flaky
      // classification exits 0, which turns an overflow gate off exactly when it fires.
      retries: 0,
      use: {
        ...devices['iPhone 14'],
        // Overrides the descriptor's `defaultBrowserType: 'webkit'`. See the block comment:
        // webkit does not install on the nightly runner. This line is not cosmetic.
        browserName: 'chromium',
        // VeloExpense: the admin's session, as `chromium` uses (ExpenseOS: `user.json`).
        storageState: 'e2e/.auth/state.json',
      },
      dependencies: ['setup'],
    },
    /**
     * mobile-412 — the wide end of the phone field, added by P02 (`pwa-pages-everyday`).
     *
     * 412 IS A LAYOUT WIDTH, NOT A HANDSET, and the name says so deliberately. It is the
     * widest width still inside the phone field — below Tailwind's `sm` (640) and a long way
     * below `lg` (1024), so the `DesktopOnlyNotice` gate and the coarse-pointer tap targets
     * behave here exactly as they do at 360. What it adds over 360 and 390 is the opposite
     * failure: a layout that only looks right when it is CRAMPED — a flex row that wraps at
     * 390 and stops wrapping at 412, a card grid that goes to two columns a breakpoint early,
     * a fixed-width element that stops being the widest thing on the page and lets something
     * else overflow instead. None of that is visible at the narrow end.
     *
     * WHAT THIS PROJECT DOES NOT CLAIM: any Android coverage. Ruling 9 in
     * `docs/design/pwa.md` keeps `android: unverified` because nobody has run this suite on
     * an Android device, and that is unchanged by adding a width. The earlier ruling that
     * dropped a `Pixel 7` project was right about the reason — naming a project for a handset
     * is a coverage claim — and this project is named for the width precisely so the reason
     * still holds. Do not rename it after a device, and do not read a green run here as
     * anything about Chrome on Android.
     *
     * Spelled out rather than spread from a `devices[...]` descriptor, for the same reason as
     * `mobile-360`: every key below is load-bearing and a descriptor would hide which. See
     * that block for what `isMobile` and `hasTouch` are each doing — the arguments are
     * identical here and are not repeated.
     *
     * `deviceScaleFactor` is deliberately left unset, so it defaults to 1. This project's job
     * is layout, and at DSF 1 each of its PNGs is roughly a ninth the pixels — and so a small
     * fraction of the bytes — of the same capture under `mobile-390`. A third phone project
     * therefore adds one more full set of route screenshots while adding close to nothing to
     * what a run uploads, which is the trade this ruling turns on. `scale: 'css'` is a no-op
     * here precisely because DSF is 1; it remains mandatory under `mobile-390`.
     *
     * The height, 900, is a round number in the tall-phone band and NOT a device's screen —
     * only the width is load-bearing. It is deliberately taller than `mobile-360`'s 800 so
     * that the two are not accidentally the same viewport aspect; nothing asserts on it.
     */
    {
      name: 'mobile-412',
      // The identical constant `mobile-360` and `mobile-390` use, never a third regex. The
      // subset invariant documented above holds BY CONSTRUCTION only while that is true —
      // a hand-written regex here is the documented half-edit, and its symptom lands in
      // `e2e/topbar-overlap.spec.ts`, three files away. Guarded by text in
      // `scripts/check-phone-projects.mjs`.
      testMatch: PHONE_PROJECT_SPECS,
      // Zero for the same reason as the other two phone projects — see the retries note in
      // `mobile-360`. Playwright reports a fail-then-pass as FLAKY and a flaky-only run
      // exits 0, which turns an overflow gate off exactly when it fires.
      retries: 0,
      use: {
        // Stated, not inherited — `isMobile` is unsupported on firefox, and webkit is out of
        // this pipeline (see `mobile-390`). Naming the engine at the lines that depend on it
        // is the point.
        browserName: 'chromium',
        viewport: { width: 412, height: 900 },
        isMobile: true,
        hasTouch: true,
        // Same stored session as every other project. Without it every route 302s to /login
        // and the crawl measures the login page 52 times over, green and worthless.
        // VeloExpense: the admin's session, as `chromium` uses (ExpenseOS: `user.json`).
        storageState: 'e2e/.auth/state.json',
      },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      command: 'node scripts/e2e-storage.mjs',
      port: STORAGE_PORT,
      // NEVER REUSED. `reuseExistingServer` reuses whatever is answering the PORT,
      // and a port probe cannot tell s3rver from anything else — so a stranger on
      // the port is silently adopted as the storage backend, and the failure
      // surfaces three specs later as an upload that never appears. With this
      // false, Playwright always starts its own; if the port is busy, s3rver
      // cannot bind and says so in one line (see the EADDRINUSE handler in
      // scripts/e2e-storage.mjs).
      //
      // The trade, stated: someone running their own s3rver on this port has to
      // stop it or set E2E_STORAGE_PORT. That is a worse first minute and a much
      // better tenth.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/e2e-mail.mjs',
      // The HTTP control port, not the SMTP one — see the note above.
      port: MAIL_HTTP_PORT,
      // Also never reused, for the same reason and to keep the two consistent: the
      // probe identifies a PORT, not a program. (What WOULD have been safe about
      // reusing this one is narrower than it looks — a captured message does not
      // depend on which build sent it, and `approval-flow.spec.ts` clears the
      // inbox in its `beforeAll` — but none of that helps if the thing on the port
      // is not this sink at all.)
      reuseExistingServer: false,
      env: {
        E2E_SMTP_PORT: String(SMTP_PORT),
        E2E_MAIL_HTTP_PORT: String(MAIL_HTTP_PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/e2e-ledger.mjs',
      // The CONTROL port, not the ledger one — Playwright's probe needs a port the
      // app does not depend on, exactly as with the mail sink's HTTP port.
      port: LEDGER_CONTROL_PORT,
      // Never reused, for the third time and the same reason: the probe identifies
      // a PORT, not a program, and a stranger answering here would be silently
      // adopted as the ledger — so bills would go somewhere unknown and the spec
      // would fail on an empty inbox while blaming the posting code.
      reuseExistingServer: false,
      env: {
        E2E_LEDGER_PORT: String(LEDGER_PORT),
        E2E_LEDGER_CONTROL_PORT: String(LEDGER_CONTROL_PORT),
        E2E_LEDGER_ENTITY_ID: LEDGER_ENTITY_ID,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/e2e-platform.mjs',
      // The CONTROL port, not the platform one — Playwright's probe needs a port
      // the app does not depend on, exactly as with the mail sink's HTTP port and
      // the ledger's.
      port: PLATFORM_CONTROL_PORT,
      // Never reused, for the fourth time and the same reason: the probe
      // identifies a PORT, not a program, so a stranger answering here would be
      // silently adopted as the platform — and a seat push would go somewhere
      // unknown while the assertion failed on an empty report list.
      reuseExistingServer: false,
      env: {
        E2E_PLATFORM_PORT: String(PLATFORM_PORT),
        E2E_PLATFORM_CONTROL_PORT: String(PLATFORM_CONTROL_PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:standalone',
      port: PORT,
      // Not reused, and the honest reason is narrower than the one that was
      // written here first.
      //
      // What was claimed: "Next mints a fresh id for every server action on every
      // build, so a reused server serves the old registry." MEASURED, AND FALSE.
      // Action ids are derived from the module path and export name, not from the
      // build — `decideFromTokenForm` is `401c4214…` in every local build, and a
      // different but equally stable id in CI (a different checkout path). A
      // reused server therefore answers unchanged actions perfectly well.
      //
      // It also was NOT the cause of the `/approve` failure this setting was added
      // for. That was `export { inspectToken };` in `app/approve/actions.ts`,
      // which made the build register no actions for the page at all;
      // `scripts/check-server-actions.mjs` now fails on it. The id in the local
      // error and the id in the manifest after the fix are the same string, which
      // is how that was finally pinned down.
      //
      // What is left, and is reason enough: ids are stable but the SET is not. Add,
      // rename or move an action and a server from an earlier build has never heard
      // of the new id — routine during development, and the symptom is a spec
      // failing on the assertion AFTER the click, pointing nowhere near the cause.
      // The e2e rebuilds every time, so the server must come from that build.
      //
      // The trade: you cannot point the e2e at `npm run dev` on this port. That was
      // never supported anyway — the note at the top of this file explains that the
      // e2e deliberately serves the STANDALONE build, which `next dev` is not.
      reuseExistingServer: false,
      env: APP_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

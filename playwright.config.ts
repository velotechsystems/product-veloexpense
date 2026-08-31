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
// The entity the sink answers for. The spec configures the VeloLedger connection
// with this value, so `testConnection`'s "is this entity one this key can see"
// check passes against the sink's `list_entities`.
const LEDGER_ENTITY_ID =
  process.env.E2E_LEDGER_ENTITY_ID ?? '00000000-0000-4000-8000-0000000000e1';
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'e2e-worker-secret';

const APP_ENV = {
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
  // The app encrypts integration credentials on write, so a connect form without
  // this key fails with a message about the key rather than about the ledger.
  SECRET_ENCRYPTION_KEY:
    process.env.SECRET_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

export default defineConfig({
  testDir: './e2e',
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
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
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

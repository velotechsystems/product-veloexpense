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
const STORAGE_PORT = Number(process.env.E2E_STORAGE_PORT ?? 9000);
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 2525);
// Playwright waits on a PORT for readiness and cannot probe SMTP, so the sink
// also serves its captured inbox over HTTP — which is how the spec reads it.
const MAIL_HTTP_PORT = Number(process.env.E2E_MAIL_HTTP_PORT ?? 2526);
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
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/e2e-mail.mjs',
      // The HTTP control port, not the SMTP one — see the note above.
      port: MAIL_HTTP_PORT,
      env: {
        E2E_SMTP_PORT: String(SMTP_PORT),
        E2E_MAIL_HTTP_PORT: String(MAIL_HTTP_PORT),
      },
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:standalone',
      port: PORT,
      reuseExistingServer: !process.env.CI,
      env: APP_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

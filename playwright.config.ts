/**
 * VX1-9 — Playwright config for the Phase-1 happy path.
 *
 * Two web servers, both started by Playwright so `npm run e2e` is the whole
 * command on a laptop and in CI:
 *   - scripts/e2e-storage.mjs — an S3 surface for the presigned receipt upload
 *   - the built Next app, pointed at that storage and at the test database
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
      command: 'npm run start:standalone',
      port: PORT,
      reuseExistingServer: !process.env.CI,
      env: APP_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

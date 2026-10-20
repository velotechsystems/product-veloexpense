/**
 * f63 — the assistant's streaming e2e, its own config and its own server.
 *
 * ── WHY A SECOND CONFIG ─────────────────────────────────────────────────────
 *
 * The normal suite's server has no Anthropic key (unless the shell has a real one), and
 * `e2e/assistant-panel.spec.ts` drives exactly that: the not-configured panel and the 503. This
 * spec needs the opposite — a server WITH a key — and Playwright projects share a `webServer`,
 * so it cannot share that server. The same reasoning as `playwright.pseudo.config.ts`.
 *
 * The server here gets a placeholder key and `ASSISTANT_FAKE_ANTHROPIC_URL`, pointing at
 * `scripts/e2e-anthropic.mjs` on loopback, so a turn runs end to end — route, session, turn
 * loop, metering — against a model that answers slowly and in pieces. The app honours that
 * variable only for a loopback http address (server/lib/assistantClient.ts).
 *
 * Ports come from `npm run e2e:assistant`, which exports shifted `E2E_*` values before this
 * config is imported, so a server left running by another suite cannot be adopted.
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import base from './playwright.config';

const ANTHROPIC_PORT = Number(process.env.E2E_ANTHROPIC_PORT ?? 9631);

const servers = base.webServer;
if (!Array.isArray(servers)) {
  throw new Error('playwright.assistant.config.ts expects playwright.config.ts to export an array of webServers');
}

const config: PlaywrightTestConfig = {
  ...base,
  testMatch: /assistant-stream\.spec\.ts/,
  testIgnore: undefined,
  // `setup` mints the sessions; `chromium` runs the spec. Its own `testIgnore` names this spec
  // (a project's `testIgnore` replaces the root one), so it is lifted here, or nothing matches.
  projects: (base.projects ?? [])
    .filter((p) => p.name === 'setup' || p.name === 'chromium')
    .map((p) => (p.name === 'chromium' ? { ...p, testIgnore: undefined } : p)),
  webServer: [
    {
      command: 'node scripts/e2e-anthropic.mjs',
      port: ANTHROPIC_PORT,
      reuseExistingServer: false,
      env: { E2E_ANTHROPIC_PORT: String(ANTHROPIC_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    ...servers.map((server) =>
      server.command === 'npm run start:standalone'
        ? {
            ...server,
            env: {
              ...(server.env ?? {}),
              // A placeholder, never a real key: it only ever reaches the loopback fake.
              ANTHROPIC_API_KEY: 'e2e-fake-anthropic-key-not-a-real-secret',
              ASSISTANT_FAKE_ANTHROPIC_URL: `http://127.0.0.1:${ANTHROPIC_PORT}`,
            },
          }
        : server,
    ),
  ],
};

export default config;

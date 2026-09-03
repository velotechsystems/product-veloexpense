/**
 * VX4-7 part 3 — the pseudo-locale crawl's own config.
 *
 * ── WHY A SECOND CONFIG AND NOT A SECOND PROJECT ────────────────────────────
 *
 * `lib/i18n/pseudo.ts` reads `PSEUDO_LOCALE` once, at module load, and that file
 * argues at length why: a render toggle a request can reach is the class of
 * thing parts 2b and 2c spent their length removing. The consequence is that one
 * server cannot serve both modes, and Playwright projects share a `webServer`.
 *
 * So: a second config, a second server. The alternative — a cookie or a query
 * parameter the crawl sets — would have been one file instead of two, and would
 * have put a switch on the render path that an outsider can flip. Two files is
 * the cheaper of those costs.
 *
 * The PORTS come from `npm run e2e:crawl`, which exports shifted `E2E_*` values
 * before this config is imported, so a server left running by the normal suite
 * cannot be adopted by this one. `reuseExistingServer: false` already refuses to
 * reuse, but a port collision would fail to bind and read as a broken harness
 * rather than as two runs fighting.
 *
 * The normal suite excludes this spec via `testIgnore` in the base config: aimed
 * at a normal server it would find nothing bracketed and report success, which
 * is a spec passing because it was pointed at the wrong build.
 */
import type { PlaywrightTestConfig } from '@playwright/test';
import base from './playwright.config';

const servers = base.webServer;
if (!Array.isArray(servers)) {
  // Loud rather than silent. If the base config ever goes back to a single
  // server object, this file would otherwise quietly start it WITHOUT the flag
  // and the crawl would pass by finding nothing.
  throw new Error(
    'playwright.pseudo.config.ts expects playwright.config.ts to export an array of webServers',
  );
}

const config: PlaywrightTestConfig = {
  ...base,
  testMatch: /pseudo-crawl\.spec\.ts/,
  // The base config ignores this spec; this config is the one place that runs
  // it, so the ignore has to be lifted here or nothing matches.
  testIgnore: undefined,
  webServer: servers.map((server) => ({
    ...server,
    env: { ...(server.env ?? {}), PSEUDO_LOCALE: '1' },
  })),
};

export default config;

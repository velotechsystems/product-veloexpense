// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading the SerpApi credentials — where "not configured" is a first-class answer.
 *
 * Every SerpApi call spends a credit from a paid plan, so this key is stricter than the
 * Maps one: in client JavaScript it would not just be liftable, it would be directly
 * spendable by whoever lifted it. Hence server-only, and hence decrypted per read rather
 * than held anywhere.
 *
 * Travel prices fall back to per-diem without it, so every "no key" path returns null
 * rather than throwing — an org that never bought a plan still gets budgets.
 *
 * Every case passes an explicit `env`. The parameter defaults to `process.env`, and a
 * SERPAPI_API_KEY in the developer's shell would otherwise turn every "returns null"
 * assertion below into a pass that proves nothing.
 *
 * VeloExpense (w6-01): ExpenseOS's installation cases ('when it is configured', and the
 * installation halves of 'when it is not usable' and the fallback) are not here, because
 * VeloExpense reads no installation yet (see serpapi.ts); the environment cases are
 * ExpenseOS's, with the installation that is "not installed" or "not active" standing for
 * the database VeloExpense does not read.
 */

import { getSerpApiConfig } from './serpapi';

/** VeloExpense (w6-01): the database is not read; any value stands for it. */
const db = {} as never;

/** apps/web's `ProcessEnv` is Next's augmented interface with no index signature, so a
 *  literal shares no members with it and needs the widening cast. */
const asEnv = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

/** No key anywhere in the environment. */
const BARE = asEnv({});
const ENV = asEnv({ SERPAPI_API_KEY: 'env-serp-key' });

afterEach(() => {
  vi.clearAllMocks();
  // One case stubs `process.env` to pin the default argument. Nothing in the root setup
  // unstubs envs, and a leaked key would make a later "not configured" assertion pass or
  // fail depending on file order.
  vi.unstubAllEnvs();
});

describe('when it is not usable', () => {
  it('returns null when the integration is not installed', async () => {
    await expect(getSerpApiConfig(db, BARE)).resolves.toBeNull();
  });
});

/**
 * The environment fallback.
 *
 * Without it, "Get prices" in the travel drawer returned `quotedLines: 0` with
 * `reason: 'no-plan'` in every environment where nobody had installed the integration —
 * a button that does nothing and says nothing, even though the key was sitting in the
 * shell the whole time.
 */
describe('the environment fallback', () => {
  it('uses SERPAPI_API_KEY when the integration is not installed', async () => {
    await expect(getSerpApiConfig(db, ENV)).resolves.toEqual({
      apiKey: 'env-serp-key',
    });
  });

  it('returns null with no installation and no env key', async () => {
    /** Still a legitimate answer, not an error: travel prices from per-diem instead. */
    await expect(getSerpApiConfig(db, BARE)).resolves.toBeNull();
    await expect(getSerpApiConfig(db, asEnv({ SERPAPI_API_KEY: '  \n' }))).resolves.toBeNull();
  });

  it('trims an env key, which arrives with a newline as often as a pasted one', async () => {
    const config = await getSerpApiConfig(db, asEnv({ SERPAPI_API_KEY: ' env-serp-key\n' }));
    expect(config?.apiKey).toBe('env-serp-key');
  });

  it('carries NO currency, country, or language from the environment', async () => {
    /** Those three decide which market a quote is priced for. Inheriting them from the
     *  shell means a flight quoted in the wrong currency with no admin screen showing
     *  why — and an installation that chose a region must not have it overwritten by a
     *  stray variable. */
    const config = await getSerpApiConfig(
      db,
      asEnv({
        SERPAPI_API_KEY: 'env-serp-key',
        // Neighbouring vars that must not be mistaken for the localisation settings.
        SERPAPI_CURRENCY: 'USD',
        SERPAPI_GL: 'us',
        SERPAPI_HL: 'en',
      }),
    );
    expect(config).toEqual({ apiKey: 'env-serp-key' });
  });

  it('reads process.env by default, because that is how every caller calls it', async () => {
    /** Both call sites pass only the db. A default that pointed anywhere else would pass
     *  every case above and still ship the bug. */
    vi.stubEnv('SERPAPI_API_KEY', 'from-process-env');
    await expect(getSerpApiConfig(db)).resolves.toEqual({ apiKey: 'from-process-env' });
  });
});

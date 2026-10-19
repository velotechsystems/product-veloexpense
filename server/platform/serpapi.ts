/**
 * SerpApi access for travel pricing — the installed integration's credentials, else
 * the environment's.
 *
 * Server-side only, and more strictly than the Maps key: every SerpApi call spends
 * a credit from a paid plan, so a key in client JavaScript is not just liftable, it
 * is directly spendable by anyone who lifts it.
 *
 * Null is a first-class answer. Travel prices from per-diem without this, so an org
 * that has not bought a plan still gets budgets — just not predicted ones.
 *
 * VeloExpense (w6-01): ported from ExpenseOS (1e682dd6) with the one difference
 * `getMapsConfig` (./googleMaps.ts) already has: the key comes from the environment only.
 * ExpenseOS reads an installed `serpapi` integration first; VeloExpense's integrations carry
 * ledgers alone until its integrations screen is ported, so there is no installation to
 * read. With no key the answer is null and travel prices from per-diem, as ExpenseOS's does
 * (d88: ported now, the key set later as `veloexpense/<stage>/serpapi-key`).
 */

import type { SerpApiConfig } from '@expenseos/travel-search';

/** VeloExpense (w6-01): kept for ExpenseOS's call sites (`getSerpApiConfig(ctx.db)`); not read. */
type Db = unknown;

/**
 * The active installation's config, else the environment, else null.
 *
 * Precedence is installation-then-env, the same order and for the same reasons as
 * `getMapsConfig`. The installation is the source of truth because rotating the key in
 * the admin UI has to beat whatever a stale task definition exported, or saving there
 * would appear to do nothing. The environment stays a FALLBACK rather than the mechanism
 * because a developer and CI have a SERPAPI_API_KEY and no installation row — and without
 * it "Get prices" answered `quotedLines: 0, reason: 'no-plan'` and left no trace of why,
 * which reads as a broken button rather than as a missing key.
 */
export async function getSerpApiConfig(
  _db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SerpApiConfig | null> {
  // VeloExpense (w6-01): no installation to read yet — see the file header. ExpenseOS's
  // installation branch (key, currency, gl and hl off the active `serpapi` installation,
  // decrypted) arrives with the integrations screen.

  const apiKey = env.SERPAPI_API_KEY?.trim();
  if (!apiKey) return null;
  // No currency/gl/hl alongside it, deliberately. Those three decide which market a
  // quote is priced for, and getting them from the shell means a flight is quoted in
  // the wrong currency with no admin screen showing why. They belong on the
  // installation next to the key; SerpApi's own defaults are the honest answer when
  // nobody has chosen. Omitting them here also keeps the env path from half-configuring
  // an installation that set a region — env is the key of last resort, not a second
  // settings source.
  return { apiKey };
}

import type { Locale } from './locales';

/**
 * Catalog loader — used by next-intl's getRequestConfig in apps/web and
 * by the worker when rendering localized email templates.
 *
 * Catalogs are split per feature area (common, nav, auth, …) and
 * combined into a single namespaced object at load time so call sites
 * can write `t('auth.signInButton')` etc.
 */
export type Catalog = Record<string, Record<string, unknown>>;

const FEATURE_AREAS = [
  'apiKeys',
  // mcp-oauth: the consent screen and connected applications (ported from VeloCRM).
  'oauth',
  'assistant',
  'common',
  'table',
  'nav',
  'auth',
  'dashboard',
  'expenses',
  'people',
  'profile',
  'admin',
  'security',
  'vcc',
  // VeloExpense: ExpenseOS's `netsuite` area, renamed for the vendor guard like the
  // `ledger.*` permissions. Its copy still names the system it describes.
  'ledger',
  'workflows',
  'notifications',
  'delegations',
  'perDiem',
  'policyRules',
  'analytics',
  'travel',
  'budgets',
  'comments',
  // Server refusals the browser translates — see apps/web/src/server/refusal.ts.
  'refusals',
] as const;
export type FeatureArea = (typeof FEATURE_AREAS)[number];

export async function loadCatalog(locale: Locale): Promise<Catalog> {
  const entries = await Promise.all(
    FEATURE_AREAS.map(async (area) => {
      const mod = await import(`./catalogs/${locale}/${area}.json`, {
        with: { type: 'json' },
      });
      return [area, mod.default as Record<string, unknown>] as const;
    }),
  );
  return Object.fromEntries(entries);
}

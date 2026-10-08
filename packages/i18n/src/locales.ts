/**
 * Locale registry — single source of truth for which locales the app
 * supports. Adding a locale here cascades through:
 *   - middleware locale matching
 *   - URL segment routing in apps/web
 *   - CI coverage check (scripts/check-coverage.mjs)
 *   - validation on User.localePref writes
 */

export const SUPPORTED_LOCALES = ['en', 'fr-CA'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * VeloExpense: the locales a reader can actually get, and an admin is asked to author.
 * English only for now (decided 7 Oct): the fr-CA catalogues are ported and checked for
 * coverage, but nobody is served French and no form asks for a French name. Switching
 * French on is adding it here (and in i18n/request.ts).
 */
export const ENABLED_LOCALES: readonly Locale[] = [DEFAULT_LOCALE];

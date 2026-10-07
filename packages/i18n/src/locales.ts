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

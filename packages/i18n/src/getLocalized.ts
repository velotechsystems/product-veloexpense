import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * Translatable DB content is stored as a JSON locale map, e.g.,
 *   label: { "en": "Meals", "fr-CA": "Repas" }
 *
 * Prisma surfaces these columns as `unknown` (Json type), so the helper
 * defensively unwraps and looks up with a fallback chain:
 *   requested locale → fallback locale (default 'en') → null
 *
 * Generic over the value type so the same helper works for plain
 * strings AND structured payloads (e.g., email templates with
 * { subject, body, html } fields).
 */
export type LocaleMap<T = string> = Partial<Record<Locale, T>>;

export function getLocalized<T = string>(
  field: unknown,
  locale: Locale,
  fallback: Locale = DEFAULT_LOCALE,
): T | null {
  if (!field || typeof field !== 'object') return null;
  const map = field as LocaleMap<T>;
  return map[locale] ?? map[fallback] ?? null;
}

/**
 * Stricter variant for code paths that should never see a null —
 * returns a guaranteed value, falling back to the provided default
 * string when the field has no entries.
 */
export function getLocalizedOr<T = string>(
  field: unknown,
  locale: Locale,
  defaultValue: T,
  fallback: Locale = DEFAULT_LOCALE,
): T {
  return getLocalized<T>(field, locale, fallback) ?? defaultValue;
}

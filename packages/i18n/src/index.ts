/**
 * @expenseos/i18n — shared internationalization primitive.
 *
 * Surface:
 *  - Locale registry (SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale, type Locale).
 *  - resolveLocale() for request-time precedence resolution.
 *  - loadCatalog() for next-intl + worker email template rendering.
 *  - getLocalized() / getLocalizedOr() for translatable DB content
 *    stored as JSON locale maps.
 *
 * Catalogs themselves live under src/catalogs/{locale}/{area}.json and
 * are loaded on demand by loadCatalog() — keeps cold-start lean.
 */

export {
  getLocalized,
  getLocalizedOr,
  type LocaleMap,
} from './getLocalized';
export { type Catalog, type FeatureArea, loadCatalog } from './load';
export {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  SUPPORTED_LOCALES,
} from './locales';
export { type ResolveInput, resolveLocale } from './negotiate';

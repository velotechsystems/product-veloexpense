/**
 * VX4-7 — the locale registry. PURE: no `pg`, no `next`, no imports from
 * `lib/db`, for the same reason `lib/policy/rules.ts`, `lib/spend/statuses.ts`
 * and `lib/notifications/catalog.ts` are pure — a server component, a migration
 * script and a CI gate all need this list, and none of them should drag a
 * connection pool along to get it.
 *
 * Ported from ExpenseOS `packages/i18n/src/locales.ts` (pinned 5a11a647), whose
 * header is the reason this file exists at all: "single source of truth for
 * which locales the app supports. Adding a locale here cascades through …".
 * Two divergences, both deliberate, both below.
 *
 * ── WHY `en-CA` AND NOT `en` (GAP-AUDIT IL-1) ───────────────────────────────
 *
 * Theirs is `['en', 'fr-CA']`, and the audit pass ran `Intl` against the bare
 * tag: `en` gives `3/4/2026` and `CA$10,799.00` — identical to `en-US` — where
 * `en-CA` gives `2026-03-04` and `$10,799.00`. So a Canadian product shipping
 * `en` has been formatting American the whole time, and "add en-US" is not an
 * addition to two locales; it is a RETAG of the first one plus an addition.
 *
 * Ours had the disagreement already, in miniature and in two files at once:
 * `lib/money.ts` defaulted to `en-CA` while `lib/notifications/catalog.ts`
 * declared `DEFAULT_LOCALE = 'en'`. Money and copy were tagged differently in a
 * product with one language. This file is now the only place either can read.
 *
 * ── DIVERGENCE 1 · A FALLBACK CHAIN, NOT A SINGLE FALLBACK ──────────────────
 *
 * Their `getLocalized(field, locale, fallback)` does `map[locale] ?? map[fallback]`
 * — exactly one hop, always to the default. That is enough for two locales that
 * share nothing and not enough for three where two share almost everything.
 *
 * `en-CA` and `en-US` need different FORMATTING (date order, currency symbol)
 * and, in an expense product specifically, they also need a handful of different
 * WORDS: cheque/check, GST/HST vs sales tax, postal code vs ZIP. That handful is
 * the whole difference. Three independent catalogues would make every other
 * string exist twice with nothing forcing the two copies to mean the same thing;
 * one language-keyed catalogue would leave "cheque" nowhere to live. So a chain:
 * author once in `en-CA`, and let `en-US` override only where the words really
 * differ.
 *
 * ── DIVERGENCE 2 · THE TABLE IS EXPLICIT, NOT DERIVED ───────────────────────
 *
 * The obvious way to build the chain is by truncating the tag: `en-US` -> `en`
 * -> default. Do not. Truncation is a RULE, and this rule quietly asserts that a
 * shorter tag is always a real fallback — so `fr-CA` would resolve through a
 * `fr` that does not exist and land on `en-CA`, silently serving English to a
 * French reader as though that were a considered decision. It is the same class
 * as ExpenseOS's `normalizeLocale` = "starts with fr" (IL-9), which collapses
 * every `en-*` variant into one bucket by string prefix.
 *
 * A table cannot do that by accident: every fallback edge below was typed by
 * somebody, and `test/i18n-locales.test.ts` asserts every chain starts with its
 * own locale, ends at a locale with no further fallback, and never cycles.
 *
 * ── WHAT IS DELIBERATELY NOT PORTED ─────────────────────────────────────────
 *
 * A URL LOCALE SEGMENT. Theirs resolves locale from `requestLocale` alone
 * (`apps/web/src/i18n/request.ts:11-17`), which is IL-2's finding: their own
 * `resolveLocale`, which documents URL > user preference > cookie >
 * Accept-Language, has NO NON-TEST CALLERS. The URL segment did not merely come
 * first — being first, it made every other rung unreachable, and a precedence
 * chain nothing exercises is a chain nobody can be sure works. Our routes are
 * flat (`/expenses`, not `/[locale]/expenses`), so adding a segment means
 * touching every page and every link to gain shareable localised URLs that
 * nobody has asked for, and to inherit the one defect that killed their
 * precedence. `resolve.ts` starts at the user preference instead, and every rung
 * it has is a rung with a caller.
 *
 * `@formatjs/intl-localematcher` AND `negotiator`. Two dependencies for one
 * header parse; `resolve.ts` does BCP-47 Lookup in about twenty lines.
 */

/**
 * Every locale the product serves. Adding one here cascades through the
 * fallback table below (the test will tell you), `scripts/check-i18n.mjs`,
 * the CHECK constraints in `0027`, and the admin and self-service pickers —
 * all of which read THIS array rather than restating it.
 *
 * That last part is not decoration. ExpenseOS's own coverage gate opens with
 * `const SUPPORTED_LOCALES = ['en', 'fr-CA']` — a second copy, in the gate, of
 * the list the gate exists to police. A gate that hardcodes the locale list is
 * a gate that stops watching the locale you just added, and it fails OPEN:
 * everything passes, because the new locale is not in the loop.
 */
export const SUPPORTED_LOCALES = ['en-CA', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * The locale everything falls back to and the tag stored copy is authored in.
 *
 * `en-CA` rather than `en`: see the header. This is also the value `0027` writes
 * into `organization.default_locale` for every existing tenant and the key the
 * same migration retags stored notification templates to.
 */
export const DEFAULT_LOCALE: Locale = 'en-CA';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Where each locale looks when it has no copy of its own, in order, starting
 * with itself.
 *
 * Read these as sentences somebody meant:
 *
 *   `en-CA` answers only for itself. It is where copy is authored, so a string
 *   missing here is missing everywhere, and there is nowhere further to look —
 *   which is precisely what the coverage gate is for.
 *
 *   `en-US` inherits `en-CA`. Same language; the override list is the handful of
 *   words that genuinely differ. An `en-US` catalogue with one entry in it is
 *   the intended steady state, not an unfinished one.
 *
 * `fr-CA` USED TO BE HERE, answering only for itself with no English fallback,
 * and that rule was the load-bearing one: a French reader hitting an unauthored
 * string must see the missing-copy marker rather than a fluent English sentence,
 * because English there looks deliberate, reads as "this part of the product is
 * English", and is invisible to everyone reviewing in English.
 *
 * VX4-7 part 2a took the rule seriously enough to act on it. Cataloguing the
 * rendered enums showed that `fr-CA` had NO copy anywhere and no route to any —
 * the UI's text is English literals in JSX — so French readers were getting
 * French date and money formatting wrapped around English words, which looked
 * like partial support and was none. Reading those enums from a catalogue would
 * have turned every one of those English words into a marker.
 *
 * So the rule stands and the LIST changed instead: this array now means "locales
 * whose copy is complete", `0028` shrinks the database CHECK to match, and
 * `test/i18n-enum-catalog.test.ts` refuses a locale in this array that is
 * missing copy for any rendered enum member. Restoring `fr-CA` is one line here
 * plus one in `FALLBACK_CHAIN` and `LOCALE_NAMES` — and the suite then goes red
 * until all 86 strings are authored, which is the forcing function that was
 * missing when it shipped empty.
 *
 * If a future caller ever does need English rather than nothing — IL-9's shape,
 * an email a locked-out user must be able to read at all costs — it passes
 * `DEFAULT_LOCALE` explicitly at that one call site, where the trade is visible
 * to whoever reads that code. It does not get it by editing this table, which
 * would grant it silently to every screen in the product.
 */
const FALLBACK_CHAIN: Record<Locale, readonly Locale[]> = {
  'en-CA': ['en-CA'],
  'en-US': ['en-US', 'en-CA'],
};

/**
 * What each locale is CALLED, in its own language, for a picker.
 *
 * `Record<Locale, string>` and not `Partial`, so a locale added to
 * `SUPPORTED_LOCALES` without a name here is a COMPILE error. The pickers on
 * `/admin/locale` and `/preferences` both read this; the first draft of those
 * screens each had their own copy of the map, and `scripts/check-i18n.mjs`
 * flagged it as two locale lists outside the registry — which is IL-7's finding
 * happening to me on the same day I wrote the gate for it.
 *
 * ENDONYMS, deliberately: "Français (Canada)", not "French (Canada)". A language
 * picker that names every option in the reader's CURRENT language is unusable by
 * the one person who needs it — somebody looking at a product in a language they
 * cannot read, hunting for their own. Which is also why this is a table rather
 * than `Intl.DisplayNames`: that returns the name translated INTO the active
 * locale, and its output shifts with the runtime's ICU version, which would make
 * a picker assertion flake between Node builds.
 */
const LOCALE_NAMES: Record<Locale, string> = {
  'en-CA': 'English (Canada)',
  'en-US': 'English (United States)',
};

export function localeName(locale: string): string {
  // Falls back to the tag itself rather than throwing: this renders in a
  // `<select>`, and a stored value from a retired locale should show as its tag
  // rather than take the settings screen down.
  return isLocale(locale) ? LOCALE_NAMES[locale] : locale;
}

/**
 * The lookup order for `locale`: itself first, then each fallback in turn.
 *
 * Every consumer of a locale-keyed map walks THIS, so "where does copy come
 * from" has one answer in one place. Returns the default's chain for an unknown
 * tag rather than throwing: this is called on stored values (`app_user.locale`,
 * a jsonb key) and a row that predates a locale being retired should render, not
 * 500.
 */
export function fallbackChain(locale: string): readonly Locale[] {
  return isLocale(locale) ? FALLBACK_CHAIN[locale] : FALLBACK_CHAIN[DEFAULT_LOCALE];
}

/**
 * Read one locale out of a locale-keyed map by walking the chain.
 *
 * Generic over the value type, as ExpenseOS's `getLocalized` is and for its
 * reason: "the same helper works for plain strings AND structured payloads".
 * Ours needs it for `notification_template.subject`/`body` today.
 *
 * An empty string counts as ABSENT, not as answered. ExpenseOS's coverage gate
 * treats `''` as a missing translation for the same reason, and their
 * `localized()` already required `.length > 0` — a half-authored template is a
 * MISS, so the caller drops to shipped copy instead of sending an empty message.
 */
export function localizedFrom<T = string>(map: unknown, locale: string): T | null {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return null;
  const m = map as Record<string, unknown>;
  for (const tag of fallbackChain(locale)) {
    const value = m[tag];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    return value as T;
  }
  return null;
}

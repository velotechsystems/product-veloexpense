/**
 * VX4-7 part 1 — the locale registry and the fallback chain.
 *
 * No database. This is a list, a table and one lookup, and it gets its own file
 * for the reason `test/spend-statuses.test.ts` does: several features now read
 * it, and the failure being prevented is two of them deciding differently.
 *
 * ── THE ASSERTION THAT MATTERS MOST HERE ────────────────────────────────────
 *
 * `fr-CA has NO English fallback` is the one that would catch a well-meaning
 * edit. Adding `'en-CA'` to the end of `fr-CA`'s chain looks like defensive
 * programming — "at least the reader sees something" — and it is the single
 * change that would make every missing French string invisible: fluent English
 * appears, nothing logs, and every reviewer reading in English sees a page that
 * works. The gate cannot catch it (the chain is data, not text) and no screen
 * would look wrong. Only this test would fail.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  fallbackChain,
  isLocale,
  localeName,
  localizedFrom,
  type Locale,
} from '@/lib/i18n/locales';

describe('the registry', () => {
  it('ships exactly the three locales VX4-7 is about', () => {
    // Pinned deliberately, like the notification catalogue's event list: a fourth
    // locale must be a visible decision in a diff, not something that arrives as
    // a side effect of a translation PR. Adding one here is one line — and the
    // three assertions below then tell you everything else that needs to move.
    expect([...SUPPORTED_LOCALES]).toEqual(['en-CA', 'en-US', 'fr-CA']);
  });

  it('has no bare language subtag, which is IL-1 itself', () => {
    // ExpenseOS shipped `'en'` as its default believing it meant Canadian
    // English. `Intl` reads a bare `en` as American: `3/4/2026`, `CA$10,799.00`.
    // A tag with no region cannot say which conventions it wants.
    for (const locale of SUPPORTED_LOCALES) {
      expect(locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it('the default is one of the supported locales', () => {
    expect(SUPPORTED_LOCALES as readonly string[]).toContain(DEFAULT_LOCALE);
  });

  it('every locale has a non-empty name, in its own language', () => {
    // `LOCALE_NAMES` is `Record<Locale, string>`, so the compiler already refuses
    // a MISSING name. It cannot refuse an empty one, and an empty one renders as
    // a blank `<option>` — a picker with an invisible choice in it.
    for (const locale of SUPPORTED_LOCALES) {
      expect(localeName(locale).trim().length).toBeGreaterThan(0);
    }
    // Endonyms, which is the property that makes the picker usable by the person
    // who needs it: somebody looking at a product in a language they cannot read,
    // hunting for their own. "French (Canada)" would fail that reader.
    expect(localeName('fr-CA')).toContain('Français');
  });

  it('names an unknown tag as itself rather than throwing', () => {
    // This renders inside a `<select>`; a stored value from a retired locale
    // should show as its tag, not take the settings screen down.
    expect(localeName('kl-GL')).toBe('kl-GL');
  });

  it('isLocale accepts every supported tag and rejects the near-misses', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isLocale(locale)).toBe(true);
    // The near-misses are the ones that actually get typed: the bare subtags
    // upstream used, a lowercase region, an underscore (the POSIX spelling), and
    // a locale we do not serve.
    for (const bad of ['en', 'fr', 'en-ca', 'en_CA', 'fr-FR', 'es-MX', '', null, undefined, 42]) {
      expect(isLocale(bad)).toBe(false);
    }
  });
});

describe('the fallback chain', () => {
  it('every chain starts with its own locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(fallbackChain(locale)[0]).toBe(locale);
    }
  });

  it('every hop lands on a supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const hop of fallbackChain(locale)) {
        expect(SUPPORTED_LOCALES as readonly string[]).toContain(hop);
      }
    }
  });

  it('no chain repeats a locale, so no chain can loop', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const chain = fallbackChain(locale);
      expect(new Set(chain).size).toBe(chain.length);
    }
  });

  it('every locale has a chain — a new locale cannot arrive without one', () => {
    // `fallbackChain` returns the DEFAULT's chain for an unknown tag, which is
    // right for stored data and would hide a registry gap. So this asserts the
    // table by identity: a locale added to SUPPORTED_LOCALES and forgotten in
    // FALLBACK_CHAIN would come back with `en-CA` first instead of itself, and
    // `every chain starts with its own locale` above is what fails.
    for (const locale of SUPPORTED_LOCALES) {
      expect(fallbackChain(locale)).not.toHaveLength(0);
    }
  });

  it('en-US inherits en-CA, so a shared string is authored once', () => {
    expect([...fallbackChain('en-US')]).toEqual(['en-US', 'en-CA']);
  });

  it('en-CA answers only for itself, because it is where copy is authored', () => {
    expect([...fallbackChain('en-CA')]).toEqual(['en-CA']);
  });

  it('fr-CA has NO English fallback', () => {
    // See this file's header. The reason is not symmetry — it is that a fluent
    // English sentence is invisible to an English-speaking reviewer, so a silent
    // fallback makes missing French copy permanent, whereas its absence makes it
    // a bug report that files itself.
    expect([...fallbackChain('fr-CA')]).toEqual(['fr-CA']);
    expect(fallbackChain('fr-CA')).not.toContain('en-CA');
    expect(fallbackChain('fr-CA')).not.toContain('en-US');
  });

  it('an unknown tag reads as the default rather than throwing', () => {
    // Called on stored values — `app_user.locale`, a jsonb key — so a row that
    // predates a locale being retired must render, not 500.
    expect([...fallbackChain('kl-GL')]).toEqual([...fallbackChain(DEFAULT_LOCALE)]);
  });
});

describe('localizedFrom', () => {
  const map = {
    'en-CA': 'Cheque',
    'en-US': 'Check',
    'fr-CA': 'Chèque',
  };

  it('reads the exact locale when it has copy', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(localizedFrom(map, locale)).toBe(map[locale as Locale]);
    }
  });

  it('falls en-US back to en-CA when only the shared string exists', () => {
    // The intended steady state: `en-US` carries the handful of words that
    // genuinely differ and inherits everything else.
    expect(localizedFrom({ 'en-CA': 'Expense report' }, 'en-US')).toBe('Expense report');
  });

  it('gives a French reader NOTHING rather than English', () => {
    expect(localizedFrom({ 'en-CA': 'Expense report' }, 'fr-CA')).toBeNull();
  });

  it('treats an empty string as absent, not as an answer', () => {
    // A half-authored template is a MISS, so the caller drops to shipped copy
    // instead of sending an empty message. ExpenseOS's coverage gate counts `''`
    // as a missing translation for the same reason, and the `localized()` this
    // replaced already required `.length > 0`.
    expect(localizedFrom({ 'en-US': '', 'en-CA': 'Check' }, 'en-US')).toBe('Check');
    expect(localizedFrom({ 'en-CA': '' }, 'en-CA')).toBeNull();
  });

  it('skips a null or undefined entry the same way', () => {
    expect(localizedFrom({ 'en-US': null, 'en-CA': 'Check' }, 'en-US')).toBe('Check');
    expect(localizedFrom({ 'en-US': undefined, 'en-CA': 'Check' }, 'en-US')).toBe('Check');
  });

  it('returns null for anything that is not a locale map', () => {
    for (const notAMap of [null, undefined, 'en-CA', 42, ['en-CA'], true]) {
      expect(localizedFrom(notAMap, 'en-CA')).toBeNull();
    }
  });

  it('is generic over the value, as the stored template columns need', () => {
    // ExpenseOS's reason for the generic, ported with it: "the same helper works
    // for plain strings AND structured payloads (e.g. email templates with
    // { subject, body, html } fields)". Ours needs it for jsonb today.
    const structured = { 'en-CA': { subject: 'Approved', body: 'Your report cleared.' } };
    expect(localizedFrom<{ subject: string; body: string }>(structured, 'en-CA')?.subject).toBe(
      'Approved',
    );
  });

  it('ignores a key that is not a supported locale, even an exact-looking one', () => {
    // A jsonb column can hold anything, including the `en` this ticket retagged
    // away from. A stray `en` must NOT satisfy an `en-CA` read: if it did, the
    // migration in 0027 would look unnecessary and a half-migrated row would
    // render as though it were fine.
    expect(localizedFrom({ en: 'Old copy' }, 'en-CA')).toBeNull();
    expect(localizedFrom({ en: 'Old copy' }, 'en-US')).toBeNull();
  });
});

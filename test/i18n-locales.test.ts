/**
 * VX4-7 part 1 — the locale registry and the fallback chain.
 *
 * No database. This is a list, a table and one lookup, and it gets its own file
 * for the reason `test/spend-statuses.test.ts` does: several features now read
 * it, and the failure being prevented is two of them deciding differently.
 *
 * ── THE ASSERTION THAT MATTERS MOST HERE ────────────────────────────────────
 *
 * `NO shipped locale falls back across a language boundary`. Adding
 * `'fr-CA': ['fr-CA', 'en-CA']` looks like defensive programming — "at least the
 * reader sees something" — and it is the single change that would make every
 * missing French string invisible: fluent English appears, nothing logs, and
 * every reviewer reading in English sees a page that works. The gate cannot
 * catch it (the chain is data, not text) and no screen would look wrong. Only
 * this test would fail.
 *
 * It was written as `fr-CA has NO English fallback` in part 1 and generalised in
 * part 2a when fr-CA was retired (0028) — the rule is unchanged, but a test that
 * named a locale we no longer ship would have been asserting about nothing.
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
  it('ships exactly the locales whose copy is COMPLETE', () => {
    // Pinned deliberately, like the notification catalogue's event list: a locale
    // must be a visible decision in a diff, not something that arrives as a side
    // effect of a translation PR.
    //
    // `fr-CA` was here after part 1 and left in part 2a (0028). This array does
    // not mean "locales we intend to support" — it means "locales a reader can
    // be served in", and `test/i18n-enum-catalog.test.ts` enforces the
    // difference by refusing any locale in this list that is missing copy for a
    // rendered enum member. Putting fr-CA back is one line here plus its chain
    // and its name; the suite then goes red until all 86 strings exist.
    expect([...SUPPORTED_LOCALES]).toEqual(['en-CA', 'en-US']);
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

  it('every locale has a real name, not its tag', () => {
    // `LOCALE_NAMES` is `Record<Locale, string>`, so the compiler already refuses
    // a MISSING name. It cannot refuse an empty one or a lazy one, and either
    // renders as a useless `<option>` — blank, or "en-CA" shown to somebody who
    // does not think in BCP 47.
    for (const locale of SUPPORTED_LOCALES) {
      const name = localeName(locale);
      expect(name.trim().length).toBeGreaterThan(0);
      expect(name, `${locale} has no human name`).not.toBe(locale);
    }

    // NOT ASSERTED HERE, and worth saying why rather than leaving a hole: the
    // ENDONYM rule — that each locale is named in its OWN language, so somebody
    // looking at a product they cannot read can find their language — has no
    // demonstrable case while both shipped locales are English. It is stated in
    // `locales.ts` and becomes testable the moment a non-English locale returns.
    // Writing `expect(localeName('fr-CA')).toContain('Français')` today would
    // assert against a retired locale and pass for the wrong reason.
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

  it('NO shipped locale falls back across a language boundary', () => {
    // The rule `fr-CA has NO English fallback` used to assert directly. It still
    // holds and is still the load-bearing one — a fluent English sentence is
    // invisible to an English-speaking reviewer, so a silent cross-language
    // fallback makes missing copy permanent — but with only English locales
    // shipped there is no cross-language edge to point at.
    //
    // So it is asserted as the general property instead, which is what the rule
    // always was: every hop stays inside the same language. That fails the day
    // somebody adds `'fr-CA': ['fr-CA', 'en-CA']`, which is precisely the
    // well-meaning edit the rule exists to stop.
    for (const locale of SUPPORTED_LOCALES) {
      const language = locale.split('-')[0];
      for (const hop of fallbackChain(locale)) {
        expect(hop.split('-')[0], `${locale} falls back to ${hop}`).toBe(language);
      }
    }
  });

  it('a RETIRED locale degrades to the default, rather than throwing', () => {
    // `fr-CA` is now an UNKNOWN tag, and unknown tags read as the default — see
    // `fallbackChain`'s own comment about stored values outliving a locale.
    // Degrading a stranded row to English is right; it is NOT the same as a
    // shipped locale falling back to English, which the test above forbids. The
    // difference is whether the product claims to speak the language.
    expect([...fallbackChain('fr-CA')]).toEqual([...fallbackChain(DEFAULT_LOCALE)]);
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

  it('gives a reader of an UNAUTHORED shipped locale nothing', () => {
    // The rule, expressed without a retired locale to lean on: a map that has no
    // entry reachable from the requested locale's chain returns null, and the
    // caller shows the missing-copy marker rather than another language.
    expect(localizedFrom({}, 'en-CA')).toBeNull();
    expect(localizedFrom({ 'en-US': 'Check' }, 'en-CA')).toBeNull();
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

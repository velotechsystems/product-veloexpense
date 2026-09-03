/**
 * VX4-7 part 1 — precedence, and the header negotiation under it.
 *
 * No database. IL-2's finding is that ExpenseOS's precedence chain has no
 * non-test callers, so it is documented behaviour nothing exercises. This file
 * is the half of the answer that can be asserted without a request; the other
 * half is `test/i18n-schema.db.test.ts`, which drives the same chain from real
 * rows, and `readerPrefs()` in the layout, which is the caller.
 *
 * ── THE TWO ASSERTIONS THAT ARE ABOUT A DECISION, NOT A MECHANISM ───────────
 *
 * `the company outranks the browser` is a deliberate divergence from upstream's
 * documented order and the place to notice if somebody reverses it.
 *
 * `locale and timezone resolve independently` is the one a plausible refactor
 * breaks: short-circuiting on "this user has some preference" reads as an
 * optimisation and would hand a Vancouver employee at a Toronto company either
 * the wrong clock or the wrong language, depending on which way it was written.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import {
  DEFAULT_TIMEZONE,
  negotiateLocale,
  resolveLocale,
  resolveReaderPrefs,
  resolveTimeZone,
} from '@/lib/i18n/resolve';

describe('locale precedence', () => {
  it('the reader wins over everything', () => {
    expect(
      resolveLocale({
        userLocale: 'en-US',
        orgLocale: 'en-CA',
        acceptLanguage: 'en-CA,en;q=0.9',
      }),
    ).toBe('en-US');
  });

  it('the company answers when the reader has no preference', () => {
    // NULL on `app_user.locale` is a real answer meaning "follow the company",
    // which is what makes an admin changing the default move everybody who never
    // chose. See 0027's column comment.
    expect(resolveLocale({ userLocale: null, orgLocale: 'en-US' })).toBe('en-US');
  });

  it('the company outranks the browser', () => {
    // Upstream puts Accept-Language above the default and has no company rung at
    // all (IL-2: "there is no company default column at all — which is the one a
    // multi-tenant product needs first"). Inserting the company ABOVE the header
    // is the choice: a default_locale is an administrative decision somebody made
    // and can be held to; a header is whatever browser happens to be open. An
    // employee who genuinely wants French sets their own preference, which is the
    // rung above and wins — as the first test here asserts.
    expect(resolveLocale({ orgLocale: 'en-CA', acceptLanguage: 'en-US,en;q=0.9' })).toBe('en-CA');
  });

  it('the browser answers pre-auth, where it is the only signal there is', () => {
    // `/login` has no user AND no tenant — `lib/branding/request.ts` resolves the
    // org from the session and returns NONE without one, and 0023 records that
    // pre-auth tenant resolution waits for Phase 5's host-based tenancy. So on
    // the first screen every user meets, this rung is the whole of localisation.
    expect(resolveLocale({ acceptLanguage: 'en-US' })).toBe('en-US');
  });

  it('falls to the constant when nothing else says anything', () => {
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ userLocale: null, orgLocale: null, acceptLanguage: null })).toBe(
      DEFAULT_LOCALE,
    );
  });

  it('skips a stored value that is no longer a supported locale', () => {
    // A row can outlive a locale being retired from the registry, and the reader
    // should then get their company's language rather than an exception on every
    // page. The rung is skipped, not the whole chain.
    expect(resolveLocale({ userLocale: 'es-MX', orgLocale: 'en-US' })).toBe('en-US');
    // And the retagged-away bare subtag specifically, which is what any row
    // written before 0027 would contain.
    expect(resolveLocale({ userLocale: 'en', orgLocale: 'en-US' })).toBe('en-US');
  });
});

describe('timezone precedence', () => {
  it('the reader wins, then the company, then UTC', () => {
    expect(
      resolveTimeZone({ userTimeZone: 'America/Vancouver', orgTimeZone: 'America/Toronto' }),
    ).toBe('America/Vancouver');
    expect(resolveTimeZone({ userTimeZone: null, orgTimeZone: 'America/Toronto' })).toBe(
      'America/Toronto',
    );
    expect(resolveTimeZone({})).toBe(DEFAULT_TIMEZONE);
  });

  it('treats a blank stored zone as no preference', () => {
    // 0027's CHECK refuses a blank string, so this should be unreachable through
    // the column — and it is kept for the reason 0014 keeps its unreachable
    // branch: it fires only if a later change lets a blank through, which is
    // exactly the change that would otherwise make every date render in UTC with
    // nothing saying why.
    expect(resolveTimeZone({ userTimeZone: '   ', orgTimeZone: 'America/Toronto' })).toBe(
      'America/Toronto',
    );
    expect(resolveTimeZone({ userTimeZone: '', orgTimeZone: '' })).toBe(DEFAULT_TIMEZONE);
  });

  it('has no browser rung, because there cannot be one', () => {
    // A timezone is in no request header, and `Intl...resolvedOptions().timeZone`
    // runs in a browser — which this product does not ship JavaScript to. So a
    // zone is stored or it is UTC. This asserts the absence rather than leaving it
    // as a comment: an `acceptLanguage` present and a locale negotiated from it
    // must still leave the clock alone.
    // `ResolveTimeZoneInput` has no `acceptLanguage` field AT ALL, which is the
    // structural half of this claim — a header cannot reach the clock even by
    // mistake, because there is nowhere to put it. The runtime half is below: a
    // request that successfully negotiates a locale from the header still gets
    // the default zone.
    expect(resolveTimeZone({})).toBe(DEFAULT_TIMEZONE);
    const prefs = resolveReaderPrefs({ acceptLanguage: 'en-US' });
    expect(prefs.locale).toBe('en-US');
    expect(prefs.timeZone).toBe(DEFAULT_TIMEZONE);
  });
});

describe('locale and timezone resolve independently', () => {
  it('a reader who set only a zone gets their zone and the company language', () => {
    // See the header. A short-circuit on "the user has some preference" is the
    // refactor this catches.
    const prefs = resolveReaderPrefs({
      userLocale: null,
      userTimeZone: 'America/Vancouver',
      orgLocale: 'en-US',
      orgTimeZone: 'America/Toronto',
    });
    expect(prefs).toEqual({ locale: 'en-US', timeZone: 'America/Vancouver' });
  });

  it('a reader who set only a language gets their language and the company clock', () => {
    const prefs = resolveReaderPrefs({
      userLocale: 'en-CA',
      userTimeZone: null,
      orgLocale: 'en-US',
      orgTimeZone: 'America/Toronto',
    });
    expect(prefs).toEqual({ locale: 'en-CA', timeZone: 'America/Toronto' });
  });
});

describe('Accept-Language negotiation', () => {
  it('matches an exact tag', () => {
    expect(negotiateLocale('en-US')).toBe('en-US');
    expect(negotiateLocale('en-CA')).toBe('en-CA');
  });

  it('is case-insensitive, as the header is', () => {
    expect(negotiateLocale('EN-us')).toBe('en-US');
    expect(negotiateLocale('en-ca')).toBe('en-CA');
  });

  it('does NOT offer a retired locale, however politely asked', () => {
    // `fr-CA` left SUPPORTED_LOCALES in part 2a (0028). Negotiation reads that
    // array, so a French browser now falls through to the company default rather
    // than being handed a language the product cannot speak — which is the whole
    // point of retiring it rather than shipping it empty.
    expect(negotiateLocale('fr-CA')).toBeNull();
    expect(negotiateLocale('fr-CA,fr;q=0.9')).toBeNull();
    expect(resolveLocale({ orgLocale: 'en-CA', acceptLanguage: 'fr-CA' })).toBe('en-CA');
  });

  it('matches a bare language to the house flavour of it', () => {
    // `en` and `en-GB` both mean "some English"; we have two and hand over the
    // first in SUPPORTED_LOCALES, which is the Canadian one. This is where a
    // prefix rule is legitimate — it matches a REQUEST against what we offer,
    // rather than deciding where authored copy comes from.
    expect(negotiateLocale('en')).toBe('en-CA');
    expect(negotiateLocale('en-GB')).toBe('en-CA');
    // …and a language we do not serve matches nothing, rather than the first
    // thing in the list. `fr` used to answer `fr-CA` here.
    expect(negotiateLocale('fr')).toBeNull();
    expect(negotiateLocale('fr-FR')).toBeNull();
  });

  it('prefers an exact match over a higher-q prefix match', () => {
    // Both passes run over the whole list, exact first. `fr-FR;q=0.9` outranks
    // `en-US;q=0.8` by q, but `en-US` is a locale we actually serve and `fr-FR`
    // is not — serving Canadian French to somebody who asked for France French
    // over American English they also asked for is the wrong trade.
    expect(negotiateLocale('en-GB;q=0.9,en-US;q=0.8')).toBe('en-US');
  });

  it('honours q-ordering among exact matches', () => {
    expect(negotiateLocale('en-US;q=0.4,en-CA;q=0.9')).toBe('en-CA');
    expect(negotiateLocale('en-CA;q=0.4,en-US;q=0.9')).toBe('en-US');
  });

  it('keeps header order when q values tie', () => {
    expect(negotiateLocale('en-CA,en-US')).toBe('en-CA');
    expect(negotiateLocale('en-US,en-CA')).toBe('en-US');
  });

  it('treats q=0 as a refusal, not a preference', () => {
    // The one header form that says "not this one". `fr-CA;q=0` must not select
    // French — and with nothing else on offer the answer is null, so the caller
    // falls to the company default or the constant.
    expect(negotiateLocale('en-CA;q=0')).toBeNull();
    expect(negotiateLocale('en-CA;q=0,en-US;q=0.5')).toBe('en-US');
  });

  it('ignores the wildcard rather than treating it as anything', () => {
    expect(negotiateLocale('*')).toBeNull();
    expect(negotiateLocale('*;q=0.5,en-US;q=0.1')).toBe('en-US');
  });

  it('returns null — distinguishably — when nothing matches', () => {
    // ExpenseOS calls `@formatjs/intl-localematcher` with DEFAULT_LOCALE as its
    // fallback argument, so it CANNOT return "no match": an unrecognised header
    // and a header asking for the default come back identical. Keeping them
    // distinct is what makes the constant rung separately testable, and it is why
    // the dependency was not ported.
    expect(negotiateLocale('es-MX,de-DE')).toBeNull();
    expect(negotiateLocale('')).toBeNull();
    expect(negotiateLocale(null)).toBeNull();
    expect(negotiateLocale(undefined)).toBeNull();
  });

  it('survives a malformed header instead of throwing', () => {
    // `intl-localematcher` throws on malformed input and upstream wraps it in a
    // try/catch with a comment saying so. This parser has nothing to throw, but
    // the inputs are worth pinning: they are what a fuzzer and a broken proxy
    // actually send.
    for (const header of [';;;', 'en-US;q=', 'en-US;q=abc', ',,,', '   ', 'en-US;;q=0.5;;']) {
      expect(() => negotiateLocale(header)).not.toThrow();
    }
    // A missing or unparseable q is treated as q=1, per RFC 9110.
    expect(negotiateLocale('en-US;q=')).toBe('en-US');
    expect(negotiateLocale('en-US;q=abc')).toBe('en-US');
  });

  it('does not leak state between calls', () => {
    // Two negotiations in a row must not influence each other. The first draft of
    // `negotiateLocale` kept q-values in a module-level map, which this would
    // have caught if it ever became async — the map is now a local, and this is
    // the assertion that keeps it one.
    expect(negotiateLocale('en-CA;q=0.9,en-US;q=0.1')).toBe('en-CA');
    expect(negotiateLocale('en-US;q=0.9,en-CA;q=0.1')).toBe('en-US');
    expect(negotiateLocale('es-MX')).toBeNull();
    expect(negotiateLocale('en-CA')).toBe('en-CA');
  });
});

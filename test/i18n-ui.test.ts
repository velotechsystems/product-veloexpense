/**
 * VX4-10 part 1 — the UI chrome catalogue.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ────────────────────────────────────
 *
 * The five catalogues before this one are keyed by something the product
 * enumerates — a status union, a rule's message codes — so their suites can ask
 * "does every member resolve" and get a real answer. Chrome has no such
 * enumeration: `UI_COPY` *is* the list, so asking whether it covers its own keys
 * is asking the catalogue about itself, which VX4-7's UD-5 requirement 2 already
 * warned passes when the catalogue is wrong in a self-consistent way.
 *
 * So this file tests the properties that are NOT self-referential — every entry
 * resolves in every shipped locale, no entry smuggles a parameter, and the
 * pseudo-locale reaches it — and the coverage question is answered somewhere
 * else entirely: by `e2e/pseudo-crawl.spec.ts`'s ratchet, which counts what a
 * page actually renders. Neither half is sufficient alone, and saying so here is
 * better than a test that looks stronger than it is.
 */
import { describe, it, expect } from 'vitest';
import {
  UI_COPY,
  UI_KEYS,
  uiText,
  UI_SENTENCES,
  UI_SENTENCE_KEYS,
  uiSentence,
  uiPlural,
  uiAround,
  UiSentenceError,
  type UiKey,
} from '@/lib/i18n/catalog/ui';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@/lib/i18n/locales';

describe('every entry resolves', () => {
  it('in every shipped locale, with no missing-copy marker', () => {
    for (const key of UI_KEYS) {
      for (const locale of SUPPORTED_LOCALES) {
        const text = uiText(key, locale);
        expect(text, `${key} in ${locale}`).not.toBe('');
        // `missingCopyMarker` renders `{the.key}` — braces around the key it
        // could not resolve. Reaching it from a VALID key means the fallback
        // chain broke, which is the one failure a reader sees as a bug rather
        // than as bad copy. Asserted against the marker's real shape rather than
        // a word I assumed was in it: the first draft of this file looked for
        // "missing:" and passed for the wrong reason.
        expect(text, `${key} in ${locale}`).not.toBe(`{${key}}`);
      }
    }
  });

  it('and the default locale is present on every entry, by construction', () => {
    // `Copy` demands `en-CA` at the type level, so this cannot fail while the
    // file compiles. It is here because the type could be loosened by somebody
    // who does not know why it is tight: `en-CA` is where copy is authored and
    // has nowhere to fall back to, so a missing one is missing everywhere.
    for (const key of UI_KEYS) {
      expect(UI_COPY[key], key).toHaveProperty(DEFAULT_LOCALE);
    }
  });
});

describe('what may not be in this catalogue', () => {
  it('no entry carries an ICU-style parameter', () => {
    // A sentence naming a number or a date belongs in the renderer-shaped
    // catalogues (`message-data.ts`), which take typed params. A `{threshold}`
    // here would render verbatim at a reader — which is exactly the defect
    // upstream shipped and their #400 fixed, and the reason this assertion is a
    // gate rather than a convention.
    for (const key of UI_KEYS) {
      for (const [locale, text] of Object.entries(UI_COPY[key] as Record<string, string>)) {
        expect(text, `${key} (${locale}) carries a parameter`).not.toMatch(/\{[a-zA-Z_]\w*\}/);
      }
    }
  });

  it('no entry is empty or whitespace', () => {
    for (const key of UI_KEYS) {
      for (const [locale, text] of Object.entries(UI_COPY[key] as Record<string, string>)) {
        expect(text.trim(), `${key} (${locale})`).not.toBe('');
      }
    }
  });

  it('every key is dotted and lower-case — one namespace, machine-readable', () => {
    // The flat dotted shape is what lets `check:i18n` read these keys with the
    // same shallow parse it uses on the other five catalogues, and what makes an
    // interpolated key a type error rather than something a guard chases later.
    for (const key of UI_KEYS) {
      expect(key, `${key} is not a dotted lower-case key`).toMatch(
        /^[a-z][a-z0-9]*(\.[A-Za-z0-9_]+)+$/,
      );
    }
  });
});

describe('the fallback marker is reachable only from outside the type', () => {
  it('an unknown key returns the marker rather than throwing or returning ""', () => {
    // Unreachable through `UiKey`, which is the point — the cast is what proves
    // the guard exists for a value that arrived from outside the type system,
    // and that it fails LOUDLY rather than rendering an empty heading.
    const text = uiText('no.such.key' as UiKey);
    expect(text).toBe('{no.such.key}');
  });
});

describe('the keys are stable identifiers, not copy', () => {
  it('no two keys differ only by case or trailing punctuation', () => {
    // Cheap protection against the drift this catalogue is most likely to suffer:
    // `billing.title` and `billing.Title` both resolving, one of them dead.
    const normalised = UI_KEYS.map((k) => k.toLowerCase().replace(/[.\s]+$/, ''));
    expect(new Set(normalised).size).toBe(UI_KEYS.length);
  });
});

/**
 * VX4-10 part 2 — the parameterised half.
 *
 * `UI_COPY` above is checked for the ABSENCE of parameters. This map is the
 * opposite and the two rules are one rule: a string with a `{hole}` in it must be
 * in the map whose renderer fills holes, and a string without one must not be, so
 * that neither map can quietly become the other.
 */
describe('the sentence catalogue', () => {
  it('every entry resolves in every shipped locale', () => {
    for (const key of UI_SENTENCE_KEYS) {
      for (const locale of SUPPORTED_LOCALES) {
        const raw = UI_SENTENCES[key] as Record<string, string>;
        const text = raw[locale] ?? raw[DEFAULT_LOCALE];
        expect(text, `${key} in ${locale}`).toBeTruthy();
      }
    }
  });

  it('every entry carries at least one parameter — otherwise it belongs in UI_COPY', () => {
    // The inverse of the rule on `UI_COPY`, and the reason both can be trusted.
    // Three entries failed this while part 2 was being written — a link's TEXT, an
    // admin suffix — and all three moved rather than the rule bending.
    for (const key of UI_SENTENCE_KEYS) {
      for (const [locale, text] of Object.entries(UI_SENTENCES[key] as Record<string, string>)) {
        expect(text, `${key} (${locale}) has no parameter`).toMatch(/\{[a-zA-Z_]\w*\}/);
      }
    }
  });

  it('a plural base has an entry for every category its locales ask for', () => {
    // The real coverage question for plurals, and it cannot be asked of the map
    // alone: `Intl.PluralRules` decides which key gets looked up at render time, so
    // a missing category is a fallback nobody sees until that language ships.
    const bases = new Set(
      UI_SENTENCE_KEYS.filter((k) => /\.(one|two|few|many|other|zero)$/.test(k)).map((k) =>
        k.slice(0, k.lastIndexOf('.')),
      ),
    );
    expect(bases.size, 'no plural bases found — has the naming changed?').toBeGreaterThan(0);
    for (const base of bases) {
      for (const locale of SUPPORTED_LOCALES) {
        for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
          expect(
            UI_SENTENCE_KEYS,
            `${base} has no .${category} for ${locale}`,
          ).toContain(`${base}.${category}`);
        }
      }
    }
  });

  it('fills its parameters, and picks the right plural form', () => {
    expect(uiPlural('expenses.count.own', 1)).toBe('1 report submitted by you');
    expect(uiPlural('expenses.count.own', 26)).toBe('26 reports submitted by you');
    expect(uiPlural('expenses.count.own', 0)).toBe('0 reports submitted by you');
    expect(uiSentence('expenses.page.of', { page: '2', pages: '7' })).toBe('Page 2 of 7');
  });

  it('REFUSES a missing parameter rather than rendering a hole', () => {
    // `message-data.ts`'s argument, applied here: "undefined is $700.00, over the
    // undefined limit" is a sentence, renders fine, and tells a reader nothing
    // while looking like it worked. A `{page}` on the screen should be a crash in
    // a test, not a shrug in production.
    expect(() => uiSentence('expenses.page.of', { page: '2' })).toThrow(UiSentenceError);
    expect(() => uiSentence('expenses.page.of', { page: '2' })).toThrow(/needs \{pages\}/);
  });

  it('splits a sentence at its {link}, and refuses one that has none', () => {
    const [before, after] = uiAround('approvals.footer');
    expect(before).toContain('Going away?');
    expect(after).toContain('you keep your queue');
    // Neither half may contain the marker, or JSX would render it verbatim.
    expect(before + after).not.toContain('{link}');
    expect(() => uiAround('expenses.page.of', { page: '1', pages: '1' })).toThrow(UiSentenceError);
  });

  it('has no key in both maps', () => {
    // Two maps, two renderers, one namespace as far as a translator is concerned.
    // A key in both would resolve differently depending on which function a call
    // site happened to use.
    const overlap = UI_SENTENCE_KEYS.filter((k) => (UI_KEYS as string[]).includes(k));
    expect(overlap).toEqual([]);
  });
});

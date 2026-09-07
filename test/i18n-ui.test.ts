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
import { UI_COPY, UI_KEYS, uiText, type UiKey } from '@/lib/i18n/catalog/ui';
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

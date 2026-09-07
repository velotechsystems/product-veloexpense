/**
 * VX4-10 part 4 — the list formatter.
 *
 * `lib/i18n/list.ts` replaced three `.join()` calls, one of which spelled an
 * English conjunction into a sentence a translator is otherwise free to write.
 * These tests are about the two things a `join` cannot do and one thing it did
 * better, which is worth being honest about: `join` never throws.
 */
import { describe, it, expect } from 'vitest';
import { joinAnd, joinOr } from '@/lib/i18n/list';
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

describe('joining a list in the reader’s language', () => {
  it('puts a conjunction between the last two, not a comma', () => {
    expect(joinAnd(['A', 'B'], 'en-CA')).toBe('A and B');
    expect(joinAnd(['A', 'B', 'C'], 'en-CA')).toBe('A, B and C');
  });

  it('and a disjunction when that is what is meant', () => {
    expect(joinOr(['A', 'B'], 'en-CA')).toBe('A or B');
  });

  it('separates every item visibly in every language, which is why there is no unit mode', () => {
    // The measurement that removed `joinList`. `Intl.ListFormat`'s `unit` type is
    // CLDR's MEASUREMENT joiner — it makes "3 ft 7 in" — and gives Chinese
    // "USDEURGBP" at every style, so a list of opaque codes has to go through the
    // conjunction like everything else. These are the actual outputs, not what
    // seemed likely: the first draft of this file asserted `'A、B'` from `unit` in
    // Japanese and got `'A B'`.
    expect(joinAnd(['USD', 'EUR', 'GBP'], 'en-CA')).toBe('USD, EUR and GBP');
    expect(joinAnd(['USD', 'EUR', 'GBP'], 'zh-CN')).toBe('USD、EUR和GBP');
    expect(joinAnd(['USD', 'EUR', 'GBP'], 'ja-JP')).toBe('USD、EUR、GBP');
  });

  it('never leaves a dangling separator on nought or one item', () => {
    // The case a hand-rolled join gets wrong first: `['A'].join(' and ')` is
    // fine, but every `length === 1 ? x : join(...)` written at a call site is a
    // branch somebody has to remember.
    expect(joinAnd([], 'en-CA')).toBe('');
    expect(joinAnd(['Only one'], 'en-CA')).toBe('Only one');
    expect(joinOr([], 'en-CA')).toBe('');
  });

  it('resolves in every shipped locale without throwing', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(joinAnd(['A', 'B'], locale), locale).toContain('A');
      expect(joinAnd(['A', 'B'], locale), locale).toContain('B');
    }
  });

  it('falls back to a comma join on a tag Intl cannot parse', () => {
    // The one thing `.join()` did better: it could not throw. `Intl.ListFormat`
    // can, on a malformed tag, and a render path is the wrong place to find out.
    // The fallback is deliberately the OLD behaviour — wrong in the same way for
    // every locale rather than broken for one.
    expect(joinAnd(['A', 'B'], 'not a locale at all')).toBe('A, B');
  });

  it('is actually locale-sensitive, which is the whole point', () => {
    // The assertion that fails if somebody replaces the implementation with a
    // join and calls it equivalent. Japanese uses an ideographic comma and no
    // conjunction word; Spanish uses "y". No `.join()` can know either.
    expect(joinAnd(['A', 'B'], 'ja-JP')).toBe('A、B');
    expect(joinAnd(['A', 'B'], 'es-ES')).toBe('A y B');
  });
});

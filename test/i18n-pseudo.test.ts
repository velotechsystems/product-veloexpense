/**
 * VX4-7 part 3 — the pseudo-locale transform.
 *
 * The transform itself, in isolation. What it is FOR — proving a string came
 * from a catalogue — is asserted by `e2e/pseudo-crawl.spec.ts` against real
 * pages; this file pins the properties that make it usable, and each one of them
 * is a way the transform could quietly ruin the crawl instead of informing it.
 */
import { describe, it, expect } from 'vitest';
import { isPseudoized, pseudoize, PSEUDO_MARKERS } from '@/lib/i18n/pseudo';

describe('pseudoize', () => {
  it('brackets, so a crawler can match on it', () => {
    const out = pseudoize('Submitted');
    expect(out.startsWith(PSEUDO_MARKERS.open)).toBe(true);
    expect(out.endsWith(PSEUDO_MARKERS.close)).toBe(true);
    expect(isPseudoized(out)).toBe(true);
    expect(isPseudoized('Submitted')).toBe(false);
  });

  it('keeps a {placeholder} intact', () => {
    // THE property that matters most. `fill()` in catalog/errors.ts substitutes
    // on `{name}`; accent the braces or the word inside and every parameterised
    // refusal degrades to the generic — so the crawl would be testing the
    // generic thirty times over and reporting success.
    const out = pseudoize('The logo is {size} KiB and the limit is {limit} KiB.');
    expect(out).toContain('{size}');
    expect(out).toContain('{limit}');
  });

  it('keeps money, ratios and dates readable', () => {
    // These come from `Intl` or from a parameter and are not copy. Mangling them
    // would hide what part 1b and part 2b made correct — a crawl that cannot
    // tell `$700.00` from `$7ÖÖ.ÖÖ` is a crawl that cannot check formatting.
    expect(pseudoize('is $700.00, over the $500.00 limit')).toContain('$700.00');
    expect(pseudoize('(2026-01-01 to 2026-03-31)')).toContain('2026-01-01');
    expect(pseudoize('4.10:1 against white')).toContain('4.10:1');
  });

  it('grows the text, which is what finds a layout bug', () => {
    // English→French runs 15–30% longer. A label that survives this survives
    // translation; one that clips was going to clip.
    const short = pseudoize('Approve');
    expect(short.length).toBeGreaterThan('Approve'.length * 1.2);
  });

  it('pads on the letters, not the whole string', () => {
    // A sentence that is mostly a formatted amount should not be padded as
    // though it were mostly words — otherwise every money sentence looks like a
    // layout risk and the signal is lost in the noise.
    const mostlyNumbers = pseudoize('$1,234,567.89');
    const mostlyWords = pseudoize('abcdefghijklm');
    expect(mostlyNumbers.length - '$1,234,567.89'.length).toBeLessThan(
      mostlyWords.length - 'abcdefghijklm'.length,
    );
  });

  it('is stable and leaves an empty string alone', () => {
    expect(pseudoize('')).toBe('');
    expect(pseudoize('Approve')).toBe(pseudoize('Approve'));
  });

  it('survives being applied twice', () => {
    // Not a state we want, but `localizedFrom` and `renderPolicyMessage` both
    // apply it and a future third funnel could double up. The result must stay
    // legible in a failure message rather than becoming unreadable soup.
    const twice = pseudoize(pseudoize('Submitted'));
    expect(isPseudoized(twice)).toBe(true);
    expect(twice).toContain(PSEUDO_MARKERS.open);
  });

  it('changes every letter it is given', () => {
    // The guard on the guard: a transform that accented nothing would pass every
    // assertion above except this one, and the crawl would then find nothing
    // while reporting that everything is catalogued.
    const out = pseudoize('The quick brown fox jumps over the lazy dog');
    expect(out).not.toContain('quick');
    expect(out).not.toContain('brown');
    expect(out.replace(/[^a-zA-Z]/g, '')).toBe('');
  });
});

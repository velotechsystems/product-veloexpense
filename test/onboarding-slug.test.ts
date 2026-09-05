/**
 * VX5-1 — the slug rules that are not the database's.
 *
 * `0034` owns the SHAPE and `test/onboarding-provision.db.test.ts` proves the
 * constraint actually refuses. This file is the two things a CHECK constraint
 * should not carry: what a person's typing becomes, and which names the platform
 * keeps for itself.
 */
import { describe, it, expect } from 'vitest';
import { checkSlug, slugify, nextFreeSlug, RESERVED_SLUGS } from '@/lib/onboarding/slug';

describe('checkSlug', () => {
  it('accepts an ordinary company slug', () => {
    for (const ok of ['acme', 'acme-ltd', 'a', 'a1', '3m', 'x'.repeat(63)]) {
      expect(checkSlug(ok), ok).toBeNull();
    }
  });

  it('refuses what a hostname cannot be, and says which rule', () => {
    // The underscore is the interesting one: legal in a DNS record, illegal in a
    // hostname — the kind of difference discovered by a certificate failing to
    // issue rather than by a form failing to submit.
    for (const bad of ['Acme', 'acme_ltd', '-acme', 'acme-', 'ac me', 'acmé', 'x'.repeat(64)]) {
      expect(checkSlug(bad), bad).toBe('SHAPE');
    }
    expect(checkSlug('')).toBe('EMPTY');
    expect(checkSlug('   ')).toBe('EMPTY');
  });

  it('refuses a reserved name SEPARATELY from a malformed one', () => {
    // Two different sentences on screen: "that is not allowed" and "that is not
    // available" send a person looking for different things.
    expect(checkSlug('www')).toBe('RESERVED');
    expect(checkSlug('api')).toBe('RESERVED');
  });

  /**
   * The third group in `RESERVED_SLUGS` is the one that gets forgotten, so it is
   * asserted rather than trusted: a tenant at `billing.veloexpense.com` can send
   * a person a link that is indistinguishable from one of ours.
   */
  it('reserves the names a tenant could impersonate us with', () => {
    for (const name of ['security', 'billing', 'support', 'veloexpense', 'velotech']) {
      expect(RESERVED_SLUGS, name).toContain(name);
      expect(checkSlug(name), name).toBe('RESERVED');
    }
  });

  it('has no reserved entry that its own shape rule would refuse', () => {
    // A reserved word that is not a legal slug is a word nobody could have typed,
    // which means it is protecting nothing and hiding a typo.
    for (const name of RESERVED_SLUGS) {
      expect(checkSlug(name), name).toBe('RESERVED');
    }
  });
});

describe('slugify', () => {
  it('turns a company name into something usable', () => {
    expect(slugify('Acme Ltd.')).toBe('acme-ltd');
    expect(slugify('  Northwind   Traders  ')).toBe('northwind-traders');
    expect(slugify('3M')).toBe('3m');
  });

  it('strips accents rather than deciding what they mean', () => {
    // This much Unicode is safe: removing a combining mark leaves a letter with
    // its identity. Transliteration is not — whether "ß" is "ss" depends on whose
    // company it is, and a signup form is no place to decide.
    expect(slugify('Café Rouge')).toBe('cafe-rouge');
  });

  it('returns EMPTY rather than inventing a name nobody recognises', () => {
    // A fallback like `org-4f2a` is worse than an empty box: it is a name the
    // person did not choose, attached to their company, in a URL.
    expect(slugify('株式会社')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('never produces a slug its own checker would refuse', () => {
    for (const name of ['Acme Ltd.', 'Café Rouge', '  --weird--  ', 'A'.repeat(200), '3M']) {
      const slug = slugify(name);
      if (slug === '') continue;
      expect(checkSlug(slug), `${name} -> ${slug}`).toBeNull();
    }
  });

  it('truncates to a DNS label without leaving a trailing hyphen', () => {
    // The slice is what makes this possible: cutting at 63 can land on a hyphen,
    // and `-` is not a legal last character.
    const slug = slugify(`${'a'.repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(checkSlug(slug)).toBeNull();
  });
});

describe('nextFreeSlug', () => {
  it('takes the base when it is free', () => {
    expect(nextFreeSlug('acme', new Set())).toBe('acme');
  });

  it('counts up when it is not', () => {
    expect(nextFreeSlug('acme', new Set(['acme']))).toBe('acme-2');
    expect(nextFreeSlug('acme', new Set(['acme', 'acme-2', 'acme-3']))).toBe('acme-4');
  });

  it('does not propose a RESERVED name even when it is unclaimed', () => {
    // `taken` comes from the organization table, which has no row for `www` —
    // so without the reserved check this would happily suggest it.
    expect(nextFreeSlug('www', new Set())).toBe('www-2');
  });

  it('keeps the suffix inside the 63-character limit', () => {
    const base = 'a'.repeat(63);
    const next = nextFreeSlug(base, new Set([base]));
    expect(next.length).toBeLessThanOrEqual(63);
    expect(checkSlug(next)).toBeNull();
  });

  it('gives up rather than looping forever', () => {
    const taken = new Set(['acme', ...Array.from({ length: 1000 }, (_, i) => `acme-${i + 2}`)]);
    expect(nextFreeSlug('acme', taken)).toBe('');
  });
});

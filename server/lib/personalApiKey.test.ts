/**
 * The fixed personal-key policy.
 *
 * **Every expected value below is spelled out as a literal, and the policy constant is
 * never imported into the assertion side of a test.** If the assertions read the constant,
 * a rename would update the code and the expectation together and the test would pass
 * while proving nothing. The constant appears here only as the subject under test.
 */

import { unknownScopes } from '@expenseos/api-scopes';
import { describe, expect, it } from 'vitest';
import {
  matchesPersonalPolicy,
  PERSONAL_KEY_POLICY,
  type PersonalPolicyComparable,
  personalKeyExpiresAt,
  personalKeyName,
} from './personalApiKey';

describe('PERSONAL_KEY_POLICY', () => {
  it('fixes all six values', () => {
    expect(PERSONAL_KEY_POLICY.kind).toBe('USER');
    expect(PERSONAL_KEY_POLICY.scopes).toEqual([
      'expense_management.expense_report',
      'travel.travel_request',
      'collaboration.discussion',
    ]);
    expect(PERSONAL_KEY_POLICY.rateLimitPerMinute).toBe(60);
    expect(PERSONAL_KEY_POLICY.expiresInDays).toBe(180);
    expect(PERSONAL_KEY_POLICY.allowedIps).toEqual([]);
  });

  it('grants three scopes and no more', () => {
    // A count assertion as well as a contents one: adding a fourth scope to the constant
    // must be a decision somebody makes on purpose, not a diff that slips through.
    expect(PERSONAL_KEY_POLICY.scopes).toHaveLength(3);
  });

  it('names only scopes this build knows', () => {
    // The guard against a silent scope rename. A stored scope string that no longer appears
    // in the vocabulary authorizes NOTHING, silently — so a rename that forgets this
    // constant would keep minting keys that do nothing at all. This fails the build first.
    expect(unknownScopes(PERSONAL_KEY_POLICY.scopes)).toEqual([]);
  });

  it('holds a duration, not a date', () => {
    // `matchesPersonalPolicy` can only stay comparable while the constant is a duration.
    expect(typeof PERSONAL_KEY_POLICY.expiresInDays).toBe('number');
    expect(PERSONAL_KEY_POLICY).not.toHaveProperty('expiresAt');
  });
});

describe('personalKeyName', () => {
  it('joins both names when both are present', () => {
    expect(personalKeyName({ firstName: 'Jose', lastName: 'Neto', email: 'jose.neto@e.inc' })).toBe(
      'Jose Neto — personal key',
    );
  });

  it('uses the first name alone when the last is null', () => {
    expect(personalKeyName({ firstName: 'Jose', lastName: null, email: 'jose.neto@e.inc' })).toBe(
      'Jose — personal key',
    );
  });

  it('uses the last name alone when the first is null', () => {
    expect(personalKeyName({ firstName: null, lastName: 'Neto', email: 'jose.neto@e.inc' })).toBe(
      'Neto — personal key',
    );
  });

  it('falls back to the email when both names are null', () => {
    // `email` is the only non-nullable one of the three on `model User`, so it is the only
    // safe end of the chain.
    expect(personalKeyName({ firstName: null, lastName: null, email: 'jose.neto@e.inc' })).toBe(
      'jose.neto@e.inc — personal key',
    );
  });

  it('leaves a non-ASCII name exactly as it was given', () => {
    // No transliteration, no upper-casing, no initials, no assumption of Latin script.
    expect(personalKeyName({ firstName: '田中', lastName: '太郎', email: 'tanaka@e.inc' })).toBe(
      '田中 太郎 — personal key',
    );
    expect(personalKeyName({ firstName: 'Ayşe', lastName: 'Yılmaz', email: 'ayse@e.inc' })).toBe(
      'Ayşe Yılmaz — personal key',
    );
    expect(personalKeyName({ firstName: 'Ολυμπία', lastName: null, email: 'o@e.inc' })).toBe(
      'Ολυμπία — personal key',
    );
  });

  it('keeps a mononym, a particle and an internal apostrophe intact', () => {
    // Three shapes a "split it into two parts" implementation gets wrong.
    expect(personalKeyName({ firstName: 'Prince', lastName: null, email: 'p@e.inc' })).toBe(
      'Prince — personal key',
    );
    expect(personalKeyName({ firstName: 'Vincent', lastName: 'van Gogh', email: 'v@e.inc' })).toBe(
      'Vincent van Gogh — personal key',
    );
    expect(personalKeyName({ firstName: "N'Golo", lastName: 'Kanté', email: 'n@e.inc' })).toBe(
      "N'Golo Kanté — personal key",
    );
  });

  it('treats a whitespace-only column as absent', () => {
    // Otherwise the key is called " — personal key" and nobody can tell whose it is.
    expect(personalKeyName({ firstName: '   ', lastName: '', email: 'ghost@e.inc' })).toBe(
      'ghost@e.inc — personal key',
    );
    expect(personalKeyName({ firstName: ' Jose ', lastName: '  ', email: 'j@e.inc' })).toBe(
      'Jose — personal key',
    );
  });

  it('clamps a name that would overrun the 120-character provisioning cap', () => {
    // A long address plus the suffix exceeds what `apiKeys.create` accepts, and the users
    // this hits are the ones with no first or last name — the worst population to fail for.
    const long = `${'a'.repeat(200)}@e.inc`;
    const name = personalKeyName({ firstName: null, lastName: null, email: long });
    expect([...name]).toHaveLength(120);
    expect(name.startsWith('aaaa')).toBe(true);
  });

  it('never cuts an astral character in half', () => {
    // Truncating by UTF-16 unit would leave a lone surrogate here.
    const name = personalKeyName({ firstName: '𝒥'.repeat(200), lastName: null, email: 'j@e.inc' });
    expect([...name]).toHaveLength(120);
    expect(name).toBe('𝒥'.repeat(120));
  });
});

describe('personalKeyExpiresAt', () => {
  it('lands 180 days after the instant given', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(personalKeyExpiresAt(now).toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('spans a DST boundary as 180 whole days, not 179 days and 23 hours', () => {
    const now = new Date('2026-02-01T12:00:00.000Z');
    expect(personalKeyExpiresAt(now).getTime() - now.getTime()).toBe(180 * 86_400_000);
  });

  it('does not mutate the date it was handed', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    personalKeyExpiresAt(now);
    expect(now.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('matchesPersonalPolicy', () => {
  /**
   * A key with the shape a fresh mint produces. Built from literals, not from the policy
   * constant, for the reason in the file docblock.
   */
  const minted = (over: Partial<PersonalPolicyComparable> = {}): PersonalPolicyComparable => ({
    scopes: [
      'expense_management.expense_report',
      'travel.travel_request',
      'collaboration.discussion',
    ],
    rateLimitPerMinute: 60,
    allowedIps: [],
    expiresAt: new Date('2026-06-30T00:00:00.000Z'),
    ...over,
  });

  it('accepts a freshly minted key', () => {
    expect(matchesPersonalPolicy(minted())).toBe(true);
  });

  it('accepts a key minted a millisecond ago', () => {
    // The reason `expiresAt` is checked for presence rather than for a value: an exact-date
    // comparison would make every key fail its own policy check the instant it exists.
    expect(matchesPersonalPolicy(minted({ expiresAt: personalKeyExpiresAt(new Date()) }))).toBe(
      true,
    );
  });

  it('ignores the order the scopes are stored in', () => {
    // The column is an array; the policy is a set. Postgres returns what was written.
    expect(
      matchesPersonalPolicy(
        minted({
          scopes: [
            'collaboration.discussion',
            'expense_management.expense_report',
            'travel.travel_request',
          ],
        }),
      ),
    ).toBe(true);
  });

  it('tolerates a duplicated scope, which grants nothing extra', () => {
    expect(
      matchesPersonalPolicy(
        minted({
          scopes: [
            'expense_management.expense_report',
            'expense_management.expense_report',
            'travel.travel_request',
            'collaboration.discussion',
          ],
        }),
      ),
    ).toBe(true);
  });

  // Each deviation is rejected on its own, with everything else in policy — so a passing
  // test names exactly which comparison is doing the work.

  it('rejects a wider scope set', () => {
    expect(
      matchesPersonalPolicy(
        minted({
          scopes: [
            'expense_management.expense_report',
            'travel.travel_request',
            'collaboration.discussion',
            'admin.people.user',
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a narrower scope set', () => {
    expect(
      matchesPersonalPolicy(
        minted({ scopes: ['expense_management.expense_report', 'travel.travel_request'] }),
      ),
    ).toBe(false);
  });

  it('rejects three scopes that are not these three', () => {
    // Right size, wrong members — the case a length check alone would wave through.
    expect(
      matchesPersonalPolicy(
        minted({
          scopes: [
            'expense_management.expense_report',
            'travel.travel_request',
            'admin.security.api_key',
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a read-only substitution of an in-policy scope', () => {
    // `x.readonly` is a DIFFERENT scope string, not a narrower form of the same one.
    expect(
      matchesPersonalPolicy(
        minted({
          scopes: [
            'expense_management.expense_report.readonly',
            'travel.travel_request',
            'collaboration.discussion',
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects an empty scope set', () => {
    expect(matchesPersonalPolicy(minted({ scopes: [] }))).toBe(false);
  });

  it('rejects a rate limit that is not 60', () => {
    expect(matchesPersonalPolicy(minted({ rateLimitPerMinute: 600 }))).toBe(false);
    expect(matchesPersonalPolicy(minted({ rateLimitPerMinute: 30 }))).toBe(false);
  });

  it('rejects an unlimited rate, which is what a null column means', () => {
    expect(matchesPersonalPolicy(minted({ rateLimitPerMinute: null }))).toBe(false);
  });

  it('rejects a non-empty IP allowlist', () => {
    expect(matchesPersonalPolicy(minted({ allowedIps: ['203.0.113.0/24'] }))).toBe(false);
  });

  it('rejects a key that never expires', () => {
    // The legacy shape. Every key this feature mints has an end date; one that does not was
    // minted under the old form and is not in policy however narrow its scopes are.
    expect(matchesPersonalPolicy(minted({ expiresAt: null }))).toBe(false);
  });

  it('still counts an already-expired key as in policy', () => {
    // In-policy and usable are different questions. The guard refuses an expired key on its
    // own; this function must not conflate "shaped wrong" with "past its date", or the UI
    // would offer to fix a key that has nothing wrong with it but age.
    expect(matchesPersonalPolicy(minted({ expiresAt: new Date('2020-01-01T00:00:00.000Z') }))).toBe(
      true,
    );
  });
});

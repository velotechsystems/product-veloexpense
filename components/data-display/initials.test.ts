import { describe, expect, it } from 'vitest';
import { initialsFrom, initialsFromDisplayName } from './initials';

/**
 * The avatar's initials fallback chain.
 *
 * Every rung is reachable from real directory data: Google SSO can create a user with
 * neither name populated, a directory sync can land a first name without a last, and a
 * seeded service account may have only an email. The function must always return
 * something paintable — an empty avatar reads as a broken image, and `undefined` in a
 * `<span>` renders as nothing at all.
 */

describe('initialsFrom', () => {
  it('takes one letter from each name', () => {
    expect(initialsFrom('Ada', 'Lovelace', 'ada@e.inc')).toBe('AL');
  });

  it('upper-cases whatever it finds', () => {
    expect(initialsFrom('ada', 'lovelace', 'ada@e.inc')).toBe('AL');
  });

  it('falls back to one initial when only a first name exists', () => {
    expect(initialsFrom('Ada', null, 'ada@e.inc')).toBe('A');
  });

  it('falls back to one initial when only a last name exists', () => {
    expect(initialsFrom(null, 'Lovelace', 'ada@e.inc')).toBe('L');
  });

  it('falls back to the email when neither name is set', () => {
    // A Google SSO user before the directory sync fills the name fields in.
    expect(initialsFrom(null, null, 'ada@e.inc')).toBe('A');
    expect(initialsFrom(undefined, undefined, 'ada@e.inc')).toBe('A');
  });

  it('treats an empty-string name as absent', () => {
    // Directory sync writes '' rather than null for a cleared field.
    expect(initialsFrom('', '', 'ada@e.inc')).toBe('A');
  });

  it('falls back to a question mark when even the email is empty', () => {
    /**
     * The last rung. Without it the avatar paints an empty circle, which reads as a
     * failed image load rather than as missing data.
     */
    expect(initialsFrom(null, null, '')).toBe('?');
  });

  it('handles a non-ASCII name', () => {
    expect(initialsFrom('Édouard', 'Ålund', 'e@e.inc')).toBe('ÉÅ');
  });
});

/**
 * The one-string variant, which is the shape a SESSION carries.
 *
 * It has two callers — the dashboard's identity band and `/profile`'s employment record —
 * and both draw their face above every error boundary from the session alone, so neither
 * has `firstName` / `lastName` to hand. Every case below is reachable from a real account:
 * Google SSO composes a display name from whatever the directory holds, a payroll import
 * can land one token, and a service account can arrive with an email and nothing else.
 */
describe('initialsFromDisplayName', () => {
  it('takes the first and last part of a composed name', () => {
    expect(initialsFromDisplayName('Ada Lovelace', 'ada@e.inc')).toBe('AL');
  });

  it('ignores the middle parts rather than growing past two letters', () => {
    expect(initialsFromDisplayName('Ada Byron King Lovelace', 'ada@e.inc')).toBe('AL');
  });

  it('gives one letter for a single token', () => {
    expect(initialsFromDisplayName('Ada', 'ada@e.inc')).toBe('A');
  });

  it('collapses runs of whitespace instead of counting them as parts', () => {
    // `token.name` is composed by concatenation, so a missing middle name can leave two
    // spaces behind — and an empty part would otherwise take the last slot and give "A".
    expect(initialsFromDisplayName('Ada   Lovelace', 'ada@e.inc')).toBe('AL');
    expect(initialsFromDisplayName('  Ada Lovelace  ', 'ada@e.inc')).toBe('AL');
  });

  it('falls back to the email for an account with no display name', () => {
    // `auth.ts` assigns `session.user.name = (token.name || '')`, so a nameless account
    // arrives as an empty string rather than as null.
    expect(initialsFromDisplayName('', 'ada@e.inc')).toBe('A');
  });

  it('is the identity map for CJK, where upper-casing does nothing', () => {
    expect(initialsFromDisplayName('\u967d\u83dc \u7530\u4e2d', 'hina@e.inc')).toBe('\u967d\u7530');
  });

  it('never returns nothing paintable', () => {
    // An empty avatar reads as a broken image, so the last rung is a literal question mark.
    expect(initialsFromDisplayName('', '')).toBe('?');
  });
});

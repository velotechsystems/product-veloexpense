import { describe, expect, it } from 'vitest';
import {
  type DirectoryCursor,
  decodeDirectoryCursor,
  encodeDirectoryCursor,
} from './directoryCursor';

/**
 * The Employee Directory pages alphabetically, which Prisma's own `cursor: { id }` cannot
 * express — it walks the index in id order. So the cursor carries the whole order key
 * (firstName, lastName, id) and the next page is "everything strictly greater than this
 * tuple".
 *
 * The cursor is opaque to the client and therefore arrives as untrusted text. Everything
 * below is about that: a cursor that decodes to something unusable has to come back as
 * `null` — meaning "start from the beginning" — rather than throw, because the alternative
 * is a directory that 500s on a stale bookmark.
 */

const C: DirectoryCursor = { firstName: 'Ada', lastName: 'Lovelace', id: 'u-1' };

describe('the directory cursor', () => {
  it('round-trips the whole order key', () => {
    expect(decodeDirectoryCursor(encodeDirectoryCursor(C))).toEqual(C);
  });

  it('round-trips the null halves of the key', () => {
    /** Both name columns are nullable and both sort NULLS LAST, so "no first name" is a
     *  position in the ordering and has to survive the trip. */
    const partial: DirectoryCursor = { firstName: null, lastName: null, id: 'u-2' };
    expect(decodeDirectoryCursor(encodeDirectoryCursor(partial))).toEqual(partial);
  });

  it('encodes url-safely, since it travels as a query parameter', () => {
    /** Plain base64 uses `+` and `/`; a `+` in a query string decodes to a space and the
     *  cursor comes back corrupt. */
    const token = encodeDirectoryCursor({
      firstName: 'Ægir Þór',
      lastName: 'Ólafsdóttir-Ø',
      id: 'u-3',
    });
    expect(token).not.toMatch(/[+/=]/);
    expect(decodeDirectoryCursor(token)?.firstName).toBe('Ægir Þór');
  });

  it('reads a name with characters base64 has to carry as bytes', () => {
    const c: DirectoryCursor = { firstName: '日本語', lastName: '👍', id: 'u-4' };
    expect(decodeDirectoryCursor(encodeDirectoryCursor(c))).toEqual(c);
  });

  it('starts over rather than throwing on a cursor that is not base64', () => {
    expect(decodeDirectoryCursor('!!!not-base64!!!')).toBeNull();
  });

  it('starts over on a cursor that decodes to something other than JSON', () => {
    expect(decodeDirectoryCursor(Buffer.from('hello', 'utf8').toString('base64url'))).toBeNull();
  });

  it('refuses a cursor with no id, which is the tie-breaker the ordering needs', () => {
    /** Without the id, two people with the same name make the page boundary ambiguous —
     *  one of them is skipped or served twice. */
    const token = Buffer.from(JSON.stringify({ firstName: 'Ada' }), 'utf8').toString('base64url');
    expect(decodeDirectoryCursor(token)).toBeNull();
  });

  it('refuses an id that is not a string', () => {
    const token = Buffer.from(JSON.stringify({ id: 42 }), 'utf8').toString('base64url');
    expect(decodeDirectoryCursor(token)).toBeNull();
  });

  it('refuses valid JSON that is not an object at all', () => {
    for (const value of ['null', '"u-1"', '[]', '7']) {
      const token = Buffer.from(value, 'utf8').toString('base64url');
      expect(decodeDirectoryCursor(token), value).toBeNull();
    }
  });
});

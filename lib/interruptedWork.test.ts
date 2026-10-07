import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberInterruptedWork, takeInterruptedWork, typedTextOf } from './interruptedWork';

/**
 * What a session expiry interrupted, kept across the re-authentication it forces.
 *
 * #329 taught `IdleTimeout` to drain in-flight writes before the CLIENT's own countdown signs
 * somebody out, which fixed the case where our timer fired first. The dominant case is the
 * other one: the server's Redis window lapses (routine — the heartbeat is throttled to one
 * call per 30s, and a click inside that window only moves the local deadline), the mutation
 * returns UNAUTHORIZED, and the client hard-navigates. The Approve click never landed and the
 * typed justification went with it, silently (GA readiness report F16 / blocker B7).
 *
 * The contract under test is DISCLOSE, NOT REPLAY — plus the storage rules that keep this from
 * becoming a place structured payloads accumulate.
 */

beforeEach(() => sessionStorage.clear());

describe('typedTextOf', () => {
  it('finds a person’s own words, whichever field carries them', () => {
    // The unrecoverable part. Everything else on a screen can be retyped from what is on it.
    expect(typedTextOf({ note: 'Client dinner, 4 attendees' })).toBe('Client dinner, 4 attendees');
    expect(typedTextOf({ justification: 'over per-diem' })).toBe('over per-diem');
    expect(typedTextOf({ explanation: 'x' })).toBe('x');
    expect(typedTextOf({ reason: 'y' })).toBe('y');
    expect(typedTextOf({ comment: 'z' })).toBe('z');
  });

  it('keeps NOTHING else', () => {
    /**
     * Deliberate: structured values are reconstructible from the screen, and stashing
     * arbitrary payloads in web storage would put amounts and record ids somewhere they do
     * not belong.
     */
    expect(typedTextOf({ taskId: 'abc', approve: true, amountMinor: '12345' })).toBeUndefined();
  });

  it('ignores whitespace-only text', () => {
    // Handing back "   " helps nobody and makes the notice look broken.
    expect(typedTextOf({ note: '   ' })).toBeUndefined();
  });

  it('survives a non-object payload', () => {
    expect(typedTextOf(null)).toBeUndefined();
    expect(typedTextOf('a string')).toBeUndefined();
    expect(typedTextOf(undefined)).toBeUndefined();
  });
});

describe('remember / take', () => {
  it('round-trips what was interrupted', () => {
    rememberInterruptedWork({ path: 'expenseApprovals.decide', typedText: 'no', url: '/en/x' });
    const got = takeInterruptedWork();
    expect(got).toMatchObject({ path: 'expenseApprovals.decide', typedText: 'no', url: '/en/x' });
  });

  it('is read ONCE — the message is not shown again on the next navigation', () => {
    rememberInterruptedWork({ path: 'a.b', url: '/en/x' });
    expect(takeInterruptedWork()).not.toBeNull();
    expect(takeInterruptedWork()).toBeNull();
  });

  it('discards a stale record rather than showing it days later', () => {
    vi.useFakeTimers();
    try {
      rememberInterruptedWork({ path: 'a.b', url: '/en/x' });
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(takeInterruptedWork()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only the most recent interruption', () => {
    rememberInterruptedWork({ path: 'first.call', url: '/en/x' });
    rememberInterruptedWork({ path: 'second.call', url: '/en/y' });
    expect(takeInterruptedWork()?.path).toBe('second.call');
  });

  it('returns null on a corrupt entry instead of throwing', () => {
    // Blocked storage, a half-written value, a schema change. A broken notice must not break
    // the page it renders on.
    sessionStorage.setItem('expenseos.interruptedWork', '{not json');
    expect(takeInterruptedWork()).toBeNull();
  });

  it('returns null on an entry missing its fields', () => {
    sessionStorage.setItem('expenseos.interruptedWork', JSON.stringify({ nope: true }));
    expect(takeInterruptedWork()).toBeNull();
  });

  it('never throws when storage itself is unavailable', () => {
    // Private mode, or a browser set to block site data. Losing the message is not worth
    // failing the redirect that is already happening.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(() => rememberInterruptedWork({ path: 'a.b', url: '/x' })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

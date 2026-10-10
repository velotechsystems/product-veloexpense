import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUuid, nextOpenNonce, useDeepLink } from './useDeepLink';

/**
 * The shared "open this thing" deep link, behind every notification click.
 *
 * Four surfaces hand-rolled this and all four had the same two faults, which
 * together produced one very confusing symptom: clicking a notification did
 * nothing, but only for the MOST RECENT one, and only until you reloaded.
 *
 *   · the once-only guard was the SUBJECT ID, so a second notification about the
 *     same subject was ignored for the life of the page — and the most recent
 *     notification is nearly always about the thing you just looked at;
 *   · the params were dropped with `history.replaceState`, which Next's router
 *     never learns about, so pushing the identical href again was not a
 *     navigation and no effect re-ran.
 *
 * The fix is a per-click nonce and a guard keyed on the pair. These tests pin
 * that a repeat of the same subject with a NEW nonce is a fresh instruction,
 * while a re-render carrying the same pair is not.
 */

const params = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
}));

function setUrl(search: string, path = '/en/virtual-cards/requests') {
  params.current = new URLSearchParams(search);
  window.history.replaceState(null, '', `${path}${search ? `?${search}` : ''}`);
}

beforeEach(() => {
  setUrl('');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeepLink', () => {
  it('reads the subject id and pairs it with the nonce', () => {
    setUrl('request=req-1&n=7');
    const { result } = renderHook(() => useDeepLink('request'));
    expect(result.current.id).toBe('req-1');
    expect(result.current.key).toBe('req-1:7');
  });

  it('has no id and no key when the link is absent', () => {
    const { result } = renderHook(() => useDeepLink('request'));
    expect(result.current.id).toBeNull();
    expect(result.current.key).toBeNull();
  });

  it('treats a repeat of the same subject with a new nonce as a fresh open', () => {
    // THE bug. Same request, second notification: this has to be actionable.
    setUrl('request=req-1&n=1');
    const { result, rerender } = renderHook(() => useDeepLink('request'));
    act(() => result.current.markSeen(result.current.key as string));
    expect(result.current.wasSeen(result.current.key)).toBe(true);

    setUrl('request=req-1&n=2');
    rerender();
    expect(result.current.id).toBe('req-1');
    expect(result.current.wasSeen(result.current.key)).toBe(false);
  });

  it('does not re-open on a plain re-render of the same click', () => {
    // The other half: a list refetch re-renders the page, and the deep-open must
    // not fire again and reopen a drawer the reader just closed.
    setUrl('request=req-1&n=1');
    const { result, rerender } = renderHook(() => useDeepLink('request'));
    act(() => result.current.markSeen(result.current.key as string));
    rerender();
    expect(result.current.wasSeen(result.current.key)).toBe(true);
  });

  it('keys on the id too, so a different subject is never mistaken for seen', () => {
    setUrl('request=req-1&n=1');
    const { result, rerender } = renderHook(() => useDeepLink('request'));
    act(() => result.current.markSeen(result.current.key as string));

    setUrl('request=req-2&n=1');
    rerender();
    expect(result.current.wasSeen(result.current.key)).toBe(false);
  });

  it('still works when the link carries no nonce at all', () => {
    // A hand-typed or bookmarked URL. It should open once and not loop.
    setUrl('request=req-1');
    const { result, rerender } = renderHook(() => useDeepLink('request'));
    expect(result.current.key).toBe('req-1:');
    act(() => result.current.markSeen(result.current.key as string));
    rerender();
    expect(result.current.wasSeen(result.current.key)).toBe(true);
  });

  it('clear() strips both params from the address bar without navigating', () => {
    setUrl('request=req-1&n=3&keep=yes');
    const { result } = renderHook(() => useDeepLink('request'));
    act(() => result.current.clear());
    const after = new URL(window.location.href);
    expect(after.searchParams.get('request')).toBeNull();
    expect(after.searchParams.get('n')).toBeNull();
    // Unrelated params are somebody else's state — leave them alone.
    expect(after.searchParams.get('keep')).toBe('yes');
  });

  it('reads the param it was asked for, not a fixed name', () => {
    setUrl('txn=t-9&n=1');
    const { result } = renderHook(() => useDeepLink('txn'));
    expect(result.current.id).toBe('t-9');
  });

  it('ignores a malformed id when the caller asked for a UUID', () => {
    /**
     * MUST-9. `?request=../../etc/passwd` is not a request id, and the honest reply
     * to a URL nobody meant to type is the page they asked for — so it reads as
     * ABSENT, not as an error. `key` goes null with it, which is what keeps the
     * deep-open effect from firing on a value nothing will ever match.
     */
    setUrl('request=%2E%2E%2F%2E%2E%2Fetc%2Fpasswd&n=1');
    const { result } = renderHook(() => useDeepLink('request', { uuid: true }));
    expect(result.current.id).toBeNull();
    expect(result.current.key).toBeNull();
  });

  it('accepts a UUIDv7, which is the shape every id in this product has', () => {
    setUrl('request=01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f&n=2');
    const { result } = renderHook(() => useDeepLink('request', { uuid: true }));
    expect(result.current.id).toBe('01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f');
  });

  it('leaves a non-UUID id alone when the caller did not ask', () => {
    // Two callers key on ids they do not own; opting them in is not this hook's call.
    setUrl('request=req-1&n=1');
    const { result } = renderHook(() => useDeepLink('request'));
    expect(result.current.id).toBe('req-1');
  });
});

describe('isUuid', () => {
  it('accepts every version this product mints and rejects the near misses', () => {
    expect(isUuid('01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f')).toBe(true);
    // Uppercase is the same id: RFC 4122 is case-insensitive on the hex.
    expect(isUuid('01924B1E-7C2A-7F3D-9C4E-5A6B7C8D9E0F')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    // Right length, wrong variant nibble — a string built to look like one.
    expect(isUuid('01924b1e-7c2a-7f3d-1c4e-5a6b7c8d9e0f')).toBe(false);
    // A trailing character is a different string, and `test` is not anchored by luck.
    expect(isUuid('01924b1e-7c2a-7f3d-9c4e-5a6b7c8d9e0f ')).toBe(false);
  });
});

describe('nextOpenNonce', () => {
  it('never repeats, so two clicks in the same millisecond are two instructions', () => {
    /** A counter rather than a timestamp, which is the whole reason it exists: a nonce
     *  that repeats is a nonce that does not work. */
    const seen = new Set(Array.from({ length: 5 }, () => nextOpenNonce()));
    expect(seen.size).toBe(5);
  });
});

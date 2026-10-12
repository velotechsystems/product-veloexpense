// VeloExpense: ExpenseOS's `apps/web/src/server/lib/rateLimit.test.ts` (550b2945), Wave 3 (w3-06), unchanged.
import { cacheNamespace } from '@expenseos/db';
import { describe, expect, it, vi } from 'vitest';
import { type Counter, clientIp, clientUserAgent, ipFromHeaders, throttle } from './rateLimit';

const headers = vi.fn(async (): Promise<Headers> => new Headers());
vi.mock('next/headers', () => ({ headers: () => headers() }));

/**
 * The database scope every Redis key carries.
 *
 * Built from `cacheNamespace()` rather than written out, so these assertions stay EXACT
 * without restating a value derived from `DATABASE_URL` — and so they keep checking the
 * key SHAPE rather than being loosened to a `toContain`.
 */
const NS = cacheNamespace();

/**
 * The auth throttle had no tests before this: the only way to exercise it was a live Redis.
 * It guards password, TOTP and passkey verification, so that gap mattered more than the
 * API-key limiter that prompted the refactor.
 */
function fakeCounter(ttl = 60): Counter & { keys: Map<string, number>; expires: string[] } {
  const keys = new Map<string, number>();
  const expires: string[] = [];
  return {
    keys,
    expires,
    async incr(key) {
      const next = (keys.get(key) ?? 0) + 1;
      keys.set(key, next);
      return next;
    },
    async expire(key) {
      expires.push(key);
      return 1;
    },
    async ttl() {
      return ttl;
    },
  };
}

const CFG = { max: 2, windowSec: 60 };

describe('throttle', () => {
  it('admits attempts up to max and refuses the next', async () => {
    const c = fakeCounter();
    expect((await throttle('k', CFG, c)).allowed).toBe(true);
    expect((await throttle('k', CFG, c)).allowed).toBe(true);
    expect((await throttle('k', CFG, c)).allowed).toBe(false);
  });

  it('counts before deciding, which is what makes it correct under concurrency', async () => {
    // Checking first and incrementing after lets two simultaneous attempts both see
    // `max - 1` and both proceed.
    const c = fakeCounter();
    const results = await Promise.all([
      throttle('k', { max: 1, windowSec: 60 }, c),
      throttle('k', { max: 1, windowSec: 60 }, c),
    ]);
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
  });

  it('sets the expiry once, on the first attempt of a window', async () => {
    const c = fakeCounter();
    await throttle('k', CFG, c);
    await throttle('k', CFG, c);
    expect(c.expires).toEqual([`ratelimit:${NS}:k`]);
  });

  it('reports retry-after from the key TTL, not from a guess', async () => {
    const c = fakeCounter(37);
    await throttle('k', { max: 1, windowSec: 60 }, c);
    expect((await throttle('k', { max: 1, windowSec: 60 }, c)).retryAfterSec).toBe(37);
  });

  it('falls back to the window when the TTL is unavailable', async () => {
    const c = { ...fakeCounter(), ttl: async () => -1 };
    await throttle('k', { max: 1, windowSec: 90 }, c);
    expect((await throttle('k', { max: 1, windowSec: 90 }, c)).retryAfterSec).toBe(90);
  });

  it('keeps separate counters per key', async () => {
    const c = fakeCounter();
    await throttle('a', { max: 1, windowSec: 60 }, c);
    expect((await throttle('b', { max: 1, windowSec: 60 }, c)).allowed).toBe(true);
  });

  it('fails OPEN when the counter is unreachable', async () => {
    // Auth must not hard-break because the limiter is down.
    const broken: Counter = {
      async incr() {
        throw new Error('redis is down');
      },
      async expire() {
        return 1;
      },
      async ttl() {
        return -1;
      },
    };
    expect((await throttle('k', CFG, broken)).allowed).toBe(true);
  });
});

describe('ipFromHeaders', () => {
  it('takes the first forwarded hop', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' });
    expect(ipFromHeaders(h)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip', () => {
    expect(ipFromHeaders(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('returns the literal "unknown" rather than null', () => {
    // So callers never decide what a missing address means, and a coalescing key never
    // contains a NULL.
    expect(ipFromHeaders(new Headers())).toBe('unknown');
    expect(ipFromHeaders(new Headers({ 'x-forwarded-for': '  ' }))).toBe('unknown');
  });
});

describe('clientIp / clientUserAgent', () => {
  it('reads the request headers when inside a request scope', async () => {
    headers.mockResolvedValue(
      new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'UA/1.0' }),
    );
    await expect(clientIp()).resolves.toBe('203.0.113.9');
    await expect(clientUserAgent()).resolves.toBe('UA/1.0');
  });

  it('degrades to the sentinels when there is no request scope', async () => {
    // Outside a request (a worker, a test) `headers()` throws; an audit row's forensic
    // columns must still be writable.
    headers.mockRejectedValue(new Error('outside request scope'));
    await expect(clientIp()).resolves.toBe('unknown');
    await expect(clientUserAgent()).resolves.toBeUndefined();
  });

  it('treats an empty user-agent as absent', async () => {
    headers.mockResolvedValue(new Headers({ 'user-agent': '' }));
    await expect(clientUserAgent()).resolves.toBeUndefined();
  });
});

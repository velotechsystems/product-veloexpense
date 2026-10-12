// @vitest-environment node
// VeloExpense: ExpenseOS's `apps/web/src/server/lib/inboundDedup.test.ts` (550b2945), Wave 3 (w3-06), unchanged.

import { cacheNamespace } from '@expenseos/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The database scope every Redis key carries.
 *
 * Built from `cacheNamespace()` rather than written out, so these assertions stay EXACT
 * without restating a value derived from `DATABASE_URL` — and so they keep checking the
 * key SHAPE rather than being loosened to a `toContain`.
 */
const NS = cacheNamespace();

/**
 * SNS delivers at-least-once, so this endpoint WILL be handed the same notification twice
 * — a slow handler or a dropped connection before the 200 is all it takes. Without a claim,
 * a redelivered reply becomes a second COMMENT activity and a second fan-out to everybody
 * on the thread.
 *
 * The claim FAILS OPEN, and that is the decision worth pinning: on a Redis error the
 * message is processed. A rare duplicate comment is visible and correctable; a legitimate
 * reply dropped because a cache blinked is silent and is not.
 */

const store = new Map<string, string>();
const set = vi.fn(async (key: string, ...rest: unknown[]) => {
  // `NX` — the whole point: the first caller wins, and every later one is told so.
  if (rest.includes('NX') && store.has(key)) return null;
  store.set(key, '1');
  return 'OK';
});
const del = vi.fn(async (key: string) => (store.delete(key) ? 1 : 0));

vi.mock('ioredis', () => ({
  Redis: class {
    set = set;
    del = del;
  },
}));

let claimOnce: (id: string | undefined) => Promise<boolean>;
let releaseClaim: (id: string | undefined) => Promise<void>;

beforeEach(async () => {
  store.clear();
  set.mockClear();
  del.mockClear();
  process.env.REDIS_URL = 'redis://localhost:6379';
  // Fresh module each time: the connection is a module-level singleton, and so is the
  // `globalThis` handle it parks itself on in development.
  vi.resetModules();
  (globalThis as { inboundDedupRedis?: unknown }).inboundDedupRedis = undefined;
  ({ claimOnce, releaseClaim } = await import('./inboundDedup'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('claiming a message', () => {
  it('admits the first delivery', async () => {
    await expect(claimOnce('m-1')).resolves.toBe(true);
  });

  it('refuses the redelivery', async () => {
    await claimOnce('m-1');
    await expect(claimOnce('m-1')).resolves.toBe(false);
  });

  it('keeps different messages apart', async () => {
    await expect(claimOnce('m-1')).resolves.toBe(true);
    await expect(claimOnce('m-2')).resolves.toBe(true);
  });

  it('holds the marker well past the redelivery window', async () => {
    /** SNS retries over minutes; a marker that expired inside that window would let the
     *  duplicate through, which is the whole failure this prevents. */
    await claimOnce('m-1');
    const [key, value, unit, ttl, mode] = set.mock.calls[0] as [
      string,
      string,
      string,
      number,
      string,
    ];
    expect(key).toBe(`inbound:seen:${NS}:m-1`);
    expect(value).toBe('1');
    expect(unit).toBe('EX');
    expect(ttl).toBe(24 * 60 * 60);
    expect(mode).toBe('NX');
  });

  it('processes a message that arrived without an id', async () => {
    /** Nothing to key on, so there is nothing to dedupe against — and refusing would drop
     *  a real reply. */
    await expect(claimOnce(undefined)).resolves.toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('processes anyway when Redis is unreachable', async () => {
    set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(claimOnce('m-1')).resolves.toBe(true);
    // Logged, because a duplicate that follows needs an explanation.
    expect(warn).toHaveBeenCalled();
  });
});

describe('releasing a claim', () => {
  it('lets a retry through after the processing failed', async () => {
    /** Without this, a handler that threw after claiming would have deduped its own
     *  retry away — the reply lost for good on a transient fault. */
    await claimOnce('m-1');
    await releaseClaim('m-1');
    await expect(claimOnce('m-1')).resolves.toBe(true);
  });

  it('does nothing for a message with no id', async () => {
    await releaseClaim(undefined);
    expect(del).not.toHaveBeenCalled();
  });

  it('is best-effort: a Redis error is not the caller’s problem', async () => {
    /** The processing already failed; failing the release on top would replace one error
     *  with a less useful one. */
    del.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(releaseClaim('m-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

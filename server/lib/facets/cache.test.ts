// @vitest-environment node

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
 * The facet-count cache.
 *
 * It has its own Redis connection, separate from the RBAC cache and the BullMQ pool, so
 * a slow facet computation cannot head-of-line block an authn-critical RBAC read. The
 * connection is built on first USE rather than at import, so `next build`'s page-data
 * collection does not open a socket.
 *
 * Two behaviours are load-bearing:
 *
 *   · **A corrupt or wrong-shaped entry recomputes.** Facet counts drive filter pills; a
 *     parse error propagating would take out the list page rather than one dropdown.
 *   · **Failures are not cached.** The fetcher's error propagates and nothing is written,
 *     so a transient timeout does not pin "no counts" into Redis for the whole TTL.
 *
 * Invalidation uses SCAN rather than KEYS, because it runs after ordinary admin
 * mutations and must not block Redis on a large keyspace.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  scanBatches: [] as string[][],
  scanArgs: null as unknown,
  constructed: 0,
}));

vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      h.constructed += 1;
    }
    get = (k: string) => h.get(k);
    setex = (k: string, ttl: number, v: string) => h.setex(k, ttl, v);
    del = (...keys: string[]) => h.del(...keys);
    scanStream = (args: unknown) => {
      h.scanArgs = args;
      const batches = h.scanBatches;
      return {
        async *[Symbol.asyncIterator]() {
          for (const b of batches) yield b;
        },
      };
    };
  },
}));

import {
  buildCacheKey,
  getFacetsRedis,
  getOrSetFacetEntry,
  hashFilterPayload,
  invalidateResourceFacets,
} from './cache';

const entry = (values: Array<{ value: string; count: number }> = [{ value: 'CAD', count: 3 }]) => ({
  scoped: true,
  values,
});

beforeEach(() => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  h.get = vi.fn().mockResolvedValue(null);
  h.setex = vi.fn().mockResolvedValue('OK');
  h.del = vi.fn().mockResolvedValue(1);
  h.scanBatches = [];
  h.scanArgs = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('the cache key', () => {
  it('carries the resource, the scope and the field', () => {
    /**
     * The scope is in the key because two readers see different counts: an admin's
     * "Department" facet is not a manager's, and sharing a key would show one the
     * other's totals.
     */
    expect(
      buildCacheKey({
        resource: 'people',
        scopeBucket: 'u-1',
        field: 'department',
        filterHash: 'abc123',
      }),
    ).toBe(`facets:${NS}:people:u-1:department:abc123`);
  });

  it('separates a global scope from a per-user one', () => {
    const admin = buildCacheKey({
      resource: 'people',
      scopeBucket: 'all',
      field: 'status',
      filterHash: 'h',
    });
    const mine = buildCacheKey({
      resource: 'people',
      scopeBucket: 'u-1',
      field: 'status',
      filterHash: 'h',
    });
    expect(admin).not.toBe(mine);
  });

  it('hashes the filters to a short, stable piece', () => {
    /**
     * The filters are the rest of the query, and a key that grew with them would be
     * unbounded — the hash keeps the key short while still varying with the question.
     */
    const a = hashFilterPayload({ status: ['ACTIVE'], dept: ['eng'] });
    expect(a).toHaveLength(16);
    expect(hashFilterPayload({ status: ['ACTIVE'], dept: ['eng'] })).toBe(a);
  });

  it('gives different filters different hashes', () => {
    expect(hashFilterPayload({ status: ['ACTIVE'] })).not.toBe(
      hashFilterPayload({ status: ['DEACTIVATED'] }),
    );
  });

  it('hashes an empty filter set to something stable too', () => {
    expect(hashFilterPayload({})).toBe(hashFilterPayload({}));
  });
});

describe('reading through', () => {
  it('returns a cached entry without computing', async () => {
    const fetch = vi.fn();
    h.get = vi.fn().mockResolvedValue(JSON.stringify(entry()));
    await expect(getOrSetFacetEntry('k', 60, fetch)).resolves.toEqual(entry());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('computes on a miss and stores the result with its TTL', async () => {
    /**
     * The TTL is per call, not global, so a cheap resource can hold counts longer than
     * an expensive one without a shared compromise.
     */
    const fetch = vi.fn().mockResolvedValue(entry());
    await getOrSetFacetEntry('k', 120, fetch);
    expect(h.setex).toHaveBeenCalledWith('k', 120, JSON.stringify(entry()));
  });

  it('recomputes from a corrupt entry rather than throwing', async () => {
    /**
     * These counts drive the filter pills. A parse error propagating would take out the
     * whole list page instead of one dropdown.
     */
    const fetch = vi.fn().mockResolvedValue(entry());
    h.get = vi.fn().mockResolvedValue('{not json');
    await expect(getOrSetFacetEntry('k', 60, fetch)).resolves.toEqual(entry());
    expect(fetch).toHaveBeenCalled();
  });

  it('recomputes from an entry of the wrong shape', async () => {
    // An older encoding, or a key collision with another writer.
    const fetch = vi.fn().mockResolvedValue(entry());
    h.get = vi.fn().mockResolvedValue(JSON.stringify({ scoped: true }));
    await expect(getOrSetFacetEntry('k', 60, fetch)).resolves.toEqual(entry());
    expect(fetch).toHaveBeenCalled();
  });

  it('recomputes when the entry is JSON but not an object', async () => {
    const fetch = vi.fn().mockResolvedValue(entry());
    h.get = vi.fn().mockResolvedValue('null');
    await expect(getOrSetFacetEntry('k', 60, fetch)).resolves.toEqual(entry());
  });

  it('keeps an unscoped fallback as unscoped', async () => {
    /**
     * `scoped: false` means the counts are global rather than filtered — a degrade the
     * consumer has to know about, so it survives the round trip.
     */
    const fallback = { scoped: false, values: [{ value: 'CAD', count: 99 }] };
    h.get = vi.fn().mockResolvedValue(JSON.stringify(fallback));
    await expect(getOrSetFacetEntry('k', 60, vi.fn())).resolves.toEqual(fallback);
  });

  it('caches an empty result, which is a real answer', async () => {
    // "No values match" is worth remembering; recomputing it every time is the waste.
    const fetch = vi.fn().mockResolvedValue(entry([]));
    await getOrSetFacetEntry('k', 60, fetch);
    expect(h.setex).toHaveBeenCalled();
  });

  it('does not cache a failure', async () => {
    /**
     * No negative caching: a transient query timeout must not pin "no counts" into
     * Redis for the whole TTL.
     */
    const fetch = vi.fn().mockRejectedValue(new Error('query timeout'));
    await expect(getOrSetFacetEntry('k', 60, fetch)).rejects.toThrow('query timeout');
    expect(h.setex).not.toHaveBeenCalled();
  });
});

describe('invalidation', () => {
  it('scans rather than listing every key', async () => {
    /**
     * It runs after ordinary admin mutations — deactivating a user, changing a status —
     * so it must not block Redis while it works.
     */
    h.scanBatches = [[`facets:${NS}:people:all:status:a`]];
    await invalidateResourceFacets('people');
    expect(h.scanArgs).toMatchObject({ match: `facets:${NS}:people:*` });
  });

  it('deletes every key it found, in one call', async () => {
    h.scanBatches = [[`facets:${NS}:people:all:status:a`], [`facets:${NS}:people:u-1:dept:b`]];
    await invalidateResourceFacets('people');
    expect(h.del).toHaveBeenCalledWith(
      `facets:${NS}:people:all:status:a`,
      `facets:${NS}:people:u-1:dept:b`,
    );
  });

  it('does nothing when there is nothing cached', async () => {
    // `del()` with no arguments is an error in Redis, not a no-op.
    await invalidateResourceFacets('people');
    expect(h.del).not.toHaveBeenCalled();
  });

  it('touches only the resource it was asked about', async () => {
    // Clearing every facet in the system on one user edit would defeat the cache.
    h.scanBatches = [[]];
    await invalidateResourceFacets('expenses');
    expect(h.scanArgs).toMatchObject({ match: `facets:${NS}:expenses:*` });
  });
});

describe('the connection', () => {
  it('is built once and reused', async () => {
    /**
     * Lazily, on first use rather than at import: `next build` collects page data by
     * importing modules, and a connection at import time would open a socket during
     * the build.
     */
    const before = h.constructed;
    const a = getFacetsRedis();
    const b = getFacetsRedis();
    expect(a).toBe(b);
    expect(h.constructed - before).toBeLessThanOrEqual(1);
  });

  it('refuses to guess a Redis URL', async () => {
    /**
     * Defaulting to localhost would make a misconfigured deployment look like it was
     * working: an empty cache, no counts, and nothing in the logs.
     */
    vi.resetModules();
    delete process.env.REDIS_URL;
    // The connection is memoised per module AND parked on globalThis outside
    // production (so dev's module reloads do not leak sockets) — both have to go for
    // a fresh module to actually reach the env read.
    delete (globalThis as { facetsRedis?: unknown }).facetsRedis;
    const fresh = await import('./cache');
    expect(() => fresh.getFacetsRedis()).toThrow(/REDIS_URL/);
  });
});

describe('VeloExpense: with no Redis configured', () => {
  it('computes the counts and opens no connection', async () => {
    /** CI and local development run without Redis; the directory must still count. */
    delete process.env.REDIS_URL;
    const before = h.constructed;
    const fetch = vi.fn(async () => entry());
    await expect(getOrSetFacetEntry('k', 60, fetch)).resolves.toEqual(entry());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.setex).not.toHaveBeenCalled();
    expect(h.constructed).toBe(before);
  });
});

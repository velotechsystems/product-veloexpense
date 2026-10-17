import crypto from 'node:crypto';
import { cacheNamespace } from '@expenseos/db';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Redis-backed facet-count cache. Separate ioredis connection from
 * the RBAC cache and the BullMQ pool so misses on facet computations
 * don't head-of-line block authn-critical RBAC reads.
 *
 * Each cached entry is `{ scoped: boolean; values: Array<{value, count}> }`
 * JSON, keyed by `facets:{resource}:{scopeBucket}:{field}:{filterHash}`.
 * The TTL is set per `setex` call so different resources can pick
 * different staleness budgets at their callsites.
 *
 * Ported from ExpenseOS `server/lib/facets/cache.ts` (1e682dd6), People 1. VeloExpense:
 *   · ONE CACHE, MANY TENANTS. ExpenseOS's database is one customer's, so its `all` scope
 *     bucket is shared by every admin safely. Here the same Redis serves every tenant, so the
 *     CALLER puts the organization into `scopeBucket` (users.ts `facetCounts`) — without it,
 *     one tenant's admin would read another tenant's department counts.
 *   · NO REDIS, NO CACHE. CI and local development have no Redis (dev and production do:
 *     the web task gets REDIS_URL, compute-stack.ts), so with REDIS_URL unset
 *     `getOrSetFacetEntry` computes every time instead of throwing. Counts are the same;
 *     only the five-minute reuse is lost.
 */

const KEY_PREFIX = 'facets:';

const globalForCache = globalThis as unknown as { facetsRedis?: Redis };

function readUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return url;
}

function createConnection(): Redis {
  const opts: RedisOptions = {
    enableReadyCheck: true,
    lazyConnect: false,
  };
  return new Redis(readUrl(), opts);
}

let _facetsRedis: Redis | undefined;

/**
 * Lazily-constructed facet-cache Redis connection. Opened on first call,
 * NOT at import time — so `next build` page-data collection doesn't connect.
 */
export function getFacetsRedis(): Redis {
  _facetsRedis ??= globalForCache.facetsRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForCache.facetsRedis = _facetsRedis;
  }
  return _facetsRedis;
}

/** Cached value shape. `scoped` tells the consumer whether the
 *  counts reflect the current filters (true) or are a global
 *  fallback (false, e.g. timeout or table-too-large degrade). */
export interface CachedFacetEntry {
  scoped: boolean;
  values: Array<{ value: string; count: number }>;
}

/** Build a stable, short hash for the "filters minus self field"
 *  payload. SHA-1 sliced to 16 hex chars — not cryptographic,
 *  just a collision-resistant cache key piece. */
export function hashFilterPayload(payload: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/** Compose the cache key. `scopeBucket` typically encodes the
 *  resolved scope (e.g. 'all' for admin global, or the user id
 *  for "my team" / "my reports"). */
export function buildCacheKey(opts: {
  resource: string;
  scopeBucket: string;
  field: string;
  filterHash: string;
}): string {
  // Scoped to the DATABASE: what is cached here are VALUES read out of it, and the
  // resource/field/filter triple is identical across databases holding different rows.
  return `${KEY_PREFIX}${cacheNamespace()}:${opts.resource}:${opts.scopeBucket}:${opts.field}:${opts.filterHash}`;
}

/** Read-through cache. Computes via `fetch()` on miss and writes
 *  the result with the given TTL. Errors from the fetcher
 *  propagate (no negative caching). */
export async function getOrSetFacetEntry(
  key: string,
  ttlSec: number,
  fetch: () => Promise<CachedFacetEntry>,
): Promise<CachedFacetEntry> {
  // VeloExpense: no Redis configured (CI, local) — compute, cache nothing (see the header).
  if (!process.env.REDIS_URL) return fetch();
  const cached = await getFacetsRedis().get(key);
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.values)) {
        return parsed as CachedFacetEntry;
      }
    } catch {
      // Corrupted entry — fall through and recompute.
    }
  }
  const fresh = await fetch();
  await getFacetsRedis().setex(key, ttlSec, JSON.stringify(fresh));
  return fresh;
}

/** Invalidate every cached entry for a resource. Call after any
 *  mutation that could change counts (admin user-deactivate,
 *  status change, etc.). Cheap when there are few entries; uses
 *  SCAN so it doesn't block on large key sets. */
export async function invalidateResourceFacets(resource: string): Promise<void> {
  const redis = getFacetsRedis();
  const stream = redis.scanStream({
    match: `${KEY_PREFIX}${cacheNamespace()}:${resource}:*`,
    count: 200,
  });
  const keys: string[] = [];
  for await (const batch of stream) {
    for (const k of batch as string[]) keys.push(k);
  }
  if (keys.length > 0) await redis.del(...keys);
}

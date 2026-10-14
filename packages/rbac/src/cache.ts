import { cacheNamespace } from '@expenseos/db';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Redis-backed permission cache. Separate ioredis connection from the
 * BullMQ pool (`@expenseos/jobs`'s `jobsConnection`) so cache reads
 * aren't blocked behind the long-running BRPOPLPUSH calls BullMQ uses.
 * Same Redis instance, default DB (BullMQ uses /1 via BULLMQ_REDIS_URL).
 *
 * Keys are scoped by {@link cacheNamespace} — the database, not the deployment. Two
 * databases sharing one Redis is the normal local setup (dev, test, e2e), and role ids are
 * seeded identically in all three.
 *
 * TTL is intentionally short (5 minutes) so that admin role edits
 * propagate even if the explicit invalidation hook is missed. Admin
 * writes SHOULD still call invalidateRolePermissions() — the TTL is
 * the safety net, not the contract.
 *
 * ## What a Redis failure does, and why the two halves differ
 *
 * **Reading is fail-soft.** This is a CACHE in front of one indexed row in Postgres,
 * and `fetcher` reads that row. So an unreachable Redis is a cache miss: the answer
 * comes from the authoritative source instead, which is exactly what a miss already
 * does. There is no authorization decision in that fallback — the database says the
 * same thing it would have said had the entry been absent. Previously the read was
 * unguarded, so a Redis blip threw out of `resolveRbacUser` and failed EVERY request
 * in the tenant, `/health` included; a cache is not permitted to be a hard dependency
 * of the thing it is caching. Every comparable module here already fails open
 * explicitly (`rateLimit`, `idleSession`, `inboundDedup`, `anthropicConfig`).
 *
 * **Invalidating is fail-loud, and stays that way.** A failed DEL is the opposite kind
 * of event: the stale entry survives and keeps authorizing for up to the TTL, so a
 * revocation an admin believes they made has not happened yet. That cannot be
 * swallowed quietly — see the note on {@link invalidateRolePermissions}.
 *
 * The asymmetry is the point. Failing soft on the read costs one extra point-read per
 * request while Redis is down; failing soft on the write costs correctness of a
 * revocation.
 *
 * VeloExpense (w4-10a, d73), each marked below:
 *   · KEYED BY ORGANIZATION. Every tenant's system roles carry ExpenseOS's fixed ids, so a
 *     role id alone names six different rows in a thousand tenants — one tenant's edited
 *     "Employee" would otherwise answer for every other's. The organization is part of every
 *     key, read and written, and of every invalidation.
 *   · NO REDIS, NO CACHE. Where `REDIS_URL` is not set (CI, a developer's machine) there is
 *     no cache at all: every request reads the row, and there is nothing to invalidate. That
 *     is not an outage, so it is not logged. Deployed, the web task always has `REDIS_URL`
 *     (the cache stack's secret), and the behaviour is ExpenseOS's.
 */

const TTL_SECONDS = 5 * 60;
const KEY_PREFIX = 'rbac:role:';

const globalForCache = globalThis as unknown as { rbacRedis?: Redis };

/** VeloExpense: whether this process has a cache at all — see the header. */
function cacheConfigured(): boolean {
  return Boolean(_rbacRedis ?? globalForCache.rbacRedis ?? process.env.REDIS_URL);
}

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

let _rbacRedis: Redis | undefined;

/**
 * Lazily-constructed RBAC Redis connection. The socket is opened on the
 * first call, NOT at import time — so `next build`'s page-data collection
 * doesn't try to connect to Redis.
 */
export function getRbacRedis(): Redis {
  _rbacRedis ??= globalForCache.rbacRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForCache.rbacRedis = _rbacRedis;
  }
  return _rbacRedis;
}

/**
 * Scoped to the DATABASE, because a role id is not unique across databases.
 *
 * The seed authors deterministic ids — `System Administrator` is
 * `019e3000-0000-7000-8000-000000000001` everywhere — so an unscoped key let the test
 * database's permission set answer for the e2e database's, and vice versa. That is a
 * cache handing out the wrong PERMISSIONS, which is the most consequential thing in this
 * package to get wrong. See `cacheNamespace` for the incident.
 */
function key(organizationId: string, roleId: string): string {
  // VeloExpense: and to the ORGANIZATION, because a role id is not unique across tenants
  // either — see the header.
  return `${KEY_PREFIX}${cacheNamespace()}:${organizationId}:${roleId}`;
}

/**
 * Get permissions for a role, populating the cache on miss via
 * `fetcher`. `fetcher` is the only DB-aware piece — the cache itself
 * is Prisma-agnostic.
 */
export async function getRolePermissions(
  organizationId: string,
  roleId: string,
  fetcher: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  const k = key(organizationId, roleId);
  const cached = await readEntry(k);
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // Corrupted entry — fall through to refetch.
    }
  }
  // NOT guarded: a `fetcher` failure is the database being unreachable, and the honest
  // answer to "what may this person do" is then "I do not know". Returning `[]` would
  // read as "nothing", which looks like a permissions bug to everyone downstream and
  // hides the outage.
  const fresh = await fetcher();
  await writeEntry(k, JSON.stringify(fresh));
  return fresh;
}

/** The cached entry, or null for a miss — including the miss an unreachable Redis is. */
async function readEntry(k: string): Promise<string | null> {
  if (!cacheConfigured()) return null; // VeloExpense: no cache here — see the header.
  try {
    return await getRbacRedis().get(k);
  } catch (e) {
    console.error('[rbac] cache read failed; resolving from the database', e);
    return null;
  }
}

/**
 * Populate the entry, best-effort.
 *
 * The permissions are already in hand and already correct by the time this runs, so a
 * write failure must not fail the request — it costs the next request a point-read, and
 * nothing else. Failing here would discard a correct answer over a cache miss.
 */
async function writeEntry(k: string, value: string): Promise<void> {
  if (!cacheConfigured()) return; // VeloExpense: no cache here — see the header.
  try {
    await getRbacRedis().setex(k, TTL_SECONDS, value);
  } catch (e) {
    console.error('[rbac] cache write failed; the next request will re-resolve', e);
  }
}

/**
 * Invalidate a single role's cached permissions. MUST be called from
 * any handler that mutates Role.permissions for that role.
 *
 * **Rejects on failure, deliberately, and a caller must not swallow it silently.** The
 * read path above treats an unreachable Redis as a miss because the database is right
 * there; this path has no such fallback. A DEL that did not happen leaves an entry that
 * keeps authorizing the OLD permission set for up to {@link TTL_SECONDS} — so a
 * revocation, a narrowing, or a deactivation the admin has been told succeeded is not in
 * force yet. That is a security-relevant delay and it has to be visible to somebody.
 */
export async function invalidateRolePermissions(organizationId: string, roleId: string): Promise<void> {
  // VeloExpense: with no cache there is no stale entry to remove — see the header.
  if (!cacheConfigured()) return;
  await getRbacRedis().del(key(organizationId, roleId));
}

/**
 * Invalidate every cached role. Useful for global RBAC operations
 * (e.g., re-syncing system roles after a code-side permission addition).
 */
export async function invalidateAllRoles(): Promise<void> {
  if (!cacheConfigured()) return; // VeloExpense: no cache here — see the header.
  const redis = getRbacRedis();
  // Scoped to this database. `${KEY_PREFIX}*` matched every database sharing the Redis
  // instance, so one environment's global invalidation silently wiped the others'.
  const stream = redis.scanStream({ match: `${KEY_PREFIX}${cacheNamespace()}:*`, count: 100 });
  const keys: string[] = [];
  for await (const batch of stream) {
    for (const k of batch as string[]) keys.push(k);
  }
  if (keys.length > 0) await redis.del(...keys);
}

import { createHash } from 'node:crypto';

/**
 * A token identifying WHICH DATABASE a cached value describes.
 *
 * ## The bug this exists to prevent
 *
 * Every Redis key in this repo used to be global. Meanwhile the seed authors
 * DETERMINISTIC ids — `System Administrator` is `019e3000-0000-7000-8000-000000000001`
 * in every database, because a fixed id is what lets server code and tests FK against a
 * system-managed row. Put those two facts together with one Redis instance shared by the
 * dev database, the unit/db test database and the e2e database, and the cache keys
 * collide across databases that hold DIFFERENT data.
 *
 * That is not hypothetical. `expenseos_test` grants that role 108 permissions and
 * `expenseos_e2e` grants it 111. Running the db suite while the browser suite was running
 * wrote the 108-permission set under `rbac:role:019e3000-…-001`, the e2e server read it,
 * and the three missing permissions included `admin.role.list` — so `/admin/roles` called
 * `notFound()` and the admin permissions spec failed with a 404. About twenty specs failed
 * that way, across tax, notifications, cards and travel, every one of them looking like a
 * product bug in the area it happened to land in.
 *
 * The SCAN-and-delete paths made it worse in the other direction: `invalidateAllRoles`
 * matched `rbac:role:*`, so a global invalidation in one database silently wiped every
 * other database's cache too.
 *
 * ## Why derived rather than configured
 *
 * An env var would work and would be forgotten. The failure mode here is silent, remote
 * from its cause, and reads as a bug in whatever feature the poisoned entry happened to
 * break — the worst combination for something a person has to remember to set. Deriving it
 * from `DATABASE_URL` means a process cannot be pointed at a different database without
 * its cache namespace following, because they are the same fact.
 *
 * The web app and the worker in one environment read the same `DATABASE_URL`, so they
 * derive the same namespace and share the cache, which is what should happen.
 *
 * ## What goes into it
 *
 * Host, port and database name — NOT the credentials. Hashing the whole URL would mean a
 * routine password rotation silently dumped every cache in the deployment, which is a
 * needless thundering herd for a value that has not changed.
 *
 * The readable database name is kept alongside the hash because the alternative is
 * debugging `rbac:role:a1b2c3d4:…` in `redis-cli` and having no idea which environment it
 * belongs to. A database name is not a secret.
 *
 * VeloExpense: ExpenseOS's `packages/db/src/cacheNamespace.ts` (550b2945), Wave 3 (w3-06),
 * unchanged — for the inbound-mail dedup claim and throttle, the first Redis keys outside
 * BullMQ here.
 */

/** Memoized against the URL it was derived from, so a test that changes the environment
 *  gets a fresh answer instead of the first one forever. */
let memo: { url: string; ns: string } | null = null;

export function cacheNamespace(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (memo?.url === url) return memo.ns;
  const ns = derive(url);
  memo = { url, ns };
  return ns;
}

function derive(url: string): string {
  // No DATABASE_URL is no database identity to confuse. Such a process shares one
  // namespace with every other of its kind, which is the pre-existing behaviour and the
  // only honest answer — there is nothing to distinguish it BY.
  if (!url) return 'nodb';

  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '');
    const identity = `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
    return `${label(database)}.${hash(identity)}`;
  } catch {
    // An unparseable URL still has to yield a STABLE namespace rather than throwing —
    // a cache helper may not be the thing that takes an app down. Hash it whole; the
    // credentials concern above does not apply to a string we could not parse.
    return `unknown.${hash(url)}`;
  }
}

/** The database name, reduced to something safe to read back out of a Redis key. */
function label(database: string): string {
  const safe = database.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return safe.slice(0, 32) || 'unnamed';
}

function hash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

import { cacheNamespace } from '@expenseos/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The database scope every Redis key carries.
 *
 * Built from `cacheNamespace()` rather than written out, so these assertions stay EXACT
 * without restating a value derived from `DATABASE_URL` — and so they keep checking the
 * key SHAPE rather than being loosened to a `toContain`.
 */
const NS = cacheNamespace();

/**
 * The permission cache, which had no tests despite deciding what every request is
 * allowed to do.
 *
 * It sits in front of the only authoritative permission lookup in the product. Three
 * distinct ways it can be wrong, none of which fail loudly:
 *
 *   · a hit that returns something that isn't a permission list → the request is
 *     evaluated against garbage;
 *   · an invalidation that writes the wrong key → a revoked role keeps working for
 *     five minutes, and a *narrowed* role keeps its old breadth;
 *   · a TTL that drifts upward → the documented safety net for a missed invalidation
 *     stops being a safety net.
 *
 * All three are silent in production and none is visible in a UI. So they are pinned
 * here against a fake Redis: the cache is deliberately Prisma-agnostic, which makes
 * it testable without a database.
 */

/** Minimum ioredis surface this module uses, with an inspectable store. */
class FakeRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  calls: string[] = [];

  /** Set to make the next call of that command reject, as an unreachable Redis does. */
  failing: Partial<Record<'get' | 'setex' | 'del', boolean>> = {};

  private guard(cmd: 'get' | 'setex' | 'del') {
    if (this.failing[cmd]) throw new Error(`connect ECONNREFUSED (${cmd})`);
  }

  async get(k: string): Promise<string | null> {
    this.calls.push(`get ${k}`);
    this.guard('get');
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  async setex(k: string, ttl: number, v: string): Promise<'OK'> {
    this.calls.push(`setex ${k} ${ttl}`);
    this.guard('setex');
    this.store.set(k, v);
    this.ttls.set(k, ttl);
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    this.guard('del');
    if (keys.length === 0) {
      // Real ioredis rejects DEL with no arguments. Making the fake strict is the
      // point: it is how the empty-scan case below can prove anything.
      throw new Error("ERR wrong number of arguments for 'del' command");
    }
    this.calls.push(`del ${keys.join(' ')}`);
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  scanStream({ match }: { match: string; count?: number }) {
    this.calls.push(`scan ${match}`);
    const re = new RegExp(`^${match.replace(/\*/g, '.*')}$`);
    const hits = [...this.store.keys()].filter((k) => re.test(k));
    // Deliberately delivered in two batches — SCAN is iterative, and a consumer that
    // only reads the first batch would leave keys behind.
    const batches = hits.length > 1 ? [hits.slice(0, 1), hits.slice(1)] : [hits];
    return {
      async *[Symbol.asyncIterator]() {
        for (const b of batches) yield b;
      },
    };
  }
}

const fake = new FakeRedis();
// Injected via the module's own non-production global handle, so `createConnection()`
// is never reached and no REDIS_URL is needed.
(globalThis as unknown as { rbacRedis?: unknown }).rbacRedis = fake;

const { getRolePermissions, invalidateAllRoles, invalidateRolePermissions } = await import(
  './cache'
);

/** VeloExpense: every key carries the organization too (see cache.ts's header). */
const ORG = 'org-uuid-1';
const ROLE = 'role-uuid-1';
const KEY = `rbac:role:${NS}:${ORG}:${ROLE}`;

beforeEach(() => {
  fake.store.clear();
  fake.ttls.clear();
  fake.calls.length = 0;
  fake.failing = {};
  vi.restoreAllMocks();
});

describe('getRolePermissions', () => {
  it('returns the cached list without consulting the database', () => {
    fake.store.set(KEY, JSON.stringify(['expense.report.read']));
    const fetcher = vi.fn(async () => ['should.not.be.called']);
    return getRolePermissions(ORG, ROLE, fetcher).then((perms) => {
      expect(perms).toEqual(['expense.report.read']);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it('fetches and caches on a miss, with the documented 5-minute TTL', async () => {
    const fetcher = vi.fn(async () => ['vcc.card.read', 'vcc.card.create']);
    const perms = await getRolePermissions(ORG, ROLE, fetcher);
    expect(perms).toEqual(['vcc.card.read', 'vcc.card.create']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fake.store.get(KEY) as string)).toEqual(['vcc.card.read', 'vcc.card.create']);
    // 300s is the safety net for a missed invalidateRolePermissions() call. If this
    // number grows, a revoked permission outlives the revocation by that much longer.
    expect(fake.ttls.get(KEY)).toBe(300);
  });

  it('caches an EMPTY permission list as a real answer', async () => {
    // A role with nothing granted is a legitimate state, and `[]` must read as a hit
    // rather than an absent entry — otherwise the least-privileged roles are the ones
    // that hammer the database on every request.
    const fetcher = vi.fn(async () => [] as string[]);
    await getRolePermissions(ORG, ROLE, fetcher);
    expect(fake.store.get(KEY)).toBe('[]');

    const second = vi.fn(async () => ['unexpected']);
    expect(await getRolePermissions(ORG, ROLE, second)).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it('VeloExpense: keeps the same role id in two tenants in separate keys', async () => {
    // Every tenant's system roles share ExpenseOS's fixed ids. Without the organization in
    // the key, one tenant's edited "Employee" would answer for every other tenant's.
    await getRolePermissions('org-a', ROLE, async () => ['a.perm']);
    await getRolePermissions('org-b', ROLE, async () => ['b.perm']);
    expect(await getRolePermissions('org-a', ROLE, async () => ['wrong'])).toEqual(['a.perm']);
    expect(await getRolePermissions('org-b', ROLE, async () => ['wrong'])).toEqual(['b.perm']);
    await invalidateRolePermissions('org-a', ROLE);
    expect(await getRolePermissions('org-b', ROLE, async () => ['wrong'])).toEqual(['b.perm']);
  });

  it('keeps roles in separate keys', async () => {
    await getRolePermissions(ORG, 'role-a', async () => ['a.perm']);
    await getRolePermissions(ORG, 'role-b', async () => ['b.perm']);
    expect(await getRolePermissions(ORG, 'role-a', async () => ['wrong'])).toEqual(['a.perm']);
    expect(await getRolePermissions(ORG, 'role-b', async () => ['wrong'])).toEqual(['b.perm']);
  });

  describe('a cache entry that is not a permission list is never trusted', () => {
    // The security-relevant branch. Anything that survives JSON.parse but isn't an
    // array must be discarded and refetched, not handed to the permission checker —
    // `'admin'`, `{}` and `null` all parse cleanly and none is a permission list.
    for (const [label, raw] of [
      ['corrupt JSON', '{not json'],
      ['a bare string', '"expense.report.approve"'],
      ['null', 'null'],
      ['an object', '{"0":"expense.report.approve"}'],
      ['a number', '42'],
      ['an empty string', ''],
    ] as const) {
      it(`refetches when the entry is ${label}`, async () => {
        fake.store.set(KEY, raw);
        const fetcher = vi.fn(async () => ['real.perm']);
        const perms = await getRolePermissions(ORG, ROLE, fetcher);
        expect(perms).toEqual(['real.perm']);
        expect(fetcher).toHaveBeenCalledTimes(1);
        // And the bad entry is replaced, so it cannot be re-read next request.
        expect(JSON.parse(fake.store.get(KEY) as string)).toEqual(['real.perm']);
      });
    }
  });

  it('propagates a fetcher failure instead of falling back to empty permissions', async () => {
    // Failing closed is right, but it must fail LOUDLY — silently returning [] would
    // read as "this user may do nothing", which looks like a permissions bug to
    // everyone downstream and hides a database outage.
    const boom = new Error('db down');
    await expect(
      getRolePermissions(ORG, ROLE, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.store.has(KEY)).toBe(false);
  });
});

describe('invalidation', () => {
  it('deletes exactly the role that changed', async () => {
    fake.store.set(`rbac:role:${NS}:${ORG}:changed`, '["old.perm"]');
    fake.store.set(`rbac:role:${NS}:${ORG}:untouched`, '["keep.perm"]');
    await invalidateRolePermissions(ORG, 'changed');
    expect(fake.store.has(`rbac:role:${NS}:${ORG}:changed`)).toBe(false);
    expect(fake.store.has(`rbac:role:${NS}:${ORG}:untouched`)).toBe(true);
  });

  it('uses the same key shape the reader uses', async () => {
    // The failure this rules out: a writer that invalidates `role:x` while the reader
    // looks up `rbac:role:${NS}:x`. Nothing errors; the revocation simply never lands.
    await getRolePermissions(ORG, ROLE, async () => ['p']);
    expect(fake.store.has(KEY)).toBe(true);
    await invalidateRolePermissions(ORG, ROLE);
    expect(fake.store.has(KEY)).toBe(false);
  });

  it('clears every role, across more than one SCAN batch', async () => {
    fake.store.set(`rbac:role:${NS}:a`, '["1"]');
    fake.store.set(`rbac:role:${NS}:b`, '["2"]');
    fake.store.set(`rbac:role:${NS}:c`, '["3"]');
    await invalidateAllRoles();
    expect([...fake.store.keys()]).toEqual([]);
  });

  it('leaves unrelated Redis keys alone', async () => {
    // The cache shares its Redis database with sessions and rate limiting; a greedy
    // match here would sign everybody out on a role edit.
    fake.store.set(`rbac:role:${NS}:a`, '["1"]');
    fake.store.set('session:abc', 'not-ours');
    fake.store.set(`ratelimit:${NS}:1.2.3.4`, 'not-ours');
    await invalidateAllRoles();
    expect([...fake.store.keys()].sort()).toEqual([`ratelimit:${NS}:1.2.3.4`, 'session:abc']);
  });

  it('does not issue a DEL when nothing matched', async () => {
    // Real ioredis errors on DEL with no keys, so an unguarded spread would turn the
    // no-op case into a thrown error inside an admin save.
    fake.store.set('session:abc', 'not-ours');
    await expect(invalidateAllRoles()).resolves.toBeUndefined();
    expect(fake.calls.some((c) => c.startsWith('del'))).toBe(false);
  });
});

describe('connection', () => {
  it('refuses to construct a connection without REDIS_URL', async () => {
    // Reached only on a genuinely unconfigured deploy. It must throw a named error
    // rather than connect to a default localhost that happens to answer.
    vi.resetModules();
    const g = globalThis as unknown as { rbacRedis?: unknown };
    const saved = g.rbacRedis;
    const savedUrl = process.env.REDIS_URL;
    g.rbacRedis = undefined;
    delete process.env.REDIS_URL;
    try {
      const { getRbacRedis } = await import('./cache');
      expect(() => getRbacRedis()).toThrow(/REDIS_URL is not set/);
    } finally {
      g.rbacRedis = saved;
      if (savedUrl !== undefined) process.env.REDIS_URL = savedUrl;
    }
  });
});

describe('when Redis is unreachable', () => {
  /**
   * The asymmetry this pins. Reading is fail-soft because the database is right there and
   * says the same thing; invalidating is fail-loud because nothing else can do its job.
   *
   * Before this, the read was unguarded — so a Redis blip threw out of `resolveRbacUser`
   * and failed every request in the tenant, `/health` included. A cache is not allowed to
   * be a hard dependency of the thing it caches.
   */

  it('resolves from the database when the read fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failing.get = true;
    const fetcher = vi.fn(async () => ['expense.report.read']);
    expect(await getRolePermissions(ORG, ROLE, fetcher)).toEqual(['expense.report.read']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Loud in the log, silent to the caller: the answer is authoritative, not degraded.
    expect(err).toHaveBeenCalled();
  });

  it('grants nothing extra by falling back — the database answer is the answer', async () => {
    /** The fallback must not widen anything. An empty role stays empty. */
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failing.get = true;
    expect(await getRolePermissions(ORG, ROLE, async () => [])).toEqual([]);
  });

  it('still answers when the entry cannot be written back', async () => {
    /**
     * The permissions are already in hand and already correct by then. Failing the
     * request over a cache write discards a right answer to report a cache problem.
     */
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failing.setex = true;
    expect(await getRolePermissions(ORG, ROLE, async () => ['vcc.card.read'])).toEqual([
      'vcc.card.read',
    ]);
    expect(err).toHaveBeenCalled();
  });

  it('survives a read AND a write failing in the same request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failing.get = true;
    fake.failing.setex = true;
    expect(await getRolePermissions(ORG, ROLE, async () => ['a.perm'])).toEqual(['a.perm']);
  });

  it('does not mask a database failure as a cache failure', async () => {
    /** Both layers down is still "I do not know", and it must stay loud. */
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.failing.get = true;
    const boom = new Error('db down');
    await expect(
      getRolePermissions(ORG, ROLE, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('rejects rather than pretending a revocation landed', async () => {
    /**
     * The one place silence would be dangerous. A DEL that did not happen leaves an entry
     * authorizing the OLD permission set for up to the TTL, so an admin who has been told
     * their change saved is wrong about when it takes effect. The caller decides what to
     * do; it is not this function's to hide.
     */
    fake.failing.del = true;
    await expect(invalidateRolePermissions(ORG, ROLE)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects on a failed global invalidation too', async () => {
    fake.store.set(`rbac:role:${NS}:a`, '["1"]');
    fake.failing.del = true;
    await expect(invalidateAllRoles()).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('VeloExpense: with no Redis configured', () => {
  /**
   * CI and a developer's machine run without `REDIS_URL`. There the cache is absent rather
   * than down: every request reads the row, nothing is logged, and an invalidation has
   * nothing stale to remove. Deployed, the web task always has `REDIS_URL`.
   */
  const withoutRedis = async <T>(fn: (m: typeof import('./cache')) => Promise<T>): Promise<T> => {
    vi.resetModules();
    const g = globalThis as unknown as { rbacRedis?: unknown };
    const saved = g.rbacRedis;
    const savedUrl = process.env.REDIS_URL;
    g.rbacRedis = undefined;
    delete process.env.REDIS_URL;
    try {
      return await fn(await import('./cache'));
    } finally {
      g.rbacRedis = saved;
      if (savedUrl !== undefined) process.env.REDIS_URL = savedUrl;
    }
  };

  it('reads the database every time, quietly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withoutRedis(async (m) => {
      const fetcher = vi.fn(async () => ['expense.report.read.own']);
      expect(await m.getRolePermissions(ORG, ROLE, fetcher)).toEqual(['expense.report.read.own']);
      expect(await m.getRolePermissions(ORG, ROLE, fetcher)).toEqual(['expense.report.read.own']);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    expect(err).not.toHaveBeenCalled();
  });

  it('has nothing to invalidate', async () => {
    await withoutRedis(async (m) => {
      await expect(m.invalidateRolePermissions(ORG, ROLE)).resolves.toBeUndefined();
      await expect(m.invalidateAllRoles()).resolves.toBeUndefined();
    });
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The candidate cache.
 *
 * A fake Redis rather than the real one: what is under test is the KEYING — which is the
 * whole security property here. A candidate is keyed by request AND kind, so an id issued
 * for one request cannot be redeemed against another, and a flight id offered to a lodging
 * line is simply not found. Whether ioredis can set a string is not this file's business.
 */
const store = new Map<string, string>();
const pipelineOps: Array<[string, number, string]> = [];

const fakeRedis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  setex: vi.fn(async (k: string, _ttl: number, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n += 1;
    return n;
  }),
  pipeline: () => {
    const ops: Array<[string, number, string]> = [];
    return {
      setex(k: string, ttl: number, v: string) {
        ops.push([k, ttl, v]);
        return this;
      },
      async exec() {
        for (const [k, ttl, v] of ops) {
          pipelineOps.push([k, ttl, v]);
          store.set(k, v);
        }
        return [];
      },
    };
  },
  scanStream: ({ match }: { match: string }) => {
    // `*` is the only wildcard the caller uses.
    const re = new RegExp(
      `^${match.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`))}$`,
    );
    const keys = [...store.keys()].filter((k) => re.test(k));
    return (async function* () {
      if (keys.length > 0) yield keys;
    })();
  },
};

/**
 * Mocked at the CONSTRUCTOR, not at the module's own accessor.
 *
 * `vi.spyOn(cache, 'getTravelOptsRedis')` does not work here: the module's functions call
 * the local binding, not the export, so the spy never runs. Replacing `new Redis()` means
 * the code under test takes its real path — key building, TTLs, the pipeline, the scan —
 * against a fake connection.
 */
vi.mock('ioredis', () => ({
  // A function rather than a class: `new fn()` returning an object is ordinary JavaScript,
  // where a class constructor returning one trips `noConstructorReturn` — a rule that is
  // right everywhere except a fake connection.
  Redis: function FakeRedis() {
    return fakeRedis;
  } as unknown as new () => typeof fakeRedis,
}));

process.env.REDIS_URL ??= 'redis://localhost:6379';

const cache = await import('./travelOptionsCache');

const CANDIDATE = {
  amountMinor: '67500',
  providerAmountMinor: '50000',
  providerCurrency: 'USD',
  option: { legs: [{ from: 'YUL', to: 'YYZ', flightNumber: 'AC 412' }] },
  search: { travelClass: 'BUSINESS' },
};

beforeEach(() => {
  store.clear();
  pipelineOps.length = 0;
  vi.clearAllMocks();
});

describe('putCandidates', () => {
  it('returns one id per candidate', async () => {
    const ids = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE, CANDIDATE, CANDIDATE]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('sets a TTL on every entry', async () => {
    // No TTL would mean a fare from March is still pickable in June. The point of caching
    // rather than storing is that these expire.
    await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    expect(pipelineOps[0][1]).toBe(cache.CANDIDATE_TTL_SEC);
    expect(cache.CANDIDATE_TTL_SEC).toBeGreaterThan(0);
  });

  it('writes one key per candidate rather than one key holding the set', async () => {
    // So a pick reads exactly the entry it needs, and expiry is per-candidate rather than
    // all-or-nothing at the end of a window that began when the search ran.
    await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE, CANDIDATE]);
    expect(store.size).toBe(2);
  });
});

describe('getCandidate', () => {
  it('reads back what was written', async () => {
    const [id] = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    await expect(cache.getCandidate('req-1', 'FLIGHT', id)).resolves.toMatchObject({
      amountMinor: '67500',
      providerCurrency: 'USD',
    });
  });

  it('does NOT find an id issued for another request', async () => {
    /**
     * The security property. The request id is part of the key, so a candidate cannot be
     * redeemed against a different estimate even by somebody who knows the id.
     */
    const [id] = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    await expect(cache.getCandidate('req-2', 'FLIGHT', id)).resolves.toBeNull();
  });

  it('does NOT find a flight id asked for as a stay', async () => {
    // Which is what stops an airfare payload being written into a lodging block that has no
    // field to read it — the mismatch is a miss, not a bad write.
    const [id] = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    await expect(cache.getCandidate('req-1', 'STAY', id)).resolves.toBeNull();
  });

  it('returns null for an id that never existed', async () => {
    // The expiry path, which the caller turns into "search again" rather than a stack trace.
    await expect(cache.getCandidate('req-1', 'FLIGHT', 'nope')).resolves.toBeNull();
  });

  it('returns null for a corrupted entry rather than throwing', async () => {
    // An entry written by an older deployment. A fresh search is cheaper than guessing what
    // it meant, and a parse throw on this path would surface as a broken picker.
    store.set('travelopts:req-1:FLIGHT:bad', '{not json');
    await expect(cache.getCandidate('req-1', 'FLIGHT', 'bad')).resolves.toBeNull();
  });

  it('returns null for an entry missing the amount', async () => {
    // The one field the caller cannot do without: a shape check beats a runtime undefined
    // reaching BigInt().
    store.set('travelopts:req-1:FLIGHT:partial', JSON.stringify({ option: {} }));
    await expect(cache.getCandidate('req-1', 'FLIGHT', 'partial')).resolves.toBeNull();
  });
});

describe('clearCandidates', () => {
  it('drops every candidate for the request, of both kinds', async () => {
    // Once one fare is taken the rivals must stop being redeemable, or a stale id from the
    // same result set can silently replace a deliberate pick.
    const [flight] = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    const [stay] = await cache.putCandidates('req-1', 'STAY', [CANDIDATE]);
    await cache.clearCandidates('req-1');
    await expect(cache.getCandidate('req-1', 'FLIGHT', flight)).resolves.toBeNull();
    await expect(cache.getCandidate('req-1', 'STAY', stay)).resolves.toBeNull();
  });

  it('leaves another request’s candidates alone', async () => {
    const [mine] = await cache.putCandidates('req-1', 'FLIGHT', [CANDIDATE]);
    const [theirs] = await cache.putCandidates('req-2', 'FLIGHT', [CANDIDATE]);
    await cache.clearCandidates('req-1');
    await expect(cache.getCandidate('req-1', 'FLIGHT', mine)).resolves.toBeNull();
    await expect(cache.getCandidate('req-2', 'FLIGHT', theirs)).resolves.not.toBeNull();
  });

  it('is a no-op when there is nothing to clear', async () => {
    // Called after every pick, including the first — `del()` with no keys throws in ioredis.
    await expect(cache.clearCandidates('req-empty')).resolves.toBeUndefined();
    expect(fakeRedis.del).not.toHaveBeenCalled();
  });
});

import crypto from 'node:crypto';
import { cacheNamespace } from '@expenseos/db';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * The searched flight and stay options a traveller can still pick from.
 *
 * ## Why this exists at all
 *
 * A picker naturally wants "the client sends back the option it chose", and that would let
 * the client name the price — the archived prototype's posted-total bug in a new shape. So
 * the server has to remember what it offered between the search and the pick, and
 * `chooseLineOption` re-reads the amount from here rather than from its input. The input
 * schema has no amount field at all, which is the enforcement.
 *
 * ## Why Redis rather than a table
 *
 * The first version stored every candidate as a `TravelQuote` row, on the theory that they
 * were durable evidence. They were not: a line's payload already carries the route, the legs
 * with flight numbers, the cabin, the dates and the booking token — that IS the explanation
 * of the number, and the one thing the row added (the provider's pre-FX amount) now lives on
 * the payload too.
 *
 * What was actually needed was for the server to remember for MINUTES, not forever. So the
 * table is gone, and with it a model, an enum, a column and a housekeeping job that existed
 * only to delete the eleven candidates nobody picked.
 *
 * ## The cost, and why it is acceptable
 *
 * A pick attempted after the TTL — or after an eviction or a Redis restart — finds nothing
 * and asks for a fresh search. That is one provider credit and the traveller is still on the
 * same screen. `chooseLineOption` must say exactly that rather than throwing something that
 * reads as a bug.
 *
 * Its own connection, for the reason `facets/cache.ts` documents: a slow miss here must not
 * head-of-line block an authn-critical RBAC read.
 */

const KEY_PREFIX = 'travelopts:';

/**
 * Thirty minutes.
 *
 * Long enough to compare a dozen fares, talk to somebody, and come back; short enough that a
 * price nobody acted on does not sit around being pickable a day later. A fare is only
 * meaningful near when it was quoted.
 */
export const CANDIDATE_TTL_SEC = 30 * 60;

const globalForCache = globalThis as unknown as { travelOptsRedis?: Redis };

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

let _travelOptsRedis: Redis | undefined;

/** Lazily constructed, NOT at import time — so `next build` page-data collection does not
 *  open a connection. Same arrangement as the facet cache. */
export function getTravelOptsRedis(): Redis {
  _travelOptsRedis ??= globalForCache.travelOptsRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForCache.travelOptsRedis = _travelOptsRedis;
  }
  return _travelOptsRedis;
}

/**
 * One cached candidate: the provider's option, the search that produced it, and the amount
 * in BOTH currencies.
 *
 * Both amounts, deliberately. `amountMinor` is what the line gets — the request's currency,
 * because a line carries none of its own. `providerAmountMinor` / `providerCurrency` are what
 * the provider actually quoted, which is the piece of evidence the dropped table used to hold
 * and which the payload now carries forward.
 *
 * Minor amounts are digit STRINGS: this round-trips through JSON, and BigInt does not.
 */
export interface CachedCandidate {
  amountMinor: string;
  providerAmountMinor: string;
  providerCurrency: string;
  option: Record<string, unknown>;
  search: Record<string, unknown>;
}

/** A candidate id. Opaque to the client, and scoped to the request in the key — so an id
 *  from one request cannot be redeemed against another even if somebody guesses it. */
export function candidateId(): string {
  return crypto.randomUUID();
}

/** Scoped to the DATABASE. A request id is a runtime UUIDv7 so it cannot collide today;
 *  scoped anyway so that every Redis key in the repo obeys one rule and the next cache
 *  keyed by something seeded inherits it for free. */
const keyFor = (requestId: string, kind: 'FLIGHT' | 'STAY', id: string) =>
  `${KEY_PREFIX}${cacheNamespace()}:${requestId}:${kind}:${id}`;

/**
 * Store a search's candidates and hand back their ids.
 *
 * One `SETEX` per candidate rather than one key holding the set: a pick reads exactly the
 * one it needs, and expiry is per-candidate rather than all-or-nothing at the end of a
 * window that started when the search ran.
 */
export async function putCandidates(
  requestId: string,
  kind: 'FLIGHT' | 'STAY',
  candidates: CachedCandidate[],
): Promise<string[]> {
  const redis = getTravelOptsRedis();
  const ids: string[] = [];
  const pipeline = redis.pipeline();
  for (const c of candidates) {
    const id = candidateId();
    ids.push(id);
    pipeline.setex(keyFor(requestId, kind, id), CANDIDATE_TTL_SEC, JSON.stringify(c));
  }
  await pipeline.exec();
  return ids;
}

/**
 * Read one candidate back, or null when it has expired or never existed.
 *
 * Null is the ordinary answer, not an error: a traveller who left the drawer open over lunch
 * gets it, and the caller turns it into "search again" rather than a stack trace. A corrupted
 * entry reads as null too — recomputing is always safe here, and a parse throw on a display
 * path is not.
 */
export async function getCandidate(
  requestId: string,
  kind: 'FLIGHT' | 'STAY',
  id: string,
): Promise<CachedCandidate | null> {
  const raw = await getTravelOptsRedis().get(keyFor(requestId, kind, id));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as CachedCandidate;
    // A minimal shape check. Anything else means the entry was written by an older
    // deployment, and a fresh search is cheaper than guessing what it meant.
    return typeof parsed?.amountMinor === 'string' && parsed.option ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Drop every candidate for a request.
 *
 * Called once a pick lands: the other eleven fares are no longer offered, and leaving them
 * redeemable means a stale id can still overwrite a deliberate choice. `SCAN` rather than
 * `KEYS` so it never blocks the server on a large keyspace.
 */
export async function clearCandidates(requestId: string): Promise<void> {
  const redis = getTravelOptsRedis();
  const stream = redis.scanStream({
    match: `${KEY_PREFIX}${cacheNamespace()}:${requestId}:*`,
    count: 200,
  });
  const keys: string[] = [];
  for await (const batch of stream) {
    for (const k of batch as string[]) keys.push(k);
  }
  if (keys.length > 0) await redis.del(...keys);
}

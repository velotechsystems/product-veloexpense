/**
 * Inbound-message idempotency (INBOUND-04).
 *
 * SNS delivers at-least-once: if this endpoint is slow or the connection drops
 * before the 200, AWS redelivers the same Notification, which would create a
 * duplicate COMMENT activity + duplicate fan-out. `claimOnce` records a
 * processed message id in Redis with SET NX so a redelivery is a no-op.
 *
 * Mirrors the Redis-singleton pattern used by rateLimit / webauthnChallenge:
 * the connection opens lazily (not at import) so `next build` doesn't dial Redis.
 *
 * VeloExpense: ExpenseOS's `apps/web/src/server/lib/inboundDedup.ts` (550b2945), Wave 3 (w3-06),
 * unchanged. REDIS_URL is the web task's queue connection (w3-00).
 */

import { cacheNamespace } from '@expenseos/db';
import { Redis, type RedisOptions } from 'ioredis';

const KEY_PREFIX = 'inbound:seen:';

/**
 * Scoped to the DATABASE, so dedup is per ENVIRONMENT.
 *
 * The id comes from the provider rather than from our data, so this is not the id
 * collision the other caches have — it is the opposite. Two environments pointed at the
 * same inbound mailbox would legitimately both want to process a message, and an unscoped
 * key meant whichever got there first silently suppressed the other.
 */
const seenKey = (messageId: string) => `${KEY_PREFIX}${cacheNamespace()}:${messageId}`;
// Retain the marker well past SNS's redelivery window (which is minutes).
const TTL_SEC = 24 * 60 * 60;

const globalForDedup = globalThis as unknown as { inboundDedupRedis?: Redis };

function readUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return url;
}

function createConnection(): Redis {
  const opts: RedisOptions = { enableReadyCheck: true, lazyConnect: false };
  return new Redis(readUrl(), opts);
}

let _dedupRedis: Redis | undefined;

function getDedupRedis(): Redis {
  _dedupRedis ??= globalForDedup.inboundDedupRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForDedup.inboundDedupRedis = _dedupRedis;
  }
  return _dedupRedis;
}

/**
 * Atomically claim `messageId` for processing. Returns true the first time
 * (caller should process), false if it was already seen (caller should skip).
 * Fails OPEN on a Redis error or a missing id — better to risk a rare duplicate
 * than to silently drop a legitimate reply.
 */
export async function claimOnce(messageId: string | undefined): Promise<boolean> {
  if (!messageId) return true;
  try {
    const res = await getDedupRedis().set(seenKey(messageId), '1', 'EX', TTL_SEC, 'NX');
    return res === 'OK';
  } catch (e) {
    console.warn('[inbound] dedup check failed (processing anyway)', e);
    return true;
  }
}

/**
 * Release a claim taken by {@link claimOnce} when processing FAILED, so a
 * legitimate retry can reprocess instead of being deduped away. Best-effort.
 */
export async function releaseClaim(messageId: string | undefined): Promise<void> {
  if (!messageId) return;
  try {
    await getDedupRedis().del(seenKey(messageId));
  } catch (e) {
    console.warn('[inbound] dedup release failed', e);
  }
}

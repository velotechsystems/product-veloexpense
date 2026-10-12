/**
 * Fixed-window rate limiting + lockout for authentication endpoints (AUTH-04).
 *
 * Password login, TOTP, and passkey verification were unthrottled — a small
 * 6-digit TOTP space and bcrypt password checks were brute-forceable at request
 * rate. Each `throttle()` increments a per-key counter with a TTL window; once
 * the window's max is exceeded the key is denied until the window rolls off.
 * Callers reset the per-account key on success so sporadic failures never lock
 * a legitimate user out.
 *
 * Mirrors the Redis-singleton pattern used by passwordPreauth / webauthnChallenge:
 * the connection is opened lazily (not at import) so `next build` page-data
 * collection doesn't dial Redis.
 *
 * VeloExpense: ExpenseOS's `apps/web/src/server/lib/rateLimit.ts` (550b2945), Wave 3 (w3-06),
 * unchanged. Its first caller here is the inbound receipts ceiling, not authentication:
 * VeloExpense signs in through SSO only.
 */

import { cacheNamespace } from '@expenseos/db';
import { Redis, type RedisOptions } from 'ioredis';
import { headers } from 'next/headers';

const KEY_PREFIX = 'ratelimit:';

/** Scoped to the DATABASE. Callers key limits by user id, and user ids are seeded
 *  identically across databases — so dev, test and e2e were sharing one budget. */
const rlKey = (key: string) => `${KEY_PREFIX}${cacheNamespace()}:${key}`;

const globalForRateLimit = globalThis as unknown as { rateLimitRedis?: Redis };

function readUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return url;
}

function createConnection(): Redis {
  const opts: RedisOptions = { enableReadyCheck: true, lazyConnect: false };
  return new Redis(readUrl(), opts);
}

let _rateLimitRedis: Redis | undefined;

function getRateLimitRedis(): Redis {
  _rateLimitRedis ??= globalForRateLimit.rateLimitRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForRateLimit.rateLimitRedis = _rateLimitRedis;
  }
  return _rateLimitRedis;
}

/**
 * The slice of a Redis client `throttle` needs.
 *
 * Injectable so the counting logic can be tested against a fake. Before this, the only way
 * to exercise the auth throttle was a live Redis, so it had no tests at all — and it
 * guards password, TOTP and passkey verification.
 */
export interface Counter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export interface ThrottleConfig {
  /** Max attempts allowed within the window before the key is locked. */
  max: number;
  /** Window / lockout length in seconds. */
  windowSec: number;
}

export interface ThrottleResult {
  allowed: boolean;
  /** Seconds until the window rolls off (only meaningful when !allowed). */
  retryAfterSec: number;
}

/**
 * Count one attempt against `key`. Returns `allowed:false` once the count
 * exceeds `cfg.max` within the window. Fail-open on a Redis error — auth must
 * not hard-break if the limiter is unavailable.
 */
export async function throttle(
  key: string,
  cfg: ThrottleConfig,
  counter?: Counter,
): Promise<ThrottleResult> {
  try {
    const redis = counter ?? getRateLimitRedis();
    const k = rlKey(key);
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, cfg.windowSec);
    if (count > cfg.max) {
      const ttl = await redis.ttl(k);
      return { allowed: false, retryAfterSec: ttl > 0 ? ttl : cfg.windowSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  } catch (e) {
    console.error('[rateLimit] throttle error (failing open):', e);
    return { allowed: true, retryAfterSec: 0 };
  }
}

/** Clear a key's counter — call on a successful authentication. */
export async function resetThrottle(key: string): Promise<void> {
  try {
    await getRateLimitRedis().del(rlKey(key));
  } catch (e) {
    console.error('[rateLimit] reset error:', e);
  }
}

/**
 * Best-effort client IP from a header bag.
 *
 * The FIRST `x-forwarded-for` hop, which behind CloudFront/ALB is the real client — and is
 * also client-*supplied*. A request that reaches the origin without passing the edge can
 * put anything here. So this is fine for throttling buckets and for a forensic record, and
 * it is **not** an authentication signal: anything gated on it (an API key's address
 * allowlist) is defence in depth, not a control that stands on its own.
 *
 * Returns `'unknown'` rather than null so callers never have to decide what a missing
 * address means — and so a coalescing key never has a NULL in it.
 */
export function ipFromHeaders(h: Headers): string {
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || h.get('x-real-ip')?.trim() || 'unknown';
}

/** Best-effort client IP inside a request scope (safe to call outside one). */
export async function clientIp(): Promise<string> {
  try {
    return ipFromHeaders(await headers());
  } catch {
    return 'unknown';
  }
}

/**
 * Best-effort user-agent inside a request scope (safe to call outside one). Paired with
 * `clientIp` on the forensic columns of an Audit row; `undefined` rather than a sentinel
 * because the column is nullable and is not part of the hash.
 */
export async function clientUserAgent(): Promise<string | undefined> {
  try {
    return (await headers()).get('user-agent') || undefined;
  } catch {
    return undefined;
  }
}

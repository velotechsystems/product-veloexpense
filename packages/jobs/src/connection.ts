import { Redis, type RedisOptions } from 'ioredis';

/**
 * Shared ioredis connection for BullMQ.
 *
 * Reads BULLMQ_REDIS_URL first (recommended — isolates the queue
 * traffic on its own Redis DB index) and falls back to REDIS_URL.
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ — its blocking
 * BRPOPLPUSH calls cannot be cancelled by ioredis's retry timer or
 * the worker will throw `MaxRetriesPerRequestError` under load.
 *
 * Cached on globalThis so HMR (worker `tsx watch`) and Next.js HMR
 * (when the web app enqueues from a tRPC mutation) don't leak open
 * sockets.
 */

const globalForJobs = globalThis as unknown as { jobsRedis?: Redis };

function readUrl(): string {
  const url = process.env.BULLMQ_REDIS_URL || process.env.REDIS_URL;
  if (!url) {
    throw new Error('Neither BULLMQ_REDIS_URL nor REDIS_URL is set');
  }
  return url;
}

function createConnection(): Redis {
  const opts: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  return new Redis(readUrl(), opts);
}

let _jobsConnection: Redis | undefined;

/**
 * Lazily-constructed BullMQ Redis connection. The socket is opened on the
 * first call, NOT at import time — so `next build`'s page-data collection
 * (the web app enqueues from tRPC) doesn't try to connect to Redis.
 */
export function getJobsConnection(): Redis {
  _jobsConnection ??= globalForJobs.jobsRedis ?? createConnection();
  if (process.env.NODE_ENV !== 'production') {
    globalForJobs.jobsRedis = _jobsConnection;
  }
  return _jobsConnection;
}

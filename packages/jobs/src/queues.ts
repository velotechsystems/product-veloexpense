/**
 * Queue topology — single source of truth for queue names and their
 * default tuning. The worker (worker/) starts one BullMQ Worker
 * per queue with these defaults; the enqueue side reads the same
 * config so retries / backoff are consistent end-to-end.
 */

export const QUEUE_NAMES = ['notifications', 'exports', 'integrations', 'housekeeping'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueOptions {
  /** Worker concurrency per queue. */
  defaultConcurrency: number;
  /** Default attempts per job in this queue. */
  defaultAttempts: number;
  /** Exponential backoff base in ms. Set to 0 to disable backoff. */
  backoffMs: number;
  /** Optional cap on backoff growth. */
  backoffMaxMs?: number;
}

export const QUEUE_CONFIG: Record<QueueName, QueueOptions> = {
  notifications: {
    defaultConcurrency: 10,
    defaultAttempts: 5,
    backoffMs: 30_000,
    backoffMaxMs: 5 * 60_000,
  },
  exports: {
    defaultConcurrency: 2,
    defaultAttempts: 3,
    backoffMs: 60_000,
  },
  integrations: {
    defaultConcurrency: 4,
    defaultAttempts: 5,
    backoffMs: 60_000,
    backoffMaxMs: 60 * 60_000,
  },
  housekeeping: {
    defaultConcurrency: 1,
    defaultAttempts: 1,
    backoffMs: 0,
  },
};

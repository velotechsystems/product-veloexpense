import { type ConnectionOptions, type JobsOptions, Queue } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { getJobsConnection } from './connection';
import { JOB_QUEUES, type JobMap, type JobName } from './jobs';
import { QUEUE_CONFIG, type QueueName } from './queues';

/**
 * Lazily cached BullMQ Queue per queue name. Each Queue holds its own
 * blocking client under the hood; we reuse them to avoid socket churn
 * when many enqueue() calls hit the same queue.
 */
const queueCache = new Map<QueueName, Queue>();

function getQueue(name: QueueName): Queue {
  const cached = queueCache.get(name);
  if (cached) return cached;
  // Cast: BullMQ accepts an ioredis instance as `connection` at runtime, but
  // its `ConnectionOptions` type is pinned to ioredis 5.10.1's `Redis` while
  // the workspace resolves a newer ioredis — the instances are API-compatible.
  const q = new Queue(name, { connection: getJobsConnection() as ConnectionOptions });
  queueCache.set(name, q);
  return q;
}

export interface EnqueueOptions {
  /**
   * Custom job id for idempotency. Re-enqueuing with the same id is a
   * no-op in BullMQ, which is exactly what we want for jobs like the
   * daily audit archive ("audit-archive-2026-05-18"). Default: a
   * fresh UUIDv7.
   */
  jobId?: string;
  /** Delay before the job becomes available. */
  delayMs?: number;
  /** Override default attempts for this queue. */
  attempts?: number;
  /** Recurring schedule. Pattern is standard cron. */
  repeat?: { pattern: string; tz?: string } | { every: number };
}

/**
 * Type-safe enqueue. Picks the queue from JOB_QUEUES, applies retry /
 * backoff from QUEUE_CONFIG, and minst a UUIDv7 job id by default for
 * idempotency-aware callers that omit one.
 */
export async function enqueue<N extends JobName>(
  name: N,
  payload: JobMap[N],
  opts: EnqueueOptions = {},
): Promise<void> {
  const queueName = JOB_QUEUES[name];
  const config = QUEUE_CONFIG[queueName];
  const queue = getQueue(queueName);

  const jobOptions: JobsOptions = {
    jobId: opts.jobId ?? uuidv7(),
    attempts: opts.attempts ?? config.defaultAttempts,
    backoff: config.backoffMs > 0 ? { type: 'exponential', delay: config.backoffMs } : undefined,
    // Keep recently completed and failed jobs around briefly so the
    // worker UI / debugging tools can show outcomes. The defaults are
    // permissive on a dev box and tightened in prod by the worker
    // env override.
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(opts.repeat ? { repeat: opts.repeat } : {}),
  };

  await queue.add(name, payload, jobOptions);
}

/**
 * Register (or update) a recurring job via a named JobScheduler. Unlike
 * `queue.add({ repeat })` — whose legacy repeat key hashes the pattern+tz, so
 * editing a cron pattern orphans the old schedule and double-fires — a
 * JobScheduler keys purely on `schedulerId` and updates the pattern in place.
 * Idempotent across boots AND across pattern/tz edits.
 */
export async function upsertRecurring<N extends JobName>(
  schedulerId: string,
  name: N,
  payload: JobMap[N],
  repeat: { pattern: string; tz?: string },
): Promise<void> {
  const queueName = JOB_QUEUES[name];
  const config = QUEUE_CONFIG[queueName];
  const queue = getQueue(queueName);
  await queue.upsertJobScheduler(
    schedulerId,
    { pattern: repeat.pattern, tz: repeat.tz },
    {
      name,
      data: payload,
      opts: {
        attempts: config.defaultAttempts,
        backoff:
          config.backoffMs > 0 ? { type: 'exponential', delay: config.backoffMs } : undefined,
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      },
    },
  );
}

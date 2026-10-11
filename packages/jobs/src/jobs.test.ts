// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_QUEUES } from './jobs';
import { QUEUE_CONFIG, QUEUE_NAMES } from './queues';

/**
 * The enqueue side of the queue topology, which had no tests.
 *
 * Everything here is a promise about a job that runs LATER, in another process, so a
 * mistake surfaces as "the notification never arrived" rather than as a failure at the
 * call site. The three that matter: the queue a job lands in, the retry policy it
 * carries, and the job id — which is what makes a re-enqueue idempotent instead of a
 * duplicate.
 *
 * VeloExpense: the job map holds `example.ping` and `expense.extractReceipt`
 * (packages/jobs/src/jobs.ts), so the cases ExpenseOS writes against `notification.dispatch`
 * and `approval.sweepExpired` run against those two: the housekeeping queue (no backoff) and
 * the integrations queue (exponential backoff), one job each.
 */

const h = vi.hoisted(() => ({
  // Rest params, not `()`: the tests read the ARGUMENTS these were called with — the
  // queue a job landed in, its retry policy, its job id — and a zero-arity
  // implementation types the call log as an empty tuple, so `calls[0]` is a type error
  // even though every call carried three arguments.
  add: vi.fn(async (..._a: unknown[]) => ({})),
  upsertJobScheduler: vi.fn(async (..._a: unknown[]) => ({})),
  ctor: vi.fn(),
  redis: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = h.add;
    upsertJobScheduler = h.upsertJobScheduler;
    constructor(name: string, opts: unknown) {
      h.ctor(name, opts);
    }
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(url: string, opts: unknown) {
      h.redis(url, opts);
    }
  },
}));

/** Fresh module state per test: both modules cache (queues, the connection). */
async function load() {
  vi.resetModules();
  return await import('./enqueue');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.REDIS_URL = 'redis://localhost:6379';
  delete process.env.BULLMQ_REDIS_URL;
  // The connection is cached on globalThis outside production — that is what stops
  // HMR (worker `tsx watch`, Next's dev server) leaking a socket per reload. It also
  // survives `vi.resetModules()`, so without clearing it here every test after the
  // first would reuse one connection and never reach the constructor.
  delete (globalThis as { jobsRedis?: unknown }).jobsRedis;
});
afterEach(() => vi.unstubAllEnvs());

describe('topology', () => {
  it('routes every job name to a real queue', () => {
    // A typo here sends jobs to a queue no worker is listening on, and they sit
    // forever with nothing failing.
    const names = new Set<string>(QUEUE_NAMES);
    const bad = Object.entries(JOB_QUEUES).filter(([, q]) => !names.has(q));
    expect(bad).toEqual([]);
  });

  it('configures every queue it names', () => {
    for (const q of QUEUE_NAMES) expect(QUEUE_CONFIG[q]).toBeDefined();
  });
});

describe('enqueue', () => {
  it('adds to the queue the job name maps to', async () => {
    const { enqueue } = await load();
    await enqueue('example.ping', { message: 'hi' });
    expect(h.ctor).toHaveBeenCalledWith('housekeeping', expect.anything());
    expect(h.add.mock.calls[0]?.[0]).toBe('example.ping');
  });

  it('mints a UUIDv7 job id by default', async () => {
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never);
    const opts = h.add.mock.calls[0]?.[2] as { jobId: string };
    // v7: version nibble is 7. Time-sortable ids are the repo-wide default.
    expect(opts.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('honours an explicit job id, which is what makes a re-enqueue a no-op', async () => {
    // BullMQ dedupes on job id, so a caller like the daily archive passes a stable one
    // and a double-schedule collapses instead of running twice.
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never, { jobId: 'audit-archive-2026-05-18' });
    expect((h.add.mock.calls[0]?.[2] as { jobId: string }).jobId).toBe('audit-archive-2026-05-18');
  });

  it("takes attempts and backoff from the queue's config", async () => {
    const { enqueue } = await load();
    await enqueue('expense.extractReceipt', {} as never);
    const opts = h.add.mock.calls[0]?.[2] as {
      attempts: number;
      backoff?: { type: string; delay: number };
    };
    expect(opts.attempts).toBe(QUEUE_CONFIG.integrations.defaultAttempts);
    expect(opts.backoff).toEqual({
      type: 'exponential',
      delay: QUEUE_CONFIG.integrations.backoffMs,
    });
  });

  it('VeloExpense: carries no backoff on a queue configured without one', async () => {
    // The housekeeping queue's `backoffMs: 0` disables it, rather than meaning "retry now".
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never);
    expect((h.add.mock.calls[0]?.[2] as { backoff?: unknown }).backoff).toBeUndefined();
  });

  it('lets a caller override attempts', async () => {
    // The VCC push uses this: a posted-but-unrecorded charge must not be auto-retried.
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never, { attempts: 4 });
    expect((h.add.mock.calls[0]?.[2] as { attempts: number }).attempts).toBe(4);
  });

  it('omits delay and repeat unless asked', async () => {
    // Present-but-undefined keys are not the same as absent to BullMQ.
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never);
    const opts = h.add.mock.calls[0]?.[2] as Record<string, unknown>;
    expect('delay' in opts).toBe(false);
    expect('repeat' in opts).toBe(false);
  });

  it('passes a delay and a repeat when given', async () => {
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never, { delayMs: 5000 });
    expect((h.add.mock.calls[0]?.[2] as { delay: number }).delay).toBe(5000);
    await enqueue('example.ping', {} as never, { repeat: { every: 60_000 } });
    expect((h.add.mock.calls[1]?.[2] as { repeat: unknown }).repeat).toEqual({ every: 60_000 });
  });

  it('reuses one Queue per queue name', async () => {
    /**
     * Each BullMQ Queue holds its own blocking client, so constructing one per
     * enqueue churns sockets. Two jobs on the same queue must share it; a job on a
     * different queue gets its own.
     */
    const { enqueue } = await load();
    await enqueue('example.ping', {} as never);
    await enqueue('example.ping', {} as never);
    expect(h.ctor).toHaveBeenCalledTimes(1);
    await enqueue('expense.extractReceipt', {} as never);
    expect(h.ctor).toHaveBeenCalledTimes(2);
  });
});

describe('upsertRecurring', () => {
  it('keys on the scheduler id so editing a cron pattern updates in place', async () => {
    /**
     * The reason this exists rather than `add({ repeat })`: the legacy repeat key
     * hashes pattern+tz, so changing a schedule orphans the old one and the job
     * double-fires. A JobScheduler keys purely on its id.
     */
    const { upsertRecurring } = await load();
    await upsertRecurring('nightly-sweep', 'example.ping', {} as never, {
      pattern: '0 2 * * *',
      tz: 'America/Toronto',
    });
    expect(h.upsertJobScheduler.mock.calls[0]?.[0]).toBe('nightly-sweep');
    expect(h.upsertJobScheduler.mock.calls[0]?.[1]).toEqual({
      pattern: '0 2 * * *',
      tz: 'America/Toronto',
    });
  });

  it("carries the queue's retry policy into the scheduled job", async () => {
    const { upsertRecurring } = await load();
    await upsertRecurring('s1', 'example.ping', {} as never, { pattern: '* * * * *' });
    const job = h.upsertJobScheduler.mock.calls[0]?.[2] as {
      name: string;
      opts: { attempts: number };
    };
    expect(job.name).toBe('example.ping');
    expect(job.opts.attempts).toBe(QUEUE_CONFIG.housekeeping.defaultAttempts);
  });
});

describe('getJobsConnection', () => {
  it('prefers BULLMQ_REDIS_URL over REDIS_URL', async () => {
    // The queue gets its own Redis DB index so queue traffic cannot evict cache keys.
    vi.resetModules();
    process.env.BULLMQ_REDIS_URL = 'redis://queue:6379/3';
    const { getJobsConnection } = await import('./connection');
    getJobsConnection();
    expect(h.redis.mock.calls[0]?.[0]).toBe('redis://queue:6379/3');
  });

  it('falls back to REDIS_URL', async () => {
    vi.resetModules();
    const { getJobsConnection } = await import('./connection');
    getJobsConnection();
    expect(h.redis.mock.calls[0]?.[0]).toBe('redis://localhost:6379');
  });

  it('sets maxRetriesPerRequest to null, which BullMQ requires', async () => {
    // Its blocking BRPOPLPUSH cannot be cancelled by ioredis's retry timer, or the
    // worker throws MaxRetriesPerRequestError under load.
    vi.resetModules();
    const { getJobsConnection } = await import('./connection');
    getJobsConnection();
    expect(h.redis.mock.calls[0]?.[1]).toMatchObject({ maxRetriesPerRequest: null });
  });

  it('throws when neither variable is set', async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    delete process.env.BULLMQ_REDIS_URL;
    const { getJobsConnection } = await import('./connection');
    expect(() => getJobsConnection()).toThrow(/BULLMQ_REDIS_URL nor REDIS_URL/);
  });

  it('opens one socket, not one per call', async () => {
    vi.resetModules();
    const { getJobsConnection } = await import('./connection');
    const a = getJobsConnection();
    const b = getJobsConnection();
    expect(a).toBe(b);
    expect(h.redis).toHaveBeenCalledTimes(1);
  });
});

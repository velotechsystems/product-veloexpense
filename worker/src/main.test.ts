// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The worker's boot: what it will process, what it will schedule, and what it refuses to
 * start without.
 *
 * `assertHandlersComplete` is the interesting one. A job mapped to a queue this process
 * consumes, with no handler behind it, is not a boot error today — it is a job that gets
 * dispatched weeks later, throws "no handler", burns its retries and dead-letters, at
 * which point somebody has to work out which of thirty handlers was never wired up.
 * Failing at boot turns that into a deploy that does not go out.
 *
 * The recurring schedules are keyed on `jobId` alone precisely so re-registering on every
 * boot is idempotent: editing a pattern updates the schedule in place instead of leaving
 * the old one running beside the new one, which is how a "daily" job ends up firing twice.
 *
 * VeloExpense: the registry holds `example.ping` alone and there are no schedules yet
 * (worker/src/main.ts says why), so the handler mocks and the registry table are cut to
 * that one, and the schedule cases hold for whatever is registered — none today, the first
 * with receipt chasing (w3-05). Each extraction handler joins both tables with w3-02.
 */

const h = vi.hoisted(() => ({
  upsertRecurring: vi.fn(),
  workers: [] as Array<{
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    listeners: Record<string, (...args: unknown[]) => void>;
  }>,
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  installShutdown: vi.fn(),
  jobQueues: {} as Record<string, string>,
  queueNames: [] as string[],
}));

/**
 * Every handler module, stubbed. Written out one by one rather than looped, because
 * `vi.mock` is hoisted above the file's own statements — a loop variable does not exist
 * yet when it runs.
 */
vi.mock('./handlers/example', () => ({
  handleExamplePing: (...args: unknown[]) => {
    h.handlers.handleExamplePing ??= vi.fn();
    return h.handlers.handleExamplePing(...args);
  },
}));

vi.mock('./lib/env', () => ({}));
vi.mock('./lib/shutdown', () => ({ installShutdown: (w: unknown) => h.installShutdown(w) }));
vi.mock('bullmq', () => ({
  Worker: class {
    // Listeners are recorded, not discarded: the three of them are the only operational
    // visibility a queue has, and a `failed` reporter that throws takes the worker with it.
    readonly listeners: Record<string, (...args: unknown[]) => void> = {};
    constructor(
      public name: string,
      public processor: (job: unknown) => Promise<unknown>,
    ) {
      h.workers.push({ name, processor, listeners: this.listeners });
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      this.listeners[event] = fn;
      return this;
    }
    waitUntilReady() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@expenseos/jobs', () => ({
  getJobsConnection: () => ({}),
  upsertRecurring: (...args: unknown[]) => h.upsertRecurring(...args),
  get JOB_QUEUES() {
    return h.jobQueues;
  },
  get QUEUE_NAMES() {
    return h.queueNames;
  },
  QUEUE_CONFIG: new Proxy({}, { get: () => ({ defaultConcurrency: 2 }) }),
}));

/** Boot a fresh copy of main.ts against the current stub state. */
async function boot() {
  vi.resetModules();
  h.workers = [];
  await import('./main');
  // main() runs at import; let its promise chain settle.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  const { JOB_QUEUES, QUEUE_NAMES } = await import('@expenseos/jobs');
  void JOB_QUEUES;
  void QUEUE_NAMES;
  h.upsertRecurring = vi.fn().mockResolvedValue(undefined);
  h.installShutdown = vi.fn();
  h.handlers = {};
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('what it starts', () => {
  beforeEach(() => {
    h.queueNames = ['default', 'notifications'];
    // VeloExpense: ExpenseOS maps `notification.dispatch` to the second queue; with no
    // handler for it here the boot check (rightly) refuses, so the second queue runs empty.
    h.jobQueues = { 'example.ping': 'default' };
  });

  it('runs one worker per queue it is responsible for', async () => {
    await boot();
    expect(h.workers.map((w) => w.name).sort()).toEqual(['default', 'notifications']);
  });

  it('installs the shutdown drain, with every worker it started', async () => {
    /**
     * If this were skipped, SIGTERM would kill in-flight jobs — the failure mode is a
     * half-written report on every deploy, and nothing in the logs to say so.
     */
    await boot();
    expect(h.installShutdown).toHaveBeenCalledWith(expect.arrayContaining([expect.anything()]));
    expect((h.installShutdown.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('VeloExpense: registers no schedules yet — its passes are /api/internal routes', async () => {
    // ExpenseOS: "registers the recurring schedules". None of ExpenseOS's schedules runs a job
    // this worker handles; when the first lands, this becomes ExpenseOS's case again.
    await boot();
    expect(h.upsertRecurring).not.toHaveBeenCalled();
  });

  it('keys every schedule on a stable jobId', async () => {
    /**
     * `upsertJobScheduler` keys on the id alone, so a re-register updates in place.
     * Without stable ids, editing a cron pattern would leave the old schedule running
     * beside the new one and the job would fire twice a day.
     */
    await boot();
    const ids = h.upsertRecurring.mock.calls.map((c) => c[0] as string);
    // VeloExpense: ExpenseOS also asserts more than ten; VeloExpense registers none yet.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every schedule an explicit timezone', async () => {
    // A cron with an implicit zone means "whatever the container thinks", which moves
    // with the host and makes a nightly job's actual hour unknowable.
    await boot();
    for (const call of h.upsertRecurring.mock.calls) {
      expect((call[3] as { tz?: string }).tz).toBeTruthy();
    }
  });
});

describe('the handler registry', () => {
  it('refuses to boot when a job on its queue has no handler', async () => {
    /**
     * The alternative is dispatching that job weeks later, burning its retries, and
     * leaving somebody to work out which of thirty handlers was never wired up.
     */
    h.queueNames = ['default'];
    h.jobQueues = { 'example.ping': 'default', 'never.wired': 'default' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await boot();
    expect(error).toHaveBeenCalledWith(
      '[worker] fatal:',
      expect.objectContaining({ message: expect.stringContaining('never.wired') }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ignores a job routed to a queue this process does not consume', async () => {
    /**
     * A second worker deployment owns that queue. Refusing to boot over somebody
     * else's job would couple the two deployments together.
     */
    h.queueNames = ['default'];
    h.jobQueues = { 'example.ping': 'default', 'someone.elses': 'other-queue' };
    await boot();
    expect(h.workers).toHaveLength(1);
    expect(h.installShutdown).toHaveBeenCalled();
  });

  it('routes a job to its handler by name', async () => {
    h.queueNames = ['default'];
    h.jobQueues = { 'example.ping': 'default' };
    await boot();
    const worker = h.workers.find((w) => w.name === 'default');
    await worker?.processor({ name: 'example.ping', data: { hello: true } });
    expect(h.handlers.handleExamplePing).toHaveBeenCalledWith({ hello: true });
  });

  it('throws for a job that arrives with no handler, naming both job and queue', async () => {
    /**
     * Reachable even with the boot check: a job enqueued by an older deployment can
     * arrive after the handler is removed, and the message has to say what it was.
     */
    h.queueNames = ['default'];
    h.jobQueues = { 'example.ping': 'default' };
    await boot();
    const worker = h.workers.find((w) => w.name === 'default');
    await expect(worker?.processor({ name: 'gone.away', data: {} })).rejects.toThrow(
      /gone.away.*default|default.*gone.away/,
    );
  });
});

describe('the whole handler registry', () => {
  /**
   * Every job name routed through the processor, not just one.
   *
   * The registry is twenty-four lines of `'name': (data) => handler(data as never)`, which
   * is the shape that invites a copy-paste error: two names pointing at the same handler.
   * Every existing assertion still passes when that happens — one worker per queue, a
   * shutdown drain, stable jobIds — and the wrong work runs for one of the two jobs. Only
   * walking the whole table catches it, and `as never` on each payload means the compiler
   * will not.
   */
  const REGISTRY: Array<[string, string]> = [
    ['example.ping', 'handleExamplePing'],
    // VeloExpense: ExpenseOS's other twenty-three rows return as their handlers are ported
    // (the three extraction jobs with w3-02).
  ];

  it('routes every job name to its own handler, with the payload untouched', async () => {
    /**
     * The payload reaches its handler unchanged. ONE handler also receives the job
     * itself — `handleExtractReceipt`, because a transient failure is re-thrown for
     * BullMQ to retry and only `attemptsMade` says whether this is the last go, which
     * is the difference between settling as FAILED and waiting for ever.
     *
     * Asserted per-handler rather than uniformly, so neither half can rot: dropping the
     * job from extraction fails here, and quietly handing it to a handler that has no
     * business reading it fails here too.
     */
    h.queueNames = ['default'];
    h.jobQueues = Object.fromEntries(REGISTRY.map(([name]) => [name, 'default']));
    await boot();
    const worker = h.workers.find((w) => w.name === 'default');
    for (const [name, handler] of REGISTRY) {
      const data = { job: name };
      const job = { name, data };
      await worker?.processor(job);
      if (handler === 'handleExtractReceipt') {
        expect(h.handlers[handler], `${name} → ${handler}`).toHaveBeenCalledWith(data, job);
      } else {
        expect(h.handlers[handler], `${name} → ${handler}`).toHaveBeenCalledWith(data);
      }
    }
  });

  it('gives each job a handler nothing else uses', async () => {
    /** The copy-paste failure stated directly: two names, one handler. */
    expect(new Set(REGISTRY.map(([, handler]) => handler)).size).toBe(REGISTRY.length);
  });

  it('covers every job the queue map declares', async () => {
    /**
     * The other direction, and the reason `main` refuses to boot on a gap: a job added to
     * `JOB_QUEUES` without a handler is only discovered when one is enqueued. This table
     * has to keep pace, so it asserts it does.
     */
    const { JOB_QUEUES } = await import('@expenseos/jobs');
    h.queueNames = ['default'];
    h.jobQueues = JOB_QUEUES as Record<string, string>;
    const declared = Object.keys(JOB_QUEUES as Record<string, string>).sort();
    expect(REGISTRY.map(([name]) => name).sort()).toEqual(declared);
  });
});

describe('what a queue reports about itself', () => {
  /**
   * The three listeners are the only operational visibility a queue has: without them a
   * job that fails twenty times is indistinguishable from one that never arrived. They are
   * also the easiest place to put a crash — `job.name` on an undefined job — which would
   * take down the worker while it was reporting somebody else's failure.
   */
  beforeEach(() => {
    h.queueNames = ['default'];
    h.jobQueues = { 'example.ping': 'default' };
  });

  it('logs a completion with the job name and id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot();
    h.workers[0].listeners.completed?.({ name: 'example.ping', id: '1' });
    expect(log.mock.calls.some((c) => String(c[0]).includes('example.ping'))).toBe(true);
  });

  it('logs a failure with the attempt count, so a retry storm is visible', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot();
    h.workers[0].listeners.failed?.(
      { name: 'example.ping', id: '1', attemptsMade: 3 },
      new Error('boom'),
    );
    const line = String(err.mock.calls.at(-1)?.[0]);
    expect(line).toContain('example.ping');
    expect(line).toContain('attempt=3');
    expect(line).toContain('boom');
  });

  it('survives a failure event with no job attached', async () => {
    /**
     * BullMQ emits `failed` with an undefined job when the failure happened before the
     * job could be fetched. Reading `job.name` there would throw inside the reporter and
     * take the worker down while it was reporting somebody else's problem.
     */
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot();
    expect(() =>
      h.workers[0].listeners.failed?.(undefined, new Error('lost the connection')),
    ).not.toThrow();
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('lost the connection');
  });

  it('logs a worker-level error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot();
    h.workers[0].listeners.error?.(new Error('redis gone'));
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('redis gone');
  });

  it('names the queue in every line, since one process runs several', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot();
    h.workers[0].listeners.completed?.({ name: 'example.ping', id: '1' });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('default');
  });
});

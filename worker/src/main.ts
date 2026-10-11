import './lib/env';

import {
  getJobsConnection,
  JOB_QUEUES,
  type JobName,
  QUEUE_CONFIG,
  QUEUE_NAMES,
  type QueueName,
  upsertRecurring,
} from '@expenseos/jobs';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import { handleExamplePing } from './handlers/example';
import { handleExtractReceipt } from './handlers/extract-receipt';
// VeloExpense: ExpenseOS's other handlers are not imported — their jobs are not in the job
// map (packages/jobs/src/jobs.ts says where each went). The batch and joint-determination
// handlers arrive with w3-02b.
import { installShutdown } from './lib/shutdown';
import { inTenant } from './lib/tenant';

/**
 * Handler registry. Each entry takes the typed payload for its job
 * and returns the job result (or void). Add new jobs here as their
 * handlers land.
 */
/**
 * The job itself is passed alongside its payload, because one handler needs to know how
 * many attempts are left: a transient extraction failure is re-thrown so BullMQ retries
 * it, and on the LAST attempt it has to settle as FAILED instead of staying PENDING for
 * ever. Every other handler ignores the second argument.
 */
const HANDLERS: { [N in JobName]?: (data: unknown, job: Job) => Promise<unknown> } = {
  'example.ping': (data) => handleExamplePing(data as never),
  // VeloExpense: a tenant's job runs as that tenant (`inTenant`, ./lib/tenant).
  'expense.extractReceipt': (data, job) =>
    inTenant(data, () => handleExtractReceipt(data as never, job)),
};

/**
 * Recurring jobs registered on every worker boot via upsertJobScheduler,
 * which keys on `jobId` alone — so re-registering on each boot is idempotent
 * even when a pattern/tz is later edited (no orphaned legacy schedule).
 */
interface RecurringJob {
  name: JobName;
  data: unknown;
  jobId: string;
  pattern: string;
  tz?: string;
}

/**
 * VeloExpense: none yet. Every ExpenseOS schedule here runs a job VeloExpense does not route
 * through this worker — its notification, approval, ledger and compliance passes are the
 * `/api/internal/*` routes EventBridge Scheduler calls (infrastructure/cdk config.ts
 * `schedules`). Receipt chasing (w3-05) is the first that will land here.
 */
const RECURRING_JOBS: RecurringJob[] = [];

async function registerRecurringJobs(): Promise<void> {
  for (const rj of RECURRING_JOBS) {
    // upsertJobScheduler keys on jobId alone, so editing a pattern/tz updates
    // the existing schedule in place instead of orphaning it (see upsertRecurring).
    // biome-ignore lint/suspicious/noExplicitAny: typed JobMap requires the call site to know its name+data pair.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same suppression, for ESLint.
    await upsertRecurring(rj.jobId, rj.name as any, rj.data as any, {
      pattern: rj.pattern,
      tz: rj.tz,
    });
    console.log(`[worker] recurring  ${rj.name}  pattern="${rj.pattern}"  tz=${rj.tz ?? 'UTC'}`);
  }
}

function startWorkerFor(queueName: QueueName): Worker {
  const config = QUEUE_CONFIG[queueName];

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const handler = HANDLERS[job.name as JobName];
      if (!handler) {
        throw new Error(`No handler registered for job "${job.name}" on queue "${queueName}"`);
      }
      return handler(job.data, job);
    },
    {
      // Cast: see enqueue.ts — BullMQ's ConnectionOptions type pins an older
      // ioredis than the workspace resolves; the instances are compatible.
      connection: getJobsConnection() as ConnectionOptions,
      concurrency: config.defaultConcurrency,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[${queueName}] ✓ ${job.name} ${job.id}`);
  });
  worker.on('failed', (job, err) => {
    console.error(
      `[${queueName}] ✗ ${job?.name} ${job?.id} attempt=${job?.attemptsMade} — ${err.message}`,
    );
  });
  worker.on('error', (err) => {
    console.error(`[${queueName}] error: ${err.message}`);
  });

  return worker;
}

/** Fail fast at boot if any job mapped to a queue this worker processes lacks a
 *  handler — otherwise such a job would only fail at first dispatch (burning
 *  retries / dead-lettering). Guards against JobMap/HANDLERS drift. */
function assertHandlersComplete(): void {
  const processed = new Set<QueueName>(QUEUE_NAMES);
  const missing = (Object.entries(JOB_QUEUES) as [JobName, QueueName][])
    .filter(([name, queue]) => processed.has(queue) && !HANDLERS[name])
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`No handler registered for job(s): ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  console.log(`[worker] starting — queues: ${QUEUE_NAMES.join(', ')}  node=${process.version}`);
  assertHandlersComplete();
  const workers = QUEUE_NAMES.map(startWorkerFor);
  await Promise.all(workers.map((w) => w.waitUntilReady()));
  await registerRecurringJobs();
  console.log('[worker] ready');
  installShutdown(workers);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});

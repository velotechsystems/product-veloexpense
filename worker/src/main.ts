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
import { handleDetermineExpense } from './handlers/determine-expense';
import { handleExamplePing } from './handlers/example';
import { handleExpenseReceiptChase } from './handlers/expense-receipt-chase';
import { handleExtractReceipt } from './handlers/extract-receipt';
import { handleExtractReceiptBatch } from './handlers/extract-receipt-batch';
import { handleIngestReceiptEmail } from './handlers/ingest-receipt-email';
// VeloExpense: ExpenseOS's other handlers are not imported — their jobs are not in the job
// map (packages/jobs/src/jobs.ts says where each went).
import { installShutdown } from './lib/shutdown';
import { fanOutToTenants, inTenant } from './lib/tenant';

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
  'expense.extractReceipt.batch': (data) =>
    inTenant(data, () => handleExtractReceiptBatch(data as never)),
  'expense.determineExpense': (data) => inTenant(data, () => handleDetermineExpense(data as never)),
  // VeloExpense: the schedule's run names no tenant and only fans out, one job per tenant;
  // each of those runs as its tenant.
  'expense.receiptChase': (data) =>
    (data as { organizationId?: string } | null)?.organizationId
      ? inTenant(data, () => handleExpenseReceiptChase(data as never))
      : fanOutToTenants('expense.receiptChase', { trigger: 'cron' }),
  // VeloExpense (w3-06): as the tenant whose address the email was sent to (d47).
  'email.ingestReceipts': (data) => inTenant(data, () => handleIngestReceiptEmail(data as never)),
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
 * VeloExpense: ExpenseOS's receipt chase only, so far. Every other ExpenseOS schedule here runs
 * a job VeloExpense does not route through this worker — its notification, approval, ledger
 * and compliance passes are the `/api/internal/*` routes EventBridge Scheduler calls
 * (infrastructure/cdk config.ts `schedules`).
 */
const RECURRING_JOBS: RecurringJob[] = [
  {
    name: 'expense.receiptChase',
    data: { trigger: 'cron' },
    jobId: 'expense-receipt-chase-daily',
    // Daily at 13:00 UTC (morning in North America) — a nudge that lands
    // mid-morning gets acted on; one that lands overnight is buried by the
    // time anyone reads it.
    pattern: '0 13 * * *',
    tz: 'UTC',
  },
];

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

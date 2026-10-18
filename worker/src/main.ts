import './lib/env';

import {
  getJobsConnection,
  JOB_QUEUES,
  type JobName,
  QUEUE_CONFIG,
  QUEUE_NAMES,
  type QueueName,
  enqueue,
  upsertRecurring,
} from '@expenseos/jobs';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import { handleApprovalSweep } from './handlers/approval-sweep';
import { handleAuditPurge } from './handlers/audit-purge';
import { handleDirectorySync } from './handlers/directory-sync';
import { handleDetermineExpense } from './handlers/determine-expense';
import { handleExamplePing } from './handlers/example';
import { handleExpenseReceiptChase } from './handlers/expense-receipt-chase';
import { handleExtractReceipt } from './handlers/extract-receipt';
import { handleExtractReceiptBatch } from './handlers/extract-receipt-batch';
import { handleIngestReceiptEmail } from './handlers/ingest-receipt-email';
import { handleIngestReplyEmail } from './handlers/ingest-reply-email';
import { handleNotificationPrune } from './handlers/notification-prune';
import { handleReceiptsSummaryEmail } from './handlers/receipts-summary-email';
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
  // VeloExpense (w4-00c): as `expense.receiptChase` — the schedule's run fans out per tenant.
  'approval.sweepExpired': (data) =>
    (data as { organizationId?: string } | null)?.organizationId
      ? inTenant(data, () => handleApprovalSweep(data as never))
      : fanOutToTenants('approval.sweepExpired', {
          trigger: (data as { trigger?: 'cron' | 'manual' | 'boot' } | null)?.trigger ?? 'cron',
        }),
  // w5-07: ExpenseOS's housekeeping — as `expense.receiptChase`, the schedule's run fans out
  // per tenant and each tenant's job runs as that tenant.
  'notification.prune': (data) =>
    (data as { organizationId?: string } | null)?.organizationId
      ? inTenant(data, () => handleNotificationPrune(data as never))
      : fanOutToTenants('notification.prune', { trigger: 'cron' }),
  'audit.purge': (data) =>
    (data as { organizationId?: string } | null)?.organizationId
      ? inTenant(data, () => handleAuditPurge(data as never))
      : fanOutToTenants('audit.purge', { trigger: 'cron' }),
  // w5-04: ExpenseOS's directory sync, as `audit.purge` — the schedule's run fans out per
  // tenant; each tenant's job (or an admin's "Sync now") runs as that tenant.
  'integration.google.directorySync': (data) =>
    (data as { organizationId?: string } | null)?.organizationId
      ? inTenant(data, () => handleDirectorySync(data as never))
      : fanOutToTenants('integration.google.directorySync', { trigger: 'cron' }),
  // VeloExpense (w3-06): as the tenant whose address the email was sent to (d47).
  'email.ingestReceipts': (data) => inTenant(data, () => handleIngestReceiptEmail(data as never)),
  // w5-01: a reply to a notification email, as a comment.
  'email.ingestReply': (data) => inTenant(data, () => handleIngestReplyEmail(data as never)),
  // VeloExpense: as the tenant the receipts were filed in, like the ingest job.
  'email.receiptsSummary': (data) =>
    inTenant(data, () => handleReceiptsSummaryEmail(data as never)),
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
 * VeloExpense: ExpenseOS's receipt chase, approval sweep, (w5-07) notification prune and
 * audit purge, and (w5-04) directory sync, so far. Every other ExpenseOS
 * schedule here runs a job VeloExpense does not route through this worker — its notification,
 * ledger and compliance passes are the `/api/internal/*` routes EventBridge Scheduler calls
 * (infrastructure/cdk config.ts `schedules`).
 */
const RECURRING_JOBS: RecurringJob[] = [
  {
    name: 'approval.sweepExpired',
    data: { trigger: 'cron' },
    jobId: 'approval-sweep-expired-hourly',
    // Hourly — deadlines are day-grained, so an hourly sweep keeps expiry and
    // "due soon" reminders timely without hammering the DB.
    pattern: '0 * * * *',
    tz: 'UTC',
  },
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
  // w5-07: ExpenseOS's two housekeeping schedules, at ExpenseOS's times.
  {
    name: 'notification.prune',
    data: { trigger: 'cron' },
    jobId: 'notification-prune-daily',
    pattern: '0 2 * * *',
    tz: 'UTC',
  },
  {
    name: 'audit.purge',
    data: { trigger: 'cron' },
    jobId: 'audit-purge-daily',
    pattern: '30 3 * * *',
    tz: 'UTC',
  },
  // w5-04: ExpenseOS's directory sync, at ExpenseOS's time.
  {
    name: 'integration.google.directorySync',
    data: { trigger: 'cron' },
    jobId: 'directory-sync-daily',
    pattern: '0 3 * * *', // every day at 03:00 UTC
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
  // VeloExpense (w4-00c): one approval sweep at boot, so a deadline that passed while the worker
  // was down is acted on now rather than at the next hour. (It also ran the cutover's recall,
  // d52, until w4-00d.) Idempotent: a sweep with nothing to do does nothing.
  await enqueue('approval.sweepExpired', { trigger: 'boot' });
  console.log('[worker] ready');
  installShutdown(workers);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});

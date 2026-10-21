/**
 * @expenseos/jobs — typed BullMQ enqueue surface shared by the web app
 * and worker/.
 *
 * Usage (from a tRPC mutation):
 *
 *   import { enqueue } from '@expenseos/jobs';
 *   await enqueue('notification.dispatch', { notificationId });
 *
 * Usage (from the worker — Worker class itself is imported direct
 * from bullmq; see worker/src/main.ts):
 *
 *   import { getJobsConnection, QUEUE_CONFIG, QUEUE_NAMES } from '@expenseos/jobs';
 *   new Worker(name, handler, { connection: getJobsConnection(), concurrency });
 *
 * Adding a new job:
 *   1. Add a line to JobMap in src/jobs.ts (name + payload type).
 *   2. Map it to a queue in JOB_QUEUES.
 *   3. Write the handler in worker/src/handlers/.
 *   4. Register the handler in worker/src/main.ts.
 */

export { getJobsConnection } from './connection';
export { type EnqueueOptions, enqueue, removeStaleSchedulers, upsertRecurring } from './enqueue';
export { JOB_QUEUES, type JobMap, type JobName } from './jobs';
export { QUEUE_CONFIG, QUEUE_NAMES, type QueueName, type QueueOptions } from './queues';

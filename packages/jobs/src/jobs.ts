import type { QueueName } from './queues';

/**
 * Typed registry of background jobs. Adding a new job is a single-line
 * change here — the `enqueue<N>()` call site picks up the new name +
 * payload type, and the worker handler must match the JobMap signature.
 *
 * Conventions:
 *   - `<module>.<action>` (dotted, lowercase, camelCase action).
 *   - Payload carries only entity IDs (and tiny context flags). The
 *     handler loads everything else from the DB / S3. Keeps Redis
 *     small and survives schema evolution.
 */
export interface JobMap {
  /** Smoke / health-check job. Used by scripts/jobs-smoke.mjs. */
  'example.ping': { message: string };

  // VeloExpense: ExpenseOS's other jobs are not here. Each arrives with its handler, as the
  // boot check in worker/src/main.ts requires, and most never will: VeloExpense's
  // notifications, approval sweeps, ledger posts and compliance passes run as
  // `/api/internal/*` routes on a schedule (infrastructure/cdk config.ts `schedules`). The
  // extraction jobs (`expense.extractReceipt`, `expense.extractReceipt.batch`,
  // `expense.determineExpense`) come with w3-02.
}

export type JobName = keyof JobMap;

/** Job name → which queue carries it. */
export const JOB_QUEUES: Record<JobName, QueueName> = {
  'example.ping': 'housekeeping',
};

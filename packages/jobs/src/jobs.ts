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

  /** AV-scan → HEIC-normalize → Claude-vision extract one uploaded receipt.
   *  Enqueued by expenses.receiptCreate. Outcome lands on the
   *  DocumentExtraction satellite; success best-effort-prefills the Expense.
   *  Never throws on business failure — the blank Expense + file always survive.
   *  `scanAttempt` counts self-re-enqueues while the GuardDuty malware scan is
   *  still in progress (0/absent on the first enqueue).
   *
   *  VeloExpense: `organizationId` names the tenant the job runs as. ExpenseOS's worker
   *  reads every tenant through one client; VeloExpense's runs each job under the tenant's
   *  RLS scope (`withTenantStatements`), so the payload carries it. */
  'expense.extractReceipt': { organizationId: string; receiptId: string; scanAttempt?: number };

  /** Extract SEVERAL receipts uploaded together in one Anthropic Message Batch
   *  (~50% cheaper, async) — enqueued by expenses.startExtraction when >1 file
   *  lands at once. Two-phase state machine carried in the payload: submit
   *  (no `batchId`) scans/normalizes + submits ready docs; poll (`batchId` set)
   *  re-polls until the batch ends, then finalizes + prefills each. `model` is
   *  carried from submit → poll so results stamp the model that produced them.
   *  A lone ready receipt degrades to one synchronous message.
   *
   *  VeloExpense: `organizationId`, as on every receipt job (above). */
  'expense.extractReceipt.batch': {
    organizationId: string;
    receiptIds: string[];
    batchId?: string;
    model?: string;
    scanAttempt?: number;
    pollAttempt?: number;
  };

  /** Re-determine ONE expense from its WHOLE document set (rule 2). Enqueued by
   *  expenses.receiptCreate / receiptDelete once an expense holds more than one
   *  document, and by the extraction handler after a second file's own pass
   *  finishes. Reads every document together, then WIPES and rebuilds the
   *  expense's header, lines, tip, tax and FX — replaying the human's recorded
   *  corrections on top. One document needs no joint pass, so that case never
   *  enqueues this. Never throws on business failure.
   *
   *  VeloExpense: `organizationId`, as on every receipt job (above). */
  'expense.determineExpense': { organizationId: string; expenseId: string };

  // VeloExpense: ExpenseOS's other jobs are not here. Each arrives with its handler, as the
  // boot check in worker/src/main.ts requires, and most never will: VeloExpense's
  // notifications, approval sweeps, ledger posts and compliance passes run as
  // `/api/internal/*` routes on a schedule (infrastructure/cdk config.ts `schedules`).
}

export type JobName = keyof JobMap;

/** Job name → which queue carries it. */
export const JOB_QUEUES: Record<JobName, QueueName> = {
  'example.ping': 'housekeeping',
  'expense.extractReceipt': 'integrations',
  'expense.extractReceipt.batch': 'integrations',
  'expense.determineExpense': 'integrations',
};

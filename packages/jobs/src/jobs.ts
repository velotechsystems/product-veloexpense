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

  /** Sweep approval tasks past their deadline: apply each task's onExpire
   *  policy (escalate/reject/approve) and send "deadline approaching"
   *  reminders. Recurring; can also be triggered ad-hoc.
   *
   *  VeloExpense (w4-00c): plus `organizationId`, as `expense.receiptChase` — the schedule's
   *  run names no tenant and only fans out, one job per tenant. */
  'approval.sweepExpired': { trigger?: 'cron' | 'manual' | 'boot'; organizationId?: string };

  /** Daily: remind submitters about draft expenses that still have no receipt.
   *
   *  VeloExpense (w3-05): ExpenseOS's job, plus `organizationId`. The schedule fires it
   *  without one, and that run only fans out: one job per active tenant, each naming its
   *  tenant, which the worker runs under that tenant's RLS scope like every other job. */
  'expense.receiptChase': { trigger?: 'cron' | 'manual'; organizationId?: string };

  /** Turn one inbound receipt email into an expense report.
   *
   *  Enqueued by POST /api/email/inbound after the SNS signature, the topic and the SES
   *  authentication verdicts have been checked and the SES message id claimed once. The raw
   *  MIME is NOT in the payload — SES stored it in the inbound-mail bucket (its SNS action
   *  caps out around 150KB, which one phone photo exceeds), so the handler reads the object
   *  and does everything slow: parse, filter attachments, create or append the report,
   *  write each receipt, enqueue extraction, acknowledge by email.
   *
   *  Deliberately off the request path: SNS redelivers a non-2xx, and a slow handler would
   *  be redelivered as a duplicate report.
   *
   *  VeloExpense (w3-06): plus `organizationId`, the tenant whose address the email was sent
   *  to (d47). The sender is looked up inside it only, and the job runs as it. `token` is
   *  carried but not yet read: replying to add receipts arrives with reply threads (w5-01,
   *  d48). */
  'email.ingestReceipts': {
    /** Where SES put the raw message. */
    bucket: string;
    objectKey: string;
    /** SES's own message id — the dedup key already claimed by the route, carried so the
     *  handler can key its audit rows and log line to the same identity. */
    sesMessageId: string;
    /** Which mailbox it arrived at, resolved from the envelope/headers by the route. */
    mailbox: 'receipts';
    /**
     * The From address the route AUTHENTICATED — tied to the domain that passed SPF/DKIM,
     * lowercased. The handler files the claim as this person and refuses the message if
     * the MIME it parses names anyone else, so the identity decision is made once, at the
     * gate, and never re-derived from headers an outsider wrote.
     */
    claimant: string;
    /** The reply token, when the message was addressed to receipts+<token>@ — meaning add
     *  to an existing report rather than start a new one. */
    token?: string;
    organizationId: string;
  };

  /**
   * w5-01 — a reply to a notification email, to become a COMMENT on its subject.
   *
   * ExpenseOS reads and posts these in the inbound route itself. VeloExpense (decided 17 Oct
   * 2026): the route checks the sender and hands the stored message here, as it does the
   * receipts mailbox's, so only the worker reads the inbound-mail bucket.
   */
  'email.ingestReply': {
    /** Where SES put the raw message. */
    bucket: string;
    objectKey: string;
    /** SES's message id — the dedup key the route already claimed. */
    sesMessageId: string;
    /** The raw token from `reply+<token>@`: the thread, and the proof of who was addressed. */
    token: string;
    /** The From the route AUTHENTICATED, lowercased. It must be the thread's recipient. */
    sender: string;
    /** The tenant the address named; the job runs as it. */
    organizationId: string;
  };

  /** The acknowledgement for one receipts email, sent once its receipts have been read.
   *
   *  Enqueued (delayed) by `email.ingestReceipts` in place of an immediate "filed" reply,
   *  because the two things the reader most wants — the total and who approves it — do not
   *  exist until the receipts are read: the total is 0.00 and the approval route depends on
   *  it. The handler checks the email's receipts, re-enqueues itself while any is still
   *  being read, and sends anyway once `waitUntil` passes, saying which receipts were not
   *  read in time. The job id is derived from the SES message id plus `attempt`, so one
   *  email yields one summary however the ingest job is retried. */
  'email.receiptsSummary': {
    reportId: string;
    /** The receipts THIS email filed — not every receipt on the report, which a reply to an
     *  earlier summary may have added to. */
    receiptIds: string[];
    /** The person who emailed them; the summary goes to their address, in their locale. */
    userId: string;
    /** The authenticated From, lowercased — where the summary is sent. */
    to: string;
    /** The token-scoped receipts address replies should land on, when one exists. */
    replyAddress?: string;
    /** Threading headers, so the summary sits under the email it answers. */
    inReplyTo?: string;
    references?: string;
    /** SES message id of the email, the stem of every job id in this chain. */
    sesMessageId: string;
    /** 0 on the first run; each re-check while receipts are still being read adds 1. */
    attempt: number;
    /** Epoch ms after which the summary goes out whether or not every receipt is read. */
    waitUntil: number;
    /** VeloExpense: the tenant the receipts were filed in; the job runs as it, as
     *  `email.ingestReceipts` does (d47). */
    organizationId: string;
  };

  // VeloExpense: ExpenseOS's other jobs are not here. Each arrives with its handler, as the
  // boot check in worker/src/main.ts requires, and most never will: VeloExpense's
  // notifications, ledger posts and compliance passes run as `/api/internal/*` routes on a
  // schedule (infrastructure/cdk config.ts `schedules`).
}

export type JobName = keyof JobMap;

/** Job name → which queue carries it. */
export const JOB_QUEUES: Record<JobName, QueueName> = {
  'example.ping': 'housekeeping',
  'expense.extractReceipt': 'integrations',
  'expense.extractReceipt.batch': 'integrations',
  'expense.determineExpense': 'integrations',
  'approval.sweepExpired': 'housekeeping',
  'expense.receiptChase': 'housekeeping',
  'email.ingestReceipts': 'integrations',
  'email.ingestReply': 'notifications',
  'email.receiptsSummary': 'notifications',
};

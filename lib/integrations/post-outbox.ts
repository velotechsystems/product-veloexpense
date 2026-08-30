/**
 * VX3-4 — the ledger post queue: enqueue on approval, claim, post, record.
 *
 * Retry policy comes from `lib/outbox/policy.ts`, shared with VX2-8's mail
 * outbox. Findings: GAP-AUDIT AC-6, AC-7, AC-8.
 *
 * ── Four properties this file is responsible for ────────────────────────────
 *
 * 1. THE ENQUEUE IS A ROW IN THE APPROVING TRANSACTION. Not a fire-and-forget
 *    job. ExpenseOS's `postApprovedReport` returns void, wraps itself in
 *    `void (async () => …)().catch(log)`, and enqueues with `attempts: 1` —
 *    reasonably, because an approval must not fail over a Redis hiccup. A row in
 *    the same transaction cannot be lost, so the trade is not needed and neither
 *    is the 30-minute cron sweep that compensates for it (AC-7).
 * 2. ONE POST PER REPORT, unrepresentable rather than guarded — `0017` has the
 *    unique key.
 * 3. THE CLAIM IS A CONDITIONAL WRITE. Sixth appearance of the idiom in this
 *    codebase; `rowCount !== 1` means somebody else took it.
 * 4. `NEEDS_REVIEW` IS NEVER RETRIED AUTOMATICALLY. It means the ledger accepted
 *    the bill and writing that down here failed. AC-8: ExpenseOS writes that
 *    situation as a retryable FAILED row with "do NOT re-post" in its error
 *    column, and its sweep then re-posts it five times. An instruction to a human
 *    is not a guard.
 */
import type { QueryRunner } from '@/lib/db/client';
import { withPlatformRead } from '@/lib/tenant/context';
import { backoffSecondsFor, isExhausted, CLAIM_TIMEOUT_SECONDS } from '@/lib/outbox/policy';

const ORG = "current_setting('app.current_org', true)::uuid";

export type PostStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'DEAD' | 'CANCELLED' | 'NEEDS_REVIEW';

export interface PostRow {
  id: string;
  report_id: string;
  installation_id: string | null;
  status: PostStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  external_id: string | null;
  posted_at: Date | null;
  /** Joined for the admin screen. */
  report_number: string | null;
  report_title: string | null;
  total_minor: string | null;
  currency_code: string | null;
}

const SELECT_POST = `
  SELECT p.id, p.report_id, p.installation_id, p.status, p.attempts, p.next_attempt_at,
         p.last_error, p.external_id, p.posted_at,
         r.number AS report_number, r.title AS report_title,
         r.total_minor, r.currency_code
    FROM integration_post p
    JOIN expense_report r ON r.id = p.report_id`;

/**
 * Queue a report for posting. Called from `lifecycle.ts`, INSIDE the transaction
 * that moved the report to APPROVED and wrote its audit row.
 *
 * ON CONFLICT DO NOTHING rather than an error: AC-6 records that ExpenseOS needed
 * FOUR call sites plus a cron sweep because its trigger hung off callers, and one
 * of those was added after a report that auto-approved on submit was "silently
 * never sent to NetSuite". Here the enqueue sits on the transition, so a second
 * caller is a belt-and-braces duplicate rather than a bug — and it must be
 * harmless, not fatal, or adding a caller becomes a way to break approval.
 */
export async function enqueuePost(tx: QueryRunner, reportId: string): Promise<void> {
  await tx.query(
    `INSERT INTO integration_post (organization_id, report_id, idempotency_key)
     VALUES (${ORG}, $1, $2)
     ON CONFLICT (organization_id, report_id) DO NOTHING`,
    [reportId, `veloexpense-report-${reportId}`],
  );
}

/**
 * The idempotency key is DERIVED FROM THE REPORT ID and never regenerated.
 *
 * That is the whole point: VeloLedger namespaces it per API key and refuses a
 * second bill carrying the same one, so a retry after an ambiguous failure cannot
 * double-post at the far end. A key that changed per attempt would make the
 * mechanism decorative.
 */
export function idempotencyKeyFor(reportId: string): string {
  return `veloexpense-report-${reportId}`;
}

export async function listQueue(
  tx: QueryRunner,
  status?: PostStatus,
): Promise<PostRow[]> {
  const r = status
    ? await tx.query(`${SELECT_POST} WHERE p.status = $1 ORDER BY p.created_at`, [status])
    : await tx.query(`${SELECT_POST} ORDER BY p.created_at`);
  return r.rows as PostRow[];
}

export async function queueSummary(tx: QueryRunner): Promise<Record<PostStatus, number>> {
  const r = await tx.query('SELECT status, count(*)::int AS n FROM integration_post GROUP BY status');
  const out: Record<PostStatus, number> = {
    PENDING: 0,
    POSTED: 0,
    FAILED: 0,
    DEAD: 0,
    CANCELLED: 0,
    NEEDS_REVIEW: 0,
  };
  for (const row of r.rows) out[row.status as PostStatus] = row.n as number;
  return out;
}

/**
 * Due work across every tenant, for the poller.
 *
 * Reached through `withPlatformRead`, whose narrowed policy in `0017` is SELECT
 * only and matches PENDING/FAILED rows that are due — so NEEDS_REVIEW and DEAD are
 * invisible here by the database's own rule, not by this query remembering to
 * exclude them.
 */
export async function duePosts(limit = 50): Promise<Array<{ id: string; organizationId: string }>> {
  return withPlatformRead(async (tx) => {
    const r = await tx.query(
      `SELECT id, organization_id
         FROM integration_post
        WHERE (claimed_at IS NULL
               OR claimed_at < clock_timestamp() - make_interval(secs => $2::int))
        ORDER BY next_attempt_at
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200), CLAIM_TIMEOUT_SECONDS],
    );
    return r.rows.map((row) => ({
      id: row.id as string,
      organizationId: row.organization_id as string,
    }));
  });
}

export interface ClaimedPost {
  id: string;
  reportId: string;
  attempts: number;
}

/**
 * Take a row, or find that somebody else did.
 *
 * The conditional write is the guard: the status and the claim window are
 * re-asserted in the same statement that takes the row, so two pollers cannot both
 * proceed. `rowCount !== 1` is not an error — it is the normal outcome for the
 * loser of a race.
 */
export async function claimPost(tx: QueryRunner, id: string): Promise<ClaimedPost | null> {
  const claimant = `${process.pid}@${new Date().toISOString()}`;
  const r = await tx.query(
    `UPDATE integration_post
        SET claimed_at = clock_timestamp(), claimed_by = $2, updated_at = clock_timestamp()
      WHERE id = $1
        AND status IN ('PENDING', 'FAILED')
        AND next_attempt_at <= clock_timestamp()
        AND (claimed_at IS NULL
             OR claimed_at < clock_timestamp() - make_interval(secs => $3::int))
      RETURNING report_id, attempts`,
    [id, claimant, CLAIM_TIMEOUT_SECONDS],
  );
  if (r.rowCount !== 1) return null;
  return {
    id,
    reportId: r.rows[0].report_id as string,
    attempts: r.rows[0].attempts as number,
  };
}

export async function markPosted(
  tx: QueryRunner,
  id: string,
  externalId: string,
  installationId: string,
): Promise<void> {
  await tx.query(
    `UPDATE integration_post
        SET status = 'POSTED', posted_at = clock_timestamp(), external_id = $2,
            installation_id = $3, attempts = attempts + 1, last_error = NULL,
            claimed_at = NULL, claimed_by = NULL, updated_at = clock_timestamp()
      WHERE id = $1`,
    [id, externalId, installationId],
  );
}

/**
 * A failure that left NOTHING at the far end, so the row stays retryable.
 *
 * Only safe for a failure the caller knows did not reach the ledger, or reached it
 * and was refused. An AMBIGUOUS failure — sent, no answer — is not this; see
 * `markNeedsReview`.
 */
export async function markFailed(tx: QueryRunner, id: string, error: string): Promise<void> {
  const r = await tx.query(
    'UPDATE integration_post SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
    [id],
  );
  if (r.rowCount !== 1) return;
  const attempts = r.rows[0].attempts as number;
  const dead = isExhausted(attempts);
  await tx.query(
    `UPDATE integration_post
        SET status = $2,
            last_error = $3,
            next_attempt_at = clock_timestamp() + make_interval(secs => $4::int),
            claimed_at = NULL, claimed_by = NULL, updated_at = clock_timestamp()
      WHERE id = $1`,
    [id, dead ? 'DEAD' : 'FAILED', error, dead ? 0 : backoffSecondsFor(attempts)],
  );
}

/**
 * The ledger accepted it and we failed to write that down.
 *
 * Terminal to every automatic path. `0017`'s `platform_read` policy does not match
 * this status, so the poller cannot see the row even if a future change forgot to
 * exclude it — which is the difference between this and AC-8's "do NOT re-post"
 * sitting in an error column where only a human could read it.
 */
export async function markNeedsReview(
  tx: QueryRunner,
  id: string,
  /**
   * NULL when the ledger never gave us one — an ambiguous failure, which is the
   * commonest way into this state. It must be NULL and not '': `0017` has a partial
   * unique index on `(organization_id, external_id) WHERE external_id IS NOT NULL`,
   * so two empty strings in one tenant collide, the second write fails, and the row
   * falls back to a retryable status. Which is the one outcome this state exists to
   * prevent. Found by reading the constraint after writing the caller.
   */
  externalId: string | null,
  error: string,
): Promise<void> {
  await tx.query(
    `UPDATE integration_post
        SET status = 'NEEDS_REVIEW', external_id = nullif($2, ''), last_error = $3,
            attempts = attempts + 1, claimed_at = NULL, claimed_by = NULL,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [id, externalId, error],
  );
}

/** An operator's decision that a DEAD or NEEDS_REVIEW row should be tried again. */
export async function retryNow(tx: QueryRunner, id: string): Promise<void> {
  // Attempts are RESET, so a human retry gets a full budget rather than one more
  // go — same choice as VX2-8's `retryNow`. `last_error` is KEPT: it is the only
  // record of why the row was stuck, and clearing it on retry loses the diagnosis
  // exactly when somebody starts investigating.
  const r = await tx.query(
    `UPDATE integration_post
        SET status = 'PENDING', attempts = 0, next_attempt_at = clock_timestamp(),
            posted_at = NULL, external_id = NULL,
            claimed_at = NULL, claimed_by = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND status IN ('FAILED', 'DEAD', 'NEEDS_REVIEW', 'CANCELLED')
      RETURNING id`,
    [id],
  );
  if (r.rowCount !== 1) {
    throw new Error('that post is not in a state that can be retried');
  }
}

/** Withhold a report from posting — an operator's decision, not a failure. */
export async function cancelPost(tx: QueryRunner, id: string, reason: string): Promise<void> {
  const r = await tx.query(
    `UPDATE integration_post
        SET status = 'CANCELLED', last_error = $2, posted_at = NULL, external_id = NULL,
            claimed_at = NULL, claimed_by = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND status <> 'POSTED'
      RETURNING id`,
    [id, reason],
  );
  if (r.rowCount !== 1) {
    throw new Error('that post is already posted, or does not exist');
  }
}

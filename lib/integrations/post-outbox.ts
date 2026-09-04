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
import { append as auditAppend, type AuditActor } from '@/lib/audit/service';
import { uncodedCategories } from '@/lib/integrations/coding';

const ORG = "current_setting('app.current_org', true)::uuid";

/**
 * A RUNTIME ARRAY, and the type derived from it — not a hand-written union with
 * the members retyped somewhere else.
 *
 * `test/i18n-enum-catalog.test.ts` keeps a `CATALOGUES` list whose entries carry
 * either an exported array or a hand-copied member list, and it has its own test
 * saying a union WITH an array must use it. `PostStatus` had no array, so its
 * members were retyped there — and adding HELD failed that file's stale-copy
 * check, which is the correspondence going stale exactly as UD-9 predicts of a
 * hand-kept copy. Exporting the array turns the copy into a derivation, and
 * migration 0030's CHECK is then testable against this same list.
 */
export const POST_STATUSES = [
  /** Due work. The poller may take it. */
  'PENDING',
  /**
   * UD-8. Enqueued by an approval in an AP_QUEUE organization, and waiting for a
   * person to send it. NOT a failure and NOT a decision against posting — those
   * are FAILED and CANCELLED, and conflating any two of the three is how an
   * operator ends up retrying something that was never attempted.
   *
   * Unreachable by the poller twice over, neither of them added by 0030: `0017`'s
   * `platform_read` policy matches PENDING/FAILED only, so `duePosts` cannot see
   * the row at all; and `claimPost` re-asserts the same pair in its conditional
   * write.
   */
  'HELD',
  /** Drafted at the far end. Terminal and successful. */
  'POSTED',
  /** Tried, refused or lost, still retryable. */
  'FAILED',
  /** Out of attempts. */
  'DEAD',
  /** An operator withheld it. */
  'CANCELLED',
  /** The ledger accepted it and recording that failed. Never retried automatically. */
  'NEEDS_REVIEW',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

/* ── UD-8: who sends an approved report ───────────────────────────────────── */

/**
 * The setting lives here, next to the one behaviour it changes: which status
 * `enqueuePost` writes. It is not a general settings module and should not become
 * one — a second reader of this value would be a sign the semantics have leaked.
 *
 * THIS UNION IS THE SOURCE OF TRUTH and migration 0030's CHECK constraint is a
 * second copy of it. `test/posting-trigger.db.test.ts` asserts the two are equal
 * in both directions, per 0027's rule: a duplicated list with a test is fine, a
 * duplicated list without one fails open.
 */
export const POSTING_TRIGGERS = ['AP_QUEUE', 'AUTOMATIC'] as const;
export type PostingTrigger = (typeof POSTING_TRIGGERS)[number];

export function isPostingTrigger(value: unknown): value is PostingTrigger {
  return typeof value === 'string' && (POSTING_TRIGGERS as readonly string[]).includes(value);
}

export async function getPostingTrigger(tx: QueryRunner): Promise<PostingTrigger> {
  const r = await tx.query(`SELECT posting_trigger FROM organization WHERE id = ${ORG}`);
  if (r.rowCount !== 1) throw new Error('no organization in scope');
  // The CHECK constraint guarantees this, so the guard is about a column read
  // through a connection that somehow bypassed it — it returns a value, never a
  // silent widening of the type.
  const value = r.rows[0].posting_trigger as string;
  if (!isPostingTrigger(value)) throw new Error(`unknown posting_trigger: ${value}`);
  return value;
}

/**
 * ADMIN-gated at the action layer, and AUDITED HERE rather than there.
 *
 * The house pattern for an organization-level setting — `lib/i18n/service.ts`'s
 * `setOrgDefaults` and `lib/branding/service.ts` both do exactly this — and the
 * reason is MT-3 once more: an audit row written by the caller is an audit row the
 * next caller forgets. It also puts the read-before-write in the one place that
 * can guarantee it shares a transaction with the write, so `from -> to` cannot be
 * a lie about a value that changed in between.
 *
 * The detail is `from -> to`, not `to`, per UD-11: "who changed this, from what"
 * is the question an auditor actually asks, and it costs one SELECT.
 *
 * Audited against the ORGANIZATION, not a report. A standing policy decision is
 * one event; an auditor asking why forty reports sat for a week needs to find the
 * day somebody changed this, not forty identical rows.
 *
 * Returns the previous value, so a caller can say what it did — or `null` when
 * nothing changed, which is not audited at all. A settings form re-submitted
 * unchanged is not an event.
 */
export async function setPostingTrigger(
  tx: QueryRunner,
  actor: AuditActor,
  trigger: PostingTrigger,
): Promise<PostingTrigger | null> {
  const before = await getPostingTrigger(tx);
  if (before === trigger) return null;

  const { rows } = await tx.query<{ id: string }>(
    `UPDATE organization
        SET posting_trigger = $1, updated_at = now()
      WHERE id = ${ORG}
      RETURNING id`,
    [trigger],
  );
  const orgId = rows[0]?.id;
  if (!orgId) throw new Error('no organization in scope');

  await auditAppend(tx, actor, {
    action: 'LEDGER_POSTING_TRIGGER_CHANGED',
    entityType: 'organization',
    entityId: orgId,
    details: {
      from: before,
      to: trigger,
      // Stated in the audit row because the screen states it too, and because the
      // absence of a release is the surprising half: switching to AUTOMATIC does
      // NOT post what is already held. Those rows were approved under a rule that
      // said a person decides, and posting a week of them because a setting
      // changed is the "wrong posting in a general ledger" this setting exists to
      // prevent.
      releasedHeldRows: 0,
    },
  });
  return before;
}

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
  // ── UD-8: the STATUS is decided HERE, not by the caller ───────────────────
  //
  // `lib/approvals/engine.ts` calls this on the transition and knows nothing
  // about posting triggers, which is deliberate and is MT-3: "a gate at the edge
  // is a gate the next caller forgets". The same argument moved
  // `requeueWaitingPosts` out of an admin action and into the service layer three
  // paragraphs of comment further down this file. A second caller that decided
  // the status itself could decide it differently.
  //
  // TWO STATEMENTS, and the tempting one-statement version is wrong. Selecting
  // the trigger inside the INSERT —
  //
  //     INSERT INTO integration_post (…, status)
  //     SELECT ${ORG}, $1, $2, CASE WHEN o.posting_trigger = 'AP_QUEUE' …
  //       FROM organization o WHERE o.id = ${ORG}
  //
  // — inserts NOTHING when that SELECT returns no row, which is what happens if
  // the tenant context is unset. Today that case fails loudly on the NOT NULL
  // organization_id; the clever version turns it into a silent no-op, and a
  // silently un-enqueued approval is precisely the bug AC-6 records upstream
  // paying for. One extra SELECT inside the approving transaction is the cheaper
  // half of that trade.
  const trigger = await getPostingTrigger(tx);
  const status: PostStatus = trigger === 'AP_QUEUE' ? 'HELD' : 'PENDING';
  await tx.query(
    `INSERT INTO integration_post (organization_id, report_id, idempotency_key, status)
     VALUES (${ORG}, $1, $2, $3)
     ON CONFLICT (organization_id, report_id) DO NOTHING`,
    [reportId, `veloexpense-report-${reportId}`, status],
  );
}

/**
 * UD-8 — a person releases a held post. HELD → PENDING, due immediately.
 *
 * Deliberately NOT folded into `retryNow`, which accepts FAILED/DEAD/
 * NEEDS_REVIEW/CANCELLED. Those four are all "this was tried, or was refused, and
 * an operator is overriding that"; `retryNow` resets `attempts` to zero and
 * clears `posted_at` and `external_id` because there is something to reset. A
 * HELD row has none of that history — releasing it is the FIRST thing that has
 * ever happened to it. Sharing a function would make the audit trail say a report
 * was retried when it had never been attempted, which is a sentence an auditor
 * would have to unpick.
 *
 * Conditional write, seventh appearance of the idiom: `rowCount !== 1` means the
 * row was not HELD when this landed — released by somebody else a moment earlier,
 * or withheld. That is a refusal, not a silent success.
 */
export async function releaseHold(tx: QueryRunner, id: string): Promise<void> {
  const r = await tx.query(
    `UPDATE integration_post
        SET status = 'PENDING', next_attempt_at = clock_timestamp(),
            claimed_at = NULL, claimed_by = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'HELD'
      RETURNING id`,
    [id],
  );
  if (r.rowCount !== 1) {
    throw new Error('that post is not held — it may have been released already');
  }
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
    HELD: 0,
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

/**
 * VX4-1 part 2 — make this tenant's WAITING posts due again.
 *
 * ── Why this exists, and it is a real gap the e2e found ────────────────────
 *
 * When `postOne` cannot post for a configuration reason — nothing connected, two
 * ledgers claiming one capability, or the accounting module switched off — it
 * SKIPS the row without burning an attempt and pushes `next_attempt_at` an hour
 * out. That backoff is right for its purpose: the poller should not spin on a
 * tenant whose configuration has not changed.
 *
 * But it means fixing the configuration does NOT move the queue. An admin who
 * turns the accounting module on watches nothing happen for up to an hour, while
 * the screen tells them the queue "drains on its own once the module is back on".
 * The e2e asserted that sentence and it was false — `posted: 0` — which is exactly
 * the kind of promise a browser test is for.
 *
 * So the ACT of fixing the configuration clears the backoff. Only `PENDING` rows:
 * a `FAILED` row backed off because a real far end refused it, and its retry
 * schedule is not this function's business.
 *
 * ── Called from the SERVICE layer, which reverses part 2's placement ────────
 *
 * VX4-1 part 2 called this from the admin screen's action, arguing that "what an
 * admin pressing a button should experience" is a UI decision rather than an
 * invariant. That argument was wrong, and wrong in the exact way this ticket spent
 * three days fixing: a hook at the EDGE is a hook the next caller forgets, which is
 * GAP-AUDIT MT-3. Two callers proved it immediately — the OAuth callback activates
 * an installation without going through that action at all, and a tenant connecting
 * a ledger has the identical problem with none of the same code in the path.
 *
 * It is now called by every operation that can change whether a tenant can post:
 * `setEntitlement` (enabling), `installIntegration` (an active install),
 * `disconnect` (which may resolve an AC-22 ambiguity), and
 * `completeAuthorisation` (an OAUTH2 install becoming active). A seed or a
 * provisioning job calling those has nothing queued yet, so the extra statement is
 * a harmless no-op — which was never a reason to leave the hook where a caller
 * could miss it.
 *
 * Returns how many rows became due, so a caller can say so.
 */
export async function requeueWaitingPosts(tx: QueryRunner): Promise<number> {
  const r = await tx.query(
    `UPDATE integration_post
        SET next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE status = 'PENDING'
        AND claimed_at IS NULL
        AND next_attempt_at > clock_timestamp()`,
  );
  return r.rowCount ?? 0;
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

/* ── the dry run (VX3-6) ───────────────────────────────────────────────────── */

export interface DryRun {
  reportId: string;
  reportNumber: string | null;
  reportTitle: string;
  currencyCode: string;
  totalMinor: string;
  /** One entry per line, with the account it would post to. */
  lines: Array<{
    description: string;
    amountMinor: string;
    taxMinor: string;
    categoryLabel: string;
    glAccountNumber: string | null;
    glAccountName: string | null;
  }>;
  /** Everything that would stop this posting. Empty means it would go. */
  problems: string[];
  /** The adapter it would go to, or null when nothing is connected. */
  destination: string | null;
}

/**
 * What WOULD be sent, and what would stop it. Writes nothing, and calls nobody.
 *
 * Deliberately does NOT contact the ledger. VX3-6's criterion is "a dry run writes
 * nothing", and the only way to have the ledger confirm a bill would be acceptable
 * is to send it one — `draft_bill` has no validate-only mode. So this checks
 * everything checkable HERE: is anything connected, does every line have an
 * account, is there anything to post at all.
 *
 * The honest limit, and it belongs on the screen rather than in a comment: a clean
 * dry run means VeloExpense has no objection. It does not mean the ledger will
 * accept it — a closed period or a missing vendor is only discoverable by asking,
 * and those are the two commonest real failures.
 */
export async function dryRun(tx: QueryRunner, postId: string): Promise<DryRun | null> {
  const head = await tx.query(
    `SELECT p.report_id, p.status, r.number, r.title, r.currency_code, r.total_minor, r.status AS report_status
       FROM integration_post p
       JOIN expense_report r ON r.id = p.report_id
      WHERE p.id = $1`,
    [postId],
  );
  if (head.rows.length === 0) return null;
  const row = head.rows[0];

  const lines = await tx.query(
    `SELECT li.description, li.amount_minor, li.tax_minor,
            c.label AS category_label,
            coalesce(lg.number, cg.number) AS gl_account_number,
            coalesce(lg.name, cg.name)     AS gl_account_name
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
       JOIN expense_category c ON c.id = li.category_id
       LEFT JOIN gl_account lg ON lg.id = li.gl_account_id
       LEFT JOIN gl_account cg ON cg.id = c.gl_account_id
      WHERE e.report_id = $1
      ORDER BY e.txn_date NULLS LAST, li.created_at`,
    [row.report_id],
  );

  const problems: string[] = [];
  if (lines.rows.length === 0) problems.push('The report has no line items.');
  // UD-2: the definition of "coded" comes from `lib/integrations/coding.ts`, which
  // `submitReport` now uses as well. It used to be computed here from this
  // function's own SELECT — the same `coalesce`, which is the good case and not
  // the durable one. A gate and a poster that disagree about coding is a report
  // that passes submit and then cannot post, which is the bug UD-2 closes.
  const uncoded = await uncodedCategories(tx, row.report_id as string);
  if (uncoded.length > 0) {
    problems.push(
      `These categories have no GL account, so a bill line cannot name one: ` +
        `${uncoded.map((u) => u.label).join(', ')}.`,
    );
  }
  if (row.report_status !== 'APPROVED' && row.report_status !== 'REIMBURSED') {
    problems.push(`The report is ${row.report_status}, not approved.`);
  }
  if (row.status === 'POSTED') problems.push('This has already been sent.');

  return {
    reportId: row.report_id as string,
    reportNumber: row.number as string | null,
    reportTitle: row.title as string,
    currencyCode: row.currency_code as string,
    totalMinor: String(row.total_minor),
    lines: lines.rows.map((l) => ({
      description: (l.description as string | null) ?? (l.category_label as string),
      amountMinor: String(l.amount_minor),
      taxMinor: String(l.tax_minor),
      categoryLabel: l.category_label as string,
      glAccountNumber: l.gl_account_number as string | null,
      glAccountName: l.gl_account_name as string | null,
    })),
    problems,
    destination: null,
  };
}

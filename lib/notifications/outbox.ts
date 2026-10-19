/**
 * VX2-8 — the delivery outbox: a work queue in Postgres.
 *
 * ExpenseOS enqueues a BullMQ job on Redis and consumes it in a separate worker
 * process. This is a table instead, and the reason is recorded in GAP-AUDIT
 * NT-19 and the decision table above it: Redis would be a new dependency of the
 * image, of CI and of every laptop, and the admin queue screen would then read a
 * datastore that is neither RLS-scoped nor backed up with the database. The same
 * call VX1-9 made choosing `s3rver` over MinIO.
 *
 * What that costs is exactly the four things BullMQ hands over free, so all four
 * are written here on purpose and each is worth reading once:
 *
 *   THE CLAIM is a conditional write, not `FOR UPDATE SKIP LOCKED`. The send is
 *   an SMTP round trip, so it happens OUTSIDE any transaction — holding one open
 *   across it would pin a pooled connection for seconds — and a row lock taken
 *   while scanning would be released before the claim anyway. So two pollers
 *   race, `rowCount` decides, and the loser moves on. Same idiom as VX2-3's
 *   decision claim and VX2-8's token consume; three single-use guarantees in this
 *   codebase now share one shape.
 *
 *   THE BACKOFF is the `next_attempt_at` column. A failing transport must not be
 *   hammered, and a retry schedule that lives in code rather than in the row
 *   cannot be inspected by the admin screen that has to explain it.
 *
 *   THE VISIBILITY TIMEOUT is `claimed_at`. A poller that dies mid-send leaves a
 *   row claimed by a process that no longer exists. Nothing else would ever
 *   release it — the transaction that claimed it committed, so there is no lock to
 *   expire — so a claim older than the timeout is treated as abandoned. This is
 *   the piece that is easiest to leave out and worst to leave out: without it one
 *   crash silently strands one notification forever.
 *
 *   THE DEAD LETTER is `status = 'DEAD'`. Retrying forever is not resilience, it
 *   is a queue that never tells anybody anything is wrong — which is precisely
 *   the failure mode NT-11 records ("no error, no log, no delivery").
 */
import type { QueryRunner } from '@/lib/db/client';
import type { Channel } from '@/lib/notifications/catalog';


export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'DEAD' | 'CANCELLED';

/**
 * Attempts before a delivery is dead-lettered.
 *
 * Five, matched to the backoff below so the last attempt lands about five hours
 * after the first. That is deliberately longer than a transient SMTP outage and
 * shorter than a working day: an admin who comes in to a DEAD row can still act
 * on the approval it was about.
 */
// VX3-4 moved the retry POLICY to `lib/outbox/policy.ts`, which VX3-4's ledger
// post-outbox also uses. Two outboxes that disagreed about how long to wait, how
// many times to try, or how long a claim is honoured would be two operational
// behaviours to learn — which is the real cost GAP-AUDIT AC-7 was pointing at.
// Re-exported here so this module's own callers and tests are unaffected.
export { MAX_ATTEMPTS, CLAIM_TIMEOUT_SECONDS } from '@/lib/outbox/policy';
import { BACKOFF_SECONDS, CLAIM_TIMEOUT_SECONDS, MAX_ATTEMPTS } from '@/lib/outbox/policy';
import { ORG } from '@/lib/tenant/sql';

export interface DeliveryRow {
  id: string;
  notificationId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  sentAt: Date | null;
  lastError: string | null;
  destination: string | null;
  createdAt: Date;
}

/* ── enqueueing ───────────────────────────────────────────────────────────── */

/**
 * Add a delivery job. Idempotent on (notification, channel).
 *
 * `ON CONFLICT DO NOTHING` against `notification_delivery_one_per_channel`,
 * because the alternative is a double-send — and a double-sent approval email
 * means two approve links for one task, which is the one thing this table exists
 * to keep from happening.
 *
 * IN_APP is refused by a CHECK constraint in `0012` rather than ignored here: it
 * was delivered the moment the notification row was written, and a job with
 * nothing to do would sit PENDING forever and make the admin queue's count a lie.
 */
export async function enqueueDelivery(
  tx: QueryRunner,
  notificationId: string,
  channel: Exclude<Channel, 'IN_APP'>,
  opts: { digest?: boolean } = {},
): Promise<string | null> {
  // w5-00: a digest-type email is not due until the next digest boundary (ExpenseOS runs
  // its digest every 15 minutes, on the quarter hour), so everything that lands for one
  // person before then goes out together. `next_attempt_at` is the outbox's own "not before"
  // column, so the hold needs no new state: the poller simply does not see the row until it
  // is due, and the admin queue shows when it will be.
  const r = await tx.query(
    `INSERT INTO notification_delivery (organization_id, notification_id, channel, next_attempt_at)
     VALUES (${ORG}, $1, $2,
             CASE WHEN $3::boolean
                  THEN date_bin(make_interval(mins => $4), clock_timestamp(),
                                TIMESTAMPTZ '2000-01-01 00:00:00+00')
                       + make_interval(mins => $4)
                  ELSE clock_timestamp() END)
     ON CONFLICT (notification_id, channel) DO NOTHING
     RETURNING id`,
    [notificationId, channel, opts.digest === true, DIGEST_INTERVAL_MINUTES],
  );
  return (r.rows[0]?.id as string) ?? null;
}

/**
 * w5-00 — how often the digest goes out: ExpenseOS's `notification.emailDigest` schedule
 * (every 15 minutes, on the quarter hour, UTC). A digest-type delivery is held until the next
 * quarter hour.
 */
export const DIGEST_INTERVAL_MINUTES = 15;

/* ── the poller ───────────────────────────────────────────────────────────── */

export interface DueDelivery {
  id: string;
  organizationId: string;
}

/**
 * Find due work in ANY tenant.
 *
 * MUST run inside `withPlatformRead` — see `lib/tenant/context.ts`. `withoutOrg`
 * would return nothing at all: under FORCE RLS an unset `app.current_org` makes
 * every policy body NULL, and that is a guarantee this schema has rather than a
 * bug to work around.
 *
 * `0012`'s `platform_read` policy is narrowed to PENDING and FAILED, so this
 * query physically cannot see a tenant's SENT history even if somebody widened
 * the WHERE clause.
 *
 * The caller takes ONLY `organizationId` from each row and does the real work
 * inside `withOrg`.
 */
export async function dueDeliveries(tx: QueryRunner, limit = 25): Promise<DueDelivery[]> {
  const r = await tx.query(
    `SELECT id, organization_id
       FROM notification_delivery
      WHERE status IN ('PENDING', 'FAILED')
        AND next_attempt_at <= clock_timestamp()
        AND (claimed_at IS NULL
             OR claimed_at < clock_timestamp() - make_interval(secs => $2::double precision))
      ORDER BY next_attempt_at
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200), CLAIM_TIMEOUT_SECONDS],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    organizationId: row.organization_id as string,
  }));
}

export interface ClaimedDelivery {
  id: string;
  notificationId: string;
  channel: Channel;
  attempts: number;
}

/**
 * Take one delivery, inside its tenant. Null when somebody else got there first.
 *
 * The WHERE clause repeats every condition `dueDeliveries` used, and that is the
 * point rather than duplication: the scan happened in a different transaction, so
 * anything could have changed since — another poller could have claimed it, an
 * admin could have cancelled it, or the send could already have succeeded. The
 * conditional write is the only thing that decides.
 *
 * `attempts` increments HERE, at claim time, not at failure time. A poller that
 * crashes mid-send has still spent an attempt, which is what stops a message that
 * kills its handler from looping forever on the visibility timeout.
 */
export async function claimDelivery(
  tx: QueryRunner,
  id: string,
  claimedBy: string,
): Promise<ClaimedDelivery | null> {
  const r = await tx.query(
    `UPDATE notification_delivery
        SET attempts = attempts + 1,
            claimed_at = clock_timestamp(),
            claimed_by = $2,
            updated_at = now()
      WHERE id = $1
        AND status IN ('PENDING', 'FAILED')
        AND next_attempt_at <= clock_timestamp()
        AND (claimed_at IS NULL
             OR claimed_at < clock_timestamp() - make_interval(secs => $3::double precision))
      RETURNING notification_id, channel, attempts`,
    [id, claimedBy.slice(0, 200), CLAIM_TIMEOUT_SECONDS],
  );
  if (r.rowCount !== 1) return null;
  return {
    id,
    notificationId: r.rows[0].notification_id as string,
    channel: r.rows[0].channel as Channel,
    attempts: r.rows[0].attempts as number,
  };
}

export async function markSent(
  tx: QueryRunner,
  id: string,
  destination: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE notification_delivery
        SET status = 'SENT', sent_at = clock_timestamp(), claimed_at = NULL,
            claimed_by = NULL, last_error = NULL, destination = $2, updated_at = now()
      WHERE id = $1`,
    [id, destination],
  );
}

/**
 * Record a failure, and decide whether there is another attempt.
 *
 * The error text is stored TRUNCATED but otherwise verbatim. An SMTP rejection
 * carries the reason a message was refused — a bad address, a rejected sender, a
 * rate limit — and paraphrasing it is how "delivery failed" becomes the only
 * thing anybody can find out.
 */
export async function markFailed(
  tx: QueryRunner,
  id: string,
  attempts: number,
  error: unknown,
): Promise<DeliveryStatus> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const dead = attempts >= MAX_ATTEMPTS;
  const backoff = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)] ?? 3600;
  await tx.query(
    `UPDATE notification_delivery
        SET status = $2,
            last_error = $3,
            claimed_at = NULL,
            claimed_by = NULL,
            next_attempt_at = CASE WHEN $2 = 'DEAD'
                                   THEN next_attempt_at
                                   ELSE clock_timestamp()
                                        + make_interval(secs => $4::double precision) END,
            updated_at = now()
      WHERE id = $1`,
    [id, dead ? 'DEAD' : 'FAILED', message, backoff],
  );
  return dead ? 'DEAD' : 'FAILED';
}

/**
 * Nothing to send after all.
 *
 * Distinct from DEAD, and the distinction is the admin's: DEAD means we tried and
 * could not, CANCELLED means there was never anything to do — the recipient has no
 * address, or the channel was turned off between enqueue and send. Collapsing
 * them would put "this is fine" and "somebody should look at this" in the same
 * bucket, which is how an alert stops being read.
 */
export async function markCancelled(
  tx: QueryRunner,
  id: string,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE notification_delivery
        SET status = 'CANCELLED', last_error = $2, claimed_at = NULL,
            claimed_by = NULL, updated_at = now()
      WHERE id = $1`,
    [id, reason.slice(0, 2000)],
  );
}

/* ── the admin queue ──────────────────────────────────────────────────────── */

export interface QueueRow extends DeliveryRow {
  eventType: string;
  /** w5-00: PENDING and not yet due — a digest-type email waiting for its quarter hour. */
  heldForDigest: boolean;
  recipientName: string;
  recipientEmail: string;
  subjectId: string;
  /** VeloExpense (w6-01): so the screen links a travel request to /travel, not /expenses. */
  subjectType: string;
}

export interface QueueSummary {
  pending: number;
  failed: number;
  dead: number;
  sent: number;
  cancelled: number;
}

export async function queueSummary(tx: QueryRunner): Promise<QueueSummary> {
  const r = await tx.query(
    `SELECT status, count(*)::int AS n FROM notification_delivery GROUP BY status`,
  );
  const out: QueueSummary = { pending: 0, failed: 0, dead: 0, sent: 0, cancelled: 0 };
  for (const row of r.rows) {
    const k = (row.status as string).toLowerCase() as keyof QueueSummary;
    if (k in out) out[k] = row.n as number;
  }
  return out;
}

/**
 * This tenant's queue.
 *
 * Defaults to everything that is NOT settled, because that is what an admin opens
 * this screen to see. `SENT` is available on request and is the majority of the
 * table in a healthy system, which is why it is not the default.
 */
export async function listQueue(
  tx: QueryRunner,
  opts: { status?: DeliveryStatus | 'UNSETTLED'; limit?: number } = {},
): Promise<QueueRow[]> {
  const status = opts.status ?? 'UNSETTLED';
  const r = await tx.query(
    `SELECT d.id, d.notification_id, d.channel, d.status, d.attempts, d.next_attempt_at,
            d.claimed_at, d.claimed_by, d.sent_at, d.last_error, d.destination, d.created_at,
            a.event_type, a.subject_id, a.subject_type,
            (d.status = 'PENDING' AND d.next_attempt_at > clock_timestamp()) AS held,
            COALESCE(u.display_name, u.email) AS recipient_name, u.email AS recipient_email
       FROM notification_delivery d
       JOIN notification n ON n.id = d.notification_id
       JOIN activity a     ON a.id = n.activity_id
       JOIN app_user u     ON u.id = n.recipient_id
      WHERE ($1::text = 'UNSETTLED' AND d.status IN ('PENDING', 'FAILED', 'DEAD'))
         OR d.status = $1::text
      ORDER BY
        -- Worst first: something an admin must act on outranks something that is
        -- merely waiting. A queue sorted by time buries the DEAD row under
        -- fifty healthy ones.
        CASE d.status WHEN 'DEAD' THEN 0 WHEN 'FAILED' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END,
        d.created_at DESC
      LIMIT $2`,
    [status, Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    notificationId: row.notification_id as string,
    channel: row.channel as Channel,
    status: row.status as DeliveryStatus,
    attempts: row.attempts as number,
    nextAttemptAt: row.next_attempt_at as Date,
    claimedAt: row.claimed_at as Date | null,
    claimedBy: row.claimed_by as string | null,
    sentAt: row.sent_at as Date | null,
    lastError: row.last_error as string | null,
    destination: row.destination as string | null,
    createdAt: row.created_at as Date,
    eventType: row.event_type as string,
    heldForDigest: row.held as boolean,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    recipientName: row.recipient_name as string,
    recipientEmail: row.recipient_email as string,
  }));
}

/**
 * An admin says try again now.
 *
 * `attempts = 0`, so a DEAD row gets a fresh budget rather than dying again on the
 * next poll — without that, the button would appear to do nothing, which is worse
 * than not having it. `last_error` is deliberately LEFT IN PLACE: the screen must
 * still be able to say what went wrong last time while the retry is in flight,
 * and clearing it would make a row that is about to fail the same way look clean.
 *
 * So `attempts` means "attempts since the last manual retry", and the column is
 * documented that way rather than pretending to be a lifetime count.
 */
export async function retryNow(tx: QueryRunner, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE notification_delivery
        SET status = 'PENDING', attempts = 0, next_attempt_at = clock_timestamp(),
            claimed_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('FAILED', 'DEAD', 'CANCELLED')`,
    [id],
  );
  return r.rowCount === 1;
}

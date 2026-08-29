/**
 * VX2-8 — composing and sending one delivery, and the drain loop that does it.
 *
 * Ported from ExpenseOS `apps/worker/src/notification-dispatch.ts`, which is a
 * BullMQ handler; this is the same handler behind a Postgres outbox instead
 * (GAP-AUDIT NT-19). Their file is also where NT-11 and NT-12 come from, and both
 * lessons are honoured here rather than re-learned.
 *
 * ── The shape of a delivery, and why it is three transactions ───────────────
 *
 *   tx1  withOrg  claim the row, read everything the message needs, mint the
 *                 approve links. Commits.
 *   ---  no tx    send. An SMTP round trip takes seconds and must not hold a
 *                 pooled connection or a row lock while it does.
 *   tx2  withOrg  mark SENT, or FAILED with the reason and a backoff.
 *
 * The gap between tx1 and tx2 is exactly why `notification_delivery.claimed_at`
 * exists: a process that dies in it leaves a claimed row that nothing else would
 * ever release, and the visibility timeout is the only thing that recovers it.
 *
 * ── What "sent" means, and what it does not ─────────────────────────────────
 *
 * SENT means the transport accepted the message. It does not mean it arrived, was
 * not filtered, or was read. That is worth being pedantic about on the admin
 * screen, because a queue that says "sent" is otherwise read as "delivered" and
 * the next question — "then why didn't they see it?" — has nowhere to go.
 */
import { withOrg, withPlatformRead } from '@/lib/tenant/context';
import type { QueryRunner } from '@/lib/db/client';
import { formatMinor } from '@/lib/money';
import { placeholderValuesFrom, type Channel } from '@/lib/notifications/catalog';
import { renderMessage } from '@/lib/notifications/service';
import {
  appOrigin,
  fromAddress,
  sendEmail,
  type EmailMessage,
} from '@/lib/notifications/email';
import {
  claimDelivery,
  dueDeliveries,
  markCancelled,
  markFailed,
  markSent,
  type ClaimedDelivery,
} from '@/lib/notifications/outbox';
import { issueActionToken } from '@/lib/notifications/action-tokens';
import { decidableTaskForReport } from '@/lib/approvals/inbox';

/**
 * The path a token lands on. `/approve` rather than something neutral, and it
 * must never change: TOKENS LIVE FIVE BUSINESS DAYS, so a rename breaks every
 * link already sitting in an approver's inbox. ExpenseOS learned this the other
 * way round — their path is still `/vcc-action` from when the feature was
 * card-only, kept "as the path rather than being renamed to something neutral
 * because tokens live five business days".
 */
export const APPROVE_PATH = '/approve';

/**
 * Event types where the recipient can act inline, so the mail carries buttons.
 *
 * TASK_ASSIGNED only. ExpenseOS's set is `SUBMITTED | TASK_ASSIGNED |
 * DEADLINE_NEAR`; VeloExpense emits neither of the others (NT-15, and VX2-7's
 * taxonomy test asserts the list). An APPROVED or REJECTED mail is addressed to
 * the submitter, who has nothing to decide.
 */
const ACTIONABLE_EVENTS = new Set(['TASK_ASSIGNED']);

/* ── preparing ────────────────────────────────────────────────────────────── */

type Prepared =
  | { kind: 'SEND'; message: EmailMessage; destination: string }
  | { kind: 'CANCEL'; reason: string };

interface Row {
  event_type: string;
  subject_type: string;
  subject_id: string;
  payload: unknown;
  recipient_id: string;
  recipient_email: string | null;
  actor_name: string | null;
  report_title: string | null;
  report_number: string | null;
  report_total_minor: string | null;
  report_currency: string | null;
}

/**
 * Everything a message needs, in one read.
 *
 * The LEFT JOIN onto `expense_report` is deliberate and load-bearing: an activity
 * is polymorphic (`subject_id` has no FK, NT-1), so a subject that is not a report
 * — or a report deleted since — must not drop the row and make the delivery
 * silently unpreparable. It becomes a CANCEL with a reason instead.
 */
async function loadForDelivery(tx: QueryRunner, notificationId: string): Promise<Row | null> {
  const r = await tx.query(
    `SELECT a.event_type, a.subject_type, a.subject_id, a.payload,
            n.recipient_id,
            u.email AS recipient_email,
            COALESCE(act.display_name, act.email) AS actor_name,
            rep.title  AS report_title,
            rep.number AS report_number,
            rep.total_minor AS report_total_minor,
            rep.currency_code AS report_currency
       FROM notification n
       JOIN activity a   ON a.id = n.activity_id
       JOIN app_user u   ON u.id = n.recipient_id
       LEFT JOIN app_user act ON act.id = a.actor_id
       LEFT JOIN expense_report rep
              ON rep.id = a.subject_id AND a.subject_type = 'EXPENSE_REPORT'
      WHERE n.id = $1`,
    [notificationId],
  );
  return (r.rows[0] as Row | undefined) ?? null;
}

/**
 * Compose one email, inside the tenant, having already claimed the row.
 *
 * Returns CANCEL rather than throwing for anything a retry cannot fix. That
 * distinction is the whole reason `CANCELLED` and `DEAD` are separate statuses: a
 * recipient with no email address will still have no email address in four hours,
 * and putting that in the same bucket as "SMTP was down" is how an admin learns to
 * ignore the screen.
 */
export async function prepareEmail(
  tx: QueryRunner,
  claim: ClaimedDelivery,
): Promise<Prepared> {
  const row = await loadForDelivery(tx, claim.notificationId);
  if (!row) return { kind: 'CANCEL', reason: 'the notification no longer exists' };
  // DEFENSIVE, not a live path: `app_user.email` is `text NOT NULL` (0001), so
  // this cannot currently be reached. Kept because the column being non-null is
  // an accident of the SSO model rather than a decision anybody made about
  // notifications, and because a delivery with nowhere to go must CANCEL rather
  // than throw whichever way that changes. There is no test for it, and the
  // reason there is no test is that no fixture can produce it.
  if (!row.recipient_email) {
    return { kind: 'CANCEL', reason: 'the recipient has no email address' };
  }
  if (row.subject_type !== 'EXPENSE_REPORT' || row.report_title === null) {
    return {
      kind: 'CANCEL',
      reason: `nothing to link to for ${row.subject_type} ${row.subject_id}`,
    };
  }

  const actor = row.actor_name ?? 'Somebody';
  const values = {
    ...placeholderValuesFrom(row.payload),
    // Reserved names LAST, so a payload key cannot shadow them (NT-6 rule 4).
    actor,
    report: row.report_title,
    number: row.report_number ?? '',
    total: formatMinor(row.report_total_minor ?? '0', row.report_currency ?? 'CAD'),
  };

  const rendered = await renderMessage(tx, {
    channel: 'EMAIL',
    eventType: row.event_type,
    subjectType: row.subject_type,
    values,
  });

  const origin = appOrigin();
  const reportUrl = origin ? `${origin}/expenses/${row.subject_id}` : null;

  // Approve links, only where there is something this person can actually decide.
  // `decidableTaskForReport` is VX2-4's function, which is the point: the mail
  // offers a button exactly when the report page would offer one, because both ask
  // the same question in the same place (AP-15).
  let actions: { approveUrl: string; rejectUrl: string } | null = null;
  if (origin && ACTIONABLE_EVENTS.has(row.event_type)) {
    const task = await decidableTaskForReport(tx, row.subject_id, row.recipient_id);
    if (task) {
      // Any earlier attempt's links are retired first. They cannot be reused —
      // only the hash is stored, so the raw value is unrecoverable by design — and
      // leaving them live would accumulate one live credential pair per attempt
      // for one task. Cost, stated because it is real: if an earlier attempt did
      // reach the recipient, its buttons now fail and they land on a page that
      // says so and links to the report.
      await tx.query(
        `UPDATE action_token SET consumed_at = clock_timestamp()
          WHERE delivery_id = $1 AND consumed_at IS NULL`,
        [claim.id],
      );
      const approve = await issueActionToken(tx, {
        taskId: task.taskId,
        action: 'APPROVE',
        recipientId: row.recipient_id,
        deliveryId: claim.id,
      });
      const reject = await issueActionToken(tx, {
        taskId: task.taskId,
        action: 'REJECT',
        recipientId: row.recipient_id,
        deliveryId: claim.id,
      });
      actions = {
        approveUrl: `${origin}${APPROVE_PATH}?token=${approve.raw}`,
        rejectUrl: `${origin}${APPROVE_PATH}?token=${reject.raw}`,
      };
    }
  }

  const subject =
    rendered.subject ?? `${row.report_title}${row.report_number ? ` (${row.report_number})` : ''}`;

  return {
    kind: 'SEND',
    destination: row.recipient_email,
    message: {
      to: row.recipient_email,
      subject,
      from: fromAddress(),
      text: plainText(rendered.body, reportUrl, actions),
      html: htmlBody(rendered.body, reportUrl, actions),
      ...threadHeaders(claim.notificationId, row.subject_id, row.recipient_id),
      headers: {
        // RFC 3834. Ported with ExpenseOS's reason, which nobody derives from
        // first principles: "a machine-generated reply has to say so, or a
        // well-behaved out-of-office responder answers it and the two of them
        // keep going."
        'Auto-Submitted': 'auto-generated',
      },
    },
  };
}

/**
 * Threading, with no stored state.
 *
 * ExpenseOS derives its thread root from a `ReplyThread` row, which exists because
 * they accept inbound replies. VeloExpense does not — inbound email is not in this
 * ticket and has no ticket yet — so the root is DERIVED from (subject, recipient)
 * instead, which needs no table and is stable for as long as those two ids are.
 *
 * The root is a phantom: no message is ever sent with that id. Clients group on a
 * shared `References` ancestor whether or not they have seen it, which is the
 * standard way to thread machine-generated mail. Each message keeps its OWN
 * `Message-ID` — a repeated one makes clients treat later messages as duplicates
 * and hide them.
 */
function threadHeaders(
  notificationId: string,
  subjectId: string,
  recipientId: string,
): Pick<EmailMessage, 'messageId' | 'references' | 'inReplyTo'> {
  const domain = messageIdDomain();
  const root = `<velo-thread-${subjectId}-${recipientId}@${domain}>`;
  return {
    messageId: `<velo-n-${notificationId}@${domain}>`,
    references: root,
    inReplyTo: root,
  };
}

/** Read at call time, not module load — same reason as `appOrigin` (NT-14). */
function messageIdDomain(): string {
  return (
    process.env.EMAIL_FROM?.trim().split('@')[1] ||
    process.env.SMTP_FROM?.trim().split('@')[1] ||
    'veloexpense.local'
  );
}

function plainText(
  body: string,
  reportUrl: string | null,
  actions: { approveUrl: string; rejectUrl: string } | null,
): string {
  const parts = [body, ''];
  if (actions) {
    parts.push(`Approve: ${actions.approveUrl}`, `Reject:  ${actions.rejectUrl}`, '');
  }
  if (reportUrl) parts.push(`Open the report: ${reportUrl}`);
  // Said in the mail, not only in the docs: a link that acts on one click is a
  // link a mail scanner can trip. Ours asks first, and the recipient should know
  // that before they click.
  if (actions) parts.push('', 'Both links ask you to confirm before anything happens.');
  return parts.join('\n');
}

function htmlBody(
  body: string,
  reportUrl: string | null,
  actions: { approveUrl: string; rejectUrl: string } | null,
): string {
  const out = [`<p>${escapeHtml(body)}</p>`];
  if (actions) {
    out.push(
      `<p><a href="${escapeHtml(actions.approveUrl)}">Approve</a>` +
        `&nbsp;&nbsp;·&nbsp;&nbsp;` +
        `<a href="${escapeHtml(actions.rejectUrl)}">Reject</a></p>`,
    );
  }
  if (reportUrl) {
    out.push(`<p><a href="${escapeHtml(reportUrl)}">Open the report</a></p>`);
  }
  if (actions) {
    out.push('<p style="color:#666;font-size:12px">Both links ask you to confirm first.</p>');
  }
  return out.join('');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── the drain loop ───────────────────────────────────────────────────────── */

export interface DrainSummary {
  scanned: number;
  sent: number;
  failed: number;
  dead: number;
  cancelled: number;
  /** Claimed by somebody else between the scan and the claim. Not an error. */
  skipped: number;
}

/**
 * Do the due work, once. Returns what happened.
 *
 * NOT a loop with a sleep in it: a request handler and a test both want "drain
 * what is due and tell me", and a long-running process is then just this function
 * on a timer. That keeps the only entry point the same one the tests exercise —
 * VX1-9's lesson about MemoryStorage was that a test path nobody ships is a test
 * that proves nothing about what ships.
 *
 * `claimedBy` names the caller so a stuck row can say who was holding it.
 */
export async function drainOutbox(
  opts: { limit?: number; claimedBy?: string } = {},
): Promise<DrainSummary> {
  const claimedBy = opts.claimedBy ?? `drain:${process.pid}`;
  const summary: DrainSummary = {
    scanned: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    cancelled: 0,
    skipped: 0,
  };

  const due = await withPlatformRead((tx) => dueDeliveries(tx, opts.limit ?? 25));
  summary.scanned = due.length;

  for (const job of due) {
    // tx1: claim and compose, inside the tenant.
    const prepared = await withOrg(job.organizationId, async (tx) => {
      const claim = await claimDelivery(tx, job.id, claimedBy);
      if (!claim) return null;
      // A channel with no transport is CANCELLED, not attempted. Nothing writes
      // such a row today — `notifyRecipients` enqueues EMAIL only — but this is
      // the function that would otherwise compose an email and send it in
      // response to a Slack job, which is a worse failure than refusing.
      if (claim.channel !== 'EMAIL') {
        await markCancelled(tx, claim.id, `no transport for ${claim.channel} yet`);
        return { claim, outcome: 'CANCELLED' as const };
      }
      const p = await prepareEmail(tx, claim);
      if (p.kind === 'CANCEL') {
        await markCancelled(tx, claim.id, p.reason);
        return { claim, outcome: 'CANCELLED' as const };
      }
      return { claim, outcome: 'SEND' as const, prepared: p };
    });

    if (prepared === null) {
      summary.skipped += 1;
      continue;
    }
    if (prepared.outcome === 'CANCELLED') {
      summary.cancelled += 1;
      continue;
    }

    // No transaction across the send.
    try {
      await sendEmail(prepared.prepared.message);
      await withOrg(job.organizationId, (tx) =>
        markSent(tx, prepared.claim.id, prepared.prepared.destination),
      );
      summary.sent += 1;
    } catch (err) {
      const status = await withOrg(job.organizationId, (tx) =>
        markFailed(tx, prepared.claim.id, prepared.claim.attempts, err),
      );
      if (status === 'DEAD') summary.dead += 1;
      else summary.failed += 1;
      // Logged as well as stored. The row is the durable record and the admin
      // screen reads it; the log line is what an operator tailing a deploy sees.
      // NT-11's rule: a non-delivery that is only in a database is a non-delivery
      // nobody notices for a day.
      console.warn(
        `[notifications] delivery ${prepared.claim.id} failed ` +
          `(attempt ${prepared.claim.attempts}, now ${status}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

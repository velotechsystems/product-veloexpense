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
 *   tx1  withOrg  claim the row, read everything the message needs. Commits.
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
import { getBranding } from '@/lib/branding/service';
import { emailShell } from '@/lib/notifications/email-shell';
import { escapeHtml } from '@/lib/notifications/html';
import type { QueryRunner } from '@/lib/db/client';
import { formatMinor } from '@/lib/money';
import { resolveReaderPrefs } from '@/lib/i18n/resolve';
import { DIGEST_EVENT_TYPES, isDigestType, placeholderValuesFrom } from '@/lib/notifications/catalog';
import { buildDigest, ctaFor, type DigestLine } from '@/lib/notifications/digest';
import { loadCatalog } from '@expenseos/i18n/load';
import { renderMessage } from '@/lib/notifications/service';
import {
  originForTenant,
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
import { withTenantDb } from '@/lib/db/prisma';
import { tenantDbOf } from '@/lib/db/prisma-pg-bridge';
import { ORG } from '@/lib/tenant/sql';
import { resolveDecidableTask } from '@/server/lib/reportApproval';
import { hasCommentThread } from '@/server/lib/threadParticipants';
import { ensureReplyThread, issueEmailReplyToken } from '@/lib/notifications/replyThreads';
import type { TenantDb } from '@/lib/db/prisma';
import { commitSlackFacts, prepareSlack, sendPreparedSlack } from '@/lib/notifications/slackDispatch';

/**
 * Event types addressed to somebody who may have a decision to make, so the mail's
 * link to the report is its button ("Review and approve") rather than a plain link.
 *
 * TASK_ASSIGNED only. ExpenseOS's set is `SUBMITTED | TASK_ASSIGNED |
 * DEADLINE_NEAR`; VeloExpense emits neither of the others (NT-15, and VX2-7's
 * taxonomy test asserts the list). An APPROVED or REJECTED mail is addressed to
 * the submitter, who has nothing to decide.
 *
 * VeloExpense (d62, 13 Oct 2026): an approval email carries NO approve or reject link.
 * It links to the report, and the approver decides there, signed in, having read it.
 * ExpenseOS mails single-use approve/reject tokens (`actionTokens.ts`, its
 * `notification-dispatch.ts`); VeloExpense ported them (VX2-8) and retired them here,
 * with the `/approve` confirm page and the `action_token` table (0063).
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
  recipient_locale: string | null;
  recipient_timezone: string | null;
  org_locale: string;
  org_timezone: string;
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
            -- VX4-7 part 1b. The RECIPIENT'S locale and clock -- not the
            -- sending process's, and not some reader's. An email is composed for
            -- one person and posted, and it is the ONLY surface in the product
            -- whose language cannot be corrected afterwards: the bell re-renders
            -- from the activity on every view (the notification table stores no
            -- body at all), and a policy violation can be re-rendered from its
            -- rule_code plus its data column. Bytes that have left cannot.
            --
            -- The join onto app_user was already here for the address, so this
            -- costs two columns and no extra round trip. organization is not
            -- RLS-scoped (0023), so its defaults join in freely for the rungs
            -- below the user's own.
            u.locale   AS recipient_locale,
            u.timezone AS recipient_timezone,
            o.default_locale   AS org_locale,
            o.default_timezone AS org_timezone,
            COALESCE(act.display_name, act.email) AS actor_name,
            rep.title  AS report_title,
            rep.number AS report_number,
            rep.total_minor AS report_total_minor,
            rep.currency_code AS report_currency
       FROM notification n
       JOIN activity a   ON a.id = n.activity_id
       JOIN app_user u   ON u.id = n.recipient_id
       JOIN organization o ON o.id = u.organization_id
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

  // The recipient's own answer, else their company's, else the constants — the
  // same precedence every screen uses, resolved here from the row above.
  const prefs = resolveReaderPrefs({
    userLocale: row.recipient_locale,
    orgLocale: row.org_locale,
    userTimeZone: row.recipient_timezone,
    orgTimeZone: row.org_timezone,
  });

  const values = messageValues(row, prefs.locale);

  const rendered = await renderMessage(tx, {
    channel: 'EMAIL',
    eventType: row.event_type,
    subjectType: row.subject_type,
    values,
    // VX4-7 part 1b. `renderMessage` has taken a locale since VX2-7 and NOTHING
    // ever passed one, so every email in the product has rendered in the default
    // regardless of who it was addressed to — IL-2's shape exactly, a parameter
    // that is correct and inert. The stored template's locale map and the
    // shipped copy are both read through this, so one argument moves both.
    locale: prefs.locale,
  });

  // VX5-5: the TENANT's origin, not the deployment's. `prepareEmail` already runs
  // inside `withOrg(job.organizationId)`, so the slug is the tenant this message
  // is about, by construction — the same reasoning the branding read below has.
  // A report link that lands on the tenant's own address arrives where the host and
  // the reader's session already agree.
  // `prepareEmail` runs inside the tenant transaction already, so the current
  // org is the tenant this message is about — read it the way every other
  // tenant-scoped statement in this file does rather than threading an id in.
  const slugRow = await tx.query(`SELECT slug FROM organization WHERE id = ${ORG}`);
  const origin = originForTenant((slugRow.rows[0]?.slug as string | undefined) ?? '');
  const reportUrl = origin ? `${origin}/expenses/${row.subject_id}` : null;

  // VX4-3 part 3. One extra read per email, in the SAME transaction — `prepareEmail`
  // already runs inside `withOrg(job.organizationId)`, so this is the tenant whose
  // report the message is about, by construction rather than by being passed in.
  // The bytes of the logo are deliberately not loaded: an email cannot use them
  // (see `email-shell.ts` on why a remote logo is broken here, not merely blocked).
  const branding = await getBranding(tx);

  // Whether this person can decide the report: the mail's report link is then its button,
  // worded for the decision. w4-00c: `resolveDecidableTask` (server/lib/reportApproval.ts,
  // ExpenseOS's) is what the report page asks, which is the point: the mail says "review
  // and approve" exactly when the report page will offer Approve, because both ask the
  // same question in the same place (AP-15). It is Prisma code, so it runs on the tenant's
  // Prisma transaction — this one, when it is bridged, or a read of its own in the same
  // tenant.
  let decide = false;
  if (reportUrl && ACTIONABLE_EVENTS.has(row.event_type)) {
    const decidable = (db: Parameters<typeof resolveDecidableTask>[0]) =>
      resolveDecidableTask(db, row.subject_id, row.recipient_id, false);
    const bridged = tenantDbOf(tx);
    let taskId: string | null;
    if (bridged) {
      taskId = await decidable(bridged);
    } else {
      const org = await tx.query(`SELECT ${ORG}::text AS id`);
      taskId = await withTenantDb(org.rows[0].id as string, decidable);
    }
    decide = taskId !== null;
  }

  const subject =
    rendered.subject ?? `${row.report_title}${row.report_number ? ` (${row.report_number})` : ''}`;

  // w5-01: a reply to this email becomes a comment, when the subject has a thread.
  const replyTo = await replyAddressFor(tx, row, (slugRow.rows[0]?.slug as string | undefined) ?? '');
  const replyLine = replyTo ? await replyInvitation() : null;

  return {
    kind: 'SEND',
    destination: row.recipient_email,
    message: {
      to: row.recipient_email,
      subject,
      from: fromAddress(),
      text: plainText(rendered.body, reportUrl, decide, replyLine),
      html: htmlBody(branding.name, branding.brandColor, rendered.body, reportUrl, decide, replyLine),
      ...(replyTo ? { replyTo } : {}),
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
 * w5-00 — compose ONE email for several digest-type deliveries to one person, inside the
 * tenant, having claimed them all.
 *
 * ExpenseOS's `handleNotificationEmailDigest` builds this per recipient from
 * `notification.emailedAt IS NULL` rows. VeloExpense: from the delivery rows the drain just
 * claimed (`claimDigestSiblings`), so a digest is an outbox send like any other.
 *
 * Each line is rendered as that event's own email would have been — the tenant's template,
 * the recipient's locale — and links to its report. A line whose subject is gone or is not
 * a report keeps its sentence and loses its link, as ExpenseOS renders "an item with no
 * landing page"; a notification deleted since is left out, and its delivery CANCELLED.
 *
 * Preferences are not re-read: VeloExpense decides the channels when the event happens
 * (`notifyRecipients`), where ExpenseOS's digest re-reads them and stamps excluded rows.
 */
export async function prepareDigest(
  tx: QueryRunner,
  claims: readonly ClaimedDelivery[],
): Promise<{ prepared: Prepared; included: ClaimedDelivery[]; gone: ClaimedDelivery[] }> {
  const included: ClaimedDelivery[] = [];
  const gone: ClaimedDelivery[] = [];
  const lines: DigestLine[] = [];
  let destination: string | null = null;

  // VeloExpense: English only for now (7 Oct 2026), as the receipts summary reads it.
  const cat = await loadCatalog('en');
  const slugRow = await tx.query(`SELECT slug FROM organization WHERE id = ${ORG}`);
  const origin = originForTenant((slugRow.rows[0]?.slug as string | undefined) ?? '');

  for (const claim of claims) {
    const row = await loadForDelivery(tx, claim.notificationId);
    if (!row) {
      gone.push(claim);
      continue;
    }
    destination ??= row.recipient_email;
    const prefs = resolveReaderPrefs({
      userLocale: row.recipient_locale,
      orgLocale: row.org_locale,
      userTimeZone: row.recipient_timezone,
      orgTimeZone: row.org_timezone,
    });
    const rendered = await renderMessage(tx, {
      channel: 'EMAIL',
      eventType: row.event_type,
      subjectType: row.subject_type,
      values: messageValues(row, prefs.locale),
      locale: prefs.locale,
    });
    const isReport = row.subject_type === 'EXPENSE_REPORT' && row.report_title !== null;
    lines.push({
      msg: rendered.body,
      link: isReport && origin ? `${origin}/expenses/${row.subject_id}` : null,
      cta: ctaFor(cat, row.subject_type),
    });
    included.push(claim);
  }

  if (included.length === 0) {
    return { prepared: { kind: 'CANCEL', reason: 'the notifications no longer exist' }, included, gone };
  }
  // DEFENSIVE, as in `prepareEmail`: `app_user.email` is NOT NULL today.
  if (!destination) {
    return {
      prepared: { kind: 'CANCEL', reason: 'the recipient has no email address' },
      included,
      gone,
    };
  }

  const branding = await getBranding(tx);
  const { subject, text, html } = buildDigest(cat, lines, {
    organizationName: branding.name,
    brandColor: branding.brandColor,
  });
  return {
    included,
    gone,
    prepared: {
      kind: 'SEND',
      destination,
      message: {
        to: destination,
        subject,
        from: fromAddress(),
        text,
        html,
        // Its own id, and no thread: a digest mixes subjects, so it belongs to none of
        // their conversations.
        messageId: `<velo-digest-${included[0].id}@${messageIdDomain()}>`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      },
    },
  };
}

/**
 * The placeholder values an event's message is rendered with — shared by the single email
 * and the digest, so a line in the digest says what that event's own email would have.
 */
function messageValues(row: Row, locale: string) {
  return {
    ...placeholderValuesFrom(row.payload),
    // Reserved names LAST, so a payload key cannot shadow them (NT-6 rule 4).
    actor: row.actor_name ?? 'Somebody',
    report: row.report_title ?? '',
    number: row.report_number ?? '',
    total: formatMinor(row.report_total_minor ?? '0', row.report_currency ?? 'CAD', undefined, locale),
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

/** The report link's wording: the decision, when the recipient has one to make. */
function reportLinkLabel(decide: boolean): string {
  return decide ? 'Review and approve' : 'Open the report';
}

function plainText(
  body: string,
  reportUrl: string | null,
  decide: boolean,
  replyLine: string | null = null,
): string {
  const parts = [body, ''];
  if (reportUrl) parts.push(`${reportLinkLabel(decide)}: ${reportUrl}`);
  if (replyLine) parts.push('', replyLine);
  return parts.join('\n');
}

/**
 * VX4-3 part 3 (BR-6). This used to BE the message — four bare `<p>` tags, no
 * doctype, no wrapper, no colour — which is the shape ExpenseOS's
 * `notification-dispatch.ts:181` has and the one we inherited from it. It now
 * builds only the BODY, and `emailShell` wraps it in the tenant's branding.
 *
 * d62: for an approver the report link IS the primary action, so it is the button
 * ("Review and approve"); the decision is made on the report, signed in. For anybody
 * else it stays a plain link — a button on a mail that asks nothing of its reader
 * over-promises.
 */
function htmlBody(
  organizationName: string,
  brandColor: string | null,
  body: string,
  reportUrl: string | null,
  decide: boolean,
  replyLine: string | null = null,
): string {
  const link = reportUrl ? { label: reportLinkLabel(decide), url: reportUrl } : null;
  return emailShell({
    organizationName,
    brandColor,
    bodyHtml: `<p style="margin:0">${escapeHtml(body)}</p>`,
    cta: decide ? link : null,
    links: !decide && link ? [link] : [],
    // w5-01: the reply invitation, only when a reply actually lands somewhere.
    footnote: replyLine,
  });
}

/**
 * w5-01 — the `reply+<token>@` address a reply to this email goes to, or null.
 *
 * ExpenseOS's notification dispatch (`notification-dispatch.ts`, 1e682dd6): for a subject
 * with a discussion thread (`hasCommentThread`), get-or-create the recipient's reply thread
 * and put its token in the Reply-To; "inviting a discussion into a mailbox nothing reads is
 * worse than not inviting one", so no inbound domain means no address and no invitation.
 *
 * VeloExpense: the address is the TENANT's — `reply+<token>@<tenant>.<inbound domain>` — as
 * its receipts mailbox is (d47), because the inbound route reads the tenant from the address.
 * The thread is a Prisma write, run on this delivery's transaction when it is bridged and in
 * the same tenant otherwise (as `resolveDecidableTask` is above); it is idempotent, so either
 * is safe.
 */
async function replyAddressFor(
  tx: QueryRunner,
  row: Row,
  slug: string,
): Promise<string | null> {
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain || !slug || !hasCommentThread(row.subject_type)) return null;
  const token = async (db: TenantDb) => {
    const thread = await ensureReplyThread(db, {
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      recipientId: row.recipient_id,
    });
    return issueEmailReplyToken(db, thread.id);
  };
  const bridged = tenantDbOf(tx);
  let raw: string;
  if (bridged) {
    raw = await token(bridged);
  } else {
    const org = await tx.query(`SELECT ${ORG}::text AS id`);
    raw = await withTenantDb(org.rows[0].id as string, token);
  }
  return `reply+${raw}@${slug}.${domain}`;
}

/** ExpenseOS's `replyToDiscuss` line, from the catalog with its English literal behind it. */
async function replyInvitation(): Promise<string> {
  const cat = await loadCatalog('en');
  const email = (cat.notifications as { email?: Record<string, string> } | undefined)?.email;
  const line = email?.replyToDiscuss;
  return typeof line === 'string' && line.trim() ? line : 'Or reply to this email to start a discussion.';
}

// Moved to `lib/notifications/html.ts` — a leaf, because `email-shell.ts` needs it
// and this file imports `email-shell.ts`. Re-exported so no caller had to change.
export { escapeHtml } from '@/lib/notifications/html';

/**
 * w5-00 — the rest of one person's due digest deliveries, claimed alongside `first`.
 *
 * Null when `first` is not a digest-type event (it is sent on its own, as before). Each
 * sibling is claimed with the same conditional write as `first`, so a row another poller
 * holds is simply not in this digest — it goes in the next one.
 */
async function claimDigestSiblings(
  tx: QueryRunner,
  first: ClaimedDelivery,
  claimedBy: string,
): Promise<ClaimedDelivery[] | null> {
  const head = await tx.query(
    `SELECT a.event_type, n.recipient_id
       FROM notification n JOIN activity a ON a.id = n.activity_id
      WHERE n.id = $1`,
    [first.notificationId],
  );
  const h = head.rows[0] as { event_type: string; recipient_id: string } | undefined;
  if (!h || !isDigestType(h.event_type)) return null;

  const due = await tx.query(
    `SELECT d.id
       FROM notification_delivery d
       JOIN notification n ON n.id = d.notification_id
       JOIN activity a     ON a.id = n.activity_id
      WHERE n.recipient_id = $1
        AND d.id <> $2
        AND d.channel = 'EMAIL'
        AND a.event_type = ANY($3::text[])
        AND d.status IN ('PENDING', 'FAILED')
        AND d.next_attempt_at <= clock_timestamp()
      ORDER BY d.created_at
      LIMIT $4`,
    [h.recipient_id, first.id, [...DIGEST_EVENT_TYPES], DIGEST_MAX_ITEMS - 1],
  );
  const claims = [first];
  for (const r of due.rows as { id: string }[]) {
    const c = await claimDelivery(tx, r.id, claimedBy);
    if (c) claims.push(c);
  }
  return claims;
}

/**
 * The most lines one digest carries. ExpenseOS caps the job's whole query at 5000 rows "so
 * one run cannot try to mail a year of backlog"; VeloExpense caps each message instead —
 * anything beyond goes in the next digest, two minutes later.
 */
const DIGEST_MAX_ITEMS = 200;

/* ── the drain loop ───────────────────────────────────────────────────────── */

/** Counted per DELIVERY ROW, so a digest covering three rows counts three sent. */
export interface DrainSummary {
  scanned: number;
  sent: number;
  failed: number;
  dead: number;
  cancelled: number;
  /** Claimed by somebody else between the scan and the claim — or, since w5-00, already
   *  sent earlier in this run inside somebody's digest. Not an error. */
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
      // w5-02a: a Slack DM. Prepared here, sent below with no transaction open, recorded
      // in a second one — the email's three-transaction shape.
      if (claim.channel === 'SLACK') {
        const slack = await prepareSlack(tx, claim.notificationId, messageValues);
        if (slack.kind === 'CANCEL') {
          await markCancelled(tx, claim.id, slack.reason);
          return { claim, covers: [claim], outcome: 'CANCELLED' as const };
        }
        return { claim, covers: [claim], outcome: 'SLACK' as const, slack };
      }
      // A channel with no transport is CANCELLED, not attempted. Since w5-02a every
      // channel `notifyRecipients` enqueues has one; this stays for a row that appears by
      // some other route, because composing an email in response to it would be a worse
      // failure than refusing.
      if (claim.channel !== 'EMAIL') {
        await markCancelled(tx, claim.id, `no transport for ${claim.channel} yet`);
        return { claim, covers: [claim], outcome: 'CANCELLED' as const };
      }
      // w5-00: a digest-type delivery takes the rest of that person's due digest rows
      // with it, and they go out as one message.
      const digest = await claimDigestSiblings(tx, claim, claimedBy);
      if (digest) {
        const d = await prepareDigest(tx, digest);
        for (const g of d.gone) await markCancelled(tx, g.id, 'the notification no longer exists');
        if (d.prepared.kind === 'CANCEL') {
          for (const c of d.included) await markCancelled(tx, c.id, d.prepared.reason);
          return { claim, covers: digest, outcome: 'CANCELLED' as const };
        }
        return { claim, covers: d.included, outcome: 'SEND' as const, prepared: d.prepared };
      }
      const p = await prepareEmail(tx, claim);
      if (p.kind === 'CANCEL') {
        await markCancelled(tx, claim.id, p.reason);
        return { claim, covers: [claim], outcome: 'CANCELLED' as const };
      }
      return { claim, covers: [claim], outcome: 'SEND' as const, prepared: p };
    });

    if (prepared === null) {
      summary.skipped += 1;
      continue;
    }
    if (prepared.outcome === 'CANCELLED') {
      summary.cancelled += prepared.covers.length;
      continue;
    }

    if (prepared.outcome === 'SLACK') {
      const { claim, slack } = prepared;
      const outcome = await sendPreparedSlack(slack);
      const status = await withOrg(job.organizationId, async (tx) => {
        await commitSlackFacts(tx, slack, outcome);
        if (outcome.kind === 'SENT') {
          await markSent(tx, claim.id, outcome.slackId);
          return 'SENT';
        }
        if (outcome.kind === 'NO_ACCOUNT') {
          // ExpenseOS sends nothing and says nothing ("an address Slack has never heard of
          // is not an error"). VeloExpense: CANCELLED with the reason, so the delivery screen
          // can answer "why no DM" — the answer is per person, and nobody else will log it.
          await markCancelled(
            tx,
            claim.id,
            `Slack has no account for ${slack.email}. It is asked again after a week, or ` +
              'sooner from Notification preferences → Slack account → Check again.',
          );
          return 'CANCELLED';
        }
        return markFailed(tx, claim.id, claim.attempts, outcome.error);
      });
      if (status === 'SENT') summary.sent += 1;
      else if (status === 'CANCELLED') summary.cancelled += 1;
      else if (status === 'DEAD') summary.dead += 1;
      else summary.failed += 1;
      if (outcome.kind === 'FAILED') {
        console.warn(
          `[notifications] delivery ${claim.id} (slack) failed (attempt ${claim.attempts}, now ${status}):`,
          outcome.error.message,
        );
      }
      continue;
    }

    // No transaction across the send. A digest is ONE send for every row it covers, so
    // they are marked together: all SENT, or each FAILED with its own attempt count.
    try {
      await sendEmail(prepared.prepared.message);
      await withOrg(job.organizationId, async (tx) => {
        for (const c of prepared.covers) await markSent(tx, c.id, prepared.prepared.destination);
      });
      summary.sent += prepared.covers.length;
    } catch (err) {
      const statuses = await withOrg(job.organizationId, async (tx) => {
        const out: string[] = [];
        for (const c of prepared.covers) out.push(await markFailed(tx, c.id, c.attempts, err));
        return out;
      });
      for (const status of statuses) {
        if (status === 'DEAD') summary.dead += 1;
        else summary.failed += 1;
      }
      // Logged as well as stored. The row is the durable record and the admin
      // screen reads it; the log line is what an operator tailing a deploy sees.
      // NT-11's rule: a non-delivery that is only in a database is a non-delivery
      // nobody notices for a day.
      console.warn(
        `[notifications] delivery ${prepared.claim.id}` +
          `${prepared.covers.length > 1 ? ` (a digest of ${prepared.covers.length})` : ''} failed ` +
          `(attempt ${prepared.claim.attempts}, now ${statuses[0]}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

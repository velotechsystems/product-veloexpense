import type { JobMap } from '@expenseos/jobs';
import { type AddressObject, simpleParser } from 'mailparser';
import { db } from '@/lib/db/prisma';
import { findThreadByEmailToken } from '@/lib/notifications/replyThreads';
import { getInboundMailStorage } from '@/lib/storage';
import { guardedRead } from '@/lib/storage/guardedRead';
import { ingestReplyComment } from '@/server/lib/inboundComment';
import { isAutoSubmitted } from './ingest-receipt-email';

/**
 * Handler for `email.ingestReply` — a reply to a notification email, as a COMMENT on its
 * subject (w5-01).
 *
 * ExpenseOS's `reply+<token>@` branch of `apps/web/src/app/api/email/inbound/route.ts`
 * (1e682dd6): resolve the thread from the token, require the From to be the recipient that
 * thread was addressed to, read the message, take its text, and post it through
 * `ingestReplyComment`. VeloExpense, each marked below:
 *   · it runs here, in the worker, as a job the route enqueues (decided 17 Oct 2026), because
 *     only the worker reads the inbound-mail bucket; the route has already verified SNS, the
 *     SES verdicts and the sender's alignment, and passes the authenticated From;
 *   · the job runs as the tenant the address named (`inTenant`), so the token is looked up
 *     inside that tenant only;
 *   · an auto-submitted message (an out-of-office, a bounce) is ignored, as the receipts
 *     mailbox ignores one — ExpenseOS's reply path has no such check, and an out-of-office
 *     answering a notification would otherwise become a comment on the report.
 */

/**
 * How much of a stored message the COMMENT path will read. ExpenseOS's
 * `MAX_COMMENT_MESSAGE_BYTES`: "A reply is prose; anything this large is an attachment
 * nobody will see in a comment, or a mistake."
 */
export const MAX_COMMENT_MESSAGE_BYTES = 2 * 1024 * 1024;

export async function handleIngestReplyEmail(data: JobMap['email.ingestReply']): Promise<void> {
  if (!data.token) return;
  const sender = data.sender.trim().toLowerCase();
  if (!sender) return;

  // VeloExpense: the message is read and parsed BEFORE the transaction opens — a storage read
  // must not hold a pooled connection — and nothing it says is trusted until the thread
  // below has been found and checked.
  const raw = await readMessage(data.bucket, data.objectKey);
  if (!raw) return;
  const parsed = await simpleParser(raw);
  if (isAutoSubmitted(parsed)) {
    console.info(`[email.ingestReply] ignoring an auto-submitted message (${data.sesMessageId})`);
    return;
  }
  // VeloExpense: the message's own From must be the authenticated sender — the route checked
  // one header of this message, and a disagreement means it is not the message that was
  // checked (as `email.ingestReceipts` refuses one).
  if (soleAddress(parsed.from) !== sender) {
    console.warn(`[email.ingestReply] refusing ${data.sesMessageId}: From is not the authenticated sender`);
    return;
  }
  const body = parsed.text ?? '';
  if (!body.trim()) return;

  // VeloExpense: one transaction for the lookup, the check and the comment, so a reply is
  // posted with its fan-out or not at all (`ingestReplyComment` explains why that matters).
  const outcome = await db.$transaction(async (tx) => {
    const thread = await findThreadByEmailToken(tx, data.token);
    if (!thread) return 'no thread for that token';

    // Require the From to match the recipient we addressed (defence in depth on top of the
    // secret token). Exact mailbox equality — NOT substring containment. A substring test
    // let "alice@e.inc.attacker.com" or "alice@e.inc <evil@x>" satisfy the check and post a
    // comment as the wrong actor.
    const recipient = await tx.user.findUnique({
      where: { id: thread.recipientId },
      select: { email: true },
    });
    if (!recipient || sender !== recipient.email.toLowerCase()) return 'sender is not the recipient';

    const ok = await ingestReplyComment({
      subjectType: thread.subjectType,
      subjectId: thread.subjectId,
      actorId: thread.recipientId,
      body,
      via: 'email',
      db: tx,
    });
    return ok ? null : 'not on the thread, or nothing left once quotes were stripped';
  });
  if (outcome) console.info(`[email.ingestReply] ${data.sesMessageId}: not posted (${outcome})`);
}

/** The one address in a From, lowercased; null for none or several. */
function soleAddress(from: AddressObject | undefined): string | null {
  const list = from?.value ?? [];
  if (list.length !== 1) return null;
  return list[0].address?.trim().toLowerCase() || null;
}

/**
 * The raw MIME SES stored. ExpenseOS's `loadRawMessage`, reading as `email.ingestReceipts`
 * does here: from the configured bucket only, capped, and null for anything too large.
 */
async function readMessage(bucket: string, objectKey: string): Promise<Buffer | null> {
  const configured = process.env.S3_INBOUND_MAIL_BUCKET?.trim();
  if (configured && bucket && bucket !== configured) {
    console.warn(`[email.ingestReply] refusing a message from an unexpected bucket: ${bucket}`);
    return null;
  }
  if (objectKey.includes('..')) return null;
  const got = await guardedRead(getInboundMailStorage(), objectKey, MAX_COMMENT_MESSAGE_BYTES);
  if (!got.ok) {
    console.warn(`[email.ingestReply] could not read ${objectKey}: ${got.reason}`);
    return null;
  }
  return Buffer.from(got.data.buffer, got.data.byteOffset, got.data.byteLength);
}

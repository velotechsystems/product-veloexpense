/**
 * Reply threads — map an outbound notification back to its subject so a reply
 * (email or Slack thread) becomes a COMMENT. One row per recipient × subject:
 *   - email → a `reply+<token>@<domain>` Reply-To; we store the token's sha256.
 *   - Slack → the per-subject DM thread root (channel + ts); later notifications
 *     post as replies under it, so any in-thread reply maps back to the subject.
 * Loose ids (no FK): the inbound path re-validates the subject + recipient.
 *
 * Ported from ExpenseOS's `packages/notifications/src/replyThreads.ts` (1e682dd6), w5-01.
 * VeloExpense: the client is the tenant's transaction (`TenantDb`), so a thread is found and
 * written inside one organization (0073 is under RLS); nothing else changed.
 */
import { createHash, createHmac } from 'node:crypto';
import type { TenantDb } from '@/lib/db/prisma';

type Db = TenantDb;

export interface ReplyThreadRef {
  id: string;
  subjectType: string;
  subjectId: string;
  recipientId: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const SELECT = {
  id: true,
  subjectType: true,
  subjectId: true,
  recipientId: true,
  slackChannelId: true,
  slackThreadTs: true,
} as const;

/** Get-or-create the reply thread for one recipient × subject. */
export async function ensureReplyThread(
  db: Db,
  key: { subjectType: string; subjectId: string; recipientId: string },
): Promise<ReplyThreadRef> {
  return db.replyThread.upsert({
    where: {
      recipientId_subjectType_subjectId: {
        recipientId: key.recipientId,
        subjectType: key.subjectType,
        subjectId: key.subjectId,
      },
    },
    create: key,
    update: {},
    select: SELECT,
  });
}

/** The raw reply token for a thread: a deterministic HMAC over the threadId
 *  with the app secret. Deterministic (not random) so the SAME Reply-To address
 *  is used for every email in the thread — a reply to any earlier message still
 *  resolves — while staying unguessable without the secret. */
function deriveReplyToken(threadId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return createHmac('sha256', secret).update(`reply:${threadId}`).digest('base64url');
}

/** Issue the email reply token for a thread and return the raw value to embed
 *  in the Reply-To local part. The token is stable for the thread's lifetime;
 *  the stored tokenHash is written idempotently (same value every call) so
 *  replies to every message in the thread keep resolving. */
export async function issueEmailReplyToken(db: Db, threadId: string): Promise<string> {
  const raw = deriveReplyToken(threadId);
  await db.replyThread.update({
    where: { id: threadId },
    data: { tokenHash: hashToken(raw) },
  });
  return raw;
}

/** Record the Slack DM thread root for a thread (first message ts). */
export async function setSlackThread(
  db: Db,
  threadId: string,
  channel: string,
  ts: string,
): Promise<void> {
  await db.replyThread.update({
    where: { id: threadId },
    data: { slackChannelId: channel, slackThreadTs: ts },
  });
}

/** Resolve an inbound email reply token (raw) to its thread, or null. */
export async function findThreadByEmailToken(db: Db, raw: string): Promise<ReplyThreadRef | null> {
  if (!raw) return null;
  return db.replyThread.findUnique({ where: { tokenHash: hashToken(raw) }, select: SELECT });
}

/** Resolve an inbound Slack thread reply (channel + parent ts) to its thread. */
export async function findThreadBySlack(
  db: Db,
  channel: string,
  threadTs: string,
): Promise<ReplyThreadRef | null> {
  if (!channel || !threadTs) return null;
  return db.replyThread.findFirst({
    where: { slackChannelId: channel, slackThreadTs: threadTs },
    select: SELECT,
  });
}

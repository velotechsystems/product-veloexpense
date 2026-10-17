/**
 * Inbound reply → COMMENT. Shared by the email (SES/SNS) and Slack-events
 * endpoints. The channel only identifies the actor + subject (a verified reply
 * token, or a Slack thread mapped to its subject); this turns the reply body
 * into a COMMENT activity and fans it out to the rest of the thread — the same
 * shape as the in-app `comments.post` mutation.
 *
 * Works for every subject that has a thread, not only card requests. Actionable
 * approve/reject in email and Slack shipped for all subjects in #222, so a
 * manager could already decide an expense report from their inbox — but typing a
 * sentence back instead of pressing a button silently did nothing. The reply was
 * accepted, verified, parsed, and dropped on the floor at the subject check.
 *
 * Ported from ExpenseOS's `apps/web/src/server/lib/inboundComment.ts` (1e682dd6), w5-01.
 * VeloExpense, each marked below:
 *   · it runs on the TENANT's transaction, which the caller passes — the `email.ingestReply`
 *     job's (`inTenant`) — so `db` is required where ExpenseOS defaults it;
 *   · the comment is recorded as `comments.post` records one here (server/routers/comments.ts):
 *     VeloExpense's activity service on that transaction, with the report placeholders
 *     (`reportPayload`) its notification's `{report}` needs;
 *   · the fan-out is not caught. See it.
 */
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';
import { stripQuotedReply } from './snsEmail';
import { threadParticipants } from './threadParticipants';

const MAX_BODY = 4000;

export interface ReplyInput {
  subjectType: string;
  subjectId: string;
  /** The authenticated actor (the notification recipient who replied). */
  actorId: string;
  body: string;
  via: 'email' | 'slack';
  /** VeloExpense: the tenant's transaction — required (see the header). */
  db: TenantDb;
}

/**
 * Record an inbound reply as a COMMENT. Returns false (no-op) when the subject
 * isn't commentable, the actor isn't a thread participant, or the body is empty
 * after stripping quotes.
 */
export async function ingestReplyComment(input: ReplyInput): Promise<boolean> {
  const db = input.db;
  const body = stripQuotedReply(input.body).slice(0, MAX_BODY).trim();
  if (!body) return false;

  /**
   * Authorize: the actor must already be on the thread.
   *
   * They were notified through it, so this is a check that the reply channel has
   * not been used to reach a subject the actor was never part of — the token or
   * the Slack thread proves WHO, this proves WHERE.
   */
  const participants = await threadParticipants(db, input.subjectType, input.subjectId);
  if (!participants.includes(input.actorId)) return false;

  // VeloExpense: the report's placeholders, as `comments.post` records them. A participant
  // was found above, so the report exists in this tenant.
  const report = await db.expenseReport.findUniqueOrThrow({
    where: { id: input.subjectId },
    select: { title: true, number: true, totalMinor: true, currencyId: true },
  });
  const tx = queryRunnerOf(db);
  const activityId = await recordActivity(tx, {
    // The subject the reply arrived on, not a constant. This line used to be
    // hardcoded to VIRTUAL_CARD_REQUEST, which — combined with a gate above it —
    // meant a reply on any other subject was dropped.
    subjectType: input.subjectType as 'EXPENSE_REPORT',
    subjectId: input.subjectId,
    eventType: 'COMMENT',
    actorId: input.actorId,
    payload: {
      ...reportPayload({
        title: report.title,
        number: report.number,
        totalMinor: report.totalMinor,
        currencyCode: report.currencyId,
      }),
      body,
      via: input.via,
    },
  });
  const others = participants.filter((id) => id !== input.actorId);
  /**
   * VeloExpense: NOT caught, where ExpenseOS logs and carries on ("best-effort fan-out").
   * The fan-out runs on this job's transaction, and a failed statement there has already
   * aborted it, so a caught failure would leave the comment unwritten while this reported
   * success. Uncaught, the whole job rolls back and its retry posts the comment once —
   * the same call `comments.post` makes.
   */
  await notifyRecipients(tx, activityId, others);
  return true;
}

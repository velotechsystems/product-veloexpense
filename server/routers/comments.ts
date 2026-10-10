/**
 * The discussion thread on a subject — read and post, for any subject that has one.
 *
 * One router rather than a copy per subject. The card-request thread
 * (`virtualCardRequests.comments`) came first and is left where it is; this exists so the
 * expense-report and travel threads are not a second and third transcription of it, each
 * with its own drift in what counts as access.
 *
 * The two things a thread router has to get right, and they pull in opposite directions:
 *
 *   · **Access is per subject and must not be re-derived.** Who may read an expense report
 *     is a real question with a real answer already written down (`canViewReport` — the
 *     submitter, their direct manager, anyone a task touched, anyone eligible to decide).
 *     Reimplementing that here would create a second definition that silently disagrees,
 *     and the disagreement would be a discussion visible to somebody who cannot see the
 *     report it is about.
 *   · **Everything else is subject-agnostic.** Fetching activities, mapping them, posting a
 *     comment, and fanning out to participants are identical, so they live here once.
 *
 * Adding a subject is one registry entry pointing at that subject's existing access check.
 *
 * VeloExpense: ExpenseOS's router (550b2945), ported with w2-02a (d37) for the expense report
 * — the travel subject arrives with travel. Differences, each marked:
 *   · the stream is VeloExpense's `activity` table, read with SQL (no Prisma model), and a
 *     comment is recorded through VeloExpense's notification service on the call's own
 *     transaction;
 *   · a decision's or a reassignment's REASON is part of the stream (`note`, and the new
 *     approver for a reassignment) — "the submitter and reviewer need to know reasons why
 *     rejected or reassigned" (d37). ExpenseOS shows the event and not its note.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { notifyRecipients, recordActivity, reportPayload } from '@/lib/notifications/service';
import { threadParticipants } from '../lib/threadParticipants';
import { protectedProcedure, router } from '../trpc';
import { canViewReport } from './expenseApprovals';

/** Subjects this router serves. Card requests keep their own endpoint (see above). */
const COMMENTABLE = ['EXPENSE_REPORT'] as const;
type Commentable = (typeof COMMENTABLE)[number];

const MAX_BODY = 4000;

type Ctx = {
  db: TenantDb;
  rbac: { id: string; permissions: readonly string[] };
};

/**
 * Can this caller see the subject's thread?
 *
 * Each entry delegates to the access check that already governs the subject itself, so a
 * thread is visible exactly when the thing it discusses is. Returns false for a subject
 * that does not exist — indistinguishable from no access on purpose, so the endpoint cannot
 * be used to probe which ids are real.
 */
const CAN_VIEW: Record<Commentable, (ctx: Ctx, subjectId: string) => Promise<boolean>> = {
  EXPENSE_REPORT: async (ctx, subjectId) => {
    const report = await ctx.db.expenseReport.findUnique({
      where: { id: subjectId },
      select: { id: true, submitterId: true },
    });
    if (!report) return false;
    return canViewReport(ctx.db, report, ctx.rbac.id, ctx.rbac.permissions);
  },
};

async function assertCanView(ctx: Ctx, subjectType: Commentable, subjectId: string) {
  if (!(await CAN_VIEW[subjectType](ctx, subjectId))) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
}

const subjectInput = z.object({
  subjectType: z.enum(COMMENTABLE),
  subjectId: z.string().uuid(),
});

/** VeloExpense (d37): the events whose reason the thread shows. */
const EVENTS_WITH_A_REASON = new Set(['APPROVED', 'REJECTED', 'RETURNED', 'REASSIGNED']);

export const commentsRouter = router({
  /**
   * The whole activity stream for a subject: system events and comments in one
   * chronological list.
   *
   * Interleaved rather than comments-only because the two halves are usually the same
   * conversation — "returned by Ana" and the comment saying why belong next to each other,
   * and splitting them across two panels makes the reader reconstruct the order themselves.
   */
  thread: protectedProcedure.input(subjectInput).query(async ({ ctx, input }) => {
    await assertCanView(ctx, input.subjectType, input.subjectId);
    // VeloExpense: VeloExpense's `activity`, with its actor's one display name.
    const rows = await ctx.db.$queryRaw<
      Array<{
        id: string;
        type: string;
        payload: Record<string, unknown> | null;
        createdAt: Date;
        actorName: string | null;
        actorEmail: string | null;
      }>
    >`
      SELECT a.id, a.event_type AS type, a.payload, a.occurred_at AS "createdAt",
             u.display_name AS "actorName", u.email AS "actorEmail"
        FROM activity a
        LEFT JOIN app_user u ON u.id = a.actor_id
       WHERE a.subject_type = ${input.subjectType} AND a.subject_id = ${input.subjectId}::uuid
       ORDER BY a.occurred_at, a.id`;
    return {
      items: rows.map((r) => {
        const payload = (r.payload ?? {}) as {
          body?: string;
          via?: string;
          note?: string;
          assignee?: string;
        };
        const reason = EVENTS_WITH_A_REASON.has(r.type) ? payload.note?.trim() || null : null;
        return {
          id: r.id,
          type: r.type,
          /** Only a COMMENT has prose. Reading `payload.body` for every type would leak
           *  whatever other events happen to store under that key. */
          body: r.type === 'COMMENT' ? (payload.body ?? '') : null,
          /** Which channel a comment arrived through, so a reply that came in by email
           *  reads as one rather than looking like it was typed here. */
          via: r.type === 'COMMENT' ? (payload.via ?? null) : null,
          /** VeloExpense (d37): why the report was decided or passed on, as the approver
           *  wrote it — named per event, for the same reason `body` is. */
          note: reason,
          /** VeloExpense (d37): who a reassignment went to. */
          assignee: r.type === 'REASSIGNED' ? (payload.assignee ?? null) : null,
          // VeloExpense: ExpenseOS's author shape, the one display name in `firstName`.
          author: r.actorEmail
            ? { firstName: r.actorName, lastName: null as string | null, email: r.actorEmail }
            : null,
          createdAt: r.createdAt,
        };
      }),
    };
  }),

  /** Post a comment. Same shape as an inbound email or Slack reply — one code path
   *  produces the activity, so an in-app comment and a replied-to notification are the
   *  same kind of thing rather than two near-identical ones. */
  post: protectedProcedure
    .input(subjectInput.extend({ body: z.string().min(1).max(MAX_BODY) }))
    .mutation(async ({ ctx, input }) => {
      await assertCanView(ctx, input.subjectType, input.subjectId);
      const body = input.body.trim();
      if (!body) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Empty comment.' });

      // VeloExpense: the report placeholders every EXPENSE_REPORT event carries
      // (`reportPayload`), for the notification's `{report}`.
      const report = await ctx.db.expenseReport.findUniqueOrThrow({
        where: { id: input.subjectId },
        select: { title: true, number: true, totalMinor: true, currencyId: true },
      });
      const tx = queryRunnerOf(ctx.db);
      const activityId = await recordActivity(tx, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        eventType: 'COMMENT',
        actorId: ctx.rbac.id,
        payload: {
          ...reportPayload({
            title: report.title,
            number: report.number,
            totalMinor: report.totalMinor,
            currencyCode: report.currencyId,
          }),
          body,
          via: 'app',
        },
      });

      /**
       * Fan out to everyone else on the thread.
       *
       * Participants, not "everyone who can view": a report's readers include anyone
       * *eligible* to decide it, which on a filter-approver step can be a whole pool. They
       * have not engaged with this report, and notifying them of every comment would train
       * them to ignore the channel.
       *
       * VeloExpense: not caught, where ExpenseOS logs and carries on. The fan-out runs on
       * this call's transaction, and a failed statement there has already aborted it — a
       * caught failure would leave the comment unwritten while the call reported success.
       */
      const participants = await threadParticipants(ctx.db, input.subjectType, input.subjectId);
      const others = participants.filter((id) => id !== ctx.rbac.id);
      await notifyRecipients(tx, activityId, others);
      return { id: activityId };
    }),
});

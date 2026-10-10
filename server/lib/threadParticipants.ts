/**
 * Who is on a subject's discussion thread.
 *
 * Shared by the two things that create comments — an inbound email/Slack reply
 * (`inboundComment`) and the in-app `comments.post` mutation — because they need the same
 * answer for different reasons, and two answers would be worse than either:
 *
 *   · the inbound path uses it to AUTHORIZE (the replier must already be on the thread);
 *   · the in-app path uses it to FAN OUT (notify the others, not everyone who can read).
 *
 * If those two lists disagreed, a person could post a comment nobody is told about, or be
 * told about a thread they are not allowed to post to.
 *
 * Deliberately narrower than "everyone who can view the subject". A report's readers
 * include anyone *eligible* to decide it, which on a filter-approver step can be a whole
 * pool of people who have never touched it — notifying them of every comment is how a
 * channel gets muted.
 *
 * VeloExpense: ExpenseOS's `server/lib/threadParticipants.ts` (550b2945), for the one subject
 * with a thread here — the expense report (w2-02a, d37). The card-request and travel
 * subjects arrive with their modules, and the inbound reply path with the email channel.
 * Read off VeloExpense's tables: the tasks of EVERY run of the report, where ExpenseOS reads
 * its one current instance (see `canViewReport`).
 */
import type { TenantDb } from '@/lib/db/prisma';

/** The subjects with a thread. ExpenseOS's `COMMENT_THREAD_SUBJECTS`, for this module. */
export const COMMENT_THREAD_SUBJECTS = ['EXPENSE_REPORT'] as const;
export type CommentThreadSubject = (typeof COMMENT_THREAD_SUBJECTS)[number];

export function hasCommentThread(subjectType: string): subjectType is CommentThreadSubject {
  return (COMMENT_THREAD_SUBJECTS as readonly string[]).includes(subjectType);
}

/**
 * Everyone on a subject's thread: its owner plus every task assignee / decider.
 *
 * Empty means the subject has no thread or does not exist — the two are not distinguished
 * because they cannot be: a subject that exists always has an owner, so a real subject
 * never yields an empty set. Returning `null` for one and `[]` for the other would be a
 * distinction nothing can act on.
 */
export async function threadParticipants(
  db: TenantDb,
  subjectType: string,
  subjectId: string,
): Promise<string[]> {
  if (!hasCommentThread(subjectType)) return [];
  const report = await db.expenseReport.findUnique({
    where: { id: subjectId },
    select: { submitterId: true },
  });
  if (!report) return [];

  const ids = new Set<string>([report.submitterId]);
  const tasks = await db.$queryRaw<Array<{ assigneeId: string | null; decidedById: string | null }>>`
    SELECT t.assignee_id AS "assigneeId", t.decided_by_id AS "decidedById"
      FROM approval_task t
      JOIN approval_request q ON q.id = t.request_id
     WHERE q.report_id = ${subjectId}::uuid`;
  for (const t of tasks) {
    if (t.assigneeId) ids.add(t.assigneeId);
    if (t.decidedById) ids.add(t.decidedById);
  }
  return [...ids];
}

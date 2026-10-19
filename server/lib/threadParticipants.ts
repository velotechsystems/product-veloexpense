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
 * VeloExpense: ExpenseOS's `server/lib/threadParticipants.ts` (550b2945), for the subjects
 * with a thread here — the expense report (w2-02a, d37) and, since w6-01, the travel request
 * (ExpenseOS's `OWNER_RESOLVERS` entry for it, 1e682dd6). The card-request subject is out of
 * scope.
 * The tasks of EVERY approval of the report, where ExpenseOS reads its one current instance
 * (see `canViewReport`): the engine's instances (w4-00c). The ladder's runs went with its
 * tables (w4-00d, d61).
 */
import type { TenantDb } from '@/lib/db/prisma';

/** The subjects with a thread. ExpenseOS's `COMMENT_THREAD_SUBJECTS`, for this module. */
export const COMMENT_THREAD_SUBJECTS = ['EXPENSE_REPORT', 'TRAVEL_REQUEST'] as const;
export type CommentThreadSubject = (typeof COMMENT_THREAD_SUBJECTS)[number];

export function hasCommentThread(subjectType: string): subjectType is CommentThreadSubject {
  return (COMMENT_THREAD_SUBJECTS as readonly string[]).includes(subjectType);
}

/**
 * Who owns a commentable subject. ExpenseOS's `OWNER_RESOLVERS` (1e682dd6): adding a subject
 * is one entry, and the `Record` is total over `CommentThreadSubject`, so this map and the
 * list above cannot drift apart without failing to compile.
 *
 * VeloExpense (w6-01): only the owner is resolved — the approval tasks are read across EVERY
 * instance of the subject (below), not ExpenseOS's one current instance, as the report's
 * thread already was here (w4-00c).
 */
export const OWNER_RESOLVERS: Record<
  CommentThreadSubject,
  (db: TenantDb, subjectId: string) => Promise<string | null>
> = {
  EXPENSE_REPORT: async (db, id) => {
    const r = await db.expenseReport.findUnique({
      where: { id },
      select: { submitterId: true },
    });
    return r?.submitterId ?? null;
  },
  TRAVEL_REQUEST: async (db, id) => {
    const r = await db.travelRequest.findUnique({
      where: { id },
      select: { submitterId: true },
    });
    return r?.submitterId ?? null;
  },
};

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
  const ownerId = await OWNER_RESOLVERS[subjectType](db, subjectId);
  if (!ownerId) return [];

  const ids = new Set<string>([ownerId]);
  const tasks = await db.$queryRaw<Array<{ assigneeId: string | null; decidedById: string | null }>>`
    SELECT t.assignee_user_id AS "assigneeId", t.decided_by_id AS "decidedById"
      FROM approval_instance_task t
      JOIN approval_instance i ON i.id = t.instance_id
     WHERE i.subject_type = ${subjectType} AND i.subject_id = ${subjectId}::uuid`;
  for (const t of tasks) {
    if (t.assigneeId) ids.add(t.assigneeId);
    if (t.decidedById) ids.add(t.decidedById);
  }
  return [...ids];
}

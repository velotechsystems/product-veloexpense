/**
 * One answer to "may this person decide this task, and is that an OVERRIDE?" — shared by
 * every decide, reassign and adjust path across expense reports, card requests, limit
 * increases and travel.
 *
 * Two questions, asked in order, because the audit row has to tell them apart:
 *
 *   1. Is the actor eligible on the task's own terms — assignee, delegatee, pool member,
 *      claimant of an unresolved task? That is `canDecide` with no override, and it is the
 *      ordinary path. Nothing about it changes here.
 *   2. If not: does the actor hold the module's `…decide.any` permission? Then the engine
 *      is asked again WITH the override, which still applies the self-approval block — the
 *      override lets somebody decide a task that was never theirs, not their own money.
 *
 * WHY THE PERMISSION IS PASSED IN RATHER THAN LOOKED UP. Each subject has its own override
 * (`expense.report.decide.any`, `travel.request.decide.any`, `vcc.request.decide.any`) so
 * that a role can own one module's approvals without owning another's, and so that module
 * gating keeps working. The caller knows which module it is; this helper does not need to.
 *
 * WHY THE SECOND CALL. Before this the routers computed one flag and handed it to the
 * engine, and the audit row recorded a plain `report.approve` whether the approver was the
 * assigned manager or somebody bypassing them. A reviewer reading the log could not tell
 * an override from an ordinary approval. Two calls cost one extra task lookup, and only
 * for an override holder who is not otherwise eligible — the person whose decision most
 * needs the label.
 */
import { canDecide } from '@expenseos/approvals/engine';
import type { Prisma, PrismaClient as BaseClient } from '@expenseos/db';

/** VeloExpense: the caller's tenant transaction, or the scoped client (ExpenseOS: its client). */
type PrismaClient = BaseClient | Prisma.TransactionClient;

export type DecideAccess =
  | { allowed: true; override: boolean }
  | { allowed: false; override: false };

export async function resolveDecideAccess(
  db: PrismaClient,
  taskId: string,
  actorId: string,
  mayOverride: boolean,
): Promise<DecideAccess> {
  if (await canDecide(db, taskId, actorId, false)) return { allowed: true, override: false };
  if (mayOverride && (await canDecide(db, taskId, actorId, true))) {
    return { allowed: true, override: true };
  }
  return { allowed: false, override: false };
}

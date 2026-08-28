/**
 * VX2-2 — the DECISION-TIME guard. Who may decide an approval task.
 *
 * ONE function answers this, and both surfaces ask it: `assertCanDecide` for the
 * server action, `canDecide` for whatever the page uses to decide whether to
 * render an Approve control. They are not two predicates that happen to agree.
 *
 * That is GAP-AUDIT AP-15, and it is a bug ExpenseOS shipped: their
 * `callerCanDecideReport` opened with `if (isAdmin) return true` while the
 * mutation behind the button asked the engine, so once the engine began refusing
 * a requester their own subject, the page rendered an Approve button that failed
 * when pressed. "One question, one answer, both surfaces."
 *
 * ── Why routing-time refusal is not enough ──────────────────────────────────
 *
 * `lib/approvals/routing.ts` declares `SELF_APPROVAL` as a routing error, and
 * the resolver does refuse to produce a self-assigned task. That is necessary
 * and insufficient: VX2-4 (reassign) and VX2-5 (delegation) can both move a task
 * onto the submitter AFTER it was routed cleanly. This module is the
 * authoritative copy of the rule (GAP-AUDIT AP-13).
 */
import type { QueryRunner } from '@/lib/db/client';

export type DecisionRefusal =
  | 'TASK_NOT_FOUND'
  | 'NOT_PENDING'
  | 'SELF_APPROVAL'
  | 'NOT_AN_APPROVER';

export class DecisionForbiddenError extends Error {
  constructor(
    message: string,
    readonly code: DecisionRefusal,
  ) {
    super(message);
    this.name = 'DecisionForbiddenError';
  }
}

/**
 * Everything the guard needs, in one query.
 *
 * `report.submitter_id` is the requester — the person whose money this is. It is
 * fetched unconditionally rather than lazily, because the self-approval check
 * runs before every grant and therefore always needs it. ExpenseOS's version
 * loads it late, which is the mechanical reason their check ended up positioned
 * after the admin short-circuit.
 */
const TASK_QUERY = `
  SELECT t.id,
         t.status,
         t.assignee_id,
         t.claim_role,
         t.resolved_via,
         r.report_id,
         rep.submitter_id,
         o.allow_sole_approver_self_approval AS break_glass
    FROM approval_task   t
    JOIN approval_request r   ON r.id  = t.request_id
    JOIN expense_report   rep ON rep.id = r.report_id
    JOIN organization     o   ON o.id  = t.organization_id
   WHERE t.id = $1`;

interface TaskRow {
  id: string;
  status: string;
  assignee_id: string | null;
  claim_role: string | null;
  resolved_via: string;
  report_id: string;
  submitter_id: string;
  break_glass: boolean;
}

/** Is `actorId` an active holder of `role`? */
const HOLDS_ROLE_QUERY = `
  SELECT 1
    FROM app_user u
   WHERE u.id = $1
     AND u.role = $2
     AND u.deleted_at IS NULL
     AND u.employee_status = 'ACTIVE'`;

/**
 * Does `actorId` hold an active, in-scope delegation from `delegatorId` today?
 *
 * Mirrors the resolver's `DELEGATION_QUERY` — same scope set, same inclusive
 * date range, same `revoked_at IS NULL`. A delegatee may decide a task still
 * assigned to their delegator, which covers tasks parked BEFORE the delegation
 * was created and tasks whose assignee went away after assignment. Without this,
 * "I am away, cover for me" would only work for reports submitted afterwards.
 */
const DELEGATED_TO_QUERY = `
  SELECT 1
    FROM delegation d
   WHERE d.from_user_id = $1
     AND d.to_user_id   = $2
     AND d.revoked_at IS NULL
     AND d.scope = ANY($3::text[])
     AND d.starts_on <= $4::date
     AND (d.ends_on IS NULL OR d.ends_on >= $4::date)`;

async function exists(tx: QueryRunner, sql: string, params: unknown[]): Promise<boolean> {
  const r = await tx.query(sql, params);
  return r.rows.length > 0;
}

export interface DecisionContext {
  /** Today in the tenant's working timezone — a delegation range is dates. */
  onDate?: Date;
  /** The caller holds the tenant ADMIN role. */
  isAdmin?: boolean;
}

/**
 * May `actorId` decide `taskId`?
 *
 * THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, not an implementation
 * detail. The self-approval refusal runs ahead of EVERY grant below it — the
 * admin override, the assignee path, the delegatee path and the claim pool
 * alike. ExpenseOS had this same rule sitting thirty lines below
 * `if (isAdmin) return true`, which made it unreachable for exactly the people
 * best able to break it: a System Administrator submitted a report, was offered
 * Approve, and the approval succeeded and was recorded as real — while the
 * ladder had assigned the decision to their manager and their own inbox showed
 * nothing (their F15 / F20, blocker B3). A privileged user approving their own
 * expenses outside the assigned route is a standard SOX audit exception.
 *
 * Ahead of the ASSIGNEE path too, not only the pool: a ladder that resolves an
 * approver relative to the submitter can legitimately land the task on the
 * submitter, and "the ladder named me" is not a reason to sign off your own
 * money.
 */
export async function canDecide(
  tx: QueryRunner,
  taskId: string,
  actorId: string,
  ctx: DecisionContext = {},
): Promise<boolean> {
  const task = await loadTask(tx, taskId);
  if (!task) return false;
  return evaluate(tx, task, actorId, ctx);
}

async function loadTask(tx: QueryRunner, taskId: string): Promise<TaskRow | undefined> {
  const r = await tx.query(TASK_QUERY, [taskId]);
  return r.rows[0] as TaskRow | undefined;
}

/** The rules, over an already-loaded task. Both entry points share this so the
 *  task is fetched exactly once per call — and, more importantly, so there is
 *  literally one copy of the ordering below. */
async function evaluate(
  tx: QueryRunner,
  task: TaskRow,
  actorId: string,
  ctx: DecisionContext,
): Promise<boolean> {
  if (task.status !== 'PENDING') return false;

  /* ── 1. Self-approval, before anything else ──────────────────────────── */
  if (task.submitter_id === actorId) {
    // The single, narrow exception (GAP-AUDIT AP-14): the tenant has enabled
    // the break-glass AND the resolver already proved, at routing time, that
    // nobody else could take this task — which is what `ADMIN_FALLBACK` on a
    // task assigned to the submitter means. Both conditions, or no.
    //
    // Deliberately NOT re-proved here. If a second administrator joined
    // between submit and decision, the task is still parked on the submitter
    // and re-proving would make it undecidable by anyone; reassignment (VX2-4)
    // is the route for that, and it is a visible action by a person.
    const soleApprover =
      task.break_glass &&
      task.resolved_via === 'ADMIN_FALLBACK' &&
      task.assignee_id === actorId;
    return soleApprover;
  }

  /* ── 2. Admin override — for everybody else's report ─────────────────── */
  // Load-bearing: it is how a stuck queue gets unwedged. What the block above
  // removes is the ability to use it on your own.
  if (ctx.isAdmin) return true;

  /* ── 3. The assignee ─────────────────────────────────────────────────── */
  if (task.assignee_id !== null && task.assignee_id === actorId) return true;

  /* ── 4. A delegatee acting for the assignee ──────────────────────────── */
  const onDate = ctx.onDate ?? new Date();
  if (
    task.assignee_id !== null &&
    (await exists(tx, DELEGATED_TO_QUERY, [
      task.assignee_id,
      actorId,
      ['ALL', 'REPORTS'],
      onDate,
    ]))
  ) {
    return true;
  }

  /* ── 5. The claim pool ───────────────────────────────────────────────── */
  //
  // Membership of the named role IS the authorization, and the subject's
  // approve permission is deliberately not also required — an admin who routes
  // a rung to a role means what they wrote, and demanding both would strand the
  // task on a technicality invisible from the ladder editor. Ported verbatim
  // from ExpenseOS's `holdsRole`, including that reasoning.
  //
  // KNOWN GAP, recorded rather than quietly diverged: this does NOT exclude the
  // submitter's own subordinates. ExpenseOS applies its subordinate exclusion to
  // the permission-pool fallback and not to a role pool, and porting the
  // divergence would create a new dead end — in a small tenant the only other
  // ADMIN may well report to the submitter, and excluding them makes the task
  // unclaimable with nothing to fall back to. The resolver DOES exclude
  // subordinates where it picks a person itself (`ADMIN_QUERY`), because there
  // the break-glass catches the empty case. Closing it here needs a
  // segregation-of-duties design that says what happens to the stranded task —
  // its own ticket, not a silent change in this one.
  if (task.claim_role !== null) {
    return exists(tx, HOLDS_ROLE_QUERY, [actorId, task.claim_role]);
  }

  return false;
}

/**
 * `canDecide`, as a gate. The server action calls this; the page calls
 * `canDecide`. One question, one answer, both surfaces (GAP-AUDIT AP-15).
 */
export async function assertCanDecide(
  tx: QueryRunner,
  taskId: string,
  actorId: string,
  ctx: DecisionContext = {},
): Promise<void> {
  const task = await loadTask(tx, taskId);
  if (!task) {
    throw new DecisionForbiddenError(`approval task ${taskId} does not exist`, 'TASK_NOT_FOUND');
  }
  if (task.status !== 'PENDING') {
    throw new DecisionForbiddenError(
      `approval task ${taskId} is ${task.status}, not PENDING`,
      'NOT_PENDING',
    );
  }
  if (await evaluate(tx, task, actorId, ctx)) return;
  // The distinct code matters to the caller: a self-approval refusal is a
  // sentence an admin can act on ("enable self-approval for this organization,
  // or add a second approver"), while NOT_AN_APPROVER is a plain 403.
  if (task.submitter_id === actorId) {
    throw new DecisionForbiddenError(
      `a report may not be approved by the person who submitted it`,
      'SELF_APPROVAL',
    );
  }
  throw new DecisionForbiddenError(
    `user ${actorId} may not decide approval task ${taskId}`,
    'NOT_AN_APPROVER',
  );
}

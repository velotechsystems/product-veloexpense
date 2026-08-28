/**
 * VX2-1 — the routing SEAM. VX2-2 fills it in (`lib/approvals/resolver.ts`).
 *
 * Types only. VX2-2 implements `ApprovalRouter` as the tiered resolver
 * (walk the manager chain past ON_LEAVE / DEACTIVATED, bounded depth; an active
 * delegation wins ahead of the chain; self-approval refused unconditionally; an
 * unresolvable rung escalates rather than auto-approving).
 *
 * WHY IT IS AN INTERFACE AND NOT JUST A FUNCTION. The Port & Build Plan's risk
 * register says to keep ExpenseOS's workflow-graph engine out of the default
 * path but to leave room for it as an advanced tier. This is that room: the
 * graph would arrive as a second implementation of this one interface, and
 * VX2-3's transition code — which is what would otherwise have to change —
 * only ever sees `ResolvedAssignment[]`.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { StepPlan, TaskResolution } from '@/lib/approvals/tiers';
import type { EmployeeRole } from '@/lib/employees/service';

/** What the resolver is routing. */
export interface RoutingSubject {
  reportId: string;
  submitterId: string;
  totalMinor: string;
  currencyCode: string;
  /** Today, in the tenant's working timezone — a delegation range is dates. */
  onDate: Date;
}

/**
 * WHO owns a task, as a discriminated union rather than three nullable fields.
 *
 * This mirrors `approval_task_owner_exclusive` — `num_nonnulls(assignee_id,
 * assignee_email, claim_role) = 1` — in the type system, so the illegal states
 * the CHECK rejects cannot be constructed in the first place and the INSERT
 * cannot disagree with the constraint. Same argument GAP-AUDIT AP-11 makes for
 * VeloExpense's column model over ExpenseOS's JSON graph, applied one layer up.
 *
 * VX2-1 declared this as a bare `assigneeId: string`. That could not express a
 * role-claimable task, which `0009` introduced once `DEFAULT_LADDER`'s
 * "Finance sign-off" rung turned out to need one (GAP-AUDIT AP-7).
 */
export type ResolvedOwner =
  /** An internal named approver: the common case. */
  | { kind: 'USER'; assigneeId: string }
  /** An external approver. Storable now, actionable at VX2-8. */
  | { kind: 'EMAIL'; assigneeEmail: string }
  /**
   * A role pool: unassigned on purpose, claimable by active holders of this
   * role. Deliberately NOT resolved to a person here — picking one would make
   * the same authored ladder behave differently the day somebody else is given
   * the role, which is invisible to whoever wrote the ladder.
   */
  | { kind: 'ROLE'; claimRole: EmployeeRole };

/** One filled step: who decides, how we got to them, and how far we walked. */
export interface ResolvedAssignment {
  step: number;
  owner: ResolvedOwner;
  resolvedVia: TaskResolution;
  /** Set only when resolvedVia is 'DELEGATION' (approval_task CHECK). */
  delegatedFromId: string | null;
  /**
   * Links between the person the policy pointed at and the person who got it.
   * 0 = the intended approver.
   *
   * `0008` documented this narrowly as "extra links walked past absent
   * approvers". GAP-AUDIT AP-10 generalized it, because the resolver can also
   * land SHORT of the intended approver: a rung naming `manager_level = 3` in a
   * two-deep org degrades to the most senior person found rather than failing
   * the submit. Both are a distance from the intended approver, so both are
   * recorded here; the direction is recoverable by walking the submitter's
   * chain to the assignee, and it is the non-zero-ness an admin acts on.
   */
  escalationLevel: number;
}

export type RoutingErrorCode =
  | 'NO_ELIGIBLE_APPROVER'
  | 'SELF_APPROVAL'
  | 'CHAIN_EXHAUSTED'
  | 'UNRESOLVABLE_RUNG'
  /**
   * An EMAIL approver was configured, and there is no way for an external party
   * to act on a task yet — the approve-link token surface is VX2-8 (VeloLedger
   * 0067 is the reference). Storing the config is allowed; routing onto it is
   * not, because the alternative is a task that can never be decided and a
   * report stuck in SUBMITTED forever. Remove this code when VX2-8 lands.
   */
  | 'EMAIL_APPROVER_UNSUPPORTED';

/**
 * Routing fails CLOSED. Every one of these codes means "this report does not
 * get approved right now" — never "so approve it anyway".
 */
export class RoutingError extends Error {
  constructor(
    message: string,
    readonly code: RoutingErrorCode,
    readonly step: number | null = null,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export interface ApprovalRouter {
  /**
   * Resolve every step of the plan, or throw. All-or-nothing on purpose: a
   * partially routed request would open a run whose later steps have nobody to
   * decide them, which surfaces days later as a report stuck in SUBMITTED.
   */
  resolve(
    tx: QueryRunner,
    subject: RoutingSubject,
    plan: StepPlan[],
  ): Promise<ResolvedAssignment[]>;
}

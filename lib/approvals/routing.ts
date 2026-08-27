/**
 * VX2-1 — the routing SEAM.
 *
 * Types only. VX2-2 implements `ApprovalRouter` here as the tiered resolver
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
import type { RungPlan, TaskResolution } from '@/lib/approvals/tiers';

/** What the resolver is routing. */
export interface RoutingSubject {
  reportId: string;
  submitterId: string;
  totalMinor: string;
  currencyCode: string;
  /** Today, in the tenant's working timezone — a delegation range is dates. */
  onDate: Date;
}

/** One filled step: who decides, how we got to them, and how far we walked. */
export interface ResolvedAssignment {
  step: number;
  assigneeId: string;
  resolvedVia: TaskResolution;
  /** Set only when resolvedVia is 'DELEGATION' (approval_task CHECK). */
  delegatedFromId: string | null;
  /** Extra links walked past absent approvers. 0 = the intended approver. */
  escalationLevel: number;
}

export type RoutingErrorCode =
  | 'NO_ELIGIBLE_APPROVER'
  | 'SELF_APPROVAL'
  | 'CHAIN_EXHAUSTED'
  | 'UNRESOLVABLE_RUNG';

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
    plan: RungPlan[],
  ): Promise<ResolvedAssignment[]>;
}

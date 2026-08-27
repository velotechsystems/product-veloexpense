/**
 * VX2-1 — the approval LADDER: types, the starter set, and rung selection.
 *
 * This module is PURE. It takes an already-loaded set of rungs plus a report
 * total and returns the ordered plan of approval steps; it never touches the
 * database. Same split as lib/policy/rules.ts, and for the same reason — the
 * part that decides how many people have to sign off is the part that must be
 * reviewable and unit-testable, so it lives in version control while the
 * per-tenant numbers live in rows.
 *
 * THE MODEL. A rung says "when the total reaches this threshold, one more
 * approval is required, from this kind of approver". A report collects EVERY
 * enabled rung whose threshold it meets, in `sequence` order, and each becomes
 * one sequential step. "Always the manager; past $1,000 a second level; past
 * $5,000 finance as well" is three rows: a $200 report needs one sign-off, a
 * $6,000 report needs three.
 *
 * WHAT THIS IS NOT: ExpenseOS's versioned workflow graph with a JSON
 * matchCondition predicate, parallel and quorum nodes, and subject adapters.
 * The Port & Build Plan's risk register calls that SMB onboarding friction, so
 * it stays out of the default path. lib/approvals/routing.ts carries the one
 * interface an advanced tier would implement.
 */
import { toBigInt, type MinorAmount } from '@/lib/money';
import type { EmployeeRole } from '@/lib/employees/service';

/** How many approvals may be REQUIRED of one report (approval_request CHECK). */
export const MAX_APPROVAL_STEPS = 5;
/** How many rungs a tenant may configure (approval_policy CHECK). */
export const MAX_CONFIGURED_RUNGS = 10;
/** How far up the chain a MANAGER rung may point (approval_policy CHECK). */
export const MAX_MANAGER_LEVEL = 5;

export const APPROVER_KINDS = ['MANAGER', 'ROLE', 'USER'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

export const REQUEST_STATUSES = [
  'RUNNING',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'CANCELLED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TASK_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** How an assignee was arrived at. Mirrors approval_task_resolved_via_check. */
export const TASK_RESOLUTIONS = [
  'MANAGER_CHAIN',
  'ROLE',
  'USER',
  'DELEGATION',
  'ADMIN_FALLBACK',
  'REASSIGNED',
] as const;
export type TaskResolution = (typeof TASK_RESOLUTIONS)[number];

export const DELEGATION_SCOPES = ['ALL', 'REPORTS'] as const;
export type DelegationScope = (typeof DELEGATION_SCOPES)[number];

export function isApproverKind(value: string): value is ApproverKind {
  return (APPROVER_KINDS as readonly string[]).includes(value);
}

/**
 * A rung as stored. `threshold_minor` is a bigint column, which node-postgres
 * hands back as a STRING — never widen it to `number`, that is how a cent goes
 * missing (lib/money.ts).
 */
export interface ApprovalPolicyRow {
  id: string;
  name: string;
  sequence: number;
  threshold_minor: string;
  approver_kind: ApproverKind;
  manager_level: number | null;
  approver_role: EmployeeRole | null;
  approver_user_id: string | null;
  /** Joined for display by listPolicies; not part of the row proper. */
  approver_user_email?: string | null;
  approver_user_name?: string | null;
  require_receipt_view_ack: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/** What an admin may write. */
export interface NewApprovalPolicy {
  name: string;
  sequence: number;
  thresholdMinor?: MinorAmount;
  approverKind: ApproverKind;
  managerLevel?: number | null;
  approverRole?: EmployeeRole | null;
  approverUserId?: string | null;
  requireReceiptViewAck?: boolean;
  enabled?: boolean;
}

export type ApprovalPolicyPatch = Partial<NewApprovalPolicy>;

/**
 * One step of a planned approval, and one element of
 * `approval_request.policy_snapshot`. Deliberately a flat, self-contained
 * record rather than a policy id: the snapshot has to stay meaningful after the
 * rung it came from is retuned or deleted.
 */
export interface RungPlan {
  /** 1-based position in THIS report's ladder, not the rung's `sequence`. */
  step: number;
  /** null for the implicit rung — there is no row behind it. */
  policyId: string | null;
  name: string;
  thresholdMinor: string;
  approverKind: ApproverKind;
  managerLevel: number | null;
  approverRole: EmployeeRole | null;
  approverUserId: string | null;
  requireReceiptViewAck: boolean;
}

export type ApprovalConfigErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_SEQUENCE'
  | 'INVALID_THRESHOLD'
  | 'INVALID_KIND'
  | 'INVALID_MANAGER_LEVEL'
  | 'INVALID_ROLE'
  | 'INVALID_APPROVER'
  | 'TOO_MANY_STEPS'
  | 'NOT_FOUND'
  | 'SEQUENCE_TAKEN';

export class ApprovalConfigError extends Error {
  constructor(
    message: string,
    readonly code: ApprovalConfigErrorCode,
  ) {
    super(message);
    this.name = 'ApprovalConfigError';
  }
}

/**
 * The rung used when a tenant has configured NONE: one approval from the
 * submitter's direct manager, receipts acknowledged.
 *
 * This is the one place the approvals ladder deliberately departs from the
 * policy engine's precedent. A fresh tenant has no policy RULES until an admin
 * restores the starter set, and the consequence is benign — nothing flags. A
 * fresh tenant with no approval rungs is not benign in either direction: with no
 * fallback, either every submitted report auto-approves (fails OPEN, which the
 * ticket forbids) or nothing can be submitted at all until an admin has
 * configured a ladder (which is exactly the onboarding friction the Port & Build
 * Plan's risk register warns about). An implicit direct-manager rung still puts
 * a human in the path, so it fails closed while working out of the box.
 *
 * If the submitter has no manager, this rung is unresolvable and VX2-2 fails the
 * routing rather than skipping the step.
 */
export const IMPLICIT_RUNG: Omit<RungPlan, 'step'> = {
  policyId: null,
  name: 'Direct manager (default)',
  thresholdMinor: '0',
  approverKind: 'MANAGER',
  managerLevel: 1,
  approverRole: null,
  approverUserId: null,
  requireReceiptViewAck: true,
};

/**
 * The starter ladder, applied by "Restore starter ladder" — the same shape as
 * DEFAULT_POLICIES in lib/policy/rules.ts, and for the same reason: ONE copy,
 * in code, so there is no seed script holding a second version to drift from.
 * `scripts/seed.mjs` deliberately seeds no rungs.
 *
 * Thresholds are minor units and assume a 2-decimal reporting currency, the same
 * assumption the policy admin page makes; every currency VeloExpense ships has
 * minor_unit 2.
 */
export const DEFAULT_LADDER: NewApprovalPolicy[] = [
  {
    name: 'Direct manager',
    sequence: 1,
    thresholdMinor: '0',
    approverKind: 'MANAGER',
    managerLevel: 1,
    requireReceiptViewAck: true,
  },
  {
    name: 'Second-level manager',
    sequence: 2,
    thresholdMinor: '100000', // 1,000.00
    approverKind: 'MANAGER',
    managerLevel: 2,
    requireReceiptViewAck: true,
  },
  {
    name: 'Finance sign-off',
    sequence: 3,
    thresholdMinor: '500000', // 5,000.00
    approverKind: 'ROLE',
    approverRole: 'ADMIN',
    requireReceiptViewAck: true,
  },
];

/* ── validation ────────────────────────────────────────────────────────────── */

/**
 * Mirrors the CHECK constraints on approval_policy so a bad write comes back as
 * a sentence rather than a Postgres 23514. The constraints stay in the schema
 * regardless — this is the message, not the guarantee.
 */
export function assertPolicyInput(input: NewApprovalPolicy): void {
  if (!input.name || input.name.trim() === '') {
    throw new ApprovalConfigError('a rung needs a name', 'INVALID_NAME');
  }
  if (
    !Number.isInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > MAX_CONFIGURED_RUNGS
  ) {
    throw new ApprovalConfigError(
      `sequence must be a whole number from 1 to ${MAX_CONFIGURED_RUNGS}`,
      'INVALID_SEQUENCE',
    );
  }
  if (input.thresholdMinor !== undefined && toBigInt(input.thresholdMinor) < 0n) {
    throw new ApprovalConfigError('threshold cannot be negative', 'INVALID_THRESHOLD');
  }
  if (!isApproverKind(input.approverKind)) {
    throw new ApprovalConfigError(`unknown approver kind: ${input.approverKind}`, 'INVALID_KIND');
  }

  // Exactly the companion the kind needs, and nothing else. An under-specified
  // rung is unresolvable, and an unresolvable rung has to fail closed at
  // approval time — far better to refuse it here, where somebody is looking.
  const hasLevel = input.managerLevel != null;
  const hasRole = input.approverRole != null;
  const hasUser = input.approverUserId != null;

  if (input.approverKind === 'MANAGER') {
    if (!hasLevel) {
      throw new ApprovalConfigError(
        'a manager rung needs a level (1 = the direct manager)',
        'INVALID_MANAGER_LEVEL',
      );
    }
    if (
      !Number.isInteger(input.managerLevel) ||
      input.managerLevel! < 1 ||
      input.managerLevel! > MAX_MANAGER_LEVEL
    ) {
      throw new ApprovalConfigError(
        `manager level must be a whole number from 1 to ${MAX_MANAGER_LEVEL}`,
        'INVALID_MANAGER_LEVEL',
      );
    }
    if (hasRole || hasUser) {
      throw new ApprovalConfigError(
        'a manager rung cannot also name a role or a person',
        'INVALID_APPROVER',
      );
    }
  } else if (input.approverKind === 'ROLE') {
    if (!hasRole) throw new ApprovalConfigError('a role rung needs a role', 'INVALID_ROLE');
    if (hasLevel || hasUser) {
      throw new ApprovalConfigError(
        'a role rung cannot also name a manager level or a person',
        'INVALID_APPROVER',
      );
    }
  } else {
    if (!hasUser) throw new ApprovalConfigError('a user rung needs a person', 'INVALID_APPROVER');
    if (hasLevel || hasRole) {
      throw new ApprovalConfigError(
        'a user rung cannot also name a manager level or a role',
        'INVALID_APPROVER',
      );
    }
  }
}

/* ── selection ─────────────────────────────────────────────────────────────── */

function toPlan(row: ApprovalPolicyRow, step: number): RungPlan {
  return {
    step,
    policyId: row.id,
    name: row.name,
    thresholdMinor: String(row.threshold_minor),
    approverKind: row.approver_kind,
    managerLevel: row.manager_level,
    approverRole: row.approver_role,
    approverUserId: row.approver_user_id,
    requireReceiptViewAck: row.require_receipt_view_ack,
  };
}

/**
 * The ordered approval plan for a report total: every enabled rung whose
 * threshold the total reaches, in `sequence` order. Falls back to the implicit
 * direct-manager rung when the tenant has configured none.
 *
 * Disabled rungs are skipped entirely rather than shifting the steps below them,
 * because switching a rung off is how an admin temporarily removes an approval
 * level and they expect the rest of the ladder to stay put.
 */
export function planApproval(
  rungs: ApprovalPolicyRow[],
  totalMinor: MinorAmount,
): RungPlan[] {
  const total = toBigInt(totalMinor);
  const applicable = rungs
    .filter((r) => r.enabled && toBigInt(r.threshold_minor) <= total)
    .sort((a, b) => a.sequence - b.sequence);

  if (applicable.length === 0) return [{ ...IMPLICIT_RUNG, step: 1 }];

  if (applicable.length > MAX_APPROVAL_STEPS) {
    // Refused rather than truncated: silently dropping the top rungs would drop
    // the FINANCE sign-off on the largest reports, which is the one approval
    // nobody would choose to lose.
    throw new ApprovalConfigError(
      `this report matches ${applicable.length} approval rungs, more than the ${MAX_APPROVAL_STEPS} a single report may require — an admin needs to shorten the ladder`,
      'TOO_MANY_STEPS',
    );
  }

  return applicable.map((row, index) => toPlan(row, index + 1));
}

/** True when the plan came from the implicit rung rather than configured rows. */
export function isImplicitPlan(plan: RungPlan[]): boolean {
  return plan.length === 1 && plan[0].policyId === null;
}

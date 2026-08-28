/**
 * VX2-1 — the approval LADDER: types, the starter set, and step planning.
 *
 * This module is PURE. It takes an already-loaded ladder plus a report total and
 * returns the ordered plan of approval steps; it never touches the database.
 * Same split as lib/policy/rules.ts, and for the same reason — the part that
 * decides how many people have to sign off is the part that must be reviewable
 * and unit-testable, so it lives in version control while the per-tenant numbers
 * live in rows.
 *
 * THE MODEL, and where it comes from. The Differences Chart specifies "simple
 * tiered/threshold default for SMBs (cf. VeloLedger AP bill-approval tiers)", so
 * VeloLedger is the in-house reference. Reconciled against it:
 *
 *  - ADOPTED from VeloLedger 0066: a rung owns an ORDERED LIST of approvers, not
 *    one approver, and an approver may be an external email. VeloLedger shipped
 *    one-approver-per-rung in 0037 and replaced it in 0066; no reason to relearn.
 *  - NOT ADOPTED: mutually exclusive value RANGES. VeloLedger approves a bill,
 *    which has no manager chain; an expense ladder is inherently cumulative
 *    ("the manager always signs, and finance as well past $5k"), and ranges force
 *    the lower approvers to be repeated inside every higher band.
 *
 * So: a report collects EVERY enabled rung whose threshold it meets, in
 * `sequence` order, and each rung's approvers flatten in `position` order into
 * one sequence of numbered steps.
 *
 * ExpenseOS's versioned workflow graph (JSON matchCondition predicates, parallel
 * and quorum nodes) stays out of the default path — the Port & Build Plan's risk
 * register calls it SMB onboarding friction. lib/approvals/routing.ts carries the
 * one interface an advanced graph tier would implement.
 */
import { toBigInt, type MinorAmount } from '@/lib/money';
import type { EmployeeRole } from '@/lib/employees/service';

/** How many approval STEPS may apply to one report (approval_request CHECK). */
export const MAX_APPROVAL_STEPS = 5;
/** How many rungs a tenant may configure (approval_policy CHECK). */
export const MAX_CONFIGURED_RUNGS = 10;
/** How far up the chain a MANAGER approver may point (approval_policy_approver CHECK). */
export const MAX_MANAGER_LEVEL = 5;

export const APPROVER_KINDS = ['MANAGER', 'ROLE', 'USER', 'EMAIL'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

/**
 * The role vocabulary a ROLE approver may name.
 *
 * Deliberately a CODE registry rather than a CHECK constraint on
 * approval_policy_approver.approver_role. The Differences Chart requires
 * "per-tenant custom roles (builder already exists) with tenant-scoped
 * permissions", so this triple is going to stop being the whole vocabulary —
 * and a CHECK would mean a migration the day that lands. Exactly the reasoning
 * that keeps expense_policy.kind out of a CHECK (VX1-7).
 *
 * Declared here rather than imported from lib/employees/service so this module
 * stays free of anything that drags `pg` in (lib/receipts/constants.ts's lesson).
 * When roles become tenant data, this becomes a lookup and nothing else moves.
 */
/**
 * Which employee roles may be named as a ROLE approver.
 *
 * Written as a Record over `EmployeeRole` rather than a bare array, so it is
 * EXHAUSTIVE BY CONSTRUCTION: adding a member to `EmployeeRole` breaks the build
 * here until somebody decides whether it may approve. A bare array compiles
 * fine while silently omitting the new role, `isApproverRole` returns false for
 * it, and no test fails — every approvals test uses this copy.
 *
 * The duplication itself is deliberate and stays: importing the VALUE
 * `EMPLOYEE_ROLES` from lib/employees/service would drag `pg` into a module that
 * must stay pure, whereas `import type` is erased at build. ExpenseOS has the
 * same duplication in `engine.ts` (APPROVE_PERMISSION, copied out of their rbac
 * package) and pins it with a test asserting the literal strings still exist;
 * a mapped type is the same guard moved from CI to `tsc`. See GAP-AUDIT AP-19.
 */
const APPROVER_ROLE_SET: Record<EmployeeRole, true> = {
  EMPLOYEE: true,
  MANAGER: true,
  ADMIN: true,
};
export const APPROVER_ROLES = Object.keys(APPROVER_ROLE_SET) as readonly EmployeeRole[];

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
  'EMAIL',
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
export function isApproverRole(value: string): value is EmployeeRole {
  return (APPROVER_ROLES as readonly string[]).includes(value);
}

/* ── stored shapes ─────────────────────────────────────────────────────────── */

/** One approver of one rung, as stored. */
export interface ApprovalPolicyApproverRow {
  id: string;
  policy_id: string;
  position: number;
  approver_kind: ApproverKind;
  manager_level: number | null;
  approver_role: EmployeeRole | null;
  approver_user_id: string | null;
  external_email: string | null;
  display_name: string | null;
  /** Joined for display; not part of the row proper. */
  approver_user_email?: string | null;
  approver_user_name?: string | null;
}

/**
 * A rung as stored, with its approvers attached in position order.
 * `threshold_minor` is a bigint column, which node-postgres hands back as a
 * STRING — never widen it to `number`, that is how a cent goes missing
 * (lib/money.ts).
 */
export interface ApprovalPolicyRow {
  id: string;
  name: string;
  sequence: number;
  threshold_minor: string;
  require_receipt_view_ack: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  approvers: ApprovalPolicyApproverRow[];
}

/* ── write shapes ──────────────────────────────────────────────────────────── */

export interface NewApprover {
  position: number;
  approverKind: ApproverKind;
  managerLevel?: number | null;
  approverRole?: EmployeeRole | null;
  approverUserId?: string | null;
  externalEmail?: string | null;
  displayName?: string | null;
}

export interface NewApprovalPolicy {
  name: string;
  sequence: number;
  thresholdMinor?: MinorAmount;
  requireReceiptViewAck?: boolean;
  enabled?: boolean;
  /** At least one. A rung nobody signs is unresolvable. */
  approvers: NewApprover[];
}

export type ApprovalPolicyPatch = Partial<NewApprovalPolicy>;

/* ── the plan ──────────────────────────────────────────────────────────────── */

/**
 * One step of a planned approval, and one element of
 * `approval_request.policy_snapshot`. Deliberately a flat, self-contained record
 * rather than a pair of ids: the snapshot has to stay meaningful after the rung
 * it came from is retuned or deleted.
 */
export interface StepPlan {
  /** 1-based position across THIS report's whole ladder. */
  step: number;
  /** null for the implicit rung — there is no row behind it. */
  policyId: string | null;
  policyName: string;
  /** The rung's ladder position; several steps can share it. */
  sequence: number;
  thresholdMinor: string;
  /** The approver's position WITHIN its rung. */
  position: number;
  approverKind: ApproverKind;
  managerLevel: number | null;
  approverRole: EmployeeRole | null;
  approverUserId: string | null;
  externalEmail: string | null;
  displayName: string | null;
  /** Inherited from the rung, so a step carries everything a decision needs. */
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
  | 'INVALID_POSITION'
  | 'INVALID_EMAIL'
  | 'NO_APPROVERS'
  | 'RUNG_WITHOUT_APPROVER'
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
 * The step used when a tenant has configured NO ladder: one approval from the
 * submitter's direct manager, receipts acknowledged.
 *
 * This is the one place approvals deliberately departs from the policy engine's
 * precedent. A fresh tenant has no policy RULES until an admin restores the
 * starter set, and the consequence is benign — nothing flags. A fresh tenant with
 * no approval rungs is not benign in either direction: with no fallback, either
 * every submitted report auto-approves (fails OPEN, which the ticket forbids) or
 * nothing can be submitted until an admin has configured a ladder (exactly the
 * onboarding friction the Port & Build Plan's risk register warns about). An
 * implicit direct-manager step still puts a human in the path, so it fails closed
 * while working out of the box.
 *
 * If the submitter has no manager, this step does NOT fail the routing. That was
 * the plan when VX2-1 shipped; reading ExpenseOS source changed it. On their dev
 * data 11% of active users had no manager at all, and refusing the submit would
 * strand a ninth of a tenant. VX2-2 resolves it to a tenant ADMIN instead
 * (resolved_via = 'ADMIN_FALLBACK'). See GAP-AUDIT AP-5 and AP-18.
 */
export const IMPLICIT_STEP: Omit<StepPlan, 'step'> = {
  policyId: null,
  policyName: 'Direct manager (default)',
  sequence: 1,
  thresholdMinor: '0',
  position: 1,
  approverKind: 'MANAGER',
  managerLevel: 1,
  approverRole: null,
  approverUserId: null,
  externalEmail: null,
  displayName: null,
  requireReceiptViewAck: true,
};

/**
 * The starter ladder, applied by "Restore starter ladder" — the same shape as
 * DEFAULT_POLICIES in lib/policy/rules.ts, and for the same reason: ONE copy, in
 * code, so no seed script holds a second version to drift from.
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
    requireReceiptViewAck: true,
    approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 1 }],
  },
  {
    name: 'Second-level manager',
    sequence: 2,
    thresholdMinor: '100000', // 1,000.00
    requireReceiptViewAck: true,
    approvers: [{ position: 1, approverKind: 'MANAGER', managerLevel: 2 }],
  },
  {
    name: 'Finance sign-off',
    sequence: 3,
    thresholdMinor: '500000', // 5,000.00
    requireReceiptViewAck: true,
    approvers: [{ position: 1, approverKind: 'ROLE', approverRole: 'ADMIN' }],
  },
];

/* ── validation ────────────────────────────────────────────────────────────── */

/**
 * Mirrors the CHECK constraints on approval_policy_approver so a bad write comes
 * back as a sentence rather than a Postgres 23514. The constraints stay in the
 * schema regardless — this is the message, not the guarantee. The ROLE value is
 * the exception: there is no CHECK for it (see APPROVER_ROLES), so this IS the
 * only validation, which is why it rejects rather than warns.
 */
export function assertApproverInput(input: NewApprover): void {
  if (!Number.isInteger(input.position) || input.position < 1) {
    throw new ApprovalConfigError(
      'an approver needs a whole position of 1 or more',
      'INVALID_POSITION',
    );
  }
  if (!isApproverKind(input.approverKind)) {
    throw new ApprovalConfigError(`unknown approver kind: ${input.approverKind}`, 'INVALID_KIND');
  }

  const hasLevel = input.managerLevel != null;
  const hasRole = input.approverRole != null;
  const hasUser = input.approverUserId != null;
  const hasEmail = input.externalEmail != null && input.externalEmail !== '';

  const only = (label: string, ...others: boolean[]) => {
    if (others.some(Boolean)) {
      throw new ApprovalConfigError(
        `a ${label} approver cannot also name anything else`,
        'INVALID_APPROVER',
      );
    }
  };

  switch (input.approverKind) {
    case 'MANAGER':
      if (!hasLevel) {
        throw new ApprovalConfigError(
          'a manager approver needs a level (1 = the direct manager)',
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
      only('manager', hasRole, hasUser, hasEmail);
      break;
    case 'ROLE':
      if (!hasRole) throw new ApprovalConfigError('a role approver needs a role', 'INVALID_ROLE');
      if (!isApproverRole(input.approverRole as string)) {
        throw new ApprovalConfigError(`unknown role: ${input.approverRole}`, 'INVALID_ROLE');
      }
      only('role', hasLevel, hasUser, hasEmail);
      break;
    case 'USER':
      if (!hasUser) {
        throw new ApprovalConfigError('a user approver needs a person', 'INVALID_APPROVER');
      }
      only('user', hasLevel, hasRole, hasEmail);
      break;
    case 'EMAIL':
      if (!hasEmail) {
        throw new ApprovalConfigError(
          'an external approver needs an email address',
          'INVALID_EMAIL',
        );
      }
      // Cheap and deliberately loose: a full address grammar rejects valid
      // addresses, and the real gate is that an EMAIL approver cannot act at all
      // until VX2-8 ships the approve-link token.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.externalEmail!.trim())) {
        throw new ApprovalConfigError(
          `"${input.externalEmail}" does not look like an email address`,
          'INVALID_EMAIL',
        );
      }
      only('external', hasLevel, hasRole, hasUser);
      break;
  }
}

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
  if (!input.approvers || input.approvers.length === 0) {
    // A rung nobody signs is not "no approval needed", it is a rung that can
    // never complete. Refused at write time rather than discovered by an
    // employee whose report never moves.
    throw new ApprovalConfigError('a rung needs at least one approver', 'NO_APPROVERS');
  }
  const positions = new Set<number>();
  for (const approver of input.approvers) {
    assertApproverInput(approver);
    if (positions.has(approver.position)) {
      throw new ApprovalConfigError(
        `two approvers share position ${approver.position}`,
        'INVALID_POSITION',
      );
    }
    positions.add(approver.position);
  }
}

/* ── planning ──────────────────────────────────────────────────────────────── */

function toStep(rung: ApprovalPolicyRow, approver: ApprovalPolicyApproverRow, step: number): StepPlan {
  return {
    step,
    policyId: rung.id,
    policyName: rung.name,
    sequence: rung.sequence,
    thresholdMinor: String(rung.threshold_minor),
    position: approver.position,
    approverKind: approver.approver_kind,
    managerLevel: approver.manager_level,
    approverRole: approver.approver_role,
    approverUserId: approver.approver_user_id,
    externalEmail: approver.external_email,
    displayName: approver.display_name,
    requireReceiptViewAck: rung.require_receipt_view_ack,
  };
}

/**
 * The ordered approval plan for a report total: every enabled rung whose
 * threshold the total reaches, in `sequence` order, with each rung's approvers
 * flattened in `position` order. Falls back to the implicit direct-manager step
 * when the tenant has configured no ladder.
 *
 * Disabled rungs are skipped entirely rather than shifting the steps below them,
 * because switching a rung off is how an admin temporarily removes an approval
 * level and they expect the rest of the ladder to stay put.
 */
export function planApproval(rungs: ApprovalPolicyRow[], totalMinor: MinorAmount): StepPlan[] {
  const total = toBigInt(totalMinor);
  const applicable = rungs
    .filter((r) => r.enabled && toBigInt(r.threshold_minor) <= total)
    .sort((a, b) => a.sequence - b.sequence);

  if (applicable.length === 0) return [{ ...IMPLICIT_STEP, step: 1 }];

  const steps: StepPlan[] = [];
  for (const rung of applicable) {
    const approvers = [...(rung.approvers ?? [])].sort((a, b) => a.position - b.position);
    if (approvers.length === 0) {
      // Only reachable if a rung lost its approvers outside the service (a
      // hand-run DELETE). Refusing beats planning a step nobody can decide.
      throw new ApprovalConfigError(
        `approval rung "${rung.name}" has no approver, so it can never be completed — an admin needs to fix the ladder`,
        'RUNG_WITHOUT_APPROVER',
      );
    }
    for (const approver of approvers) {
      steps.push(toStep(rung, approver, steps.length + 1));
    }
  }

  if (steps.length > MAX_APPROVAL_STEPS) {
    // Refused rather than truncated: silently dropping the tail drops the
    // FINANCE sign-off on the largest reports, the one approval nobody would
    // choose to lose.
    throw new ApprovalConfigError(
      `this report would need ${steps.length} approvals, more than the ${MAX_APPROVAL_STEPS} a single report may require — an admin needs to shorten the ladder`,
      'TOO_MANY_STEPS',
    );
  }

  return steps;
}

/** True when the plan came from the implicit step rather than configured rows. */
export function isImplicitPlan(plan: StepPlan[]): boolean {
  return plan.length === 1 && plan[0].policyId === null;
}

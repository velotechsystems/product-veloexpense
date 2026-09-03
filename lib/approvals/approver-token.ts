/**
 * VX2-4a — the approver token: how one `<select>` names an approver.
 *
 * PURE. No pg, no React, no server directive — so it is unit-testable and so the
 * admin page and its actions cannot drift on the encoding.
 *
 * ── Why a single token rather than a kind plus four fields ───────────────────
 *
 * An approver is a kind AND its companion: MANAGER needs a level, ROLE needs a
 * role, USER needs a person. `approval_policy_approver_complete` enforces
 * "exactly the companion the kind needs, and no other", and ExpenseOS needed a
 * zod schema to police the same thing because their editor could write
 * `{ kind: 'user', userId: '' }` the moment somebody chose "a specific person"
 * and before they said who (GAP-AUDIT AP-11).
 *
 * Encoding the pair in one option value — `MANAGER:2`, `ROLE:ADMIN`,
 * `USER:<uuid>` — makes that half-configured state unrepresentable in the form
 * rather than merely rejected by it. It also means no client JS: the alternative
 * needs script to hide the three irrelevant fields.
 *
 * EMAIL is deliberately not in the vocabulary. The schema stores external
 * approvers, but the resolver refuses to route onto one until VX2-8 ships the
 * approve-link token — so offering it would let an admin save a ladder that
 * breaks every submit in the tenant. `encodeApprover` returns '' for one, which
 * the page renders read-only.
 */
import { DomainError } from '@/lib/errors/domain';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import {
  APPROVER_ROLES,
  MAX_MANAGER_LEVEL,
  type ApprovalPolicyApproverRow,
  type NewApprover,
} from '@/lib/approvals/tiers';
// Type-only, so it is erased at build and drags no `pg` into this pure module —
// the same trick tiers.ts uses (GAP-AUDIT AP-19).
import type { EmployeeRole } from '@/lib/employees/service';

export type ApproverGroup = 'Reporting line' | 'By role' | 'A specific person';

export interface ApproverChoice {
  /** `MANAGER:2` · `ROLE:ADMIN` · `USER:<uuid>` */
  value: string;
  label: string;
  group: ApproverGroup;
}

export interface ApproverPerson {
  id: string;
  email: string;
  display_name: string | null;
}

function levelLabel(level: number): string {
  if (level === 1) return "The submitter's manager";
  if (level === 2) return "Their manager's manager";
  return `${level} levels up the reporting line`;
}

/** Every approver an admin may pick, as flat grouped options. */
export function approverChoices(people: ApproverPerson[]): ApproverChoice[] {
  const out: ApproverChoice[] = [];
  for (let level = 1; level <= MAX_MANAGER_LEVEL; level += 1) {
    out.push({ value: `MANAGER:${level}`, label: levelLabel(level), group: 'Reporting line' });
  }
  for (const role of APPROVER_ROLES) {
    // A role is a POOL: whoever holds it at decision time may act, and the task
    // is deliberately assigned to nobody (GAP-AUDIT AP-7).
    out.push({ value: `ROLE:${role}`, label: `Anyone with the ${role} role`, group: 'By role' });
  }
  for (const p of people) {
    out.push({
      value: `USER:${p.id}`,
      label: p.display_name ?? p.email,
      group: 'A specific person',
    });
  }
  return out;
}

export class ApproverTokenError extends DomainError {
  constructor(message: string,
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
    this.name = 'ApproverTokenError';
  }
}

/**
 * Decode one select value into an approver. `position` is assigned by the order
 * the selects appear in, which is the order shown on the page.
 */
export function decodeApproverToken(token: string, position: number): NewApprover {
  const split = token.indexOf(':');
  if (split < 1) throw new ApproverTokenError(`unrecognised approver: ${token}`,
      'APPROVER_SELECTION_STALE',
    );
  const kind = token.slice(0, split);
  const rest = token.slice(split + 1);

  if (kind === 'MANAGER') {
    const level = Number(rest);
    if (!Number.isInteger(level) || level < 1 || level > MAX_MANAGER_LEVEL) {
      throw new ApproverTokenError(`unrecognised reporting-line level: ${rest}`,
      'APPROVER_SELECTION_STALE',
    );
    }
    return { position, approverKind: 'MANAGER', managerLevel: level };
  }
  if (kind === 'ROLE') {
    if (!(APPROVER_ROLES as readonly string[]).includes(rest)) {
      throw new ApproverTokenError(`unrecognised role: ${rest}`,
      'APPROVER_SELECTION_STALE',
    );
    }
    return { position, approverKind: 'ROLE', approverRole: rest as EmployeeRole };
  }
  if (kind === 'USER') {
    if (rest === '') throw new ApproverTokenError('pick a person',
      'APPROVER_NEEDS_PERSON',
    );
    return { position, approverKind: 'USER', approverUserId: rest };
  }
  throw new ApproverTokenError(`unrecognised approver: ${token}`,
      'APPROVER_SELECTION_STALE',
    );
}

/** The stored row as the token the select understands, so an existing rung's
 *  approvers come back pre-selected rather than blank. '' for EMAIL. */
export function encodeApproverToken(row: ApprovalPolicyApproverRow): string {
  if (row.approver_kind === 'MANAGER') return `MANAGER:${row.manager_level ?? 1}`;
  if (row.approver_kind === 'ROLE') return row.approver_role ? `ROLE:${row.approver_role}` : '';
  if (row.approver_kind === 'USER') return row.approver_user_id ? `USER:${row.approver_user_id}` : '';
  return '';
}

/**
 * The chosen tokens of one rung, in order, as approvers.
 *
 * Blank selects are dropped — which is what makes "one empty select at the end"
 * work as an add-another affordance with no client JS, and what makes removing an
 * approver "set it to none and save".
 */
export function decodeApproverList(tokens: readonly string[]): NewApprover[] {
  const chosen = tokens.map((t) => t.trim()).filter((t) => t !== '');
  if (chosen.length === 0) {
    // The service refuses this too (RUNG_WITHOUT_APPROVER); saying it here means
    // the admin gets a sentence rather than an error code.
    throw new ApproverTokenError(
      'a rung needs at least one approver — a rung nobody signs can never complete',
      'RUNG_NEEDS_APPROVER',
    );
  }
  return chosen.map((token, i) => decodeApproverToken(token, i + 1));
}

/**
 * VX2-5 — delegations: handing your approvals to somebody while you are away.
 *
 * The machinery already existed before this ticket. Migration `0008` shipped the
 * table, VX2-2's resolver redirects a task to an active delegatee at routing
 * time, and VX2-4's `canDecide` lets a delegatee act on a task that was ALREADY
 * parked before the delegation existed. What was missing was a way to create one
 * without SQL. So this file is CRUD plus the rules that the resolver assumes.
 *
 * ── Four properties the rest of the system already depends on ───────────────
 *
 * 1. ONE HOP, NEVER A CHAIN. A delegates to B and B delegates to C: a task of
 *    A's goes to B, not C. Ported from ExpenseOS, whose comment is explicit
 *    ("no chains-of-delegations"). The recursive reading is the intuitive one
 *    and it is also an infinite loop waiting to happen (A→B, B→A). This file
 *    does not enforce the rule — the resolver does — but it WARNS, because an
 *    onward delegation is invisible from here and silently does nothing.
 * 2. OVERLAPS ARE ALLOWED and break by `created_at DESC`. The newest instruction
 *    is the one the delegator meant. So this refuses nothing on overlap; it
 *    would be refusing something the resolver already handles.
 * 3. A DELEGATION DOES NOT TAKE THE TASK AWAY from the delegator. They keep it
 *    in their own inbox — covering for somebody is not confiscating their queue,
 *    and a manager back early should still find their work.
 * 4. DATES, INCLUSIVE ON BOTH ENDS, in the tenant's working timezone. `0008`
 *    chose dates over timestamps deliberately: "I am away these days" is not an
 *    instant, and a half-open range invites an off-by-one at exactly the moment
 *    somebody is away and cannot fix it.
 */
import type { QueryRunner } from '@/lib/db/client';
import { DomainError } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { append as auditAppend } from '@/lib/audit/service';
import { holdsAdminPermission } from '@/lib/auth/actor';
import type { EmployeeRow } from '@/lib/employees/service';
import { ORG } from '@/lib/tenant/sql';

/** What a delegation covers. Moved here from the approval ladder's lib/approvals/tiers.ts
 *  when the ladder was retired (w4-00d, d61); delegations outlive it. */
export const DELEGATION_SCOPES = ['ALL', 'REPORTS'] as const;
export type DelegationScope = (typeof DELEGATION_SCOPES)[number];

export type DelegationErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SELF_DELEGATION'
  | 'INVALID_SCOPE'
  | 'INVALID_RANGE'
  | 'ALREADY_REVOKED'
  | 'DELEGATEE_UNAVAILABLE';

export class DelegationError extends DomainError {
  constructor(
    message: string,
    readonly code: DelegationErrorCode,
    userMessage: UserMessageCode | null = null,
  ) {
    super(message, userMessage);
    this.name = 'DelegationError';
  }
}

export interface DelegationRow {
  id: string;
  from_user_id: string;
  from_name: string;
  to_user_id: string;
  to_name: string;
  /** 'YYYY-MM-DD'. See SELECT_DELEGATION for why these are text. */
  starts_on: string;
  ends_on: string | null;
  scope: DelegationScope;
  created_by_id: string;
  created_by_name: string;
  revoked_at: Date | null;
  revoked_by_name: string | null;
  note: string | null;
  created_at: Date;
  /** In force on the date the query was asked about. */
  active: boolean;
}

/**
 * The tenant's calendar day that contains the instant `$n` (a timestamptz parameter), in the
 * organization's working timezone (`organization.default_timezone`, 0027) — rule 4 above.
 *
 * Not `$n::date`, which casts in the SESSION's zone: the database server's, whatever that
 * is (UTC on RDS, America/Toronto on a developer's machine), so a delegation ending today
 * stopped covering at 20:00 for a Toronto tenant on one and at midnight on the other. And
 * not `current_date`, for the same reason. Nothing here depends on the session's zone.
 */
const tenantDayOf = (param: string) =>
  `((${param}::timestamptz) AT TIME ZONE COALESCE(
      (SELECT o.default_timezone FROM organization o WHERE o.id = ${ORG}), 'UTC'))::date`;

/**
 * `starts_on::text`, deliberately.
 *
 * `node-postgres` maps a `date` column to a JS `Date` at local midnight, so a
 * delegation starting 2026-06-01 comes back as May 31st for anyone west of UTC
 * and the UI shows the wrong day. These are calendar dates, not instants —
 * exactly the reasoning `0008` gives for choosing `date` over `timestamptz` —
 * and text is the only representation that survives the round trip unchanged.
 */
const SELECT_DELEGATION = `
  SELECT d.id,
         d.from_user_id,
         COALESCE(f.display_name, f.email)  AS from_name,
         d.to_user_id,
         COALESCE(t.display_name, t.email)  AS to_name,
         d.starts_on::text                  AS starts_on,
         d.ends_on::text                    AS ends_on,
         d.scope,
         d.created_by_id,
         COALESCE(c.display_name, c.email)  AS created_by_name,
         d.revoked_at,
         COALESCE(r.display_name, r.email)  AS revoked_by_name,
         d.note,
         d.created_at,
         (d.revoked_at IS NULL
          AND d.starts_on <= ${tenantDayOf('$1')}
          AND (d.ends_on IS NULL OR d.ends_on >= ${tenantDayOf('$1')})) AS active
    FROM delegation d
    JOIN app_user f ON f.id = d.from_user_id
    JOIN app_user t ON t.id = d.to_user_id
    JOIN app_user c ON c.id = d.created_by_id
    LEFT JOIN app_user r ON r.id = d.revoked_by_id`;

export interface DelegationFilter {
  /** Delegations this person gave OR received. Omit for the whole tenant (admin
   *  screens only — RLS still scopes to the org). */
  forUserId?: string;
  includeRevoked?: boolean;
  /** An instant; a delegation is active on the tenant's calendar day containing it. */
  onDate?: Date;
}

export async function listDelegations(
  tx: QueryRunner,
  filter: DelegationFilter = {},
): Promise<DelegationRow[]> {
  const onDate = filter.onDate ?? new Date();
  const r = await tx.query(
    `${SELECT_DELEGATION}
      WHERE ($2::uuid IS NULL OR d.from_user_id = $2::uuid OR d.to_user_id = $2::uuid)
        AND ($3::boolean OR d.revoked_at IS NULL)
      ORDER BY d.revoked_at IS NOT NULL, d.starts_on DESC, d.created_at DESC`,
    [onDate, filter.forUserId ?? null, filter.includeRevoked ?? false],
  );
  return r.rows as DelegationRow[];
}

export interface NewDelegation {
  /** Defaults to the actor. Naming somebody else requires ADMIN. */
  fromUserId?: string;
  toUserId: string;
  /** 'YYYY-MM-DD'. */
  startsOn: string;
  endsOn?: string | null;
  scope?: DelegationScope;
  note?: string | null;
}

/**
 * The delegatee's OWN active delegation, if they have one.
 *
 * Not a validation — an onward delegation is perfectly legal — but the caller
 * should say so, because it silently does nothing: a task of yours goes to them,
 * and stops there. Without the warning the delegator believes they have arranged
 * cover two people deep.
 */
export async function onwardDelegation(
  tx: QueryRunner,
  toUserId: string,
  onDate: Date = new Date(),
): Promise<{ toName: string } | null> {
  const r = await tx.query(
    `SELECT COALESCE(t.display_name, t.email) AS to_name
       FROM delegation d
       JOIN app_user t ON t.id = d.to_user_id
      WHERE d.from_user_id = $1
        AND d.revoked_at IS NULL
        AND d.starts_on <= ${tenantDayOf('$2')}
        AND (d.ends_on IS NULL OR d.ends_on >= ${tenantDayOf('$2')})
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [toUserId, onDate],
  );
  return r.rows[0] ? { toName: r.rows[0].to_name as string } : null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export async function createDelegation(
  tx: QueryRunner,
  actor: EmployeeRow,
  input: NewDelegation,
): Promise<DelegationRow> {
  const fromUserId = input.fromUserId ?? actor.id;
  // Delegating somebody ELSE's approvals is an admin act. `created_by_id` exists
  // so that difference is visible afterwards (0008), which only means anything
  // if the two can differ.
  if (fromUserId !== actor.id && !holdsAdminPermission(actor)) {
    throw new DelegationError(
      'only an administrator can delegate somebody else’s approvals',
      'FORBIDDEN',
      'DELEGATE_FOR_SOMEBODY_ELSE',
    );
  }
  if (fromUserId === input.toUserId) {
    throw new DelegationError(
      'you cannot delegate your approvals to yourself',
      'SELF_DELEGATION',
      'DELEGATE_TO_SELF',
    );
  }
  const scope = input.scope ?? 'ALL';
  if (!(DELEGATION_SCOPES as readonly string[]).includes(scope)) {
    throw new DelegationError(
      `unknown delegation scope: ${scope}`,
      'INVALID_SCOPE',
      'DELEGATION_SCOPE_UNKNOWN',
    );
  }
  if (!DATE_ONLY.test(input.startsOn)) {
    throw new DelegationError('give a start date', 'INVALID_RANGE', 'DELEGATION_START_REQUIRED');
  }
  const endsOn = input.endsOn ?? null;
  if (endsOn !== null && !DATE_ONLY.test(endsOn)) {
    throw new DelegationError(
      'give an end date, or leave it open-ended',
      'INVALID_RANGE',
      'DELEGATION_END_INVALID',
    );
  }
  if (endsOn !== null && endsOn < input.startsOn) {
    throw new DelegationError(
      'the end date is before the start date',
      'INVALID_RANGE',
      'DELEGATION_END_BEFORE_START',
    );
  }

  // Handing your approvals to somebody who has left, or who is themselves away,
  // is a queue that goes nowhere. The resolver would skip up THEIR manager
  // chain, which is not what anybody meant by "cover for me".
  const to = await tx.query(
    `SELECT COALESCE(display_name, email) AS name, employee_status, deleted_at
       FROM app_user WHERE id = $1`,
    [input.toUserId],
  );
  if (to.rows.length === 0) {
    throw new DelegationError(
      'that person is not in this organization',
      'NOT_FOUND',
      'DELEGATEE_NOT_IN_ORG',
    );
  }
  if (to.rows[0].deleted_at !== null || to.rows[0].employee_status !== 'ACTIVE') {
    throw new DelegationError(
      `${to.rows[0].name} is not active, so approvals sent to them would go nowhere`,
      'DELEGATEE_UNAVAILABLE',
      // The NAME stays in the log message and leaves the screen: the person
      // picked it from a select two seconds ago, so the copy loses nothing they
      // do not already have in front of them, and gains a code that travels.
      'DELEGATEE_INACTIVE',
    );
  }

  const ins = await tx.query(
    `INSERT INTO delegation
       (organization_id, from_user_id, to_user_id, starts_on, ends_on, scope, created_by_id, note)
     VALUES (${ORG}, $1, $2, $3::date, $4::date, $5, $6, $7)
     RETURNING id`,
    [fromUserId, input.toUserId, input.startsOn, endsOn, scope, actor.id, input.note ?? null],
  );
  const id = ins.rows[0].id as string;

  // A delegation moves who may approve money. That is a control change, so it
  // belongs in the hash-chained trail, not only in the row's own created_by.
  await auditAppend(
    tx,
    { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role_label },
    {
      action: 'DELEGATION_CREATED',
      entityType: 'delegation',
      entityId: id,
      details: {
        fromUserId,
        toUserId: input.toUserId,
        startsOn: input.startsOn,
        endsOn,
        scope,
        onBehalfOfSomeoneElse: fromUserId !== actor.id,
      },
    },
  );

  const row = await getDelegation(tx, id);
  if (!row) throw new DelegationError('delegation not found after insert', 'NOT_FOUND');
  return row;
}

export async function getDelegation(
  tx: QueryRunner,
  id: string,
  onDate: Date = new Date(),
): Promise<DelegationRow | null> {
  const r = await tx.query(`${SELECT_DELEGATION} WHERE d.id = $2`, [onDate, id]);
  return (r.rows[0] as DelegationRow) ?? null;
}

/**
 * Revoke a delegation. The delegator, whoever created it, or an admin.
 *
 * Revoked rather than deleted: `delegation_revocation_complete` requires both
 * `revoked_at` and `revoked_by_id`, so the row records who ended it. A deleted
 * row cannot answer "who took my cover away, and when".
 */
export async function revokeDelegation(
  tx: QueryRunner,
  actor: EmployeeRow,
  id: string,
): Promise<DelegationRow> {
  const current = await getDelegation(tx, id);
  if (!current) throw new DelegationError('delegation not found', 'NOT_FOUND');
  if (current.revoked_at !== null) {
    throw new DelegationError(
      'that delegation was already revoked',
      'ALREADY_REVOKED',
      'DELEGATION_ALREADY_REVOKED',
    );
  }
  const mine = current.from_user_id === actor.id || current.created_by_id === actor.id;
  if (!mine && !holdsAdminPermission(actor)) {
    throw new DelegationError(
      'that delegation is not yours to revoke',
      'FORBIDDEN',
      'DELEGATION_NOT_YOURS',
    );
  }

  await tx.query(
    `UPDATE delegation
        SET revoked_at = clock_timestamp(), revoked_by_id = $2, updated_at = now()
      WHERE id = $1`,
    [id, actor.id],
  );

  await auditAppend(
    tx,
    { id: actor.id, name: actor.display_name ?? actor.email, role: actor.role_label },
    {
      action: 'DELEGATION_REVOKED',
      entityType: 'delegation',
      entityId: id,
      details: {
        fromUserId: current.from_user_id,
        toUserId: current.to_user_id,
        revokedSomebodyElses: current.from_user_id !== actor.id,
      },
    },
  );

  const row = await getDelegation(tx, id);
  if (!row) throw new DelegationError('delegation not found after revoke', 'NOT_FOUND');
  return row;
}

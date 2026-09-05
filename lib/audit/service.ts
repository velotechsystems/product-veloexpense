/**
 * VX2-6 — the audit writer.
 *
 * ONE function, `append`, and every state change that matters goes through it.
 * It must be called inside `withOrg()` and inside the SAME transaction as the
 * change it records — that is the whole point: a state change that commits
 * without its audit row, or an audit row that commits without its state change,
 * is worse than no audit log, because it is a log that is trusted and wrong.
 *
 * COST, stated plainly: three round trips per entry — lock, head read, insert.
 * They cannot be collapsed. The hash is computed in JS from the head hash, so
 * the insert cannot precede the read; and the read cannot share a statement with
 * the lock, because Postgres does not guarantee that a function in the select
 * list is evaluated before a subquery's row lock is taken — which would reopen
 * exactly the genesis race the lock exists to close. ExpenseOS pays the same
 * three.
 */
import type { QueryRunner } from '@/lib/db/client';
import type { AuditAction } from '@/lib/audit/actions';
import { DomainError } from '@/lib/errors/domain';
import {
  acquireChainLock,
  computeEntryHash,
  currentOrganizationId,
  readHeadHashForUpdate,
  type HashPayload,
} from '@/lib/audit/chain';

/**
 * Who did it. Frozen into the row and into the hash, so a later rename or role
 * change cannot rewrite history.
 *
 * Exactly one of `id` / `email` — an internal user, or an external approver with
 * no `app_user` row (VX2-8's approve-link). `audit_entry_actor_exclusive`
 * enforces it in the database; this throws first so the caller gets a sentence.
 */
export interface AuditActor {
  id: string | null;
  email?: string | null;
  /** Display name at the time. For a system actor, name it — 'system' reads
   *  badly in an auditor's export; say which system. */
  name: string;
  /** Role at the time, or 'SYSTEM'. In the hash — see chain.ts. */
  role: string;
}

/**
 * An `app_user` row as the actor that wrote something (UD-11).
 *
 * There were three byte-identical copies of this — `app/admin/branding`,
 * `app/admin/locale`, `app/admin/ledger-queue` — and this ticket needed a fourth.
 * Three copies of a four-line helper is not the sin fifteen copies of an
 * authorization gate was, but the fix is one line and the alternative was to make
 * it four: `display_name ?? email` is a POLICY (what an auditor's export calls a
 * person who never set a display name) and it should have one answer.
 */
export function auditActorOf(row: {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}): AuditActor {
  return { id: row.id, name: row.display_name ?? row.email, role: row.role };
}

export interface AuditInput {
  /**
   * TYPED, not `string`, and that is the whole point of `lib/audit/actions.ts`.
   * A registry the compiler does not consult is decoration: it would still accept
   * `action: 'REPROT_EDITED'`, which inserts happily into an append-only table and
   * is then wrong for good, because nobody's query finds it again to notice.
   */
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  /**
   * Free-form context. MINOR AMOUNTS AS STRINGS — `canonical()` throws on
   * BigInt, and it throws inside this transaction (GAP-AUDIT AU-5).
   */
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
  /** Operational, and deliberately OUTSIDE the hash. */
  requestId?: string | null;
  userAgent?: string | null;
}

export interface AuditEntryRef {
  id: string;
  sequence: string;
  entryHash: string;
  prevHash: string | null;
}

export class AuditError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

export async function append(
  tx: QueryRunner,
  actor: AuditActor,
  input: AuditInput,
): Promise<AuditEntryRef> {
  const actorEmail = actor.email ?? null;
  if ((actor.id === null) === (actorEmail === null)) {
    throw new AuditError(
      'audit: exactly one of actor.id / actor.email is required (internal user or external approver)',
    );
  }
  if (actor.name.trim() === '') throw new AuditError('audit: actor.name is required');
  if (input.action.trim() === '') throw new AuditError('audit: action is required');
  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new AuditError('audit: entityType and entityId are both required, or neither');
  }

  const organizationId = await currentOrganizationId(tx);

  // 1. Serialize this tenant's appenders. Before the head read, always.
  await acquireChainLock(tx);

  // 2. The head, under the lock.
  const prevHash = await readHeadHashForUpdate(tx, organizationId);

  // 3. The timestamp is read from the database and then inserted EXPLICITLY,
  //    rather than left to the column default. The hash covers occurredAt, so
  //    the value hashed and the value stored have to be the same one — a
  //    DEFAULT clock_timestamp() would produce a second, later instant and every
  //    row would fail verification immediately. The column default remains for
  //    rows written by hand or by a future path that forgets.
  const clock = await tx.query('SELECT clock_timestamp() AS t');
  const occurredAt = clock.rows[0].t as Date;

  const payload: HashPayload = {
    organizationId,
    occurredAt,
    actorId: actor.id,
    actorEmail,
    actorName: actor.name,
    actorRole: actor.role,
    action: input.action,
    entityType,
    entityId,
    details: input.details ?? null,
    ipAddress: input.ipAddress ?? null,
    prevHash,
  };
  const entryHash = computeEntryHash(payload);

  const r = await tx.query(
    `INSERT INTO audit_entry
       (organization_id, occurred_at, actor_id, actor_email, actor_name, actor_role,
        action, entity_type, entity_id, details, ip_address, request_id, user_agent,
        prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
     RETURNING id, sequence`,
    [
      organizationId,
      occurredAt,
      actor.id,
      actorEmail,
      actor.name,
      actor.role,
      input.action,
      entityType,
      entityId,
      payload.details === null ? null : JSON.stringify(payload.details),
      input.ipAddress ?? null,
      input.requestId ?? null,
      input.userAgent ?? null,
      prevHash,
      entryHash,
    ],
  );

  return {
    id: r.rows[0].id as string,
    sequence: String(r.rows[0].sequence),
    entryHash,
    prevHash,
  };
}

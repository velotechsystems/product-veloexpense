/**
 * Ported from ExpenseOS `packages/audit/src/writer.ts` (550b2945): `writeAudit` and
 * `withAudit`, with ExpenseOS's signatures, so ported routers call them unchanged.
 *
 * VeloExpense: the ROW they write is VeloExpense's, not ExpenseOS's. There is one audit
 * chain per tenant (`audit_entry`, lib/audit/chain.ts), and `lib/audit/verify.ts` must be
 * able to verify what this writes. So everything that decides the hash follows
 * `lib/audit/service.ts` `append` exactly:
 *
 *   · the lock is the per-tenant advisory lock, not ExpenseOS's one global key;
 *   · the head is this tenant's latest row, by `sequence`;
 *   · the hash payload is VeloExpense's (`organizationId`, `actorEmail`, `actorRole`
 *     included), hashed by the same `computeEntryHash`;
 *   · `occurredAt` is read from the database clock and stored explicitly.
 *
 * It runs on the Prisma transaction ported code holds (`ctx.db`, scoped by
 * `withTenantDb`), with tagged `$queryRaw` only, so the row commits or rolls back with
 * the change it records. Not ported: ExpenseOS's API-key delegation marker (VeloExpense
 * has no API keys yet) and the 7-year `expiresAt` (VeloExpense's retention is the purge
 * watermark in lib/audit/verify.ts).
 */
import { isAuditAction } from '@/lib/audit/actions';
import { computeEntryHash, type HashPayload } from '@/lib/audit/chain';
import type { TenantDb } from '@/lib/db/prisma';
import { type AuditInput, resolveActor } from './types';

/** lib/audit/chain.ts's lock class ('AUDT'); the second key is the tenant. */
const AUDIT_CHAIN_LOCK_CLASS = 0x41554454;

/** ExpenseOS takes `PrismaClient`; here it is the tenant-scoped `db` (lib/db/prisma.ts). */
type AuditDb = { $transaction<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> };

/**
 * Append one audit row inside the caller's transaction. Must run inside the tenant
 * scope: the chain is the scope's tenant's.
 */
export async function writeAudit(tx: TenantDb, input: AuditInput): Promise<void> {
  if (!isAuditAction(input.action)) {
    // VeloExpense: an action outside the registry would be a row nobody's query finds
    // again, in an append-only table (lib/audit/actions.ts). Refused, so it rolls back.
    throw new Error(`audit: "${input.action}" is not in lib/audit/actions.ts`);
  }
  if (input.actor.kind !== 'user') {
    // VeloExpense: a row names exactly one of a user or an external email. A job actor
    // arrives with the worker port (Wave 3), and is refused until then.
    throw new Error('audit: system actors are not supported yet (worker port, Wave 3)');
  }
  const { actorId, actorName } = resolveActor(input.actor);

  const [scope] = await tx.$queryRaw<{ org: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_org', true), '')::uuid::text AS org`;
  const organizationId = scope?.org ?? null;
  if (!organizationId) {
    throw new Error('audit: no tenant context — write inside withTenantDb()');
  }

  // VeloExpense's actor_role is the member's VeloExpense role, read from the row rather
  // than trusted from the session (ExpenseOS's roleLabel is a display string).
  const [member] = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM app_user WHERE id = ${actorId}::uuid`;
  if (!member) throw new Error('audit: the actor is not a member of this organization');

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_CLASS}::int,
                                 hashtext(current_setting('app.current_org', true)))`;
  const [head] = await tx.$queryRaw<{ entry_hash: string }[]>`
    SELECT entry_hash FROM audit_entry
     WHERE organization_id = ${organizationId}::uuid
     ORDER BY sequence DESC
     LIMIT 1
     FOR UPDATE`;
  const prevHash = head?.entry_hash ?? null;
  // The database clock, as `append` reads it — but carried as TEXT, both ways. A raw
  // query hands a timestamptz back at microsecond precision, which a `Date` cannot hold,
  // and the driver adapter's reading of it depends on the session's time zone
  // (lib/db/prisma.ts sets UTC for that reason). Hashing one instant and storing another
  // would make every row fail verification, so the instant is fixed once, as a UTC ISO
  // string at millisecond precision, and that one string is both hashed and stored.
  const [clock] = await tx.$queryRaw<{ t: string }[]>`
    SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`;
  const occurredAt = new Date(clock.t);

  // VeloExpense: a row names an entity completely or not at all
  // (`audit_entry_entity_complete`). ExpenseOS also writes a TYPE with no id — a reorder
  // of many categories, say — so that type is kept in `details` rather than dropped.
  const entityId = input.entityId ?? null;
  const entityType = entityId === null ? null : (input.entityType ?? null);
  const details =
    entityId === null && input.entityType
      ? { ...(input.details ?? {}), entityType: input.entityType }
      : (input.details ?? null);
  const ipAddress = input.ip ?? null;

  const payload: HashPayload = {
    organizationId,
    occurredAt,
    actorId,
    actorEmail: null,
    actorName,
    actorRole: member.role,
    action: input.action,
    entityType,
    entityId,
    details,
    ipAddress,
    prevHash,
  };
  const entryHash = computeEntryHash(payload);

  await tx.$executeRaw`
    INSERT INTO audit_entry
      (organization_id, occurred_at, actor_id, actor_email, actor_name, actor_role,
       action, entity_type, entity_id, details, ip_address, request_id, user_agent,
       prev_hash, entry_hash)
    VALUES (${organizationId}::uuid, ${clock.t}::timestamptz, ${actorId}::uuid, NULL, ${actorName},
            ${member.role}, ${input.action}, ${entityType}, ${entityId}::uuid,
            ${details === null ? null : JSON.stringify(details)}::jsonb, ${ipAddress},
            ${input.requestId ?? null}, ${input.userAgent ?? null}, ${prevHash}, ${entryHash})`;
}

/**
 * Open a transaction, run `fn`, and append the audit row IFF `fn` succeeds. If `fn`
 * throws, the transaction is rolled back and no audit row is written.
 *
 * For creates the entity id isn't known until `fn` has inserted the row. Pass
 * `resolveEntityId` to derive `entityId` from `fn`'s result — it overrides
 * `input.entityId` before the audit row (and its hash) is computed.
 *
 * VeloExpense: `prisma.$transaction(fn)` on the tenant-scoped `db` runs `fn` on the
 * request's existing tenant transaction (lib/db/prisma.ts), so "the transaction" is the
 * whole procedure's, as the tRPC `tenant` middleware opens it.
 */
export async function withAudit<T>(
  prisma: AuditDb,
  input: AuditInput,
  fn: (tx: TenantDb) => Promise<T>,
  resolveEntityId?: (result: T) => string | null | undefined,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await fn(tx);
    const entityId = resolveEntityId ? (resolveEntityId(result) ?? undefined) : input.entityId;
    await writeAudit(tx, { ...input, entityId });
    return result;
  });
}

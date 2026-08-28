/**
 * VX2-6 — the hash chain itself: the frozen payload, the per-tenant lock, and
 * the per-tenant head read.
 *
 * Ported from ExpenseOS `packages/audit/src/chain.ts` with the three
 * multi-tenancy corrections GAP-AUDIT AU-1 sets out. Their version is correct
 * for one enterprise on one database and wrong for a pooled one in three places:
 * a single global advisory lock, a head read with no tenant predicate, and no
 * tenant in the hash payload. All three are fixed here and in `0010`.
 */
import { createHash } from 'node:crypto';
import type { QueryRunner } from '@/lib/db/client';
import { canonical } from '@/lib/audit/canonical';

/**
 * THE FROZEN PAYLOAD. Changing this invalidates every hash ever written, so it
 * does not change — see `0010`'s header for the full in/out table and the
 * reasoning for each exclusion.
 *
 * Two fields are additions to ExpenseOS's nine:
 *  - `organizationId`, without which a row's tenant attribution sits outside the
 *    integrity guarantee and `UPDATE … SET organization_id = <other tenant>`
 *    breaks no hash;
 *  - `actorRole`, which theirs excludes with a comment inviting exactly this
 *    change. After GAP-AUDIT AP-13 — a privileged user approving their own
 *    report, which shipped in ExpenseOS — "under what authority" is the first
 *    question an auditor asks.
 */
export interface HashPayload {
  organizationId: string;
  occurredAt: Date;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  prevHash: string | null;
}

export function computeEntryHash(payload: HashPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/**
 * Advisory-lock CLASS id. ExpenseOS uses this constant as its whole key;
 * `0x41554454` is 'AUDT' in ASCII, which keeps it greppable in `pg_locks`.
 *
 * Here it is only the first of two keys — the second is the tenant — so that
 * appends serialize WITHIN a tenant and not across the estate. Ported as one
 * global key, tenant A's audit throughput would be coupled to every other
 * tenant's on the hot path of every state change.
 *
 * 0x41554454 = 1096041044, comfortably inside int4.
 */
const AUDIT_CHAIN_LOCK_CLASS = 0x41554454;

/**
 * Serialize this tenant's audit appends with a transaction-scoped advisory lock.
 * Must be called inside a transaction, before `readHeadHashForUpdate`.
 *
 * Keep ExpenseOS's explanation of why the lock rather than the row lock is what
 * does the work, because it is the least obvious thing in this file:
 *
 *   "SELECT ... FOR UPDATE alone cannot do this: on an empty table it locks zero
 *    rows, so concurrent first appenders both read prevHash = null and fork the
 *    genesis."
 *
 * Per-tenant, "an empty table" means "this tenant's first ever audit row" — a
 * state every customer passes through on its first day. The genesis race is
 * therefore reachable during onboarding, for every tenant, not a theoretical
 * edge.
 *
 * The tenant comes from `app.current_org` rather than an argument so that the
 * lock cannot disagree with the rows RLS will let us see.
 *
 * Two tenants whose ids collide in `hashtext` serialize together. That costs a
 * little contention and breaks nothing.
 */
export async function acquireChainLock(tx: QueryRunner): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock($1, hashtext(current_setting('app.current_org', true)))`,
    [AUDIT_CHAIN_LOCK_CLASS],
  );
}

/**
 * This TENANT's chain head, or null for its genesis row. Call inside a
 * transaction, after `acquireChainLock`.
 *
 * `FOR UPDATE` is kept alongside the advisory lock as defence in depth, exactly
 * as ExpenseOS has it. RLS supplies the tenant predicate, and the explicit
 * `organization_id = …` is here so the query is correct when read on its own
 * rather than only in the presence of a policy.
 */
export async function readHeadHashForUpdate(
  tx: QueryRunner,
  organizationId: string,
): Promise<string | null> {
  const r = await tx.query(
    `SELECT entry_hash
       FROM audit_entry
      WHERE organization_id = $1
      ORDER BY sequence DESC
      LIMIT 1
      FOR UPDATE`,
    [organizationId],
  );
  return (r.rows[0]?.entry_hash as string | undefined) ?? null;
}

/** The tenant this transaction is scoped to. Throws rather than returning null:
 *  an audit append outside a tenant context is a bug in the caller, and the
 *  alternative is a row that RLS's WITH CHECK would reject with a less useful
 *  message. */
export async function currentOrganizationId(tx: QueryRunner): Promise<string> {
  const r = await tx.query(
    `SELECT NULLIF(current_setting('app.current_org', true), '')::uuid AS org`,
  );
  const org = r.rows[0]?.org as string | null | undefined;
  if (!org) {
    throw new Error(
      'audit: no tenant context — an audit entry must be written inside withOrg()',
    );
  }
  return org;
}

/**
 * VX2-6 — chain verification, per tenant and windowed.
 *
 * Ported from ExpenseOS `packages/audit/src/verify.ts`. Two changes, both from
 * GAP-AUDIT AU-1 and AU-4:
 *
 *  - it walks ONE TENANT's chain, ordered by `sequence`. Theirs has no tenant
 *    predicate and orders by a UUIDv7 id. Under RLS a tenant-blind verifier
 *    cannot work at all: verifying tenant A would require reading tenant B's
 *    rows, which the policy forbids;
 *  - the purge watermark is STORED per tenant rather than passed in per call.
 *    Theirs takes a `seedPrevHash` argument because its chain is global; ours
 *    reads `organization.audit_purged_head_hash`, so one tenant's retention
 *    purge does not require every other tenant's verification to be seeded by
 *    hand.
 *
 * WHAT THIS DOES NOT CHECK, and must not start checking: sequence contiguity.
 * Gaps are normal — a rolled-back append consumes a sequence value and never
 * fills it — and a gap is also what a deleted row leaves behind. Deletion is
 * caught by the hash, because the next surviving row's `prev_hash` stops
 * matching. A contiguity check would fail on every rollback and tell an admin
 * that a routine gap is tampering. See GAP-AUDIT AU-6 and the test that pins it.
 */
import type { QueryRunner } from '@/lib/db/client';
import { computeEntryHash } from '@/lib/audit/chain';
import { ORG } from '@/lib/tenant/sql';

export interface VerifyWindow {
  /** Verify entries with sequence >= this. */
  fromSequence?: string;
  /** Verify entries with sequence <= this. */
  toSequence?: string;
  /** Rows per batch while walking. Default 1000. */
  batchSize?: number;
  /**
   * Override the hash the first row in the window should carry as its
   * `prev_hash`. Almost never needed — the watermark is read from the tenant
   * automatically. Present for the case where a caller is reconciling against a
   * hash it holds from somewhere else, e.g. an exported proof.
   */
  seedPrevHash?: string | null;
}

export interface VerifyOk {
  ok: true;
  scanned: number;
  firstSequence: string | null;
  lastSequence: string | null;
}

export interface VerifyFail {
  ok: false;
  scanned: number;
  reason: 'prev-hash-mismatch' | 'entry-hash-mismatch';
  at: {
    id: string;
    sequence: string;
    storedPrev: string | null;
    storedEntry: string;
    expectedPrev?: string | null;
    recomputedEntry?: string;
  };
}

export type VerifyResult = VerifyOk | VerifyFail;

interface Row {
  id: string;
  sequence: string;
  organization_id: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string;
  actor_role: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  prev_hash: string | null;
  entry_hash: string;
}

const SELECT_ROWS = `
  SELECT id, sequence, organization_id, occurred_at, actor_id, actor_email,
         actor_name, actor_role, action, entity_type, entity_id, details,
         ip_address, prev_hash, entry_hash
    FROM audit_entry
   WHERE ($1::bigint IS NULL OR sequence >= $1::bigint)
     AND ($2::bigint IS NULL OR sequence <= $2::bigint)
     AND ($3::bigint IS NULL OR sequence > $3::bigint)
   ORDER BY sequence
   LIMIT $4`;

export async function verifyChain(
  tx: QueryRunner,
  window: VerifyWindow = {},
): Promise<VerifyResult> {
  const batchSize = window.batchSize ?? 1000;
  const from = window.fromSequence ?? null;
  const to = window.toSequence ?? null;

  let expectedPrev: string | null;
  if (window.seedPrevHash !== undefined) {
    expectedPrev = window.seedPrevHash;
  } else if (from !== null) {
    // A window starting mid-chain reads the row immediately BEFORE it, so the
    // verify still proves integrity AT the window boundary rather than only
    // within it. Kept from ExpenseOS.
    const before = await tx.query(
      `SELECT entry_hash FROM audit_entry
        WHERE sequence < $1::bigint
        ORDER BY sequence DESC LIMIT 1`,
      [from],
    );
    expectedPrev = (before.rows[0]?.entry_hash as string | undefined) ?? null;
    if (before.rows.length === 0) expectedPrev = await purgeWatermark(tx);
  } else {
    // Verifying from the beginning: the oldest surviving row's prev_hash points
    // at whatever retention removed, which is indistinguishable from tampering
    // without the watermark.
    expectedPrev = await purgeWatermark(tx);
  }

  let scanned = 0;
  let firstSequence: string | null = null;
  let lastSequence: string | null = null;
  let cursor: string | null = null;

  for (;;) {
    const page = await tx.query(SELECT_ROWS, [from, to, cursor, batchSize]);
    const rows = page.rows as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          scanned,
          reason: 'prev-hash-mismatch',
          at: {
            id: row.id,
            sequence: String(row.sequence),
            storedPrev: row.prev_hash,
            storedEntry: row.entry_hash,
            expectedPrev,
          },
        };
      }
      const recomputed = computeEntryHash({
        organizationId: row.organization_id,
        occurredAt: row.occurred_at,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        actorName: row.actor_name,
        actorRole: row.actor_role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        details: row.details,
        ipAddress: row.ip_address,
        prevHash: row.prev_hash,
      });
      if (recomputed !== row.entry_hash) {
        return {
          ok: false,
          scanned,
          reason: 'entry-hash-mismatch',
          at: {
            id: row.id,
            sequence: String(row.sequence),
            storedPrev: row.prev_hash,
            storedEntry: row.entry_hash,
            recomputedEntry: recomputed,
          },
        };
      }
      expectedPrev = row.entry_hash;
      lastSequence = String(row.sequence);
      if (firstSequence === null) firstSequence = String(row.sequence);
      scanned += 1;
    }

    cursor = String(rows[rows.length - 1].sequence);
    if (rows.length < batchSize) break;
  }

  return { ok: true, scanned, firstSequence, lastSequence };
}

/** The hash of the last entry retention removed, or null if this tenant has
 *  never been purged. RLS scopes the row. */
async function purgeWatermark(tx: QueryRunner): Promise<string | null> {
  const r = await tx.query(
    `SELECT audit_purged_head_hash AS h
       FROM organization
      WHERE id = ${ORG}`,
  );
  return (r.rows[0]?.h as string | null | undefined) ?? null;
}

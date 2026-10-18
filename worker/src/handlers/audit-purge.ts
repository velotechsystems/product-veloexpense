import { auditActions, withAudit } from '@expenseos/audit';
import type { JobMap } from '@expenseos/jobs';
import { db } from '@/lib/db/prisma';

/**
 * Handler for `audit.purge` (daily). Deletes Audit rows past the retention
 * window and records a watermark so chain verification stays sound afterwards.
 *
 * Two things make this different from `notification.prune`:
 *
 * 1. **The cutoff comes from the retention flag, not from `Audit.expiresAt`.**
 *    `expiresAt` is stamped at write time as `occurredAt + 7 years`, so rows
 *    written before a retention change carry the old horizon forever. Deriving
 *    the cutoff from the current flag is what makes reconfiguring retention
 *    actually mean something. Rows are never deleted *earlier* than their
 *    stored `expiresAt`, so lengthening retention is honoured and shortening it
 *    below the SOX floor is refused at the router.
 *
 * 2. **Purging breaks the head of the hash chain.** The oldest surviving row's
 *    `prevHash` points at a row that no longer exists, which is
 *    indistinguishable from tampering. Before deleting, this records the newest
 *    purged row's id + entryHash in the `auditPurgeWatermark` system flag; the
 *    verifier uses it to seed `expectedPrev` and reconcile the gap.
 *
 * The purge writes its own audit row (`audit.retention.purge`) — a deletion in a
 * compliance log that leaves no trace of itself is exactly the thing an auditor
 * asks about.
 *
 * w5-07 — ported from ExpenseOS `apps/worker/src/handlers/audit-purge.ts` (1e682dd6).
 * VeloExpense, each marked below:
 *   · PER TENANT: the job runs as one tenant (fanned out by the schedule, as
 *     `expense.receiptChase` is), over that tenant's chain (0010), with that tenant's
 *     retention (`organization.audit_retention_years`, NULL = the 7-year floor, 0075) and
 *     watermark (`organization.audit_purged_*`, 0010 + 0075), where ExpenseOS has one chain and
 *     two SystemFlags;
 *   · the batch is a PREFIX of the chain by `sequence` (the chain's order), and the watermark
 *     names the sequence it purged through — what `lib/audit/verify.ts` reads;
 *   · ONE transaction for the watermark, the delete and the purge's own audit row. ExpenseOS
 *     writes the watermark first and deletes after, because its three steps commit separately
 *     ("The reverse order would leave a real gap with no watermark"); here they commit
 *     together or not at all, so neither half-state can exist;
 *   · the delete passes the append-only trigger by setting `app.audit_purge` for this
 *     transaction only (0010: "a purge is a deliberate, auditable act");
 *   · VeloExpense's writer stamps no `expires_at`, so a row with none is governed by the
 *     retention cutoff alone; a row that does carry one is still never deleted before it.
 */

const DEFAULT_RETENTION_YEARS = 7;
/** Bounded per run so one pass can't hold a long transaction over a huge log;
 *  the daily cadence catches up over subsequent runs. */
export const MAX_DELETE_PER_RUN = 50_000;

export interface AuditPurgeResult {
  retentionYears: number;
  cutoff: Date;
  purgedCount: number;
  truncated: boolean;
}

export async function handleAuditPurge(
  _data: JobMap['audit.purge'],
  opts: { now?: Date; maxPerRun?: number } = {},
): Promise<AuditPurgeResult> {
  const now = opts.now ?? new Date();
  const max = opts.maxPerRun ?? MAX_DELETE_PER_RUN;

  return db.$transaction(async (tx) => {
    const [org] = await tx.$queryRaw<{ years: number | null }[]>`
      SELECT audit_retention_years AS years FROM organization
       WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`;
    const years = org?.years ?? DEFAULT_RETENTION_YEARS;
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);

    // Eligible = old enough by the *current* policy AND past its own stamped
    // horizon. The second condition means a longer retention window protects rows
    // written under a shorter one, and a row is never destroyed ahead of the
    // promise made when it was written.
    //
    // VeloExpense: only the PREFIX of the chain that is eligible — everything older than the
    // first row that is not — and the oldest `max` of that. A purge that skipped a protected
    // row and deleted the ones after it would cut the chain in the middle, where no
    // watermark can reconcile it. The watermark then describes exactly what was deleted,
    // even when the run is truncated.
    const batch = await tx.$queryRaw<{ sequence: string; entry_hash: string; occurred_at: Date }[]>`
      SELECT a.sequence::text AS sequence, a.entry_hash, a.occurred_at FROM audit_entry a
       WHERE a.sequence < COALESCE(
               (SELECT min(k.sequence) FROM audit_entry k
                 WHERE NOT (k.occurred_at < ${cutoff} AND (k.expires_at IS NULL OR k.expires_at < ${now}))),
               9223372036854775807)
       ORDER BY a.sequence ASC
       LIMIT ${max}`;
    const last = batch.at(-1);
    if (!last) {
      console.log(`[audit.purge] nothing past retention (${years}y, cutoff ${cutoff.toISOString()})`);
      return { retentionYears: years, cutoff, purgedCount: 0, truncated: false };
    }

    // The watermark: the newest row about to go — its entryHash is the `prevHash` the
    // oldest survivor will carry.
    await tx.$executeRaw`
      UPDATE organization
         SET audit_purged_through_sequence = ${last.sequence}::bigint,
             audit_purged_head_hash = ${last.entry_hash},
             audit_purged_count = ${batch.length},
             audit_purged_at = ${now}
       WHERE id = NULLIF(current_setting('app.current_org', true), '')::uuid`;

    await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
    const deleted = await tx.$executeRaw`
      DELETE FROM audit_entry WHERE sequence <= ${last.sequence}::bigint`;
    await tx.$executeRaw`SELECT set_config('app.audit_purge', 'off', true)`;
    const truncated = batch.length === max;

    // Recorded after the deletion so this row is never itself in the purged range.
    // VeloExpense: on the same transaction (`withAudit` on `tx` runs inside it).
    await withAudit(
      { $transaction: (fn) => fn(tx) },
      {
        action: auditActions.audit.retentionPurge,
        entityType: 'Audit',
        actor: { kind: 'system', jobName: 'audit.purge' },
        details: {
          retentionYears: years,
          cutoff: cutoff.toISOString(),
          purgedCount: deleted,
          purgedThrough: last.occurred_at.toISOString(),
          truncated,
        },
      },
      async () => undefined,
    );

    console.log(
      `[audit.purge] removed ${deleted} audit row(s) older than ${years}y ` +
        `(through ${last.occurred_at.toISOString()})` +
        (truncated ? ' — capped, more next run' : ''),
    );
    return { retentionYears: years, cutoff, purgedCount: deleted, truncated };
  });
}

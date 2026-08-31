/**
 * VX3-4 — drain the ledger post queue.
 *
 * ── Three transactions per row, and the middle one is not a transaction ──────
 *
 * Same structure as VX2-8's `drainOutbox`, for the same reason: an HTTP call to
 * somebody else's service must not be inside a database transaction. So —
 *
 *   1. claim the row (a conditional write, its own transaction)
 *   2. call the ledger (NO transaction open)
 *   3. record what happened (its own transaction)
 *
 * ── The distinction this file exists to make ─────────────────────────────────
 *
 * A failure is one of two kinds and they must not be conflated:
 *
 *   REFUSED — 401/403/404/422, or a problem found before the call. Nothing exists
 *             at the far end, so the row stays retryable.
 *   AMBIGUOUS — a timeout, a network error, a 5xx. The bill MIGHT exist. The row
 *             becomes NEEDS_REVIEW, which no automatic path will touch.
 *
 * GAP-AUDIT AC-8 is what happens when that distinction is missing: ExpenseOS
 * writes the ambiguous case as a retryable FAILED row with "do NOT re-post" in its
 * error column, and its sweep re-posts it up to five times. The instruction is
 * addressed to a human and enforced against nobody.
 *
 * VX3-7 CORRECTED A DEFECT IN THIS FILE. It used to import the refused-versus-
 * ambiguous classifier from the VeloLedger adapter by name, so VeloLedger was the
 * only adapter that could report a refusal and every other adapter's failures —
 * a 401 included — became NEEDS_REVIEW, a state no automatic path retries. The
 * classifier is now `isDefinitelyNotApplied` on the contract, satisfied by any
 * adapter that throws `AdapterError`, and the default for anything else is still
 * the dangerous case.
 *
 * VeloLedger's `idempotencyKey` means a genuine double-send would be refused at
 * the far end anyway — which is a much better position than the NetSuite path,
 * whose only guard was `externalId` uniqueness asserted by no test in a transport
 * marked "UNVERIFIED against a live account". We still make the distinction: a
 * guard that depends on the other system behaving is not the guard.
 */
import { withOrg } from '@/lib/tenant/context';
import { requireCapability, IntegrationError } from '@/lib/integrations/service';
import {
  claimPost,
  duePosts,
  markFailed,
  markNeedsReview,
  markPosted,
} from '@/lib/integrations/post-outbox';
import { isDefinitelyNotApplied, type PostableReport } from '@/lib/integrations/contract';
import type { QueryRunner } from '@/lib/db/client';

export interface DrainResult {
  claimed: number;
  posted: number;
  failed: number;
  needsReview: number;
  skipped: number;
}

/**
 * Everything a bill needs, in the adapter's vendor-neutral shape.
 *
 * `gl_account_number` comes from the LINE's snapshot (VX3-1 / AC-10), falling back
 * to the category's current account only when the line has none — which happens
 * for a line written before `0014`. It does NOT prefer the category: a report posts
 * to the account it was coded to when it was filed.
 */
async function loadPostable(tx: QueryRunner, reportId: string): Promise<PostableReport | null> {
  const r = await tx.query(
    `SELECT rep.id, rep.number, rep.title, rep.currency_code, rep.total_minor, rep.approved_at,
            u.display_name AS submitter_name, u.email AS submitter_email
       FROM expense_report rep
       JOIN app_user u ON u.id = rep.submitter_id
      WHERE rep.id = $1`,
    [reportId],
  );
  if (r.rows.length === 0) return null;
  const head = r.rows[0];

  const lines = await tx.query(
    `SELECT li.id, li.description, li.amount_minor, li.tax_minor,
            c.code AS category_code, c.label AS category_label,
            coalesce(lg.number, cg.number) AS gl_account_number,
            coalesce(lg.name, cg.name)     AS gl_account_name,
            e.txn_date, e.merchant
       FROM expense_line_item li
       JOIN expense e ON e.id = li.expense_id
       JOIN expense_category c ON c.id = li.category_id
       LEFT JOIN gl_account lg ON lg.id = li.gl_account_id
       LEFT JOIN gl_account cg ON cg.id = c.gl_account_id
      WHERE e.report_id = $1
      ORDER BY e.txn_date NULLS LAST, li.created_at`,
    [reportId],
  );

  return {
    reportId: head.id as string,
    number: head.number as string | null,
    title: head.title as string,
    submitterName: (head.submitter_name as string | null) ?? (head.submitter_email as string),
    submitterEmail: head.submitter_email as string,
    currencyCode: head.currency_code as string,
    totalMinor: String(head.total_minor),
    approvedAt: head.approved_at as Date | null,
    lines: lines.rows.map((line) => ({
      lineItemId: line.id as string,
      description: line.description as string | null,
      categoryCode: line.category_code as string,
      categoryLabel: line.category_label as string,
      glAccountNumber: line.gl_account_number as string | null,
      glAccountName: line.gl_account_name as string | null,
      amountMinor: String(line.amount_minor),
      taxMinor: String(line.tax_minor),
      txnDate: line.txn_date as Date | null,
      merchant: line.merchant as string | null,
    })),
  };
}

/**
 * Post one claimed row. Exported so the admin screen's "send now" and the poller
 * share one implementation rather than two that drift.
 */
export async function postOne(
  organizationId: string,
  postId: string,
): Promise<'POSTED' | 'FAILED' | 'NEEDS_REVIEW' | 'SKIPPED'> {
  const claimed = await withOrg(organizationId, (tx) => claimPost(tx, postId));
  // Somebody else took it, or it is no longer due. The normal outcome for the
  // loser of a race, not an error.
  if (!claimed) return 'SKIPPED';

  const prepared = await withOrg(organizationId, async (tx) => {
    try {
      const resolved = await requireCapability(tx, 'POST_EXPENSE_REPORT');
      const report = await loadPostable(tx, claimed.reportId);
      if (!report) return { kind: 'GONE' as const };
      return { kind: 'READY' as const, resolved, report };
    } catch (err) {
      if (err instanceof IntegrationError && err.code === 'NO_CAPABILITY') {
        // Nothing connected that can post. NOT a failure of this row — it must not
        // burn an attempt, or a tenant that connects a ledger a week later finds
        // every waiting report already DEAD.
        return {
          kind: 'WAITING' as const,
          reason: 'No accounting integration is connected.',
        };
      }
      if (err instanceof IntegrationError && err.code === 'AMBIGUOUS_CAPABILITY') {
        // AC-22: TWO ledgers can post, so there is no right answer and this must
        // not invent one. Same treatment as "nothing is connected" — waiting, no
        // attempt burnt — because the fix is a human disconnecting one, and every
        // report must still be here when they do. The reason goes on the row, so
        // the queue screen says which two rather than merely "waiting".
        return { kind: 'WAITING' as const, reason: err.message };
      }
      throw err;
    }
  });

  if (prepared.kind === 'WAITING') {
    await withOrg(organizationId, (tx) =>
      tx.query(
        `UPDATE integration_post
            SET claimed_at = NULL, claimed_by = NULL,
                next_attempt_at = clock_timestamp() + interval '1 hour',
                last_error = $2
          WHERE id = $1`,
        [postId, prepared.reason],
      ),
    );
    return 'SKIPPED';
  }
  if (prepared.kind === 'GONE') {
    await withOrg(organizationId, (tx) =>
      markFailed(tx, postId, 'the report no longer exists'),
    );
    return 'FAILED';
  }

  const { resolved, report } = prepared;
  // ── Outside any transaction ────────────────────────────────────────────────
  try {
    const result = await resolved.adapter.postExpenseReport!(resolved.config, report);
    try {
      await withOrg(organizationId, (tx) =>
        markPosted(tx, postId, result.externalId, resolved.installationId),
      );
      return 'POSTED';
    } catch (recordErr) {
      // THE case AC-8 is about: the ledger accepted it and we could not write that
      // down. Terminal to every automatic path, and `0017`'s platform_read policy
      // does not match NEEDS_REVIEW, so the poller cannot see it even if a future
      // change forgot to exclude it.
      await withOrg(organizationId, (tx) =>
        markNeedsReview(
          tx,
          postId,
          result.externalId,
          `Drafted in the ledger as ${result.externalId} but recording it here failed: ` +
            `${recordErr instanceof Error ? recordErr.message : String(recordErr)}. ` +
            `Do not retry without checking the ledger first.`,
        ),
      ).catch(() => undefined);
      return 'NEEDS_REVIEW';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitelyNotApplied(err)) {
      await withOrg(organizationId, (tx) => markFailed(tx, postId, message));
      return 'FAILED';
    }
    // Ambiguous: a timeout, a network error, a 5xx. The bill MIGHT exist.
    await withOrg(organizationId, (tx) =>
      markNeedsReview(
        tx,
        postId,
        // NULL, not '': see the note on markNeedsReview. We never got an id, which
        // is exactly the problem, and two empty strings in one tenant would
        // collide on the unique index and drop the row back to retryable.
        null,
        `The ledger may or may not have accepted this: ${message}. Check the ledger ` +
          `for a bill referencing this report before retrying.`,
      ).catch(() => markFailed(tx, postId, message)),
    );
    return 'NEEDS_REVIEW';
  }
}

/** Drain due work across every tenant. */
export async function drainPosts(limit = 50): Promise<DrainResult> {
  const due = await duePosts(limit);
  const result: DrainResult = { claimed: 0, posted: 0, failed: 0, needsReview: 0, skipped: 0 };
  for (const row of due) {
    const outcome = await postOne(row.organizationId, row.id);
    if (outcome === 'SKIPPED') {
      result.skipped += 1;
      continue;
    }
    result.claimed += 1;
    if (outcome === 'POSTED') result.posted += 1;
    else if (outcome === 'FAILED') result.failed += 1;
    else result.needsReview += 1;
  }
  return result;
}

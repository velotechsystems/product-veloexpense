/**
 * Fold a bulk upload's duplicate documents onto one expense.
 *
 * `startFromReceipts` creates one expense per file BEFORE anything is read, so a
 * restaurant bill and its card copy arrive as two expenses each carrying the full
 * total — the meal claimed twice, both expenses individually well-formed. This runs
 * once the batch's extractions land, when there is finally something to compare.
 *
 * The decision itself is pure and lives in `@expenseos/receipt-extraction`
 * (`groupDocuments`); this is the part that touches the database. Only CONFIDENT
 * groups are merged silently — a group the evidence does not positively agree on is
 * logged and left alone, because a wrong merge hides a charge nobody saw.
 *
 * Best-effort, like every extraction path: the receipts and expenses are already
 * persisted, so a failure here leaves an over-claim to fix by hand rather than
 * losing anything.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/group-receipts.ts` (550b2945),
 * Wave 3 (w3-02b). VeloExpense: `db` is the tenant-scoped client, and the joint pass it
 * queues names the tenant the job runs as (`currentTenantId`).
 */

import { recomputeReportTotal } from '@expenseos/db';
import { enqueue } from '@expenseos/jobs';
import { currentTenantId, db } from '@/lib/db/prisma';
import { type GroupCandidate, groupDocuments } from '@expenseos/receipt-extraction';
import { message } from './extract-core';
import { isReportEditable, lockReportStatus } from './report-editable';

/** The extraction payload's shape, as far as grouping cares. Read defensively:
 *  `DocumentExtraction.data` is a Json column and an older row predates the two
 *  fields the distinctness veto needs. */
function candidateFrom(row: {
  id: string;
  expenseId: string | null;
  kind: string;
  extraction: { data: unknown; confidence: unknown } | null;
}): GroupCandidate | null {
  if (!row.expenseId || !row.extraction?.data) return null;
  const d = row.extraction.data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    documentId: row.id,
    expenseId: row.expenseId,
    vendor: str(d.vendor),
    date: str(d.date),
    time: str(d.time),
    transactionId: str(d.transactionId),
    currencyCode: str(d.currencyCode),
    total: num(d.total),
    subtotal: num(d.subtotal),
    voluntaryTip: num(d.voluntaryTip),
    confidence: Number(row.extraction.confidence ?? 0),
    kind: row.kind,
  };
}

export interface GroupingOutcome {
  merged: number;
  /** Groups the evidence did not positively agree on. Left alone deliberately. */
  proposed: number;
}

/**
 * Group and merge the documents from one upload.
 *
 * Scoped to the receipts of this batch rather than the whole report: a document
 * uploaded weeks ago has already been reviewed, and quietly folding it into a new
 * expense would move something a human had settled.
 */
export async function groupUploadedReceipts(receiptIds: string[]): Promise<GroupingOutcome> {
  if (receiptIds.length < 2) return { merged: 0, proposed: 0 };
  // VeloExpense: the joint pass this queues runs as a separate job, which reaches its
  // tenant only through its payload. Read once, before anything moves.
  const organizationId = currentTenantId();
  if (!organizationId) throw new Error('groupUploadedReceipts: no tenant scope');

  const rows = await db.receipt.findMany({
    where: { id: { in: receiptIds } },
    select: {
      id: true,
      expenseId: true,
      kind: true,
      extraction: { select: { data: true, confidence: true } },
    },
  });
  const candidates = rows.map(candidateFrom).filter((c): c is GroupCandidate => c !== null);
  if (candidates.length < 2) return { merged: 0, proposed: 0 };

  const groups = groupDocuments(candidates);
  let merged = 0;
  let proposed = 0;

  for (const group of groups) {
    if (!group.confident) {
      proposed += 1;
      console.info(
        `[group-receipts] not merging ${group.members.length} documents (${group.reason}) — evidence is not conclusive`,
      );
      continue;
    }
    try {
      const survivorId = group.survivorExpenseId;
      const moving = group.members.filter((m) => m.expenseId !== survivorId);
      if (moving.length === 0) continue;

      // The expenses being vacated. Only ever deleted when they hold nothing else —
      // this runs before anyone has opened them, but a concurrent upload could have
      // added a document, and dropping that would lose a file.
      const vacatedIds = [...new Set(moving.map((m) => m.expenseId))];
      const reportId = (
        await db.expense.findUniqueOrThrow({
          where: { id: survivorId },
          select: { reportId: true },
        })
      ).reportId;

      // A merge moves documents and deletes the emptied expense — a change to the
      // filed claim. Batch extraction can land an hour after the upload, by which
      // time the person may have submitted; a submitted report is left as filed.
      // Same lock-then-check as the prefill, for the same race.
      const moved = await db.$transaction(async (tx) => {
        if (!isReportEditable(await lockReportStatus(tx, reportId))) return false;
        await tx.receipt.updateMany({
          where: { id: { in: moving.map((m) => m.documentId) } },
          data: { expenseId: survivorId },
        });
        for (const id of vacatedIds) {
          const left = await tx.receipt.count({ where: { expenseId: id } });
          if (left === 0) await tx.expense.delete({ where: { id } });
        }
        // Under the same lock as the deletes: the total and the expense set it
        // describes commit together, or not at all.
        await recomputeReportTotal(tx, reportId);
        return true;
      });
      if (!moved) {
        proposed += 1;
        console.info(
          `[group-receipts] not merging ${group.members.length} documents — report ${reportId} is no longer editable`,
        );
        continue;
      }

      // The survivor now holds the whole set, so its determination is re-derived by
      // the pass that already knows a card copy outranks a pre-tip bill.
      await enqueue('expense.determineExpense', {
        organizationId,
        expenseId: survivorId,
      });
      merged += 1;
      console.info(
        `[group-receipts] merged ${group.members.length} documents onto expense ${survivorId} (${group.reason})`,
      );
    } catch (err) {
      console.warn(`[group-receipts] merge failed (${group.reason}): ${message(err)}`);
    }
  }
  return { merged, proposed };
}

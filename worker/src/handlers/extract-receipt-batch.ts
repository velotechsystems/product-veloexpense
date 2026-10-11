import { enqueue, type JobMap } from '@expenseos/jobs';
import {
  type BatchItem,
  collectReceiptBatch,
  DEFAULT_MODEL,
  ExtractionUnavailableError,
  extractReceipt,
  retrieveReceiptBatch,
  submitReceiptBatch,
} from '@expenseos/receipt-extraction';
import { db } from '@/lib/db/prisma';
import { anthropicForExtraction } from './lib/anthropic';
import {
  finalizeExtraction,
  message,
  prepareExtraction,
  recordExtractionUsage,
} from './lib/extract-core';
import { groupUploadedReceipts } from './lib/group-receipts';
import { type CategoryRow, labelEn, loadReviewThreshold, prefillExpense } from './lib/prefill';

/**
 * Handler for `expense.extractReceipt.batch`. Extracts several receipts uploaded
 * together in ONE Anthropic Message Batch (~50% cheaper, async) instead of N
 * synchronous calls. A single ready receipt is still one synchronous message
 * (the Batch API's latency isn't worth it for one document).
 *
 * The batch lifecycle is a two-phase state machine carried in the job payload
 * (no schema): submit phase (no `batchId`) scans + normalizes each receipt and
 * submits the ready ones; poll phase (`batchId` present) re-enqueues until the
 * batch ends, then finalizes + prefills each result. BEST-EFFORT throughout: a
 * receipt that isn't scan-ready falls back to its own sync job; nothing throws.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/extract-receipt-batch.ts` (550b2945),
 * Wave 3 (w3-02b). VeloExpense: runs inside the job's tenant scope, every job it queues
 * carries `organizationId`, and each model call — the batch's items at the batch rate, the
 * lone synchronous one at the standard rate — is recorded in `ai_usage` (d43).
 */

/** Re-poll cadence + budget (batch usually settles in minutes; cap ~1h). */
const POLL_DELAY_MS = 30_000;
const MAX_POLL_ATTEMPTS = 120;

async function loadCategories(): Promise<CategoryRow[]> {
  return db.expenseCategory.findMany({
    where: { active: true },
    select: {
      id: true,
      label: true,
      itcGstHstRate: true,
      itcQstRate: true,
      pstRecoverable: true,
      // Where an extracted tip may land, and which lines are mileage.
      acceptsTip: true,
      isMileage: true,
    },
  });
}

async function prefillReceipt(
  receiptId: string,
  categories: CategoryRow[],
  ex: Parameters<typeof prefillExpense>[2],
  reviewThreshold: number,
) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    select: { expenseId: true },
  });
  if (!receipt?.expenseId) return;
  try {
    await prefillExpense(receipt.expenseId, categories, ex, reviewThreshold, receiptId);
  } catch (err) {
    console.warn(
      `[extract-receipt-batch] prefill skipped for receipt ${receiptId}: ${message(err)}`,
    );
  }
}

export async function handleExtractReceiptBatch(
  data: JobMap['expense.extractReceipt.batch'],
): Promise<void> {
  // The `anthropic` integration's credential, with the environment behind it. Resolved
  // once for the whole invocation — the submit, the poll and the collect must all reach
  // the same account, or a batch submitted under one key becomes unreadable under
  // another.
  const anthropic = await anthropicForExtraction();
  const keyOpt = anthropic?.apiKey ? { apiKey: anthropic.apiKey } : {};

  // ── Poll phase ────────────────────────────────────────────────────────
  if (data.batchId) {
    const { status } = await retrieveReceiptBatch(data.batchId, keyOpt);
    if (status !== 'ended') {
      const attempt = data.pollAttempt ?? 0;
      if (attempt < MAX_POLL_ATTEMPTS) {
        await enqueue(
          'expense.extractReceipt.batch',
          {
            organizationId: data.organizationId,
            receiptIds: data.receiptIds,
            batchId: data.batchId,
            model: data.model,
            pollAttempt: attempt + 1,
          },
          { delayMs: POLL_DELAY_MS },
        );
      } else {
        // Exhausted the poll budget — don't leave rows stuck EXTRACTING.
        for (const id of data.receiptIds) {
          await finalizeExtraction(
            { receiptId: id },
            { ok: false, error: 'batch timed out' },
          ).catch(() => {});
        }
      }
      return;
    }
    const model = data.model ?? DEFAULT_MODEL;
    const results = await collectReceiptBatch(data.batchId, keyOpt);
    const categories = await loadCategories();
    const reviewThreshold = await loadReviewThreshold();
    for (const r of results) {
      if (r.data) {
        await recordExtractionUsage(r.customId, { model, rawResponse: r.rawResponse }, { batch: true });
        await finalizeExtraction(
          { receiptId: r.customId },
          {
            ok: true,
            result: {
              model,
              data: r.data,
              confidence: r.confidence ?? null,
              rawResponse: r.rawResponse,
            },
          },
        );
        await prefillReceipt(r.customId, categories, r.data, reviewThreshold);
      } else {
        await finalizeExtraction(
          { receiptId: r.customId },
          { ok: false, error: r.error ?? 'batch item failed' },
        );
      }
    }
    // Every document in this upload has now been read, which is the first moment
    // anything can be compared. A bill and its card copy arrived as two expenses
    // each carrying the full total; this is what stops the meal being claimed twice.
    // Best-effort: an over-claim to fix by hand beats losing the extractions.
    try {
      const grouped = await groupUploadedReceipts(data.receiptIds);
      if (grouped.merged > 0 || grouped.proposed > 0) {
        console.info(
          `[extract-receipt-batch] grouping: ${grouped.merged} merged, ${grouped.proposed} left for review`,
        );
      }
    } catch (err) {
      console.warn(`[extract-receipt-batch] grouping skipped: ${message(err)}`);
    }
    return;
  }

  // ── Submit phase ──────────────────────────────────────────────────────
  const receipts = await db.receipt.findMany({
    where: { id: { in: data.receiptIds } },
    select: { id: true, s3Key: true, contentType: true, expenseId: true },
  });
  const categories = await loadCategories();
  const hints = categories.map((c) => ({ code: c.id, label: labelEn(c.label) }));

  // Scan + normalize each; only CLEAN, ready documents go into the batch. A
  // still-scanning receipt re-enqueues as its own sync job (self-polls) and is
  // excluded here.
  const items: BatchItem[] = [];
  for (const rc of receipts) {
    if (!rc.expenseId) continue;
    const prepared = await prepareExtraction({
      where: { receiptId: rc.id },
      s3Key: rc.s3Key,
      contentType: rc.contentType,
      categoryHints: hints,
      scanAttempt: data.scanAttempt,
      rescheduleScan: (delayMs, nextAttempt) =>
        enqueue(
          'expense.extractReceipt',
          { organizationId: data.organizationId, receiptId: rc.id, scanAttempt: nextAttempt },
          { delayMs },
        ),
    });
    if (prepared) {
      items.push({
        customId: rc.id,
        data: prepared.data,
        mimeType: prepared.mimeType,
        categoryHints: hints,
      });
    }
  }

  if (items.length === 0) return; // nothing ready — sync fallbacks (if any) will run

  // One ready document → a single synchronous message (batch isn't worth it).
  if (items.length === 1) {
    const only = items[0];
    try {
      const result = await extractReceipt({
        data: only.data,
        mimeType: only.mimeType,
        categoryHints: hints,
        ...keyOpt,
        ...(anthropic?.model ? { model: anthropic.model } : {}),
      });
      await recordExtractionUsage(only.customId, result);
      await finalizeExtraction({ receiptId: only.customId }, { ok: true, result });
      await prefillReceipt(only.customId, categories, result.data, await loadReviewThreshold());
    } catch (err) {
      await finalizeExtraction(
        { receiptId: only.customId },
        { ok: false, unavailable: err instanceof ExtractionUnavailableError, error: message(err) },
      );
    }
    return;
  }

  // ≥2 ready → one Batch API submission, then poll.
  try {
    const { batchId, model } = await submitReceiptBatch(items, {
      ...keyOpt,
      ...(anthropic?.model ? { model: anthropic.model } : {}),
    });
    await enqueue(
      'expense.extractReceipt.batch',
      {
        organizationId: data.organizationId,
        receiptIds: items.map((i) => i.customId),
        batchId,
        model,
        pollAttempt: 0,
      },
      { delayMs: POLL_DELAY_MS },
    );
  } catch (err) {
    const unavailable = err instanceof ExtractionUnavailableError;
    for (const it of items) {
      await finalizeExtraction(
        { receiptId: it.customId },
        { ok: false, unavailable, error: message(err) },
      ).catch(() => {});
    }
  }
}

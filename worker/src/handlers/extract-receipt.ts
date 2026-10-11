import { type Prisma, supersedeDetermination } from '@expenseos/db';
import { enqueue, type JobMap } from '@expenseos/jobs';
import type { CategoryHint } from '@expenseos/receipt-extraction';
import { db } from '@/lib/db/prisma';
import { anthropicForExtraction } from './lib/anthropic';
import { message, runDocumentExtraction } from './lib/extract-core';
import { labelEn, loadReviewThreshold, prefillExpense } from './lib/prefill';

/**
 * Handler for `expense.extractReceipt`. Runs the shared AV-scan →
 * HEIC-normalize → Claude-vision pipeline on one uploaded receipt, then
 * best-effort prefills the (blank) Expense.
 *
 * BEST-EFFORT BY DESIGN: the Receipt + Expense are already persisted by the
 * upload flow. This handler NEVER throws on a business failure — no API key, a
 * model error, an infected file, or a prefill hiccup all just mark the
 * satellite and return, leaving the blank Expense + visible file intact. (A
 * genuinely transient infra error is the only case worth a retry; we still
 * record it and return rather than storm the queue.)
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/extract-receipt.ts` (550b2945), Wave 3
 * (w3-02a). VeloExpense: runs inside the job's tenant scope (worker/src/main.ts), so `db`
 * is the tenant's and the re-poll carries `organizationId`; and the joint determination
 * for an expense holding several documents (`expense.determineExpense`) is not ported yet
 * (w3-02b), so such an expense keeps each document's own reading and is not prefilled.
 */
export async function handleExtractReceipt(
  data: JobMap['expense.extractReceipt'],
  job?: { attemptsMade?: number; opts?: { attempts?: number } },
): Promise<void> {
  const receipt = await db.receipt.findUnique({
    where: { id: data.receiptId },
    select: { id: true, s3Key: true, contentType: true, expenseId: true },
  });
  if (!receipt?.expenseId) return; // receipt gone or not attached to an expense — nothing to do

  // Constrain the category to the real ExpenseCategory ids (used for both the
  // extraction hint vocabulary and the tax prefill lookup).
  const categories = await db.expenseCategory.findMany({
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
  const hints: CategoryHint[] = categories.map((c) => ({ code: c.id, label: labelEn(c.label) }));

  // Resolved once: the same object decides which key extracts and which model gets
  // RECORDED on the determination row. Reading the env var separately down there is how
  // the two drifted — an integration-pinned model would have extracted correctly and
  // then been logged as whatever the task definition happened to say.
  const anthropic = await anthropicForExtraction();

  const extraction = await runDocumentExtraction({
    where: { receiptId: receipt.id },
    s3Key: receipt.s3Key,
    contentType: receipt.contentType,
    categoryHints: hints,
    anthropic,
    scanAttempt: data.scanAttempt,
    rescheduleScan: (delayMs, nextAttempt) =>
      enqueue(
        'expense.extractReceipt',
        { organizationId: data.organizationId, receiptId: receipt.id, scanAttempt: nextAttempt },
        { delayMs },
      ),
    /**
     * `attemptsMade` counts the tries BEFORE this one, so the run in progress is the
     * (n+1)th. Absent job ⇒ not final, which keeps the row retryable rather than
     * declaring a document unreadable on the strength of a missing argument.
     */
    isFinalAttempt: () => (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1),
  });
  if (!extraction) return; // bailed to PENDING/FAILED/scan-pending — nothing to prefill

  // How many documents this expense now holds. One is already one answer, so it
  // prefills from its own extraction as it always has and records that as the
  // determination — no second model call to reach the same conclusion. More than
  // one means the documents have to be read TOGETHER (rule 2): a bill and its
  // cardholder copy describe one charge, and only a reader that sees both knows
  // the difference between them is a tip rather than a second purchase.
  const documentCount = await db.receipt.count({ where: { expenseId: receipt.expenseId } });

  if (documentCount > 1) {
    // VeloExpense (w3-02a): ExpenseOS enqueues the joint pass here
    // (`expense.determineExpense`), which arrives with w3-02b. Until then the documents'
    // own readings stand on the receipt pane and the expense is left as the person has it:
    // prefilling from ONE of several documents is exactly what rule 2 forbids.
    console.info(
      `[extract-receipt] expense ${receipt.expenseId} holds ${documentCount} documents; the joint determination arrives with w3-02b`,
    );
    return;
  }

  // Best-effort prefill — never fails the job.
  try {
    await prefillExpense(
      receipt.expenseId,
      categories,
      extraction,
      await loadReviewThreshold(),
      receipt.id,
    );
  } catch (err) {
    console.warn(
      `[extract-receipt] prefill skipped for expense ${receipt.expenseId}: ${message(err)}`,
    );
  }

  // Record the single-document conclusion AS a determination, so the override
  // machinery is uniform: a person who corrects a one-document expense and then
  // uploads a second file has their correction carried into the joint pass. With
  // no determination row there would be nowhere to record that edit, and it would
  // be silently overwritten by the rebuild.
  try {
    await supersedeDetermination(db, {
      expenseId: receipt.expenseId,
      receiptIds: [receipt.id],
      proposed: extraction as unknown as Prisma.InputJsonValue,
      model: anthropic?.model ?? process.env.RECEIPT_EXTRACTION_MODEL ?? null,
      confidence: typeof extraction.confidence === 'number' ? extraction.confidence : null,
    });
  } catch (err) {
    console.warn(
      `[extract-receipt] determination record skipped for expense ${receipt.expenseId}: ${message(err)}`,
    );
  }
}

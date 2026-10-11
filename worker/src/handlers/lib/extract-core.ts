import { randomUUID } from 'node:crypto';
import { DocExtractStatus, DocScanStatus, type Prisma } from '@expenseos/db';
import {
  type CategoryHint,
  ExtractionUnavailableError,
  type ExtractResult,
  extractReceipt,
  isTransientExtractionFailure,
  type ReceiptExtraction,
  sharpNormalizer,
} from '@expenseos/receipt-extraction';
import { type AiFeature, recordUsage, usageOf } from '@/lib/ai/usage';
import { db } from '@/lib/db/prisma';
import { type BoundedRead, getStorage } from '@/lib/storage';
// Subpaths, not the root barrel: a test that mocks `@/lib/storage` wholesale still runs
// the real HEAD-then-bounded-read logic and gets the real caps.
import { guardedRead } from '@/lib/storage/guardedRead';
import { RECEIPT_CAP_BYTES } from '@/lib/storage/limits';
import { MAX_SCAN_ATTEMPTS, scanPollDelayMs } from './scanPolicy';

/*
 * Ported from ExpenseOS's `apps/worker/src/handlers/lib/extract-core.ts` (550b2945), Wave 3
 * (w3-02a). VeloExpense:
 *   · `db` is the tenant-scoped client (lib/db/prisma.ts), statement at a time inside the
 *     job (`withTenantStatements`, worker/src/main.ts), so each status write is committed —
 *     and seen by the screen and by `submit` — as it is made, as ExpenseOS's are;
 *   · storage is `lib/storage` (`getStorage()`, one bucket), not `storage.receipts`;
 *   · receipts only: ExpenseOS also extracts virtual-card attachments, which VeloExpense
 *     does not have, so `ExtractionKey` is the receipt arm and the cap is the receipt cap;
 *   · every model call is recorded in `ai_usage` (d43, lib/ai/usage.ts), which ExpenseOS
 *     does not do.
 */

/**
 * GuardDuty Malware Protection for S3 scans objects asynchronously after upload,
 * so the tag isn't present the instant the extraction job first runs. When the
 * scan is still in progress we re-enqueue the job with a short delay to re-poll,
 * up to a bound — instead of throwing (which would log a spurious failure) or
 * busy-waiting. Enabled only where a real scanner exists (`S3_MALWARE_SCAN=guardduty`);
 * local/MinIO leaves it unset and allows.
 */
const SCAN_ENABLED = process.env.S3_MALWARE_SCAN === 'guardduty';

// The re-poll schedule lives in `scanPolicy` (no imports) so a hermetic unit test
// can reach it without loading this module's Prisma client. Re-exported for
// existing importers; a bare `export … from` would not bind the names for use
// here, so it is imported too.
export { MAX_SCAN_ATTEMPTS, scanPollDelayMs } from './scanPolicy';

/** Which DocumentExtraction row this run owns — exactly one FK. VeloExpense: receipts
 *  only (ExpenseOS's other arm is a virtual-card attachment). */
export type ExtractionKey = { receiptId: string };

export interface DocumentExtractionInput {
  /** DocumentExtraction upsert key (receipt vs VCC attachment). */
  where: ExtractionKey;
  s3Key: string;
  contentType: string;
  /** Optional category vocabulary the model may map `derivedCategoryCode` to. */
  categoryHints?: CategoryHint[];
  /** Self-re-enqueue count while the malware scan is in progress (0 = first run). */
  scanAttempt?: number;
  /**
   * Re-enqueue this same job to re-poll the malware-scan tag after a delay.
   * Supplied by each handler (it knows its own job name + payload). Absent =>
   * no re-poll (the run just settles at PENDING).
   */
  rescheduleScan?: (delayMs: number, nextAttempt: number) => Promise<void>;
  /**
   * Is this the queue's LAST attempt at this job?
   *
   * A transient provider failure is re-thrown so BullMQ retries it — but on the final
   * attempt there is nothing left to retry into, and re-throwing would leave the row
   * PENDING for ever, which reads as "still working" about something that has stopped.
   * Knowing it is the last go is what lets the run settle honestly as FAILED with the
   * provider's own words. Absent ⇒ treated as not-final, which is the safe direction:
   * at worst the row stays retryable and a person can re-run it.
   */
  isFinalAttempt?: () => boolean;
  /**
   * Claude credential + model, resolved by the handler from the `anthropic`
   * integration (falling back to the environment).
   *
   * Passed in rather than read from `process.env` down here, because the credential
   * now lives in a database row an admin can rotate — and because a key read at the
   * bottom of the stack is a key nobody can see is missing. Optional: absent means
   * "let the package fall back to the environment", which keeps the local and test
   * paths working.
   */
  anthropic?: { apiKey: string; model?: string } | null;
}

/**
 * Malware-scan gate → download → HEIC-normalize, shared by the sync and batch
 * paths. Owns the `DocumentExtraction` satellite (upsert on the provided key)
 * and drives its status up to EXTRACTING. Returns the CLEAN, normalized bytes
 * ready for the model — or `null` when it bailed (infected, scan
 * unavailable/in-progress, missing or over-cap object, download/normalize failure);
 * on a bail the status is already written and, for a still-scanning object,
 * `rescheduleScan` has been called. NEVER throws on a business failure.
 */
export async function prepareExtraction(
  input: DocumentExtractionInput,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  // The satellite row is owned here (upsert): the web side only enqueues.
  const ext = await db.documentExtraction.upsert({
    where: input.where as Prisma.DocumentExtractionWhereUniqueInput,
    create: input.where,
    update: {},
    select: { id: true },
  });
  const setStatus = (patch: Prisma.DocumentExtractionUpdateInput) =>
    db.documentExtraction.update({ where: { id: ext.id }, data: patch });

  // 1. Malware-scan gate — read GuardDuty's scan-status tag by key BEFORE
  //    downloading any bytes. Only 'clean' proceeds.
  if (SCAN_ENABLED) {
    await setStatus({ scanStatus: DocScanStatus.SCANNING });
    const scan = await getStorage().getMalwareScanStatus(input.s3Key);
    if (scan === 'infected') {
      await setStatus({
        scanStatus: DocScanStatus.INFECTED,
        status: DocExtractStatus.FAILED,
        error: 'infected file',
      });
      return null;
    }
    if (scan === 'pending') {
      // GuardDuty hasn't finished scanning. Re-enqueue to re-poll, bounded.
      const attempt = input.scanAttempt ?? 0;
      if (input.rescheduleScan && attempt < MAX_SCAN_ATTEMPTS) {
        await setStatus({ status: DocExtractStatus.PENDING, error: 'malware scan in progress' });
        try {
          await input.rescheduleScan(scanPollDelayMs(attempt), attempt + 1);
        } catch (err) {
          // Re-enqueue failed (Redis hiccup) — settle at PENDING; a later
          // upload/sweep can re-drive it. Don't storm.
          console.warn(`[extract-core] scan re-poll enqueue failed: ${message(err)}`);
        }
        return null;
      }
      // Exhausted the poll budget — leave PENDING (not FAILED); a genuinely
      // slow/stuck scan is retryable, not a malicious verdict.
      await setStatus({
        scanStatus: DocScanStatus.FAILED,
        status: DocExtractStatus.PENDING,
        error: 'malware scan timed out',
      });
      return null;
    }
    if (scan === 'unavailable') {
      // Tag read failed / FAILED / ACCESS_DENIED / UNSUPPORTED — fail closed.
      await setStatus({
        scanStatus: DocScanStatus.FAILED,
        status: DocExtractStatus.PENDING,
        error: 'malware scan unavailable',
      });
      return null;
    }
    await setStatus({ scanStatus: DocScanStatus.CLEAN });
  } else {
    // Dev / local (MinIO, no GuardDuty): allow.
    await setStatus({ scanStatus: DocScanStatus.CLEAN });
  }

  // 2. Read the object bytes, never more than this document kind's cap. Only after the
  //    scan verdict: HEAD first (a missing or over-cap object is refused without a
  //    download), then a server-side read that stops at the cap + 1 whatever HEAD said.
  //    A HEAD or read that THROWS lands in the catch below as FAILED, exactly as a failed
  //    GET always has; it never falls back to an unmeasured download.
  const cap = extractionCapBytes(input.where);
  let bytes: Uint8Array;
  try {
    const got = await guardedRead(getStorage(), input.s3Key, cap);
    if (!got.ok) {
      // Permanent for this object: FAILED (a person can re-upload), not a retry.
      await setStatus({ status: DocExtractStatus.FAILED, error: refusedReadError(got, cap) });
      return null;
    }
    bytes = got.data;
  } catch (err) {
    await setStatus({ status: DocExtractStatus.FAILED, error: `download failed: ${message(err)}` });
    return null;
  }

  // 3. Normalize (HEIC→JPEG via sharp; passthrough for already-supported types).
  try {
    const normalized = await sharpNormalizer.normalize(bytes, input.contentType);
    await setStatus({ status: DocExtractStatus.EXTRACTING });
    return { data: normalized.data, mimeType: normalized.mimeType };
  } catch (err) {
    await setStatus({
      status: DocExtractStatus.FAILED,
      error: `normalize failed: ${message(err)}`,
    });
    return null;
  }
}

/**
 * Fetch + normalize a document WITHOUT touching its `DocumentExtraction` row.
 *
 * The joint determination (rule 2) has to read every document on an expense, but
 * it is not performing a per-document extraction — so it must not write that
 * column. `prepareExtraction` drives the satellite to EXTRACTING as its last act,
 * which is correct when a document is genuinely being extracted and wrong for a
 * file that finished days ago: re-preparing an already-EXTRACTED document parked
 * it at EXTRACTING forever, which kept the report page polling every 4 seconds and
 * left the expense editor locked, because both read that status.
 *
 * The malware gate is deliberately not re-run here either. GuardDuty's verdict on
 * an object does not change, so a document already recorded CLEAN has been
 * scanned; only a NEW file needs gating, and that is the caller's job to decide
 * (see `loadDocuments`). Returns null on a missing or over-cap object or a
 * download/normalize failure — one unreadable file must not sink a determination
 * the other documents can support.
 */
export async function fetchCleanDocument(input: {
  s3Key: string;
  contentType: string;
}): Promise<{ data: Uint8Array; mimeType: string } | null> {
  // Its only caller is the joint determination, which reads an expense's receipts, so the
  // receipt cap applies. A missing or over-cap object is logged and skipped, and no status
  // row is written: this function never owns one.
  const cap = RECEIPT_CAP_BYTES;
  try {
    const got = await guardedRead(getStorage(), input.s3Key, cap);
    if (!got.ok) {
      console.warn(
        `[extract-core] re-read of ${input.s3Key} skipped: ${refusedReadError(got, cap)}`,
      );
      return null;
    }
    const normalized = await sharpNormalizer.normalize(got.data, input.contentType);
    return { data: normalized.data, mimeType: normalized.mimeType };
  } catch (err) {
    console.warn(`[extract-core] re-read of ${input.s3Key} failed: ${message(err)}`);
    return null;
  }
}

/**
 * Minimum confidence at which a returned extraction still counts as one.
 *
 * The model is called with a FORCED tool call, so it always returns something — including
 * for an unreadable image, where it returns a shape with every field null and a confidence of
 * 0. That was written as `EXTRACTED`, so a 4000x4000 noise JPG got a green "Extracted" badge
 * and an "AI: 0%" chip (GA readiness report F10). Nothing downstream could tell "read the
 * receipt and is certain of nothing" from "there was nothing to read".
 */
const MIN_USEFUL_CONFIDENCE = 0.05;

/**
 * Did the model actually extract anything?
 *
 * Two independent tests, because either alone is escapable: a confidence floor catches the
 * model reporting its own failure, and the all-null check catches a confidently-returned
 * empty shape. The fields checked are the ones an expense cannot be filed without — vendor,
 * date, total — not every optional field on the schema.
 */
function extractionIsEmpty(result: ExtractResult): boolean {
  const d = result.data as { vendor?: unknown; date?: unknown; total?: unknown } | null;
  const noMaterialField = d != null && d.vendor == null && d.date == null && d.total == null;
  const belowFloor = result.confidence != null && result.confidence < MIN_USEFUL_CONFIDENCE;
  return noMaterialField || belowFloor;
}

/** Write the terminal state for a prepared extraction. `EXTRACTED` on success
 *  (with model + confidence + payload); PENDING when the API key is missing (so
 *  a later config can re-drive it); FAILED otherwise. Keyed by the satellite's
 *  unique FK, so the sync and batch paths finalize the same way. */
export async function finalizeExtraction(
  where: ExtractionKey,
  outcome:
    | { ok: true; result: ExtractResult }
    | { ok: false; unavailable?: boolean; error: string; pendingReason?: string },
): Promise<void> {
  const w = where as Prisma.DocumentExtractionWhereUniqueInput;
  if (outcome.ok && extractionIsEmpty(outcome.result)) {
    /**
     * A returned-but-empty extraction is a FAILURE, recorded as one.
     *
     * Fixing this in the UI alone would have left the stored status lying to every future
     * consumer; the badge is only the first thing that read it. The model and confidence are
     * still written, because "which model said it was sure of nothing" is worth keeping.
     */
    await db.documentExtraction.update({
      where: w,
      data: {
        status: DocExtractStatus.FAILED,
        model: outcome.result.model,
        confidence: outcome.result.confidence ?? null,
        data: outcome.result.data as unknown as Prisma.InputJsonValue,
        rawResponse: outcome.result.rawResponse as Prisma.InputJsonValue,
        error: 'the document could not be read: no vendor, date or total was extracted',
      },
    });
    return;
  }
  if (outcome.ok) {
    await db.documentExtraction.update({
      where: w,
      data: {
        status: DocExtractStatus.EXTRACTED,
        model: outcome.result.model,
        confidence: outcome.result.confidence ?? null,
        data: outcome.result.data as unknown as Prisma.InputJsonValue,
        rawResponse: outcome.result.rawResponse as Prisma.InputJsonValue,
        error: null,
      },
    });
    return;
  }
  await db.documentExtraction.update({
    where: w,
    data: {
      // No API key, or a transient provider failure with attempts left ⇒ PENDING
      // (retryable), not a hard failure. Only an exhausted or permanent one is FAILED.
      status: outcome.unavailable ? DocExtractStatus.PENDING : DocExtractStatus.FAILED,
      error: outcome.unavailable
        ? (outcome.pendingReason ?? 'extraction not configured')
        : outcome.error,
    },
  });
}

/**
 * The full sync pipeline: prepare → Claude-vision extract → finalize. Returns
 * the parsed extraction, or `null` when it bailed at any stage. Used for a
 * single receipt (one document = one synchronous message); bulk uploads go
 * through the Batch API path instead. NEVER throws on a business failure.
 */
export async function runDocumentExtraction(
  input: DocumentExtractionInput,
): Promise<ReceiptExtraction | null> {
  const prepared = await prepareExtraction(input);
  if (!prepared) return null;
  try {
    const result = await extractReceipt({
      data: prepared.data,
      mimeType: prepared.mimeType,
      categoryHints: input.categoryHints,
      ...(input.anthropic?.apiKey ? { apiKey: input.anthropic.apiKey } : {}),
      ...(input.anthropic?.model ? { model: input.anthropic.model } : {}),
    });
    // VeloExpense (d43): the call is recorded whatever it read — an empty reading cost the
    // same tokens as a full one.
    await recordExtractionUsage(input.where.receiptId, result);
    await finalizeExtraction(input.where, { ok: true, result });
    return result.data;
  } catch (err) {
    /**
     * A capacity blip is not a bad receipt, and only one of the two is worth a person.
     *
     * This used to record every failure the same way and return, which is why the daily-cap
     * outage on 31 August left two production receipts reading "Extraction failed" until
     * somebody raised the cap and re-ran them by hand. The handler is best-effort by design
     * — it never throws, so BullMQ never retried, so nothing self-healed.
     *
     * A TRANSIENT failure is now re-thrown, which hands it to the `integrations` queue's
     * existing policy: five attempts, exponential backoff from a minute out to an hour.
     * A cap that resets, or a provider that is briefly overloaded, clears on its own.
     *
     * The row is written FIRST and left PENDING rather than FAILED, so the badge says
     * "still working on it" instead of accusing the document — and if every attempt is
     * exhausted the last one lands as a real FAILED with the provider's own words.
     */
    const transient = isTransientExtractionFailure(err);
    const exhausted = input.isFinalAttempt?.() ?? false;
    await finalizeExtraction(input.where, {
      ok: false,
      unavailable: err instanceof ExtractionUnavailableError || (transient && !exhausted),
      error: message(err),
      ...(transient && !exhausted ? { pendingReason: message(err) } : {}),
    });
    if (transient && !exhausted) throw err;
    return null;
  }
}

/** The byte cap for the document an extraction key names: a receipt, or a card attachment.
 *  VeloExpense: always a receipt (see `ExtractionKey`). */
function extractionCapBytes(_where: ExtractionKey): number {
  return RECEIPT_CAP_BYTES;
}

/**
 * VeloExpense (d43): one `ai_usage` row for a model call, from the response's own token
 * counts. Included, not metered: receipt reading is part of every plan. Best-effort as
 * VeloLedger's gateway is — a usage write never fails the reading — but logged, because a
 * dropped row under-counts with no other trace. The request id is the model's message id
 * where the response carries one, so a row can be matched to the provider's own record.
 */
export async function recordExtractionUsage(
  receiptId: string | null,
  result: { model: string; rawResponse: unknown },
  opts: { feature?: AiFeature; batch?: boolean } = {},
): Promise<void> {
  const usage = usageOf(result.rawResponse);
  if (!usage) return;
  const messageId = (result.rawResponse as { id?: unknown } | null)?.id;
  try {
    await recordUsage(db, {
      feature: opts.feature ?? 'receipt_extraction',
      model: result.model,
      ...usage,
      requestId: typeof messageId === 'string' ? messageId : randomUUID(),
      receiptId,
      batch: opts.batch,
    });
  } catch (err) {
    console.error(`[extract-core] failed to record AI usage for receipt ${receiptId}: ${message(err)}`);
  }
}

/**
 * Why a bounded read handed back no bytes, in the words `DocumentExtraction.error` and the
 * worker log use. Built only from the numbers: never a URL, a bucket name or a response body.
 *
 * - HEAD reported the size: name it and the cap.
 * - The read overflowed while streaming (no size known): name the cap.
 * - The object is not there: say so, and not "too large".
 */
function refusedReadError(got: Exclude<BoundedRead, { ok: true }>, capBytes: number): string {
  if (got.reason === 'missing') return 'download failed: object not found';
  return got.size === undefined
    ? `file too large: more than the ${capBytes}-byte limit`
    : `file too large: ${got.size} bytes, over the ${capBytes}-byte limit`;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

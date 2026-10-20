/**
 * Filing the files a proposal was confirmed for.
 *
 * The press creates the report and its blank expenses and hands back one presigned PUT per
 * file. The bytes then go from this browser straight to S3 — they never pass through the
 * model, and they were never sent to our server either.
 *
 * Everything here takes its dependencies as arguments. The alternative is a hook that can
 * only be tested by rendering something, and the part worth testing hardest is the pairing
 * rule below, which has nothing to do with React.
 */

/** One upload slot, as `expenses.startFromReceipts` / `addReceiptExpenses` return it. */
export interface UploadSlot {
  readonly expenseId: string;
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/** A slot matched to the bytes it was created for. */
export interface PairedUpload {
  readonly slot: UploadSlot;
  readonly file: File;
}

export interface Pairing {
  readonly paired: readonly PairedUpload[];
  /** Slots we hold no bytes for — the model asked for a file that was not staged. */
  readonly unmatchedSlots: readonly UploadSlot[];
  /** Staged files no slot was created for — the model dropped one from its list. */
  readonly unmatchedFiles: readonly File[];
}

/**
 * Pair each slot with the staged file it belongs to.
 *
 * Matched on filename + content type, first match consumed. **Not by index:** the slots come
 * back in the order the MODEL listed the files, and it can reorder or drop one. Uploading by
 * position would then PUT the restaurant bill to the slot presigned for the taxi — the wrong
 * receipt on the wrong expense, with extraction confidently filling in the wrong merchant.
 * (The presigned URL pins Content-Type, so a mismatched pair often fails at S3 as well; that
 * is a backstop, not the reason.)
 *
 * Two staged files sharing a name and type are told apart by nothing we hold here, so either
 * assignment is equally right: both get uploaded, each to its own expense.
 *
 * Anything left over on either side is REPORTED rather than guessed at. A slot with no bytes
 * is an expense that will sit blank; a file with no slot is a receipt the person believes
 * they filed. Both need saying out loud.
 */
export function pairUploads(slots: readonly UploadSlot[], files: readonly File[]): Pairing {
  const remaining = [...files];
  const paired: PairedUpload[] = [];
  const unmatchedSlots: UploadSlot[] = [];
  const typeOf = (f: File) => f.type || 'application/octet-stream';

  for (const slot of slots) {
    const i = remaining.findIndex(
      (f) => f.name === slot.filename && typeOf(f) === slot.contentType,
    );
    if (i < 0) {
      unmatchedSlots.push(slot);
      continue;
    }
    paired.push({ slot, file: remaining[i] as File });
    remaining.splice(i, 1);
  }

  return { paired, unmatchedSlots, unmatchedFiles: remaining };
}

export interface UploadDeps {
  /** PUT the bytes. Injected so a test needs no network. */
  put: (slot: UploadSlot, file: File) => Promise<boolean>;
  /**
   * `expenses.receiptUploadUrl` for the same expense, filename and type, bound to `file.size`.
   *
   * Every link is signed for one exact byte length, and on this path that length is the one
   * the MODEL copied into its tool call. A digit copied wrong means storage refuses the PUT
   * (and stores nothing), so a failed PUT gets one fresh link sized from the File itself.
   * Returns the slot to retry against — a new key, which is the one that gets registered.
   */
  reissue: (slot: UploadSlot, file: File) => Promise<UploadSlot>;
  /** `expenses.receiptCreate`, deferring extraction so the batch goes at once. */
  register: (input: {
    expenseId: string;
    key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }) => Promise<{ id: string }>;
  /** `expenses.startExtraction` for the whole batch. */
  extract: (receiptIds: string[]) => Promise<unknown>;
  onProgress?: (done: number, total: number) => void;
}

export interface UploadReport {
  readonly filed: number;
  readonly failed: number;
  /** Slots or files that could not be paired — reported, never guessed at. */
  readonly mismatched: number;
  /**
   * Files filed only after their first PUT failed and a reissued link took them. Counted in
   * `filed` too. A retry can't tell a size the model copied wrong from an expired link or a
   * network blip, so this is the number to watch: steadily above zero means the sizes the
   * model hands back are not to be trusted.
   */
  readonly retried: number;
}

/**
 * Upload and file every paired slot.
 *
 * A failed PUT is retried once, on a link reissued for the File's real size (see `reissue`);
 * only a second failure, or a reissue that itself fails, counts as `failed`.
 *
 * One failure does not abandon the rest: the report and its expenses exist either way, and a
 * receipt that did not land is visible and re-uploadable in the workbench. The batch is
 * extracted in a single call at the end so more than five files take the cheaper Batch API
 * path rather than one synchronous model call each.
 */
export async function runReceiptUploads(
  slots: readonly UploadSlot[],
  files: readonly File[],
  deps: UploadDeps,
): Promise<UploadReport> {
  const { paired, unmatchedSlots, unmatchedFiles } = pairUploads(slots, files);
  const receiptIds: string[] = [];
  let failed = 0;
  let retried = 0;
  let done = 0;

  // A PUT that rejects (a cross-origin refusal can surface as a network error rather than a
  // status) is a failed PUT like any other, so it gets the retry too.
  const putOk = async (slot: UploadSlot, file: File) => {
    try {
      return await deps.put(slot, file);
    } catch {
      return false;
    }
  };

  for (const { slot, file } of paired) {
    try {
      let target = slot;
      const firstOk = await putOk(target, file);
      if (!firstOk) {
        target = await deps.reissue(slot, file);
        if (!(await putOk(target, file))) throw new Error('upload failed');
      }
      const { id } = await deps.register({
        expenseId: target.expenseId,
        key: target.key,
        filename: target.filename,
        contentType: target.contentType,
        sizeBytes: file.size,
      });
      receiptIds.push(id);
      if (!firstOk) retried += 1;
    } catch {
      failed += 1;
    }
    done += 1;
    deps.onProgress?.(done, paired.length);
  }

  if (receiptIds.length > 0) {
    try {
      await deps.extract(receiptIds);
    } catch {
      // Best-effort, matching the contract everywhere else: the receipts are filed and
      // visible, and an expense can be filled in by hand or re-extracted.
    }
  }

  return {
    filed: receiptIds.length,
    failed,
    mismatched: unmatchedSlots.length + unmatchedFiles.length,
    retried,
  };
}

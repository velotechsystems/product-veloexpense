/**
 * f19 — a receipt's view link is signed only once its malware scan is CLEAN.
 *
 * ExpenseOS gates the receipt VIEWER on the scan (`scanCleared` in the workbench's
 * parts.tsx: "the file is safe to render once the AV scan is CLEAN; a missing extraction
 * row means the scan hasn't run yet — treat as not-cleared"). It still signs the URL and
 * sends it to the browser, so anyone reading the response (or a screen that forgets the
 * gate, like the approver's receipt link) can open bytes nobody has scanned.
 *
 * VeloExpense: the same rule, moved to the server. No CLEAN verdict, no link:
 *   - CLEAN                                 → a presigned GET;
 *   - PENDING / SCANNING / INFECTED / FAILED → null;
 *   - no extraction row (the worker hasn't reported yet, or a legacy upload it never
 *     saw)                                  → null, as ExpenseOS's viewer treats it.
 *
 * The worker writes CLEAN after GuardDuty's tag says NO_THREATS_FOUND, or straight away
 * where scanning is off (dev/local, `SCAN_ENABLED` false) — so nothing here changes
 * what a dev environment with a running worker shows.
 */
import { getStorage, type DownloadOptions, type Storage } from '@/lib/storage';

export const SCAN_CLEAN = 'CLEAN';

export function scanIsClean(scanStatus: string | null | undefined): boolean {
  return scanStatus === SCAN_CLEAN;
}

/** The presigned GET for a receipt, or null while its scan is not CLEAN. */
export async function receiptViewUrl(
  s3Key: string,
  scanStatus: string | null | undefined,
  options: { filename?: string; download?: DownloadOptions; storage?: Storage } = {},
): Promise<string | null> {
  if (!scanIsClean(scanStatus)) return null;
  const storage = options.storage ?? getStorage();
  return storage.presignDownload(s3Key, options.filename, options.download);
}

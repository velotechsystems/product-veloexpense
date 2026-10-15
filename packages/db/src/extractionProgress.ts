// VeloExpense: the enum types from this package's text enums (`./enums`), and the tenant's
// client type, where ExpenseOS imports both from `@prisma/client`.
import type { TenantDb } from '@/lib/db/prisma';
import type { DocExtractStatus, DocScanStatus } from './enums';

/**
 * Is a receipt's reading still in progress — and should that hold the report?
 *
 * A late extraction result rewrites an expense's amounts. Before #506 it did so on a
 * report an approver had already read; #506 made the late write refuse on a non-editable
 * report, which kept the approver honest and threw the reading away. The owner's call is
 * that the submit should WAIT instead: a receipt that is still being read holds the
 * report in draft until its amounts are in, and the submitter is told what it is waiting
 * for. This module is that rule, shared by the refusal in `expenses.submit`, the
 * disclosure the workbench renders before the press, and the worker's emailed-receipts
 * summary (which waits for the same "settled" before it states a total), so none of them
 * can disagree. It lives here rather than in `apps/web` because the worker cannot import
 * from the web app.
 *
 * "In flight" mirrors what the workbench already polls on (`hasPendingExtractionIn`):
 *  · the malware scan has not returned (`scanStatus` PENDING / SCANNING) — the row is
 *    re-polled on a schedule and every re-poll touches `updatedAt`;
 *  · the model is reading it (`status` EXTRACTING);
 *  · it is queued and nothing has been attempted (`status` PENDING with no `error`).
 * PENDING *with* an error is the worker's way of parking a row it will not finish on its
 * own — "extraction not configured", "malware scan timed out" — and those never block:
 * the no-API-key contract is that a receipt still uploads, previews and can be typed over.
 */
export interface ExtractionProgressRow {
  scanStatus: DocScanStatus;
  status: DocExtractStatus;
  error: string | null;
  updatedAt: Date;
}

/**
 * How long a row may sit in an in-flight state, untouched, before it stops holding the
 * report. Fifteen minutes, for the same reason the NetSuite sweep rescues a PROCESSING
 * row after fifteen (`PROCESSING_STALE_MS`): far longer than a healthy step and short
 * enough that a lost job does not lock somebody out of submitting for an afternoon.
 *
 * Measured from `updatedAt`, which the worker writes at every transition — SCANNING, each
 * scan re-poll (≤ 20 s apart across the ~5-minute scan budget), CLEAN, EXTRACTING — so a
 * pipeline that is genuinely progressing never goes fifteen minutes silent. The one path
 * that can is the Batch API (poll cap ~1 h, rows parked at EXTRACTING throughout): a batch
 * slower than this releases the submit, and its late result is then refused by the
 * editable-report guard from #506 — the bounded trade-off, chosen over holding a report
 * for up to an hour on a job that may never come back.
 */
export const EXTRACTION_IN_FLIGHT_MAX_MS = 15 * 60_000;

export type ExtractionProgress = 'inFlight' | 'stale' | 'settled';

export function classifyExtraction(
  row: ExtractionProgressRow,
  now = new Date(),
): ExtractionProgress {
  const running =
    row.scanStatus === 'PENDING' ||
    row.scanStatus === 'SCANNING' ||
    row.status === 'EXTRACTING' ||
    (row.status === 'PENDING' && !row.error);
  if (!running) return 'settled';
  return now.getTime() - row.updatedAt.getTime() > EXTRACTION_IN_FLIGHT_MAX_MS
    ? 'stale'
    : 'inFlight';
}

export interface ExtractionProgressSummary {
  /** Receipts still being read — these hold the submit. */
  inFlight: number;
  /** Receipts that look in flight but have not been touched for `EXTRACTION_IN_FLIGHT_MAX_MS`.
   *  They no longer hold the submit; the workbench says so, because their amounts were
   *  never read and somebody has to check them by hand. */
  stale: number;
}

export function summarizeExtractionProgress(
  rows: readonly (ExtractionProgressRow | null | undefined)[],
  now = new Date(),
): ExtractionProgressSummary {
  const out: ExtractionProgressSummary = { inFlight: 0, stale: 0 };
  for (const row of rows) {
    if (!row) continue;
    const state = classifyExtraction(row, now);
    if (state === 'inFlight') out.inFlight += 1;
    else if (state === 'stale') out.stale += 1;
  }
  return out;
}

/** The summary for every receipt on a report, read fresh — what `submit` decides on.
 *
 *  VeloExpense: on VeloExpense's `document_extraction` (0056, w3-01), through the tenant's
 *  client; its statuses are text under a CHECK, read here as ExpenseOS's enum types. */
export async function reportExtractionProgress(
  db: Pick<TenantDb, 'documentExtraction'>,
  reportId: string,
  now = new Date(),
): Promise<ExtractionProgressSummary> {
  const rows = await db.documentExtraction.findMany({
    // VeloExpense: STORED receipts only, as the report detail reads them
    // (`EXPENSE_DETAIL_INCLUDE`), so the screen's count and this refusal's agree.
    where: { receipt: { status: 'STORED', expense: { reportId } } },
    select: { scanStatus: true, status: true, error: true, updatedAt: true },
  });
  return summarizeExtractionProgress(
    rows.map((r) => ({
      ...r,
      scanStatus: r.scanStatus as DocScanStatus,
      status: r.status as DocExtractStatus,
    })),
    now,
  );
}

/**
 * Byte caps for uploaded documents.
 *
 * VeloExpense: ExpenseOS's `@expenseos/storage/limits` (Wave 2, w2-09), the two caps the
 * ported receipt procedures read. ExpenseOS's comment, for the shared part:
 *
 * The values are fixed in code by operator decision (2026-09-28): not admin-configurable,
 * no `PlatformConfig` column.
 *
 * Not ported: the card-transaction attachment, card statement and inbound mail caps —
 * VeloExpense has none of those features. The old receipt drawer's own cap
 * (`lib/receipts/constants.ts`, 20 MB) stays until the drawer is replaced (w2-02).
 */

/**
 * The absolute ceiling for anything uploaded through a presigned link: 25 MiB.
 *
 * `presignUpload` refuses to sign a length above it, whoever the caller is, and every
 * uploaded-document cap below must be at or under it.
 */
export const UPLOAD_CEILING_BYTES = 25 * 1024 * 1024;

/** A receipt or invoice on an expense: 10 MiB. */
export const RECEIPT_CAP_BYTES = 10 * 1024 * 1024;

if (RECEIPT_CAP_BYTES > UPLOAD_CEILING_BYTES) {
  throw new Error(`RECEIPT_CAP_BYTES (${RECEIPT_CAP_BYTES}) exceeds UPLOAD_CEILING_BYTES (${UPLOAD_CEILING_BYTES})`);
}

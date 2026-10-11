/**
 * Byte caps for uploaded documents.
 *
 * VeloExpense: ExpenseOS's `@expenseos/storage/limits` (Wave 2, w2-09), the two caps the
 * ported receipt procedures read. ExpenseOS's comment, for the shared part:
 *
 * The values are fixed in code by operator decision (2026-09-28): not admin-configurable,
 * no `PlatformConfig` column.
 *
 * Not ported: the card-transaction attachment and card statement caps — VeloExpense has
 * neither feature. The inbound mail cap arrived with emailed receipts (w3-06). The old receipt drawer's own cap
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

/**
 * The raw MIME object the inbound mail service stores for one receipt e-mail: 40 MiB.
 *
 * A worker READ cap, not an upload cap. Nobody uploads this object through a presigned link,
 * so it is deliberately NOT bound by {@link UPLOAD_CEILING_BYTES}. 40 MiB is believed to be
 * the largest message the inbound mail service delivers, so no mail filed today stops being
 * filed (operator, 2026-09-28). The per-attachment limit applied after parsing is a separate
 * number that lives with the e-mail handler.
 *
 * VeloExpense (w3-06): ExpenseOS's, as written.
 */
export const INBOUND_MAIL_CAP_BYTES = 40 * 1024 * 1024;

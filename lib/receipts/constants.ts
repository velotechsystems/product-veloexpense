/**
 * VX1-5/VX1-6 — receipt constants, split out of the service so the browser can
 * import them. lib/receipts/service.ts pulls in pg and node:crypto; the upload
 * drawer is a client component and must not drag either into the bundle.
 * The service re-exports these, so its public API is unchanged.
 */

/**
 * What a receipt may be.
 *
 * UD-9 lists this as a hand-kept correspondence, on the strength of the comment
 * that used to be here: *"kept in step with the UI's file-picker accept list"*.
 * It is not one, and has not been since VX1-6 — `RECEIPT_ACCEPT` below is DERIVED
 * from this list and the drawer imports it, so there is nothing to keep in step.
 *
 * The comment is replaced rather than deleted because a stale promise is worse
 * than none: it tells the next reader a copy exists to maintain, which is an
 * invitation to create one.
 */
export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export const MAX_RECEIPT_BYTES = 20 * 1024 * 1024; // 20 MB

/** For <input type="file" accept="..."> */
export const RECEIPT_ACCEPT = ALLOWED_CONTENT_TYPES.join(',');

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

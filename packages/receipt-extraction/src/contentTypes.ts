/**
 * What a receipt document may be.
 *
 * Canonical here because this package is what READS these files: the vision extractor accepts
 * images and PDFs, and HEIC/HEIF only because the pipeline normalises them first. A list kept
 * anywhere else drifts from what can actually be processed, and the failure is quiet — the
 * file uploads, stores, scans, and then never extracts.
 */

export const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

/** Membership test that narrows, for callers holding an arbitrary string. */
export function isReceiptContentType(value: string): value is ReceiptContentType {
  return (RECEIPT_CONTENT_TYPES as readonly string[]).includes(value);
}

/** The `accept` attribute for a receipt file input. */
export const RECEIPT_ACCEPT = RECEIPT_CONTENT_TYPES.join(',');

/** Extension for an object key, from a filename that may not carry one. */
export function receiptExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'bin';
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : 'bin';
}

/**
 * Files somebody attached to a turn, and how the transcript describes them.
 *
 * The model is told what was attached and never shown what is in it. That is not a
 * limitation being worked around — it is the ruling. Receipts are read by the extraction
 * pipeline, behind a malware-scan gate, by a prompt that knows about categories and tax;
 * a second reader looking at pixels in the chat would produce figures the system prompt
 * forbids it from stating, and would disagree with the first one about somebody's money.
 *
 * So what lands in the transcript is a plain-text notice: names, exact types, exact sizes.
 * A text block rather than a bespoke shape, because the Messages API replays it unchanged
 * and the panel can render it beside the person's own words without special handling.
 */

/** One attached file, as the browser describes it before anything is uploaded. */
export interface AttachedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * What a receipt may be.
 *
 * A second copy of the list `expenses.ts` enforces, and deliberately not shared with it:
 * this one exists so the file picker can filter and the panel can refuse early, while the
 * server's copy is the one that decides. A drift here shows up as a file the picker offered
 * and the server rejected — annoying, and visible. Sharing them would mean the router
 * importing the assistant package or the assistant package owning a storage concern.
 */
export const RECEIPT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

/** The `accept` attribute for a receipt file input. */
export const RECEIPT_ACCEPT = RECEIPT_CONTENT_TYPES.join(',');

/** Matches `MAX_RECEIPT_BYTES` in the expenses router. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * How many files one turn may carry.
 *
 * Lower than the 50 the procedures accept, because these are held in the browser until the
 * press: 50 × 10MB is half a gigabyte in a tab somebody left open.
 */
export const MAX_ATTACHMENTS_PER_TURN = 20;

/** Why this file cannot be attached, or null. */
export type AttachmentRejection = 'type' | 'size';

export function rejectAttachment(file: AttachedFile): AttachmentRejection | null {
  if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(file.contentType)) return 'type';
  if (file.sizeBytes > MAX_ATTACHMENT_BYTES) return 'size';
  return null;
}

/**
 * The notice appended to the person's message.
 *
 * **Sizes are exact byte counts, not "2.3 MB".** The model has to copy them into the tool
 * call, and a rounded figure is one it cannot reconstruct — it would either invent a number
 * or leave the field out, and both fail validation at the procedure. The human-readable form
 * belongs in the panel, which has the real `File` objects.
 */
export function attachmentNotice(files: readonly AttachedFile[], locale: 'en' | 'fr-CA'): string {
  const list = files
    .map((f) => `${f.filename} — ${f.contentType}, ${f.sizeBytes} bytes`)
    .join('\n');
  return locale === 'fr-CA'
    ? `Fichiers joints (dont vous ne voyez pas le contenu) :\n${list}`
    : `Attached files (you cannot see inside them):\n${list}`;
}

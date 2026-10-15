/**
 * A receipt image, generated rather than committed.
 *
 * Both the expense lifecycle and the card-operations specs need a real image to attach:
 * every seeded expense category inherits `receiptRequired`, so a report with no receipt
 * carries a BLOCKING policy violation and cannot be submitted at all. Without one, neither
 * spec gets past its first step.
 *
 * It used to be `e2e/fixtures/receipt.png` on disk — and `.gitignore` has a blanket
 * `*.png`, so the file was never tracked. The specs passed on the machine that created it
 * and would have failed on a fresh clone and in the nightly CI job, with "file not found"
 * pointing at the attach step rather than at the missing fixture. The same trap the
 * card-profile workbook fixture avoids by generating itself.
 *
 * Bytes rather than a path, so there is nothing to lose: `setInputFiles` accepts an
 * in-memory file, and Playwright hands the browser exactly these bytes.
 */

/** The smallest thing that is unambiguously a PNG: 1×1, white, 70 bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A receipt in the shape `setInputFiles` takes. Named so the UI can be asserted on it. */
export function receiptFile(name = 'receipt.png') {
  return { name, mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') };
}

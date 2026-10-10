import { describe, expect, it } from 'vitest';
import { RECEIPT_CAP_BYTES, UPLOAD_CEILING_BYTES } from './limits';

/**
 * The byte caps, pinned as literals.
 *
 * Operator decisions (2026-09-28), fixed in code: a change to any of these numbers should be
 * a deliberate edit to this file too, not a side effect of editing `limits.ts`.
 *
 * VeloExpense: ExpenseOS's `limits.test.ts`, for the two caps ported (see `limits.ts`).
 */
describe('byte caps', () => {
  it('pins each uploaded-document cap and the ceiling', () => {
    expect(RECEIPT_CAP_BYTES).toBe(10_485_760);
    expect(UPLOAD_CEILING_BYTES).toBe(26_214_400);
  });

  it('keeps every uploaded-document cap at or under the 25 MiB ceiling', () => {
    for (const cap of [RECEIPT_CAP_BYTES]) {
      expect(cap).toBeLessThanOrEqual(26_214_400);
    }
  });
});

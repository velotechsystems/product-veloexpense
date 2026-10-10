import { describe, expect, it } from 'vitest';
import { isReceiptDrag, RECEIPT_DRAG_TYPE, readReceiptDrag, setReceiptDrag } from './receiptDrag';

/**
 * The drag contract, which is the part that can silently break: the source and the
 * drop target live in different panes and never share React state, so they agree
 * only through this module. A typo in the MIME type would make every drop a no-op
 * with nothing to see in the console.
 */

/** Enough of DataTransfer for the contract — jsdom does not implement drag events. */
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => {
      // Browsers lowercase the type; mirroring that is what makes the `types` check
      // in `isReceiptDrag` meaningful here.
      store.set(type.toLowerCase(), value);
    },
    getData: (type: string) => store.get(type.toLowerCase()) ?? '',
    get types() {
      return [...store.keys()];
    },
    effectAllowed: 'none',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

const PAYLOAD = { receiptId: 'r-1', fromExpenseId: 'e-1', filename: 'bill.pdf' };

describe('receipt drag contract', () => {
  it('round-trips the payload', () => {
    const dt = fakeDataTransfer();
    setReceiptDrag(dt, PAYLOAD);
    expect(readReceiptDrag(dt)).toEqual(PAYLOAD);
  });

  it('is recognisable mid-drag, when values are unreadable but types are not', () => {
    const dt = fakeDataTransfer();
    setReceiptDrag(dt, PAYLOAD);
    expect(isReceiptDrag(dt)).toBe(true);
  });

  it('uses a lowercase MIME type, because browsers normalise it', () => {
    expect(RECEIPT_DRAG_TYPE).toBe(RECEIPT_DRAG_TYPE.toLowerCase());
  });

  it('carries a plain-text fallback, so a drop outside the app yields the filename', () => {
    const dt = fakeDataTransfer();
    setReceiptDrag(dt, PAYLOAD);
    expect(dt.getData('text/plain')).toBe('bill.pdf');
  });

  it('marks the drag as a move', () => {
    const dt = fakeDataTransfer();
    setReceiptDrag(dt, PAYLOAD);
    expect(dt.effectAllowed).toBe('move');
  });

  it('ignores a drag that is not ours — a file from the desktop, say', () => {
    const dt = fakeDataTransfer();
    dt.setData('text/plain', 'hello');
    expect(isReceiptDrag(dt)).toBe(false);
    expect(readReceiptDrag(dt)).toBeNull();
  });

  it('ignores unreadable JSON rather than throwing mid-drop', () => {
    const dt = fakeDataTransfer();
    dt.setData(RECEIPT_DRAG_TYPE, '{not json');
    expect(readReceiptDrag(dt)).toBeNull();
  });

  it('rejects a payload missing the ids the move needs', () => {
    const dt = fakeDataTransfer();
    dt.setData(RECEIPT_DRAG_TYPE, JSON.stringify({ filename: 'orphan.pdf' }));
    expect(readReceiptDrag(dt)).toBeNull();
  });

  it('tolerates a missing filename, which is cosmetic', () => {
    const dt = fakeDataTransfer();
    dt.setData(RECEIPT_DRAG_TYPE, JSON.stringify({ receiptId: 'r', fromExpenseId: 'e' }));
    expect(readReceiptDrag(dt)).toEqual({ receiptId: 'r', fromExpenseId: 'e', filename: '' });
  });

  it('is false for a null dataTransfer', () => {
    expect(isReceiptDrag(null)).toBe(false);
    expect(readReceiptDrag(null)).toBeNull();
  });
});

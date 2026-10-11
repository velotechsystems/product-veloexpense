import { describe, expect, it } from 'vitest';
import { reconcileLineItems } from './lineReconcile';
import type { ReceiptExtraction } from './schema';

/**
 * Whether a document's line items are purchases, or purchases plus tax.
 *
 * The case that prompted this is `docs/samples/FOLIODETE_20250714061449.pdf`, a Hampton
 * Inn folio. Its numbers appear verbatim below, because the point is not that the logic
 * is plausible — it is that it produces the right answer on the document that exposed
 * the problem.
 */

const cents = (n: number) => BigInt(Math.round(n * 100));

const ex = (over: Partial<ReceiptExtraction>): ReceiptExtraction =>
  ({
    vendor: null,
    address: null,
    date: null,
    time: null,
    transactionId: null,
    currencyCode: 'USD',
    total: null,
    subtotal: null,
    taxGstHst: null,
    taxQst: null,
    taxPst: null,
    mandatoryGratuity: null,
    voluntaryTip: null,
    lineItems: [],
    derivedCategoryCode: null,
    confidence: 0.95,
    ...over,
  }) as ReceiptExtraction;

const line = (description: string, amount: number, categoryCode: string | null = null) => ({
  description,
  amount,
  quantity: 1,
  categoryCode,
});

describe('reconcileLineItems', () => {
  it('refuses per-line categories on the Hampton Inn folio', () => {
    /**
     * The real document. Five rows summing to 346.61 — which is the TOTAL, not the
     * 299.00 subtotal — because four of them are tax and a fee:
     *   Guest Room 299.00 · Occupancy Tax 2.00 · Javits Center Fee 1.50 ·
     *   City Tax 17.57 · State Tax 26.54
     */
    const r = reconcileLineItems(
      ex({
        subtotal: 299,
        total: 346.61,
        lineItems: [
          line('Guest Room', 299, 'cat-lodging'),
          line('Occupancy Tax', 2, 'cat-lodging'),
          line('Javits Center Fee', 1.5, 'cat-lodging'),
          line('City Tax', 17.57, 'cat-lodging'),
          line('State Tax', 26.54, 'cat-lodging'),
        ],
      }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: false, matched: 'total' });
  });

  it('still refuses when the model scatters the tax rows across categories', () => {
    // The failure the folio ONLY avoided by luck: had "City Tax" been coded
    // Miscellaneous, a $17.57 miscellaneous expense would have appeared for a tax.
    // The verdict must not depend on how the rows were labelled.
    const r = reconcileLineItems(
      ex({
        subtotal: 299,
        total: 346.61,
        lineItems: [
          line('Guest Room', 299, 'cat-lodging'),
          line('Occupancy Tax', 2, 'cat-misc'),
          line('Javits Center Fee', 1.5, 'cat-misc'),
          line('City Tax', 17.57, 'cat-misc'),
          line('State Tax', 26.54, 'cat-misc'),
        ],
      }),
      cents,
    );
    expect(r.trustPerLine).toBe(false);
  });

  it('trusts per-line categories when the lines are pre-tax purchases', () => {
    // A Canadian restaurant bill done properly: lines sum to the subtotal and the tax
    // sits in its own field. Here a per-line category is real information — a bill with
    // a meal and a parking charge should produce two differently-coded lines.
    const r = reconcileLineItems(
      ex({
        subtotal: 100,
        total: 115,
        taxGstHst: 5,
        taxQst: 10,
        lineItems: [line('Dinner', 80, 'cat-meals'), line('Parking', 20, 'cat-ground')],
      }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: true, matched: 'subtotal' });
  });

  it('trusts them on a tax-free receipt, where subtotal equals total', () => {
    // Both figures match; the permissive-and-correct reading has to win, which is why
    // subtotal is checked first rather than total.
    const r = reconcileLineItems(
      ex({
        subtotal: 50,
        total: 50,
        lineItems: [line('Book', 30, 'cat-misc'), line('Pen', 20, 'cat-misc')],
      }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: true, matched: 'subtotal' });
  });

  it('absorbs per-line rounding', () => {
    // 33.33 × 3 = 99.99 against a stated 100.00 subtotal. Three lines, so three minor
    // units of slack are legitimate.
    const r = reconcileLineItems(
      ex({
        subtotal: 100,
        total: 100,
        lineItems: [line('A', 33.33), line('B', 33.33), line('C', 33.33)],
      }),
      cents,
    );
    expect(r.trustPerLine).toBe(true);
  });

  it('does not let a genuinely different figure slip through as rounding', () => {
    // 3 lines buys 4 minor units of tolerance, not 40.
    const r = reconcileLineItems(
      ex({
        subtotal: 100,
        total: 140,
        lineItems: [line('A', 33.33), line('B', 33.33), line('C', 33.73)],
      }),
      cents,
    );
    expect(r.matched).not.toBe('subtotal');
  });

  it('refuses when the lines reconcile to neither figure', () => {
    // The model dropped a row, or invented one. Their categories are not evidence of
    // anything, and the caller falls back to a single line carrying the document total.
    const r = reconcileLineItems(
      ex({ subtotal: 200, total: 230, lineItems: [line('A', 50), line('B', 20)] }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: false, matched: 'neither' });
  });

  it('refuses with fewer than two priced lines, where there is nothing to split', () => {
    expect(reconcileLineItems(ex({ subtotal: 10, total: 10, lineItems: [] }), cents)).toEqual({
      trustPerLine: false,
      matched: 'neither',
    });
    expect(
      reconcileLineItems(ex({ subtotal: 10, total: 10, lineItems: [line('One', 10)] }), cents)
        .trustPerLine,
    ).toBe(false);
  });

  it('ignores a negative settlement row when summing', () => {
    // A folio prints its card payment as a negative row — `VS *2938 ($346.61)`. Counting
    // it would make the lines sum to zero and match nothing.
    const r = reconcileLineItems(
      ex({
        subtotal: 100,
        total: 115,
        lineItems: [
          line('Dinner', 80, 'cat-meals'),
          line('Parking', 20, 'cat-ground'),
          line('VISA payment', -115),
        ],
      }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: true, matched: 'subtotal' });
  });

  it('refuses when there is no subtotal to reconcile against', () => {
    // Plenty of receipts print only a total. Without a subtotal there is no way to tell
    // a purchase row from a tax row, so the safe reading applies.
    const r = reconcileLineItems(
      ex({ subtotal: null, total: 115, lineItems: [line('A', 100), line('Tax', 15)] }),
      cents,
    );
    expect(r).toEqual({ trustPerLine: false, matched: 'total' });
  });

  it('handles a zero-exponent currency', () => {
    // JPY has no minor units, so the tolerance is in whole yen. Nothing may assume 2dp.
    const yen = (n: number) => BigInt(Math.round(n));
    const r = reconcileLineItems(
      ex({
        currencyCode: 'JPY',
        subtotal: 3000,
        total: 3300,
        lineItems: [line('Ramen', 2000), line('Beer', 1000)],
      }),
      yen,
    );
    expect(r).toEqual({ trustPerLine: true, matched: 'subtotal' });
  });
});

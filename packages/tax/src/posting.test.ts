import { describe, expect, it } from 'vitest';
import { composePosting, convertComposition } from './posting';
import { allocateProportional } from './recoverable';

/** A line at a given amount and ITC rates. */
const line = (ref: string, amountMinor: bigint, itc = 100, itcQst = itc) => ({
  ref,
  amountMinor,
  itcGstHstRate: itc,
  itcQstRate: itcQst,
});

const sum = (values: bigint[]) => values.reduce((a, v) => a + v, 0n);

describe('allocateProportional', () => {
  it('splits exactly and gives the residual to the largest weight', () => {
    const parts = allocateProportional(100n, [1n, 1n, 1n]);
    expect(sum(parts)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
  });

  it('splits a NEGATIVE total exactly — a refund reverses, it does not vanish', () => {
    const parts = allocateProportional(-101n, [1n, 1n]);
    expect(sum(parts)).toBe(-101n);
  });

  it('splits across negative weights instead of zeroing them', () => {
    // A refund line among charges: the sum is still non-zero, so the tax splits.
    const parts = allocateProportional(-100n, [-600n, -400n]);
    expect(sum(parts)).toBe(-100n);
  });

  it('returns zeros only when the weights cancel out', () => {
    expect(allocateProportional(100n, [0n, 0n])).toEqual([0n, 0n]);
  });
});

describe('composePosting', () => {
  it('composes a Canadian meal: half the GST recoverable, the rest capitalised', () => {
    // $113.00 gross, $13.00 HST, one meal line at 50% ITC.
    const out = composePosting({
      grossMinor: 11300n,
      gstHstMinor: 1300n,
      qstMinor: 0n,
      lines: [line('meal', 11300n, 50)],
      entityRecovers: true,
    });
    expect(out.taxLines).toEqual([{ kind: 'GST_HST', amountMinor: 650n }]);
    expect(out.expenseLines[0].capitalisedTaxMinor).toBe(650n);
    expect(out.expenseLines[0].netMinor).toBe(10000n);
    expect(out.expenseLines[0].amountMinor).toBe(10650n);
    expect(out.totalMinor).toBe(11300n);
  });

  it('capitalises everything and posts NO tax line for a US entity (rules 3 + 6)', () => {
    const out = composePosting({
      grossMinor: 10800n,
      gstHstMinor: 800n,
      qstMinor: 0n,
      lines: [line('lunch', 10800n, 100)],
      entityRecovers: false,
    });
    expect(out.taxLines).toEqual([]);
    expect(out.expenseLines[0].capitalisedTaxMinor).toBe(800n);
    expect(out.expenseLines[0].amountMinor).toBe(10800n);
    expect(out.totalMinor).toBe(10800n);
  });

  it('capitalises DIFFERENT amounts on two lines at different ITC rates (rule 4)', () => {
    // One receipt, $200 of meals (50%) + $100 of supplies (100%), $39 HST.
    const out = composePosting({
      grossMinor: 33900n,
      gstHstMinor: 3900n,
      qstMinor: 0n,
      lines: [line('meals', 22600n, 50), line('supplies', 11300n, 100)],
      entityRecovers: true,
    });
    const [meals, supplies] = out.expenseLines;
    expect(supplies.capitalisedTaxMinor).toBe(0n);
    expect(meals.capitalisedTaxMinor).toBeGreaterThan(0n);
    expect(out.totalMinor).toBe(33900n);
  });

  it('posts GST/HST and QST as separate lines (Quebec)', () => {
    // $100 + 5% GST + 9.975% QST = $114.98.
    const out = composePosting({
      grossMinor: 11498n,
      gstHstMinor: 500n,
      qstMinor: 998n,
      lines: [line('meeting', 11498n, 100)],
      entityRecovers: true,
    });
    expect(out.taxLines.map((l) => l.kind)).toEqual(['GST_HST', 'QST']);
    expect(sum(out.taxLines.map((l) => l.amountMinor))).toBe(1498n);
    expect(out.totalMinor).toBe(11498n);
  });

  it('capitalises PST in full — nobody reclaims it', () => {
    const out = composePosting({
      grossMinor: 11200n,
      gstHstMinor: 500n,
      qstMinor: 0n,
      pstMinor: 700n,
      lines: [line('hotel', 11200n, 100)],
      entityRecovers: true,
    });
    expect(out.taxLines).toEqual([{ kind: 'GST_HST', amountMinor: 500n }]);
    expect(out.expenseLines[0].capitalisedTaxMinor).toBe(700n);
    expect(out.totalMinor).toBe(11200n);
  });

  it('omits a tax line that rounds to zero rather than posting $0.00', () => {
    const out = composePosting({
      grossMinor: 100n,
      gstHstMinor: 1n,
      qstMinor: 0n,
      lines: [line('tiny', 100n, 0)],
      entityRecovers: true,
    });
    expect(out.taxLines).toEqual([]);
    expect(out.totalMinor).toBe(100n);
  });

  it('sums back to gross across awkward splits — the posting invariant', () => {
    for (const gross of [1n, 7n, 999n, 100001n, 123457n]) {
      for (const tax of [0n, 1n, 13n, 137n]) {
        if (tax > gross) continue;
        const out = composePosting({
          grossMinor: gross,
          gstHstMinor: tax,
          qstMinor: 0n,
          lines: [line('a', (gross * 2n) / 3n, 50), line('b', gross - (gross * 2n) / 3n, 100)],
          entityRecovers: true,
        });
        expect(out.totalMinor, `gross ${gross} tax ${tax}`).toBe(gross);
        expect(
          sum(out.expenseLines.map((l) => l.amountMinor)) +
            sum(out.taxLines.map((l) => l.amountMinor)),
        ).toBe(gross);
        for (const l of out.expenseLines) {
          expect(l.netMinor + l.capitalisedTaxMinor).toBe(l.amountMinor);
        }
      }
    }
  });

  it('composes a refund (negative amounts) without losing the reversal', () => {
    const out = composePosting({
      grossMinor: -11300n,
      gstHstMinor: -1300n,
      qstMinor: 0n,
      lines: [line('returned', -11300n, 50)],
      entityRecovers: true,
    });
    expect(out.totalMinor).toBe(-11300n);
    // The credit reverses: a negative receivable from the tax authority.
    expect(out.taxLines[0]?.amountMinor ?? 0n).toBeLessThan(0n);
  });

  it('emits nothing for an expense with no lines', () => {
    const out = composePosting({
      grossMinor: 0n,
      gstHstMinor: 0n,
      qstMinor: 0n,
      lines: [],
      entityRecovers: true,
    });
    expect(out).toEqual({ expenseLines: [], taxLines: [], totalMinor: 0n });
  });
});

describe('convertComposition', () => {
  it('converts to the home total exactly, with the parts still adding up', () => {
    const usd = composePosting({
      grossMinor: 33900n,
      gstHstMinor: 3900n,
      qstMinor: 0n,
      lines: [line('meals', 22600n, 50), line('supplies', 11300n, 100)],
      entityRecovers: true,
    });
    // ~1.37 CAD/USD.
    const cad = convertComposition(usd, 46443n);
    expect(cad.totalMinor).toBe(46443n);
    expect(
      sum(cad.expenseLines.map((l) => l.amountMinor)) + sum(cad.taxLines.map((l) => l.amountMinor)),
    ).toBe(46443n);
    for (const l of cad.expenseLines) {
      expect(l.netMinor + l.capitalisedTaxMinor).toBe(l.amountMinor);
    }
    expect(cad.taxLines.map((l) => l.kind)).toEqual(usd.taxLines.map((l) => l.kind));
  });

  it('leaves a same-currency composition untouched in total', () => {
    const c = composePosting({
      grossMinor: 11300n,
      gstHstMinor: 1300n,
      qstMinor: 0n,
      lines: [line('meal', 11300n, 50)],
      entityRecovers: true,
    });
    expect(convertComposition(c, 11300n).totalMinor).toBe(11300n);
  });
});

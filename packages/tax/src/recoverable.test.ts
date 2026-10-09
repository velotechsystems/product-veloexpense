import { describe, expect, it } from 'vitest';
import { allocateProportional, allocateRecoverable, nonRecoverablePerLine } from './recoverable';

/**
 * This module exists because the rule was implemented twice, with different
 * rounding and only one of the two honouring the legal-entity gate. So the tests
 * pin the parts that differed: the split is exact, the entity gate beats the
 * category rate, and what a line can't reclaim is derived per line.
 */

const line = (amountMinor: bigint, itcGstHstRate = 100, itcQstRate = 100) => ({
  amountMinor,
  itcGstHstRate,
  itcQstRate,
});

describe('allocateProportional', () => {
  it('splits exactly — the parts always sum back to the total', () => {
    const parts = allocateProportional(100n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
    // The leftover cent goes to a largest weight, not to whoever is first.
    expect(parts).toEqual([34n, 33n, 33n]);
  });

  it('gives the remainder to the largest weights', () => {
    expect(allocateProportional(10n, [1n, 8n, 1n])).toEqual([1n, 8n, 1n]);
    expect(allocateProportional(11n, [1n, 8n, 1n])).toEqual([1n, 9n, 1n]);
  });

  it('is stable for equal weights rather than order-dependent', () => {
    expect(allocateProportional(5n, [1n, 1n])).toEqual([3n, 2n]);
  });

  it('returns zeros when there is nothing to weigh against', () => {
    expect(allocateProportional(100n, [0n, 0n])).toEqual([0n, 0n]);
    expect(allocateProportional(100n, [])).toEqual([]);
  });
});

describe('allocateRecoverable', () => {
  it('applies each line category rate to its share of the tax', () => {
    // $100 of meals at 50% + $100 of software at 100%, $26 HST split evenly.
    const out = allocateRecoverable({
      gstHstMinor: 2600n,
      qstMinor: 0n,
      entityRecovers: true,
      lines: [line(10_000n, 50, 50), line(10_000n, 100, 100)],
    });
    expect(out.recoverableGstHstMinor).toBe(650n + 1300n);
  });

  it('reclaims nothing when the ENTITY cannot, whatever the categories say', () => {
    const out = allocateRecoverable({
      gstHstMinor: 2600n,
      qstMinor: 1000n,
      entityRecovers: false,
      lines: [line(10_000n), line(10_000n)],
    });
    expect(out).toEqual({ recoverableGstHstMinor: 0n, recoverableQstMinor: 0n });
  });

  it('handles GST/HST and QST independently', () => {
    const out = allocateRecoverable({
      gstHstMinor: 1000n,
      qstMinor: 2000n,
      entityRecovers: true,
      lines: [line(10_000n, 50, 0)],
    });
    expect(out.recoverableGstHstMinor).toBe(500n);
    expect(out.recoverableQstMinor).toBe(0n);
  });

  it('reclaims nothing with no lines to allocate across', () => {
    const out = allocateRecoverable({
      gstHstMinor: 1000n,
      qstMinor: 0n,
      entityRecovers: true,
      lines: [],
    });
    expect(out.recoverableGstHstMinor).toBe(0n);
  });
});

describe('nonRecoverablePerLine', () => {
  it('capitalises what each line cannot reclaim, line by line', () => {
    // Same receipt, two rates: the meal keeps half its tax, the software none.
    const out = nonRecoverablePerLine({
      gstHstMinor: 2600n,
      qstMinor: 0n,
      entityRecovers: true,
      lines: [line(10_000n, 50, 50), line(10_000n, 100, 100)],
    });
    expect(out).toEqual([650n, 0n]);
  });

  it('capitalises the whole tax when the entity reclaims nothing', () => {
    const out = nonRecoverablePerLine({
      gstHstMinor: 1300n,
      qstMinor: 700n,
      entityRecovers: false,
      lines: [line(10_000n)],
    });
    expect(out).toEqual([2000n]);
  });

  it('and the recoverable + non-recoverable halves always sum to the tax paid', () => {
    const params = {
      gstHstMinor: 1301n,
      qstMinor: 997n,
      entityRecovers: true,
      lines: [line(3333n, 50, 50), line(3333n, 100, 100), line(3334n, 0, 0)],
    };
    const rec = allocateRecoverable(params);
    const nonRec = nonRecoverablePerLine(params).reduce((a, b) => a + b, 0n);
    expect(rec.recoverableGstHstMinor + rec.recoverableQstMinor + nonRec).toBe(1301n + 997n);
  });
});

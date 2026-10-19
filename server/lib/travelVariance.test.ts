import { describe, expect, it } from 'vitest';
import { isOverrun, travelVariance } from './travelVariance';

const b = (categoryId: string, amountMinor: bigint) => ({ categoryId, amountMinor });

describe('travelVariance', () => {
  it('pairs budget and actual by category', () => {
    const v = travelVariance({
      budgetLines: [b('c-air', 74200n), b('c-hotel', 60000n)],
      actualLines: [b('c-air', 81000n), b('c-hotel', 55000n)],
    });
    expect(v.budgetedMinor).toBe(134200n);
    expect(v.actualMinor).toBe(136000n);
    expect(v.varianceMinor).toBe(1800n);
    expect(v.rows.find((r) => r.categoryId === 'c-air')?.varianceMinor).toBe(6800n);
    expect(v.rows.find((r) => r.categoryId === 'c-hotel')?.varianceMinor).toBe(-5000n);
  });

  it('sums several lines in one category', () => {
    const v = travelVariance({
      budgetLines: [b('c-meals', 9000n)],
      actualLines: [b('c-meals', 3000n), b('c-meals', 4500n)],
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].actualMinor).toBe(7500n);
  });

  it('shows spend in a category nobody budgeted for', () => {
    // Unplanned spend is exactly what a variance report is for. Dropping it would
    // make an overrun vanish rather than stand out.
    const v = travelVariance({ budgetLines: [], actualLines: [b('c-bar', 12000n)] });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].budgetedMinor).toBe(0n);
    expect(v.rows[0].varianceMinor).toBe(12000n);
  });

  it('keeps a budgeted category with nothing filed against it', () => {
    const v = travelVariance({ budgetLines: [b('c-car', 20000n)], actualLines: [] });
    expect(v.rows[0].actualMinor).toBe(0n);
    expect(v.varianceMinor).toBe(-20000n);
  });

  it('separates "on budget" from "nothing filed yet"', () => {
    // Identical totals, opposite meanings.
    const nothingYet = travelVariance({ budgetLines: [b('c-air', 100n)], actualLines: [] });
    const onBudget = travelVariance({
      budgetLines: [b('c-air', 100n)],
      actualLines: [b('c-air', 100n)],
    });
    expect(nothingYet.hasActuals).toBe(false);
    expect(onBudget.hasActuals).toBe(true);
  });
});

describe('isOverrun', () => {
  const v = (budgetedMinor: bigint, varianceMinor: bigint) => ({ budgetedMinor, varianceMinor });

  it('fires when both the percentage and the floor are exceeded', () => {
    expect(isOverrun(v(100_000n, 20_000n), 10, 5_000n)).toBe(true);
  });

  it('is silent under budget', () => {
    expect(isOverrun(v(100_000n, -1n), 10, 5_000n)).toBe(false);
  });

  it('is silent on a small overrun of a small budget', () => {
    // A percentage alone would report $12 over on $40. That is noise.
    expect(isOverrun(v(4_000n, 1_200n), 10, 5_000n)).toBe(false);
  });

  it('is silent on a large overrun that is a small percentage', () => {
    // And an absolute alone would report a rounding error on a $500k programme.
    expect(isOverrun(v(50_000_000n, 6_000n), 10, 5_000n)).toBe(false);
  });

  it('does not treat an unbudgeted trip as infinitely over', () => {
    // That is a different finding and not this one's to raise.
    expect(isOverrun(v(0n, 90_000n), 10, 5_000n)).toBe(false);
  });

  it('needs to EXCEED the tolerance, not merely meet it', () => {
    expect(isOverrun(v(100_000n, 10_000n), 10, 1_000n)).toBe(false);
    expect(isOverrun(v(100_000n, 10_001n), 10, 1_000n)).toBe(true);
  });

  it('handles a fractional tolerance without floating point drift', () => {
    // 12.5% of 100_000 is 12_500 exactly.
    expect(isOverrun(v(100_000n, 12_500n), 12.5, 1n)).toBe(false);
    expect(isOverrun(v(100_000n, 12_501n), 12.5, 1n)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { splitExact } from './split';

/**
 * `splitExact` divides money, and it had no tests.
 *
 * It is the arithmetic under three things that must balance to the cent: the lines
 * `postExpenseReport` sends to NetSuite (they have to add up to what the employee is
 * paid), a report's home-currency rollup, and a budget's apportioned actuals. A
 * one-minor-unit leak here is an accounting discrepancy, and it would surface as a
 * NetSuite rejection or a budget that never quite reconciles — a long way from the
 * cause.
 *
 * This repo has already shipped one money-scale bug (`convertMoney`, PR #127), which
 * is the argument for pinning the invariants rather than a few examples: the
 * properties below hold for EVERY input, so they are asserted over a fuzz sweep as
 * well as the specific shapes the callers actually pass.
 */

/** A seeded LCG. Deterministic on purpose — a fuzz failure has to be reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const abs = (v: bigint) => (v < 0n ? -v : v);

describe('splitExact', () => {
  describe('the invariant that matters: the parts sum to the whole', () => {
    it('holds for an indivisible split', () => {
      // 100 / 3 loses a unit to naive arithmetic — 33+33+33 = 99.
      const parts = splitExact(100n, [1n, 1n, 1n]);
      expect(sum(parts)).toBe(100n);
      expect(parts).toEqual([34n, 33n, 33n]);
    });

    it('holds for a refund (negative total), handing the leftover downward', () => {
      const parts = splitExact(-100n, [1n, 1n, 1n]);
      expect(sum(parts)).toBe(-100n);
      // Every part is negative: a refund must not produce a positive line.
      expect(parts.every((p) => p < 0n)).toBe(true);
      expect(parts).toEqual([-34n, -33n, -33n]);
    });

    it('holds across a fuzz sweep, including negatives and lopsided weights', () => {
      const rand = lcg(20260814);
      for (let i = 0; i < 2_000; i++) {
        const n = 1 + Math.floor(rand() * 8);
        const weights = Array.from({ length: n }, () => BigInt(Math.floor(rand() * 5_000)));
        const total = BigInt(Math.floor((rand() - 0.5) * 2_000_000));
        const parts = splitExact(total, weights);
        expect(
          sum(parts),
          `total=${total} weights=[${weights.join(',')}] parts=[${parts.join(',')}]`,
        ).toBe(total);
        expect(parts).toHaveLength(n);
      }
    });

    it('never drops or invents a unit when the total is smaller than the part count', () => {
      // 2 units across 5 lines: three lines legitimately get nothing.
      const parts = splitExact(2n, [1n, 1n, 1n, 1n, 1n]);
      expect(sum(parts)).toBe(2n);
      expect(parts.filter((p) => p > 0n)).toHaveLength(2);
    });
  });

  describe('who receives the leftover', () => {
    it('gives it to the largest weight, not the first line', () => {
      // A leftover unit belongs on the biggest line, where it is proportionally least
      // visible — not on whichever line happens to be listed first.
      const parts = splitExact(10n, [1n, 8n, 1n]);
      expect(sum(parts)).toBe(10n);
      expect(parts[1]).toBe(8n);
      // 10*1/10 = 1 exactly for the outer lines, so nothing is left to hand out.
      expect(parts).toEqual([1n, 8n, 1n]);
    });

    it('walks weights largest-first when several units are left over', () => {
      // Exact shares are 1.67 / 3.33 / 5.00; truncation gives 1/3/5 = 9, so one unit
      // is left and it goes to weight 30.
      expect(splitExact(10n, [10n, 20n, 30n])).toEqual([1n, 3n, 6n]);
      // Two units left over walk the two largest weights in turn.
      expect(sum(splitExact(11n, [10n, 20n, 30n]))).toBe(11n);
    });

    it('orders by WEIGHT, not by fractional remainder — despite what the name suggests', () => {
      /**
       * Worth pinning explicitly, because textbook largest-remainder (Hare quota)
       * would answer differently and somebody reading only the function name would
       * call this a bug.
       *
       * Exact shares here are 1.67 / 3.33 / 5.00. Hare quota gives the spare unit to
       * the biggest FRACTION (0.67, index 0) → [2,3,5]. This implementation gives it
       * to the biggest WEIGHT (30, index 2) → [1,3,6], so a line whose exact share is
       * already a whole number still gets bumped.
       *
       * Both sum correctly and both keep every line within one minor unit, so this is
       * a fairness nuance, not a money leak — and changing it would silently move the
       * leftover cent on already-posted allocations. Left as-is deliberately; the
       * docstring was corrected to stop claiming Hare quota.
       */
      expect(splitExact(10n, [10n, 20n, 30n])).toEqual([1n, 3n, 6n]);
      expect(splitExact(10n, [10n, 20n, 30n])).not.toEqual([2n, 3n, 5n]);
    });

    it('breaks ties by index, so the split is reproducible', () => {
      // Equal weights must not depend on the sort implementation being stable.
      expect(splitExact(101n, [5n, 5n, 5n, 5n])).toEqual([26n, 25n, 25n, 25n]);
      expect(splitExact(7n, [1n, 1n])).toEqual([4n, 3n]);
    });

    it('is order-sensitive only in where the leftover lands, never in the total', () => {
      const a = splitExact(100n, [1n, 2n, 7n]);
      const b = splitExact(100n, [7n, 2n, 1n]);
      expect(sum(a)).toBe(100n);
      expect(sum(b)).toBe(100n);
      expect([...a].sort()).toEqual([...b].sort());
    });
  });

  describe('fairness: no line is off by more than a minor unit', () => {
    it('keeps every share within one unit of its exact proportional value', () => {
      /**
       * The other half of correctness. Summing to the total is easy to get right by
       * dumping the whole remainder onto one line — that would balance and still be
       * wrong, and this is the assertion that rules it out.
       *
       * The bound is ≤ 1 unit, not < 1. A line whose exact share is already a whole
       * number can still receive a leftover unit, because leftovers follow weight
       * rather than fractional remainder (see the test above). Asserting `< 1` fails
       * on exactly that case, which is how the naming discrepancy surfaced.
       */
      const rand = lcg(7);
      for (let i = 0; i < 1_000; i++) {
        const n = 2 + Math.floor(rand() * 6);
        const weights = Array.from({ length: n }, () => BigInt(1 + Math.floor(rand() * 900)));
        const total = BigInt(Math.floor((rand() - 0.5) * 500_000));
        const parts = splitExact(total, weights);
        const w = sum(weights);
        parts.forEach((part, idx) => {
          // |part − total·wᵢ/w| ≤ 1, kept in integer arithmetic to avoid float drift.
          expect(
            abs(part * w - total * weights[idx]) <= abs(w),
            `part ${idx} of [${parts.join(',')}] strays >1 unit (total=${total}, weights=[${weights.join(',')}])`,
          ).toBe(true);
        });
      }
    });

    it('does not dump the whole remainder onto a single line', () => {
      // The failure mode the bound above exists to catch, asserted directly: 7 units
      // across 7 equal weights that each floor to 0 must land one per line.
      const parts = splitExact(
        7n,
        Array.from({ length: 7 }, () => 1n),
      );
      expect(sum(parts)).toBe(7n);
      expect(parts).toEqual([1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    });
  });

  describe('degenerate inputs', () => {
    it('puts everything on the first line when the weights total zero', () => {
      // A line set with no amounts yet. Dropping the money would be the bug.
      expect(splitExact(500n, [0n, 0n, 0n])).toEqual([500n, 0n, 0n]);
    });

    it('does not lose the total when there is exactly one weight', () => {
      expect(splitExact(999n, [3n])).toEqual([999n]);
      expect(splitExact(999n, [0n])).toEqual([999n]);
    });

    it('returns nothing for no weights, rather than throwing', () => {
      // Reached when a caller maps over an empty allocation list.
      expect(splitExact(100n, [])).toEqual([]);
    });

    it('splits zero into zeroes', () => {
      expect(splitExact(0n, [1n, 2n, 3n])).toEqual([0n, 0n, 0n]);
    });

    it('gives a zero-weight line nothing while the total still balances', () => {
      const parts = splitExact(100n, [1n, 0n, 1n]);
      expect(sum(parts)).toBe(100n);
      expect(parts[1]).toBe(0n);
    });
  });

  describe('the shapes the callers actually pass', () => {
    it('splits by basis points that sum to 10000 (cost allocations)', () => {
      // `budgets.ts` and `postExpenseReport.ts` both apportion by ExpenseAllocation
      // basis points. 33.33/33.33/33.34 of $1000.00 must still be $1000.00.
      const parts = splitExact(100_000n, [3333n, 3333n, 3334n]);
      expect(sum(parts)).toBe(100_000n);
      expect(parts).toEqual([33_330n, 33_330n, 33_340n]);
    });

    it('splits an awkward amount by thirds without losing a cent', () => {
      const parts = splitExact(1_000_01n, [3333n, 3333n, 3334n]);
      expect(sum(parts)).toBe(1_000_01n);
    });

    it('apportions a home-currency total across composed line amounts', () => {
      // postExpenseReport: convert once at the report level, then apportion, so the
      // posted lines add up to the converted total instead of each rounding apart.
      const lineAmounts = [4_512n, 1_099n, 88n, 20_000n];
      const homeTotal = 34_982n;
      const parts = splitExact(homeTotal, lineAmounts);
      expect(sum(parts)).toBe(homeTotal);
      // The largest line stays the largest — apportioning must not reorder them.
      expect(parts.indexOf(parts.reduce((a, b) => (b > a ? b : a)))).toBe(3);
    });

    it('apportions a refund across allocations without flipping a sign', () => {
      const parts = splitExact(-34_982n, [4_512n, 1_099n, 88n, 20_000n]);
      expect(sum(parts)).toBe(-34_982n);
      expect(parts.every((p) => p <= 0n)).toBe(true);
    });

    it('handles amounts far beyond Number.MAX_SAFE_INTEGER', () => {
      // The reason these are bigint and not number. In a zero-exponent currency a
      // large total is plausible, and silent float drift would be unfindable.
      const big = 9_007_199_254_740_993n * 1_000n;
      const parts = splitExact(big, [1n, 1n, 1n]);
      expect(sum(parts)).toBe(big);
    });
  });
});

/**
 * Split an integer money amount across weights so the parts sum to exactly the
 * whole.
 *
 * Truncate every share, then hand the leftover minor units out one at a time to
 * the largest **weights**. The naive `total * w / sum` per share loses up to n-1
 * minor units, and in this codebase those units are real — a report's posted
 * lines have to add up to what the employee is paid, and a budget's apportioned
 * actuals have to add up to the expense that produced them.
 *
 * NOT largest-remainder / Hare quota, though it was described as that for a
 * while. Hare quota orders by the largest *fractional remainder*; this orders by
 * the largest *weight*, so a line whose exact share is already a whole number can
 * still be bumped by one unit while a line sitting at .99 gets nothing. Both
 * methods sum exactly and hold every line to within one minor unit, so the
 * difference is a fairness nuance rather than a leak — and switching now would
 * silently move the leftover cent on allocations already posted to NetSuite.
 * Left as-is deliberately; `split.test.ts` pins the distinction so it is not
 * "fixed" by accident.
 *
 * Lives here because it is integer-money arithmetic, which is what this package
 * is for, and it is the single implementation: `integrations-netsuite` had a
 * byte-identical private copy until it was deleted in favour of this one.
 */

/**
 * @param total   the amount to divide, in minor units. May be negative (a
 *                refund), in which case the leftover is handed out downward.
 * @param weights relative shares — basis points, line amounts, anything. Zero
 *                total weight puts everything on the first entry rather than
 *                dropping it on the floor.
 */
export function splitExact(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum === 0n) {
    return weights.map((_, i) => (i === 0 ? total : 0n));
  }
  const out = weights.map((w) => (total * w) / sum);
  let remainder = total - out.reduce((a, v) => a + v, 0n);
  const step = remainder < 0n ? -1n : 1n;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  // Largest weight first; ties break on index so the split is deterministic
  // rather than dependent on the sort implementation.
  const order = weights
    .map((w, i) => [abs(w), i] as const)
    .sort((a, b) => (b[0] === a[0] ? a[1] - b[1] : b[0] > a[0] ? 1 : -1));
  for (let k = 0; remainder !== 0n && k < order.length; k++, remainder -= step) {
    out[order[k][1]] += step;
  }
  return out;
}

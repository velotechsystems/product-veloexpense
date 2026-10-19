/**
 * Budget vs actual for a travel request.
 *
 * The question this answers — "we approved $2,400 for Toronto; what did it cost?" —
 * is the one the whole module exists to make answerable, and it only works because
 * both sides key on the same things. The budget line carries a categoryId and a
 * snapshotted glAccountId; the expense line it becomes carries the same two. Neither
 * side resolves through a category an admin can re-point, so a mapping changed in
 * March cannot restate a trip approved in January.
 *
 * Pure. The caller loads both sides; this is the arithmetic and the pairing.
 */

export interface VarianceInput {
  budgetLines: ReadonlyArray<{ categoryId: string; amountMinor: bigint }>;
  /** Line items from the reports built from this request. */
  actualLines: ReadonlyArray<{ categoryId: string; amountMinor: bigint }>;
}

export interface VarianceRow {
  categoryId: string;
  budgetedMinor: bigint;
  actualMinor: bigint;
  /** actual − budgeted. Positive is an overrun. */
  varianceMinor: bigint;
}

export interface Variance {
  rows: VarianceRow[];
  budgetedMinor: bigint;
  actualMinor: bigint;
  varianceMinor: bigint;
  /** True once anything has been filed. Distinguishes "on budget" from "no receipts
   *  yet", which look identical if you only compare the totals. */
  hasActuals: boolean;
}

export function travelVariance(input: VarianceInput): Variance {
  const rows = new Map<string, VarianceRow>();
  const row = (categoryId: string) => {
    const existing = rows.get(categoryId);
    if (existing) return existing;
    const fresh = { categoryId, budgetedMinor: 0n, actualMinor: 0n, varianceMinor: 0n };
    rows.set(categoryId, fresh);
    return fresh;
  };

  for (const l of input.budgetLines) row(l.categoryId).budgetedMinor += l.amountMinor;
  // Categories that were never budgeted still appear — spend nobody planned for is
  // exactly what a variance report is for, and dropping it would make an overrun
  // vanish rather than stand out.
  for (const l of input.actualLines) row(l.categoryId).actualMinor += l.amountMinor;

  const out = [...rows.values()];
  for (const r of out) r.varianceMinor = r.actualMinor - r.budgetedMinor;

  const budgetedMinor = out.reduce((a, r) => a + r.budgetedMinor, 0n);
  const actualMinor = out.reduce((a, r) => a + r.actualMinor, 0n);
  return {
    rows: out,
    budgetedMinor,
    actualMinor,
    varianceMinor: actualMinor - budgetedMinor,
    hasActuals: input.actualLines.length > 0,
  };
}

/**
 * Is the overrun big enough to report?
 *
 * Both a percentage AND an absolute floor, because either alone is useless: a
 * percentage alone reports a $12 overrun on a $40 budget, and an absolute alone
 * stays silent on a 90% overrun of a small trip until it happens to be large. A
 * finding needs both.
 */
export function isOverrun(
  v: Pick<Variance, 'budgetedMinor' | 'varianceMinor'>,
  tolerancePercent: number,
  minimumMinor: bigint,
): boolean {
  if (v.varianceMinor <= 0n) return false;
  if (v.varianceMinor < minimumMinor) return false;
  // A trip with no budget at all is not "infinitely over" — it is unbudgeted, which
  // is a different finding and not this one's to raise.
  if (v.budgetedMinor <= 0n) return false;
  const allowed = (v.budgetedMinor * BigInt(Math.round(tolerancePercent * 100))) / 10_000n;
  return v.varianceMinor > allowed;
}

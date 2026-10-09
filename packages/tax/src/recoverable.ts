/**
 * Input-tax-credit allocation, shared by every write path.
 *
 * A receipt carries ONE tax total but its lines can sit in categories with
 * different ITC rates (meals 50%, most things 100%), so the recoverable slice
 * has to be derived: split the tax across the lines by amount, apply each line's
 * rate, sum. Two gates, in this order:
 *
 *   1. the LEGAL ENTITY — a non-registrant or foreign entity reclaims nothing,
 *      whatever its categories say. The credit belongs to the entity that
 *      incurred the cost, so the entity decides whether one arises at all.
 *   2. the CATEGORY — its rate only ever narrows a credit that already exists.
 *
 * It lives here, in the pure package, because it was implemented twice — once in
 * the tRPC write path and once in the worker's extraction prefill — with
 * *different rounding* (BigInt weights vs Number weights) and only one of them
 * honouring the entity gate. Two implementations of one tax rule is two answers.
 */

/** A line as far as ITC allocation cares. */
export interface RecoverableLine {
  amountMinor: bigint;
  /** Percent of GST/HST this line's category can reclaim (0–100). */
  itcGstHstRate: number;
  /** Percent of QST this line's category can reclaim (0–100). */
  itcQstRate: number;
}

export interface AllocateRecoverableParams {
  gstHstMinor: bigint;
  qstMinor: bigint;
  lines: RecoverableLine[];
  /**
   * `LegalEntity.itcRecoverable`. False forces both figures to zero regardless
   * of category — the entity gate above.
   */
  entityRecovers: boolean;
}

export interface RecoverableResult {
  recoverableGstHstMinor: bigint;
  recoverableQstMinor: bigint;
}

/**
 * Largest-remainder proportional split of `total` across `weights`, in minor
 * units. Exact: the parts always sum back to `total`, and the leftover cents go
 * to the largest weights rather than to whichever line happens to be first.
 *
 * Signed on both axes, because a refund is a negative expense in this system and
 * the poster splits its tax the same way a charge's is split. Integer division
 * truncates toward zero, so the residual takes the sign of `total` and is
 * distributed in that direction; ordering is by MAGNITUDE so the biggest line
 * absorbs it either way.
 */
export function allocateProportional(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  // Only a zero sum is unsplittable. A negative sum used to return zeros, which
  // dropped a refund's tax on the floor instead of reversing it.
  if (sum === 0n) return weights.map(() => 0n);
  const out = weights.map((w) => (total * w) / sum);
  let remainder = total - out.reduce((a, v) => a + v, 0n);
  const step = remainder < 0n ? -1n : 1n;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const byMagnitudeDesc = weights
    .map((w, i) => [abs(w), i] as const)
    .sort((a, b) => (b[0] === a[0] ? a[1] - b[1] : b[0] > a[0] ? 1 : -1));
  for (let k = 0; remainder !== 0n && k < byMagnitudeDesc.length; k++, remainder -= step) {
    out[byMagnitudeDesc[k][1]] += step;
  }
  return out;
}

/** The recoverable ITC for a whole expense. */
export function allocateRecoverable(params: AllocateRecoverableParams): RecoverableResult {
  const { gstHstMinor, qstMinor, lines, entityRecovers } = params;
  if (!entityRecovers || lines.length === 0) {
    return { recoverableGstHstMinor: 0n, recoverableQstMinor: 0n };
  }
  const weights = lines.map((l) => l.amountMinor);
  const gstShare = allocateProportional(gstHstMinor, weights);
  const qstShare = allocateProportional(qstMinor, weights);
  let recoverableGstHstMinor = 0n;
  let recoverableQstMinor = 0n;
  lines.forEach((l, i) => {
    recoverableGstHstMinor += (gstShare[i] * BigInt(Math.max(0, l.itcGstHstRate))) / 100n;
    recoverableQstMinor += (qstShare[i] * BigInt(Math.max(0, l.itcQstRate))) / 100n;
  });
  return { recoverableGstHstMinor, recoverableQstMinor };
}

/**
 * The share of tax a line CANNOT reclaim — the amount that gets capitalised into
 * that line's own cost when posting, rather than sitting in a tax GL account.
 * Derived per line, because two lines at different ITC rates capitalise
 * different amounts from the same receipt.
 */
export function nonRecoverablePerLine(params: AllocateRecoverableParams): bigint[] {
  const { gstHstMinor, qstMinor, lines, entityRecovers } = params;
  if (lines.length === 0) return [];
  const weights = lines.map((l) => l.amountMinor);
  const gstShare = allocateProportional(gstHstMinor, weights);
  const qstShare = allocateProportional(qstMinor, weights);
  return lines.map((l, i) => {
    if (!entityRecovers) return gstShare[i] + qstShare[i];
    const gstRec = (gstShare[i] * BigInt(Math.max(0, l.itcGstHstRate))) / 100n;
    const qstRec = (qstShare[i] * BigInt(Math.max(0, l.itcQstRate))) / 100n;
    return gstShare[i] - gstRec + (qstShare[i] - qstRec);
  });
}

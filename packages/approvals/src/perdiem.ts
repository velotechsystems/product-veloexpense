/**
 * Per-diem rate resolution (pure — no DB). Given the candidate rates and a
 * spend context (a day + placeText for one traveller), pick the single most
 * specific applicable rate, so the caller can compare a day's spend against its
 * allowance for the `overPerDiem` workflow fact.
 *
 * It matches placeText by substring on the free-text expense placeText and
 * evaluates a (day × placeText × category) group only when a rate clearly
 * applies (tier + placeText + category). `firstLastDay` halving is applied at the
 * trip's edge days. The allowance is per expense category — the per-diem
 * "bucket" IS the category — so a day's meals spend is checked against the meals
 * cap independently of its lodging spend, etc.
 */

export interface PerDiemRateRow {
  city: string;
  /** The expense category this allowance covers (the bucket). */
  categoryId: string;
  /** Daily cap for this (placeText, tier, category), in `currencyId`'s currency. */
  amountMinor: bigint;
  /** GSA convention: halve the daily allowance on the first/last day of a trip. */
  firstLastDay: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  jobLevelId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
  currencyId: string | null;
}

export interface PerDiemContext {
  /** Free-text expense placeText (matched against a rate's city). */
  placeText: string | null;
  date: Date;
  /** The category being evaluated — a rate applies only to its own category. */
  categoryId: string;
  jobLevelId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
}

function cityMatches(placeText: string | null, city: string): boolean {
  if (!placeText || !city) return false;
  return placeText.toLowerCase().includes(city.toLowerCase());
}

function inWindow(rate: PerDiemRateRow, date: Date): boolean {
  if (date < rate.effectiveFrom) return false;
  return rate.effectiveTo == null || date < rate.effectiveTo;
}

/** A rate applies when every non-null scoping dimension equals the context's,
 *  the date is in the effective window, and the placeText matches the city. */
function applies(rate: PerDiemRateRow, ctx: PerDiemContext): boolean {
  if (rate.categoryId !== ctx.categoryId) return false;
  if (!inWindow(rate, ctx.date)) return false;
  if (!cityMatches(ctx.placeText, rate.city)) return false;
  if (rate.jobLevelId != null && rate.jobLevelId !== ctx.jobLevelId) return false;
  if (rate.legalEntityId != null && rate.legalEntityId !== ctx.legalEntityId) return false;
  if (rate.businessUnitId != null && rate.businessUnitId !== ctx.businessUnitId) return false;
  return true;
}

/** Number of non-null scoping dimensions — higher = more specific. */
function specificity(rate: PerDiemRateRow): number {
  return (
    (rate.jobLevelId != null ? 1 : 0) +
    (rate.legalEntityId != null ? 1 : 0) +
    (rate.businessUnitId != null ? 1 : 0)
  );
}

/** The single best-matching rate for a context, or null when none applies.
 *  Most specific wins; ties break to the newest effectiveFrom. */
export function pickPerDiemRate(
  candidates: readonly PerDiemRateRow[],
  ctx: PerDiemContext,
): PerDiemRateRow | null {
  let best: PerDiemRateRow | null = null;
  let bestScore = -1;
  for (const rate of candidates) {
    if (!applies(rate, ctx)) continue;
    const score = specificity(rate);
    if (
      score > bestScore ||
      (score === bestScore && best != null && rate.effectiveFrom > best.effectiveFrom)
    ) {
      best = rate;
      bestScore = score;
    }
  }
  return best;
}

/** One (day + placeText + category) spend group, with the group's total already
 *  in base currency (minor units). `dateKey` is a 'YYYY-MM-DD' string —
 *  lexicographic order equals chronological order. */
export interface PerDiemGroup {
  dateKey: string;
  placeText: string | null;
  categoryId: string;
  spendBaseMinor: number;
}

export interface PerDiemTier {
  jobLevelId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
}

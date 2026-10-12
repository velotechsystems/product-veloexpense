/**
 * Why a per-diem rate did — or did not — apply.
 *
 * `pickPerDiemRate` returns a rate or null. Null is the interesting case and the one people
 * ask about: "why wasn't my dinner capped?", or the reverse, "why was I flagged at $60 when
 * the policy says $75?". Both answers live in which candidates were rejected and on which
 * clause, and that is discarded today.
 *
 * There are six ways a rate silently fails to apply, and they are not equally actionable.
 * A city that did not match is a data-entry problem the claimant can fix. A job-level scope
 * that excluded them is policy working correctly. A rate whose window closed last month is an
 * admin's problem. Telling somebody the wrong one sends them to the wrong place.
 *
 * As with `explainTax`, this re-runs the real selector rather than reimplementing it: the
 * verdict comes from `pickPerDiemRate`, and the trace only records why each candidate lost.
 */

import { type PerDiemContext, type PerDiemRateRow, pickPerDiemRate } from './perdiem';

/** Why one candidate rate did not apply. Ordered as the selector tests them. */
export type RateRejection =
  /** The rate covers a different expense category — a lunch cap does not bound a hotel. */
  | 'WRONG_CATEGORY'
  /** The expense date falls outside the rate's effective window. */
  | 'NOT_IN_EFFECT'
  /** The expense's place text does not contain the rate's city. The most common cause, and
   *  the only one the claimant can fix themselves. */
  | 'CITY_MISMATCH'
  /** The rate is scoped to a job level, entity or unit that is not this claimant's. Policy
   *  working as configured, not a fault. */
  | 'SCOPED_OUT_JOB_LEVEL'
  | 'SCOPED_OUT_LEGAL_ENTITY'
  | 'SCOPED_OUT_BUSINESS_UNIT';

export interface CandidateVerdict {
  readonly city: string;
  readonly amountMinor: bigint;
  /**
   * The rate's own currency, or null to mean the org policy currency.
   *
   * Carried rather than dropped because `amountMinor` is meaningless without it. Per-diem
   * is scoped by country and each rate is denominated in that country's currency — a US
   * rate in USD, a Canadian one in CAD — so a trace listing candidates from both and
   * reporting bare integers invites reading a USD cap as CAD. The applied rate has always
   * reported its currency; the candidates beside it did not, which is the shape that made
   * the amounts unformattable downstream.
   *
   * An id, not a code: this module is pure and has no currency table. The caller resolves
   * it, exactly as it already does for the applied rate.
   */
  readonly currencyId: string | null;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  /** Null when this candidate applied. */
  readonly rejection: RateRejection | null;
  /** Non-null scoping dimensions — higher wins ties. */
  readonly specificity: number;
}

export interface PerDiemTrace {
  /** True when some rate applied. */
  readonly matched: boolean;
  /** Every candidate considered, with why it lost. */
  readonly candidates: readonly CandidateVerdict[];
  /**
   * Why nothing applied, when nothing did — the single most useful field.
   *
   * `null` when a rate matched. When several candidates failed for different reasons this
   * reports the most actionable one rather than the first: a city mismatch is something the
   * claimant can correct, so it outranks a scope exclusion they cannot.
   */
  readonly noMatchReason: RateRejection | null;
  /** Won on specificity, or on a newer effectiveFrom at equal specificity. */
  readonly wonBy: 'specificity' | 'recency' | null;
  readonly context: PerDiemContext;
}

function specificityOf(rate: PerDiemRateRow): number {
  return (
    (rate.jobLevelId != null ? 1 : 0) +
    (rate.legalEntityId != null ? 1 : 0) +
    (rate.businessUnitId != null ? 1 : 0)
  );
}

/**
 * Which clause rejected this candidate, in the selector's own order.
 *
 * The order is copied from `applies` deliberately: reporting a city mismatch on a rate that
 * was for a different category entirely would be true and misleading.
 */
function rejectionFor(rate: PerDiemRateRow, ctx: PerDiemContext): RateRejection | null {
  if (rate.categoryId !== ctx.categoryId) return 'WRONG_CATEGORY';
  const inWindow =
    ctx.date >= rate.effectiveFrom && (rate.effectiveTo == null || ctx.date < rate.effectiveTo);
  if (!inWindow) return 'NOT_IN_EFFECT';
  const cityMatches =
    !!ctx.placeText && !!rate.city && ctx.placeText.toLowerCase().includes(rate.city.toLowerCase());
  if (!cityMatches) return 'CITY_MISMATCH';
  if (rate.jobLevelId != null && rate.jobLevelId !== ctx.jobLevelId) return 'SCOPED_OUT_JOB_LEVEL';
  if (rate.legalEntityId != null && rate.legalEntityId !== ctx.legalEntityId) {
    return 'SCOPED_OUT_LEGAL_ENTITY';
  }
  if (rate.businessUnitId != null && rate.businessUnitId !== ctx.businessUnitId) {
    return 'SCOPED_OUT_BUSINESS_UNIT';
  }
  return null;
}

/**
 * How actionable a rejection is, for choosing what to tell somebody.
 *
 * A claimant can retype a place. They cannot change their job level, and they should not be
 * told to. Higher is reported first.
 */
const ACTIONABILITY: Record<RateRejection, number> = {
  CITY_MISMATCH: 5,
  NOT_IN_EFFECT: 4,
  SCOPED_OUT_JOB_LEVEL: 3,
  SCOPED_OUT_LEGAL_ENTITY: 3,
  SCOPED_OUT_BUSINESS_UNIT: 3,
  // Least useful on its own: it only means this rate was for something else entirely.
  WRONG_CATEGORY: 1,
};

/** Run the selector and explain the outcome. */
export function explainPerDiemRate(
  candidates: readonly PerDiemRateRow[],
  ctx: PerDiemContext,
): { rate: PerDiemRateRow | null; trace: PerDiemTrace } {
  const rate = pickPerDiemRate(candidates, ctx);

  const verdicts: CandidateVerdict[] = candidates.map((c) => ({
    city: c.city,
    amountMinor: c.amountMinor,
    currencyId: c.currencyId,
    effectiveFrom: c.effectiveFrom,
    effectiveTo: c.effectiveTo,
    rejection: rejectionFor(c, ctx),
    specificity: specificityOf(c),
  }));

  const rejections = verdicts.map((v) => v.rejection).filter((r): r is RateRejection => r !== null);

  const noMatchReason =
    rate !== null || rejections.length === 0
      ? null
      : rejections.reduce((best, r) => (ACTIONABILITY[r] > ACTIONABILITY[best] ? r : best));

  // Which rule won: a strictly-more-specific rate, or a newer one at equal specificity.
  let wonBy: PerDiemTrace['wonBy'] = null;
  if (rate) {
    const applied = verdicts.filter((v) => v.rejection === null);
    const top = Math.max(...applied.map((v) => v.specificity));
    wonBy = applied.filter((v) => v.specificity === top).length > 1 ? 'recency' : 'specificity';
  }

  return {
    rate,
    trace: { matched: rate !== null, candidates: verdicts, noMatchReason, wonBy, context: ctx },
  };
}

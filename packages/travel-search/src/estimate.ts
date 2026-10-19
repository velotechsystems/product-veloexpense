/**
 * Quotes + policy → a budget an approver can actually judge.
 *
 * Pure, and separate from the provider calls, because this is the part with
 * opinions in it and opinions deserve tests.
 *
 * The central idea: every line says WHERE ITS NUMBER CAME FROM. A flight priced
 * from a live quote and a car priced from a policy cap are both "budget", but they
 * are not equally trustworthy, and an approver deciding on a total is entitled to
 * know which parts are market prices, which are caps, and which are guesses. A
 * budget that hides its own provenance is how a $9,000 trip gets waved through
 * because the total looked like it came from somewhere.
 */

import { nightlyRateMinor } from './stays';
import type { FlightOption, PriceInsight, StayOption } from './types';

/** Where a budget figure came from, worst-to-best evidence. */
export type PriceBasis =
  /** A live provider quote for this itinerary. */
  | 'QUOTE'
  /** A policy ceiling — real, but a limit rather than a prediction. */
  | 'POLICY_CAP'
  /** The per-diem allowance for the destination. */
  | 'PER_DIEM'
  /** Somebody typed it. */
  | 'MANUAL';

/** How a quote compares with what the route normally costs. */
export type PriceConfidence = 'BELOW_TYPICAL' | 'TYPICAL' | 'ABOVE_TYPICAL' | 'UNKNOWN';

export interface BudgetLineEstimate {
  /** Stable key for the bucket: 'airfare' | 'lodging' | 'car' | 'meals' | … */
  kind: string;
  amountMinor: bigint;
  currency: string;
  basis: PriceBasis;
  confidence: PriceConfidence;
  /** One line a human can read: "Round trip YUL→YYZ, Air Canada, 1 stop". */
  detail: string | null;
}

export interface TravelEstimate {
  lines: BudgetLineEstimate[];
  totalMinor: bigint;
  currency: string;
  /**
   * True when at least one line is a live quote. A budget assembled entirely from
   * caps and per-diems is a policy maximum, not a prediction, and the UI should
   * not present it as though a provider agreed with it.
   */
  quoted: boolean;
}

/**
 * Where a quoted price sits against the route's typical range.
 *
 * The provider's own `level` is preferred — it knows the route's history — and the
 * numeric range is the fallback. UNKNOWN when neither is available, which is
 * honest and common for thin routes.
 */
export function priceConfidence(priceMinor: bigint, insight: PriceInsight | null): PriceConfidence {
  if (!insight) return 'UNKNOWN';
  const level = insight.level?.toLowerCase();
  if (level === 'low') return 'BELOW_TYPICAL';
  if (level === 'high') return 'ABOVE_TYPICAL';
  if (level === 'typical') return 'TYPICAL';
  const range = insight.typicalRangeMinor;
  if (!range) return 'UNKNOWN';
  if (priceMinor < range.lowMinor) return 'BELOW_TYPICAL';
  if (priceMinor > range.highMinor) return 'ABOVE_TYPICAL';
  return 'TYPICAL';
}

export interface EstimateInput {
  currency: string;
  nights: number;
  /** Whole days the traveller is away — cars are billed by day, not by night. */
  days: number;
  /** Cheapest acceptable itinerary, if a flight search ran. */
  flight?: { option: FlightOption; insight: PriceInsight | null } | null;
  /** Chosen or cheapest stay, if a lodging search ran. */
  stay?: StayOption | null;
  /**
   * Policy numbers, all optional and all in minor units:
   *   · `lodgingCapPerNightMinor` — the per-diem lodging cap. Used when no stay was
   *     quoted, and used to FLAG a quote that exceeds it.
   *   · `mealsPerDiemPerDayMinor` — the meals allowance; always policy, never quoted.
   *   · `carCapPerDayMinor` — the daily car cap. There is no car engine, so this is
   *     the only figure available for a car.
   */
  policy?: {
    lodgingCapPerNightMinor?: bigint | null;
    mealsPerDiemPerDayMinor?: bigint | null;
    carCapPerDayMinor?: bigint | null;
  };
  /** Include a car line. Off by default: most trips don't rent one, and a line
   *  nobody asked for inflates every budget by a week of car hire. */
  includeCar?: boolean;
}

/**
 * Build the estimate.
 *
 * Lodging deserves a note. When a stay was quoted AND a cap exists, the quote is
 * what gets budgeted — the traveller will pay the market rate, and budgeting the
 * cap would under-fund a trip that policy is about to approve anyway. The overage
 * is surfaced through `basis: 'QUOTE'` plus a detail line naming the cap, so the
 * approver sees a real number and the fact that it is over. Silently clamping to
 * the cap would produce a budget the trip cannot be taken within.
 */
export function estimateTravelBudget(input: EstimateInput): TravelEstimate {
  const { currency } = input;
  const lines: BudgetLineEstimate[] = [];
  const nights = Math.max(0, input.nights);
  const days = Math.max(0, input.days);

  // ── Airfare ──────────────────────────────────────────────────────────────
  if (input.flight) {
    const { option, insight } = input.flight;
    const route = option.legs.length
      ? `${option.legs[0].from}→${option.legs[option.legs.length - 1].to}`
      : null;
    lines.push({
      kind: 'airfare',
      amountMinor: option.priceMinor,
      currency,
      basis: 'QUOTE',
      confidence: priceConfidence(option.priceMinor, insight),
      detail:
        [route, option.airlines.join(', ') || null, stopsLabel(option.stops)]
          .filter(Boolean)
          .join(' · ') || null,
    });
  }

  // ── Lodging ──────────────────────────────────────────────────────────────
  const cap = input.policy?.lodgingCapPerNightMinor ?? null;
  const quotedNightly = input.stay ? nightlyRateMinor(input.stay, nights) : null;
  if (quotedNightly !== null && nights > 0) {
    const overCap = cap !== null && quotedNightly > cap;
    lines.push({
      kind: 'lodging',
      amountMinor: quotedNightly * BigInt(nights),
      currency,
      basis: 'QUOTE',
      confidence: 'UNKNOWN',
      detail: [
        input.stay?.name ?? null,
        `${nights} night${nights === 1 ? '' : 's'}`,
        // Named, not clamped — see the note above.
        overCap ? 'over the per-diem lodging cap' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  } else if (cap !== null && nights > 0) {
    lines.push({
      kind: 'lodging',
      amountMinor: cap * BigInt(nights),
      currency,
      basis: 'PER_DIEM',
      confidence: 'UNKNOWN',
      detail: `per-diem cap × ${nights} night${nights === 1 ? '' : 's'}`,
    });
  }

  // ── Meals ────────────────────────────────────────────────────────────────
  //
  // Always the allowance, never a quote: a per-diem is what the employee is
  // entitled to, not what food will cost.
  const meals = input.policy?.mealsPerDiemPerDayMinor ?? null;
  if (meals !== null && days > 0) {
    lines.push({
      kind: 'meals',
      amountMinor: meals * BigInt(days),
      currency,
      basis: 'PER_DIEM',
      confidence: 'UNKNOWN',
      detail: `per-diem × ${days} day${days === 1 ? '' : 's'}`,
    });
  }

  // ── Car ──────────────────────────────────────────────────────────────────
  const car = input.policy?.carCapPerDayMinor ?? null;
  if (input.includeCar && car !== null && days > 0) {
    lines.push({
      kind: 'car',
      amountMinor: car * BigInt(days),
      currency,
      basis: 'POLICY_CAP',
      confidence: 'UNKNOWN',
      // Said plainly: there is no car search to quote from.
      detail: `daily cap × ${days} day${days === 1 ? '' : 's'} (no live rate available)`,
    });
  }

  return {
    lines,
    totalMinor: lines.reduce((a, l) => a + l.amountMinor, 0n),
    currency,
    quoted: lines.some((l) => l.basis === 'QUOTE'),
  };
}

function stopsLabel(stops: number): string {
  if (stops <= 0) return 'nonstop';
  return `${stops} stop${stops === 1 ? '' : 's'}`;
}

/**
 * The cheapest itinerary that satisfies policy, or the cheapest overall when none
 * does.
 *
 * Returning something either way is deliberate: a route where every flight exceeds
 * the cap still needs a number on the request, and an approver looking at "$2,400,
 * over the $2,000 cap" can make a decision. An empty budget just sends the form
 * back with nothing to discuss.
 */
export function pickFlight(
  options: readonly FlightOption[],
  maxPriceMinor: bigint | null,
): { option: FlightOption; withinPolicy: boolean } | null {
  if (options.length === 0) return null;
  const cheapest = [...options].sort((a, b) => (a.priceMinor < b.priceMinor ? -1 : 1));
  if (maxPriceMinor === null) return { option: cheapest[0], withinPolicy: true };
  const compliant = cheapest.find((o) => o.priceMinor <= maxPriceMinor);
  return compliant
    ? { option: compliant, withinPolicy: true }
    : { option: cheapest[0], withinPolicy: false };
}

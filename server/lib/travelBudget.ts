/**
 * The per-diem allowance for ONE category on one trip.
 *
 * This used to build a whole budget: every per-diem category that had a rate at the
 * destination got a line, automatically, on create and on every edit and again inside
 * the submit transaction. That is gone. A traveller composes their own lines now, and
 * picking a category is what asks this question — "what is the allowance for meals in
 * Toronto over these four days?" — for that category alone.
 *
 * Why the change. An auto-built budget had to be REBUILT to stay correct, and a rebuild
 * cannot tell a stale figure from a deliberate one: a traveller who corrected an
 * allowance downward got it silently restored on their next edit. The estimate is now
 * computed once, when the line is created, and a manual amount takes precedence
 * permanently. To go back to the allowance, add a new line in the same category and
 * delete the old one — which is explicit, visible, and needs no rule.
 *
 * Server-authoritative, still. The client may propose an amount and it lands as
 * `MANUAL`, labelled as somebody's typed figure; it can never arrive wearing `PER_DIEM`.
 *
 * Pure — no DB, no clock, no FX table. Rates and the currency conversion arrive as
 * arguments, so the arithmetic is testable without standing any of that up.
 */

import { type PerDiemRateRow, type PerDiemTier, pickPerDiemRate } from '@expenseos/approvals';

export interface PerDiemLookupInput {
  /** Matched against a rate's city by substring — the same rule expenses use. */
  destinationCity: string | null;
  departDate: Date;
  /** Null for a one-way trip, which is budgeted as its single departure day. */
  returnDate: Date | null;
  tier: PerDiemTier;
  rates: readonly PerDiemRateRow[];
  /**
   * The EXPENSE category to look up.
   *
   * Per-diem rates are keyed on the expense taxonomy — the same table drives
   * submit-time enforcement on the expense side — so a travel line reaches its
   * allowance through `TravelCategory.expenseCategoryId`. A travel category mapped to
   * nothing has no allowance to derive, which is one of the costs of two taxonomies.
   */
  expenseCategoryId: string;
}

export interface PerDiemLookupResult {
  amountMinor: bigint;
  /** Days the allowance was summed over, for the human-readable detail line. */
  days: number;
  /** True when at least one edge day was halved — the GSA first/last-day convention. */
  edgeDaysHalved: boolean;
  /** The daily rate on the FIRST day, in the request's currency. What a
   *  `DEPARTMENT_MEAL` line needs as its per-person allowance, where the total is
   *  heads × occurrences × days rather than one allowance per day. */
  dailyRateMinor: bigint;
}

/**
 * Every UTC day the traveller is away, departure and return inclusive.
 *
 * UTC throughout: a trip is a range of calendar dates, not a duration, and running the
 * same request from Montréal and Vancouver must not produce budgets that differ by a
 * day. Capped at 366 — a travel request spanning more than a year is a data-entry
 * accident, and iterating on it would be a slow one.
 */
export function tripDays(departDate: Date, returnDate: Date | null): Date[] {
  const start = Date.UTC(
    departDate.getUTCFullYear(),
    departDate.getUTCMonth(),
    departDate.getUTCDate(),
  );
  const end =
    returnDate == null
      ? start
      : Date.UTC(returnDate.getUTCFullYear(), returnDate.getUTCMonth(), returnDate.getUTCDate());
  // A return before departure is nonsense the form should have caught; budget the
  // departure day rather than returning nothing, so the request still prices.
  if (end < start) return [new Date(start)];

  const days: Date[] = [];
  const DAY = 86_400_000;
  for (let t = start; t <= end && days.length < 366; t += DAY) days.push(new Date(t));
  return days;
}

/**
 * The allowance for one category over the trip, or null when no rate applies.
 *
 * Summed day by day rather than multiplied by a night count, because the rate that
 * applies can CHANGE mid-trip: per-diem rows carry effective windows, and a trip
 * spanning a rate revision has to be priced with both halves. Multiplying one day's
 * rate by the length of the trip silently prices the whole thing at whichever rate
 * happened to be in force on day one.
 *
 * `firstLastDay` halves the allowance on the trip's edge days — the GSA convention
 * already implemented for overage checking, applied here so the estimate an approver
 * sees uses the same arithmetic the policy engine will later hold the actuals to.
 *
 * `toRequestMinor` converts a rate's own currency into the request's; the caller owns
 * the FX table.
 */
export function perDiemForCategory(
  input: PerDiemLookupInput,
  toRequestMinor: (amountMinor: bigint, currencyId: string | null) => bigint,
): PerDiemLookupResult | null {
  const days = tripDays(input.departDate, input.returnDate);
  if (days.length === 0 || !input.destinationCity) return null;

  let amountMinor = 0n;
  let counted = 0;
  let edgeDaysHalved = false;
  let dailyRateMinor = 0n;

  for (const [index, date] of days.entries()) {
    const isEdge = index === 0 || index === days.length - 1;
    const rate = pickPerDiemRate(input.rates, {
      placeText: input.destinationCity,
      date,
      categoryId: input.expenseCategoryId,
      jobLevelId: input.tier.jobLevelId,
      legalEntityId: input.tier.legalEntityId,
      businessUnitId: input.tier.businessUnitId,
    });
    if (!rate) continue;

    const full = toRequestMinor(rate.amountMinor, rate.currencyId);
    // The first day that resolves a rate sets the daily figure. Used by the kinds
    // whose total is not "one allowance per day" — a department meal is heads ×
    // occurrences × days, so it needs the RATE, not the sum.
    if (counted === 0) dailyRateMinor = full;
    // Halving rounds DOWN, so a half-day allowance can never exceed half the cap the
    // policy engine will check the actuals against. Budgeting a cent more than policy
    // permits would approve a trip that cannot be expensed.
    const halve = rate.firstLastDay && isEdge;
    if (halve) edgeDaysHalved = true;
    amountMinor += halve ? full / 2n : full;
    counted += 1;
  }

  // No rate on any day, or a rate of zero. Null rather than a zero line: "there is no
  // allowance here" and "the allowance is nothing" mean different things to whoever is
  // deciding whether the estimate is complete.
  if (counted === 0 || amountMinor <= 0n) return null;
  return { amountMinor, days: counted, edgeDaysHalved, dailyRateMinor };
}

/**
 * `perDiemDetail` used to live here — a one-line English string ("Per diem · 3 days ·
 * Toronto · first/last day halved") composed server-side and written into the line's
 * `detail`.
 *
 * Both halves of that were wrong. `detail` is the TRAVELLER's field now — free text a
 * policy rule can require, and the business purpose of the expense the line becomes — so
 * the server may not write it. And the sentence was English whoever was reading it, which
 * a "snapshot" argument was used to excuse and which was never true of an estimate a
 * traveller and an approver in two languages both look at.
 *
 * The FACTS (`perDiemDays`, `perDiemCity`, `perDiemDailyMinor`, `perDiemEdgeHalved`) ride
 * in the STANDARD payload now, and the sentence is composed at render in the reader's
 * locale — see `travel/_lines/summary.ts`.
 */

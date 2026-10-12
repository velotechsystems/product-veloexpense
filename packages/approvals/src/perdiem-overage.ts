/**
 * Per-diem overage, and the same computation with its reasoning kept.
 *
 * One implementation, three surfaces. `explainPerDiemOverage` does the work and records what
 * it decided; the two numeric functions are wrappers that throw the reasoning away. The
 * approval engine and the submit-time policy rule both call the numeric path, so what a
 * submitter is warned about, what an approver is routed on, and what the assistant explains
 * are guaranteed to be the same number — not three implementations that agree today.
 *
 * Split out of `perdiem.ts` so the explaining version can be the real one: it needs
 * `explainPerDiemRate`, which needs `perdiem.ts`, and leaving these there would have made
 * that a cycle.
 */

import { convertMoney } from '@expenseos/money';
import type { PerDiemGroup, PerDiemRateRow, PerDiemTier } from './perdiem';
import { explainPerDiemRate, type PerDiemTrace } from './perdiem-explain';

/** What happened to one (day × place × category) group. */
export interface PerDiemGroupExplanation extends PerDiemGroup {
  /** The rate that applied, or null when none did. */
  rate: PerDiemRateRow | null;
  /** Every candidate's verdict — including why the ones that lost, lost. */
  trace: PerDiemTrace;
  /** The daily cap in base minor units, AFTER any trip-edge halving. */
  capBaseMinor: number | null;
  /**
   * True when this day is the first or last at this place and the rate halves there.
   *
   * Worth surfacing rather than folding silently into the cap: somebody comparing the cap
   * they were given against the cap in the admin table will otherwise conclude the system
   * is wrong, and the GSA first/last-day convention is not something a claimant knows.
   */
  halvedForTripEdge: boolean;
  overageBaseMinor: number;
}

export interface PerDiemOverageInput {
  expenses: readonly {
    date: Date;
    placeText: string | null;
    lineItems: readonly { amountMinor: bigint; categoryId: string }[];
  }[];
  /** Currency the line amounts are denominated in (the report currency). */
  reportCurrencyCode: string;
  /** Currency the overage is expressed in (org base / policy currency). */
  baseCode: string;
  /** `${base}->${quote}` → decimal rate string, as convertMoney expects. */
  fxRates: Map<string, string>;
  rates: readonly PerDiemRateRow[];
  tier: PerDiemTier;
  /** Rate.currencyId → ISO code (rate amounts' currency; null → base). */
  rateCurrencyCodeById: Map<string, string>;
}

/**
 * Overage across a set of groups whose spend is already in base currency.
 *
 * Kept as its own function because the FX and grouping shell above it is the part that needs
 * a database, and this part is the arithmetic worth testing without one.
 */
export function perDiemOverageBaseMinor(
  groups: readonly PerDiemGroup[],
  rates: readonly PerDiemRateRow[],
  tier: PerDiemTier,
  capBaseMinorFor: (rate: PerDiemRateRow) => number,
): number {
  return explainGroups(groups, rates, tier, capBaseMinorFor).reduce(
    (sum, g) => sum + g.overageBaseMinor,
    0,
  );
}

/** Group-by-group, with the trace for each. */
function explainGroups(
  groups: readonly PerDiemGroup[],
  rates: readonly PerDiemRateRow[],
  tier: PerDiemTier,
  capBaseMinorFor: (rate: PerDiemRateRow) => number,
): PerDiemGroupExplanation[] {
  // Earliest + latest day per placeText → the trip edges for firstLastDay. Keyed
  // by placeText only: a day is a trip edge whatever its categories.
  const edges = new Map<string, { min: string; max: string }>();
  for (const g of groups) {
    const loc = g.placeText ?? '';
    const e = edges.get(loc);
    if (!e) edges.set(loc, { min: g.dateKey, max: g.dateKey });
    else {
      if (g.dateKey < e.min) e.min = g.dateKey;
      if (g.dateKey > e.max) e.max = g.dateKey;
    }
  }

  return groups.map((g) => {
    const { rate, trace } = explainPerDiemRate(rates, {
      placeText: g.placeText,
      date: new Date(`${g.dateKey}T00:00:00Z`),
      categoryId: g.categoryId,
      jobLevelId: tier.jobLevelId,
      legalEntityId: tier.legalEntityId,
      businessUnitId: tier.businessUnitId,
    });
    // A group with no rate is not evaluated at all — no rate means no cap, which is not the
    // same as a cap of zero.
    if (!rate) {
      return {
        ...g,
        rate,
        trace,
        capBaseMinor: null,
        halvedForTripEdge: false,
        overageBaseMinor: 0,
      };
    }
    let cap = capBaseMinorFor(rate);
    const edge = edges.get(g.placeText ?? '');
    const halved = Boolean(
      rate.firstLastDay && edge && (g.dateKey === edge.min || g.dateKey === edge.max),
    );
    if (halved) cap /= 2;
    return {
      ...g,
      rate,
      trace,
      capBaseMinor: cap,
      halvedForTripEdge: halved,
      overageBaseMinor: g.spendBaseMinor > cap ? g.spendBaseMinor - cap : 0,
    };
  });
}

/** Group a report's expenses by day × place × category, spend converted to base. */
function groupsOf(input: PerDiemOverageInput, toBase: (m: bigint, c: string) => number) {
  const grouped = new Map<string, PerDiemGroup>();
  for (const e of input.expenses) {
    const dateKey = e.date.toISOString().slice(0, 10);
    for (const li of e.lineItems) {
      const key = `${dateKey}|${e.placeText ?? ''}|${li.categoryId}`;
      const spendBaseMinor = toBase(li.amountMinor, input.reportCurrencyCode);
      const g = grouped.get(key);
      if (g) g.spendBaseMinor += spendBaseMinor;
      else
        grouped.set(key, {
          dateKey,
          placeText: e.placeText,
          categoryId: li.categoryId,
          spendBaseMinor,
        });
    }
  }
  return [...grouped.values()];
}

/**
 * The whole computation, with its reasoning.
 *
 * Note what the CALLER has to get right: `rates` should be every rate that could conceivably
 * apply, NOT pre-filtered by the claimant's job level, legal entity or business unit.
 * `pickPerDiemRate` applies those itself, so pre-filtering changes no result — but it deletes
 * the evidence for three of the trace's rejection reasons, and the answer silently becomes
 * "there is no rate for Toronto" when the truth is "there is one, scoped to a job level you
 * do not have". The second answer is the one somebody can act on.
 */
export function explainPerDiemOverage(input: PerDiemOverageInput): {
  overageBaseMinor: number;
  groups: PerDiemGroupExplanation[];
} {
  if (input.rates.length === 0) return { overageBaseMinor: 0, groups: [] };
  const toBase = (amountMinor: bigint, currencyCode: string): number =>
    Number(
      (
        convertMoney({ amountMinor, currencyCode }, input.baseCode, input.fxRates) ?? {
          amountMinor,
        }
      ).amountMinor,
    );
  const capBaseMinorFor = (rate: PerDiemRateRow): number => {
    const capCode = rate.currencyId
      ? (input.rateCurrencyCodeById.get(rate.currencyId) ?? input.baseCode)
      : input.baseCode;
    return toBase(rate.amountMinor, capCode);
  };
  const groups = explainGroups(groupsOf(input, toBase), input.rates, input.tier, capBaseMinorFor);
  return {
    overageBaseMinor: groups.reduce((sum, g) => sum + g.overageBaseMinor, 0),
    groups,
  };
}

/** End-to-end per-diem overage (base minor units) from a report's expenses. */
export function computePerDiemOverageMinor(input: PerDiemOverageInput): number {
  return explainPerDiemOverage(input).overageBaseMinor;
}

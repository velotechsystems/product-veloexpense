import { convertMoney } from './convert';

/**
 * Report FX / VAT roll-up.
 *
 * An expense report has ONE currency (its "home" currency), but its
 * expenses may each be in a different currency. The report total must
 * therefore be the sum of every expense CONVERTED into the home
 * currency — summing raw minor units across currencies is meaningless
 * (¥1,000 is not $10.00). This module owns that conversion so the
 * stored `totalMinor`, the list view, and the workbench preview all
 * agree.
 *
 * Kept pure (no DB / I/O) so it is unit-testable and reusable by both
 * `recomputeReportTotal` (persist) and the `report` query (preview).
 */

/** The minimal per-expense facts the roll-up needs. */
export interface RollupExpense {
  amountMinor: bigint;
  currencyCode: string;
  recoverableGstHstMinor?: bigint | null;
  recoverableQstMinor?: bigint | null;
  /**
   * The rate this expense was actually converted at, snapshotted on the row
   * (`Expense.fxRate` / `Expense.homeCurrency`). When present and its home
   * currency matches the report's, it OVERRIDES the shared rate map: a filed
   * claim converts at the rate it was filed at, not at whatever the daily table
   * says today. Absent (legacy rows) falls back to the map as before.
   */
  fxRate?: { toString(): string } | null;
  fxHomeCurrency?: string | null;
}

/** One currency's contribution to the report. */
export interface RollupCurrencyLine {
  code: string;
  /** Raw sum of this currency's expenses, in this currency's minor units. */
  grossMinor: string;
  /** `grossMinor` converted into the home currency, or null when no rate. */
  convertedMinor: string | null;
  /** The `<code>->home` rate used (decimal string), or null (same currency
   *  or missing rate). */
  rate: string | null;
  /** How many expenses are in this currency. */
  count: number;
}

export interface ReportRollup {
  homeCurrency: string;
  /** Sum of every CONVERTIBLE expense in the home currency. Expenses whose
   *  rate is missing are excluded (and surfaced via `missingRates`) rather
   *  than added in the wrong units. */
  homeTotalMinor: string;
  /** Recoverable GST/HST + QST across the report, converted to the home
   *  currency (missing-rate expenses excluded). */
  recoverableTotalMinor: string;
  /** True when the report spans more than one currency. */
  multiCurrency: boolean;
  /** Per-currency breakdown, home currency first. */
  byCurrency: RollupCurrencyLine[];
  /** Distinct foreign currency codes with no rate to the home currency —
   *  their amounts are omitted from `homeTotalMinor`. */
  missingRates: string[];
}

interface RateLookup {
  get(key: string): string | undefined;
}

/**
 * Convert a minor-unit amount between currencies via `@expenseos/money`'s
 * `convertMoney` (exact integer math, correct minor-unit scale, handles
 * differing ISO-4217 exponents). Same-currency and zero are trivial; a
 * missing rate or an unknown ISO code (convertMoney throws) → null, so the
 * caller flags it as a missing rate rather than fabricating a number.
 */
function convertOrNull(
  amountMinor: bigint,
  from: string,
  to: string,
  rates: RateLookup,
): bigint | null {
  if (from === to) return amountMinor;
  if (amountMinor === 0n) return 0n;
  try {
    const converted = convertMoney({ amountMinor, currencyCode: from }, to, rates);
    return converted ? converted.amountMinor : null;
  } catch {
    return null;
  }
}

/**
 * A one-entry lookup for an expense that carries its own rate, or null when it
 * doesn't and the shared map should be used. The snapshot only counts when it
 * converts into the currency being rolled up into — a snapshot taken against a
 * different home currency (the entity's, before somebody changed it) says
 * nothing about this report.
 */
function snapshotLookup(e: RollupExpense, homeCurrency: string): RateLookup | null {
  if (!e.fxRate || e.fxHomeCurrency !== homeCurrency || e.currencyCode === homeCurrency) {
    return null;
  }
  const key = `${e.currencyCode}->${homeCurrency}`;
  const rate = e.fxRate.toString();
  return { get: (k) => (k === key ? rate : undefined) };
}

/**
 * Build the FX/VAT roll-up for a report from its expenses and a latest
 * FX-rate map (keys `${base}->${quote}`, values decimal strings — the
 * shape `fxRateMapFrom` and the policy engine both produce).
 *
 * Conversion happens PER EXPENSE, not per currency group: each expense may carry
 * its own snapshotted rate, and the report total has to equal the sum of the
 * per-expense home amounts that will be posted to NetSuite. Rounding a group's
 * gross once would produce a total the line items don't add up to.
 */
export function buildReportRollup(
  homeCurrency: string,
  expenses: readonly RollupExpense[],
  rates: RateLookup,
): ReportRollup {
  interface Group {
    gross: bigint;
    count: number;
    /** Null once any member of the group could not be converted — a partial sum
     *  in the home currency would understate the report silently. */
    converted: bigint | null;
    /** Every distinct rate applied within the group. One means the group has a
     *  single rate worth displaying; more than one means the breakdown can only
     *  honestly show the converted total. */
    rates: Set<string>;
  }
  const groups = new Map<string, Group>();
  const missing = new Set<string>();
  let recoverable = 0n;

  for (const e of expenses) {
    const code = e.currencyCode;
    // Snapshot first, shared map second. `rateFor` returns the effective lookup
    // for THIS expense, so its amount and its recoverable tax convert alike.
    const lookup = snapshotLookup(e, homeCurrency) ?? rates;
    const g = groups.get(code) ?? { gross: 0n, count: 0, converted: 0n, rates: new Set<string>() };
    g.gross += e.amountMinor;
    g.count += 1;
    const converted = convertOrNull(e.amountMinor, code, homeCurrency, lookup);
    if (converted === null) {
      g.converted = null;
      missing.add(code);
    } else if (g.converted !== null) {
      g.converted += converted;
    }
    const applied = code === homeCurrency ? null : lookup.get(`${code}->${homeCurrency}`);
    if (applied) g.rates.add(applied);
    groups.set(code, g);

    const rec = (e.recoverableGstHstMinor ?? 0n) + (e.recoverableQstMinor ?? 0n);
    if (rec !== 0n) {
      const recHome = convertOrNull(rec, code, homeCurrency, lookup);
      if (recHome === null) missing.add(code);
      else recoverable += recHome;
    }
  }

  let homeTotal = 0n;
  const byCurrency: RollupCurrencyLine[] = [];
  for (const [code, g] of groups) {
    if (g.converted !== null) homeTotal += g.converted;
    byCurrency.push({
      code,
      grossMinor: g.gross.toString(),
      convertedMinor: g.converted === null ? null : g.converted.toString(),
      rate: g.rates.size === 1 ? [...g.rates][0] : null,
      count: g.count,
    });
  }

  // Home currency first, then largest converted contribution first so the
  // breakdown reads top-down by weight.
  byCurrency.sort((a, b) => {
    if (a.code === homeCurrency) return -1;
    if (b.code === homeCurrency) return 1;
    return Number(BigInt(b.convertedMinor ?? '0') - BigInt(a.convertedMinor ?? '0'));
  });

  return {
    homeCurrency,
    homeTotalMinor: homeTotal.toString(),
    recoverableTotalMinor: recoverable.toString(),
    multiCurrency: groups.size > 1,
    byCurrency,
    missingRates: [...missing],
  };
}

/**
 * Overlay an AP FX override (A4) onto a rate map: force the
 * `${fromCurrency}->${homeCurrency}` entry to the override rate so the roll-up
 * converts that currency at the card-statement rate instead of the daily
 * FxRate. No-op when the override is absent or its currency IS the home
 * currency (nothing to convert). Mutates and returns the same map.
 */
export function withFxOverride(
  rates: Map<string, string>,
  homeCurrency: string,
  override: { fromCurrency: string; rate: string } | null | undefined,
): Map<string, string> {
  if (override?.fromCurrency && override.fromCurrency !== homeCurrency) {
    rates.set(`${override.fromCurrency}->${homeCurrency}`, override.rate);
  }
  return rates;
}

/**
 * Collapse `FxRate` rows (ordered newest-first) into a latest-per-pair lookup keyed
 * `${base}->${quote}`, then fill in each missing opposite direction with the
 * reciprocal.
 *
 * THE ONE BUILDER. Four places used to run this same "latest per pair, first wins"
 * loop by hand — here, `expenses.perDiemExplain`, `policy/validate`, and the approvals
 * engine's `fxContext`. They agreed while all four were only reading direct rows, and
 * would have diverged the moment one of them learned to invert: a report total that
 * converts a line the policy engine still cannot value is worse than both failing. They
 * all call this now.
 *
 * A derived inverse never overwrites a real row, in either pass — an actual quoted
 * `CAD -> USD` beats `1 / (USD -> CAD)`, which ignores the spread between them.
 */
export function fxRateMapFrom(
  rows: readonly { base: string; quote: string; rate: { toString(): string } }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.base}->${r.quote}`;
    if (!map.has(key)) map.set(key, r.rate.toString());
  }
  // Second pass, over a SNAPSHOT of the direct rows: a real row always wins, and a
  // derived inverse is never itself inverted.
  for (const [key, rate] of [...map]) {
    const [base, quote] = key.split('->');
    if (!base || !quote) continue;
    const inverse = `${quote}->${base}`;
    if (map.has(inverse)) continue;
    const derived = reciprocalOf(rate);
    if (derived) map.set(inverse, derived);
  }
  return map;
}

/**
 * Most decimal places a derived reciprocal may carry, and the digit ceiling that
 * keeps it usable.
 *
 * `convertMoney` scales a rate by stripping its decimal point and calling `Number`,
 * then throws if the result is not a safe integer. Fifteen total digits is the widest
 * that cannot reach 2^53, so a long-tail pair (JPY→USD at 0.0067 inverts to
 * 149.253731343284 — fifteen digits exactly) converts instead of throwing.
 */
const MAX_RECIPROCAL_DP = 12;
const SAFE_TOTAL_DIGITS = 15;

/**
 * `1 / rate` as a decimal string, or null when that cannot be represented usefully.
 *
 * Exact integer arithmetic on the rate's own digits — never float division, which
 * drifts on exactly the long-tail rates this exists for. `1.3876` becomes
 * `0.720668780628` exactly, with no float in the path to round it.
 *
 * WHY THIS EXISTS. `FxRate` holds one direction per pair, and every seeded row quotes
 * `X -> CAD` because CAD is the reporting currency. A USD-denominated report containing
 * a CAD line therefore needed `CAD -> USD`, which no row supplied, and
 * `buildReportRollup` dropped the line from the total rather than adding it in the wrong
 * units. On EXP-000009 that silently omitted CAD 911.66 — about 23% of an approvable,
 * payable claim — behind a hover tooltip.
 *
 * The decimal places are allocated after the integer part is known, because the ceiling
 * is on TOTAL digits, not fractional ones.
 */
function reciprocalOf(rate: string): string | null {
  if (rate.startsWith('-')) return null;
  const [whole = '', frac = ''] = rate.split('.');
  const digits = BigInt((whole + frac).replace(/^0+(?=\d)/, '') || '0');
  if (digits === 0n) return null;
  const scale = frac.length;

  const intDigits = (10n ** BigInt(scale) / digits).toString().length;
  const dp = Math.min(MAX_RECIPROCAL_DP, SAFE_TOTAL_DIGITS - intDigits);
  // A rate so small its inverse already fills the digit budget: a derived value would
  // be too coarse to be worth trusting, so say nothing rather than guess.
  if (dp <= 0) return null;

  const numerator = 10n ** BigInt(scale + dp);
  const quotient = numerator / digits;
  const remainder = numerator % digits;
  const rounded = remainder * 2n >= digits ? quotient + 1n : quotient;

  const s = rounded.toString().padStart(dp + 1, '0');
  const head = s.slice(0, s.length - dp);
  const tail = s.slice(s.length - dp).replace(/0+$/, '');
  return tail ? `${head}.${tail}` : head;
}

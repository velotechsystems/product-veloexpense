// @vitest-environment node
import { buildReportRollup, fxRateMapFrom } from '@expenseos/money';
import { describe, expect, it } from 'vitest';
import { buildHomeRollup, type CurrencyGroup, type HomeConverter } from './readerCurrency';

/**
 * Reading a report in your own currency, at the rate it was FILED at.
 *
 * GA audit v2, GA-3. One expense, one date, two answers:
 *
 *     Report header, toggled to CAD   CAD 174.29
 *     The one line composing it       CAD 174.14
 *
 * Source was USD 125.50 in both. Not rounding — rounding 125.50 at a single rate cannot
 * produce both figures. Two different rates were in play: the line displayed the rate the
 * expense was filed at (1.38757, snapshotted on the row), and the header converted the
 * rolled-up total at whatever the FX table says TODAY (1.38876).
 *
 * The owner's decision is that the snapshot is authoritative: a claim's value in another
 * currency is what it was worth when it was incurred, not what it would be worth if it
 * were incurred this morning. Otherwise an approved report's total moves daily, and an
 * employee reconciling a reimbursement line by line never ties out.
 *
 * These assert the arithmetic directly, against `buildReportRollup` — which already
 * honours a snapshot when its home currency matches the currency being rolled into. The
 * defect was never in the rollup; it was in converting the ANSWER once, afterwards.
 */

// No `as never`: the cast on the first draft of this fixture hid the fact that the
// fields are `base`/`quote`, and the map came out empty — two tests then asserted
// against a rate table that did not exist.
const RATES = fxRateMapFrom([{ base: 'USD', quote: 'CAD', rate: '1.38876' }]);

/** The expense from EXP-004954: filed in USD, valued in CAD at the time. */
const filedExpense = {
  amountMinor: 12_550n,
  currencyCode: 'USD',
  fxRate: '1.38757',
  fxHomeCurrency: 'CAD',
};

describe('a report read in the reader’s currency', () => {
  it('uses the rate the expense was FILED at, not today’s', () => {
    const rollup = buildReportRollup('CAD', [filedExpense], RATES);
    // 12550 × 1.38757 = 17414. Today's rate would give 17429 — the header's figure.
    expect(rollup.homeTotalMinor).toBe('17414');
  });

  it('agrees with the line, which is the whole complaint', () => {
    /**
     * The line renders the expense's own snapshot. Rolling up at the reader's currency
     * has to reach the same number, or a one-line report disagrees with its only line —
     * which is what an auditor screenshotted.
     */
    const rollup = buildReportRollup('CAD', [filedExpense], RATES);
    const lineInCad = (12_550n * 138_757n) / 100_000n;
    expect(BigInt(rollup.homeTotalMinor)).toBe(lineInCad);
  });

  it('still uses the live table for an expense that carries no snapshot', () => {
    // Legacy rows have no `fxRate`. They convert at the table, as they always did —
    // preserving a rate nobody recorded is not possible, and pretending otherwise
    // would be worse than saying so.
    const rollup = buildReportRollup('CAD', [{ amountMinor: 12_550n, currencyCode: 'USD' }], RATES);
    expect(rollup.homeTotalMinor).toBe('17429');
  });

  it('ignores a snapshot taken against a DIFFERENT currency', () => {
    /**
     * A snapshot is a rate between two named currencies, not a universal one. An expense
     * filed USD→CAD says nothing about USD→GBP, and using it there would be inventing a
     * rate. `buildReportRollup` already refuses; asserted so a future change to the
     * reader-currency path cannot quietly widen it.
     */
    const rollup = buildReportRollup(
      'GBP',
      [filedExpense],
      fxRateMapFrom([{ base: 'USD', quote: 'GBP', rate: '0.8' }]),
    );
    // 12550 × 0.8, the TABLE's rate. 0.8 rather than 0.75 so the assertion is not
    // also about half-to-even rounding, which is a different subject.
    expect(rollup.homeTotalMinor).toBe('10040');
  });
});

/**
 * `buildHomeRollup` in isolation, for the states the seeded fixtures cannot reach.
 *
 * The database has exactly one unconvertible row (the JPY report), which is enough to
 * pin the ordinary "some excluded" case in `landingAggregates.db.test.ts` and not enough
 * to reach the two ends: nothing at all, and nothing convertible. Those two are where a
 * roll-up says something false most cheaply — an empty set and a wholly unvaluable set
 * both produce the digit 0, and only one of them means it.
 */

/** A converter with a rate for USD only, so JPY is the excluded currency here too. */
const convert: HomeConverter = (amountMinor, code) => {
  if (code === 'CAD') return amountMinor.toString();
  if (code === 'USD') return ((amountMinor * 136n) / 100n).toString();
  return null;
};

const group = (over: Partial<CurrencyGroup> = {}): CurrencyGroup => ({
  code: 'CAD',
  symbol: '$',
  count: 1,
  totalMinor: 10000n,
  ...over,
});

describe('buildHomeRollup', () => {
  it('converts each group separately and adds the results', () => {
    const rollup = buildHomeRollup(
      [group({ count: 2, totalMinor: 10000n }), group({ code: 'USD', totalMinor: 125000n })],
      convert,
    );
    expect(rollup.homeTotalMinor).toBe('180000');
    expect(rollup.excludedCount).toBe(0);
  });

  it('sorts by ISO code, whatever order groupBy handed them over in', () => {
    /** `groupBy` promises no ordering, and a panel whose currencies reshuffle between
     *  loads looks broken even when every figure on it is right. */
    const rollup = buildHomeRollup(
      [group({ code: 'USD' }), group({ code: 'CAD' }), group({ code: 'JPY' })],
      convert,
    );
    expect(rollup.byCurrency.map((c) => c.code)).toEqual(['CAD', 'JPY', 'USD']);
  });

  it('counts ROWS behind an excluded group, not the group', () => {
    /** "3 reports left out" is the sentence a reader needs; "1 currency left out" is a
     *  fact about the query. */
    const rollup = buildHomeRollup(
      [group({ totalMinor: 50000n }), group({ code: 'JPY', count: 3, totalMinor: 90000n })],
      convert,
    );
    expect(rollup.homeTotalMinor).toBe('50000');
    expect(rollup.excludedCount).toBe(3);
  });

  it('returns null, not a zero, when nothing could be valued', () => {
    /**
     * The sum IS 0n here, and printing it would say "CAD 0.00" — "you have nothing
     * outstanding" — about a set whose true total is unknowable-but-larger. That is the
     * same lie as understating, with more confidence behind it.
     */
    const rollup = buildHomeRollup([group({ code: 'JPY', count: 2, totalMinor: 90000n })], convert);
    expect(rollup.homeTotalMinor).toBeNull();
    expect(rollup.excludedCount).toBe(2);
    expect(rollup.byCurrency[0].totalMinor).toBe('90000');
  });

  it('returns a real zero for a set with no rows in it', () => {
    /** The only zero that means "nothing to add up". A caller must be able to tell it
     *  apart from the null above, because they call for different copy on screen. */
    const rollup = buildHomeRollup([], convert);
    expect(rollup).toEqual({ byCurrency: [], homeTotalMinor: '0', excludedCount: 0 });
  });

  it('keeps a genuine zero total as a zero', () => {
    /** A report with no expenses on it converts to 0 and is INCLUDED — it is not
     *  missing data, and counting it as excluded would overstate the caveat. */
    const rollup = buildHomeRollup([group({ totalMinor: 0n })], convert);
    expect(rollup.homeTotalMinor).toBe('0');
    expect(rollup.excludedCount).toBe(0);
  });
});

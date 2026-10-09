import { describe, expect, it } from 'vitest';
import {
  buildReportRollup,
  fxRateMapFrom,
  type RollupExpense,
  withFxOverride,
} from './reportRollup';

/** CAD-home rates: 1 USD = 1.37 CAD, 1 EUR = 1.49 CAD. */
const rates = fxRateMapFrom([
  { base: 'USD', quote: 'CAD', rate: { toString: () => '1.37' } },
  { base: 'EUR', quote: 'CAD', rate: { toString: () => '1.49' } },
]);

const exp = (
  o: Partial<RollupExpense> & { amountMinor: bigint; currencyCode: string },
): RollupExpense => o;

describe('buildReportRollup', () => {
  it('same-currency report: home total is the raw sum, no conversion', () => {
    const r = buildReportRollup(
      'CAD',
      [
        exp({ amountMinor: 10_000n, currencyCode: 'CAD' }),
        exp({ amountMinor: 2_500n, currencyCode: 'CAD' }),
      ],
      rates,
    );
    expect(r.homeTotalMinor).toBe('12500');
    expect(r.multiCurrency).toBe(false);
    expect(r.missingRates).toEqual([]);
    expect(r.byCurrency).toHaveLength(1);
    expect(r.byCurrency[0]).toMatchObject({
      code: 'CAD',
      grossMinor: '12500',
      convertedMinor: '12500',
      rate: null,
      count: 2,
    });
  });

  it('multi-currency: converts each currency to home and sums', () => {
    const r = buildReportRollup(
      'CAD',
      [
        exp({ amountMinor: 10_000n, currencyCode: 'CAD' }), // 100.00 CAD
        exp({ amountMinor: 10_000n, currencyCode: 'USD' }), // 100.00 USD → 137.00 CAD
      ],
      rates,
    );
    // 10000 + round(10000 * 1.37) = 10000 + 13700 = 23700
    expect(r.homeTotalMinor).toBe('23700');
    expect(r.multiCurrency).toBe(true);
    const usd = r.byCurrency.find((c) => c.code === 'USD');
    expect(usd).toMatchObject({ grossMinor: '10000', convertedMinor: '13700', rate: '1.37' });
    // home currency sorts first
    expect(r.byCurrency[0].code).toBe('CAD');
  });

  it('rolls up recoverable GST/HST + QST, converted to home', () => {
    const r = buildReportRollup(
      'CAD',
      [
        exp({
          amountMinor: 10_000n,
          currencyCode: 'CAD',
          recoverableGstHstMinor: 500n,
          recoverableQstMinor: 100n,
        }),
        exp({ amountMinor: 10_000n, currencyCode: 'USD', recoverableGstHstMinor: 1_000n }), // 10.00 USD → 13.70 CAD
      ],
      rates,
    );
    // 600 CAD + round(1000 * 1.37)=1370 → 1970
    expect(r.recoverableTotalMinor).toBe('1970');
  });

  it('missing rate: excludes that currency from the total and flags it', () => {
    const r = buildReportRollup(
      'CAD',
      [
        exp({ amountMinor: 10_000n, currencyCode: 'CAD' }),
        exp({ amountMinor: 5_000n, currencyCode: 'GBP' }), // no GBP->CAD rate
      ],
      rates,
    );
    expect(r.homeTotalMinor).toBe('10000'); // GBP excluded
    expect(r.missingRates).toEqual(['GBP']);
    const gbp = r.byCurrency.find((c) => c.code === 'GBP');
    expect(gbp).toMatchObject({ grossMinor: '5000', convertedMinor: null, rate: null });
  });

  it('empty report: zero totals', () => {
    const r = buildReportRollup('CAD', [], rates);
    expect(r).toMatchObject({
      homeTotalMinor: '0',
      recoverableTotalMinor: '0',
      multiCurrency: false,
      missingRates: [],
    });
    expect(r.byCurrency).toEqual([]);
  });
});

describe('per-expense FX snapshots (rule 3)', () => {
  const snap = (amountMinor: bigint, rate: string) =>
    exp({ amountMinor, currencyCode: 'USD', fxRate: rate, fxHomeCurrency: 'CAD' });

  it('converts at the rate the expense was filed at, not today’s', () => {
    // The map says 1.37; the expense was filed at 1.30 and must stay there.
    const r = buildReportRollup('CAD', [snap(10_000n, '1.30')], rates);
    expect(r.homeTotalMinor).toBe('13000');
    expect(r.byCurrency[0].rate).toBe('1.30');
  });

  it('lets two expenses in one currency carry different rates', () => {
    const r = buildReportRollup('CAD', [snap(10_000n, '1.30'), snap(10_000n, '1.40')], rates);
    expect(r.homeTotalMinor).toBe('27000');
    // One group, two rates — no single rate can honestly be shown.
    expect(r.byCurrency[0].count).toBe(2);
    expect(r.byCurrency[0].rate).toBeNull();
    expect(r.byCurrency[0].convertedMinor).toBe('27000');
  });

  it('falls back to the shared map for an expense with no snapshot', () => {
    const r = buildReportRollup(
      'CAD',
      [snap(10_000n, '1.30'), exp({ amountMinor: 10_000n, currencyCode: 'USD' })],
      rates,
    );
    // 13000 (snapshot) + 13700 (map at 1.37).
    expect(r.homeTotalMinor).toBe('26700');
  });

  it('ignores a snapshot taken against a different home currency', () => {
    const r = buildReportRollup(
      'CAD',
      [exp({ amountMinor: 10_000n, currencyCode: 'USD', fxRate: '0.9', fxHomeCurrency: 'EUR' })],
      rates,
    );
    expect(r.homeTotalMinor).toBe('13700');
  });

  it('converts recoverable tax at the same snapshot rate as its expense', () => {
    const r = buildReportRollup(
      'CAD',
      [
        exp({
          amountMinor: 11_300n,
          currencyCode: 'USD',
          recoverableGstHstMinor: 1_000n,
          fxRate: '1.30',
          fxHomeCurrency: 'CAD',
        }),
      ],
      rates,
    );
    expect(r.recoverableTotalMinor).toBe('1300');
  });

  it('excludes an unconvertible expense but keeps its convertible sibling', () => {
    const r = buildReportRollup(
      'CAD',
      [snap(10_000n, '1.30'), exp({ amountMinor: 5_000n, currencyCode: 'JPY' })],
      rates,
    );
    expect(r.homeTotalMinor).toBe('13000');
    expect(r.missingRates).toEqual(['JPY']);
  });
});

describe('withFxOverride (A4)', () => {
  it('overrides the foreign→home rate so the roll-up uses the statement rate', () => {
    const base = fxRateMapFrom([{ base: 'USD', quote: 'CAD', rate: { toString: () => '1.37' } }]);
    // AP pins USD→CAD at 1.40 (the card-statement rate).
    withFxOverride(base, 'CAD', { fromCurrency: 'USD', rate: '1.40' });
    const r = buildReportRollup('CAD', [exp({ amountMinor: 10_000n, currencyCode: 'USD' })], base);
    // $100 USD × 1.40 = $140.00 CAD (not 137.00).
    expect(r.homeTotalMinor).toBe('14000');
    expect(r.byCurrency[0].rate).toBe('1.40');
  });

  it('is a no-op when the override currency is the home currency', () => {
    const base = fxRateMapFrom([]);
    withFxOverride(base, 'CAD', { fromCurrency: 'CAD', rate: '2' });
    expect(base.get('CAD->CAD')).toBeUndefined();
  });

  it('is a no-op when there is no override', () => {
    const base = fxRateMapFrom([{ base: 'USD', quote: 'CAD', rate: { toString: () => '1.37' } }]);
    withFxOverride(base, 'CAD', null);
    expect(base.get('USD->CAD')).toBe('1.37');
  });
});

describe('fxRateMapFrom', () => {
  it('keeps the first (newest) row per pair', () => {
    const map = fxRateMapFrom([
      { base: 'USD', quote: 'CAD', rate: { toString: () => '1.37' } }, // newest
      { base: 'USD', quote: 'CAD', rate: { toString: () => '1.30' } }, // older, ignored
    ]);
    expect(map.get('USD->CAD')).toBe('1.37');
  });
});

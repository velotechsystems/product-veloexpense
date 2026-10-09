import { describe, expect, it } from 'vitest';
import { convertMoney } from './convert';
import { buildReportRollup, fxRateMapFrom, type RollupExpense } from './reportRollup';

/**
 * `FxRate` stores ONE direction per pair, and every seeded row quotes `X -> CAD`
 * because CAD is the reporting currency. A USD-denominated report holding a CAD line
 * therefore asked for `CAD -> USD`, got nothing, and `buildReportRollup` dropped the
 * line from the total rather than adding it in the wrong units.
 *
 * Live consequence on DEV (GA readiness report F34 / blocker B2): report EXP-000009
 * showed a header total of USD 2,871.46 while CAD 911.66 — about 23% of the claim —
 * was excluded, disclosed only in a hover tooltip on an approvable, payable document.
 *
 * `fxRateMapFrom` now fills each missing opposite direction with the reciprocal.
 */

const row = (base: string, quote: string, rate: string) => ({
  base,
  quote,
  rate: { toString: () => rate },
});

const exp = (
  o: Partial<RollupExpense> & { amountMinor: bigint; currencyCode: string },
): RollupExpense => o;

describe('fxRateMapFrom — derived reciprocals', () => {
  it('fills the missing opposite direction by exact integer division', () => {
    const m = fxRateMapFrom([row('USD', 'CAD', '1.3876')]);
    expect(m.get('USD->CAD')).toBe('1.3876');
    // 1 / 1.3876, to twelve places, with no float anywhere in the path.
    expect(m.get('CAD->USD')).toBe('0.720668780628');
  });

  it('never overwrites a real quoted row with a derived one', () => {
    // A genuine CAD->USD quote differs from 1/(USD->CAD) by the spread. The real
    // row has to win, whichever order the rows arrive in.
    const m = fxRateMapFrom([row('USD', 'CAD', '1.3876'), row('CAD', 'USD', '0.71')]);
    expect(m.get('CAD->USD')).toBe('0.71');

    const reversed = fxRateMapFrom([row('CAD', 'USD', '0.71'), row('USD', 'CAD', '1.3876')]);
    expect(reversed.get('CAD->USD')).toBe('0.71');
  });

  it('keeps the newest row per pair, and derives from that one', () => {
    // Rows arrive newest-first, so the first per pair wins — unchanged behaviour.
    const m = fxRateMapFrom([row('USD', 'CAD', '1.3876'), row('USD', 'CAD', '1.20')]);
    expect(m.get('USD->CAD')).toBe('1.3876');
    expect(m.get('CAD->USD')).toBe('0.720668780628');
  });

  it('does not invert an inverse it just derived', () => {
    const m = fxRateMapFrom([row('USD', 'CAD', '1.3876')]);
    // Exactly two entries: the row and its one inverse. A second pass over the
    // growing map would keep finding new work.
    expect([...m.keys()].sort()).toEqual(['CAD->USD', 'USD->CAD']);
  });

  it('stays inside the safe-integer budget on a long-tail rate', () => {
    // JPY quoted at 0.0067 inverts to 149.253731343284 — fifteen digits, the widest
    // `convertMoney` can scale without throwing. This is the case that would break
    // if the decimal places were allocated before the integer part was known.
    const m = fxRateMapFrom([row('JPY', 'USD', '0.0067')]);
    expect(m.get('USD->JPY')).toBe('149.253731343284');
    expect(() =>
      convertMoney({ amountMinor: 10_000n, currencyCode: 'USD' }, 'JPY', m),
    ).not.toThrow();
  });

  it('produces a clean integer when the reciprocal is one', () => {
    expect(fxRateMapFrom([row('A', 'B', '0.5')]).get('B->A')).toBe('2');
    expect(fxRateMapFrom([row('A', 'B', '2')]).get('B->A')).toBe('0.5');
  });

  it('derives nothing from a zero or negative rate', () => {
    expect(fxRateMapFrom([row('A', 'B', '0')]).has('B->A')).toBe(false);
    expect(fxRateMapFrom([row('A', 'B', '0.00')]).has('B->A')).toBe(false);
    expect(fxRateMapFrom([row('A', 'B', '-1.5')]).has('B->A')).toBe(false);
  });
});

describe('buildReportRollup — the EXP-000009 shape', () => {
  /** Only `X -> CAD` exists, exactly as the table is seeded. */
  const seeded = fxRateMapFrom([row('USD', 'CAD', '1.3876'), row('EUR', 'CAD', '1.49')]);

  it('values a CAD line on a USD report instead of dropping it', () => {
    const r = buildReportRollup(
      'USD',
      [
        exp({ amountMinor: 287_146n, currencyCode: 'USD' }),
        exp({ amountMinor: 91_166n, currencyCode: 'CAD' }),
      ],
      seeded,
    );

    expect(r.missingRates).toEqual([]);
    // CAD 911.66 × 0.720668780628 = USD 656.99 (half-even at cent scale), so the
    // total is no longer the USD lines alone.
    expect(r.homeTotalMinor).not.toBe('287146');
    const cad = r.byCurrency.find((c) => c.code === 'CAD');
    expect(cad?.convertedMinor).not.toBeNull();
    expect(BigInt(r.homeTotalMinor)).toBe(287_146n + BigInt(cad?.convertedMinor ?? '0'));
  });

  it('still reports a currency with no row in either direction as missing', () => {
    // The safety net stays: deriving an inverse cannot invent a pair that was never
    // quoted at all, and such a line must not be silently added in the wrong units.
    const r = buildReportRollup(
      'USD',
      [
        exp({ amountMinor: 100_00n, currencyCode: 'USD' }),
        exp({ amountMinor: 50_00n, currencyCode: 'GBP' }),
      ],
      seeded,
    );
    expect(r.missingRates).toEqual(['GBP']);
    expect(r.homeTotalMinor).toBe('10000');
  });
});

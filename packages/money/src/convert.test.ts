import { describe, expect, it } from 'vitest';
import { convertMoney } from './convert';
import type { Money } from './money';

const usd = (amountMinor: bigint): Money => ({ amountMinor, currencyCode: 'USD' });
const rates = (entries: [string, string][]) => new Map(entries);

describe('convertMoney', () => {
  it('returns the input unchanged for a same-currency conversion', () => {
    expect(convertMoney(usd(10_000n), 'USD', rates([]))).toEqual(usd(10_000n));
  });

  it('returns null when no rate is present', () => {
    expect(convertMoney(usd(10_000n), 'CAD', rates([]))).toBeNull();
  });

  it('converts to real minor units, NOT amount × 10^rateDecimals (regression)', () => {
    // 100.00 USD × 1.37 = 137.00 CAD = 13_700 cents (was 1_370_000 before the fix).
    const out = convertMoney(usd(10_000n), 'CAD', rates([['USD->CAD', '1.37']]));
    expect(out).toEqual({ amountMinor: 13_700n, currencyCode: 'CAD' });
  });

  it('handles a single-decimal rate', () => {
    // 100.00 USD × 1.5 = 150.00 CAD = 15_000 cents.
    expect(convertMoney(usd(10_000n), 'CAD', rates([['USD->CAD', '1.5']]))?.amountMinor).toBe(
      15_000n,
    );
  });

  it('an integer rate leaves the minor amount unchanged in scale', () => {
    expect(convertMoney(usd(10_000n), 'CAD', rates([['USD->CAD', '1']]))?.amountMinor).toBe(
      10_000n,
    );
  });

  it('preserves precision on an 8-decimal rate', () => {
    // 100.00 USD × 1.37000000 = 13_700 cents.
    expect(
      convertMoney(usd(10_000n), 'CAD', rates([['USD->CAD', '1.37000000']]))?.amountMinor,
    ).toBe(13_700n);
  });

  it('converts into a zero-exponent currency (JPY)', () => {
    // 100.00 USD × 150 = 15_000 JPY (whole yen; JPY exponent = 0).
    const out = convertMoney(usd(10_000n), 'JPY', rates([['USD->JPY', '150']]));
    expect(out).toEqual({ amountMinor: 15_000n, currencyCode: 'JPY' });
  });

  it('converts out of a zero-exponent currency (JPY → USD)', () => {
    // 15_000 JPY × 0.0088 = 132.00 USD = 13_200 cents.
    const out = convertMoney(
      { amountMinor: 15_000n, currencyCode: 'JPY' },
      'USD',
      rates([['JPY->USD', '0.0088']]),
    );
    expect(out).toEqual({ amountMinor: 13_200n, currencyCode: 'USD' });
  });
});

/**
 * VX1-6 — lib/money. Pure functions, no database: this suite is unaffected by
 * the shared-Postgres / fileParallelism:false constraint on the DB suites.
 *
 * The point of these is that money never round-trips through a float. Every
 * conversion is string/bigint math, so a typed "12.345" is rejected rather than
 * quietly becoming 12.34 and putting a report a cent away from its receipts.
 */
import { describe, it, expect } from 'vitest';
import { AmountError, formatMinor, minorToDecimalString, parseAmountToMinor } from '@/lib/money';

describe('minorToDecimalString', () => {
  it('places the decimal point by minor unit', () => {
    expect(minorToDecimalString('123456', 2)).toBe('1234.56');
    expect(minorToDecimalString(5, 2)).toBe('0.05');
    expect(minorToDecimalString(0, 2)).toBe('0.00');
    expect(minorToDecimalString('1234', 0)).toBe('1234');
  });

  it('keeps negatives (refunds and credits) intact', () => {
    expect(minorToDecimalString(-750, 2)).toBe('-7.50');
  });

  it('is exact past float precision', () => {
    expect(minorToDecimalString('900719925474099', 2)).toBe('9007199254740.99');
  });
});

describe('parseAmountToMinor', () => {
  it('accepts what people actually type', () => {
    expect(parseAmountToMinor('12.34', 2)).toBe(1234n);
    expect(parseAmountToMinor('12', 2)).toBe(1200n);
    expect(parseAmountToMinor('12.3', 2)).toBe(1230n);
    expect(parseAmountToMinor(' $1,234.56 ', 2)).toBe(123456n);
    expect(parseAmountToMinor('-5.00', 2)).toBe(-500n);
  });

  it('refuses to silently round away a decimal place', () => {
    expect(() => parseAmountToMinor('12.345', 2)).toThrow(AmountError);
  });

  it('refuses nonsense rather than guessing', () => {
    expect(() => parseAmountToMinor('', 2)).toThrow(AmountError);
    expect(() => parseAmountToMinor('twelve', 2)).toThrow(AmountError);
    expect(() => parseAmountToMinor('1.2.3', 2)).toThrow(AmountError);
  });
});

describe('formatMinor', () => {
  it('renders the report currency', () => {
    expect(formatMinor('123456', 'CAD', 2, 'en-CA')).toContain('1,234.56');
    expect(formatMinor(0, 'USD', 2, 'en-CA')).toContain('0.00');
  });
});

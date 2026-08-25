/**
 * VX1-6 — money helpers.
 *
 * Amounts are stored as bigint MINOR units (cents), which node-postgres hands
 * back as strings so nothing is lost to float. These helpers are the only place
 * that converts between that storage form and what a human types or reads, and
 * they do it with string math rather than division, so a 2^53-cent report is
 * still exact.
 *
 * `minorUnit` comes from the global `currency` reference table (CAD/USD = 2),
 * never from a hard-coded 100.
 */

export type MinorAmount = string | number | bigint;

export function toBigInt(amount: MinorAmount): bigint {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number') return BigInt(Math.trunc(amount));
  return BigInt(amount.trim() === '' ? '0' : amount.trim());
}

/** '123456' + minorUnit 2 -> '1234.56' (no symbol, no grouping). */
export function minorToDecimalString(amount: MinorAmount, minorUnit = 2): string {
  const value = toBigInt(amount);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(minorUnit + 1, '0');
  if (minorUnit === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -minorUnit);
  const fraction = digits.slice(-minorUnit);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Display form: '$1,234.56'. Falls back to a plain decimal for odd codes. */
export function formatMinor(
  amount: MinorAmount,
  currencyCode: string,
  minorUnit = 2,
  locale = 'en-CA',
): string {
  const decimal = minorToDecimalString(amount, minorUnit);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: minorUnit,
      maximumFractionDigits: minorUnit,
    }).format(Number(decimal));
  } catch {
    return `${decimal} ${currencyCode}`;
  }
}

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/**
 * What a person typed -> minor units. Accepts '12', '12.3', '1,234.56',
 * '$12.34', ' -5.00 '. Rejects anything else rather than guessing, and refuses
 * more decimal places than the currency has (silently rounding someone's
 * 12.345 to 12.34 is how a report stops matching its receipts).
 */
export function parseAmountToMinor(input: string, minorUnit = 2): bigint {
  const cleaned = input.trim().replace(/[\s,$]/g, '').replace(/,/g, '');
  if (cleaned === '') throw new AmountError('amount is required');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new AmountError(`"${input}" is not a valid amount`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > minorUnit) {
    throw new AmountError(
      `"${input}" has more than ${minorUnit} decimal place${minorUnit === 1 ? '' : 's'}`,
    );
  }
  const digits = `${whole}${fraction.padEnd(minorUnit, '0')}`;
  const value = BigInt(digits);
  return sign === '-' ? -value : value;
}

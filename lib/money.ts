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
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import type { UserMessage } from '@/lib/errors/domain';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { DomainError } from '@/lib/errors/domain';

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

/**
 * Display form: '$1,234.56'. Falls back to a plain decimal for odd codes.
 *
 * ── VX4-7: THE DEFAULT NOW COMES FROM THE REGISTRY (GAP-AUDIT IL-1/IL-10) ───
 *
 * `locale = 'en-CA'` was a literal here, and `lib/notifications/catalog.ts`
 * separately declared `DEFAULT_LOCALE = 'en'`. Two files, two answers to "what
 * language is this product", and `Intl` renders them differently — `en` gives
 * `CA$10,799.00` where `en-CA` gives `$10,799.00`. The tag now comes from
 * `lib/i18n/locales.ts` and nowhere else.
 *
 * The PARAMETER, though, is worth defending exactly as it stands. IL-10 calls
 * upstream's `formatMoney` "exemplary … requires an explicit reader locale and
 * derives symbol, position and separators from `Intl`", and contrasts it with
 * their 29 date calls that pass no locale and resolve to whatever the rendering
 * process happens to be set to. This signature has had the right shape since
 * VX1-6.
 *
 * What it has NOT had is a caller supplying it: all 23 call sites let the
 * default stand, so the parameter has been correct and inert. Threading the
 * reader's locale through those sites is part 1b of this ticket — which is why
 * the default is still here rather than the parameter being made required. A
 * required parameter today would be 23 mechanical edits in a PR about storage,
 * and mechanical edits are where a wrong `locale` gets pasted.
 */
export function formatMinor(
  amount: MinorAmount,
  currencyCode: string,
  minorUnit = 2,
  locale: string = DEFAULT_LOCALE,
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

export class AmountError extends DomainError {
  constructor(message: string,
    userMessage: UserMessageCode | UserMessage | null = null,
  ) {
    super(message, userMessage);
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
  if (cleaned === '') throw new AmountError('amount is required', 'AMOUNT_REQUIRED');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new AmountError(`"${input}" is not a valid amount`, {
      code: 'AMOUNT_MALFORMED',
      params: { given: String(input) },
    });
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > minorUnit) {
    throw new AmountError(
      `"${input}" has more than ${minorUnit} decimal place${minorUnit === 1 ? '' : 's'}`,
      // Two codes, not a parameter. The plural was computed inline here, and a
      // parameter whose only job is to pick a wording is a template language
      // starting up — see lib/errors/domain.ts.
      minorUnit === 1 ? 'AMOUNT_TOO_MANY_DECIMALS_ONE' : 'AMOUNT_TOO_MANY_DECIMALS_MANY',
    );
  }
  const digits = `${whole}${fraction.padEnd(minorUnit, '0')}`;
  const value = BigInt(digits);
  return sign === '-' ? -value : value;
}

/* ── currency conversion (VX3-2) ───────────────────────────────────────────── */

/**
 * A rate as it comes out of `fx_rate.rate` — a decimal string like '1.37000000'.
 * numeric(18,8) arrives from node-postgres as a string, which is the point: it
 * has not been through a float.
 */
export type RateString = string;

/** RATE_SCALE decimal places, matching `numeric(18,8)`. */
export const RATE_SCALE = 8;
const RATE_UNIT = 10n ** BigInt(RATE_SCALE);

/**
 * A decimal rate string -> an integer scaled by 10^8.
 *
 * Rejects rather than guesses. A rate is the multiplier on somebody's expense
 * limit; a silently-truncated or mis-parsed one produces a threshold nobody chose,
 * which is the whole failure PE-1 and PE-7 are about.
 */
export function rateToScaled(rate: RateString): bigint {
  const trimmed = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AmountError(`'${rate}' is not a positive decimal rate`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > RATE_SCALE) {
    throw new AmountError(
      `rate '${rate}' has ${fraction.length} decimal places; the column holds ${RATE_SCALE}`,
    );
  }
  const scaled = BigInt(whole + fraction.padEnd(RATE_SCALE, '0'));
  if (scaled === 0n) throw new AmountError(`rate '${rate}' is zero`);
  return scaled;
}

/** Half-even (banker's) rounding of a BigInt quotient. */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator < 0n) return divideHalfEven(-numerator, -denominator);
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const twice = remainder * 2n;
  let rounded = quotient;
  if (twice > denominator) rounded += 1n;
  // Exactly half: go to even, so a long run of conversions does not drift upward
  // the way half-up does. Matches the rounding `allocate` uses for splits.
  else if (twice === denominator && quotient % 2n === 1n) rounded += 1n;
  return negative ? -rounded : rounded;
}

/**
 * Convert minor units between currencies. Integer arithmetic throughout — no
 * float ever touches an amount or a rate.
 *
 * `rate` is quote-per-1-base for `from -> to`, exactly as `fx_rate` stores it.
 * The exponents are the two currencies' `minor_unit` values, because they are not
 * always equal (JPY has none) and hard-coding 100 is how a JPY amount becomes a
 * hundred times itself.
 *
 *   minor_to = amount_minor x rate x 10^(exp_to - exp_from)
 *
 * expressed as one rounded division so there is no intermediate truncation.
 */
export function convertMinor(
  amount: MinorAmount,
  rate: RateString | bigint,
  fromMinorUnit = 2,
  toMinorUnit = 2,
): bigint {
  const scaledRate = typeof rate === 'bigint' ? rate : rateToScaled(rate);
  const value = toBigInt(amount);
  let numerator = value * scaledRate;
  let denominator = RATE_UNIT;
  if (toMinorUnit >= fromMinorUnit) numerator *= 10n ** BigInt(toMinorUnit - fromMinorUnit);
  else denominator *= 10n ** BigInt(fromMinorUnit - toMinorUnit);
  return divideHalfEven(numerator, denominator);
}

/**
 * The reciprocal of a rate, as a scaled integer — `1 / rate`, to 8 places.
 *
 * This is PE-7's fix. ExpenseOS stores CAD-quoted pairs only (its source is the
 * Bank of Canada) and builds its lookup forward-only, so `CAD->USD` simply does
 * not exist and every CAD amount fails to convert for a tenant whose policy
 * currency is USD. Deriving the inverse costs one division; storing both
 * directions invites two rows that disagree.
 *
 * Not exact, and it does not pretend to be: 1/1.37 is not representable in eight
 * decimals, so a round trip can land one minor unit away from where it started.
 * That is a rounding error on a THRESHOLD COMPARISON, which is the right place to
 * accept one — as opposed to on a stored amount, where it would not be.
 */
export function reciprocalRate(rate: RateString | bigint): bigint {
  const scaled = typeof rate === 'bigint' ? rate : rateToScaled(rate);
  return divideHalfEven(RATE_UNIT * RATE_UNIT, scaled);
}

/** A scaled rate back to a decimal string, for a message or a payload. */
export function scaledRateToString(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(RATE_SCALE + 1, '0');
  const whole = digits.slice(0, -RATE_SCALE);
  const fraction = digits.slice(-RATE_SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

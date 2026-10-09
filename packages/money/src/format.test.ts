import { describe, expect, it } from 'vitest';
import { getCurrency, isKnownCurrency } from './currencies';
import { formatMoney } from './format';
import { fromWire, type Money, toWire } from './money';

/**
 * Rendering money, and the two things about it that are not obvious.
 *
 * **The exponent comes from dinero, not from Intl.** dinero says JPY has exponent 0;
 * Intl sometimes formats a currency it does not fully recognise as zero-exponent
 * regardless. Reading the exponent from one place and formatting with the other is how a
 * ¥500 charge renders as ¥5.00 — so the definition drives both the division and the
 * fraction digits.
 *
 * **An overflow throws rather than truncating.** These are financial figures; a display
 * string that silently lost precision is worse than an error, because nobody can tell by
 * looking that it is wrong.
 */

const money = (amountMinor: bigint, currencyCode: string): Money => ({
  amountMinor,
  currencyCode,
});

/** The reader locale for the assertions that are not ABOUT the locale. Explicit
 *  rather than defaulted, because `formatMoney` no longer has a default. */
const EN = { locale: 'en-US' } as const;

/** Intl groups fr-CA with a no-break space. Escaped, not literal: a literal one
 *  is indistinguishable from an ASCII space in a diff. */
const NBSP = '\u00A0';

/** Non-breaking and narrow-no-break spaces, which Intl uses in several locales. */
const flat = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatting', () => {
  it('renders a two-decimal currency with its symbol', () => {
    expect(flat(formatMoney(money(4200n, 'USD'), EN))).toBe('$42.00');
  });

  it('renders a zero-exponent currency with no decimals at all', () => {
    /**
     * The case the whole implementation note is about: 500 yen is ¥500, and dividing by
     * 100 or padding two decimals would misstate it by two orders of magnitude.
     */
    expect(flat(formatMoney(money(500n, 'JPY'), EN))).toBe('¥500');
  });

  it('renders a three-decimal currency to three places', () => {
    // Dinars have mils; truncating to cents would lose a digit that exists.
    expect(flat(formatMoney(money(1234n, 'BHD'), EN))).toContain('1.234');
  });

  it('follows the locale for symbol position and separators', () => {
    /**
     * The reason the locale is threaded through every money field: one report reading
     * "$1,234.56" in one row and "1 234,56 $" in the next is a report nobody trusts.
     */
    const enCA = formatMoney(money(123_456n, 'CAD'), { locale: 'en-CA' });
    const frCA = formatMoney(money(123_456n, 'CAD'), { locale: 'fr-CA' });
    expect(enCA).toBe('$1,234.56');
    // Un-flattened on purpose. `flat()` turns the fr-CA no-break space into an
    // ASCII one, so a flattened assertion cannot tell a correctly grouped
    // `1 234,56` from a wrongly grouped one — and the separator IS the thing
    // under test here.
    expect(frCA).toBe(`1${NBSP}234,56${NBSP}$`);
    expect(frCA).not.toBe(enCA);
    // Symbol side, which the position-blind `toContain` above never checked.
    expect(frCA.endsWith('$')).toBe(true);
    expect(enCA.startsWith('$')).toBe(true);
  });

  it('has NO default locale — the reader’s is the only one that can be right', () => {
    /**
     * There used to be an `?? 'en-US'` here, and it was the other half of the
     * render bug: every call that forgot to thread a locale silently produced
     * American money for a French-Canadian reader, and the omission typechecked.
     * `locale` is required now, so the assertion is on the TYPE — removing the
     * `locale` argument below must stop compiling, not start guessing.
     */
    // Never invoked: the assertion is the compile step. `npm run typecheck`
    // fails if either @ts-expect-error stops being an error.
    const _typeOnly = () => {
      // @ts-expect-error — locale is required; a call without one must not compile.
      formatMoney(money(4200n, 'USD'), {});
      // @ts-expect-error — nor may the options object be omitted entirely.
      formatMoney(money(4200n, 'USD'));
    };
    expect(_typeOnly).toBeTypeOf('function');
  });

  it('uses the NARROW symbol, so it reads beside an ISO code', () => {
    /**
     * Intl's default `currencyDisplay` disambiguates against the locale's own
     * currency: CAD in `en` becomes `CA$`, USD in `fr-CA` becomes `$ US`. Most
     * of the app prints the ISO code next to the figure, where that reads as
     * "CA$1,250.00 CAD". The narrow form is the glyph the `Currency` rows carry.
     */
    expect(formatMoney(money(1_079_900n, 'CAD'), { locale: 'en' })).toBe('$10,799.00');
    expect(formatMoney(money(-8040n, 'USD'), { locale: 'fr-CA' })).toBe(`-80,40${NBSP}$`);
    // Still locale-placed, which is the whole point of not building it by hand.
    expect(formatMoney(money(1_079_900n, 'CAD'), { locale: 'fr-CA' })).toBe(
      `10${NBSP}799,00${NBSP}$`,
    );
  });

  it('drops the symbol on request, keeping the decimals', () => {
    /**
     * For an inline form where the currency sits beside the input — with the symbol it
     * would appear twice, and without the decimals it would round.
     */
    expect(flat(formatMoney(money(4200n, 'USD'), { ...EN, noSymbol: true }))).toBe('42.00');
  });

  it('keeps the zero-exponent rule when the symbol is dropped', () => {
    expect(flat(formatMoney(money(500n, 'JPY'), { ...EN, noSymbol: true }))).toBe('500');
  });

  it('renders a negative amount as negative', () => {
    // Refunds and credit notes are negative money, not a separate kind of number.
    expect(flat(formatMoney(money(-4200n, 'USD'), EN))).toContain('42.00');
    expect(flat(formatMoney(money(-4200n, 'USD'), EN))).toMatch(/^-|\(/);
  });

  it('renders zero as zero, not as blank', () => {
    expect(flat(formatMoney(money(0n, 'USD'), EN))).toBe('$0.00');
  });

  it('groups a large amount', () => {
    expect(flat(formatMoney(money(123_456_789n, 'USD'), EN))).toBe('$1,234,567.89');
  });

  it('accepts a lowercase code, because the caller may pass a raw column', () => {
    expect(flat(formatMoney(money(4200n, 'usd'), EN))).toBe('$42.00');
  });
});

describe('what it refuses', () => {
  it('throws past the safe integer range rather than truncating', () => {
    /**
     * A display string that silently lost precision is worse than an error: nothing
     * about it looks wrong.
     */
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => formatMoney(money(tooBig, 'USD'), EN)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('throws on a large NEGATIVE amount too', () => {
    // The bound is a magnitude, and a huge credit is just as unrepresentable.
    const tooSmall = -(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => formatMoney(money(tooSmall, 'USD'), EN)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('formats right up to the boundary', () => {
    expect(() => formatMoney(money(BigInt(Number.MAX_SAFE_INTEGER), 'USD'), EN)).not.toThrow();
  });

  it('throws on a currency nothing recognises', () => {
    /**
     * The `Currency` table is the gate for allowed codes, so reaching this means
     * something bypassed it — and formatting a guess would hide that.
     */
    expect(() => formatMoney(money(4200n, 'XXZ'), EN)).toThrow(/Unknown currency/);
  });
});

describe('the currency lookup itself', () => {
  it('answers for a code it knows, case-insensitively', () => {
    expect(isKnownCurrency('cad')).toBe(true);
    expect(getCurrency('cad').code).toBe('CAD');
  });

  it('says no for a code it does not, rather than throwing', () => {
    // The callers that ask are validating input; a throw would make that awkward.
    expect(isKnownCurrency('XXZ')).toBe(false);
  });

  it('reports the exponent the formatter relies on', () => {
    expect(getCurrency('JPY').exponent).toBe(0);
    expect(getCurrency('USD').exponent).toBe(2);
  });
});

describe('crossing a JSON boundary', () => {
  it('string-encodes the amount, because JSON cannot carry a BigInt', () => {
    /**
     * `JSON.stringify` throws on a BigInt outright, so every tRPC and browser payload
     * goes through this — a hand-rolled conversion is how one boundary starts sending
     * numbers and losing cents on large totals.
     */
    expect(toWire(money(123_456_789_012n, 'CAD'))).toEqual({
      amountMinor: '123456789012',
      currencyCode: 'CAD',
    });
    expect(() => JSON.stringify(toWire(money(1n, 'CAD')))).not.toThrow();
  });

  it('round-trips without losing a digit', () => {
    const original = money(9_007_199_254_740_993n, 'CAD');
    expect(fromWire(toWire(original))).toEqual(original);
  });

  it('round-trips a negative amount', () => {
    const original = money(-4200n, 'USD');
    expect(fromWire(toWire(original))).toEqual(original);
  });
});

/**
 * CAD and USD share the `$` glyph, so `narrowSymbol` makes two amounts of two different
 * currencies print identically — and the reports list, which can hold both at once, gave
 * the reader no way to tell them apart (GA readiness report F54).
 */
describe('formatMoney withCode', () => {
  it('renders the ISO code where the symbol would go', () => {
    const cad = formatMoney(
      { amountMinor: 352917n, currencyCode: 'CAD' },
      {
        locale: 'en',
        withCode: true,
      },
    );
    const usd = formatMoney(
      { amountMinor: 352917n, currencyCode: 'USD' },
      {
        locale: 'en',
        withCode: true,
      },
    );
    expect(cad).toContain('CAD');
    expect(usd).toContain('USD');
    // The whole point: the two must not be the same string.
    expect(cad).not.toBe(usd);
  });

  it('is indistinguishable WITHOUT it — which is the bug', () => {
    const cad = formatMoney({ amountMinor: 352917n, currencyCode: 'CAD' }, { locale: 'en' });
    const usd = formatMoney({ amountMinor: 352917n, currencyCode: 'USD' }, { locale: 'en' });
    expect(cad).toBe(usd);
  });

  it('puts the code where the locale puts it', () => {
    // en leads, fr-CA trails. Intl decides; this pins that we let it.
    expect(
      formatMoney({ amountMinor: 100000n, currencyCode: 'CAD' }, { locale: 'en', withCode: true }),
    ).toMatch(/^CAD/);
    expect(
      formatMoney(
        { amountMinor: 100000n, currencyCode: 'CAD' },
        { locale: 'fr-CA', withCode: true },
      ),
    ).toMatch(/CAD$/);
  });

  it('yields to noSymbol — that asks for a bare number', () => {
    const bare = formatMoney(
      { amountMinor: 100000n, currencyCode: 'CAD' },
      {
        locale: 'en',
        noSymbol: true,
        withCode: true,
      },
    );
    expect(bare).not.toContain('CAD');
    expect(bare).not.toContain('$');
  });

  it('keeps the currency exponent', () => {
    // JPY has no minor unit; the code must not drag a 2-decimal assumption in with it.
    expect(
      formatMoney({ amountMinor: 1000n, currencyCode: 'JPY' }, { locale: 'en', withCode: true }),
    ).toContain('1,000');
  });
});

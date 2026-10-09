import { describe, expect, it } from 'vitest';
import {
  displayName,
  formatMinor,
  majorToMinor,
  minorToMajorInput,
  pickText,
  sanitizeMoneyText,
  sumInHome,
} from './format';

const USD = { code: 'USD', symbol: '$' };

/** Intl groups fr-CA with a NO-BREAK space (U+00A0) and separates the trailing
 *  symbol with one too. Written as an escape on purpose: a literal U+00A0 is
 *  indistinguishable from an ASCII space in a diff or a review, so a test that
 *  had accidentally matched the wrong character would look correct. */
const NBSP = '\u00A0';

describe('pickText', () => {
  it('returns the requested locale when present', () => {
    expect(pickText({ en: 'Meals', 'fr-CA': 'Repas' }, 'fr-CA')).toBe('Repas');
  });

  it('falls back to en when the requested locale is missing', () => {
    expect(pickText({ en: 'Meals', 'fr-CA': 'Repas' }, 'de')).toBe('Meals');
  });

  it('falls back to the first available value when neither locale nor en exist', () => {
    expect(pickText({ 'fr-CA': 'Repas' }, 'en')).toBe('Repas');
  });

  it('returns empty string for an empty object', () => {
    expect(pickText({}, 'en')).toBe('');
  });

  it('passes a plain string through unchanged', () => {
    expect(pickText('literal', 'en')).toBe('literal');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', true],
  ])('returns empty string for non-object, non-string value (%s)', (_label, value) => {
    expect(pickText(value, 'en')).toBe('');
  });
});

describe('displayName', () => {
  it('joins first and last name', () => {
    expect(displayName({ firstName: 'Ada', lastName: 'Lovelace', email: 'a@e.inc' })).toBe(
      'Ada Lovelace',
    );
  });

  it('uses first name alone when last name is null', () => {
    expect(displayName({ firstName: 'Ada', lastName: null, email: 'a@e.inc' })).toBe('Ada');
  });

  it('uses last name alone when first name is null', () => {
    expect(displayName({ firstName: null, lastName: 'Lovelace', email: 'a@e.inc' })).toBe(
      'Lovelace',
    );
  });

  it('falls back to email when both names are null', () => {
    expect(displayName({ firstName: null, lastName: null, email: 'a@e.inc' })).toBe('a@e.inc');
  });

  it('falls back to email when both names are empty strings', () => {
    expect(displayName({ firstName: '', lastName: '', email: 'a@e.inc' })).toBe('a@e.inc');
  });
});

describe('formatMinor', () => {
  it('renders an em dash for null', () => {
    expect(formatMinor(null, USD, 'en')).toBe('—');
  });

  it('formats zero with two decimals and the symbol', () => {
    expect(formatMinor(0, USD, 'en')).toBe('$0.00');
  });

  it('formats a bigint minor amount', () => {
    expect(formatMinor(12345n, USD, 'en')).toBe('$123.45');
  });

  it('formats a number minor amount', () => {
    expect(formatMinor(12345, USD, 'en')).toBe('$123.45');
  });

  it('rounds to two decimals', () => {
    expect(formatMinor(199, USD, 'en')).toBe('$1.99');
  });

  it('suppresses the symbol when the caller passes an empty one', () => {
    expect(formatMinor(500, { code: 'EUR', symbol: '€' }, 'en')).toBe('€5.00');
    expect(formatMinor(500, { code: 'USD', symbol: '' }, 'en')).toBe('5.00');
  });

  it('suppresses the symbol when the currency row carries none at all', () => {
    // `{ code }` with no `symbol` is the shape a dozen call sites pass when they
    // print the ISO code beside the figure themselves; it must stay bare.
    expect(formatMinor(500, { code: 'USD' }, 'en')).toBe('5.00');
  });

  it('keeps the sign for negative amounts', () => {
    // `-$5.00`, not `$-5.00`: the minus leads, because that is where en puts it.
    expect(formatMinor(-500, USD, 'en')).toBe('-$5.00');
  });

  it('scales by the currency exponent — JPY has 0 decimals', () => {
    // ¥1130 is stored as 1130 minor; it must render ¥1,130, not ¥11.30.
    expect(formatMinor(1130, { code: 'JPY', symbol: '¥' }, 'en')).toBe('¥1,130');
  });

  it('scales by the currency exponent — KWD has 3 decimals', () => {
    // 1500 fils = 1.500 dinar, not 15.00.
    // No narrow symbol exists for KWD, so Intl falls back to the code itself.
    expect(formatMinor(1500, { code: 'KWD', symbol: 'KD' }, 'en')).toBe(`KWD${NBSP}1.500`);
  });

  it('unknown code falls back to 2 decimals (never throws)', () => {
    expect(formatMinor(12345, { code: 'ZZZ', symbol: '' }, 'en')).toBe('123.45');
  });

  it('a blank currency code still formats in the reader locale', () => {
    // Import previews carry rows with no resolved currency; the amount is still
    // the reader's to read.
    expect(formatMinor(1_079_900, { code: '' }, 'fr-CA')).toBe(`10${NBSP}799,00`);
    expect(formatMinor(1_079_900, { code: '' }, 'en')).toBe('10,799.00');
  });
});

/**
 * The reported bug, pinned from both ends.
 *
 * `10 799,00 $` is not a prettier `$10,799.00` — it differs in three
 * independent ways (which side the symbol sits on, the grouping character, the
 * decimal character), and the old implementation could not produce it at all:
 * it hard-coded the symbol in front and passed `undefined` to
 * `toLocaleString`, which resolves to the RUNTIME's locale (the Node process on
 * the server, the browser's setting on the client) rather than the reader's.
 *
 * Every assertion below is written to fail on a build that returns English to
 * everyone. `expect(fr).toContain('799')` would not have been.
 */
describe('formatMinor — the reader locale decides, not the runtime', () => {
  const CAD = { code: 'CAD', symbol: '$' };
  /** 10,799.00 CAD in minor units — the figure from the bug report. */
  const AMOUNT = 1_079_900n;

  it('renders the FR-CA form exactly, symbol trailing', () => {
    expect(formatMinor(AMOUNT, CAD, 'fr-CA')).toBe(`10${NBSP}799,00${NBSP}$`);
  });

  it('renders the EN form exactly, symbol leading', () => {
    expect(formatMinor(AMOUNT, CAD, 'en')).toBe('$10,799.00');
  });

  it('gives the SAME amount two DIFFERENT strings in en and fr-CA', () => {
    // The one assertion no hardcoded-locale build can satisfy, whichever locale
    // it hardcodes.
    expect(formatMinor(AMOUNT, CAD, 'fr-CA')).not.toBe(formatMinor(AMOUNT, CAD, 'en'));
  });

  it('puts the symbol AFTER the digits in fr-CA and BEFORE them in en', () => {
    // Position, not presence: the old `${symbol}${digits}` template could pass a
    // "contains a $" check while being wrong for every trailing-symbol locale.
    const fr = formatMinor(AMOUNT, CAD, 'fr-CA');
    const en = formatMinor(AMOUNT, CAD, 'en');
    expect(fr.endsWith('$')).toBe(true);
    expect(fr.startsWith('1')).toBe(true);
    expect(en.endsWith('$')).toBe(false);
    expect(en.indexOf('$')).toBeLessThan(en.indexOf('1'));
  });

  it('groups fr-CA with U+00A0 — not a comma, and not an ASCII space', () => {
    const fr = formatMinor(AMOUNT, CAD, 'fr-CA');
    expect(fr).toContain(`10${NBSP}799`);
    expect(fr).not.toContain('10 799');
    expect(fr).not.toContain('10,799');
  });

  it('uses a comma decimal in fr-CA and a period decimal in en', () => {
    expect(formatMinor(AMOUNT, CAD, 'fr-CA')).toContain('799,00');
    expect(formatMinor(AMOUNT, CAD, 'en')).toContain('799.00');
  });

  it('keeps the locale split when the symbol is suppressed', () => {
    // The `{ symbol: '' }` call sites (the report FX breakdown, the statement
    // dialog) print the ISO code themselves — the DIGITS still have to be
    // localized, which is the half a symbol-only fix would have missed.
    expect(formatMinor(AMOUNT, { code: 'CAD', symbol: '' }, 'fr-CA')).toBe(`10${NBSP}799,00`);
    expect(formatMinor(AMOUNT, { code: 'CAD', symbol: '' }, 'en')).toBe('10,799.00');
  });

  it('splits a zero-exponent currency by locale too', () => {
    expect(formatMinor(1130n, { code: 'JPY', symbol: '¥' }, 'fr-CA')).toBe(`1${NBSP}130${NBSP}¥`);
    expect(formatMinor(1130n, { code: 'JPY', symbol: '¥' }, 'en')).toBe('¥1,130');
  });

  it('ignores the stored symbol glyph — Intl owns it, so its side can be right', () => {
    // A stored glyph cannot be honoured AND placed correctly, because placement
    // comes from the locale. A nonsense stored symbol must not reach the output.
    expect(formatMinor(AMOUNT, { code: 'CAD', symbol: 'XYZ' }, 'fr-CA')).toBe(
      `10${NBSP}799,00${NBSP}$`,
    );
  });
});

describe('majorToMinor / minorToMajorInput (exponent-aware money input round-trip)', () => {
  it('parses a typed major amount at the currency exponent', () => {
    expect(majorToMinor('11.30', 'USD', 'en')).toBe(1130n); // 2 decimals
    expect(majorToMinor('1130', 'JPY', 'en')).toBe(1130n); // 0 decimals — not ×100
    expect(majorToMinor('1.500', 'KWD', 'en')).toBe(1500n); // 3 decimals
    expect(majorToMinor('', 'USD', 'en')).toBeNull();
    expect(majorToMinor(null, 'USD', 'en')).toBeNull();
  });

  it('seeds an input field with the exponent-correct decimal string', () => {
    expect(minorToMajorInput(1130n, 'USD')).toBe('11.30');
    expect(minorToMajorInput(1130n, 'JPY')).toBe('1130');
    expect(minorToMajorInput(1500n, 'KWD')).toBe('1.500');
    expect(minorToMajorInput(null, 'USD')).toBe('');
  });
});

/**
 * The same bug pointing inwards. `majorToMinor` was `Number(major)`, so the only
 * notation it ever accepted was `1234.56`. A French-Canadian typing their own
 * notation into a localized field got `NaN` → `null`, and the callers that
 * coalesce that null with `?? 0n` (the budget monthly spread, the tip commit)
 * saved a ZERO rather than refusing the amount.
 */
describe('majorToMinor — reads the amount in the reader notation', () => {
  it('accepts the FR-CA form a fr-CA reader types', () => {
    expect(majorToMinor('10 799,00', 'CAD', 'fr-CA')).toBe(1_079_900n);
    expect(majorToMinor(`10${NBSP}799,00`, 'CAD', 'fr-CA')).toBe(1_079_900n);
    expect(majorToMinor('10799,00', 'CAD', 'fr-CA')).toBe(1_079_900n);
  });

  it('still accepts the period form in fr-CA (a US keyboard is not a lockout)', () => {
    expect(majorToMinor('10799.00', 'CAD', 'fr-CA')).toBe(1_079_900n);
  });

  it('accepts the EN form in en, grouping comma included', () => {
    expect(majorToMinor('10,799.00', 'CAD', 'en')).toBe(1_079_900n);
    expect(majorToMinor('10799.00', 'CAD', 'en')).toBe(1_079_900n);
  });

  it('the SAME text parses differently in en and fr-CA', () => {
    // "1,5" is one and a half in fr-CA. In en it is a malformed group and has to
    // be refused rather than silently read as 15. No locale-blind parser can do
    // both, which is why the locale is a required argument and not a guess.
    expect(majorToMinor('1,5', 'CAD', 'fr-CA')).toBe(150n);
    expect(majorToMinor('1,5', 'CAD', 'en')).toBeNull();
  });

  it('REFUSES a comma-decimal amount in en rather than multiplying it by 100', () => {
    // The dangerous near-miss: stripping ',' as a grouping character would turn
    // 10799,00 into 1079900 — a silent 100x on a saved money field. Refusing an
    // ambiguous amount is the only safe answer.
    expect(majorToMinor('10799,00', 'CAD', 'en')).toBeNull();
  });

  it('refuses two decimal separators and other garbage in both locales', () => {
    for (const loc of ['en', 'fr-CA']) {
      expect(majorToMinor('1.2.3', 'CAD', loc)).toBeNull();
      expect(majorToMinor('abc', 'CAD', loc)).toBeNull();
      expect(majorToMinor('   ', 'CAD', loc)).toBeNull();
    }
  });

  it('keeps the sign and the exponent across locales', () => {
    expect(majorToMinor('-5,00', 'CAD', 'fr-CA')).toBe(-500n);
    expect(majorToMinor('-5.00', 'CAD', 'en')).toBe(-500n);
    expect(majorToMinor('1 130', 'JPY', 'fr-CA')).toBe(1130n);
    expect(majorToMinor('1,500', 'KWD', 'fr-CA')).toBe(1500n); // comma = decimal
    expect(majorToMinor('1.500', 'KWD', 'en')).toBe(1500n); // period = decimal
  });

  it('passes a numeric input through untouched — a number has no notation', () => {
    // Machine-produced values (receipt-extraction totals) arrive as numbers and
    // must not be run through any locale parse.
    expect(majorToMinor(107.99, 'CAD', 'fr-CA')).toBe(10_799n);
    expect(majorToMinor(107.99, 'CAD', 'en')).toBe(10_799n);
  });

  it('round-trips the seed string in both locales', () => {
    // `minorToMajorInput` is deliberately NOT localized (several callers feed its
    // output to `Number()` or to a CSV export), so it has to parse in either.
    const seed = minorToMajorInput(1_079_900n, 'CAD');
    expect(seed).toBe('10799.00');
    expect(majorToMinor(seed, 'CAD', 'en')).toBe(1_079_900n);
    expect(majorToMinor(seed, 'CAD', 'fr-CA')).toBe(1_079_900n);
  });
});

/**
 * The money-field filter.
 *
 * The audit typed `abc<b>x</b>` into a `$` field and it was accepted (GA readiness report
 * F06). The only consequence was a save that never happened — the value could not be
 * converted — so the bogus text sat there looking exactly like a saved amount.
 *
 * A FILTER, not a validator, and the distinction is the whole contract: it has to let a
 * HALF-TYPED amount through, because people type one character at a time. What it makes
 * impossible is getting prose into the field at all.
 */
describe('sanitizeMoneyText', () => {
  it('drops letters and markup', () => {
    expect(sanitizeMoneyText('abc<b>x</b>', 'en')).toBe('');
    expect(sanitizeMoneyText('twelve dollars', 'en')).toBe('');
    expect(sanitizeMoneyText('12abc34', 'en')).toBe('1234');
  });

  it('lets a HALF-TYPED amount through', () => {
    // The reason this is not a validator. Refusing these would make the field unusable.
    for (const partial of ['', '-', '12.', '1']) {
      expect(sanitizeMoneyText(partial, 'en')).toBe(partial);
    }
  });

  it('keeps the reader’s own decimal character', () => {
    // A French-Canadian typing "12,50" is not making a mistake, and stripping their comma
    // would be.
    expect(sanitizeMoneyText('12,50', 'fr-CA')).toBe('12,50');
    // …and still accepts a pasted machine value, the same tolerance majorToMinor applies.
    expect(sanitizeMoneyText('12.50', 'fr-CA')).toBe('12.50');
  });

  it('allows one decimal mark, not two', () => {
    expect(sanitizeMoneyText('12.5.5', 'en')).toBe('12.55');
  });

  it('allows a sign only at the front, and only once', () => {
    // "1-2" is not a number anybody means.
    expect(sanitizeMoneyText('-12', 'en')).toBe('-12');
    expect(sanitizeMoneyText('1-2', 'en')).toBe('12');
    expect(sanitizeMoneyText('--12', 'en')).toBe('-12');
  });

  it('passes grouping characters through for majorToMinor to strip', () => {
    expect(sanitizeMoneyText('1,234.50', 'en')).toBe('1,234.50');
  });

  it('drops a currency symbol pasted with the amount', () => {
    expect(sanitizeMoneyText('$12.50', 'en')).toBe('12.50');
  });

  it('round-trips into majorToMinor', () => {
    // The contract that matters: whatever survives the filter has to be convertible, or the
    // filter has merely moved the problem.
    expect(majorToMinor(sanitizeMoneyText('$1,234.50', 'en'), 'CAD', 'en')).toBe(123450n);
  });
});

describe('sumInHome', () => {
  it('adds up converted totals arriving as decimal strings', () => {
    // bigint does not survive JSON, so the routers hand these over as strings.
    expect(sumInHome(['1000', '250', '3'])).toEqual({ minor: 1253n, excluded: 0 });
  });

  it('reports a real zero for an empty list', () => {
    // The only zero this function can produce that actually means "nothing to add up".
    expect(sumInHome([])).toEqual({ minor: 0n, excluded: 0 });
  });

  it('EXCLUDES a null rather than treating it as zero', () => {
    /**
     * The whole reason this function exists. `null` is "no FX rate connects this report's
     * currency to the reader's" — an amount that is unknown, not an amount that is nought.
     * A `?? 0` here would return 1000n with excluded 0, and the panel would state a total
     * of $10.00 with nothing on screen admitting a report had been left out. Understating
     * money silently is the failure mode; the count is what lets the caller confess.
     */
    expect(sumInHome(['1000', null])).toEqual({ minor: 1000n, excluded: 1 });
  });

  it('counts every excluded amount, not just the first', () => {
    expect(sumInHome([null, '500', null, null])).toEqual({ minor: 500n, excluded: 3 });
  });

  it('reports zero-with-exclusions distinctly from a genuine zero', () => {
    /**
     * `{ minor: 0n, excluded: 2 }` and `{ minor: 0n, excluded: 0 }` are different claims —
     * "we cannot total these" versus "these total nothing" — and a caller that renders
     * only `minor` collapses them into the same $0.00.
     */
    expect(sumInHome([null, null])).toEqual({ minor: 0n, excluded: 2 });
    expect(sumInHome(['0', '0'])).toEqual({ minor: 0n, excluded: 0 });
  });

  it('handles a negative total (a credit) without special-casing it', () => {
    expect(sumInHome(['-2500', '1000'])).toEqual({ minor: -1500n, excluded: 0 });
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // Minor units, summed as bigint on purpose: doing this in `number` starts losing cents
    // somewhere around $90 trillion, and does it without complaining.
    expect(sumInHome(['9007199254740993', '2'])).toEqual({
      minor: 9007199254740995n,
      excluded: 0,
    });
  });
});

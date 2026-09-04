/**
 * VX4-8 part 2 — the fraud catalogue's own properties, without a database.
 *
 * `test/fraud-rules.db.test.ts` proves the sentences can be said FROM REAL
 * FINDINGS, which is the assertion that needs data. This file proves the three
 * things that do not:
 *
 *   1. every code has copy in the default locale and resolves in every shipped
 *      one;
 *   2. the COPY falls back down the locale chain and the FORMATTING does not —
 *      the defect VX4-7 part 2b introduced inside its own fix, where the copy's
 *      locale was handed to `Intl` instead of the reader's;
 *   3. a row that cannot satisfy its sentence renders the marker rather than a
 *      sentence with a hole in it.
 */
import { describe, it, expect } from 'vitest';
import {
  FRAUD_MESSAGES,
  FRAUD_MESSAGE_CODES,
  isFraudMessageCode,
  renderFraudMessage,
} from '@/lib/i18n/catalog/fraud-messages';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/lib/i18n/locales';

/** Data that satisfies every declared key of every code, for the coverage walk. */
const SAMPLE: Record<string, unknown> = {
  merchant: 'Beck Taxi',
  amountMinor: '415000',
  currencyCode: 'CAD',
  minorUnit: 2,
  otherDate: '2026-03-04',
  otherReportNumber: 'EXP-000123',
  windowDays: 3,
  sigmas: 4.25,
  meanMinor: '41337',
  samples: 12,
  lookbackDays: 90,
  violatedExpenses: 3,
  expenses: 4,
  violations: 7,
  approverName: 'Ann Approver',
  submitterName: 'Sam Submitter',
  pairApprovals: 10,
  totalApprovals: 10,
};

describe('coverage', () => {
  it('every code is authored in the default locale and resolves in all of them', () => {
    for (const code of FRAUD_MESSAGE_CODES) {
      const definition = FRAUD_MESSAGES[code];
      expect(definition.copy[DEFAULT_LOCALE], `${code} has no ${DEFAULT_LOCALE} copy`).toBeTypeOf(
        'function',
      );
      for (const locale of SUPPORTED_LOCALES) {
        const text = renderFraudMessage(code, SAMPLE, locale);
        expect(text, `${code} in ${locale}`).not.toMatch(/^\{.*\}$/);
        expect(text.trim().length, `${code} in ${locale} is blank`).toBeGreaterThan(0);
      }
    }
  });

  it('the guard and the array agree', () => {
    for (const code of FRAUD_MESSAGE_CODES) expect(isFraudMessageCode(code)).toBe(true);
    expect(isFraudMessageCode('NOT_A_CODE')).toBe(false);
  });

  it('declares no key the sample does not have — the list is not aspirational', () => {
    // A `requires` entry naming a key nothing ever supplies is a sentence that
    // can only ever render as the marker. Cheap to state, and it caught a typo.
    for (const code of FRAUD_MESSAGE_CODES) {
      for (const key of FRAUD_MESSAGES[code].requires) {
        expect(Object.prototype.hasOwnProperty.call(SAMPLE, key), `${code}.${key}`).toBe(true);
      }
    }
  });
});

describe('the reader decides the formatting, not the copy', () => {
  it('money is formatted in the READER\'s locale even when the copy is en-CA', () => {
    // There is only one authored locale today, so an en-US reader falls back to
    // en-CA COPY — and must still get en-US MONEY. Part 2b passed the copy's
    // locale to Intl and its own test caught it; this is that test, here.
    const enCA = renderFraudMessage('AMOUNT_OUTLIER', SAMPLE, 'en-CA');
    const enUS = renderFraudMessage('AMOUNT_OUTLIER', SAMPLE, 'en-US');
    expect(enCA).toContain('$4,150.00');
    // `Intl` disambiguates a currency that is not the reader's own — IL-1's
    // finding pointing the useful way.
    expect(enUS).toContain('CA$4,150.00');
    expect(enUS).not.toBe(enCA);
  });

  it('a date is formatted in the reader\'s locale', () => {
    const enCA = renderFraudMessage('DUPLICATE_SAME_REPORT', SAMPLE, 'en-CA');
    const enUS = renderFraudMessage('DUPLICATE_SAME_REPORT', SAMPLE, 'en-US');
    expect(enCA).toContain('2026-03-04');
    expect(enUS).toContain('03/04/2026');
  });

  it('an unsupported tag formats in the default rather than in itself', () => {
    // By the time a row reaches the renderer the locale has been through
    // `resolveLocale`, so anything else is a caller passing a raw header.
    expect(renderFraudMessage('AMOUNT_OUTLIER', SAMPLE, 'de-DE')).toBe(
      renderFraudMessage('AMOUNT_OUTLIER', SAMPLE, DEFAULT_LOCALE),
    );
  });
});

describe('a row that cannot satisfy its sentence', () => {
  it('renders the marker rather than a sentence with a hole in it', () => {
    const { merchant, ...withoutMerchant } = SAMPLE;
    expect(merchant).toBeDefined();
    const text = renderFraudMessage('DUPLICATE_SAME_REPORT', withoutMerchant, DEFAULT_LOCALE);
    expect(text).toMatch(/^\{.*\}$/);
    expect(text).not.toContain('undefined');
  });

  it('a blank string is not an answer for a key the sentence declared', () => {
    const text = renderFraudMessage(
      'DUPLICATE_SAME_REPORT',
      { ...SAMPLE, merchant: '   ' },
      DEFAULT_LOCALE,
    );
    expect(text).toMatch(/^\{.*\}$/);
  });

  it('a count that is not a whole number is refused rather than rounded', () => {
    // 3.5 entries is a query returning something other than what the sentence
    // claims to describe. Rounding it to 4 would put a plausible wrong number in
    // front of a reviewer.
    const text = renderFraudMessage(
      'VIOLATION_DENSITY',
      { ...SAMPLE, violatedExpenses: 3.5 },
      DEFAULT_LOCALE,
    );
    expect(text).toMatch(/^\{.*\}$/);
  });

  it('an unknown code is a marker, not a throw', () => {
    expect(renderFraudMessage('NO_SUCH_CODE', SAMPLE, DEFAULT_LOCALE)).toMatch(/^\{.*\}$/);
  });
});

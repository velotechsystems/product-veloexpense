import { describe, expect, it } from 'vitest';
import { violationValues } from './parts';

/**
 * Placeholder values for a policy label.
 *
 * The bug this fixes rendered "Receipt required over {threshold}" to the person it was meant to
 * inform — the engine stores the message KEY and a structured payload, and nothing was assembling
 * the sentence. Interpolating on the FE rather than when the rule fires is deliberate: a violation
 * is read by the submitter AND by approvers who need not share a language.
 */

const violation = (data: unknown) =>
  ({ severity: 'BLOCK', message: 'receiptThresholdBlock', lineItemId: 'l1', data }) as never;

describe('violationValues', () => {
  it('formats the threshold from the payload the engine emitted', () => {
    expect(
      violationValues(violation({ thresholdMinor: '7500', policyCurrency: 'USD' }), 'en'),
    ).toEqual({
      threshold: '75.00',
    });
  });

  it('scales by the currency exponent rather than assuming two decimals', () => {
    // JPY has no minor unit; dividing by 100 would report ¥75 as ¥0.75.
    expect(
      violationValues(violation({ thresholdMinor: '7500', policyCurrency: 'JPY' }), 'en'),
    ).toEqual({
      threshold: '7,500',
    });
  });

  it('accepts a numeric threshold as well as a string', () => {
    expect(
      violationValues(violation({ thresholdMinor: 2500, policyCurrency: 'CAD' }), 'en'),
    ).toEqual({
      threshold: '25.00',
    });
  });

  it('returns undefined when the payload cannot supply the value', () => {
    // next-intl then renders the placeholder, which is visibly wrong — the right failure for a
    // missing payload, rather than inventing a number in a sentence about somebody's money.
    expect(violationValues(violation(null), 'en')).toBeUndefined();
    expect(violationValues(violation({}), 'en')).toBeUndefined();
    expect(violationValues(violation({ thresholdMinor: '7500' }), 'en')).toBeUndefined();
    expect(violationValues(violation({ policyCurrency: 'USD' }), 'en')).toBeUndefined();
  });

  it('ignores a payload whose threshold is not a number', () => {
    expect(
      violationValues(violation({ thresholdMinor: { nested: true }, policyCurrency: 'USD' }), 'en'),
    ).toBeUndefined();
  });

  it('renders the threshold in the READER locale, not one fixed locale', () => {
    // A violation is read by the submitter AND by approvers who need not share a
    // language, so the amount inside the sentence has to follow the reader the
    // way the sentence around it already does.
    // No symbol: the payload carries the policy currency code, which the label
    // itself names. The DIGITS are still the reader's — group and decimal both.
    const v = violation({ thresholdMinor: '1079900', policyCurrency: 'CAD' });
    expect(violationValues(v, 'en')?.threshold).toBe('10,799.00');
    expect(violationValues(v, 'fr-CA')?.threshold).toBe('10\u00A0799,00');
    expect(violationValues(v, 'fr-CA')?.threshold).not.toBe(violationValues(v, 'en')?.threshold);
  });
});

import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, isCountryCode } from '@/lib/countries';

describe('isCountryCode (f75)', () => {
  it('accepts every assigned ISO-3166-1 alpha-2 code', () => {
    for (const code of COUNTRY_CODES) expect(isCountryCode(code)).toBe(true);
    expect(COUNTRY_CODES.length).toBe(249);
  });

  it.each(['XX', 'ZZ', 'AA', 'UK', 'ca', 'Ca', 'CAN', 'C', '', ' CA', null, undefined, 12])(
    'refuses %p',
    (value) => {
      expect(isCountryCode(value)).toBe(false);
    },
  );
});

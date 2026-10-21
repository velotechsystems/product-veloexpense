import '@testing-library/jest-dom/vitest';
import enExpenses from '@expenseos/i18n/catalogs/en/expenses';
import enPeople from '@expenseos/i18n/catalogs/en/people';
import frExpenses from '@expenseos/i18n/catalogs/fr-CA/expenses';
import frPeople from '@expenseos/i18n/catalogs/fr-CA/people';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import type { MileageYtdRow } from '@/server/routers/mileageBalances';
import { MileageYtdLines } from './MileageYtdLines';

/**
 * MileageYtdLines — the year-to-date sentences of the People drawer's "Mileage this year" row.
 *
 * Rendered through next-intl against the REAL catalogs, not a key-echo mock. Nothing in the
 * gate parses ICU (`check-coverage` compares keys, `check-used-keys` resolves them), so a
 * malformed message or a `select` branch that never matches would reach the page. This file
 * is the only thing that reads the actual sentences.
 *
 * FR-CA grouping and dates use no-break spaces whose code point depends on the ICU build, so
 * text is compared with every space folded to a plain one.
 */

const fold = (s: string | null | undefined) => (s ?? '').replace(/\s/gu, ' ');

const TWO_TIERS = [
  { fromDistance: '0.00', rateMinor: '72' },
  { fromDistance: '5000.00', rateMinor: '66' },
];

function row(over: Partial<MileageYtdRow> = {}): MileageYtdRow {
  return {
    country: 'CA',
    unit: 'KM',
    carried: '0.00',
    claimed: '4210.00',
    pending: '0.00',
    total: '4210.00',
    carriedThrough: null,
    rule: { ruleId: 'rule-ca', isCarAllowance: false, tiers: TWO_TIERS },
    bandIndex: 0,
    bandFrom: '0.00',
    nextBoundary: '5000.00',
    remaining: '790.00',
    crossedAt: null,
    ...over,
  };
}

/** Past the 5,000 boundary of a two-tier rule. */
const past = (over: Partial<MileageYtdRow> = {}) =>
  row({
    claimed: '6100.00',
    total: '6100.00',
    bandIndex: 1,
    bandFrom: '5000.00',
    nextBoundary: null,
    remaining: null,
    crossedAt: new Date('2026-09-12T00:00:00.000Z'),
    ...over,
  });

function show(rows: MileageYtdRow[], locale: 'en' | 'fr-CA' = 'en') {
  const messages =
    locale === 'en'
      ? { people: enPeople, expenses: enExpenses }
      : { people: frPeople, expenses: frExpenses };
  return render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <MileageYtdLines rows={rows} locale={locale} />
    </NextIntlClientProvider>,
  );
}

/** Each country's line: its primary sentence, then its sub-lines in order. */
function lines(container: HTMLElement) {
  return [...container.querySelectorAll('li')].map((li) => {
    const [main, ...subs] = [...li.children].map((el) => fold(el.textContent));
    return { main, subs };
  });
}

describe('MileageYtdLines — the sentence', () => {
  it('says None for no rows, and draws no list', () => {
    const { container } = show([]);
    expect(container.textContent).toBe('None');
    expect(container.querySelector('ul')).toBeNull();
  });

  it('first band: the total against the boundary, and the distance left', () => {
    const { container } = show([row()]);
    expect(lines(container)).toEqual([
      {
        main: '4,210 of 5,000 km this year · 790 km left in the first band',
        subs: [],
      },
    ]);
  });

  it('past the boundary with the date the crossing line was made, and no year total', () => {
    const { container } = show([past()]);
    const [line] = lines(container);
    expect(line?.main).toBe('Past 5,000 km since Sep 12, 2026 · second rate applies');
    // Operator ruling: the sentence does not append the year's total.
    expect(line?.main).not.toContain('6,100');
    expect(line?.main).not.toContain('this year');
  });

  it('past the boundary with no crossing date says no "since"', () => {
    const { container } = show([past({ crossedAt: null })]);
    expect(lines(container)[0]?.main).toBe('Past 5,000 km · second rate applies');
  });

  it('names the band through the ICU select: 2 second, 3 third, anything else by number', () => {
    const tiers = [
      { fromDistance: '0.00', rateMinor: '72' },
      { fromDistance: '5000.00', rateMinor: '66' },
      { fromDistance: '10000.00', rateMinor: '60' },
      { fromDistance: '20000.00', rateMinor: '55' },
    ];
    const rule = { ruleId: 'r4', isCarAllowance: false, tiers };
    const { container } = show([
      past({ country: 'CA', rule, bandIndex: 2, bandFrom: '10000.00', nextBoundary: '20000.00' }),
      past({ country: 'US', rule, bandIndex: 3, bandFrom: '20000.00', crossedAt: null }),
    ]);
    const [third, fourth] = lines(container);
    expect(third?.main).toContain('Past 10,000 km since Sep 12, 2026 · third rate applies');
    expect(fourth?.main).toContain('Past 20,000 km · band 4 rate applies');
  });

  it('a middle band still says what is left before the next rate', () => {
    const tiers = [...TWO_TIERS, { fromDistance: '10000.00', rateMinor: '60' }];
    const { container } = show([
      past({
        rule: { ruleId: 'r3', isCarAllowance: false, tiers },
        nextBoundary: '10000.00',
        remaining: '3900.00',
      }),
    ]);
    expect(lines(container)[0]?.main).toBe(
      'Past 5,000 km since Sep 12, 2026 · second rate applies · 3,900 km left before the next rate',
    );
  });

  it('a one-tier car allowance is a flat rate, with the total', () => {
    const rule = {
      ruleId: 'car',
      isCarAllowance: true,
      tiers: [{ fromDistance: '0.00', rateMinor: '50' }],
    };
    const { container } = show([
      row({ total: '6100.00', rule, nextBoundary: null, remaining: null }),
    ]);
    expect(lines(container)[0]?.main).toBe('Flat rate (car allowance) · 6,100 km');
  });

  it('a one-tier country rule is a single rate', () => {
    const rule = {
      ruleId: 'one',
      isCarAllowance: false,
      tiers: [{ fromDistance: '0.00', rateMinor: '70' }],
    };
    const { container } = show([row({ rule, nextBoundary: null, remaining: null })]);
    expect(lines(container)[0]?.main).toBe('Single rate · 4,210 km');
  });

  it('no rule in force: the total, and no band', () => {
    const { container } = show([
      row({
        total: '1234.50',
        rule: null,
        bandIndex: null,
        bandFrom: null,
        nextBoundary: null,
        remaining: null,
      }),
    ]);
    expect(lines(container)[0]?.main).toBe('1,234.5 km this year · no rate in force today');
  });

  it('an MI row says mi', () => {
    const { container } = show([
      row({ country: 'US', unit: 'MI', total: '2500.25', remaining: '2499.75' }),
    ]);
    expect(lines(container)[0]?.main).toBe(
      '2,500.25 of 5,000 mi this year · 2,499.75 mi left in the first band',
    );
  });
});

describe('MileageYtdLines — sub-lines', () => {
  it('shows the carry-over only when above 0', () => {
    const carriedThrough = new Date('2026-08-31T00:00:00.000Z');
    const { container } = show([
      row({ country: 'CA', carried: '3900.00', carriedThrough }),
      row({ country: 'FR', carried: '0.00', carriedThrough }),
    ]);
    const [withCarry, without] = lines(container);
    expect(withCarry?.subs).toEqual(['incl. 3,900 km carried over through Aug 31, 2026']);
    expect(without?.subs).toEqual([]);
  });

  it('shows the not-yet-approved part only when above 0', () => {
    const { container } = show([
      row({ country: 'CA', pending: '120.50' }),
      row({ country: 'FR', pending: '0.00' }),
    ]);
    const [withPending, without] = lines(container);
    expect(withPending?.subs).toEqual(['of which 120.5 km not yet approved']);
    expect(without?.subs).toEqual([]);
  });

  it('puts the carry-over before the pending part when both apply', () => {
    const { container } = show([
      row({
        carried: '3900.00',
        carriedThrough: new Date('2026-08-31T00:00:00.000Z'),
        pending: '310.00',
      }),
    ]);
    expect(lines(container)[0]?.subs).toEqual([
      'incl. 3,900 km carried over through Aug 31, 2026',
      'of which 310 km not yet approved',
    ]);
  });
});

describe('MileageYtdLines — countries', () => {
  it('two countries are two lines, each named, each in its own unit', () => {
    const { container } = show([
      row({ country: 'CA' }),
      row({ country: 'US', unit: 'MI', total: '120.00', remaining: '4880.00' }),
    ]);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(lines(container).map((l) => l.main)).toEqual([
      'Canada: 4,210 of 5,000 km this year · 790 km left in the first band',
      'United States: 120 of 5,000 mi this year · 4,880 mi left in the first band',
    ]);
  });

  it('one country is not named: the unit already says which', () => {
    const { container } = show([row()]);
    expect(lines(container)[0]?.main).not.toContain('Canada');
  });
});

describe('MileageYtdLines — dates are the UTC day', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it('a midnight-UTC date stays on its own day for a reader west of UTC', () => {
    process.env.TZ = 'America/Toronto';
    // The premise: in this zone the same instant IS the day before, locally.
    expect(new Date('2026-09-12T00:00:00.000Z').getDate()).toBe(11);
    const { container } = show([
      past({ carried: '3900.00', carriedThrough: new Date('2026-08-31T00:00:00.000Z') }),
    ]);
    const [line] = lines(container);
    expect(line?.main).toContain('since Sep 12, 2026');
    expect(line?.subs[0]).toContain('through Aug 31, 2026');
  });
});

describe('MileageYtdLines — FR-CA', () => {
  it('renders the French catalog: grouping, date, the select, and the sub-lines', () => {
    const { container } = show(
      [
        row({ country: 'CA', carried: '3900.00', carriedThrough: new Date('2026-08-31T00:00Z') }),
        past({ country: 'US', pending: '310.00' }),
      ],
      'fr-CA',
    );
    expect(lines(container)).toEqual([
      {
        main: 'Canada : 4 210 sur 5 000 km cette année · il reste 790 km dans la première tranche',
        subs: ['y compris 3 900 km reportés jusqu’au 31 août 2026'],
      },
      {
        main: 'États-Unis : Au-delà de 5 000 km depuis le 12 sept. 2026 · le deuxième taux s’applique',
        subs: ['dont 310 km pas encore approuvés'],
      },
    ]);
  });

  it('says Aucun for no rows', () => {
    const { container } = show([], 'fr-CA');
    expect(container.textContent).toBe('Aucun');
  });
});

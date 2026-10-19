// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRAVEL_CLASS_NAMES } from '@expenseos/travel-lines';
import { describe, expect, it } from 'vitest';
import { derivationSummary, lineSummary } from './summary';

/**
 * The summary the server used to compose and store.
 *
 * Every assertion here is about a fact that used to be prose. The old string was
 * "Per diem · 3 days · Toronto · first/last day halved"; what is checked now is that the
 * pieces come from the payload, that a missing piece is omitted rather than rendered as
 * a gap, and that a locale key is asked for rather than an English word emitted.
 */

/** `t` as a key echo, so a test asserts WHICH key was asked for, not a translation. */
const t = (key: string, values?: Record<string, string | number>) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')})`
    : key;
const money = (minor: bigint) => `$${(Number(minor) / 100).toFixed(2)}`;
const deps = { t, money };

const summary = (kind: string, payload: unknown) => lineSummary(kind, payload, deps);

describe('per-diem lines', () => {
  it('names the days, the city and the daily rate', () => {
    expect(
      summary('STANDARD', {
        perDiemDays: 4,
        perDiemCity: 'Toronto',
        perDiemDailyMinor: '7500',
        perDiemEdgeHalved: false,
      }),
    ).toBe('line.summary.perDiem(days=4,city=Toronto) · line.summary.dailyRate(rate=$75.00)');
  });

  it('says so when the edge days were halved', () => {
    // Otherwise a traveller checking rate × days finds the figure short by a day and
    // reports a bug. This is the one fragment that exists to prevent a false report.
    expect(
      summary('STANDARD', { perDiemDays: 4, perDiemCity: 'Toronto', perDiemEdgeHalved: true }),
    ).toContain('line.summary.edgeHalved');
  });

  it('says nothing for a STANDARD line with no allowance applied', () => {
    /**
     * Absent, not zero. Such a line's amount is somebody's typed figure — there is no
     * derivation to explain, and a caption saying "Per diem · 0 days ·" would be a claim
     * about one.
     */
    expect(summary('STANDARD', {})).toBeNull();
    expect(summary('STANDARD', { perDiemDays: 0 })).toBeNull();
  });
});

/**
 * The caption under a figure that has not been saved yet — composed from the preview, by
 * the same function, so what the traveller reads before the save is what they read after.
 */
describe('a previewed derivation', () => {
  it('reads exactly like the saved line it becomes', () => {
    const preview = {
      derivedAmountMinor: '30000',
      days: 4,
      dailyRateMinor: '7500',
      edgeDaysHalved: false,
      city: 'Toronto',
    };
    expect(derivationSummary(preview, deps)).toBe(
      summary('STANDARD', {
        perDiemDays: 4,
        perDiemCity: 'Toronto',
        perDiemDailyMinor: '7500',
        perDiemEdgeHalved: false,
      }),
    );
  });

  it('mentions the halved edge days, as the saved caption does', () => {
    expect(
      derivationSummary(
        {
          derivedAmountMinor: '28000',
          days: 4,
          dailyRateMinor: '8000',
          edgeDaysHalved: true,
          city: 'Toronto',
        },
        deps,
      ),
    ).toContain('line.summary.edgeHalved');
  });

  it('says nothing when nothing was derived, or nothing was asked', () => {
    expect(
      derivationSummary(
        {
          derivedAmountMinor: null,
          days: 0,
          dailyRateMinor: null,
          edgeDaysHalved: false,
          city: null,
        },
        deps,
      ),
    ).toBeNull();
    expect(derivationSummary(null, deps)).toBeNull();
    expect(derivationSummary(undefined, deps)).toBeNull();
  });
});

describe('flights', () => {
  const flight = {
    fromLabel: 'YUL',
    toLabel: 'LHR',
    travelClass: 'BUSINESS',
    legs: [
      { from: 'YUL', to: 'LHR', flightNumber: 'AC 872' },
      { from: 'LHR', to: 'YUL', flightNumber: 'AC 873' },
    ],
  };

  it('gives the WHOLE route, the flight numbers and a premium cabin', () => {
    const out = summary('AIRFARE', flight);
    // The turnaround included: a return trip used to render `YUL → YUL`, which is accurate
    // and tells the reader nothing about where they went.
    expect(out).toContain('YUL → LHR → YUL');
    expect(out).toContain('AC 872 · AC 873');
    expect(out).toContain('policy.cabin.BUSINESS');
  });

  it('does NOT name the ordinary cabin', () => {
    // A label reading "economy" on every flight is a label nobody reads; the point of
    // showing the cabin at all is the exception.
    expect(summary('AIRFARE', { ...flight, travelClass: 'ECONOMY' })).not.toContain('cabin');
  });

  it('omits the numbers on a fare with no legs, falling back to the search endpoints', () => {
    expect(summary('AIRFARE', { fromLabel: 'YUL', toLabel: 'LHR', legs: [] })).toBe('YUL → LHR');
  });

  it('shows a connection rather than hiding it', () => {
    // Same fact one level down: where the trip actually went.
    expect(
      summary('AIRFARE', {
        fromLabel: 'YYZ',
        toLabel: 'MCO',
        travelClass: 'ECONOMY',
        legs: [
          { from: 'YYZ', to: 'YYC', flightNumber: 'AC 101' },
          { from: 'YYC', to: 'MCO', flightNumber: 'AC 202' },
        ],
      }),
    ).toContain('YYZ → YYC → MCO');
  });
});

describe('the other kinds', () => {
  it('gives the property, the nights and the nightly rate', () => {
    const out = summary('LODGING', {
      propertyName: 'The Savoy',
      nights: 3,
      nightlyMinor: '32000',
      checkIn: '2026-09-01',
      checkOut: '2026-09-04',
    });
    expect(out).toBe(
      'The Savoy · line.summary.nights(nights=3) · line.summary.nightly(rate=$320.00)',
    );
  });

  it('counts the heads on a department meal, and only says ×/day when it is more than one', () => {
    const one = summary('DEPARTMENT_MEAL', {
      attendees: [{ name: 'A' }, { name: 'B' }],
      occurrencesPerDay: 1,
      days: 2,
      ratePerPersonMinor: '5000',
    });
    expect(one).toContain('line.summary.attendees(count=2)');
    expect(one).not.toContain('perDay');

    expect(
      summary('DEPARTMENT_MEAL', {
        attendees: [{ name: 'A' }],
        occurrencesPerDay: 2,
        days: 2,
        ratePerPersonMinor: '5000',
      }),
    ).toContain('line.summary.perDay(count=2)');
  });

  it('says nothing for a department meal with nobody at it', () => {
    expect(summary('DEPARTMENT_MEAL', { attendees: [], occurrencesPerDay: 1, days: 2 })).toBeNull();
  });

  it('gives days and the cap for a car or a ground line', () => {
    for (const kind of ['CAR_RENTAL', 'GROUND']) {
      expect(summary(kind, { days: 4, dailyCapMinor: '6000' })).toBe(
        'line.summary.days(days=4) · line.summary.dailyCap(cap=$60.00)',
      );
    }
  });

  it('says nothing on a payload it cannot read, rather than throwing', () => {
    // The tolerant reader. A payload written by an older deployment degrades to no
    // caption, which is what makes a drawer render the forty-nine lines it understands.
    expect(summary('AIRFARE', { legs: 'not an array' })).toBeNull();
    expect(summary('LODGING', { nights: -1 })).toBeNull();
    expect(summary('WHAT_IS_THIS', {})).toBeNull();
  });
});

describe('cabin labels', () => {
  it.each(['en', 'fr-CA'])('has a %s label for every travel class', (locale) => {
    /**
     * The drift guard, and it is not hypothetical: the cabin key is composed at runtime
     * from the enum, so `check-used-keys` cannot see it (it looks for literal `t('…')`
     * call sites) and `check-coverage` only compares EN against FR-CA — a class missing
     * from BOTH catalogs would pass every gate and print its own enum name at a reader.
     * That is exactly how `perDiemRate` shipped unlabelled for months.
     */
    const raw = readFileSync(
      resolve(process.cwd(), `packages/i18n/src/catalogs/${locale}/travel.json`),
      'utf8',
    );
    const cabin = (JSON.parse(raw) as { policy: { cabin: Record<string, string> } }).policy.cabin;
    expect(TRAVEL_CLASS_NAMES.filter((c) => !cabin[c])).toEqual([]);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's #589 cases read mock calls untyped; Biome allows it there. */
import { describe, expect, it, vi } from 'vitest';
import {
  bandPosition,
  calendarYearBounds,
  computeMileageMinor,
  convertScaled,
  defaultMileageUnitFor,
  defaultMileageUnitsFor,
  distanceToScaled,
  type MileageDb,
  priceMileage,
  unscale,
  ytdBasis,
  ytdDistanceScaled,
} from './mileage';

/** `[fromDistance, rate]` pairs → the scaled tier shape the engine takes. */
const bands = (...pairs: [number, number][]) =>
  pairs.map(([from, rate]) => ({ fromScaled: BigInt(from * 100), rateMinor: BigInt(rate) }));

/** The example from the spec: 0.75 / 0.73 / 0.71 stepping at 5,000 and 10,000. */
const CRA = bands([0, 75], [5000, 73], [10000, 71]);
const km = (v: string) => distanceToScaled(v) as bigint;

describe('distance parsing', () => {
  it('scales to hundredths', () => {
    expect(distanceToScaled('123.45')).toBe(12_345n);
    expect(distanceToScaled('10')).toBe(1_000n);
    expect(distanceToScaled('0.5')).toBe(50n);
  });

  it('rejects anything that isn’t a plain positive decimal', () => {
    for (const bad of ['-1', '1.234', 'abc', '', '1,5']) {
      expect(distanceToScaled(bad)).toBeNull();
    }
  });
});

describe('unit conversion', () => {
  it('is exact in both directions', () => {
    // 100 mi = 160.9344 km, to the hundredth.
    expect(convertScaled(km('100'), 'MI', 'KM')).toBe(16_093n);
    // …and back: 160.93 km is 100.004 mi, which rounds to 100.00.
    expect(convertScaled(km('160.93'), 'KM', 'MI')).toBe(10_000n);
  });

  it('is the identity when the units already match', () => {
    expect(convertScaled(km('42.5'), 'KM', 'KM')).toBe(4_250n);
  });
});

describe('rounding', () => {
  it('rounds half up', () => {
    // 1.005 km × 0.50 = 0.5025 → 50 (round half up on the half-cent).
    expect(computeMileageMinor(101n, 50n)).toBe(51n);
    expect(computeMileageMinor(100n, 50n)).toBe(50n);
  });
});

describe('banded pricing', () => {
  it('prices wholly inside the opening band', () => {
    const r = priceMileage(CRA, 0n, km('100'));
    expect(r.amountMinor).toBe(7_500n);
    expect(r.segments).toHaveLength(1);
  });

  it('SPLITS a trip that crosses a boundary', () => {
    // The case the whole design turns on: 4,900 YTD + 200 km.
    const r = priceMileage(CRA, km('4900'), km('200'));
    expect(r.segments).toEqual([
      { fromDistance: '0.00', rateMinor: '75', distance: '100.00', amountMinor: '7500' },
      { fromDistance: '5000.00', rateMinor: '73', distance: '100.00', amountMinor: '7300' },
    ]);
    expect(r.amountMinor).toBe(14_800n);
  });

  it('spans three bands when the trip is long enough', () => {
    // 4,900 YTD + 6,000 km: 100 at 0.75, 5,000 at 0.73, 900 at 0.71.
    const r = priceMileage(CRA, km('4900'), km('6000'));
    expect(r.segments.map((s) => s.distance)).toEqual(['100.00', '5000.00', '900.00']);
    expect(r.amountMinor).toBe(7_500n + 365_000n + 63_900n);
  });

  it('prices entirely in the top band once past the last threshold', () => {
    const r = priceMileage(CRA, km('12000'), km('50'));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].rateMinor).toBe('71');
    expect(r.amountMinor).toBe(3_550n);
  });

  it('starts exactly on a boundary in the upper band, not the lower', () => {
    // At exactly 5,000 the next kilometre is already the cheaper rate.
    const r = priceMileage(CRA, km('5000'), km('10'));
    expect(r.segments[0].rateMinor).toBe('73');
  });

  it('totals the sum of its own segments', () => {
    // A total that didn't equal its breakdown would be indefensible in a review,
    // so rounding is per segment.
    const r = priceMileage(CRA, km('4999.99'), km('0.02'));
    const summed = r.segments.reduce((a, s) => a + BigInt(s.amountMinor), 0n);
    expect(r.amountMinor).toBe(summed);
  });

  it('handles a flat rule as one band', () => {
    const r = priceMileage(bands([0, 72]), km('9999'), km('10'));
    expect(r.segments).toHaveLength(1);
    expect(r.amountMinor).toBe(720n);
  });

  it('returns nothing for a zero distance rather than a zero-width segment', () => {
    const r = priceMileage(CRA, 0n, 0n);
    expect(r.amountMinor).toBe(0n);
    expect(r.segments).toHaveLength(0);
  });

  it('does not spin on an empty band list', () => {
    const r = priceMileage([], 0n, km('10'));
    expect(r.amountMinor).toBe(0n);
  });
});

describe('band position (where a year-to-date total sits)', () => {
  /** The ticket's two-band rule: one rate to 5,000, another after. */
  const TWO = bands([0, 75], [5000, 73]);

  it.each([
    // [case, tiers, total, index, from, next, remaining]
    ['A1 total 0 is the first band', TWO, '0', 0, '0', '5000', '5000'],
    ['A2 inside the first band', TWO, '4210', 0, '0', '5000', '790'],
    ['A3 one hundredth under the boundary', TWO, '4999.99', 0, '0', '5000', '0.01'],
    ['A4 exactly on the boundary is the upper band', TWO, '5000', 1, '5000', null, null],
    ['A5 middle band of three names the NEXT tier', CRA, '7000', 1, '5000', '10000', '3000'],
    ['A6 past the last boundary', CRA, '12000', 2, '10000', null, null],
    ['A7 a single tier (car allowance)', bands([0, 72]), '6100', 0, '0', null, null],
  ] as const)('%s', (_, tiers, total, index, from, next, remaining) => {
    expect(bandPosition(tiers, km(total))).toEqual({
      index,
      fromScaled: km(from),
      nextScaled: next === null ? null : km(next),
      remainingScaled: remaining === null ? null : km(remaining),
    });
  });

  it('A8 has no band to name on a rule with no tiers', () => {
    expect(bandPosition([], 0n)).toBeNull();
    expect(bandPosition([], km('500'))).toBeNull();
  });

  it('A9 names the band pricing would price the next hundredth in', () => {
    // The drawer must never name a band that pricing disagrees with.
    const totals = ['0', '4999.99', '5000', '5000.01', '9999.99', '10000', '12000'];
    for (const tiers of [TWO, CRA, bands([0, 72])]) {
      for (const total of totals) {
        const priced = priceMileage(tiers, km(total), 1n).segments[0].fromDistance;
        expect(
          bandPosition(tiers, km(total))?.fromScaled,
          `${total} on ${tiers.length} tiers`,
        ).toBe(km(priced));
      }
    }
  });

  it('formats a scaled distance as the two-decimal string segments carry', () => {
    expect(unscale(0n)).toBe('0.00');
    expect(unscale(5n)).toBe('0.05');
    expect(unscale(km('5000'))).toBe('5000.00');
    expect(unscale(km('4999.99'))).toBe('4999.99');
  });
});

describe('calendar year bounds', () => {
  it('brackets the year containing the date, in UTC', () => {
    const { start, end } = calendarYearBounds(new Date('2026-07-31T23:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('puts 1 January inside the year that starts that day', () => {
    const { start } = calendarYearBounds(new Date('2026-01-01T00:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('year-to-date basis (carried over + claimed here)', () => {
  /** Just enough of Prisma.Decimal for the engine: `.mul(100).toFixed(0)`. */
  const dec = (v: string) => ({
    mul: (n: number) => ({ toFixed: () => String(Math.round(Number(v) * n)) }),
  });
  const balance = (distance: string, unit: 'KM' | 'MI', asOf: string) => ({
    distance: dec(distance),
    unit,
    import: { asOf: new Date(`${asOf}T00:00:00.000Z`) },
  });
  const line = (
    distance: string | null,
    unit: 'KM' | 'MI' | null,
    override: string | null = null,
  ) => ({
    mileageDistance: distance === null ? null : dec(distance),
    mileageDistanceOverride: override === null ? null : dec(override),
    mileageUnit: unit,
  });

  const fakeDb = (balances: unknown[], lines: unknown[]) => {
    const db = {
      mileageOpeningBalance: { findMany: vi.fn(async () => balances) },
      expenseLineItem: { findMany: vi.fn(async () => lines) },
    };
    return db as typeof db & MileageDb;
  };
  const params = {
    userId: 'u1',
    country: 'CA',
    on: new Date('2026-08-15T00:00:00.000Z'),
    unit: 'KM' as const,
  };

  it('with no upload, counts the whole calendar year and carries nothing', async () => {
    const db = fakeDb([], [line('100', 'KM'), line('50.5', 'KM')]);
    const basis = await ytdBasis(db, params);
    expect(basis).toEqual({ totalScaled: 150_50n, carriedScaled: 0n, carriedThrough: null });

    const balanceWhere = (db.mileageOpeningBalance.findMany.mock.calls[0] as any)[0].where;
    expect(balanceWhere).toEqual({
      userId: 'u1',
      country: 'CA',
      import: { year: 2026, supersededAt: null },
    });
    const where = (db.expenseLineItem.findMany.mock.calls[0] as any)[0].where;
    expect(where.id).toBeUndefined();
    expect(where.expense.date).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(where.expense.report).toEqual({ status: { not: 'REJECTED' } });
    expect(where.mileageRate).toEqual({ country: 'CA' });
  });

  it('adds the carried-over balance and counts only lines dated after its period end', async () => {
    const db = fakeDb([balance('4900', 'KM', '2026-06-30')], [line('200', 'KM')]);
    const basis = await ytdBasis(db, params);
    expect(basis.carriedScaled).toBe(4900_00n);
    expect(basis.totalScaled).toBe(5100_00n);
    expect(basis.carriedThrough?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    const where = (db.expenseLineItem.findMany.mock.calls[0] as any)[0].where;
    expect(where.expense.date).toEqual({
      gt: new Date('2026-06-30T00:00:00.000Z'),
      lt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });

  it('converts a balance and lines kept in the other unit into the rule unit', async () => {
    // 100 mi → 160.93 km; 10 km line stays; 10 mi line → 16.09 km.
    const db = fakeDb([balance('100', 'MI', '2026-03-31')], [line('10', 'KM'), line('10', 'MI')]);
    const basis = await ytdBasis(db, params);
    expect(basis.carriedScaled).toBe(convertScaled(100_00n, 'MI', 'KM'));
    expect(basis.totalScaled).toBe(
      convertScaled(100_00n, 'MI', 'KM') + 10_00n + convertScaled(10_00n, 'MI', 'KM'),
    );

    const inMiles = await ytdBasis(fakeDb([balance('160.93', 'KM', '2026-03-31')], []), {
      ...params,
      unit: 'MI',
    });
    expect(inMiles.carriedScaled).toBe(convertScaled(160_93n, 'KM', 'MI'));
  });

  it('sums balances from more than one upload in force and dates them by the latest', async () => {
    const db = fakeDb(
      [balance('1000', 'KM', '2026-05-31'), balance('500', 'KM', '2026-07-31')],
      [],
    );
    const basis = await ytdBasis(db, params);
    expect(basis.carriedScaled).toBe(1500_00n);
    expect(basis.carriedThrough?.toISOString()).toBe('2026-07-31T00:00:00.000Z');

    // Order does not matter: an earlier asOf after a later one keeps the later one.
    const reversed = await ytdBasis(
      fakeDb([balance('500', 'KM', '2026-07-31'), balance('1000', 'KM', '2026-05-31')], []),
      params,
    );
    expect(reversed.carriedThrough?.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });

  it('prefers the override, skips a line with no distance and defaults a missing unit', async () => {
    const db = fakeDb(
      [],
      [
        line('100', 'KM', '80'),
        line(null, 'KM'),
        line('25', null),
        { ...line('1', 'KM'), mileageDistance: null, mileageDistanceOverride: null },
      ],
    );
    const basis = await ytdBasis(db, params);
    expect(basis.totalScaled).toBe(105_00n);
  });

  it('leaves the line being repriced out of its own basis', async () => {
    const db = fakeDb([], []);
    await ytdBasis(db, { ...params, excludeLineItemId: 'line-1' });
    const where = (db.expenseLineItem.findMany.mock.calls[0] as any)[0].where;
    expect(where.id).toEqual({ not: 'line-1' });
  });

  it('ytdDistanceScaled is the total alone', async () => {
    const db = fakeDb([balance('10', 'KM', '2026-01-31')], [line('5', 'KM')]);
    expect(await ytdDistanceScaled(db, params)).toBe(15_00n);
  });
});

describe('the unit a new mileage line opens in (FR-11)', () => {
  it.each([
    ['a US owner', { country: 'US', homeCurrencyCode: 'CAD' }, 'MI'],
    ['a US owner, lower-cased', { country: 'us', homeCurrencyCode: 'CAD' }, 'MI'],
    ['an owner paid in USD with no country', { country: null, homeCurrencyCode: 'USD' }, 'MI'],
    ['a Canadian owner paid in USD', { country: 'CA', homeCurrencyCode: 'USD' }, 'MI'],
    ['a CA / CAD owner', { country: 'CA', homeCurrencyCode: 'CAD' }, 'KM'],
    ['an owner with neither set (the CAD floor)', { country: null, homeCurrencyCode: 'CAD' }, 'KM'],
    ['a UK owner paid in GBP', { country: 'GB', homeCurrencyCode: 'GBP' }, 'KM'],
  ] as const)('%s → %s', (_name, owner, unit) => {
    expect(defaultMileageUnitFor(owner)).toBe(unit);
  });

  /**
   * The owner resolution, against a stub that answers like Prisma: `user.findMany` for the
   * countries, `user.findUnique` for the shared currency chain (`defaultCurrencyCodeFor`).
   *
   * VeloExpense (d92): the chain is the person's legal entity, else the tenant's main
   * entity, else CAD (`homeCurrencyCode`) — there is no per-person currency, so ExpenseOS's
   * "paid in USD with no entity" owner is not a case here; the entity one is. The main
   * entity read (`legalEntity.findFirst`) answers none, so the floor is CAD.
   */
  function ownersDb(
    people: Record<
      string,
      { country: string | null; entityCurrency?: string }
    >,
  ) {
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id in people).map((id) => ({ id, country: people[id].country })),
    );
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
      const p = people[where.id];
      if (!p) return null;
      return { entity: p.entityCurrency ? { homeCurrencyId: p.entityCurrency } : null };
    });
    const legalEntity = { findFirst: vi.fn(async () => null) };
    return { db: { user: { findMany, findUnique }, legalEntity } as never, findMany, findUnique };
  }

  it('resolves each owner by the owner, never by whoever is reading', async () => {
    const { db } = ownersDb({
      'us-owner': { country: 'US' },
      'usd-entity-owner': { country: null, entityCurrency: 'USD' },
      'ca-owner': { country: 'CA', entityCurrency: 'CAD' },
      // A delegate who works in kilometres: present in the db, never asked for here.
      'ca-delegate': { country: 'CA', entityCurrency: 'CAD' },
    });
    const units = await defaultMileageUnitsFor(db, [
      'us-owner',
      'usd-entity-owner',
      'ca-owner',
      'gone',
    ]);
    expect(Object.fromEntries(units)).toEqual({
      'us-owner': 'MI',
      // The entity's currency counts as a link in the OWNER's chain.
      'usd-entity-owner': 'MI',
      'ca-owner': 'KM',
      // No user row: no country and the CAD floor.
      gone: 'KM',
    });
  });

  it('reads once per distinct owner, not once per expense', async () => {
    const { db, findMany, findUnique } = ownersDb({ owner: { country: 'US' } });
    const units = await defaultMileageUnitsFor(db, Array(40).fill('owner'));
    expect(units.get('owner')).toBe('MI');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for no owners', async () => {
    const { db, findMany, findUnique } = ownersDb({});
    expect((await defaultMileageUnitsFor(db, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

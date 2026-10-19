import { describe, expect, it, vi } from 'vitest';
import { estimateTravelBudget, pickFlight, priceConfidence } from './estimate';
import { cheapestStay, nightlyRateMinor, nightsBetween, searchStays } from './stays';
import type { FlightOption, PriceInsight, StayOption } from './types';

const flight = (priceMinor: bigint, over: Partial<FlightOption> = {}): FlightOption => ({
  priceMinor,
  currency: 'CAD',
  legs: [
    {
      from: 'YUL',
      to: 'YYZ',
      departsAt: null,
      arrivesAt: null,
      airline: 'Air Canada',
      flightNumber: 'AC 123',
      durationMinutes: 90,
    },
  ],
  totalDurationMinutes: 90,
  stops: 0,
  airlines: ['Air Canada'],
  bookingToken: null,
  ...over,
});

const stay = (over: Partial<StayOption> = {}): StayOption => ({
  name: 'Test Hotel',
  kind: 'hotel',
  nightlyMinor: 18000n,
  totalMinor: null,
  currency: 'CAD',
  rating: 4.3,
  reviews: 900,
  starClass: 4,
  propertyToken: null,
  ...over,
});

describe('nightsBetween', () => {
  it('counts whole nights', () => {
    expect(nightsBetween('2026-09-01', '2026-09-05')).toBe(4);
    expect(nightsBetween('2026-09-01', '2026-09-02')).toBe(1);
  });

  it('parses as UTC, so a trip is not a night shorter behind UTC', () => {
    // Constructing these in local time is how a 4-night trip becomes 3.
    expect(nightsBetween('2026-03-01', '2026-03-31')).toBe(30);
  });

  it('is 0 for a reversed or unparseable range, never negative', () => {
    expect(nightsBetween('2026-09-05', '2026-09-01')).toBe(0);
    expect(nightsBetween('2026-09-01', '2026-09-01')).toBe(0);
    expect(nightsBetween('nonsense', '2026-09-01')).toBe(0);
  });
});

describe('nightlyRateMinor', () => {
  it('prefers the provider’s nightly figure', () => {
    expect(nightlyRateMinor(stay(), 4)).toBe(18000n);
  });

  it('derives a nightly rate from a total when that is all there is', () => {
    expect(nightlyRateMinor(stay({ nightlyMinor: null, totalMinor: 72000n }), 4)).toBe(18000n);
  });

  it('is null when neither is derivable — the caller then uses the policy cap', () => {
    expect(nightlyRateMinor(stay({ nightlyMinor: null, totalMinor: null }), 4)).toBeNull();
    expect(nightlyRateMinor(stay({ nightlyMinor: null, totalMinor: 72000n }), 0)).toBeNull();
  });
});

describe('cheapestStay', () => {
  it('compares the figure it would BUDGET, not whichever field was populated', () => {
    // 200/night vs a 600 total over 4 nights (=150/night). Comparing the raw fields
    // would pick the wrong one.
    const result = {
      currency: 'CAD',
      nights: 4,
      properties: [
        stay({ name: 'Nightly 200', nightlyMinor: 20000n }),
        stay({ name: 'Total 600', nightlyMinor: null, totalMinor: 60000n }),
      ],
    };
    expect(cheapestStay(result)?.name).toBe('Total 600');
  });

  it('ignores properties it cannot price, and returns null when none can be', () => {
    expect(
      cheapestStay({
        currency: 'CAD',
        nights: 2,
        properties: [stay({ nightlyMinor: null, totalMinor: null })],
      }),
    ).toBeNull();
  });
});

describe('priceConfidence', () => {
  const insight = (over: Partial<PriceInsight> = {}): PriceInsight => ({
    lowestMinor: 25000n,
    level: null,
    typicalRangeMinor: { lowMinor: 25000n, highMinor: 40000n },
    currency: 'CAD',
    ...over,
  });

  it('trusts the provider’s own level first — it knows the route history', () => {
    expect(priceConfidence(99999n, insight({ level: 'low' }))).toBe('BELOW_TYPICAL');
    expect(priceConfidence(1n, insight({ level: 'high' }))).toBe('ABOVE_TYPICAL');
    expect(priceConfidence(30000n, insight({ level: 'typical' }))).toBe('TYPICAL');
  });

  it('falls back to the numeric range', () => {
    expect(priceConfidence(20000n, insight())).toBe('BELOW_TYPICAL');
    expect(priceConfidence(30000n, insight())).toBe('TYPICAL');
    expect(priceConfidence(50000n, insight())).toBe('ABOVE_TYPICAL');
  });

  it('is UNKNOWN with nothing to compare against — common on thin routes', () => {
    expect(priceConfidence(30000n, null)).toBe('UNKNOWN');
    expect(priceConfidence(30000n, insight({ typicalRangeMinor: null }))).toBe('UNKNOWN');
  });
});

describe('estimateTravelBudget', () => {
  const base = { currency: 'CAD', nights: 4, days: 5 };

  it('prices a fully quoted trip and totals it', () => {
    const out = estimateTravelBudget({
      ...base,
      flight: { option: flight(31250n), insight: null },
      stay: stay({ nightlyMinor: 18000n }),
      policy: { mealsPerDiemPerDayMinor: 7500n },
    });
    // 312.50 + (180 × 4) + (75 × 5) = 312.50 + 720 + 375 = 1407.50
    expect(out.totalMinor).toBe(140750n);
    expect(out.quoted).toBe(true);
    expect(out.lines.map((l) => l.kind)).toEqual(['airfare', 'lodging', 'meals']);
  });

  it('records WHERE each number came from', () => {
    const out = estimateTravelBudget({
      ...base,
      flight: { option: flight(31250n), insight: null },
      stay: stay(),
      policy: { mealsPerDiemPerDayMinor: 7500n, carCapPerDayMinor: 9000n },
      includeCar: true,
    });
    expect(Object.fromEntries(out.lines.map((l) => [l.kind, l.basis]))).toEqual({
      airfare: 'QUOTE',
      lodging: 'QUOTE',
      meals: 'PER_DIEM',
      car: 'POLICY_CAP',
    });
  });

  it('is NOT "quoted" when everything came from policy', () => {
    const out = estimateTravelBudget({
      ...base,
      policy: { lodgingCapPerNightMinor: 18500n, mealsPerDiemPerDayMinor: 7500n },
    });
    // A total assembled from caps is a policy maximum, not a prediction, and the UI
    // must not present it as though a provider agreed with it.
    expect(out.quoted).toBe(false);
    expect(out.lines.every((l) => l.basis === 'PER_DIEM')).toBe(true);
  });

  it('budgets the QUOTED nightly rate even when it exceeds the cap, and says so', () => {
    const out = estimateTravelBudget({
      ...base,
      stay: stay({ nightlyMinor: 25000n }),
      policy: { lodgingCapPerNightMinor: 18500n },
    });
    const lodging = out.lines.find((l) => l.kind === 'lodging');
    // Clamping to the cap would produce a budget the trip cannot be taken within.
    expect(lodging?.amountMinor).toBe(100000n);
    expect(lodging?.detail).toMatch(/over the per-diem lodging cap/);
  });

  it('falls back to the lodging cap when nothing was quoted', () => {
    const out = estimateTravelBudget({
      ...base,
      policy: { lodgingCapPerNightMinor: 18500n },
    });
    const lodging = out.lines.find((l) => l.kind === 'lodging');
    expect(lodging?.amountMinor).toBe(74000n);
    expect(lodging?.basis).toBe('PER_DIEM');
  });

  it('omits a car unless asked — most trips do not rent one', () => {
    const withoutFlag = estimateTravelBudget({ ...base, policy: { carCapPerDayMinor: 9000n } });
    expect(withoutFlag.lines.find((l) => l.kind === 'car')).toBeUndefined();

    const withFlag = estimateTravelBudget({
      ...base,
      policy: { carCapPerDayMinor: 9000n },
      includeCar: true,
    });
    // Days, not nights — a car is billed per day.
    expect(withFlag.lines.find((l) => l.kind === 'car')?.amountMinor).toBe(45000n);
    expect(withFlag.lines.find((l) => l.kind === 'car')?.detail).toMatch(/no live rate/);
  });

  it('emits nothing rather than zero-value lines for a trip with no data', () => {
    const out = estimateTravelBudget({ currency: 'CAD', nights: 0, days: 0 });
    expect(out.lines).toEqual([]);
    expect(out.totalMinor).toBe(0n);
    expect(out.quoted).toBe(false);
  });

  it('treats a negative night count as zero', () => {
    const out = estimateTravelBudget({
      currency: 'CAD',
      nights: -3,
      days: -1,
      policy: { lodgingCapPerNightMinor: 18500n, mealsPerDiemPerDayMinor: 7500n },
    });
    expect(out.lines).toEqual([]);
  });

  it('carries the flight’s confidence onto its line', () => {
    const out = estimateTravelBudget({
      ...base,
      flight: {
        option: flight(50000n),
        insight: {
          lowestMinor: 25000n,
          level: null,
          typicalRangeMinor: { lowMinor: 25000n, highMinor: 40000n },
          currency: 'CAD',
        },
      },
    });
    expect(out.lines[0].confidence).toBe('ABOVE_TYPICAL');
    expect(out.lines[0].detail).toContain('YUL→YYZ');
    expect(out.lines[0].detail).toContain('nonstop');
  });
});

describe('pickFlight', () => {
  it('picks the cheapest when there is no cap', () => {
    const out = pickFlight([flight(50000n), flight(31250n)], null);
    expect(out?.option.priceMinor).toBe(31250n);
    expect(out?.withinPolicy).toBe(true);
  });

  it('picks the cheapest COMPLIANT option, not simply the cheapest', () => {
    const out = pickFlight([flight(10000n, { stops: 3 }), flight(31250n)], 20000n);
    expect(out?.option.priceMinor).toBe(10000n);
    expect(out?.withinPolicy).toBe(true);
  });

  it('still returns something when nothing complies, flagged', () => {
    // An approver looking at "$2,400, over the $2,000 cap" can decide. An empty
    // budget just sends the form back with nothing to discuss.
    const out = pickFlight([flight(240000n), flight(300000n)], 200000n);
    expect(out?.option.priceMinor).toBe(240000n);
    expect(out?.withinPolicy).toBe(false);
  });

  it('is null with no options at all', () => {
    expect(pickFlight([], 100n)).toBeNull();
  });
});

describe('searchStays', () => {
  it('sends the documented parameters and switches inventory for rentals', async () => {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ properties: [] }),
        text: async () => '',
      };
    });
    await searchStays(
      { apiKey: 'k', currency: 'CAD' },
      {
        query: 'Toronto',
        checkInDate: '2026-09-01',
        checkOutDate: '2026-09-05',
        vacationRentals: true,
        sortBy: 3,
      },
      { fetchImpl: impl },
    );
    const p = new URL(calls[0]).searchParams;
    expect(p.get('engine')).toBe('google_hotels');
    expect(p.get('check_in_date')).toBe('2026-09-01');
    expect(p.get('check_out_date')).toBe('2026-09-05');
    expect(p.get('vacation_rentals')).toBe('true');
    expect(p.get('sort_by')).toBe('3');
  });

  it('normalizes both rate shapes and reports the nights it covered', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        properties: [
          {
            type: 'hotel',
            name: 'Nightly only',
            rate_per_night: { extracted_lowest: 180 },
            overall_rating: 4.2,
            extracted_hotel_class: 4,
          },
          {
            type: 'vacation rental',
            name: 'Total only',
            total_rate: { extracted_lowest: 600 },
          },
          { name: 'Unpriced' },
        ],
      }),
    }));
    const out = await searchStays(
      { apiKey: 'k', currency: 'CAD' },
      { query: 'Toronto', checkInDate: '2026-09-01', checkOutDate: '2026-09-05' },
      { fetchImpl: impl },
    );
    expect(out.nights).toBe(4);
    // The unpriced listing is dropped — it cannot be budgeted from.
    expect(out.properties.map((p) => p.name)).toEqual(['Nightly only', 'Total only']);
    expect(out.properties[0].nightlyMinor).toBe(18000n);
    expect(out.properties[1].totalMinor).toBe(60000n);
  });
});

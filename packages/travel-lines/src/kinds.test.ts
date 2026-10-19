import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  attendeeCountOf,
  derivedAmountMinor,
  flightNumbersOf,
  flightRouteOf,
  kindCarriesAttendees,
  kindIsQuotable,
  parseTravelLinePayload,
  payloadSchemaFor,
  readTravelLinePayload,
  routeFromLegs,
  TRAVEL_LINE_KINDS,
} from './kinds';

/**
 * The registry, and the two properties that make it worth having.
 *
 * A payload is rejected on WRITE and tolerated on READ. Getting that split backwards is
 * how one malformed row either enters the database or takes a whole drawer down with it,
 * and both failures are silent until somebody is looking at the wrong number.
 */

describe('the kind list', () => {
  it('covers every kind with a schema', () => {
    // A kind with no schema would throw on its first write, in production, on whatever
    // line happened to use it.
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(payloadSchemaFor(kind)).toBeDefined();
    }
  });

  it('matches the Prisma enum it mirrors', () => {
    /**
     * The drift guard. This package deliberately does NOT import `TravelLineKind` — a
     * value import pulls in the Prisma client and a pure package must not need a
     * database — so the two lists are only kept honest by asserting them here.
     *
     * Read out of the schema text rather than the client, for the same reason.
     */
    // `fileURLToPath` rather than handing a URL straight to `readFileSync`: under
    // vitest's transform `import.meta.url` is not always a file: URL, and the resulting
    // "The URL must be of scheme file" is a confusing way to learn that. The same path
    // dance `__test-helpers__/prismaShape.ts` does, for the same reason.
    //
    // VeloExpense: the kind is text under a CHECK (migration 0077), not a Prisma enum, so the
    // list is read out of the migration's CHECK — on the budget line AND on the category,
    // which carries the same list.
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, '..', '..', '..', 'prisma', 'migrations', '0077_travel', 'migration.sql'),
      'utf8',
    );
    for (const name of ['travel_budget_line_kind', 'travel_category_line_kind']) {
      const block = new RegExp(`${name}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)`).exec(sql);
      expect(block, name).not.toBeNull();
      const declared = (block?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      expect(declared, name).toEqual([...TRAVEL_LINE_KINDS]);
    }
  });
});

describe('write validation', () => {
  it('accepts an EMPTY payload for every kind', () => {
    /**
     * The invariant, and the regression it pins. A traveller adds an "Airfare" line and
     * THEN searches for a flight; a car line exists before anybody types how many days.
     * `days` and `occurrencesPerDay` used to be required, so
     * `parseTravelLinePayload('CAR_RENTAL', {})` threw "expected number, received
     * undefined" and neither line could be created at all — caught by the end-to-end
     * run, not by anything here, which is why this test exists.
     *
     * The registry refuses FOREIGN fields and MALFORMED values. It does not demand a
     * complete itinerary at creation.
     */
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(() => parseTravelLinePayload(kind, {}), kind).not.toThrow();
      expect(() => parseTravelLinePayload(kind, null), kind).not.toThrow();
    }
  });

  it('derives nothing from an empty payload, rather than zero', () => {
    // An incomplete line sits at whatever the caller set and visibly wants a figure. A
    // derived zero would read as "this costs nothing".
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(derivedAmountMinor(kind, {}), kind).toBeNull();
    }
  });

  it('accepts an empty payload for STANDARD, and rejects a decorated one', () => {
    // `.strict()` everywhere: a field nothing reads is a field somebody believes is
    // being used.
    expect(parseTravelLinePayload('STANDARD', {})).toEqual({});
    expect(() => parseTravelLinePayload('STANDARD', { amountMinor: '100' })).toThrow();
  });

  it('treats a null payload as an empty one', () => {
    // The column is nullable, and a line that has never been edited holds null.
    expect(parseTravelLinePayload('STANDARD', null)).toEqual({});
    expect(parseTravelLinePayload('STANDARD', undefined)).toEqual({});
  });

  it('rejects a payload belonging to a different kind', () => {
    const airfare = {
      fromLabel: 'Montréal',
      toLabel: 'Toronto',
      tripType: 'ONE_WAY',
      travelClass: 'ECONOMY',
      outboundDate: '2026-09-14',
    };
    expect(() => parseTravelLinePayload('LODGING', airfare)).toThrow();
    expect(() => parseTravelLinePayload('CAR_RENTAL', airfare)).toThrow();
  });

  it('rejects a minor amount that is not a digit string', () => {
    /**
     * The whole reason payloads carry strings: a float that got past here would be a
     * float in an approved estimate. `12.50`, `1e3` and a negative are all the same
     * refusal.
     */
    const base = { days: 3 };
    for (const bad of [1250, '12.50', '1e3', '-500', '', ' 500']) {
      expect(() => parseTravelLinePayload('CAR_RENTAL', { ...base, dailyCapMinor: bad })).toThrow();
    }
    expect(parseTravelLinePayload('CAR_RENTAL', { ...base, dailyCapMinor: '7500' })).toBeTruthy();
  });

  it('rejects a date that is not a calendar date', () => {
    // A timestamp here would make the same trip a day shorter for anyone behind UTC.
    for (const bad of ['2026-9-14', '2026-09-14T00:00:00Z', 'Sep 14 2026', '20260914']) {
      expect(() =>
        parseTravelLinePayload('LODGING', { checkIn: bad, checkOut: '2026-09-18', nights: 4 }),
      ).toThrow();
    }
  });

  it('bounds the day counts', () => {
    // An unbounded count multiplied by a rate is how a fat finger reaches an approval
    // tier nobody meant to trigger.
    expect(() => parseTravelLinePayload('CAR_RENTAL', { days: 400 })).toThrow();
    expect(() => parseTravelLinePayload('CAR_RENTAL', { days: -1 })).toThrow();
    expect(() => parseTravelLinePayload('CAR_RENTAL', { days: 1.5 })).toThrow();
  });

  it('stores the cabin by name, not by the provider’s number', () => {
    // `"travelClass": 3` explains nothing to somebody reading this back in a year.
    const base = {
      fromLabel: 'Montréal',
      toLabel: 'Toronto',
      tripType: 'ONE_WAY',
      outboundDate: '2026-09-14',
    };
    expect(parseTravelLinePayload('AIRFARE', { ...base, travelClass: 'BUSINESS' })).toBeTruthy();
    expect(() => parseTravelLinePayload('AIRFARE', { ...base, travelClass: 3 })).toThrow();
  });

  it('defaults an airfare payload’s legs to empty rather than refusing', () => {
    // A route can be priced before a specific itinerary is chosen, and refusing the
    // write would mean the search parameters could not be saved at all.
    const p = parseTravelLinePayload('AIRFARE', {
      fromLabel: 'Montréal',
      toLabel: 'Toronto',
      tripType: 'ONE_WAY',
      travelClass: 'ECONOMY',
      outboundDate: '2026-09-14',
    }) as { legs: unknown[] };
    expect(p.legs).toEqual([]);
  });
});

describe('tolerant reads', () => {
  it('returns null for a malformed payload instead of throwing', () => {
    /**
     * Strict on write, tolerant on read. A drawer rendering fifty lines must show the
     * forty-nine it understands rather than a blank page, and the write path is where a
     * bad payload is refused.
     */
    expect(readTravelLinePayload('LODGING', { nights: 'four' })).toBeNull();
    expect(flightNumbersOf({ legs: 'nope' })).toEqual([]);
    expect(attendeeCountOf({ attendees: 3 })).toBe(0);
  });

  it('reads the flight numbers in itinerary order, skipping legs that have none', () => {
    const numbers = flightNumbersOf({
      fromLabel: 'Montréal',
      toLabel: 'London',
      tripType: 'ONE_WAY',
      travelClass: 'ECONOMY',
      outboundDate: '2026-09-14',
      legs: [
        { from: 'YUL', to: 'YYZ', flightNumber: 'AC 412' },
        // A codeshare the provider named no number for. Dropped, not rendered as a gap.
        { from: 'YYZ', to: 'LHR' },
        { from: 'LHR', to: 'LGW', flightNumber: 'BA 998' },
      ],
    });
    expect(numbers).toEqual(['AC 412', 'BA 998']);
  });

  it('reads a null payload as the kind’s empty one', () => {
    // A line that has never been edited holds null, and the reader must not treat that
    // as malformed — it is a STANDARD line with nothing kind-specific on it yet.
    expect(readTravelLinePayload('STANDARD', null)).toEqual({});
    expect(readTravelLinePayload('STANDARD', undefined)).toEqual({});
  });

  it('counts attendees', () => {
    expect(
      attendeeCountOf({
        attendees: [{ name: 'Ada' }, { name: 'Grace', isExternal: true }],
        occurrencesPerDay: 1,
        days: 2,
      }),
    ).toBe(2);
  });
});

describe('derivedAmountMinor', () => {
  it('prices a stay at the QUOTED nightly rate × nights', () => {
    expect(
      derivedAmountMinor('LODGING', {
        checkIn: '2026-09-14',
        checkOut: '2026-09-18',
        nights: 4,
        nightlyMinor: '22500',
        capPerNightMinor: '20000',
      }),
    ).toBe(90_000n);
  });

  it('does NOT clamp a quoted stay to the per-diem cap', () => {
    /**
     * $225/night against a $200 cap is budgeted at $225. Clamping produces a budget the
     * trip cannot be taken within; the cap survives in the payload as the reason the
     * line is flagged, not as the number that was used.
     */
    const amount = derivedAmountMinor('LODGING', {
      checkIn: '2026-09-14',
      checkOut: '2026-09-15',
      nights: 1,
      nightlyMinor: '22500',
      capPerNightMinor: '20000',
    });
    expect(amount).toBe(22_500n);
  });

  it('falls back to the cap × nights when nothing was quoted', () => {
    expect(
      derivedAmountMinor('LODGING', {
        checkIn: '2026-09-14',
        checkOut: '2026-09-18',
        nights: 4,
        capPerNightMinor: '20000',
      }),
    ).toBe(80_000n);
  });

  it('prices a department meal as heads × occurrences × days × allowance', () => {
    // 3 people, twice a day, 4 days, $25.00 each = 24 covers = $600.00. Nobody should
    // be doing that multiplication in their head into a single box.
    expect(
      derivedAmountMinor('DEPARTMENT_MEAL', {
        attendees: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Katherine' }],
        occurrencesPerDay: 2,
        days: 4,
        ratePerPersonMinor: '2500',
      }),
    ).toBe(60_000n);
  });

  it('prices a meal with nobody at it as zero, not as null', () => {
    // Zero attendees is a complete, meaningful answer: the meal costs nothing until
    // somebody is going to it. Null would read as "could not be priced".
    expect(
      derivedAmountMinor('DEPARTMENT_MEAL', {
        attendees: [],
        occurrencesPerDay: 2,
        days: 4,
        ratePerPersonMinor: '2500',
      }),
    ).toBe(0n);
  });

  it('prices a car and a ground leg at the daily cap × days', () => {
    expect(derivedAmountMinor('CAR_RENTAL', { days: 3, dailyCapMinor: '7500' })).toBe(22_500n);
    expect(derivedAmountMinor('GROUND', { days: 5, dailyCapMinor: '4000' })).toBe(20_000n);
  });

  it('returns null when a kind cannot be priced from its payload alone', () => {
    /**
     * Null means "not derivable here", never zero — a free flight and an unpriceable
     * one must not look alike.
     *
     * STANDARD needs per-diem rates and a calendar, which a pure package must not know
     * about. AIRFARE's amount is the stored quote's price, re-read rather than
     * recomputed: a payload that could restate an approved fare would defeat the point
     * of snapshotting it.
     */
    expect(derivedAmountMinor('STANDARD', {})).toBeNull();
    expect(
      derivedAmountMinor('AIRFARE', {
        fromLabel: 'Montréal',
        toLabel: 'Toronto',
        tripType: 'ONE_WAY',
        travelClass: 'ECONOMY',
        outboundDate: '2026-09-14',
      }),
    ).toBeNull();
    // And the cap-priced kinds, with no cap to price from.
    expect(derivedAmountMinor('CAR_RENTAL', { days: 3 })).toBeNull();
    expect(derivedAmountMinor('GROUND', { dailyCapMinor: '4000' })).toBeNull();
    expect(
      derivedAmountMinor('LODGING', { checkIn: '2026-09-14', checkOut: '2026-09-18', nights: 0 }),
    ).toBeNull();
  });

  it('returns null for a stay with known dates that nothing priced', () => {
    // Distinct from `nights: 0`: the trip IS four nights, and neither a quote nor a cap
    // exists to price them. Zero here would read as four free nights.
    expect(
      derivedAmountMinor('LODGING', {
        checkIn: '2026-09-14',
        checkOut: '2026-09-18',
        nights: 4,
      }),
    ).toBeNull();
  });

  it('returns null for a meal with attendees but no allowance to price them at', () => {
    expect(
      derivedAmountMinor('DEPARTMENT_MEAL', {
        attendees: [{ name: 'Ada' }],
        occurrencesPerDay: 1,
        days: 2,
      }),
    ).toBeNull();
  });

  it('returns null rather than throwing on a malformed payload', () => {
    for (const kind of TRAVEL_LINE_KINDS) {
      expect(derivedAmountMinor(kind, { totally: 'wrong' })).toBeNull();
    }
  });
});

describe('capability helpers', () => {
  it('names the two kinds a provider can price', () => {
    // These are the two that get an option picker; everything else gets a figure
    // derived or typed.
    expect(TRAVEL_LINE_KINDS.filter(kindIsQuotable)).toEqual(['AIRFARE', 'LODGING']);
  });

  it('names the one kind that captures attendees', () => {
    expect(TRAVEL_LINE_KINDS.filter(kindCarriesAttendees)).toEqual(['DEPARTMENT_MEAL']);
  });
});

// ── The route ─────────────────────────────────────────────────────────────────

describe('routeFromLegs', () => {
  it('shows a RETURN trip as the whole path, not origin to origin', () => {
    /**
     * The bug this replaced. `first.from → last.to` rendered a return Calgary–Orlando as
     * `YYC → YYC`: accurate, and it tells the reader nothing about where they went, which
     * is the one fact a fare row exists to carry.
     */
    expect(
      routeFromLegs([
        { from: 'YYC', to: 'MCO' },
        { from: 'MCO', to: 'YYC' },
      ]),
    ).toEqual(['YYC', 'MCO', 'YYC']);
  });

  it('shows a one-way as two airports', () => {
    expect(routeFromLegs([{ from: 'YUL', to: 'LHR' }])).toEqual(['YUL', 'LHR']);
  });

  it('surfaces a CONNECTION rather than hiding it behind a stop count', () => {
    expect(
      routeFromLegs([
        { from: 'YYZ', to: 'YYC' },
        { from: 'YYC', to: 'MCO' },
      ]),
    ).toEqual(['YYZ', 'YYC', 'MCO']);
  });

  it('shows a multi-city trip in the order it is flown', () => {
    expect(
      routeFromLegs([
        { from: 'YUL', to: 'CDG' },
        { from: 'CDG', to: 'FCO' },
        { from: 'FCO', to: 'YUL' },
      ]),
    ).toEqual(['YUL', 'CDG', 'FCO', 'YUL']);
  });

  it('collapses a repeated interchange rather than printing it twice', () => {
    // Some providers return a zero-length hop between an arrival and the next departure.
    expect(
      routeFromLegs([
        { from: 'YYC', to: 'MCO' },
        { from: 'MCO', to: 'MCO' },
        { from: 'MCO', to: 'YYC' },
      ]),
    ).toEqual(['YYC', 'MCO', 'YYC']);
  });

  it('keeps a genuine there-and-back-again, which is not a repeat', () => {
    // The discriminating case for the collapse above: YYC appears twice and must stay.
    expect(
      routeFromLegs([
        { from: 'YYC', to: 'MCO' },
        { from: 'MCO', to: 'YYC' },
      ]).length,
    ).toBe(3);
  });

  it('drops blanks and non-strings instead of printing them', () => {
    expect(
      routeFromLegs([
        { from: 'YYC', to: '' },
        { from: null, to: 'MCO' },
        { from: 7, to: 'YYZ' },
      ]),
    ).toEqual(['YYC', 'MCO', 'YYZ']);
  });

  it('is empty for no legs at all', () => {
    expect(routeFromLegs([])).toEqual([]);
  });
});

describe('flightRouteOf', () => {
  it('reads the path off a stored payload', () => {
    expect(
      flightRouteOf({
        fromLabel: 'YYC',
        toLabel: 'MCO',
        legs: [
          { from: 'YYC', to: 'MCO' },
          { from: 'MCO', to: 'YYC' },
        ],
      }),
    ).toEqual(['YYC', 'MCO', 'YYC']);
  });

  it('falls back to the SEARCH endpoints when no legs were recorded', () => {
    // A manual airfare line, or one priced before the legs existed, still knows where it
    // was meant to go.
    expect(flightRouteOf({ fromLabel: 'YUL', toLabel: 'LHR', legs: [] })).toEqual(['YUL', 'LHR']);
  });

  it('is empty when it knows neither, rather than inventing a route', () => {
    expect(flightRouteOf({ legs: [] })).toEqual([]);
  });

  it('is empty on a payload it cannot read', () => {
    expect(flightRouteOf({ legs: 'not an array' })).toEqual([]);
  });
});

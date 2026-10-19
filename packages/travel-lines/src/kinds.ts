/**
 * The travel budget-line KIND registry.
 *
 * A line is a category and an amount, plus whatever its kind needs. `ExpenseLineItem`
 * already proved how that goes wrong when each kind adds its own columns: six nullable
 * mileage fields that mean nothing on a meal, and the next kind would add more. So a
 * kind declares its payload here, as a zod schema, and the row carries one `payload`
 * Json column validated against it.
 *
 * The shape mirrors `@expenseos/expense-lines`, which mirrors the policy-rule kind
 * registry: engineers add a kind in ONE place, and every consumer — the tRPC writes,
 * the drawer's editor block, the report generator — reads it through the accessors
 * below rather than reaching into the Json.
 *
 * ## Two boundaries this package holds
 *
 * **Money.** Payloads carry minor amounts as digit STRINGS, because BigInt does not
 * survive JSON — `JSON.stringify` throws on it rather than coercing. The accessors
 * hand back BigInt, so no consumer is tempted to do arithmetic on a string or, worse,
 * on a float that round-tripped through `Number`.
 *
 * **Purity.** No database, no clock, no FX table, no provider. A per-diem allowance
 * needs rates and a calendar and therefore is NOT derived here; what is derived here is
 * the arithmetic that depends on nothing but the payload itself. That is what makes
 * `derivedAmountMinor` testable without standing anything up, and what stops two
 * callers computing a department meal two different ways.
 *
 * ## What is NOT here
 *
 * `TravelLineKind` itself lives in the Prisma schema, and this module deliberately does
 * not import it — a value import would pull in the Prisma client and make a pure
 * package need a database. `TRAVEL_LINE_KINDS` below is the same list, and
 * `kinds.test.ts` is where the two are asserted to agree.
 */

import { z } from 'zod';

export const TRAVEL_LINE_KINDS = [
  'STANDARD',
  'AIRFARE',
  'LODGING',
  'DEPARTMENT_MEAL',
  'CAR_RENTAL',
  'GROUND',
] as const;
export type TravelLineKindName = (typeof TRAVEL_LINE_KINDS)[number];

/** Minor units on the wire: BigInt doesn't survive JSON, so payloads carry digit
 *  strings and the accessors hand back BigInt. Non-negative — a negative "estimate"
 *  would silently reduce the total an approver is being asked to authorise. */
const minorString = z.string().regex(/^\d+$/, 'minor units must be a non-negative integer string');

/**
 * A calendar date, `YYYY-MM-DD`.
 *
 * Not a timestamp. A trip is a range of calendar dates, and the whole travel module
 * reads dates in UTC for one reason: running the same request from Montréal and from
 * Vancouver must not produce itineraries that differ by a day.
 *
 * An empty string is allowed and means "not chosen yet" — see the note below. A
 * malformed one is still refused: `2026-9-14` and a timestamp are both rejected.
 */
const calendarDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'expected a YYYY-MM-DD date')
  .default('');

/**
 * ## EMPTY PAYLOADS MUST VALIDATE
 *
 * Every field below that looks required is defaulted, and that is not laziness — it is
 * the flow. A traveller adds an "Airfare" line and THEN searches for a flight; a car
 * line exists before anybody has typed how many days. `parseTravelLinePayload('CAR_RENTAL', {})`
 * throwing meant neither line could be created at all, which is exactly what the
 * end-to-end run caught: "Invalid input: expected number, received undefined" on `days`,
 * from pressing Add on a car with no payload.
 *
 * What the registry is for is refusing FOREIGN fields (`.strict()`) and MALFORMED values —
 * a float where minor units belong, a timestamp where a calendar date belongs, a cabin
 * number where a name belongs. Not demanding a complete itinerary at creation. The
 * AMOUNT is what carries authority, and an incomplete payload simply derives nothing:
 * `derivedAmountMinor` returns null, and the line sits at zero visibly wanting a figure.
 */

/**
 * Bounded counts. A trip of 400 nights is a data-entry accident, and an unbounded count
 * multiplied by a rate is how a fat finger reaches an approval tier.
 *
 * DEFAULTED to zero, which is the rule every required-looking field below follows — see
 * the note on `EMPTY PAYLOADS MUST VALIDATE`.
 */
const dayCount = z.number().int().min(0).max(366).default(0);

/**
 * Cabin, by NAME rather than by the provider's number.
 *
 * SerpApi takes 1–4 (`TRAVEL_CLASS` in `@expenseos/travel-search`). A payload is read
 * back years later to explain what was approved, and `"travelClass": 3` explains
 * nothing. The caller maps the name to the provider's number at the edge, which is also
 * the only place that has to change if a provider renumbers them.
 */
export const TRAVEL_CLASS_NAMES = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const;
export type TravelClassName = (typeof TRAVEL_CLASS_NAMES)[number];

export const TRIP_SHAPES = ['ROUND_TRIP', 'ONE_WAY', 'MULTI_CITY'] as const;

// ── Payloads, one per kind ──────────────────────────────────────────────────

/**
 * A plain line, plus the per-diem derivation when the amount came from an allowance.
 *
 * The derivation used to be nowhere. `priceLine` computed it, composed a prose string
 * ("Per diem · 3 days · Toronto · first/last day halved") into the line's `detail`, and
 * discarded the numbers. That cost three things: `detail` was no longer free for the
 * traveller's own words (so no rule could require one), the sentence was English-only,
 * and the derivation could not be re-read — only re-parsed out of prose.
 *
 * So the FACTS live here and the sentence is composed at render, in the reader's locale.
 * The same argument the airfare payload makes: the search is what makes the number
 * reproducible, and a number nobody can reproduce is not evidence.
 *
 * SERVER-WRITTEN, always. `priceLine` strips these off whatever the client posted and
 * sets them only on the per-diem path, so a typed figure cannot arrive dressed as an
 * allowance — the same property the `basis` ladder exists to protect.
 */
const standardPayload = z
  .object({
    /**
     * Days the allowance was applied over, edges included.
     *
     * Its own schema rather than `dayCount.nullish()`: `dayCount` carries `.default(0)`,
     * and `.nullish()` wraps the default so an absent value stays `undefined` instead of
     * becoming 0. Both behaviours are defensible; stacking them means the reader has to
     * know which wins. Here absent means "no allowance was applied", and 0 would be a
     * claim about one that was.
     */
    perDiemDays: z.number().int().min(0).max(366).nullish(),
    /** The city the rate was matched on — free text, as `PerDiemRate.city` is. */
    perDiemCity: z.string().max(300).nullish(),
    /** The daily rate, already converted into the REQUEST's currency. */
    perDiemDailyMinor: minorString.nullish(),
    /** Whether the first and last day were counted at half. */
    perDiemEdgeHalved: z.boolean().nullish(),
  })
  .strict();

/** One leg of the chosen itinerary, normalized from the provider. */
const flightLeg = z
  .object({
    from: z.string().min(1).max(120),
    to: z.string().min(1).max(120),
    /** Provider-formatted local departure/arrival, e.g. "2026-09-14 08:05". Kept
     *  verbatim: it is what the traveller saw when they picked this flight. */
    departsAt: z.string().max(60).nullish(),
    arrivesAt: z.string().max(60).nullish(),
    airline: z.string().max(120).nullish(),
    /** "AC 412". The single most useful thing on the whole line months later. */
    flightNumber: z.string().max(40).nullish(),
    durationMinutes: z.number().int().min(0).max(100_000).nullish(),
  })
  .strict();

/**
 * A flight the traveller chose, and the search that produced it.
 *
 * Both halves matter. The SEARCH (from, to, dates, cabin) is what makes the number
 * reproducible; the CHOICE (legs, flight numbers) is what makes it checkable against a
 * boarding pass. `pricedAt` is when, because a fare is only meaningful with a date on it.
 */
const airfarePayload = z
  .object({
    fromId: z.string().max(200).nullish(),
    fromLabel: z.string().max(300).default(''),
    toId: z.string().max(200).nullish(),
    toLabel: z.string().max(300).default(''),
    tripType: z.enum(TRIP_SHAPES).default('ROUND_TRIP'),
    travelClass: z.enum(TRAVEL_CLASS_NAMES).default('ECONOMY'),
    /** SerpApi's numbering: 0 any · 1 nonstop · 2 ≤1 stop · 3 ≤2 stops. */
    maxStops: z.number().int().min(0).max(3).nullish(),
    outboundDate: calendarDate,
    returnDate: calendarDate.nullish(),
    legs: z.array(flightLeg).max(24).default([]),
    /** Retained so a later phase can offer "book this" without a second search —
     *  which would also be a second charge. */
    bookingToken: z.string().max(4000).nullish(),
    pricedAt: z.string().max(40).nullish(),
    /**
     * What the PROVIDER quoted, before FX.
     *
     * The line's `amountMinor` is in the request's currency, because a line carries none of
     * its own. This is the figure the provider actually named, and it is the one piece of
     * evidence the dropped `TravelQuote` table used to hold: an approved estimate should
     * still be able to say "the airline quoted USD 512" rather than only the converted
     * number, which depends on an FX rate that moves.
     */
    providerAmountMinor: minorString.nullish(),
    providerCurrency: z.string().length(3).nullish(),
  })
  .strict();

/**
 * A stay. `nightlyMinor` and `capPerNightMinor` are both kept, deliberately.
 *
 * A quoted rate over the per-diem cap is budgeted at the QUOTE — clamping to the cap
 * produces a budget the trip cannot be taken within — so the cap survives beside it as
 * the reason the line is flagged rather than as the number that was used.
 */
const lodgingPayload = z
  .object({
    city: z.string().max(300).nullish(),
    checkIn: calendarDate,
    checkOut: calendarDate,
    nights: dayCount,
    propertyName: z.string().max(300).nullish(),
    propertyToken: z.string().max(4000).nullish(),
    nightlyMinor: minorString.nullish(),
    rating: z.number().min(0).max(10).nullish(),
    starClass: z.number().int().min(0).max(7).nullish(),
    capPerNightMinor: minorString.nullish(),
    pricedAt: z.string().max(40).nullish(),
    /**
     * What the PROVIDER quoted, before FX.
     *
     * The line's `amountMinor` is in the request's currency, because a line carries none of
     * its own. This is the figure the provider actually named, and it is the one piece of
     * evidence the dropped `TravelQuote` table used to hold: an approved estimate should
     * still be able to say "the airline quoted USD 512" rather than only the converted
     * number, which depends on an FX rate that moves.
     */
    providerAmountMinor: minorString.nullish(),
    providerCurrency: z.string().length(3).nullish(),
  })
  .strict();

/** Somebody who will be at the meal. A flat snapshot, exactly like `ExpenseAttendee`:
 *  no FK to `User`, because a client guest is not a user and never will be. */
const attendee = z
  .object({
    name: z.string().min(1).max(200),
    company: z.string().max(200).nullish(),
    /** True for guests outside the company (clients, vendors); false for staff. */
    isExternal: z.boolean().default(false),
  })
  .strict();

/**
 * A meal with people at it, priced per head.
 *
 * `occurrencesPerDay` is the field that makes this a kind rather than a typed amount: a
 * team eating together twice a day for four days is sixteen covers at the allowance,
 * and nobody should be doing that multiplication in their head into a single box.
 */
const departmentMealPayload = z
  .object({
    attendees: z.array(attendee).max(200).default([]),
    occurrencesPerDay: z.number().int().min(0).max(24).default(0),
    days: dayCount,
    /** The per-diem allowance per person per occurrence, snapshotted. */
    ratePerPersonMinor: minorString.nullish(),
  })
  .strict();

/** A rental car. Priced from a policy cap: no provider on the travel integration
 *  quotes car hire, so a cap × days is the only honest figure available. */
const carRentalPayload = z
  .object({
    pickUpDate: calendarDate.nullish(),
    dropOffDate: calendarDate.nullish(),
    days: dayCount,
    dailyCapMinor: minorString.nullish(),
  })
  .strict();

/** Taxi, rideshare or transit. Same cap-times-days shape as a car, with a note instead
 *  of dates — nobody plans the calendar of their airport taxis. */
const groundPayload = z
  .object({
    days: dayCount.nullish(),
    dailyCapMinor: minorString.nullish(),
    note: z.string().max(200).nullish(),
  })
  .strict();

const PAYLOAD_SCHEMAS = {
  STANDARD: standardPayload,
  AIRFARE: airfarePayload,
  LODGING: lodgingPayload,
  DEPARTMENT_MEAL: departmentMealPayload,
  CAR_RENTAL: carRentalPayload,
  GROUND: groundPayload,
} satisfies Record<TravelLineKindName, z.ZodTypeAny>;

export type StandardPayload = z.infer<typeof standardPayload>;
export type AirfarePayload = z.infer<typeof airfarePayload>;
export type LodgingPayload = z.infer<typeof lodgingPayload>;
export type DepartmentMealPayload = z.infer<typeof departmentMealPayload>;
export type CarRentalPayload = z.infer<typeof carRentalPayload>;
export type GroundPayload = z.infer<typeof groundPayload>;

export function payloadSchemaFor(kind: TravelLineKindName): z.ZodTypeAny {
  return PAYLOAD_SCHEMAS[kind];
}

/**
 * Validate a payload for its kind. THROWS on mismatch — a line whose payload does not
 * fit its kind is a bug, not user input to be salvaged. Use on every write.
 */
export function parseTravelLinePayload(kind: TravelLineKindName, payload: unknown): unknown {
  return payloadSchemaFor(kind).parse(payload ?? {});
}

/**
 * Read a payload back, or null if it does not fit its kind.
 *
 * Tolerant on READ, strict on write — the same split `tipMinorOf` makes, for the same
 * reason: a display path must not break on one bad row. A drawer rendering fifty lines
 * should show the forty-nine it understands, not a blank page.
 */
export function readTravelLinePayload<K extends TravelLineKindName>(
  kind: K,
  payload: unknown,
): z.infer<(typeof PAYLOAD_SCHEMAS)[K]> | null {
  const parsed = PAYLOAD_SCHEMAS[kind].safeParse(payload ?? {});
  return parsed.success ? (parsed.data as z.infer<(typeof PAYLOAD_SCHEMAS)[K]>) : null;
}

/** Whether a kind's amount is meant to come from a live provider quote. Both of these
 *  get an option picker; everything else gets a figure derived or typed. */
export function kindIsQuotable(kind: TravelLineKindName): boolean {
  return kind === 'AIRFARE' || kind === 'LODGING';
}

/** Whether a kind captures attendees at all. Drives whether the editor offers them —
 *  the same job `ExpenseCategory.requiresAttendees` does on the expense side. */
export function kindCarriesAttendees(kind: TravelLineKindName): boolean {
  return kind === 'DEPARTMENT_MEAL';
}

const toMinor = (v: string | null | undefined): bigint | null =>
  v == null || !/^\d+$/.test(v) ? null : BigInt(v);

/**
 * The amount a payload implies, or null when the payload cannot imply one.
 *
 * ONE implementation, because the alternative is two callers computing a department
 * meal differently and a budget that disagrees with its own lines. Null is a real
 * answer and means "not derivable from this payload alone", not zero:
 *
 *   · **STANDARD** — a per-diem needs rates and a calendar, which this package must
 *     not know about. Derived by the server, or typed.
 *   · **AIRFARE** — the amount is the chosen quote's price, re-read from the stored
 *     quote rather than recomputed from anything here. A payload that could restate an
 *     approved fare would defeat the point of snapshotting it.
 *   · **LODGING** — the quoted nightly rate × nights, falling back to the cap × nights
 *     when nothing was quoted. Over-cap is NOT clamped: see `lodgingPayload`.
 *   · **DEPARTMENT_MEAL** — heads × occurrences per day × days × the allowance.
 *   · **CAR_RENTAL / GROUND** — the daily cap × days.
 */
export function derivedAmountMinor(kind: TravelLineKindName, payload: unknown): bigint | null {
  switch (kind) {
    case 'LODGING': {
      const p = readTravelLinePayload('LODGING', payload);
      if (!p || p.nights <= 0) return null;
      const rate = toMinor(p.nightlyMinor) ?? toMinor(p.capPerNightMinor);
      return rate == null ? null : rate * BigInt(p.nights);
    }
    case 'DEPARTMENT_MEAL': {
      const p = readTravelLinePayload('DEPARTMENT_MEAL', payload);
      if (!p) return null;
      const rate = toMinor(p.ratePerPersonMinor);
      if (rate == null) return null;
      const covers = BigInt(p.attendees.length) * BigInt(p.occurrencesPerDay) * BigInt(p.days);
      return rate * covers;
    }
    case 'CAR_RENTAL': {
      const p = readTravelLinePayload('CAR_RENTAL', payload);
      if (!p) return null;
      const cap = toMinor(p.dailyCapMinor);
      return cap == null || p.days <= 0 ? null : cap * BigInt(p.days);
    }
    case 'GROUND': {
      const p = readTravelLinePayload('GROUND', payload);
      if (!p) return null;
      const cap = toMinor(p.dailyCapMinor);
      const days = p.days ?? 0;
      return cap == null || days <= 0 ? null : cap * BigInt(days);
    }
    // Not derivable from the payload alone — see the note above.
    default:
      return null;
  }
}

/**
 * The flight numbers on a line, in itinerary order.
 *
 * An accessor rather than a reach into the Json, because this is what a list column and
 * a generated expense line both want, and two hand-rolled versions of it would disagree
 * about a null leg.
 */
export function flightNumbersOf(payload: unknown): string[] {
  const p = readTravelLinePayload('AIRFARE', payload);
  if (!p) return [];
  return p.legs.map((l) => l.flightNumber).filter((n): n is string => !!n);
}

/**
 * The airports a flight actually touches, in order.
 *
 * ## Why not first-leg-origin → last-leg-destination
 *
 * Because for a RETURN flight that renders `YYZ → YYZ`, which is accurate and tells the
 * reader nothing: the one fact they want from a fare row is where the trip went. The legs
 * already hold it — a return Calgary–Orlando is `YYC→MCO` then `MCO→YYC` — so the path is
 * `YYC → MCO → YYC` and the turnaround is visible.
 *
 * It also surfaces CONNECTIONS for free, which is the same fact one level down: a
 * `YYZ→YYC` + `YYC→MCO` itinerary reads `YYZ → YYC → MCO` rather than hiding the stop
 * behind a count.
 *
 * Consecutive duplicates are collapsed so a provider that repeats the interchange (some
 * return a `MCO→MCO` zero-length hop between an arrival and the next departure) does not
 * produce `MCO → MCO`.
 *
 * Returns the airports rather than a joined string: the caller owns the separator, and
 * both callers here render into different type scales.
 */
export function routeFromLegs(legs: ReadonlyArray<{ from?: unknown; to?: unknown }>): string[] {
  const path: string[] = [];
  const push = (value: unknown) => {
    const code = typeof value === 'string' ? value.trim() : '';
    if (!code) return;
    if (path[path.length - 1] === code) return;
    path.push(code);
  };
  for (const leg of legs) {
    push(leg?.from);
    push(leg?.to);
  }
  return path;
}

/**
 * The route on a stored AIRFARE line, from its payload.
 *
 * Falls back to the SEARCH's endpoints when the itinerary has no legs — a line priced
 * before the legs were recorded, or a manual airfare line, still knows where it was meant
 * to go. Empty when it knows neither, which the caller renders as em dashes rather than
 * inventing a route.
 */
export function flightRouteOf(payload: unknown): string[] {
  const p = readTravelLinePayload('AIRFARE', payload);
  if (!p) return [];
  const fromLegs = routeFromLegs(p.legs);
  if (fromLegs.length > 0) return fromLegs;
  return routeFromLegs([{ from: p.fromLabel, to: p.toLabel }]);
}

/** Heads at the meal, or 0. */
export function attendeeCountOf(payload: unknown): number {
  return readTravelLinePayload('DEPARTMENT_MEAL', payload)?.attendees.length ?? 0;
}

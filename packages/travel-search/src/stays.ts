/**
 * Lodging: hotels and vacation rentals, from one engine.
 *
 * SerpApi's `google_hotels` covers both — `vacation_rentals=true` switches which
 * inventory it searches. That is why "rentals" here means VACATION rentals.
 *
 * Car rental is NOT covered: SerpApi has no car engine, so there is no honest live
 * quote for it. The travel budget prices a car from the policy's daily cap instead
 * (the legacy `BOOKING_ENFORCEMENT` already carried $75/day), and says so, rather
 * than inventing a number and calling it a quote.
 */

import { type SearchOptions, type SerpApiConfig, serpApiSearch } from './client';
import { toMinor } from './money';
import type { StayOption } from './types';

export interface StaySearchInput {
  /** Free text the provider geocodes — "Toronto hotels", "Austin TX". */
  query: string;
  /** YYYY-MM-DD. */
  checkInDate: string;
  checkOutDate: string;
  adults?: number;
  /** Search vacation rentals instead of hotels. */
  vacationRentals?: boolean;
  /** Cap in major units, passed to the provider so it filters rather than us —
   *  filtering server-side after paying for 40 results wastes the search. */
  maxPrice?: number;
  /** 3 lowest price · 8 highest rating · 13 most reviewed. SerpApi's numbering. */
  sortBy?: 3 | 8 | 13;
}

export interface StaySearchResult {
  properties: StayOption[];
  currency: string;
  /** Nights the search covered, derived from the dates the caller passed. Carried
   *  because a nightly rate is only a budget once multiplied by this, and deriving
   *  it twice in two places is how the two disagree. */
  nights: number;
}

/**
 * Whole nights between two YYYY-MM-DD dates.
 *
 * Parsed as UTC on purpose: these are calendar dates, and constructing them in
 * local time makes a trip one night shorter for anyone behind UTC. Returns 0 for
 * anything unparseable or reversed, so a malformed range prices as nothing rather
 * than as a negative budget.
 */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

export async function searchStays(
  config: SerpApiConfig,
  input: StaySearchInput,
  opts: SearchOptions = {},
): Promise<StaySearchResult> {
  const currency = (config.currency ?? 'USD').toUpperCase();
  const nights = nightsBetween(input.checkInDate, input.checkOutDate);
  const json = await serpApiSearch(
    config,
    {
      engine: 'google_hotels',
      q: input.query,
      check_in_date: input.checkInDate,
      check_out_date: input.checkOutDate,
      adults: input.adults ?? 1,
      vacation_rentals: input.vacationRentals ? true : undefined,
      max_price: input.maxPrice,
      sort_by: input.sortBy,
      currency,
      gl: config.gl,
      hl: config.hl,
    },
    opts,
  );

  const raw = Array.isArray(json.properties) ? json.properties : [];
  const properties = raw
    .map((p) => {
      const row = p as {
        name?: unknown;
        type?: unknown;
        rate_per_night?: { extracted_lowest?: unknown };
        total_rate?: { extracted_lowest?: unknown };
        overall_rating?: unknown;
        reviews?: unknown;
        extracted_hotel_class?: unknown;
        property_token?: unknown;
      };
      const nightlyMinor = toMinor(row.rate_per_night?.extracted_lowest, currency);
      const totalMinor = toMinor(row.total_rate?.extracted_lowest, currency);
      // A property with neither figure is a listing we cannot budget from.
      if (nightlyMinor === null && totalMinor === null) return null;
      return {
        name: typeof row.name === 'string' ? row.name : '',
        kind: typeof row.type === 'string' ? row.type : 'hotel',
        nightlyMinor,
        totalMinor,
        currency,
        rating: typeof row.overall_rating === 'number' ? row.overall_rating : null,
        reviews: typeof row.reviews === 'number' ? row.reviews : null,
        starClass: typeof row.extracted_hotel_class === 'number' ? row.extracted_hotel_class : null,
        propertyToken: typeof row.property_token === 'string' ? row.property_token : null,
      } satisfies StayOption;
    })
    .filter((s): s is StayOption => s !== null && !!s.name);

  return { properties, currency, nights };
}

/**
 * The nightly rate to budget a stay at.
 *
 * Prefers the provider's own nightly figure; falls back to dividing the total by
 * the nights, because some listings only publish one of the two. Returns null when
 * neither is derivable — the caller then falls back to the per-diem lodging cap,
 * which is a policy number rather than a market one and should be labelled as such.
 */
export function nightlyRateMinor(stay: StayOption, nights: number): bigint | null {
  if (stay.nightlyMinor !== null) return stay.nightlyMinor;
  if (stay.totalMinor !== null && nights > 0) return stay.totalMinor / BigInt(nights);
  return null;
}

/**
 * The cheapest bookable stay, or null.
 *
 * "Cheapest" is by the figure we would actually budget, not by whichever field the
 * provider happened to populate — comparing a nightly rate against another
 * property's whole-stay total would pick the wrong one every time.
 */
export function cheapestStay(result: StaySearchResult): StayOption | null {
  let best: StayOption | null = null;
  let bestRate: bigint | null = null;
  for (const s of result.properties) {
    const rate = nightlyRateMinor(s, result.nights);
    if (rate === null) continue;
    if (bestRate === null || rate < bestRate) {
      best = s;
      bestRate = rate;
    }
  }
  return best;
}

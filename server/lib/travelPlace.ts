/**
 * Google place → the airports you can fly into for it.
 *
 * Two vocabularies have to meet somewhere. Google Places owns the destination
 * picker — one place picker across the product, one durable `placeId`. SerpApi's
 * flight engine has never heard of a Google placeId and wants its own metro id or an
 * IATA code. This is the join, and `TravelPlace` is where the answer is kept.
 *
 * Resolved ONCE per place, not once per request. Fifty people flying to Toronto cost
 * one billable autocomplete call, everyone gets the same airports, and a mapping an
 * admin corrects is corrected for everyone at once.
 *
 * A negative result is cached too. A place SerpApi has nothing for is a real answer
 * worth remembering — otherwise every request to a town without an airport re-pays
 * to learn the same nothing.
 */

import type { PrismaClient } from '@expenseos/db';
import { type SerpApiConfig, suggestPlaces } from '@expenseos/travel-search';
import { currentTenantId } from '@/lib/db/prisma';

/** How long a resolution stands before it is worth asking again. Airports do not
 *  move; this exists so a mapping that was wrong or thin eventually self-heals,
 *  not because the data expires. */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface ResolvedPlace {
  /** SerpApi metro id, when it had one. Null is a resolved answer, not a failure. */
  serpPlaceId: string | null;
  /** IATA codes, e.g. ["YYZ","YTZ"]. */
  airports: string[];
}

export interface PlaceKey {
  /** Google's durable handle. The cache key when present. */
  placeId?: string | null;
  /** What to search SerpApi for, and the fallback cache key. */
  label: string;
  city?: string | null;
  country?: string | null;
}

const EMPTY: ResolvedPlace = { serpPlaceId: null, airports: [] };

type Db = Pick<PrismaClient, 'travelPlace'>;

function fresh(resolvedAt: Date, now: number): boolean {
  return now - resolvedAt.getTime() < TTL_MS;
}

/**
 * Pick the metro and its airports out of SerpApi's suggestions.
 *
 * Preference order is deliberate: a CITY suggestion prices the whole metro, which is
 * what a traveller flying to London actually wants. Falling straight to the first
 * airport would silently commit them to Heathrow and hide the Gatwick fare.
 */
export function readSuggestions(
  suggestions: Awaited<ReturnType<typeof suggestPlaces>>,
): ResolvedPlace {
  const city = suggestions.find((s) => s.kind === 'city' && s.airports.length > 0);
  if (city) {
    return {
      serpPlaceId: city.id,
      airports: [...new Set(city.airports.map((a) => a.id).filter(Boolean))],
    };
  }
  // No metro, but a bare airport is still a usable answer — a lot of smaller places
  // resolve this way, and one airport beats no flights.
  const airport = suggestions.find((s) => s.kind === 'airport');
  if (airport) return { serpPlaceId: airport.id, airports: [airport.id] };

  const any = suggestions[0];
  if (any) {
    return {
      serpPlaceId: any.id,
      airports: [...new Set(any.airports.map((a) => a.id).filter(Boolean))],
    };
  }
  return EMPTY;
}

/**
 * Resolve a place, using the cache when it can and paying for a lookup when it must.
 *
 * `config` may be null — an org with no SerpApi plan still gets whatever is already
 * cached, and an empty answer otherwise. That is the difference between travel
 * degrading and travel breaking.
 *
 * A provider failure is swallowed to an empty result rather than thrown: the caller
 * is pricing a trip, and a trip that cannot be quoted still has per-diem lines and
 * still needs to reach an approver.
 */
export async function resolveTravelPlace(
  db: Db,
  config: SerpApiConfig | null,
  key: PlaceKey,
  now: Date = new Date(),
): Promise<ResolvedPlace> {
  const cacheKey = key.placeId?.trim() || `label:${key.label.trim().toLowerCase()}`;
  if (!cacheKey || cacheKey === 'label:') return EMPTY;

  // VeloExpense (w6-01): `travel_place` is per tenant (0077), so `placeId` is unique within
  // the tenant, not globally. The read is the tenant's own under RLS; the write below names
  // the tenant in the compound key.
  const cached = await db.travelPlace.findFirst({ where: { placeId: cacheKey } });
  if (cached) {
    // A pinned row is an admin's correction and outranks both the TTL and the
    // provider. Refreshing over it would undo the fix on a schedule.
    if (cached.pinnedAt || fresh(cached.resolvedAt, now.getTime()) || !config) {
      return { serpPlaceId: cached.serpPlaceId, airports: cached.airports };
    }
  }
  if (!config) return EMPTY;

  let resolved = EMPTY;
  try {
    // Search on the city when we have one: "Toronto" resolves, "123 Bloor St W,
    // Toronto, ON, Canada" does not, and the destination picker returns the latter.
    const query = key.city?.trim() || key.label.trim();
    resolved = readSuggestions(await suggestPlaces(config, query));
  } catch (e) {
    console.warn('[travel] place resolution failed', e);
    // Fall through to the write: caching the miss is the point. Without it, a
    // provider outage means every request re-tries and re-pays for the same failure.
  }

  // VeloExpense (w6-01): the tenant's own row — see the read above.
  const organizationId = currentTenantId();
  if (!organizationId) throw new Error('resolveTravelPlace: no tenant scope');
  await db.travelPlace.upsert({
    where: { organizationId_placeId: { organizationId, placeId: cacheKey } },
    create: {
      placeId: cacheKey,
      label: key.label.trim(),
      city: key.city?.trim() || null,
      country: key.country?.trim() || null,
      serpPlaceId: resolved.serpPlaceId,
      airports: resolved.airports,
      resolvedAt: now,
    },
    update: {
      label: key.label.trim(),
      city: key.city?.trim() || null,
      country: key.country?.trim() || null,
      serpPlaceId: resolved.serpPlaceId,
      airports: resolved.airports,
      resolvedAt: now,
    },
  });
  return resolved;
}

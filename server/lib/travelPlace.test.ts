import { describe, expect, it, vi } from 'vitest';
import { readSuggestions, resolveTravelPlace } from './travelPlace';

/**
 * The cache is the whole point of this module — every miss is a billable SerpApi
 * call — so most of what is pinned here is about when it does NOT call out.
 */

type Suggestion = Parameters<typeof readSuggestions>[0][number];

function suggestion(over: Partial<Suggestion> = {}): Suggestion {
  return { id: 'YYZ', name: 'Pearson', kind: 'airport', description: null, airports: [], ...over };
}

const CONFIG = { apiKey: 'k' };

// VeloExpense (w6-01): the read is `findFirst` (the place is unique within a tenant, 0077),
// so the stub answers that; ExpenseOS's stubs `findUnique`.
function stubDb(row: Record<string, unknown> | null) {
  const upsert = vi.fn(async () => row);
  return {
    db: { travelPlace: { findFirst: vi.fn(async () => row), upsert } } as never,
    upsert,
  };
}

function cachedRow(over: Record<string, unknown> = {}) {
  return {
    placeId: 'g-toronto',
    serpPlaceId: '/m/0h7h6',
    airports: ['YYZ', 'YTZ'],
    resolvedAt: new Date('2026-08-01T00:00:00Z'),
    pinnedAt: null,
    ...over,
  };
}

describe('readSuggestions', () => {
  it('prefers the CITY, so a metro prices all its airports', () => {
    // Falling to the first airport would silently commit a London trip to Heathrow
    // and hide the Gatwick fare.
    const out = readSuggestions([
      suggestion({ id: 'LHR', name: 'Heathrow' }),
      suggestion({
        id: '/m/04jpl',
        kind: 'city',
        airports: [
          { id: 'LHR', name: 'Heathrow', city: 'London' },
          { id: 'LGW', name: 'Gatwick', city: 'London' },
        ],
      }),
    ]);
    expect(out.serpPlaceId).toBe('/m/04jpl');
    expect(out.airports).toEqual(['LHR', 'LGW']);
  });

  it('takes a bare airport when there is no metro — one airport beats no flights', () => {
    expect(readSuggestions([suggestion({ id: 'YQB' })])).toEqual({
      serpPlaceId: 'YQB',
      airports: ['YQB'],
    });
  });

  it('de-duplicates the airport list', () => {
    const out = readSuggestions([
      suggestion({
        id: 'c',
        kind: 'city',
        airports: [
          { id: 'YYZ', name: 'a', city: null },
          { id: 'YYZ', name: 'b', city: null },
        ],
      }),
    ]);
    expect(out.airports).toEqual(['YYZ']);
  });

  it('is empty for nothing at all', () => {
    expect(readSuggestions([])).toEqual({ serpPlaceId: null, airports: [] });
  });
});

describe('resolveTravelPlace', () => {
  it('serves a fresh cache hit without calling the provider', async () => {
    const { db, upsert } = stubDb(cachedRow());
    const out = await resolveTravelPlace(
      db,
      CONFIG,
      { placeId: 'g-toronto', label: 'Toronto' },
      new Date('2026-08-05T00:00:00Z'),
    );
    expect(out.airports).toEqual(['YYZ', 'YTZ']);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('honours a pinned row past its TTL — a correction is not on a refresh schedule', async () => {
    const { db, upsert } = stubDb(
      cachedRow({ pinnedAt: new Date('2026-01-01T00:00:00Z'), airports: ['YTZ'] }),
    );
    const out = await resolveTravelPlace(
      db,
      CONFIG,
      { placeId: 'g-toronto', label: 'Toronto' },
      // Years later.
      new Date('2030-01-01T00:00:00Z'),
    );
    expect(out.airports).toEqual(['YTZ']);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('serves a stale hit rather than nothing when there is no plan', async () => {
    const { db } = stubDb(cachedRow({ resolvedAt: new Date('2020-01-01T00:00:00Z') }));
    const out = await resolveTravelPlace(
      db,
      null,
      { placeId: 'g-toronto', label: 'Toronto' },
      new Date('2026-08-05T00:00:00Z'),
    );
    expect(out.airports).toEqual(['YYZ', 'YTZ']);
  });

  it('is empty, not an error, with no plan and no cache', async () => {
    // Travel degrades to per-diem pricing; it does not break.
    const { db, upsert } = stubDb(null);
    expect(await resolveTravelPlace(db, null, { label: 'Toronto' })).toEqual({
      serpPlaceId: null,
      airports: [],
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('falls back to a label key when the place has no Google id', async () => {
    const { db } = stubDb(null);
    await resolveTravelPlace(db, null, { label: '  Toronto  ' });
    expect(
      (db as unknown as { travelPlace: { findFirst: ReturnType<typeof vi.fn> } }).travelPlace
        .findFirst,
    ).toHaveBeenCalledWith({ where: { placeId: 'label:toronto' } });
  });

  it('refuses a place with no usable key at all', async () => {
    const { db } = stubDb(null);
    expect(await resolveTravelPlace(db, CONFIG, { label: '   ' })).toEqual({
      serpPlaceId: null,
      airports: [],
    });
  });
});

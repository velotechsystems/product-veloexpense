import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS } from '@/server/refusal';

/**
 * The workspace hook's one-send guards (FR-3, spec FR-2).
 *
 * What is pinned: a request key that comes BACK to the one still in flight — key K sent,
 * a stop row added (no key), the row removed before K answers (K again) — is sent again.
 * K's own answer is stale by then (every edit bumps the token), so if the guard skipped
 * the second send the workspace would sit with every stop picked, no routes, no message
 * and no Try again.
 *
 * And for a dropped point: one `pointToPlace` per drop, then one `computeRoutes`; when
 * Routes refuses the Roads place ID, exactly one more of each, through Geocoding, and the
 * session's later drops ask Geocoding straight away. Never a third attempt.
 */

interface Pending {
  vars: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  pending: [] as Pending[],
  places: [] as Pending[],
  locations: [] as Pending[],
  options: [] as unknown[],
}));

/** `computeRoutes` held until the test answers it. One stable `mutateAsync`, as tRPC's. */
const mutateAsync = (vars: Record<string, unknown>) =>
  new Promise((resolve, reject) => h.pending.push({ vars, resolve, reject }));
/** `pointToPlace`, the same way. */
const placeAsync = (vars: Record<string, unknown>) =>
  new Promise((resolve, reject) => h.places.push({ vars, resolve, reject }));
/** `viaLocations`, the same way. */
const locateAsync = (vars: Record<string, unknown>) =>
  new Promise((resolve, reject) => h.locations.push({ vars, resolve, reject }));

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    mileageRoute: {
      computeRoutes: {
        useMutation: (o: unknown) => {
          h.options.push(o);
          return { mutateAsync };
        },
      },
      pointToPlace: {
        useMutation: (o: unknown) => {
          h.options.push(o);
          return { mutateAsync: placeAsync };
        },
      },
      viaLocations: {
        useMutation: (o: unknown) => {
          h.options.push(o);
          return { mutateAsync: locateAsync };
        },
      },
    },
  },
}));

import { MILEAGE_REFUSALS, pointFailureOf, useRouteWorkspace } from './useRouteWorkspace';

const TORONTO = { placeId: 'p-tor', description: 'Toronto' };
const OTTAWA = { placeId: 'p-ott', description: 'Ottawa' };
const ROUTE = {
  index: 0,
  totalMeters: 450_000,
  legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 450_000 }],
  encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
};

afterEach(() => {
  h.pending.length = 0;
  h.places.length = 0;
  h.locations.length = 0;
  h.options.length = 0;
});

describe('useRouteWorkspace', () => {
  it('sends the same key again when it returns to it while the first request is pending', async () => {
    const { result } = renderHook(() =>
      useRouteWorkspace({ kind: 'stops', stops: [TORONTO, OTTAWA] }, 'KM', true),
    );
    expect(h.pending.map((p) => p.vars)).toEqual([{ placeIds: ['p-tor', 'p-ott'], unit: 'KM' }]);

    // A stop row added: an unpicked row, so no key and nothing to send.
    act(() => result.current.insertAfter(0));
    expect(h.pending).toHaveLength(1);

    // Removed again before the first answer: the same key, and a second request for it.
    act(() => result.current.removeAt(1));
    expect(h.pending.map((p) => p.vars)).toEqual([
      { placeIds: ['p-tor', 'p-ott'], unit: 'KM' },
      { placeIds: ['p-tor', 'p-ott'], unit: 'KM' },
    ]);

    // The first answer is stale and dropped; the second one is drawn.
    await act(async () => {
      h.pending[0]?.resolve({ routes: [] });
    });
    expect(result.current.state.phase).toBe('loading');
    await act(async () => {
      h.pending[1]?.resolve({ routes: [ROUTE] });
    });
    expect(result.current.state.phase).toBe('ready');
    expect(result.current.state.routes).toHaveLength(1);
    expect(h.pending).toHaveLength(2);
  });

  it('sends a key once, however often the hook re-renders while it is in flight', () => {
    const { result, rerender } = renderHook(() =>
      useRouteWorkspace({ kind: 'stops', stops: [TORONTO, OTTAWA] }, 'KM', true),
    );
    rerender();
    rerender();
    act(() => result.current.select(0));
    expect(h.pending).toHaveLength(1);
  });

  it('creates every Google-calling mutation with no cache life and no retry of its own', () => {
    renderHook(() => useRouteWorkspace({ kind: 'new' }, 'KM', true));
    expect(h.options.length).toBeGreaterThan(0);
    for (const o of h.options) expect(o).toEqual({ gcTime: 0 });
  });
});

// ── A dropped point ─────────────────────────────────────────────────────────────────

/** A straight path from Toronto towards Ottawa, for the drop to lie on. */
const PATH = [
  { lat: 43.65, lng: -79.38 },
  { lat: 44.5, lng: -77.5 },
  { lat: 45.42, lng: -75.7 },
];

/** A tRPC client error as the formatter puts it on the wire. */
const refusal = (code: string, key?: string, params?: Record<string, string>) =>
  Object.assign(new Error('English sentence'), {
    data: { code, ...(key ? { refusal: { key, ...(params ? { params } : {}) } } : {}) },
  });

async function routedHook() {
  const view = renderHook(() =>
    useRouteWorkspace({ kind: 'stops', stops: [TORONTO, OTTAWA] }, 'KM', true),
  );
  await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
  expect(view.result.current.state.phase).toBe('ready');
  return view;
}

const last = <T>(list: T[]) => list[list.length - 1] as T;

describe('useRouteWorkspace — a dropped point', () => {
  it('one conversion, then one route request with the place ID; no coordinate reaches it', async () => {
    const { result } = await routedHook();
    act(() => result.current.addPoint({ lat: 44.5, lng: -77.5 }, PATH));
    expect(h.places.map((p) => p.vars)).toEqual([{ lat: 44.5, lng: -77.5, method: 'auto' }]);
    expect(h.pending).toHaveLength(1);

    await act(async () =>
      last(h.places).resolve({
        placeId: 'road-1',
        location: { lat: 44.501, lng: -77.499 },
        source: 'roads',
      }),
    );
    expect(h.pending).toHaveLength(2);
    expect(last(h.pending).vars).toEqual({
      placeIds: ['p-tor', 'p-ott'],
      unit: 'KM',
      via: [{ placeId: 'road-1', leg: 0 }],
    });
    await act(async () => last(h.pending).resolve({ routes: [ROUTE] }));
    expect(result.current.state.points).toEqual([
      expect.objectContaining({ placeId: 'road-1', leg: 0, at: { lat: 44.501, lng: -77.499 } }),
    ]);
    expect(h.places).toHaveLength(1);
    expect(h.pending).toHaveLength(2);
  });

  it('refused Roads place: exactly 2 conversions and 2 route requests, then Geocoding first', async () => {
    const { result } = await routedHook();
    act(() => result.current.addPoint({ lat: 44.5, lng: -77.5 }, PATH));
    await act(async () =>
      last(h.places).resolve({
        placeId: 'road-1',
        location: { lat: 44.501, lng: -77.499 },
        source: 'roads',
      }),
    );
    await act(async () =>
      last(h.pending).reject(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused)),
    );
    expect(h.places.map((p) => p.vars)).toEqual([
      { lat: 44.5, lng: -77.5, method: 'auto' },
      { lat: 44.5, lng: -77.5, method: 'geocoding' },
    ]);
    await act(async () =>
      last(h.places).resolve({
        placeId: 'address-1',
        location: { lat: 44.49, lng: -77.51 },
        source: 'geocoding',
      }),
    );
    expect(last(h.pending).vars).toMatchObject({ via: [{ placeId: 'address-1', leg: 0 }] });
    await act(async () => last(h.pending).resolve({ routes: [ROUTE] }));

    // The first drop of the session: 2 + 2, the starting route request aside.
    expect(h.places).toHaveLength(2);
    expect(h.pending).toHaveLength(3);
    expect(result.current.state.roadsRefused).toBe(true);

    // The next drop asks Geocoding at once: one of each.
    act(() => result.current.addPoint({ lat: 45, lng: -76.5 }, PATH));
    expect(last(h.places).vars).toEqual({ lat: 45, lng: -76.5, method: 'geocoding' });
    await act(async () =>
      last(h.places).resolve({
        placeId: 'address-2',
        location: { lat: 45, lng: -76.5 },
        source: 'geocoding',
      }),
    );
    await act(async () => last(h.pending).resolve({ routes: [ROUTE] }));
    expect(h.places).toHaveLength(3);
    expect(h.pending).toHaveLength(4);
  });

  it('a second refusal undoes the drop and sends nothing more', async () => {
    const { result } = await routedHook();
    act(() => result.current.addPoint({ lat: 44.5, lng: -77.5 }, PATH));
    await act(async () =>
      last(h.places).resolve({
        placeId: 'road-1',
        location: { lat: 44.5, lng: -77.5 },
        source: 'roads',
      }),
    );
    await act(async () =>
      last(h.pending).reject(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused)),
    );
    await act(async () =>
      last(h.places).resolve({
        placeId: 'address-1',
        location: { lat: 44.5, lng: -77.5 },
        source: 'geocoding',
      }),
    );
    await act(async () =>
      last(h.pending).reject(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused)),
    );
    expect(h.places).toHaveLength(2);
    expect(h.pending).toHaveLength(3);
    expect(result.current.state).toMatchObject({
      phase: 'ready',
      points: [],
      converting: null,
      pointNotice: { kind: 'viaRefused' },
      roadsRefused: false,
    });
  });

  it('a zod BAD_REQUEST without the refusal key is a plain failure, never a retry', async () => {
    const { result } = await routedHook();
    act(() => result.current.addPoint({ lat: 44.5, lng: -77.5 }, PATH));
    await act(async () =>
      last(h.places).resolve({
        placeId: 'road-1',
        location: { lat: 44.5, lng: -77.5 },
        source: 'roads',
      }),
    );
    await act(async () => last(h.pending).reject(refusal('BAD_REQUEST')));
    expect(h.places).toHaveLength(1);
    expect(result.current.state.pointNotice).toEqual({
      kind: 'failed',
      message: 'English sentence',
    });
  });

  it('sends one conversion under StrictMode', async () => {
    const { result } = renderHook(
      () => useRouteWorkspace({ kind: 'stops', stops: [TORONTO, OTTAWA] }, 'KM', true),
      { wrapper: StrictMode },
    );
    await act(async () => {
      for (const p of h.pending) p.resolve({ routes: [ROUTE] });
    });
    act(() => result.current.addPoint({ lat: 44.5, lng: -77.5 }, PATH));
    expect(h.places).toHaveLength(1);
  });
});

// ── A stored route reopened ─────────────────────────────────────────────────────────

/** Toronto to Ottawa as stored, through two points: a Roads place ID and an address. */
const STORED = {
  stops: [TORONTO, OTTAWA],
  legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 451_000 }],
  routeLabel: 'Hwy 7',
  routeIndex: 0,
  routeCount: 1,
  via: [
    { placeId: 'road-1', leg: 0 },
    { placeId: 'address-2', leg: 0 },
  ],
  distance: { KM: '451.00', MI: '280.24' },
};
const reopen = { kind: 'previous', entry: STORED } as const;

describe('useRouteWorkspace — a stored route reopened (spec FR-4, NFR-8)', () => {
  it('ONE route request with the via, then ONE viaLocations for every point; none on a re-render', async () => {
    const { result, rerender } = renderHook(() => useRouteWorkspace(reopen, 'KM', true));
    expect(h.pending.map((p) => p.vars)).toEqual([
      { placeIds: ['p-tor', 'p-ott'], unit: 'KM', via: STORED.via },
    ]);
    // Nothing is looked up before the route is drawn.
    expect(h.locations).toHaveLength(0);

    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    expect(h.locations.map((l) => l.vars)).toEqual([{ placeIds: ['road-1', 'address-2'] }]);

    rerender();
    rerender();
    act(() => result.current.select(0));
    await act(async () =>
      h.locations[0]?.resolve({
        results: [
          { placeId: 'road-1', location: { lat: 44.1, lng: -77.2 } },
          { placeId: 'address-2', location: { lat: 44.9, lng: -76.1 } },
        ],
      }),
    );
    rerender();
    expect(h.locations).toHaveLength(1);
    expect(h.pending).toHaveLength(1);
  });

  it('with no map shown, looks nothing up: the points stay listed, removable, with no marker', async () => {
    const { result } = renderHook(() => useRouteWorkspace(reopen, 'KM', false));
    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    expect(result.current.state.phase).toBe('ready');
    expect(h.locations).toHaveLength(0);
    // Listed as they were stored — neither placed nor "not on the map": there is no map.
    expect(
      result.current.state.points.map((p) => [p.placeId, p.at ?? null, p.unplaced ?? false]),
    ).toEqual([
      ['road-1', null, false],
      ['address-2', null, false],
    ]);
    expect(result.current.state.stored?.via).toEqual(STORED.via);

    // Removable: one route request through the point left, and still no lookup.
    act(() => result.current.removePoint(1));
    expect(h.pending.map((p) => p.vars)[1]).toEqual({
      placeIds: ['p-tor', 'p-ott'],
      unit: 'KM',
      via: [STORED.via[0]],
    });
    await act(async () => h.pending[1]?.resolve({ routes: [ROUTE] }));
    expect(result.current.state.points.map((p) => p.placeId)).toEqual(['road-1']);
    expect(h.locations).toHaveLength(0);
  });

  it('a map that fails before the route is drawn stops the lookup too', async () => {
    const { rerender } = renderHook(
      ({ shown }: { shown: boolean }) => useRouteWorkspace(reopen, 'KM', shown),
      { initialProps: { shown: true } },
    );
    rerender({ shown: false });
    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    rerender({ shown: false });
    expect(h.locations).toHaveLength(0);
  });

  it('sends ONE viaLocations under StrictMode', async () => {
    renderHook(() => useRouteWorkspace(reopen, 'KM', true), { wrapper: StrictMode });
    await act(async () => {
      for (const p of h.pending) p.resolve({ routes: [ROUTE] });
    });
    expect(h.locations).toHaveLength(1);
  });

  it('TR-13 check 2, placed: a Roads place ID Place Details resolves gets a marker', async () => {
    const { result } = renderHook(() => useRouteWorkspace(reopen, 'KM', true));
    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    await act(async () =>
      h.locations[0]?.resolve({
        results: [
          { placeId: 'road-1', location: { lat: 44.1, lng: -77.2 } },
          { placeId: 'address-2', location: { lat: 44.9, lng: -76.1 } },
        ],
      }),
    );
    expect(
      result.current.state.points.map((p) => ({ placeId: p.placeId, at: p.at, un: p.unplaced })),
    ).toEqual([
      { placeId: 'road-1', at: { lat: 44.1, lng: -77.2 }, un: undefined },
      { placeId: 'address-2', at: { lat: 44.9, lng: -76.1 }, un: undefined },
    ]);
  });

  it('TR-13 check 2, unplaced: a Roads place ID it does not resolve is listed with no marker', async () => {
    const { result } = renderHook(() => useRouteWorkspace(reopen, 'KM', true));
    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    await act(async () =>
      h.locations[0]?.resolve({
        results: [
          { placeId: 'road-1', location: null, reason: 'unresolved' },
          { placeId: 'address-2', location: { lat: 44.9, lng: -76.1 } },
        ],
      }),
    );
    const { points } = result.current.state;
    expect(points.map((p) => [p.placeId, p.at ?? null, p.unplaced ?? false])).toEqual([
      ['road-1', null, true],
      ['address-2', { lat: 44.9, lng: -76.1 }, false],
    ]);
    // The route still runs through it: the card is the stored one, accepted unchanged.
    expect(result.current.state.stored?.via).toEqual(STORED.via);
  });

  it('a refused viaLocations leaves every point unplaced, and is not sent again', async () => {
    const { result, rerender } = renderHook(() => useRouteWorkspace(reopen, 'KM', true));
    await act(async () => h.pending[0]?.resolve({ routes: [ROUTE] }));
    await act(async () => h.locations[0]?.reject(refusal('PRECONDITION_FAILED')));
    rerender();
    expect(result.current.state.points.every((p) => p.unplaced === true)).toBe(true);
    expect(h.locations).toHaveLength(1);
  });

  it('2.A: a failed route request routes the stops alone and looks nothing up', async () => {
    const { result } = renderHook(() => useRouteWorkspace(reopen, 'KM', true));
    await act(async () =>
      h.pending[0]?.reject(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused)),
    );
    expect(h.pending.map((p) => p.vars)).toEqual([
      { placeIds: ['p-tor', 'p-ott'], unit: 'KM', via: STORED.via },
      { placeIds: ['p-tor', 'p-ott'], unit: 'KM' },
    ]);
    await act(async () => h.pending[1]?.resolve({ routes: [ROUTE] }));
    expect(result.current.state).toMatchObject({
      phase: 'ready',
      points: [],
      stored: null,
      reopenFallback: { kind: 'viaRefused' },
    });
    expect(h.locations).toHaveLength(0);
  });
});

describe('pointFailureOf', () => {
  it.each([
    ['a throttle', refusal('TOO_MANY_REQUESTS'), { kind: 'throttled' }],
    ['no road near', refusal('NOT_FOUND', MILEAGE_REFUSALS.noRoadNear), { kind: 'noRoad' }],
    [
      'both APIs refused, naming them',
      refusal('PRECONDITION_FAILED', MILEAGE_REFUSALS.dragApisUnavailable, {
        apis: 'Roads API, Geocoding API',
      }),
      { kind: 'apisOff', apis: 'Roads API, Geocoding API' },
    ],
    [
      'lookup not configured',
      refusal('PRECONDITION_FAILED'),
      { kind: 'failed', message: 'English sentence' },
    ],
    [
      'anything else',
      refusal('INTERNAL_SERVER_ERROR'),
      { kind: 'failed', message: 'English sentence' },
    ],
  ])('%s', (_, error, failure) => {
    expect(pointFailureOf(error)).toEqual(failure);
  });

  it('branches on the same keys the server throws', () => {
    expect(MILEAGE_REFUSALS).toEqual({
      noRoadNear: REFUSAL_KEYS.mileageNoRoadNear,
      dragApisUnavailable: REFUSAL_KEYS.mileageDragApisUnavailable,
      viaPlaceRefused: REFUSAL_KEYS.mileageViaPlaceRefused,
    });
  });
});

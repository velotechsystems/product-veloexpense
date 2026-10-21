import { describe, expect, it } from 'vitest';
import {
  acceptPayload,
  chosenRoute,
  insertIndex,
  legForPoint,
  type PickerRoute,
  type PointFailure,
  type PreviousRoute,
  pointMarkers,
  requestInput,
  requestKey,
  seedState,
  shortestIndex,
  type WorkspaceAction,
  type WorkspacePoint,
  type WorkspaceState,
  workspaceReducer,
} from './routeWorkspace';

/**
 * The workspace rules as a table (FR-3, FR-5, FR-7, and spec FR-2): when a request is
 * due, which answer counts, which route starts selected, how a dropped point becomes a
 * place ID, and what Use this route writes.
 */

const route = (index: number, meters: number, over: Partial<PickerRoute> = {}): PickerRoute => ({
  index,
  label: `Hwy ${index}`,
  totalMeters: meters,
  distance: (meters / 1000).toFixed(2),
  durationSeconds: 60,
  legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters }],
  encodedPolyline: `p${index}`,
  ...over,
});

const PICKED = [
  { placeId: 'a', description: 'A' },
  { placeId: 'b', description: 'B' },
];
const IDS = ['r0', 'r1', 'r2'];

function routed(routes: PickerRoute[]): WorkspaceState {
  let s = seedState({ kind: 'stops', stops: PICKED }, IDS);
  const key = requestKey(s) as string;
  s = workspaceReducer(s, { type: 'request', token: 1, key });
  return workspaceReducer(s, { type: 'answer', token: 1, routes });
}

describe('shortestIndex', () => {
  it.each([
    ['the smallest total wins, wherever Google lists it', [450, 398, 415], 1],
    ['a tie goes to the first in Google’s order', [400, 398, 398], 1],
    ['a single route is the answer', [500], 0],
  ])('%s', (_, meters, expected) => {
    expect(shortestIndex(meters.map((m, i) => route(i, m)))).toBe(expected);
  });

  it('is null with no routes', () => {
    expect(shortestIndex([])).toBeNull();
  });
});

describe('request key', () => {
  it('exists only when every row holds a picked place', () => {
    expect(requestKey(seedState({ kind: 'new' }, IDS))).toBeNull();
    expect(
      requestKey(
        seedState({ kind: 'stops', stops: [PICKED[0] as never, { description: 'typed' }] }, IDS),
      ),
    ).toBeNull();
    expect(requestKey(seedState({ kind: 'stops', stops: PICKED }, IDS))).not.toBeNull();
  });

  it('sends the place ids in order, and no via while there is none', () => {
    const key = requestKey(seedState({ kind: 'stops', stops: PICKED }, IDS)) as string;
    expect(requestInput(key, 'MI')).toEqual({ placeIds: ['a', 'b'], unit: 'MI' });
  });
});

describe('workspaceReducer', () => {
  it('selects the shortest route when the answer lands', () => {
    expect(routed([route(0, 450), route(1, 398)]).selected).toBe(1);
  });

  it('drops an answer whose token is no longer current', () => {
    let s = seedState({ kind: 'stops', stops: PICKED }, IDS);
    s = workspaceReducer(s, { type: 'request', token: 1, key: requestKey(s) as string });
    s = workspaceReducer(s, {
      type: 'setStop',
      index: 1,
      stop: { placeId: 'c', description: 'C' },
    });
    const after = workspaceReducer(s, { type: 'answer', token: 1, routes: [route(0, 1)] });
    expect(after).toBe(s);
    expect(after.routes).toEqual([]);
  });

  it.each([
    ['a stop retyped', { type: 'setStop', index: 0, stop: { description: 'A2' } } as const],
    ['a stop added', { type: 'insertAfter', index: 0, id: 'new' } as const],
  ])('%s clears the routes, the points and the request', (_, action) => {
    const s = workspaceReducer(routed([route(0, 1)]), action);
    expect(s).toMatchObject({
      routes: [],
      selected: null,
      phase: 'idle',
      requested: null,
      points: [],
      converting: null,
    });
  });

  it('never removes below an origin and a destination', () => {
    const s = seedState({ kind: 'stops', stops: PICKED }, IDS);
    expect(workspaceReducer(s, { type: 'removeAt', index: 0 })).toBe(s);
  });

  it('a refusal clears the routes and is not retried until asked', () => {
    let s = routed([route(0, 1)]);
    s = workspaceReducer(s, { type: 'request', token: 2, key: 'k' });
    s = workspaceReducer(s, { type: 'failed', token: 2, throttled: true, message: '' });
    expect(s).toMatchObject({ phase: 'throttled', routes: [], requested: 'k' });
    expect(workspaceReducer(s, { type: 'retry' }).requested).toBeNull();
  });
});

describe('a stored route reopened (spec FR-4)', () => {
  const ENTRY: PreviousRoute = {
    stops: PICKED,
    legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 12_345 }],
    routeLabel: 'Hwy 2',
    routeIndex: 1,
    routeCount: 2,
    distance: { KM: '12.35', MI: '7.67' },
  };
  const VIA = [
    { placeId: 'road-1', leg: 0 },
    { placeId: 'address-2', leg: 0 },
  ];
  const WITH_VIA: PreviousRoute = { ...ENTRY, via: VIA };
  const STORED = {
    stops: PICKED,
    legs: ENTRY.legs,
    routeLabel: 'Hwy 2',
    routeIndex: 1,
    routeCount: 2,
  };

  /** Seeded, its one request sent, and answered with `routes`. */
  function reopenedWith(entry: PreviousRoute, routes: PickerRoute[]): WorkspaceState {
    let s = seedState({ kind: 'previous', entry }, IDS);
    s = workspaceReducer(s, { type: 'request', token: 1, key: requestKey(s) as string });
    return workspaceReducer(s, { type: 'answer', token: 1, routes });
  }

  it('opens on its stops and its via, routed by ONE request for both, nothing Google drew', () => {
    const s = seedState({ kind: 'previous', entry: WITH_VIA }, IDS);
    expect(s).toMatchObject({ phase: 'idle', routes: [], requested: null, locating: null });
    expect(s.points.map((p) => ({ placeId: p.placeId, leg: p.leg, at: p.at }))).toEqual([
      { placeId: 'road-1', leg: 0, at: undefined },
      { placeId: 'address-2', leg: 0, at: undefined },
    ]);
    expect(requestInput(requestKey(s) as string, 'KM')).toEqual({
      placeIds: ['a', 'b'],
      unit: 'KM',
      via: VIA,
    });
    expect(acceptPayload(s, 'KM')).toBeNull();
  });

  it('without via, shows the alternative closest to the stored distance as its ONE card', () => {
    const s = reopenedWith(ENTRY, [route(0, 11_000), route(1, 12_500), route(2, 20_000)]);
    expect(s.phase).toBe('ready');
    expect(s.routes).toEqual([
      {
        index: 1,
        label: 'Hwy 2',
        totalMeters: 12_345,
        distance: '12.35',
        durationSeconds: null,
        legs: ENTRY.legs,
        // The path drawn is the closest answer's.
        encodedPolyline: 'p1',
      },
    ]);
    expect(s.selected).toBe(1);
    // Nothing to place: no lookup.
    expect(s.locating).toBeNull();
  });

  it('with via, the one route Google gives is drawn as the stored card, then its points are placed', () => {
    const s = reopenedWith(WITH_VIA, [route(0, 14_000)]);
    expect(s.routes).toMatchObject([
      { index: 1, label: 'Hwy 2', totalMeters: 12_345, encodedPolyline: 'p0' },
    ]);
    expect(s.locating).toEqual({ ticket: 1, placeIds: ['road-1', 'address-2'] });
  });

  it('an unchanged accept writes the stored value exactly, with the stored distance', () => {
    const s = reopenedWith(WITH_VIA, [route(0, 14_000)]);
    expect(acceptPayload(s, 'KM')).toEqual({
      mileageDistance: '12.35',
      mileageUnit: 'KM',
      mileageRoute: { ...STORED, via: VIA },
    });
    // Its points placed or not, it is the same write.
    const placed = workspaceReducer(s, {
      type: 'located',
      ticket: 1,
      results: [
        { placeId: 'road-1', location: { lat: 1, lng: 2 } },
        { placeId: 'address-2', location: null },
      ],
    });
    expect(acceptPayload(placed, 'KM')).toEqual(acceptPayload(s, 'KM'));
    // Without via, no via key.
    expect(acceptPayload(reopenedWith(ENTRY, [route(0, 12_000)]), 'MI')).toEqual({
      mileageDistance: '7.67',
      mileageUnit: 'MI',
      mileageRoute: STORED,
    });
  });

  it('a removed point writes the newly computed route', () => {
    let s = reopenedWith(WITH_VIA, [route(0, 14_000)]);
    s = workspaceReducer(s, { type: 'removePoint', index: 0 });
    expect(acceptPayload(s, 'KM')).toBeNull();
    const key = requestKey(s) as string;
    expect(requestInput(key, 'KM').via).toEqual([{ placeId: 'address-2', leg: 0 }]);
    s = workspaceReducer(s, { type: 'request', token: s.token + 1, key });
    s = workspaceReducer(s, { type: 'answer', token: s.token, routes: [route(0, 13_000)] });
    expect(s.stored).toBeNull();
    expect(acceptPayload(s, 'KM')).toEqual({
      mileageDistance: '13.00',
      mileageUnit: 'KM',
      mileageRoute: { ...chosenRoute(PICKED, route(0, 13_000), 1), via: [VIA[1]] },
    });
  });

  it('a changed stop writes the newly computed route, with no via', () => {
    let s = reopenedWith(WITH_VIA, [route(0, 14_000)]);
    s = workspaceReducer(s, {
      type: 'setStop',
      index: 1,
      stop: { placeId: 'c', description: 'C' },
    });
    expect(s).toMatchObject({ points: [], stored: null, locating: null, reopen: null });
    const key = requestKey(s) as string;
    s = workspaceReducer(s, { type: 'request', token: s.token + 1, key });
    s = workspaceReducer(s, {
      type: 'answer',
      token: s.token,
      routes: [route(0, 9_000), route(1, 8_000)],
    });
    expect(acceptPayload(s, 'KM')?.mileageRoute).toEqual(
      chosenRoute([PICKED[0] as never, { placeId: 'c', description: 'C' }], route(1, 8_000), 2),
    );
  });

  it('places each point by place ID; one Google cannot place is listed unplaced', () => {
    const s = workspaceReducer(reopenedWith(WITH_VIA, [route(0, 14_000)]), {
      type: 'located',
      ticket: 1,
      results: [
        { placeId: 'address-2', location: { lat: 1, lng: 2 } },
        { placeId: 'road-1', location: null },
      ],
    });
    expect(s.points.map((p) => [p.placeId, p.at, p.unplaced])).toEqual([
      ['road-1', undefined, true],
      ['address-2', { lat: 1, lng: 2 }, undefined],
    ]);
    expect(pointMarkers(s).markers).toEqual([null, { lat: 1, lng: 2 }]);
    expect(s.locating).toBeNull();
  });

  it('a refused lookup leaves every point unplaced; a stale answer is dropped', () => {
    const s = reopenedWith(WITH_VIA, [route(0, 14_000)]);
    const refused = workspaceReducer(s, { type: 'locateFailed', ticket: 1 });
    expect(refused.points.every((p) => p.unplaced === true && p.at === undefined)).toBe(true);
    expect(workspaceReducer(s, { type: 'locateFailed', ticket: 99 })).toBe(s);
    // A stop edited first: the points are gone, and the answer is for nothing.
    const edited = workspaceReducer(s, {
      type: 'setStop',
      index: 0,
      stop: { placeId: 'c', description: 'C' },
    });
    expect(workspaceReducer(edited, { type: 'locateFailed', ticket: 1 })).toBe(edited);
  });

  it('an unplaced point can be removed: one request for the route without it', () => {
    let s = workspaceReducer(reopenedWith(WITH_VIA, [route(0, 14_000)]), {
      type: 'locateFailed',
      ticket: 1,
    });
    s = workspaceReducer(s, { type: 'removePoint', index: 0 });
    expect(s.phase).toBe('loading');
    expect(s.points.map((p) => p.placeId)).toEqual(['address-2']);
  });

  it.each([
    [
      'fails',
      { type: 'failed', token: 1, throttled: false, message: 'Boom' },
      { kind: 'failed', message: 'Boom' },
    ],
    [
      'is throttled',
      { type: 'failed', token: 1, throttled: true, message: '' },
      { kind: 'throttled' },
    ],
    [
      'refuses a point',
      { type: 'failed', token: 1, throttled: false, message: 'x', viaRefused: true },
      { kind: 'viaRefused' },
    ],
    ['finds nothing', { type: 'answer', token: 1, routes: [] }, { kind: 'empty' }],
  ] as const)(
    '2.A: when the request %s, the stops are routed alone and why is said',
    (_, action, why) => {
      let s = seedState({ kind: 'previous', entry: WITH_VIA }, IDS);
      s = workspaceReducer(s, { type: 'request', token: 1, key: requestKey(s) as string });
      s = workspaceReducer(s, action as WorkspaceAction);
      expect(s).toMatchObject({
        phase: 'idle',
        points: [],
        routes: [],
        stored: null,
        reopen: null,
        locating: null,
        requested: null,
        reopenFallback: why,
      });
      // A new key, for the stops alone, for the hook to send.
      expect(requestInput(requestKey(s) as string, 'KM')).toEqual({
        placeIds: ['a', 'b'],
        unit: 'KM',
      });
      s = workspaceReducer(s, {
        type: 'request',
        token: s.token + 1,
        key: requestKey(s) as string,
      });
      s = workspaceReducer(s, { type: 'answer', token: s.token, routes: [route(0, 13_000)] });
      // Today's routes, and the accept is the new route; the reason stays said.
      expect(acceptPayload(s, 'KM')?.mileageRoute).toEqual(
        chosenRoute(PICKED, route(0, 13_000), 1),
      );
      expect(s.reopenFallback).toEqual(why);
    },
  );

  it('without via, a failed request is today’s failure, and Try again reopens it as stored', () => {
    let s = seedState({ kind: 'previous', entry: ENTRY }, IDS);
    s = workspaceReducer(s, { type: 'request', token: 1, key: requestKey(s) as string });
    s = workspaceReducer(s, { type: 'failed', token: 1, throttled: false, message: 'Boom' });
    expect(s).toMatchObject({ phase: 'failed', reopenFallback: null });
    s = workspaceReducer(s, { type: 'retry' });
    s = workspaceReducer(s, { type: 'request', token: 2, key: requestKey(s) as string });
    s = workspaceReducer(s, { type: 'answer', token: 2, routes: [route(0, 12_000)] });
    expect(acceptPayload(s, 'KM')?.mileageRoute).toEqual(STORED);
  });

  it('legs that do not chain through the stops open on the stops alone', () => {
    const stale = { ...WITH_VIA, legs: [{ fromPlaceId: 'x', toPlaceId: 'b', meters: 1 }] };
    const s = seedState({ kind: 'previous', entry: stale }, IDS);
    expect(s).toMatchObject({ points: [], stored: null, reopen: null });
  });
});

describe('acceptPayload', () => {
  it('is null until a route is ready', () => {
    expect(acceptPayload(seedState({ kind: 'stops', stops: PICKED }, IDS), 'KM')).toBeNull();
  });

  it('carries the chosen route and nothing Google drew', () => {
    const p = acceptPayload(routed([route(0, 410_000), route(1, 400_000)]), 'KM');
    expect(p).toEqual({
      mileageDistance: '400.00',
      mileageUnit: 'KM',
      mileageRoute: chosenRoute(PICKED, route(1, 400_000), 2),
    });
    expect(p?.mileageRoute).not.toHaveProperty('encodedPolyline');
    expect(p?.mileageRoute).not.toHaveProperty('via');
  });
});

// ── Pass-through points (FR-4) ───────────────────────────────────────────────────────────

/** A straight path along the equator, one degree between vertices: easy to reason about. */
const LINE = [0, 1, 2, 3].map((lng) => ({ lat: 0, lng }));
const at = (lng: number, lat = 0) => ({ lat, lng });

describe('legForPoint', () => {
  const EQUAL = [{ meters: 1000 }, { meters: 1000 }, { meters: 1000 }];
  it.each([
    ['early on the first leg', EQUAL, at(0.5), 0],
    ['in the middle leg, dropped beside the line', EQUAL, at(1.5, 0.1), 1],
    ['late on the last leg', EQUAL, at(2.9), 2],
    ['exactly on a named stop: the leg that ends there', EQUAL, at(1), 0],
    ['1 % past a named stop: the leg that starts there', EQUAL, at(1.01), 1],
    ['1 % short of a named stop: the leg that ends there', EQUAL, at(0.99), 0],
    ['beyond the destination: never past the last leg', EQUAL, at(5), 2],
    ['before the origin: never before the first leg', EQUAL, at(-2), 0],
    // The drawn path is scaled to Google's leg metres: a short first leg ends early.
    ['scaled to the legs, not the drawing', [{ meters: 100 }, { meters: 2900 }], at(0.5), 1],
    ['a route with one leg', [{ meters: 3000 }], at(2), 0],
  ])('%s', (_, legs, point, leg) => {
    expect(legForPoint(LINE, legs, point)).toBe(leg);
  });

  it('is 0 with no path to measure', () => {
    expect(legForPoint([], [{ meters: 1 }, { meters: 1 }], at(1))).toBe(0);
  });
});

const THREE = [
  { placeId: 'a', description: 'A' },
  { placeId: 'b', description: 'B' },
  { placeId: 'c', description: 'C' },
];
const threeLegs = (index: number, meters: number): PickerRoute =>
  route(index, meters, {
    legs: [
      { fromPlaceId: 'a', toPlaceId: 'b', meters: meters / 2 },
      { fromPlaceId: 'b', toPlaceId: 'c', meters: meters / 2 },
    ],
  });

/** Three stops, routed: two alternatives, the shorter (index 1) selected. */
function routedThree(): WorkspaceState {
  let s = seedState({ kind: 'stops', stops: THREE }, IDS);
  s = workspaceReducer(s, { type: 'request', token: 1, key: requestKey(s) as string });
  return workspaceReducer(s, {
    type: 'answer',
    token: 1,
    routes: [threeLegs(0, 3000), threeLegs(1, 2000)],
  });
}

/** What the hook does next for a new key: send it, under the next token. */
function sent(s: WorkspaceState): WorkspaceState {
  const key = requestKey(s) as string;
  expect(key).not.toBe(s.requested);
  return workspaceReducer(s, { type: 'request', token: s.token + 1, key });
}

const drop = (s: WorkspaceState, lng: number, id = `pt-${lng}`, lat = 0) =>
  workspaceReducer(s, { type: 'addPoint', point: at(lng, lat), path: LINE, id });

/** `pointToPlace` answers the conversion waiting now. */
function placed(
  s: WorkspaceState,
  placeId: string,
  source: 'roads' | 'geocoding' = 'roads',
  location = { lat: 0.01, lng: 9 },
): WorkspaceState {
  const ticket = s.converting?.ticket as number;
  return workspaceReducer(s, { type: 'placed', ticket, placeId, location, source });
}

const answered = (s: WorkspaceState, routes: PickerRoute[] = [threeLegs(0, 2400)]) =>
  workspaceReducer(s, { type: 'answer', token: s.token, routes });

const refusedVia = (s: WorkspaceState) =>
  workspaceReducer(s, {
    type: 'failed',
    token: s.token,
    throttled: false,
    message: 'Google could not route through a point the route was dragged through.',
    viaRefused: true,
  });

/** A drop placed and routed: the point is kept. */
const kept = (s: WorkspaceState, lng: number, placeId: string) =>
  answered(sent(placed(drop(s, lng), placeId)), [threeLegs(0, 9)]);

describe('workspaceReducer — a drop becomes a place ID, then a route (spec FR-2)', () => {
  it('a drop asks for its place first: no route request, the routes stay drawn', () => {
    const before = routedThree();
    const s = drop(before, 2.5);
    expect(s.converting).toMatchObject({
      at: { lat: 0, lng: 2.5 },
      leg: 1,
      stage: 'converting',
      method: 'auto',
      retried: false,
    });
    expect(s.points).toEqual([]);
    expect(s.phase).toBe('loading');
    expect(s.routes).toBe(before.routes);
    // The key is the one already answered: the hook sends no route request yet.
    expect(requestKey(s)).toBe(s.requested);
    expect(acceptPayload(s, 'KM')).toBeNull();
  });

  it('the place lands: the point is held as its place ID and leg, and routed once', () => {
    const s = placed(drop(routedThree(), 2.5), 'road-1', 'roads', { lat: 0.001, lng: 2.49 });
    expect(s.points).toEqual([
      { id: 'pt-2.5', placeId: 'road-1', leg: 1, at: { lat: 0.001, lng: 2.49 } },
    ]);
    expect(s.converting).toMatchObject({ stage: 'routing', source: 'roads' });
    const key = requestKey(s) as string;
    expect(key).not.toBe(s.requested);
    expect(requestInput(key, 'KM')).toEqual({
      placeIds: ['a', 'b', 'c'],
      unit: 'KM',
      via: [{ placeId: 'road-1', leg: 1 }],
    });
    // No coordinate in what is sent, the dropped one or the snapped one.
    expect(key).not.toMatch(/lat|lng|2\.49|2\.5/);
  });

  it('the one route back is selected and accept writes the place IDs, never `at`', () => {
    const s = kept(routedThree(), 2.5, 'road-1');
    expect(s).toMatchObject({ phase: 'ready', selected: 0, pointsUndo: null, converting: null });
    const payload = acceptPayload(s, 'KM');
    expect(payload?.mileageRoute.via).toEqual([{ placeId: 'road-1', leg: 1 }]);
    expect(JSON.stringify(payload)).not.toMatch(/"at"|lat|lng|encodedPolyline|passThrough/);
    expect(payload?.mileageRoute).toMatchObject({ routeCount: 1 });
  });

  it('a later drop on an earlier leg goes before the points on later legs', () => {
    let s = kept(routedThree(), 2.5, 'road-1');
    s = kept(s, 1.2, 'road-0');
    expect(s.points.map((p) => p.placeId)).toEqual(['road-0', 'road-1']);
  });

  const placeFailures: [string, PointFailure][] = [
    ['is throttled', { kind: 'throttled' }],
    ['finds no road and no address', { kind: 'noRoad' }],
    ['may use neither API', { kind: 'apisOff', apis: 'Roads API, Geocoding API' }],
    ['fails', { kind: 'failed', message: 'Point lookup failed.' }],
  ];
  it.each(placeFailures)('a drop whose conversion %s is undone, and says why', (_, failure) => {
    const before = routedThree();
    const s0 = drop(before, 2.5);
    const s = workspaceReducer(s0, {
      type: 'placeFailed',
      ticket: s0.converting?.ticket as number,
      failure,
    });
    expect(s.points).toEqual([]);
    expect(s.routes).toBe(before.routes);
    expect(s.selected).toBe(1);
    expect(s.phase).toBe('ready');
    expect(s.converting).toBeNull();
    expect(s.pointNotice).toEqual(failure);
    expect(requestKey(s)).toBe(s.requested);
    expect(acceptPayload(s, 'KM')).not.toBeNull();
  });

  const routeFailures: [string, (s: WorkspaceState) => WorkspaceState, string][] = [
    [
      'fails',
      (s) =>
        workspaceReducer(s, { type: 'failed', token: s.token, throttled: false, message: 'no' }),
      'failed',
    ],
    [
      'is throttled',
      (s) => workspaceReducer(s, { type: 'failed', token: s.token, throttled: true, message: '' }),
      'throttled',
    ],
    ['finds no route', (s) => answered(s, []), 'empty'],
  ];
  it.each(routeFailures)('a drop whose route request %s is undone', (_, fail, kind) => {
    const before = routedThree();
    const s = fail(sent(placed(drop(before, 2.5), 'road-1')));
    expect(s.points).toEqual([]);
    expect(s.routes).toBe(before.routes);
    expect(s.phase).toBe('ready');
    expect(s.converting).toBeNull();
    expect(s.pointNotice?.kind).toBe(kind);
    expect(requestKey(s)).toBe(s.requested);
  });

  it('drops an answer for a conversion that is no longer waiting', () => {
    const s0 = drop(routedThree(), 2.5);
    const ticket = s0.converting?.ticket as number;
    const edited = workspaceReducer(s0, {
      type: 'setStop',
      index: 1,
      stop: { placeId: 'z', description: 'Z' },
    });
    expect(edited.converting).toBeNull();
    const late: WorkspaceAction = {
      type: 'placed',
      ticket,
      placeId: 'road-1',
      location: at(1),
      source: 'roads',
    };
    expect(workspaceReducer(edited, late)).toBe(edited);
    expect(
      workspaceReducer(edited, { type: 'placeFailed', ticket, failure: { kind: 'noRoad' } }),
    ).toBe(edited);
  });

  it('one drop or move at a time: no other point change while one is being placed', () => {
    let s = kept(routedThree(), 2.5, 'road-1');
    s = drop(s, 0.5);
    expect(drop(s, 1.5, 'other')).toBe(s);
    expect(workspaceReducer(s, { type: 'movePoint', index: 0, point: at(2.6) })).toBe(s);
    expect(workspaceReducer(s, { type: 'removePoint', index: 0 })).toBe(s);
    // Once its route lands, the points can change again.
    s = answered(sent(placed(s, 'road-0')));
    expect(drop(s, 1.5, 'other').converting).not.toBeNull();
  });

  it('a second removal before the first answers goes back to the last ANSWERED route', () => {
    let s = kept(kept(routedThree(), 0.5, 'road-0'), 2.5, 'road-1');
    const answeredRoutes = s.routes;
    s = sent(workspaceReducer(s, { type: 'removePoint', index: 0 }));
    s = sent(workspaceReducer(s, { type: 'removePoint', index: 0 }));
    expect(s.points).toEqual([]);
    s = workspaceReducer(s, { type: 'failed', token: s.token, throttled: false, message: 'no' });
    expect(s.points.map((p) => p.placeId)).toEqual(['road-0', 'road-1']);
    expect(s.routes).toBe(answeredRoutes);
  });

  it('removing one point sends the rest; removing the last asks without via', () => {
    let s = kept(kept(routedThree(), 0.5, 'road-0'), 2.5, 'road-1');
    const removed = workspaceReducer(s, { type: 'removePoint', index: 0 });
    expect(requestInput(requestKey(removed) as string, 'KM').via).toEqual([
      { placeId: 'road-1', leg: 1 },
    ]);
    s = answered(sent(removed));
    s = sent(workspaceReducer(s, { type: 'removePoint', index: 0 }));
    expect(requestInput(s.requested as string, 'KM')).not.toHaveProperty('via');
    s = answered(s, [threeLegs(0, 3000), threeLegs(1, 2000), threeLegs(2, 2500)]);
    expect(s.routes).toHaveLength(3);
    expect(s.selected).toBe(1);
  });

  it('no route selected, no point: a drop needs a route to lie on', () => {
    const s = seedState({ kind: 'stops', stops: THREE }, IDS);
    expect(drop(s, 1)).toBe(s);
  });

  it('a named-stop edit clears every point, and the refusal that went with them', () => {
    const s = kept(routedThree(), 2.5, 'road-1');
    expect(s.points).toHaveLength(1);
    const edited = workspaceReducer(s, {
      type: 'setStop',
      index: 1,
      stop: { placeId: 'z', description: 'Z' },
    });
    expect(edited.points).toEqual([]);
    expect(edited.pointNotice).toBeNull();
    expect(edited.pointsUndo).toBeNull();
  });
});

describe('workspaceReducer — moving a point', () => {
  it('keeps its leg and its place in the order, and is placed before it is routed', () => {
    let s = kept(kept(routedThree(), 0.5, 'road-0'), 2.5, 'road-1');
    s = workspaceReducer(s, { type: 'movePoint', index: 0, point: at(0.9, 0.2) });
    expect(s.converting).toMatchObject({ id: 'pt-0.5', leg: 0, insertAt: null });
    // Drawn where it was dropped until its place lands.
    expect(pointMarkers(s).markers[0]).toEqual({ lat: 0.2, lng: 0.9 });
    expect(pointMarkers(s).pending).toBeNull();
    expect(requestKey(s)).toBe(s.requested);
    s = placed(s, 'road-0b', 'roads', { lat: 0.19, lng: 0.91 });
    expect(s.points.map((p) => [p.placeId, p.leg])).toEqual([
      ['road-0b', 0],
      ['road-1', 1],
    ]);
    expect(s.points[0]?.at).toEqual({ lat: 0.19, lng: 0.91 });
    expect(requestKey(s)).not.toBe(s.requested);
  });

  it('a move undone puts the marker back where it was', () => {
    let s = kept(routedThree(), 2.5, 'road-1');
    const before = s.points[0]?.at;
    s = workspaceReducer(s, { type: 'movePoint', index: 0, point: at(2.9) });
    s = workspaceReducer(s, {
      type: 'placeFailed',
      ticket: s.converting?.ticket as number,
      failure: { kind: 'noRoad' },
    });
    expect(pointMarkers(s).markers).toEqual([before]);
    expect(s.pointNotice).toEqual({ kind: 'noRoad' });
  });

  it('a move to the same place is the route already on offer: no request', () => {
    let s = kept(routedThree(), 2.5, 'road-1');
    const routes = s.routes;
    s = workspaceReducer(s, { type: 'movePoint', index: 0, point: at(2.55) });
    s = placed(s, 'road-1', 'roads', { lat: 0, lng: 2.55 });
    expect(s).toMatchObject({ phase: 'ready', converting: null, pointsUndo: null });
    expect(s.routes).toBe(routes);
    expect(requestKey(s)).toBe(s.requested);
    expect(s.points[0]?.at).toEqual({ lat: 0, lng: 2.55 });
  });
});

describe('pointMarkers', () => {
  it('draws a drop being placed as a pending ring, and each point at its place', () => {
    const s0 = kept(routedThree(), 2.5, 'road-1');
    const s = drop(s0, 0.5);
    expect(pointMarkers(s)).toEqual({ markers: [{ lat: 0.01, lng: 9 }], pending: at(0.5) });
    expect(pointMarkers(placed(s, 'road-0')).pending).toBeNull();
  });

  it('a point with no position is drawn nowhere', () => {
    const points: WorkspacePoint[] = [{ id: 'x', placeId: 'p', leg: 0 }];
    expect(pointMarkers({ points, converting: null }).markers).toEqual([null]);
  });
});

describe('insertIndex', () => {
  const ON_LEG_1: WorkspacePoint[] = [
    { id: 'a', placeId: 'pa', leg: 1, at: at(1.2) },
    { id: 'b', placeId: 'pb', leg: 1, at: at(1.8) },
  ];
  it.each([
    ['an earlier leg goes first', 0.5, 0, 0],
    ['the same leg goes by its place along the path', 1.5, 1, 1],
    ['a later leg goes last', 2.5, 2, 2],
  ])('%s', (_, lng, leg, index) => {
    expect(insertIndex(ON_LEG_1, { at: at(lng), leg }, LINE)).toBe(index);
  });
});

/**
 * Routes refused a Roads road-segment place ID (spec TR-13 check 1): the same point is
 * converted once more through Geocoding and routed once more. Counted as the hook sends:
 * a conversion each time one waits (`stage: 'converting'` under a new ticket), a route
 * request each time the key is new.
 */
describe('workspaceReducer — a Roads place ID Routes refuses', () => {
  /** Run `steps` and count what the hook would send. */
  function counting(start: WorkspaceState) {
    let s = start;
    const conversions: { ticket: number; method: string }[] = [];
    let routeRequests = 0;
    const seen = new Set<number>();
    const note = () => {
      const c = s.converting;
      if (c?.stage === 'converting' && !seen.has(c.ticket)) {
        seen.add(c.ticket);
        conversions.push({ ticket: c.ticket, method: c.method });
      }
      const key = requestKey(s);
      if (key !== null && key !== s.requested) {
        routeRequests += 1;
        s = workspaceReducer(s, { type: 'request', token: s.token + 1, key });
      }
    };
    return {
      get s() {
        return s;
      },
      conversions,
      get routeRequests() {
        return routeRequests;
      },
      step(f: (s: WorkspaceState) => WorkspaceState) {
        s = f(s);
        note();
      },
    };
  }

  it('first drop: Roads, refused route, Geocoding, route — 2 conversions and 2 route requests', () => {
    const run = counting(routedThree());
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'road-segment', 'roads'));
    run.step(refusedVia);
    expect(run.s.converting).toMatchObject({
      stage: 'converting',
      method: 'geocoding',
      retried: true,
      at: { lat: 0, lng: 2.5 },
    });
    run.step((s) => placed(s, 'address-1', 'geocoding'));
    expect(requestInput(run.s.requested as string, 'KM').via).toEqual([
      { placeId: 'address-1', leg: 1 },
    ]);
    run.step((s) => answered(s));
    expect(run.conversions.map((c) => c.method)).toEqual(['auto', 'geocoding']);
    expect(run.routeRequests).toBe(2);
    expect(run.s).toMatchObject({ phase: 'ready', roadsRefused: true, converting: null });
    expect(run.s.points.map((p) => p.placeId)).toEqual(['address-1']);

    // A later drop of the session goes straight to Geocoding: one of each.
    run.step((s) => drop(s, 0.5));
    run.step((s) => placed(s, 'address-0', 'geocoding'));
    run.step((s) => answered(s));
    expect(run.conversions.map((c) => c.method)).toEqual(['auto', 'geocoding', 'geocoding']);
    expect(run.routeRequests).toBe(3);
  });

  it('a second refusal undoes the drop: never a third attempt', () => {
    const before = routedThree();
    const run = counting(before);
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'road-segment', 'roads'));
    run.step(refusedVia);
    run.step((s) => placed(s, 'address-1', 'geocoding'));
    run.step(refusedVia);
    expect(run.conversions).toHaveLength(2);
    expect(run.routeRequests).toBe(2);
    expect(run.s.converting).toBeNull();
    expect(run.s.points).toEqual([]);
    expect(run.s.routes).toBe(before.routes);
    expect(run.s.pointNotice).toEqual({ kind: 'viaRefused' });
    // Geocoding did not route either: the session does not switch Roads off.
    expect(run.s.roadsRefused).toBe(false);
  });

  it.each([
    ['finds nothing', { kind: 'noRoad' } as PointFailure, { kind: 'viaRefused' }],
    ['fails', { kind: 'failed', message: 'x' } as PointFailure, { kind: 'viaRefused' }],
    ['is throttled', { kind: 'throttled' } as PointFailure, { kind: 'throttled' }],
  ])('a retry conversion that %s undoes the drop', (_, failure, notice) => {
    const run = counting(routedThree());
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'road-segment', 'roads'));
    run.step(refusedVia);
    run.step((s) =>
      workspaceReducer(s, {
        type: 'placeFailed',
        ticket: s.converting?.ticket as number,
        failure,
      }),
    );
    expect(run.s.points).toEqual([]);
    expect(run.s.converting).toBeNull();
    expect(run.s.pointNotice).toEqual(notice);
    expect(run.conversions).toHaveLength(2);
    expect(run.routeRequests).toBe(1);
  });

  it('a Geocoding place refused is undone at once: there is nothing to fall back to', () => {
    const run = counting(routedThree());
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'address-1', 'geocoding'));
    run.step(refusedVia);
    expect(run.s.converting).toBeNull();
    expect(run.s.pointNotice).toEqual({ kind: 'viaRefused' });
    expect(run.conversions).toHaveLength(1);
    expect(run.routeRequests).toBe(1);
  });

  it('a Geocoding retry that returns the very place refused is not asked again', () => {
    const run = counting(routedThree());
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'same', 'roads'));
    run.step(refusedVia);
    run.step((s) => placed(s, 'same', 'geocoding'));
    expect(run.routeRequests).toBe(1);
    expect(run.s.pointNotice).toEqual({ kind: 'viaRefused' });
    expect(run.s.converting).toBeNull();
  });

  it('a move whose Geocoding retry lands back on its old place still learns Roads is refused', () => {
    const run = counting(kept(routedThree(), 2.5, 'road-1'));
    const routes = run.s.routes;
    run.step((s) => workspaceReducer(s, { type: 'movePoint', index: 0, point: at(2.6) }));
    run.step((s) => placed(s, 'road-new', 'roads'));
    run.step(refusedVia);
    expect(run.s.converting).toMatchObject({ stage: 'converting', retried: true });
    // Geocoding answers the place the point already had: the route on offer, no request.
    run.step((s) => placed(s, 'road-1', 'geocoding'));
    expect(run.s).toMatchObject({ phase: 'ready', converting: null, pointsUndo: null });
    expect(run.s.routes).toBe(routes);
    expect(run.s.roadsRefused).toBe(true);
    expect(run.routeRequests).toBe(1);
    // So the session's next drop asks Geocoding straight away: no second refused Routes call.
    expect(drop(run.s, 0.5).converting?.method).toBe('geocoding');
  });

  it('a refusal on a removal is not retried', () => {
    let s = kept(kept(routedThree(), 0.5, 'road-0'), 2.5, 'road-1');
    s = refusedVia(sent(workspaceReducer(s, { type: 'removePoint', index: 0 })));
    expect(s.converting).toBeNull();
    expect(s.points.map((p) => p.placeId)).toEqual(['road-0', 'road-1']);
    expect(s.pointNotice).toEqual({ kind: 'viaRefused' });
  });

  it('what the session learnt survives New route, and a new drop asks Geocoding', () => {
    const run = counting(routedThree());
    run.step((s) => drop(s, 2.5));
    run.step((s) => placed(s, 'road-segment', 'roads'));
    run.step(refusedVia);
    run.step((s) => placed(s, 'address-1', 'geocoding'));
    run.step((s) => answered(s));
    let s = workspaceReducer(run.s, {
      type: 'reset',
      seed: { kind: 'stops', stops: THREE },
      ids: IDS,
    });
    expect(s.roadsRefused).toBe(true);
    s = answered(sent(s), [threeLegs(0, 3000)]);
    expect(drop(s, 2.5).converting?.method).toBe('geocoding');
  });
});

describe('the 25-stop total is shared by stops and points (FR-4 3.A)', () => {
  /** From, To and 23 points: 25 in all, routed. */
  function atLimit(): WorkspaceState {
    const s = routed([route(0, 3000)]);
    const points: WorkspacePoint[] = Array.from({ length: 23 }, (_, i) => ({
      id: `p${i}`,
      placeId: `place-${i}`,
      leg: 0,
      at: at(i / 10),
    }));
    return { ...s, points, requested: requestKey({ ...s, points }) };
  }

  it('the next drop is refused with maxStops, and the key is unchanged: no request', () => {
    const s = atLimit();
    const next = drop(s, 2.5);
    expect(next.pointNotice).toEqual({ kind: 'maxStops' });
    expect(next.points).toHaveLength(23);
    expect(next.converting).toBeNull();
    expect(requestKey(next)).toBe(next.requested);
    expect(next.phase).toBe('ready');
  });

  it('Add stop is refused the same way', () => {
    const s = atLimit();
    expect(workspaceReducer(s, { type: 'insertAfter', index: 0, id: 'new' })).toBe(s);
  });

  it('with one point fewer, a drop is taken', () => {
    let s = atLimit();
    s = workspaceReducer(s, { type: 'removePoint', index: 0 });
    s = workspaceReducer(s, { type: 'answer', token: s.token, routes: [route(0, 9)] });
    const next = drop(s, 2.5);
    expect(next.converting).not.toBeNull();
    expect(next.pointNotice).toBeNull();
  });
});

import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMapsPageForTests } from '@/lib/googleMapsPage';
import { restorePointer, stubDevice } from '@/test-utils/pointer';
import { createTrpcMock } from '@/test-utils/trpc';

/**
 * Pass-through points end to end inside the workspace (FR-4, NFR-12, NFR-14, TR-18): the
 * modal, its lazy `RouteMap` and the real drag code, with only the map library and
 * Google's objects stood in for — down to the polyline's `addListener`, which is where the
 * gesture starts in a browser.
 *
 * What is pinned: only the SELECTED route listens for a press; pointer moves during a
 * drag send nothing; the drop sends exactly one `pointToPlace` for the dropped spot and,
 * once it answers, one `computeRoutes` carrying the point as its place ID on its leg —
 * never a coordinate; the one route back is selected and priced; at 25 stops and points a
 * drop and Add stop are refused with the `maxStops` message and no request; a click on the
 * only point (or its remove control in the panel) is one request and the alternatives come
 * back with the shortest selected; a refused drop — by the conversion or by the route —
 * keeps the previous route and drops the point, and says why; a Roads place ID Routes
 * refuses is converted once more through Geocoding; dragging a point's marker moves it
 * with one conversion and one request.
 */

interface Listener {
  name: string;
  fn: (e: unknown) => void;
  removed: boolean;
}
interface Pending {
  vars: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  pending: [] as Pending[],
  computed: [] as Record<string, unknown>[],
  /** `pointToPlace` calls still waiting, oldest first, and every input sent. */
  places: [] as Pending[],
  converted: [] as Record<string, unknown>[],
  /** `viaLocations` calls still waiting, oldest first, and every input sent. */
  locations: [] as Pending[],
  located: [] as Record<string, unknown>[],
  /** Every listener a route's Google polyline was given. */
  listeners: [] as Listener[],
  /** Every pass-through marker's props, latest render last. */
  points: [] as Array<Record<string, unknown>>,
  /** The temporary markers the drag made. */
  ghosts: [] as Array<{ map: unknown; position: unknown }>,
  map: {} as Record<string, unknown>,
  decoded: {} as Record<string, unknown[]>,
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

vi.mock('@vis.gl/react-google-maps', async () => {
  const React = await import('react');
  /** A stand-in for Google's polyline: what the library's forwarded ref hands over. */
  // eslint-disable-next-line react/display-name -- VeloExpense: ExpenseOS's mock, a stand-in never shown in a tree.
  const Polyline = React.forwardRef<unknown, { onClick?: () => void }>((props, ref) => {
    const polyline = React.useMemo(
      () => ({
        addListener: (name: string, fn: (e: unknown) => void) => {
          const entry: Listener = { name, fn, removed: false };
          h.listeners.push(entry);
          return {
            remove: () => {
              entry.removed = true;
            },
          };
        },
      }),
      [],
    );
    React.useImperativeHandle(ref, () => polyline, [polyline]);
    return props.onClick ? (
      <button type="button" data-testid="hit-line" onClick={props.onClick}>
        line
      </button>
    ) : null;
  });
  return {
    APILoadingStatus: { LOADED: 'LOADED', FAILED: 'FAILED', AUTH_FAILURE: 'AUTH_FAILURE' },
    APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Map: (props: { children: ReactNode; onTilesLoaded?: () => void }) => {
      React.useEffect(() => props.onTilesLoaded?.(), [props.onTilesLoaded]);
      return <div data-testid="map">{props.children}</div>;
    },
    Polyline,
    Marker: (props: { onClick?: () => void; title?: string; draggable?: boolean }) => {
      if (props.draggable === undefined) {
        return (
          <button type="button" onClick={props.onClick}>
            {`badge ${props.title}`}
          </button>
        );
      }
      h.points.push(props as Record<string, unknown>);
      return (
        <button type="button" data-testid="point-marker" onClick={props.onClick}>
          {`marker ${props.title}`}
        </button>
      );
    },
    useApiLoadingStatus: () => 'LOADED',
    useMap: () => h.map,
    useMapsLibrary: () => ({
      encoding: { decodePath: (s: string) => h.decoded[s] ?? [] },
    }),
  };
});

import { LONG_PRESS_MS } from './dragOnLine';
import { RoutePickerModal } from './RoutePickerModal';
import type { PickerRoute, WorkspaceSeed } from './routeWorkspace';
import { MILEAGE_REFUSALS } from './useRouteWorkspace';

/** A LatLng as Google hands one over. */
const latLng = (lat: number, lng: number) => ({ lat: () => lat, lng: () => lng });
/** A straight path along the equator, one degree between vertices. */
const LINE = [0, 1, 2, 3].map((lng) => latLng(0, lng));

class FakeOverlay {
  setMap() {}
  /** One map degree per 100 container pixels. */
  getProjection() {
    return {
      fromContainerPixelToLatLng: (p: { x: number; y: number }) => latLng(p.y / 100, p.x / 100),
    };
  }
}
class FakeGhost {
  map: unknown;
  position: unknown;
  constructor(opts: { map: unknown; position: unknown }) {
    this.map = opts.map;
    this.position = opts.position;
    h.ghosts.push(this);
  }
  setPosition(p: unknown) {
    this.position = p;
  }
  setMap(m: unknown) {
    this.map = m;
  }
}

beforeEach(() => {
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      SymbolPath: { CIRCLE: 0 },
      LatLngBounds: class {
        extend() {}
      },
      Size: class {},
      Point: class {
        constructor(
          public x: number,
          public y: number,
        ) {}
      },
      Marker: FakeGhost,
      OverlayView: FakeOverlay,
    },
  };
  h.pending = [];
  h.computed = [];
  h.places = [];
  h.converted = [];
  h.locations = [];
  h.located = [];
  h.listeners = [];
  h.points = [];
  h.ghosts = [];
  h.decoded = { enc0: LINE, enc1: LINE, enc2: LINE };
  h.map = {
    fitBounds: vi.fn(),
    setOptions: vi.fn(),
    getDiv: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  };
  resetMapsPageForTests();
  setTrpc();
});
afterEach(() => {
  delete (globalThis as unknown as { google?: unknown }).google;
});

function setTrpc() {
  const base = createTrpcMock({
    queries: {
      'mileageRoute.mapConfig': { data: { browserApiKey: 'browser-key', region: 'CA' } },
      'mileageRoute.recentRoutes': { dataFor: () => ({ routes: [] }) },
      'mileageRoute.searchPlaces': {
        dataFor: () => ({ available: true, items: [], error: null }),
      },
      'expenses.mileagePreview': { dataFor: () => ({ ok: true, amountMinor: '1735' }) },
    },
  });
  const computeRoutes = {
    useMutation: () => ({
      mutateAsync: (vars: Record<string, unknown>) => {
        h.computed.push(vars);
        return new Promise((resolve, reject) => h.pending.push({ vars, resolve, reject }));
      },
    }),
  };
  const pointToPlace = {
    useMutation: () => ({
      mutateAsync: (vars: Record<string, unknown>) => {
        h.converted.push(vars);
        return new Promise((resolve, reject) => h.places.push({ vars, resolve, reject }));
      },
    }),
  };
  const viaLocations = {
    useMutation: () => ({
      mutateAsync: (vars: Record<string, unknown>) => {
        h.located.push(vars);
        return new Promise((resolve, reject) => h.locations.push({ vars, resolve, reject }));
      },
    }),
  };
  const mileageRoute = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'computeRoutes'
          ? computeRoutes
          : k === 'pointToPlace'
            ? pointToPlace
            : k === 'viaLocations'
              ? viaLocations
              : (base.mileageRoute as Record<string | symbol, unknown>)[k],
    },
  );
  h.trpc = new Proxy(
    {},
    { get: (_t, k) => (k === 'mileageRoute' ? mileageRoute : base[k as string]) },
  );
}

const STOPS = [
  { placeId: 'p-tor', description: 'Toronto' },
  { placeId: 'p-kin', description: 'Kingston' },
  { placeId: 'p-ott', description: 'Ottawa' },
];
/** A route over the three stops, its metres split evenly between the two legs. */
const route = (index: number, km: number): PickerRoute => ({
  index,
  label: `Hwy ${index + 401}`,
  totalMeters: km * 1000,
  distance: `${km}.00`,
  durationSeconds: 3600,
  legs: [
    { fromPlaceId: 'p-tor', toPlaceId: 'p-kin', meters: (km * 1000) / 2 },
    { fromPlaceId: 'p-kin', toPlaceId: 'p-ott', meters: (km * 1000) / 2 },
  ],
  encodedPolyline: `enc${index}`,
});

function show(
  seed: WorkspaceSeed,
  mapAvailable = true,
  onAccept: (payload: unknown) => Promise<void> = vi.fn(async () => {}),
) {
  return render(
    <RoutePickerModal
      seed={seed}
      unit="KM"
      mapAvailable={mapAvailable}
      pricing={{
        expenseId: 'exp-1',
        categoryId: 'cat-mileage',
        currency: { code: 'CAD', symbol: '$' },
      }}
      onAccept={onAccept}
      onClose={vi.fn()}
    />,
  );
}

async function answer(routes: PickerRoute[]) {
  const next = h.pending.shift();
  if (!next) throw new Error('no computeRoutes is waiting');
  await act(async () => next.resolve({ routes }));
}
async function refuse(error: { message: string; data?: unknown }) {
  const next = h.pending.shift();
  if (!next) throw new Error('no computeRoutes is waiting');
  await act(async () => next.reject(error));
}

/** The polyline listeners still attached: only the selected route's should be. */
const pressListeners = () => h.listeners.filter((l) => l.name === 'mousedown' && !l.removed);

/** Wait for the lazy map, then for the selected route's line to listen for a press. */
async function pressable(): Promise<Listener> {
  await screen.findByTestId('map');
  await waitFor(() => expect(pressListeners()).toHaveLength(1));
  return pressListeners()[0] as Listener;
}

const pointer = (type: string, x: number, y: number) => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
  act(() => {
    document.dispatchEvent(e);
  });
};

/** Press the line at (x, y) px, drag through `via`, and release at the last of them. */
function dragLine(listener: Listener, from: [number, number], via: Array<[number, number]>) {
  act(() =>
    listener.fn({
      domEvent: { clientX: from[0], clientY: from[1], button: 0, pointerType: 'mouse' },
      latLng: latLng(from[1] / 100, from[0] / 100),
    }),
  );
  for (const [x, y] of via) pointer('pointermove', x, y);
  const [x, y] = via[via.length - 1] as [number, number];
  pointer('pointerup', x, y);
}

/** Routed over the three stops: two routes, the shorter (Hwy 402) selected. */
async function routed() {
  show({ kind: 'stops', stops: STOPS });
  expect(h.computed).toHaveLength(1);
  await answer([route(0, 400), route(1, 300)]);
  return pressable();
}

const radios = () => screen.queryAllByRole('radio');

/** `pointToPlace` answers the oldest conversion waiting. */
async function place(
  placeId: string,
  location = { lat: 0.01, lng: 2.5 },
  source: 'roads' | 'geocoding' = 'roads',
) {
  const next = h.places.shift();
  if (!next) throw new Error('no pointToPlace is waiting');
  await act(async () => next.resolve({ placeId, location, source }));
}
async function refusePlace(error: unknown) {
  const next = h.places.shift();
  if (!next) throw new Error('no pointToPlace is waiting');
  await act(async () => next.reject(error));
}
/** A tRPC client error carrying a refusal key, as the server's formatter sends one. */
const refusal = (code: string, key: string, params?: Record<string, string>) => ({
  message: 'English sentence',
  data: { code, refusal: { key, ...(params ? { params } : {}) } },
});

/**
 * Routed over the three stops (`first` on offer), then `n` points dropped one by one,
 * each placed and routed: one route on offer, through all of them.
 */
async function withPoints(n: number, first: PickerRoute[] = [route(0, 300)]) {
  const view = show({ kind: 'stops', stops: STOPS });
  await answer(first);
  // Every point on the first leg, Toronto to Kingston, in the order dropped.
  for (let i = 0; i < n; i++) {
    const line = await pressable();
    dragLine(line, [100, 0], [[50 + i * 2, 0]]);
    await place(`place-${i}`, { lat: 0, lng: (50 + i * 2) / 100 });
    await answer([route(0, 320)]);
  }
  h.computed = [];
  h.converted = [];
  return view;
}

/** A marker click this soon after a drag is the drag's own release: let it pass. */
const dragSettles = () => act(() => new Promise((r) => setTimeout(r, 350)));

describe('<RoutePickerModal> — drag the selected route through a point', () => {
  it('only the selected route takes a press; selecting another moves the listener', async () => {
    const first = await routed();
    fireEvent.click(screen.getAllByTestId('hit-line')[0] as HTMLElement);
    await waitFor(() => expect(first.removed).toBe(true));
    expect(pressListeners()).toHaveLength(1);
    expect(pressListeners()[0]).not.toBe(first);
  });

  it('the drop sends ONE conversion, then ONE request with the place ID on its leg', async () => {
    const line = await routed();
    act(() =>
      line.fn({
        domEvent: { clientX: 100, clientY: 0, button: 0, pointerType: 'mouse' },
        latLng: latLng(0, 1),
      }),
    );
    expect(h.map.setOptions).toHaveBeenLastCalledWith({ gestureHandling: 'none' });
    for (let x = 110; x <= 250; x += 10) pointer('pointermove', x, 0);
    // The temporary marker follows the pointer; nothing has been asked.
    expect(h.ghosts).toHaveLength(1);
    expect(h.ghosts[0]?.position).toEqual({ lat: 0, lng: 2.5 });
    expect(h.computed).toHaveLength(1);
    expect(h.converted).toHaveLength(0);

    pointer('pointerup', 250, 0);
    expect(h.ghosts[0]?.map).toBeNull();
    expect(h.map.setOptions).toHaveBeenLastCalledWith({ gestureHandling: 'greedy' });
    // First the spot becomes a place; no route is asked for yet, and a ring marks it.
    expect(h.converted).toEqual([{ lat: 0, lng: 2.5, method: 'auto' }]);
    expect(h.computed).toHaveLength(1);
    expect(screen.getAllByTestId('point-marker')).toHaveLength(1);
    expect(screen.getByText('route.pointAdded')).toBeInTheDocument();

    await place('road-1', { lat: 0.01, lng: 2.49 });
    expect(h.computed).toHaveLength(2);
    expect(h.computed[1]).toEqual({
      placeIds: ['p-tor', 'p-kin', 'p-ott'],
      unit: 'KM',
      via: [{ placeId: 'road-1', leg: 1 }],
    });

    // Google gives one route once a point is in it: it is selected and priced.
    await answer([route(0, 320)]);
    expect(radios()).toHaveLength(1);
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('output')).toHaveTextContent('320.00');
    // The marker sits where Google puts the place.
    expect(h.points[h.points.length - 1]).toMatchObject({ position: { lat: 0.01, lng: 2.49 } });
    expect(screen.getAllByTestId('point-marker')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'route.removePoint:1,Kingston,Ottawa' }),
    ).toBeInTheDocument();
    expect(h.computed).toHaveLength(2);
    expect(h.converted).toHaveLength(1);
  });

  it('no other drop is taken while one is being placed', async () => {
    const line = await routed();
    dragLine(line, [100, 0], [[200, 0]]);
    expect(h.converted).toHaveLength(1);
    // The line takes no press until the drop is placed and routed.
    expect(pressListeners()).toHaveLength(0);
    // Its ring takes no press either.
    expect(h.points[h.points.length - 1]).toMatchObject({ draggable: false, clickable: false });
  });

  it('a drop whose request fails is not kept: the previous routes stay and the error shows', async () => {
    const line = await routed();
    dragLine(line, [100, 0], [[200, 0]]);
    await place('road-1');
    expect(h.computed).toHaveLength(2);
    // While it is out, the point shows and the old routes stay drawn.
    expect(screen.getAllByTestId('point-marker')).toHaveLength(1);
    expect(radios()).toHaveLength(2);

    await refuse({ message: 'Google said no', data: { code: 'BAD_GATEWAY' } });
    expect(screen.queryAllByTestId('point-marker')).toHaveLength(0);
    expect(radios()).toHaveLength(2);
    expect(screen.getByRole('radio', { checked: true })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('pointsUnchanged Google said no');
    // Nothing sent again on its own.
    expect(h.computed).toHaveLength(2);
    expect(h.converted).toHaveLength(1);
  });

  it('a throttled drop is not kept either, and says so', async () => {
    const line = await routed();
    dragLine(line, [100, 0], [[200, 0]]);
    await place('road-1');
    await refuse({ message: '', data: { code: 'TOO_MANY_REQUESTS' } });
    expect(screen.queryAllByTestId('point-marker')).toHaveLength(0);
    expect(screen.getByText('pointsUnchanged throttled')).toHaveAttribute('role', 'status');
  });

  it.each([
    [
      'no road and no address near it',
      refusal('NOT_FOUND', MILEAGE_REFUSALS.noRoadNear),
      'noRoadNear',
    ],
    [
      'the key may use neither API — a red alert naming them',
      refusal('PRECONDITION_FAILED', MILEAGE_REFUSALS.dragApisUnavailable, {
        apis: 'Roads API, Geocoding API',
      }),
      'dragApisUnavailable:Roads API, Geocoding API',
    ],
    [
      'the conversion is throttled',
      { message: '', data: { code: 'TOO_MANY_REQUESTS' } },
      'pointsUnchanged throttled',
    ],
  ])(
    'a drop whose conversion is refused (%s) is undone, with no route request',
    async (_, error, text) => {
      const line = await routed();
      dragLine(line, [100, 0], [[200, 0]]);
      await refusePlace(error);
      expect(screen.queryAllByTestId('point-marker')).toHaveLength(0);
      expect(radios()).toHaveLength(2);
      expect(h.computed).toHaveLength(1);
      const notice = screen.getByText(text);
      if (text.startsWith('pointsUnchanged')) {
        expect(notice).toHaveAttribute('role', 'status');
      } else {
        expect(notice).toHaveAttribute('role', 'alert');
        expect(notice).toHaveClass('text-destructive');
      }
      // Routing by stops still works afterwards.
      expect(await pressable()).toBeDefined();
    },
  );

  it('a Roads place Routes refuses is converted once more through Geocoding, and the session remembers', async () => {
    const line = await routed();
    dragLine(line, [100, 0], [[200, 0]]);
    await place('road-segment', { lat: 0, lng: 2 }, 'roads');
    await refuse(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused));
    expect(h.converted).toEqual([
      { lat: 0, lng: 2, method: 'auto' },
      { lat: 0, lng: 2, method: 'geocoding' },
    ]);
    await place('address-1', { lat: 0.02, lng: 2 }, 'geocoding');
    expect(h.computed[2]).toMatchObject({ via: [{ placeId: 'address-1', leg: 1 }] });
    await answer([route(0, 320)]);
    expect(h.converted).toHaveLength(2);
    expect(h.computed).toHaveLength(3);
    expect(screen.getAllByTestId('point-marker')).toHaveLength(1);

    // The next drop asks Geocoding straight away.
    const next = await pressable();
    dragLine(next, [100, 0], [[150, 0]]);
    expect(h.converted[2]).toEqual({ lat: 0, lng: 1.5, method: 'geocoding' });
  });

  it('refused again after the retry: undone, said, and nothing more is sent', async () => {
    const line = await routed();
    dragLine(line, [100, 0], [[200, 0]]);
    await place('road-segment', { lat: 0, lng: 2 }, 'roads');
    await refuse(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused));
    await place('address-1', { lat: 0.02, lng: 2 }, 'geocoding');
    await refuse(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused));
    expect(h.converted).toHaveLength(2);
    expect(h.computed).toHaveLength(3);
    expect(screen.queryAllByTestId('point-marker')).toHaveLength(0);
    expect(radios()).toHaveLength(2);
    expect(screen.getByText('viaPlaceRefused')).toHaveAttribute('role', 'alert');
  });

  it('dragging a point’s marker moves it — one conversion, then one request, same leg', async () => {
    await withPoints(1);
    const marker = h.points[h.points.length - 1] as { onDragEnd: (e: unknown) => void };
    act(() => marker.onDragEnd({ latLng: latLng(0.5, 2) }));
    expect(h.converted).toEqual([{ lat: 0.5, lng: 2, method: 'auto' }]);
    expect(h.computed).toEqual([]);
    await place('road-moved', { lat: 0.49, lng: 2 });
    expect(h.computed).toEqual([
      {
        placeIds: ['p-tor', 'p-kin', 'p-ott'],
        unit: 'KM',
        via: [{ placeId: 'road-moved', leg: 0 }],
      },
    ]);
  });
});

describe('<RoutePickerModal> — removing a point', () => {
  it('a click on the only point is ONE request, and the shortest alternative comes back selected', async () => {
    await withPoints(1);
    await dragSettles();
    fireEvent.click(screen.getByTestId('point-marker'));
    expect(h.computed).toEqual([{ placeIds: ['p-tor', 'p-kin', 'p-ott'], unit: 'KM' }]);
    expect(h.converted).toEqual([]);
    expect(screen.getByText('route.pointRemoved')).toBeInTheDocument();

    await answer([route(0, 400), route(1, 300), route(2, 350)]);
    expect(radios()).toHaveLength(3);
    expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Hwy 402/);
    expect(h.computed).toHaveLength(1);
  });

  it('the panel lists each point with a named remove control, which removes it the same way', async () => {
    await withPoints(2);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('route.pointsTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'route.removePoint:2,Toronto,Kingston' }));
    expect(h.computed).toEqual([
      {
        placeIds: ['p-tor', 'p-kin', 'p-ott'],
        unit: 'KM',
        via: [{ placeId: 'place-0', leg: 0 }],
      },
    ]);
    // Focus goes to the remaining row's remove control.
    expect(
      screen.getByRole('button', { name: 'route.removePoint:1,Toronto,Kingston' }),
    ).toHaveFocus();
  });

  it('has no axe violations with points listed', async () => {
    const { container } = await withPoints(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('<RoutePickerModal> — 25 stops and points in all', () => {
  it('From, a stop, To and 22 points: the next drop is refused with maxStops and NO request', async () => {
    await withPoints(22);
    const line = await pressable();
    dragLine(line, [100, 0], [[150, 0]]);
    expect(h.computed).toEqual([]);
    expect(h.converted).toEqual([]);
    expect(screen.getAllByTestId('point-marker')).toHaveLength(22);
    const refusals = screen.getAllByText('maxStops:25');
    // Beside the points (status) and beside Add stop.
    expect(refusals.some((p) => p.getAttribute('role') === 'status')).toBe(true);
  });

  it('Add stop is refused the same way', async () => {
    await withPoints(22);
    const addStops = screen.getAllByRole('button', { name: 'addStop' });
    for (const addStop of addStops) expect(addStop).toBeDisabled();
    fireEvent.click(addStops[0] as HTMLElement);
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.getByText('maxStops:25')).toBeInTheDocument();
    expect(h.computed).toEqual([]);
  });
});
describe('<RoutePickerModal> — dragging on a phone (FR-4, NFR-12)', () => {
  beforeEach(() => stubDevice('phone'));
  afterEach(() => {
    vi.useRealTimers();
    restorePointer();
  });

  /** A touch event on the document, where the drag reads its moves and its release. */
  const touch = (type: 'touchmove' | 'touchend', x: number, y: number) => {
    const e = new Event(type, { cancelable: true });
    const at = [{ clientX: x, clientY: y }];
    Object.assign(e, { touches: type === 'touchend' ? [] : at, changedTouches: at });
    act(() => {
      document.dispatchEvent(e);
    });
    return e;
  };
  const longPressOn = (listener: Listener, x: number, y: number) =>
    act(() =>
      listener.fn({
        domEvent: { touches: [{ clientX: x, clientY: y }] },
        latLng: latLng(y / 100, x / 100),
      }),
    );
  const handle = () => screen.getByTestId('route-sheet-toggle');
  const list = () => document.getElementById(handle().getAttribute('aria-controls') ?? '');

  it('a long-press on the line and a drag is ONE request, on the sheet layout', async () => {
    const line = await routed();
    expect(screen.getByTestId('route-sheet')).toBeInTheDocument();
    vi.useFakeTimers();
    longPressOn(line, 100, 0);
    // Held, not yet a drag: panning is untouched, so a swipe would still pan.
    expect(h.ghosts).toHaveLength(0);
    expect(h.map.setOptions).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(h.map.setOptions).toHaveBeenLastCalledWith({ gestureHandling: 'none' });
    expect(h.ghosts).toHaveLength(1);
    // The finger moving the marker does not scroll the sheet under it.
    expect(touch('touchmove', 250, 0).defaultPrevented).toBe(true);
    expect(h.computed).toHaveLength(1);
    touch('touchend', 250, 0);
    vi.useRealTimers();
    expect(h.map.setOptions).toHaveBeenLastCalledWith({ gestureHandling: 'greedy' });
    expect(h.converted).toEqual([{ lat: 0, lng: 2.5, method: 'auto' }]);
    await place('road-1');
    expect(h.computed).toHaveLength(2);
    expect(h.computed[1]).toMatchObject({ via: [{ placeId: 'road-1', leg: 1 }] });
  });

  it('a swipe that starts on the line pans the map and adds nothing', async () => {
    const line = await routed();
    vi.useFakeTimers();
    longPressOn(line, 100, 0);
    act(() => vi.advanceTimersByTime(100));
    touch('touchmove', 100, 40);
    // Not taken: the browser and Google keep the swipe, and the timer is gone.
    // VeloExpense: ExpenseOS also asserts the move's `defaultPrevented` is false. The kit's
    // Dialog is Radix, whose scroll lock (react-remove-scroll) cancels every touchmove that
    // nothing inside the dialog would scroll — this one, dispatched on the document,
    // included — so that flag no longer says whether the DRAG took it. What the drag would
    // have done if it had is checked below: no ghost marker, panning never switched off.
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    touch('touchend', 100, 40);
    expect(h.ghosts).toHaveLength(0);
    expect(h.map.setOptions).not.toHaveBeenCalled();
    expect(h.computed).toHaveLength(1);
  });

  it('a drop refused at 25 is said under the map, visible with the list closed', async () => {
    await withPoints(22);
    const line = await pressable();
    // One loaded route: the list starts closed.
    expect(handle()).toHaveAttribute('aria-expanded', 'false');
    dragLine(line, [100, 0], [[150, 0]]);
    expect(h.computed).toEqual([]);
    const refusal = screen
      .getAllByText('maxStops:25')
      .find((p) => p.getAttribute('role') === 'status');
    expect(refusal).toBeDefined();
    expect(refusal).toBeVisible();
    expect(list()?.contains(refusal ?? null)).toBe(false);
  });
});

describe('<RoutePickerModal> — a stored route reopened with its points (spec FR-4, NFR-10)', () => {
  /** Toronto, Kingston, Ottawa as stored, through a point on each leg. */
  const STORED = {
    stops: STOPS,
    legs: [
      { fromPlaceId: 'p-tor', toPlaceId: 'p-kin', meters: 150_000 },
      { fromPlaceId: 'p-kin', toPlaceId: 'p-ott', meters: 180_000 },
    ],
    routeLabel: 'Hwy 7',
    routeIndex: 0,
    routeCount: 1,
    via: [
      { placeId: 'road-1', leg: 0 },
      { placeId: 'address-2', leg: 1 },
    ],
  };
  const SEED: WorkspaceSeed = {
    kind: 'previous',
    entry: { ...STORED, distance: { KM: '330.00', MI: '205.05' } },
  };

  /** Reopened and routed; the lookup answers `road-1` unplaced and `address-2` placed. */
  async function reopened(onAccept?: (payload: unknown) => Promise<void>) {
    const view = show(SEED, true, onAccept);
    expect(h.computed).toEqual([
      { placeIds: ['p-tor', 'p-kin', 'p-ott'], unit: 'KM', via: STORED.via },
    ]);
    // Nothing is looked up until the route is drawn.
    expect(h.located).toEqual([]);
    await answer([route(0, 335)]);
    expect(h.located).toEqual([{ placeIds: ['road-1', 'address-2'] }]);
    const next = h.locations.shift();
    await act(async () =>
      next?.resolve({
        results: [
          { placeId: 'road-1', location: null, reason: 'unresolved' },
          { placeId: 'address-2', location: { lat: 0, lng: 2.5 } },
        ],
      }),
    );
    await screen.findByTestId('map');
    return view;
  }

  it('ONE route request, ONE lookup; the card is the stored route; only the placed point has a marker', async () => {
    await reopened();
    expect(radios()).toHaveLength(1);
    expect(radios()[0]).toHaveAccessibleName(/route\.picker\.via:Hwy 7/);
    expect(document.querySelector('output')).toHaveTextContent('330.00');
    expect(screen.getByText('picker.storedOnly')).toBeInTheDocument();

    // The placed point is a draggable marker where Google puts it; the other has none.
    await waitFor(() => expect(screen.getAllByTestId('point-marker')).toHaveLength(1));
    expect(h.points[h.points.length - 1]).toMatchObject({
      position: { lat: 0, lng: 2.5 },
      draggable: true,
    });
    // Both are listed; the unplaced one says it is not on the map.
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText('route.pointUnplaced')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByText('route.pointUnplaced')).toBeNull();
    expect(h.computed).toHaveLength(1);
    expect(h.located).toHaveLength(1);
  });

  it('an unchanged Use this route writes the stored route back exactly', async () => {
    const onAccept = vi.fn(async (_payload: unknown) => {});
    await reopened(onAccept);
    const use = screen.getByRole('button', { name: 'route.picker.useRoute' });
    await waitFor(() => expect(use).not.toHaveAttribute('aria-disabled'));
    await act(async () => fireEvent.click(use));
    expect(onAccept).toHaveBeenCalledWith({
      mileageDistance: '330.00',
      mileageUnit: 'KM',
      mileageRoute: STORED,
    });
  });

  it('the point with no marker is removed by keyboard from the panel: ONE request without it', async () => {
    const user = userEvent.setup();
    await reopened();
    const remove = screen.getByRole('button', { name: 'route.removePoint:1,Toronto,Kingston' });
    expect(remove).not.toBeDisabled();
    // In the tab order — a native button, enabled, no negative tabindex — and pressed with
    // Enter. (Tab itself is not walked here: jsdom does not run the dialog's focus guards.)
    expect(remove.tagName).toBe('BUTTON');
    expect(remove.tabIndex).toBe(0);
    act(() => remove.focus());
    expect(remove).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(h.computed).toEqual([
      expect.anything(),
      {
        placeIds: ['p-tor', 'p-kin', 'p-ott'],
        unit: 'KM',
        via: [{ placeId: 'address-2', leg: 1 }],
      },
    ]);
    expect(h.converted).toEqual([]);
  });

  it('the placed point’s marker moves the same way a dropped one does: one conversion', async () => {
    await reopened();
    await waitFor(() => expect(screen.getAllByTestId('point-marker')).toHaveLength(1));
    const marker = h.points[h.points.length - 1] as { onDragEnd: (e: unknown) => void };
    act(() => marker.onDragEnd({ latLng: latLng(0.5, 2.2) }));
    expect(h.converted).toEqual([{ lat: 0.5, lng: 2.2, method: 'auto' }]);
    await place('road-moved', { lat: 0.49, lng: 2.2 });
    expect(h.computed[1]).toEqual({
      placeIds: ['p-tor', 'p-kin', 'p-ott'],
      unit: 'KM',
      via: [
        { placeId: 'road-1', leg: 0 },
        { placeId: 'road-moved', leg: 1 },
      ],
    });
  });

  it('2.A: the route request failing routes the stops alone, says why, and looks nothing up', async () => {
    show(SEED);
    await refuse(refusal('BAD_REQUEST', MILEAGE_REFUSALS.viaPlaceRefused));
    expect(h.computed[1]).toEqual({ placeIds: ['p-tor', 'p-kin', 'p-ott'], unit: 'KM' });
    await answer([route(0, 400), route(1, 300)]);
    expect(radios()).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('reopenFallback reopenViaRefused');
    expect(screen.queryByRole('list')).toBeNull();
    expect(h.located).toEqual([]);
  });

  it('has no axe violations with an unplaced point listed', async () => {
    const { container } = await reopened();
    expect(await axe(container)).toHaveNoViolations();
  });
});

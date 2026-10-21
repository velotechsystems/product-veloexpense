import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMapsPageForTests } from '@/lib/googleMapsPage';

/**
 * The route picker's map (FR-4 step 2–3, NFR-9, TR-14), with the map library stood in for.
 *
 * Google's script cannot run here, and what this file owes is not Google's drawing but
 * its own instructions to it: which key, language and region the script is loaded with;
 * that each route is decoded with the `geometry` library and drawn so it can be told
 * apart WITHOUT colour (weight, dash pattern, a number); that a tap on a line selects
 * that route; and that every way the map can fail ends in `onUnavailable`.
 */

const h = vi.hoisted(() => ({
  status: 'LOADED' as string,
  provider: {} as Record<string, unknown>,
  map: {} as Record<string, unknown>,
  lines: [] as Array<Record<string, unknown>>,
  markers: [] as Array<Record<string, unknown>>,
  /** What the stand-in `geometry.encoding.decodePath` returns, by encoded string. */
  decoded: {} as Record<string, unknown[]>,
  fitBounds: vi.fn(),
  geometryLoaded: true,
}));

vi.mock('@vis.gl/react-google-maps', () => ({
  APILoadingStatus: {
    NOT_LOADED: 'NOT_LOADED',
    LOADING: 'LOADING',
    LOADED: 'LOADED',
    FAILED: 'FAILED',
    AUTH_FAILURE: 'AUTH_FAILURE',
  },
  APIProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    h.provider = props;
    return <>{props.children}</>;
  },
  Map: (props: { children: ReactNode; onTilesLoaded?: () => void } & Record<string, unknown>) => {
    h.map = props;
    return (
      <div data-testid="map">
        <button type="button" onClick={() => props.onTilesLoaded?.()}>
          tiles loaded
        </button>
        {props.children}
      </div>
    );
  },
  Polyline: (props: { onClick?: () => void } & Record<string, unknown>) => {
    h.lines.push(props);
    return props.onClick ? (
      <button type="button" data-testid="hit-line" onClick={props.onClick}>
        line
      </button>
    ) : null;
  },
  Marker: (props: { onClick?: () => void; title?: string } & Record<string, unknown>) => {
    h.markers.push(props);
    return (
      <button type="button" onClick={props.onClick}>
        {`badge ${props.title}`}
      </button>
    );
  },
  useApiLoadingStatus: () => h.status,
  useMap: () => ({ fitBounds: h.fitBounds }),
  useMapsLibrary: (name: string) =>
    name === 'geometry' && h.geometryLoaded
      ? { encoding: { decodePath: (s: string) => h.decoded[s] ?? [] } }
      : null,
}));

import RouteMap from './RouteMap';
import type { PickerRoute, RouteMapProps } from './RoutePickerModal';

/** The two Maps API constructs the component touches outside the library. */
class FakeBounds {
  points: unknown[] = [];
  extend(p: unknown) {
    this.points.push(p);
  }
}
beforeEach(() => {
  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      SymbolPath: { CIRCLE: 0 },
      LatLngBounds: FakeBounds,
      Size: class {
        constructor(
          public width: number,
          public height: number,
        ) {}
      },
      Point: class {
        constructor(
          public x: number,
          public y: number,
        ) {}
      },
    },
  };
  h.status = 'LOADED';
  h.lines = [];
  h.markers = [];
  h.fitBounds = vi.fn();
  h.geometryLoaded = true;
  h.decoded = { a: ['a1', 'a2', 'a3'], b: ['b1', 'b2', 'b3'], c: ['c1', 'c2', 'c3'] };
  resetMapsPageForTests();
});
afterEach(() => {
  delete (globalThis as unknown as { google?: unknown }).google;
});

const route = (index: number, encodedPolyline: string | null): PickerRoute => ({
  index,
  label: `Hwy ${index}`,
  totalMeters: 1000,
  distance: '1.00',
  durationSeconds: 60,
  legs: [{ fromPlaceId: 'p', toPlaceId: 'q', meters: 1000 }],
  encodedPolyline,
});

function draw(over: Partial<RouteMapProps> = {}) {
  const props: RouteMapProps = {
    apiKey: 'browser-key',
    region: null,
    language: 'en',
    routes: [route(0, 'a'), route(1, 'b'), route(2, 'c')],
    names: ['via Hwy 0', 'via Hwy 1', 'via Hwy 2'],
    selected: null,
    onSelect: vi.fn(),
    onReady: vi.fn(),
    onUnavailable: vi.fn(),
    ...over,
  };
  const view = render(<RouteMap {...props} />);
  return { props, view };
}

/** The visible line of each route (the one that is neither casing nor touch target). */
function visibleLines() {
  return h.lines.filter((l) => l.strokeColor !== '#ffffff' && !l.onClick);
}
/** The last render's lines only: each render pushes a fresh set. */
function latest<T>(all: T[], perRender: number): T[] {
  return all.slice(-perRender);
}

describe('<RouteMap>', () => {
  it('loads Google’s script with the browser key, the reader’s language and the geometry library', () => {
    draw({ language: 'fr-CA', region: 'CA' });
    expect(h.provider).toMatchObject({
      apiKey: 'browser-key',
      language: 'fr-CA',
      region: 'CA',
      libraries: ['geometry'],
      // Google is sent nothing the map does not need.
      solutionChannel: '',
      disableUsageAttribution: true,
    });
  });

  it('sets no region when there is none — never a list of countries', () => {
    draw({ region: null });
    expect(h.provider).not.toHaveProperty('region');
  });

  it('draws every route, told apart by weight and dash pattern, the chosen one on top', () => {
    draw({ selected: 1 });
    const [first, chosen, third] = latest(visibleLines(), 3);

    // Route 1 unselected: thin and solid.
    expect(first).toMatchObject({ strokeWeight: 4, strokeOpacity: 1, path: ['a1', 'a2', 'a3'] });
    expect(first).not.toHaveProperty('icons');
    // The chosen route: thick, solid, highest.
    expect(chosen).toMatchObject({ strokeWeight: 8, strokeOpacity: 1, strokeColor: '#0c2340' });
    expect(chosen).not.toHaveProperty('icons');
    expect(chosen.zIndex as number).toBeGreaterThan(third.zIndex as number);
    // Route 3 unselected: thin dots (an invisible stroke carrying a circle symbol).
    expect(third).toMatchObject({ strokeWeight: 4, strokeOpacity: 0 });
    expect((third.icons as Array<{ icon: { path: unknown } }>)[0].icon.path).toBe(0);
  });

  it('draws route 2 in long dashes while it is not the chosen one', () => {
    draw({ selected: null });
    const second = latest(visibleLines(), 3)[1];
    expect(second).toMatchObject({ strokeWeight: 4, strokeOpacity: 0 });
    expect((second.icons as Array<{ icon: { path: unknown } }>)[0].icon.path).toBe('M 0,-1 0,1');
  });

  it('numbers each line like its card, and a tap on the line or its number selects it', () => {
    const { props } = draw();
    expect(latest(h.markers, 3).map((m) => (m.label as { text: string }).text)).toEqual([
      '1',
      '2',
      '3',
    ]);

    const hitLines = screen.getAllByTestId('hit-line');
    fireEvent.click(hitLines[2]);
    expect(props.onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'badge via Hwy 1' }));
    expect(props.onSelect).toHaveBeenLastCalledWith(1);
  });

  it('draws a single route as the chosen one, with no number', () => {
    draw({ routes: [route(0, 'a')], names: ['via Hwy 0'] });
    expect(latest(visibleLines(), 1)[0]).toMatchObject({ strokeWeight: 8 });
    expect(h.markers).toEqual([]);
  });

  it('frames all the routes once', () => {
    draw();
    expect(h.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, padding] = h.fitBounds.mock.calls[0] as [FakeBounds, number];
    expect(bounds.points).toHaveLength(9);
    expect(padding).toBe(32);
  });

  it('skips a route Google sent no path for, and still draws the others', () => {
    const { props } = draw({ routes: [route(0, 'a'), route(1, null)] });
    expect(screen.getAllByTestId('hit-line')).toHaveLength(1);
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

  it('is unavailable when there is no path to draw at all', () => {
    const { props } = draw({ routes: [route(0, null), route(1, null)] });
    expect(props.onUnavailable).toHaveBeenCalled();
  });

  it('says it is ready once Google has drawn the tiles', () => {
    const { props } = draw();
    fireEvent.click(screen.getByRole('button', { name: 'tiles loaded' }));
    expect(props.onReady).toHaveBeenCalled();
  });

  it.each(['FAILED', 'AUTH_FAILURE'])('is unavailable when the loader reports %s', (status) => {
    h.status = status;
    const { props } = draw();
    expect(props.onUnavailable).toHaveBeenCalled();
  });

  it('is unavailable when the script fails to load (onError)', () => {
    const { props } = draw();
    act(() => (h.provider.onError as (e: unknown) => void)(new Error('network')));
    expect(props.onUnavailable).toHaveBeenCalled();
  });

  it('draws each pass-through point as a draggable ring with a 44 px hit area', () => {
    const onRemovePoint = vi.fn();
    const onMovePoint = vi.fn();
    draw({
      routes: [route(0, 'a')],
      points: [{ lat: 1, lng: 2 }],
      pointNames: ['Remove point 1'],
      onRemovePoint,
      onMovePoint,
    });
    const point = h.markers.find((m) => m.title === 'Remove point 1') as Record<string, unknown>;
    expect(point).toMatchObject({ position: { lat: 1, lng: 2 }, draggable: true, clickable: true });
    const icon = point.icon as { url: string; size: { width: number }; anchor: { x: number } };
    expect(icon.size.width).toBe(44);
    expect(icon.anchor.x).toBe(22);
    // A hollow ring: an image icon, not the filled numbered badge symbol.
    expect(decodeURIComponent(icon.url)).toContain("stroke='#0c2340'");

    fireEvent.click(screen.getByRole('button', { name: 'badge Remove point 1' }));
    expect(onRemovePoint).toHaveBeenCalledOnce();
    expect(onRemovePoint).toHaveBeenCalledWith(0);
  });

  it('a drag of a point moves it, and the click that ends the drag removes nothing', () => {
    const onRemovePoint = vi.fn();
    const onMovePoint = vi.fn();
    draw({
      routes: [route(0, 'a')],
      points: [{ lat: 1, lng: 2 }],
      pointNames: ['Remove point 1'],
      onRemovePoint,
      onMovePoint,
    });
    const point = h.markers.find((m) => m.title === 'Remove point 1') as {
      onDragEnd: (e: unknown) => void;
    };
    act(() => point.onDragEnd({ latLng: { lat: () => 3, lng: () => 4 } }));
    expect(onMovePoint).toHaveBeenCalledOnce();
    expect(onMovePoint).toHaveBeenCalledWith(0, { lat: 3, lng: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'badge Remove point 1' }));
    expect(onRemovePoint).not.toHaveBeenCalled();
  });

  it('without point handlers a point can be neither dragged nor clicked', () => {
    draw({ routes: [route(0, 'a')], points: [{ lat: 1, lng: 2 }], pointNames: ['p'] });
    expect(h.markers.find((m) => m.title === 'p')).toMatchObject({
      draggable: false,
      clickable: false,
    });
  });

  it('a point with no position is not drawn; a drop being placed is a ring that takes no press', () => {
    draw({
      routes: [route(0, 'a')],
      points: [null, { lat: 1, lng: 2 }],
      pending: { lat: 5, lng: 6 },
      pointNames: ['first', 'second'],
      onRemovePoint: vi.fn(),
      onMovePoint: vi.fn(),
    });
    const rings = h.markers.filter((m) => typeof (m.icon as { url?: string })?.url === 'string');
    expect(rings.map((m) => m.position)).toEqual([
      { lat: 1, lng: 2 },
      { lat: 5, lng: 6 },
    ]);
    expect(h.markers.find((m) => m.title === 'first')).toBeUndefined();
    const pending = rings.find((m) => (m.position as { lat: number }).lat === 5);
    expect(pending).toMatchObject({ clickable: false });
    expect(pending?.draggable).toBeFalsy();
  });

  it('is unavailable when Google refuses the key (gm_authFailure)', () => {
    const { props } = draw();
    expect(props.onUnavailable).not.toHaveBeenCalled();
    act(() => (window as unknown as { gm_authFailure: () => void }).gm_authFailure());
    expect(props.onUnavailable).toHaveBeenCalled();
  });
});

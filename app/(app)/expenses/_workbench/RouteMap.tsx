// TypeScript 6 includes no `@types/*` package unless asked, and `google.maps.*` (the
// Maps API's own types, installed with the map library) is used below. A triple-slash
// reference must come before every statement, `'use client'` included.
/// <reference types="google.maps" />
'use client';

/**
 * The route picker's map: every route Calculate brought back, drawn on a Google map.
 *
 * One of exactly three files allowed to import `@vis.gl/react-google-maps` (the others
 * are the saved line's `RouteLineMap` and the admin page's `MapKeyProbe`), and only ever
 * loaded through `React.lazy` from
 * `RoutePickerModal` — a test pins both — so the library and Google's script are not
 * part of the expense page's first load (NFR-11). It is mounted only while the picker is
 * open with a browser key, and unmounted with it, which drops the decoded paths: they
 * are drawn and never kept (TR-12, paralegal B1/B7).
 *
 * What it must get right:
 *   · **Routes told apart without colour.** The unselected routes are thin grey lines,
 *     route 1 solid, route 2 long dashes, route 3 dots; the selected one is thick, solid
 *     and on top. Each line also carries its card's number in a badge, so "2" on the map
 *     is "2" in the list (NFR-9). Colour only reinforces this.
 *   · **One selection.** Tapping a line or its badge calls `onSelect`; the modal owns
 *     `selected` and both the cards and the lines render it.
 *   · **Failure is quiet and total.** Google's script failing to load, a refused key
 *     (`gm_authFailure` — see `lib/googleMapsPage.ts`), or no path to draw each call
 *     `onUnavailable`, and the modal swaps the map for the "map unavailable" line. The
 *     modal's watchdog covers what reports nothing.
 *   · **Google's own map.** The paths are drawn on a Google map only (paralegal B6), and
 *     nothing is laid over it, so Google's logo and attribution stay visible (B5).
 *   · **Drag the selected route to pass through a point (FR-4, TR-18).** The library's
 *     `Polyline` has no press prop, but it forwards a ref to Google's polyline, which raises
 *     `mousedown`. So the selected route's touch line alone takes a callback ref, and its
 *     `mousedown` starts the gesture in `dragOnLine.ts`: panning off, a temporary marker
 *     that follows the pointer, nothing sent until the drop. Unselected routes only select.
 *     Each point is a legacy draggable `Marker` (no Map ID, no `AdvancedMarker`), a hollow
 *     ring with a 44 px hit area: dragging it moves the point, clicking it removes it. A
 *     drop still being turned into a place ID is a ring that takes no press (`pending`);
 *     a point is drawn where Google puts its place, which the modal holds for its session
 *     only.
 *
 * Paths are decoded with the Maps `geometry` library (TR-14), here rather than by the
 * library's `encodedPath`, because the decoded points are also what the camera is fitted to.
 */

import {
  APILoadingStatus,
  APIProvider,
  Map as GoogleMap,
  Marker,
  Polyline,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { claimMapsKey, onMapsAuthFailure } from '@/lib/googleMapsPage';
import { createLineDrag, type LatLng } from './dragOnLine';
import type { PickerRoute, RouteMapProps } from './RoutePickerModal';

/**
 * Line colours, as literals because Google draws them outside the DOM where CSS
 * variables do not reach. They mirror the design tokens: `brand-navy` (#0c2340) for the
 * chosen route and `muted-foreground` (#5e6678) for the others, each on a white casing
 * so it reads over any map tile.
 */
const SELECTED = '#0c2340';
const OFFERED = '#5e6678';
const CASING = '#ffffff';

/**
 * Stable across renders: the provider re-runs its loader effect when `libraries`
 * changes identity (`useGoogleMapsApiLoader` lists it as a dependency).
 */
const LIBRARIES = ['geometry'];

/** The map's own gesture setting, and the one it is set back to after a drag. */
const GESTURES = 'greedy';

/**
 * A click that lands this soon after a drag ended is the drag's own release, not a request
 * to remove the point under it (UX: a dropped marker must not remove itself).
 */
const CLICK_AFTER_DRAG_MS = 300;

/** Pass-through points sit above every route line (z 10–33) and its badge. */
const POINT_Z = 40;
const GHOST_Z = 50;

export default function RouteMap({ apiKey, region, language, ...map }: RouteMapProps) {
  const unavailable = useLatest(map.onUnavailable);
  const onError = useMemo(() => () => unavailable.current(), [unavailable]);

  useEffect(() => {
    claimMapsKey(apiKey);
  }, [apiKey]);

  return (
    <APIProvider
      apiKey={apiKey}
      language={language}
      // A multi-country restriction cannot be a map region; mapConfig sends one code or null.
      {...(region ? { region } : {})}
      libraries={LIBRARIES}
      onError={onError}
      // Send Google nothing the map does not need: no library-usage attribution.
      solutionChannel=""
      disableUsageAttribution
    >
      <RouteCanvas {...map} />
    </APIProvider>
  );
}

function RouteCanvas({
  routes,
  names,
  selected,
  onSelect,
  onReady,
  onUnavailable,
  fitKey,
  points = [],
  pending = null,
  pointNames = [],
  onDropPoint,
  onMovePoint,
  onRemovePoint,
  onDragStart,
  onDragCancel,
}: Omit<RouteMapProps, 'apiKey' | 'region' | 'language'>) {
  const unavailable = useLatest(onUnavailable);
  const status = useApiLoadingStatus();
  useEffect(() => {
    if (status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE) {
      unavailable.current();
    }
  }, [status, unavailable]);
  useEffect(() => onMapsAuthFailure(() => unavailable.current()), [unavailable]);

  const geometry = useMapsLibrary('geometry');
  const paths = useMemo(
    () =>
      geometry
        ? routes.map((r) =>
            r.encodedPolyline ? geometry.encoding.decodePath(r.encodedPolyline) : null,
          )
        : null,
    [geometry, routes],
  );
  // Only a route list with no drawable path is a failure. An empty list is a workspace
  // that has not been routed yet: the map shows the world and waits.
  const nothingToDraw = routes.length > 0 && (paths?.every((p) => !p || p.length < 2) ?? false);
  useEffect(() => {
    if (nothingToDraw) unavailable.current();
  }, [nothingToDraw, unavailable]);

  const single = routes.length === 1;

  /** When the last drag (off the line, or of a point) ended: see `CLICK_AFTER_DRAG_MS`. */
  const dragEndedAt = useRef(0);
  const markDragEnd = useCallback(() => {
    dragEndedAt.current = Date.now();
  }, []);
  const handlers = useLatest({ onDropPoint, onDragStart, onDragCancel, markDragEnd });
  const draggable = Boolean(onDropPoint);
  const ring = useMemo(() => (paths ? ringIcon(1) : null), [paths]);

  return (
    <GoogleMap
      // No text selection or callout under a long-press on the line (TR-18, touch).
      className="h-full w-full select-none [-webkit-touch-callout:none]"
      defaultCenter={{ lat: 0, lng: 0 }}
      defaultZoom={2}
      // The map sits outside the scrolling list, so one finger pans it on a phone.
      gestureHandling={GESTURES}
      disableDefaultUI
      zoomControl
      // Places on the map are not part of the claim; a tap on one does nothing.
      clickableIcons={false}
      onTilesLoaded={onReady}
    >
      {paths && <FitRoutes paths={paths} fitKey={fitKey} />}
      {paths &&
        routes.map((route, i) => {
          const path = paths[i];
          if (!path || path.length < 2) return null;
          return (
            <RouteLine
              key={route.index}
              route={route}
              position={i}
              path={path}
              name={names[i] ?? ''}
              selected={route.index === selected || single}
              badge={!single}
              onSelect={onSelect}
              draggable={draggable}
              handlers={handlers}
            />
          );
        })}
      {/* Only once Google's script is in (`paths` waits for it): the ring is a Maps icon. */}
      {ring &&
        points.map((point, i) =>
          point ? (
            <Marker
              // By position in the list: a removal shifts the rest, and each takes its new place.
              // biome-ignore lint/suspicious/noArrayIndexKey: the map is told positions, not ids
              key={i}
              position={{ lat: point.lat, lng: point.lng }}
              title={pointNames[i] ?? ''}
              icon={ring}
              zIndex={POINT_Z}
              draggable={Boolean(onMovePoint)}
              clickable={Boolean(onRemovePoint)}
              onDragEnd={(e) => {
                markDragEnd();
                if (e.latLng) onMovePoint?.(i, { lat: e.latLng.lat(), lng: e.latLng.lng() });
              }}
              onClick={() => {
                if (Date.now() - dragEndedAt.current < CLICK_AFTER_DRAG_MS) return;
                onRemovePoint?.(i);
              }}
            />
          ) : null,
        )}
      {ring && pending && (
        <Marker
          position={{ lat: pending.lat, lng: pending.lng }}
          icon={ring}
          zIndex={POINT_Z}
          draggable={false}
          clickable={false}
        />
      )}
    </GoogleMap>
  );
}

/** The canvas's latest drag callbacks, read when an event fires (`useLatest`). */
interface DragHandlers {
  readonly current: {
    onDropPoint?: RouteMapProps['onDropPoint'];
    onDragStart?: () => void;
    onDragCancel?: () => void;
    markDragEnd: () => void;
  };
}

/**
 * Turns a viewport point into a map position. Google gives a position only for events on
 * its own objects, so the drag reads the document's pointer and asks the map's projection,
 * through an overlay that draws nothing (`OverlayView.getProjection`).
 */
function useContainerProjection(map: google.maps.Map | null) {
  const overlay = useRef<google.maps.OverlayView | null>(null);
  useEffect(() => {
    if (!map) return;
    class Probe extends google.maps.OverlayView {
      override onAdd() {}
      override draw() {}
      override onRemove() {}
    }
    const probe = new Probe();
    probe.setMap(map);
    overlay.current = probe;
    return () => {
      probe.setMap(null);
      overlay.current = null;
    };
  }, [map]);
  return useCallback(
    (clientX: number, clientY: number): LatLng | null => {
      const projection = overlay.current?.getProjection();
      if (!map || !projection) return null;
      const box = map.getDiv().getBoundingClientRect();
      const at = projection.fromContainerPixelToLatLng(
        new google.maps.Point(clientX - box.left, clientY - box.top),
      );
      return at ? { lat: at.lat(), lng: at.lng() } : null;
    },
    [map],
  );
}

/**
 * The press-and-drag on the selected route's touch line. Listens to Google's polyline
 * `mousedown` (reached through the forwarded ref) only while the line is selected and the
 * workspace takes points, and hands it to `dragOnLine`.
 */
function useLineDrag(
  hit: google.maps.Polyline | null,
  path: google.maps.LatLng[],
  handlers: DragHandlers,
) {
  const map = useMap();
  // The probe overlay only for the one line that takes a press.
  const toLatLng = useContainerProjection(hit ? map : null);
  const latestPath = useLatest(path);
  useEffect(() => {
    if (!hit || !map) return;
    let ghost: google.maps.Marker | null = null;
    const drag = createLineDrag({
      setPanning: (on) => map.setOptions({ gestureHandling: on ? GESTURES : 'none' }),
      toLatLng,
      ghost: {
        show: (at) => {
          ghost = new google.maps.Marker({
            map,
            position: at,
            clickable: false,
            icon: ringIcon(1.25),
            zIndex: GHOST_Z,
          });
        },
        move: (at) => ghost?.setPosition(at),
        hide: () => {
          ghost?.setMap(null);
          ghost = null;
        },
      },
      onStart: () => handlers.current.onDragStart?.(),
      onDrop: (at) => {
        handlers.current.markDragEnd();
        const points = latestPath.current.map((p) => ({ lat: p.lat(), lng: p.lng() }));
        handlers.current.onDropPoint?.(at, points);
      },
      onCancel: () => {
        handlers.current.markDragEnd();
        handlers.current.onDragCancel?.();
      },
    });
    const listener = hit.addListener('mousedown', (e: google.maps.PolyMouseEvent) =>
      drag.press(e.domEvent, e.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null),
    );
    return () => {
      listener.remove();
      drag.dispose();
    };
  }, [hit, map, toLatLng, handlers, latestPath]);
}

/**
 * A pass-through point's look: a hollow ring with a centre dot, 20 px across (25 px for
 * the temporary marker), on a white casing, inside a 44 px disc that is all but
 * transparent — the marker's hit area is its image, so the disc is the touch target.
 * Told apart from the route badges by shape (a ring, not a filled numbered circle).
 */
function ringIcon(scale: number): google.maps.Icon {
  const r = 9 * scale;
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'>" +
    "<circle cx='22' cy='22' r='22' fill='#ffffff' fill-opacity='0.01'/>" +
    `<circle cx='22' cy='22' r='${r + 1.5}' fill='${CASING}'/>` +
    `<circle cx='22' cy='22' r='${r}' fill='${CASING}' stroke='${SELECTED}' stroke-width='3'/>` +
    `<circle cx='22' cy='22' r='${2.5 * scale}' fill='${SELECTED}'/>` +
    '</svg>';
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    size: new google.maps.Size(44, 44),
    scaledSize: new google.maps.Size(44, 44),
    anchor: new google.maps.Point(22, 22),
  };
}

/**
 * Frame every route once its points are known — once per `fitKey`, so a new set of stops
 * is framed again while the person's own panning and zooming of the same stops is left
 * alone. Without a key, once for the life of the map.
 */
function FitRoutes({
  paths,
  fitKey = '',
}: {
  paths: (google.maps.LatLng[] | null)[];
  fitKey?: string;
}) {
  const map = useMap();
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!map || fitted.current === fitKey) return;
    const bounds = new google.maps.LatLngBounds();
    let points = 0;
    for (const path of paths) {
      for (const point of path ?? []) {
        bounds.extend(point);
        points += 1;
      }
    }
    if (points === 0) return;
    fitted.current = fitKey;
    map.fitBounds(bounds, 32);
  }, [map, paths, fitKey]);
  return null;
}

/**
 * One route: a white casing, the visible line, a wide invisible line that makes it easy
 * to tap, and — when there is more than one route — its number at the middle of the path.
 */
function RouteLine({
  route,
  position,
  path,
  name,
  selected,
  badge,
  onSelect,
  draggable,
  handlers,
}: {
  route: PickerRoute;
  /** 0-based place in the list, which is also the card's number minus one. */
  position: number;
  path: google.maps.LatLng[];
  name: string;
  selected: boolean;
  badge: boolean;
  onSelect: (index: number) => void;
  /** The workspace takes points: the selected line takes a press-and-drag. */
  draggable: boolean;
  handlers: DragHandlers;
}) {
  const select = () => onSelect(route.index);
  // Google's polyline under the touch line, once the library has made it; only the
  // selected route's is asked for, so only the selected route can be dragged.
  const [hit, setHit] = useState<google.maps.Polyline | null>(null);
  const takesPress = selected && draggable;
  useLineDrag(takesPress ? hit : null, path, handlers);
  const weight = selected ? 8 : 4;
  // The chosen route on top; the others in list order beneath it.
  const z = selected ? 30 : 10 + (3 - position);
  const pattern = selected ? 'solid' : PATTERNS[position % PATTERNS.length];
  const middle = path[Math.floor(path.length / 2)];

  return (
    <>
      <Polyline
        path={path}
        strokeColor={CASING}
        strokeOpacity={1}
        strokeWeight={weight + 4}
        zIndex={z}
        clickable={false}
      />
      <Polyline
        path={path}
        {...lineStyle(pattern, selected ? SELECTED : OFFERED, weight)}
        zIndex={z + 1}
        clickable={false}
      />
      {/* The touch target: the line itself is 4 px, a finger is not. */}
      <Polyline
        ref={takesPress ? setHit : undefined}
        path={path}
        strokeColor={OFFERED}
        strokeOpacity={0.01}
        strokeWeight={24}
        zIndex={z + 2}
        clickable
        onClick={select}
      />
      {badge && middle && (
        <Marker
          position={middle}
          title={name}
          zIndex={z + 3}
          onClick={select}
          label={{
            text: String(position + 1),
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: '600',
          }}
          icon={{
            path: google.maps.SymbolPath.CIRCLE,
            scale: 11,
            fillColor: selected ? SELECTED : OFFERED,
            fillOpacity: 1,
            strokeColor: CASING,
            strokeWeight: 2,
          }}
        />
      )}
    </>
  );
}

type Pattern = 'solid' | 'dash' | 'dot';

/** Route 1 solid, route 2 long dashes, route 3 dots — the order of the cards. */
const PATTERNS: Pattern[] = ['solid', 'dash', 'dot'];

/**
 * A Google polyline has no dash setting: a dashed or dotted line is an invisible stroke
 * carrying a repeated symbol, which is how Google's own examples draw one.
 */
function lineStyle(
  pattern: Pattern,
  color: string,
  weight: number,
): Pick<google.maps.PolylineOptions, 'strokeColor' | 'strokeOpacity' | 'strokeWeight' | 'icons'> {
  if (pattern === 'solid') return { strokeColor: color, strokeOpacity: 1, strokeWeight: weight };
  const icon: google.maps.Symbol =
    pattern === 'dash'
      ? { path: 'M 0,-1 0,1', strokeColor: color, strokeOpacity: 1, scale: weight }
      : {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: color,
          fillOpacity: 1,
          strokeOpacity: 0,
          scale: weight / 2,
        };
  return {
    strokeColor: color,
    strokeOpacity: 0,
    strokeWeight: weight,
    icons: [
      { icon, offset: '0', repeat: pattern === 'dash' ? `${weight * 5}px` : `${weight * 3}px` },
    ],
  };
}

/** A ref that always holds the latest value, so effects can call it without re-running. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

// TypeScript 6 includes no `@types/*` package unless asked, and `google.maps.*` is used
// below. A triple-slash reference must come before every statement, `'use client'` included.
/// <reference types="google.maps" />
'use client';

/**
 * The small map on a saved mileage line (FR-3): the path the server just routed for the
 * line, and its From and To — a picture of the route, nothing to operate. No marker for a
 * point the route was dragged through (ruled 2026-10-19: the path and its A/B ends only).
 *
 * The third and last file allowed to import `@vis.gl/react-google-maps` (with `RouteMap`
 * and the admin page's `MapKeyProbe`), and only ever loaded through `React.lazy` from
 * `RouteLine` — `lib/mapLibraryImports.test.ts` pins both — so the library and Google's
 * script are part of no first load (NFR-11, TR-18).
 *
 *   · **No gestures, no controls, no keyboard.** `gestureHandling: 'none'`, the default UI
 *     off, keyboard shortcuts and double-click zoom off, and nothing clickable. The line's
 *     dropdown is where the route is changed.
 *   · **Google's own map, nothing laid over it** (paralegal B5, B6). The default UI flag
 *     takes the buttons away, not Google's logo or attribution. The line's loading spinner
 *     sits over it only until the tiles are drawn, and is gone before anything is read.
 *   · **The same script parameters as `RouteMap`.** Google's script is loaded once per page
 *     with whichever parameters arrive first (`lib/googleMapsPage.ts`), so this map asks for
 *     exactly what the workspace map asks for: the `geometry` library, no solution channel,
 *     no usage attribution, and the key claimed through `claimMapsKey`.
 *   · **Drawn, never kept.** The decoded path lives in this component and goes with it
 *     (paralegal B1, B7): no image, no export.
 *   · **Two ways to fail, told apart.** `onUnavailable('library')` when Google's script,
 *     the key or its authorisation fails — every map on the page would fail the same way;
 *     `onUnavailable('path')` when this line's path decodes to nothing to draw.
 *
 * From and To are the first and last points of the path: the line holds its stops' place
 * ids and names, not their coordinates.
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
import { useEffect, useMemo, useRef } from 'react';
import { claimMapsKey, onMapsAuthFailure } from '@/lib/googleMapsPage';
import type { RouteLineMapProps } from './RouteLine';

/** The design tokens' `brand-navy` and white, as literals: Google draws outside the DOM. */
const LINE = '#0c2340';
const CASING = '#ffffff';

/** Identical to `RouteMap`'s, and stable across renders (the loader effect depends on it). */
const LIBRARIES = ['geometry'];

/** Padding around the fitted path, in pixels. */
const FIT_PADDING = 16;

export default function RouteLineMap({ apiKey, region, language, ...map }: RouteLineMapProps) {
  const unavailable = useLatest(map.onUnavailable);
  const onError = useMemo(() => () => unavailable.current('library'), [unavailable]);

  useEffect(() => {
    claimMapsKey(apiKey);
  }, [apiKey]);

  return (
    <APIProvider
      apiKey={apiKey}
      language={language}
      {...(region ? { region } : {})}
      libraries={LIBRARIES}
      onError={onError}
      solutionChannel=""
      disableUsageAttribution
    >
      <LineCanvas {...map} />
    </APIProvider>
  );
}

function LineCanvas({
  encodedPolyline,
  onReady,
  onUnavailable,
}: Omit<RouteLineMapProps, 'apiKey' | 'region' | 'language'>) {
  const unavailable = useLatest(onUnavailable);
  const status = useApiLoadingStatus();
  useEffect(() => {
    if (status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE) {
      unavailable.current('library');
    }
  }, [status, unavailable]);
  useEffect(() => onMapsAuthFailure(() => unavailable.current('library')), [unavailable]);

  const geometry = useMapsLibrary('geometry');
  const path = useMemo(
    () => (geometry ? geometry.encoding.decodePath(encodedPolyline) : null),
    [geometry, encodedPolyline],
  );
  const nothingToDraw = path !== null && path.length < 2;
  useEffect(() => {
    if (nothingToDraw) unavailable.current('path');
  }, [nothingToDraw, unavailable]);

  const from = path?.[0];
  const to = path && path.length > 1 ? path[path.length - 1] : undefined;

  return (
    <GoogleMap
      className="h-full w-full"
      defaultCenter={{ lat: 0, lng: 0 }}
      defaultZoom={2}
      gestureHandling="none"
      disableDefaultUI
      keyboardShortcuts={false}
      disableDoubleClickZoom
      clickableIcons={false}
      onTilesLoaded={onReady}
    >
      {path && path.length >= 2 && (
        <>
          {/* Keyed by the path: a different one on the same map is framed afresh. The map
            itself stays mounted — no second Google load. */}
          <FitPath key={encodedPolyline} path={path} />
          <Polyline
            path={path}
            strokeColor={CASING}
            strokeOpacity={1}
            strokeWeight={7}
            clickable={false}
          />
          <Polyline
            path={path}
            strokeColor={LINE}
            strokeOpacity={1}
            strokeWeight={4}
            zIndex={1}
            clickable={false}
          />
          {from && <EndMarker position={from} letter="A" />}
          {to && <EndMarker position={to} letter="B" />}
        </>
      )}
    </GoogleMap>
  );
}

/** A lettered end: A is From, B is To. */
function EndMarker({ position, letter }: { position: google.maps.LatLng; letter: string }) {
  return (
    <Marker
      position={position}
      clickable={false}
      zIndex={3}
      label={{ text: letter, color: CASING, fontSize: '11px', fontWeight: '600' }}
      icon={{
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: LINE,
        fillOpacity: 1,
        strokeColor: CASING,
        strokeWeight: 2,
      }}
    />
  );
}

/**
 * Frame the path once, when its points are known; never again for that path. A new path
 * is a new `key`, so a new `FitPath` frames it in turn.
 */
function FitPath({ path }: { path: google.maps.LatLng[] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (!map || fitted.current || path.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const point of path) bounds.extend(point);
    fitted.current = true;
    map.fitBounds(bounds, FIT_PADDING);
  }, [map, path]);
  return null;
}

/** A ref that always holds the latest value, so effects can call it without re-running. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

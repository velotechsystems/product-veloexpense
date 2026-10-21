'use client';

/**
 * A saved mileage line's route, for the line's writer (FR-3, FR-6, FR-7).
 *
 * Two things, top to bottom:
 *
 *   · **The route dropdown** (`RouteSelect`), whose closed state reads the route — its two
 *     ends, and Google's name for it when there is one. Open, it offers **Change route**
 *     (the workspace on this route's named stops), **New route**, then **Previous routes**.
 *     Every entry opens the workspace, and its Use this route updates the line in one
 *     write (`onAccept`).
 *   · **A small map** of the route (`RouteLineMap.tsx`, loaded through `React.lazy` so the
 *     map library is in no first load), with no gestures and no controls. Nothing Google
 *     draws is kept on the line, so the path is asked for each time the map is mounted:
 *     one `mileageRoute.lineRoutePath` per mount (`useLineRoutePath`), which writes
 *     nothing. The map mounts only once the line has been on screen, and only while it
 *     holds one of the `MAX_LINE_MAPS` slots on the page. Until the map's tiles are drawn,
 *     a spinner (`MapSpinner`) sits in the map's box.
 *
 * What the line shows, by state:
 *
 *   · no browser key, a stop without a place, or this line's map failed (the path call
 *     refused, throttled or empty, the chunk, the script, the key, the watchdog) → the text
 *     summary (`RouteSummary`), with no error text;
 *   · not yet on screen, or waiting for its slot to be confirmed → an empty box the size
 *     of the map, hidden from assistive technology, so the summary never flashes first;
 *   · a slot held → the map: spinner, then the path with its A/B ends;
 *   · five maps already open → the summary and the sentence "Map not shown: five route
 *     maps are already open on this page" — plain text, not a live region (NFR-10).
 *
 * A line whose map failed gives its slot back, so a line waiting for one gets a map. A
 * failure of the map library itself (`mapLibraryFailed`) stops the page from asking for any
 * more paths: every later map would fail the same way after spending a paid call.
 *
 * Change route reopens the workspace on the route as stored — its stops and the points it
 * passes through (`via`) — which it routes with one request and shows as stored until
 * something is changed (`changeRouteSeed`, spec FR-4).
 *
 * Read-only and approver views never render this: `LineItemReadOnlyRow` and
 * `MileageLineDetail` keep their text summary, so they never read `mapConfig` and never
 * ask for a path.
 */

import { useLocale, useTranslations } from 'next-intl';
import {
  type ComponentType,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CurrencyLike } from '@/lib/format';
import type { RouteValue } from '@/lib/mileageRouteSchema';
import { trpc } from '@/lib/trpc/client';
import { MapSpinner } from './MapSpinner';
import { RouteSummary } from './RouteEditor';
import { MAP_WATCHDOG_MS, RoutePickerModal } from './RoutePickerModal';
import { RouteSelect } from './RouteSelect';
import { type AcceptPayload, storedRouteEntry, type WorkspaceSeed } from './routeWorkspace';
import { useLineRoutePath } from './useLineRoutePath';
import type { MileagePricing } from './useMileageQuote';
import { useOnScreen } from './useOnScreen';
import { useRecentRoutes } from './useRecentRoutes';

/** Why a map cannot be shown: the map library (every map on the page), or this path. */
export type LineMapFailure = 'library' | 'path';

/**
 * What `RouteLineMap` is given. Declared here, by the one file that loads it, so nothing
 * imports `RouteLineMap` statically — that one import would put the map library in the
 * expense page's first load.
 */
export interface RouteLineMapProps {
  /** The browser key from `mileageRoute.mapConfig`. Held in memory only. */
  apiKey: string;
  /** A single country code, or null for none. */
  region: string | null;
  /** The reader's locale, for Google's own labels. */
  language: string;
  encodedPolyline: string;
  /** The tiles are drawn: the spinner and the watchdog can stand down. */
  onReady: () => void;
  /** The map cannot be shown; the line falls back to its text summary. */
  onUnavailable: (cause: LineMapFailure) => void;
}

/** The chunk failing to load is a failure of the map library. */
function RouteLineMapUnavailable({ onUnavailable }: RouteLineMapProps) {
  useEffect(() => onUnavailable('library'), [onUnavailable]);
  return null;
}

const RouteLineMap = lazy<ComponentType<RouteLineMapProps>>(() =>
  import('./RouteLineMap').catch(() => ({ default: RouteLineMapUnavailable })),
);

// ── The cap on mounted line maps, and the page-level stop ─────────────────────────────

/**
 * At most this many line maps are mounted on a page at once (spec FR-3, NFR-8).
 *
 * Each mounted map is one paid route call, one Google map load on the browser key, and one
 * more map a phone has to keep alive. A line takes a slot the first time it is on screen
 * and keeps it while it stays mounted — giving it back on scroll would only ask for the
 * same path again later. A line past the cap shows its text summary and the "five route
 * maps" sentence, and takes a slot if one frees up.
 *
 * The sentence says "five" in words, in both catalogs (`route.lineMapCapped`): raising
 * this number means editing that copy, which `RouteLine.test.tsx` pins.
 */
export const MAX_LINE_MAPS = 5;

const slotHolders = new Set<string>();
const slotListeners = new Set<() => void>();
let slotVersion = 0;

/**
 * Set once the map library has failed on this page — Google's script, the key, its
 * authorisation, the lazy chunk, or a map that never drew within `MAP_WATCHDOG_MS` (the
 * watchdog counts as a library failure: operator ruling, 2026-10-19). From then on no line
 * takes a slot, so no more paths are asked for: each would be a paid call for a map that
 * cannot be drawn. Lines already holding a slot keep it. Cleared by a reload.
 */
let mapLibraryFailed = false;

function notifySlots() {
  slotVersion += 1;
  for (const listener of [...slotListeners]) listener();
}

function subscribeSlots(listener: () => void) {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}

const slotSnapshot = () => slotVersion;

function markMapLibraryFailed() {
  if (mapLibraryFailed) return;
  mapLibraryFailed = true;
  notifySlots();
}

/** Test-only: the module-level state, so a test can check nothing leaked into the next. */
export function lineMapStateForTests() {
  return { slots: slotHolders.size, mapLibraryFailed };
}

/** Test-only: forget every slot and the library failure, as a reload would. */
export function resetLineMapsForTests() {
  slotHolders.clear();
  mapLibraryFailed = false;
  notifySlots();
}

/**
 * Where a line stands for a map slot:
 *   · `held`    — it holds one;
 *   · `capped`  — it wants one and all `MAX_LINE_MAPS` are taken;
 *   · `stopped` — the map library failed on this page, so it will not get one;
 *   · `waiting` — it does not want one yet, or its claim lands in the next effect.
 *
 * `capped` and `waiting` are told apart so the "five maps" sentence never flashes on a
 * line's first render, before its effect has had the chance to take a free slot.
 */
type SlotState = 'held' | 'capped' | 'stopped' | 'waiting';

function useLineMapSlot(wanted: boolean): SlotState {
  const id = useId();
  const version = useSyncExternalStore(subscribeSlots, slotSnapshot, slotSnapshot);
  useEffect(() => {
    // `version` is read so a slot freed elsewhere is offered to a waiting line.
    void version;
    if (!wanted) {
      if (slotHolders.delete(id)) notifySlots();
      return;
    }
    if (!mapLibraryFailed && !slotHolders.has(id) && slotHolders.size < MAX_LINE_MAPS) {
      slotHolders.add(id);
      notifySlots();
    }
  }, [wanted, id, version]);
  useEffect(
    () => () => {
      if (slotHolders.delete(id)) notifySlots();
    },
    [id],
  );
  if (!wanted) return 'waiting';
  if (slotHolders.has(id)) return 'held';
  if (mapLibraryFailed) return 'stopped';
  return slotHolders.size >= MAX_LINE_MAPS ? 'capped' : 'waiting';
}

// ── Change route ──────────────────────────────────────────────────────────────────────

/**
 * What Change route opens the workspace on: the route as stored — its stops, legs, label,
 * position, count and `via` — which the workspace routes with one request and writes back
 * unchanged if nothing is changed (FR-4). A route that cannot be reopened as stored (a
 * stop without a place, legs that do not chain through the stops) opens on its stops.
 */
export function changeRouteSeed(route: RouteValue): WorkspaceSeed {
  const entry = storedRouteEntry(route);
  if (entry) return { kind: 'previous', entry };
  return {
    kind: 'stops',
    stops: route.stops.map((s) => ({
      ...(s.placeId ? { placeId: s.placeId } : {}),
      description: s.description,
    })),
  };
}

/**
 * The stops' place IDs, when there are at least two and every stop has one — the routes a
 * line map can be drawn for; null for any other route.
 */
function routablePlaceIds(route: RouteValue): string[] | null {
  if (route.stops.length < 2) return null;
  const ids = route.stops.map((s) => s.placeId ?? '');
  return ids.every(Boolean) ? ids : null;
}

/**
 * What the line map is keyed by: the stops' place IDs, the place IDs the route passes
 * through (each with its leg), which of Google's routes was chosen and each leg's metres.
 * The path is drawn through the first two, and between the same two stops the server draws
 * the alternative closest to what the line claims — so another route picked between the
 * same stops (398 km instead of 415 km) is a new route to ask for too. Nothing else is in
 * the key: editing another line, or a refetch that returns an equal route, asks nothing.
 */
export function lineMapKey(placeIds: readonly string[], route: RouteValue): string {
  const via = (route.via ?? []).map((v) => [v.leg, v.placeId]);
  const meters = (route.legs ?? []).map((l) => l.meters);
  return JSON.stringify([placeIds, via, route.routeIndex ?? null, meters]);
}

// ── The line's route ──────────────────────────────────────────────────────────────────

export interface RouteLineProps {
  lineItemId: string;
  /** The writer's stored route, as `expenses.report` sent it; null when there is none. */
  route: RouteValue | null;
  /** The line's stored unit: the workspace prices and writes in it. */
  unit: 'KM' | 'MI';
  /** "412.34 km", for the map's text alternative. */
  distanceText: string;
  /** `mileageRoute.status.mapAvailable`: lookup on and a browser key set. */
  mapAvailable: boolean;
  pricing?: MileagePricing & { currency: CurrencyLike };
  disabled?: boolean;
  /** The one write: Use this route updates the line. Rejects with the server's error. */
  onAccept: (payload: AcceptPayload) => Promise<void>;
}

export function RouteLine({
  lineItemId,
  route,
  unit,
  distanceText,
  mapAvailable,
  pricing,
  disabled,
  onAccept,
}: RouteLineProps) {
  const t = useTranslations('expenses');
  const previous = useRecentRoutes();
  const screen = useOnScreen<HTMLDivElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [seed, setSeed] = useState<WorkspaceSeed | null>(null);

  const named = route?.stops.filter((s) => s.description.trim()) ?? [];
  const hasRoute = route !== null && named.length > 0;
  const placeIds = route ? routablePlaceIds(route) : null;

  const ends = hasRoute
    ? t('route.previousRouteEnds', {
        from: route.stops[0]?.description ?? '',
        to: route.stops[route.stops.length - 1]?.description ?? '',
      })
    : null;
  const closed = ends ? (
    <span className="flex min-w-0 flex-col items-start text-left">
      <span className="truncate">{ends}</span>
      {route?.routeLabel && (
        <span className="truncate text-muted-foreground text-xs">
          {t('route.picker.via', { label: route.routeLabel })}
        </span>
      )}
    </span>
  ) : (
    t('route.dropdownPlaceholder')
  );

  return (
    <div ref={screen.ref} className="flex w-full flex-col gap-2">
      {/* With a route the dropdown and its map run the full width of the line (no icons
          beside it, unlike the category field), and the dropdown keeps 16 px from the map:
          the column's 8 px `gap-2` + `mb-2`. */}
      <div className={hasRoute && route ? 'mb-2 w-full' : 'w-full lg:max-w-[480px]'}>
        <RouteSelect
          entries={previous}
          onChangeRoute={hasRoute && route ? () => setSeed(changeRouteSeed(route)) : undefined}
          onNewRoute={() => setSeed({ kind: 'new' })}
          onPrevious={(entry) => setSeed({ kind: 'previous', entry })}
          label={t('route.dropdownLabel')}
          placeholder={closed}
          triggerRef={triggerRef}
          disabled={disabled}
        />
      </div>
      {hasRoute && route && (
        <LineMapOrSummary
          // Keyed by the route — its stops, its pass-through points, the route chosen and
          // its legs (`lineMapKey`): a changed route is a new mount — a new slot claim, a
          // new path call, and never the old route's path or failure.
          key={placeIds ? lineMapKey(placeIds, route) : 'unroutable'}
          lineItemId={lineItemId}
          route={route}
          eligible={mapAvailable && placeIds !== null}
          seen={screen.seen}
          label={t('route.lineMapLabel', {
            from: route.stops[0]?.description ?? '',
            to: route.stops[route.stops.length - 1]?.description ?? '',
            distance: distanceText,
          })}
        />
      )}
      {seed && (
        <RoutePickerModal
          seed={seed}
          unit={unit}
          mapAvailable={mapAvailable}
          pricing={pricing}
          finalFocus={triggerRef}
          onAccept={async (payload) => {
            await onAccept(payload);
            setSeed(null);
          }}
          onClose={() => setSeed(null)}
        />
      )}
    </div>
  );
}

/** The map's box: its size, border and radius, shared by the map and the empty box. */
const MAP_BOX = 'h-[120px] w-full rounded-sm border border-border bg-muted md:h-[140px]';

/**
 * The small map when the line holds a slot; the text summary, the cap sentence or the
 * empty box in every other case (see the file comment's states).
 */
function LineMapOrSummary({
  lineItemId,
  route,
  eligible,
  seen,
  label,
}: {
  lineItemId: string;
  route: RouteValue;
  /** A map can be drawn for this line: a browser key, and every stop a place. */
  eligible: boolean;
  seen: boolean;
  label: string;
}) {
  const t = useTranslations('expenses');
  // Sticky for this mount: a failed line never asks again, and gives its slot back.
  const [failed, setFailed] = useState(false);
  const slot = useLineMapSlot(eligible && seen && !failed);
  const onFailed = useCallback(() => setFailed(true), []);

  if (!eligible || failed || slot === 'stopped') return <RouteSummary value={route} />;
  if (slot === 'held') return <LineMap lineItemId={lineItemId} label={label} onFailed={onFailed} />;
  if (slot === 'capped') {
    return (
      <div className="flex flex-col gap-1">
        <RouteSummary value={route} />
        <p className="text-muted-foreground text-xs">{t('route.lineMapCapped')}</p>
      </div>
    );
  }
  return <div aria-hidden className={MAP_BOX} />;
}

/** The map: its path call, its key read, the lazy chunk, the spinner and the watchdog. */
function LineMap({
  lineItemId,
  label,
  onFailed,
}: {
  lineItemId: string;
  label: string;
  onFailed: () => void;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  // Both start now, in parallel: the path (one paid call, once for this mount) and the key.
  const path = useLineRoutePath({ lineItemId, enabled: !mapLibraryFailed });
  // Read only now — the line holds a slot — and never prefetched.
  // No retry: a refusal falls back to the summary at once.
  const config = trpc.mileageRoute.mapConfig.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const apiKey = config.data?.browserApiKey ?? null;
  const noKey = config.isError || (config.data !== undefined && !apiKey);

  const fail = useCallback(
    (cause: LineMapFailure) => {
      if (cause === 'library') markMapLibraryFailed();
      onFailed();
    },
    [onFailed],
  );
  useEffect(() => {
    if (noKey) fail('library');
  }, [noKey, fail]);
  useEffect(() => {
    if (path.status === 'failed') fail('path');
  }, [path.status, fail]);

  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  // One timer for the whole chain, from this mount to the drawn tiles, so the line is never
  // left spinning. Expiring while the map loads is a library failure (the script stalled);
  // expiring while the path call is still out is this line's failure alone.
  const pathArrived = useRef(false);
  pathArrived.current = path.status === 'ready';
  useEffect(() => {
    if (ready) return;
    const id = setTimeout(() => fail(pathArrived.current ? 'library' : 'path'), MAP_WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [ready, fail]);

  return (
    // A picture of the route, named in words: no gestures, no controls, no tab stop. A
    // small radius and no overlay once drawn, so Google's logo and attribution are never
    // cut (B5). While it loads, the same box is named "Loading the map…" and is busy —
    // no live region, so five maps loading at once announce nothing (UX U1).
    // `inert` on what Google draws inside it: whatever focusable element Google's map
    // renders is out of the tab order and the accessibility tree, so a picture never
    // contains a control (axe `nested-interactive`). Its look is untouched.
    <div
      role="img"
      aria-label={ready ? label : t('route.picker.mapLoading')}
      aria-busy={ready ? undefined : true}
      className={`relative ${MAP_BOX}`}
    >
      <div inert className="h-full w-full">
        {apiKey && path.status === 'ready' && (
          <Suspense fallback={null}>
            <RouteLineMap
              apiKey={apiKey}
              region={config.data?.region ?? null}
              language={locale}
              encodedPolyline={path.encodedPolyline}
              onReady={onReady}
              onUnavailable={fail}
            />
          </Suspense>
        )}
      </div>
      {!ready && <MapSpinner mode="line" />}
    </div>
  );
}

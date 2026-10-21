'use client';

/**
 * "Choose a route" — the route workspace (FR-2, FR-3, FR-5).
 *
 * A fixed 380 px panel on the left (`RouteWorkspacePanel`) and the map on the right
 * (spec FR-6): the Previous routes dropdown (only when there are previous routes), From /
 * stops / To, the routes as a radio group of cards, and a footer with the selected route's
 * distance, its price and **Use this route**. On desktop (768 px and wider) the dialog is
 * 70 % of the viewport wide, capped at 1200 px, and 80 % of its height; the design-system
 * dialog takes that size through `className`. The panel is first in the DOM as well as on
 * screen, so Tab runs inputs → routes → footer → map (NFR-10); CSS `order` would put the
 * picture right and the tab order wrong. The map's column has 48 px of top padding, so the
 * dialog's close button sits on the dialog, above the map, never on its imagery.
 *
 * Routing is automatic. Once every row holds a picked place one `computeRoutes` goes out
 * (`useRouteWorkspace`), and the shortest route by total distance is selected. Nothing is
 * written until Use this route: it hands the caller one payload — distance, unit, and the
 * route with its pass-through place IDs (`via`), never a path or a coordinate — and the
 * caller makes the one write. The
 * button refuses a second press synchronously, before any re-render, so a double click is
 * one write. A write that fails keeps the workspace open with the reason in the footer.
 * Cancel, Escape, the close button and the backdrop write nothing.
 *
 * The map only illustrates the panel. It is drawn when the organisation has a browser key
 * (`mapAvailable`), by `RouteMap.tsx` — the only file here that loads the map library,
 * through `React.lazy`, so neither the library nor Google's script is part of the expense
 * page's first load (NFR-11). The key is read from `mileageRoute.mapConfig` when the
 * workspace opens, never earlier. Any failure — the chunk, the key read, Google's script,
 * a refused key, or nothing drawn within `MAP_WATCHDOG_MS` — takes the map away and the
 * panel says "Map unavailable" (FR-9 1.B); with no browser key at all there is no map and
 * the same line (FR-9). The panel never waits for the map.
 *
 * A stored route (Change route, or a previous route) is reopened as stored (spec FR-4): its
 * stops and points routed by one request, shown as its one card with the stored label,
 * distance and price, its points placed by one `viaLocations`; an unchanged Use this route
 * writes it back exactly. A point Google cannot place is listed with no marker.
 *
 * Pass-through points (FR-4): a drag off the selected route drops one, its marker moves it
 * or removes it, and the panel lists them each with a remove control (NFR-12). A removal
 * is one request; a drop or a move is first turned into a place ID, and nothing else about
 * the points can change until its route lands or it is undone. The map moves no focus, so
 * each change is announced in the live region.
 *
 * Nothing is laid over the map, so Google's logo and attribution stay visible: the map's
 * section has its own small radius and no overlay but its loading spinner (`MapSpinner`
 * `mode="modal"`, the modal's one loading `role="status"`), which ignores the pointer and
 * goes once the tiles are drawn — or with the map, on any failure or the watchdog.
 *
 * On a phone (767 px and narrower, `useIsCompact`) the workspace is a full-screen sheet:
 * the inputs on top, the map below them, and the route list docked BELOW the map behind a
 * handle, in normal flow (FR-2 1.A as amended for Paralegal B5). The map is handed to the
 * panel to place, so it is a sibling before the list and never under it. Which place the
 * map takes is decided in JS because the map RELOCATES (`@/lib/useIsBelowLg` states the
 * rule); the workspace state lives here, above both places, so crossing 768 px redraws the
 * map and keeps every stop, route and point. On the sheet the map takes no browser touch
 * gesture (`touch-action: none`): a swipe on it is Google's pan, and a long-press on the
 * line is not taken over by a scroll of the sheet.
 *
 * Focus (NFR-12): opening on a new route puts it in From (no address search is sent on
 * focus); opening on a loaded route puts it on Use this route, which stays focusable while
 * it waits for its price. Closing returns it to whatever opened the workspace, or to
 * `finalFocus` when the caller knows that control is about to go.
 */

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  useIsCompact,
} from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import {
  type ComponentProps,
  type ComponentType,
  type RefObject,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type CurrencyLike, formatMinor } from '@/lib/format';
import { metersToDistance } from '@/lib/mileageRouteSchema';
import { trpc } from '@/lib/trpc/client';
import { MapSpinner } from './MapSpinner';
import { pointName, RouteWorkspacePanel, routeName } from './RouteWorkspacePanel';
import {
  type AcceptPayload,
  acceptPayload,
  hasRoomForStop,
  type LatLngLiteral,
  type PickerRoute,
  pointMarkers,
  requestKey,
  selectedRoute,
  type WorkspaceSeed,
} from './routeWorkspace';
import { type MileagePricing, useMileageQuote } from './useMileageQuote';
import { useRecentRoutes } from './useRecentRoutes';
import { useRouteWorkspace } from './useRouteWorkspace';

export type { PickerRoute } from './routeWorkspace';

/**
 * What `RouteMap` is given. Declared here, by the component that uses it, so this file
 * never has to import `RouteMap` statically — that one import would put the map library
 * in the expense page's first load.
 */
export interface RouteMapProps {
  /** The browser key from `mileageRoute.mapConfig`. Held in memory only. */
  apiKey: string;
  /** A single country code, or null for none (never a list). */
  region: string | null;
  /** The reader's locale, so Google's labels and controls are in their language. */
  language: string;
  routes: PickerRoute[];
  /** Each route's display name, in `routes` order — the same words as its card. */
  names: string[];
  selected: number | null;
  onSelect: (index: number) => void;
  /** The map has drawn its tiles: the watchdog can stand down. */
  onReady: () => void;
  /** The map cannot be shown; the picker falls back to the cards and the hint. */
  onUnavailable: () => void;
  /**
   * Which stops the routes are for. The map frames the routes once per key, so new stops
   * are framed again and the person's own panning of the same stops is left alone.
   */
  fitKey?: string;
  /**
   * Where each pass-through point is drawn, in route order, as a draggable ring (FR-4);
   * null for a point with no position to draw.
   */
  points?: readonly (LatLngLiteral | null)[];
  /** A drop still being turned into a place ID: a ring that takes no press. */
  pending?: LatLngLiteral | null;
  /** Each point's name, in `points` order: its marker's tooltip, which says a click removes it. */
  pointNames?: readonly string[];
  /**
   * A press on the selected route was dragged and dropped at `at`; `path` is that route's
   * decoded path, which places the point on its leg. Without it, the line takes no press.
   */
  onDropPoint?: (at: LatLngLiteral, path: LatLngLiteral[]) => void;
  /** A point's marker was dragged and dropped at `at`. */
  onMovePoint?: (index: number, at: LatLngLiteral) => void;
  /** A point's marker was clicked. */
  onRemovePoint?: (index: number) => void;
  /** A drag off the line started (the temporary marker is up), or ended without a drop. */
  onDragStart?: () => void;
  onDragCancel?: () => void;
}

/**
 * How long the map gets to draw before the picker gives up on it.
 *
 * Some failures say nothing: a key whose referrer list leaves this site out can leave a
 * grey box with no status change, and a stalled script never settles. Ten seconds is long
 * enough for a slow phone connection and short enough that nobody is left wondering.
 */
export const MAP_WATCHDOG_MS = 10_000;

/** The chunk failing to load is one more way for the map to be unavailable. */
function RouteMapUnavailable({ onUnavailable }: RouteMapProps) {
  useEffect(() => onUnavailable(), [onUnavailable]);
  return null;
}

const RouteMap = lazy<ComponentType<RouteMapProps>>(() =>
  import('./RouteMap').catch(() => ({ default: RouteMapUnavailable })),
);

/**
 * VeloExpense: the kit's Dialog is Radix, not Base UI, so there is no `initialFocus` /
 * `finalFocus` prop. The same two rules are applied through Radix's auto-focus events
 * (below): a ref to the element focus goes to. ExpenseOS's prop also took a function; no
 * caller passes one.
 */
type FinalFocus = RefObject<HTMLElement | null>;

/** The server's sentence from a rejected write; empty when there is none to show. */
function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return '';
}

export interface RoutePickerModalProps {
  /** What the workspace opens on: New route, a set of stops, or a previous route. */
  seed: WorkspaceSeed;
  /** The unit the line is priced in; every distance is stated in it, spelled out. */
  unit: 'KM' | 'MI';
  /**
   * `mileageRoute.status.mapAvailable`: lookup is on and a browser key is set. Without
   * it nothing about the map loads — no chunk, no key read, no Google request.
   */
  mapAvailable?: boolean;
  /** What the footer prices against. Omitted: no price, and accept does not wait for one. */
  pricing?: MileagePricing & { currency: CurrencyLike };
  /**
   * The one write. Resolve when it landed (the caller then closes the workspace); reject
   * with the server's error to keep it open with the reason in the footer.
   */
  onAccept: (payload: AcceptPayload) => Promise<void>;
  /** Cancel, Escape, the close button or the backdrop: nothing is written. */
  onClose: () => void;
  /** Where focus goes on close, when the control that opened the workspace will not stay. */
  finalFocus?: FinalFocus;
}

export function RoutePickerModal({
  seed,
  unit,
  mapAvailable = false,
  pricing,
  onAccept,
  onClose,
  finalFocus,
}: RoutePickerModalProps) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const titleId = useId();
  const [mapFailed, setMapFailed] = useState(false);
  const showMap = mapAvailable && !mapFailed;
  // No map, no markers: a reopened route's points are not looked up (`useRouteWorkspace`).
  const workspace = useRouteWorkspace(seed, unit, showMap);
  const { state } = workspace;
  const previous = useRecentRoutes();
  /** ≤767 px: the phone sheet, with the map between the inputs and the route list. */
  const phone = useIsCompact();
  const onMapUnavailable = useCallback(() => setMapFailed(true), []);
  const names = useMemo(() => state.routes.map((r) => routeName(t, r)), [state.routes, t]);
  const fitKey = state.rows.map((r) => r.stop.placeId ?? '').join('|');

  /**
   * A pick made on the map moves no focus, so a screen reader would hear nothing; a
   * card pick is announced by the radio itself and needs no echo here.
   */
  const [announcement, setAnnouncement] = useState('');
  const { select } = workspace;
  const selectOnMap = useCallback(
    (index: number) => {
      select(index);
      const name = names[state.routes.findIndex((r) => r.index === index)];
      if (name) setAnnouncement(t('route.picker.mapSelected', { route: name }));
    },
    [names, select, state.routes, t],
  );

  const { addPoint, movePoint, removePoint } = workspace;
  const roomForPoint = hasRoomForStop(state);
  const dropPoint = useCallback(
    (at: LatLngLiteral, path: LatLngLiteral[]) => {
      // At the limit the panel says why (role=status); nothing else to announce.
      if (roomForPoint) setAnnouncement(t('route.pointAdded'));
      addPoint(at, path);
    },
    [addPoint, roomForPoint, t],
  );
  const movePointOnMap = useCallback(
    (index: number, at: LatLngLiteral) => {
      setAnnouncement(t('route.pointMoved'));
      movePoint(index, at);
    },
    [movePoint, t],
  );
  const removePointAt = useCallback(
    (index: number) => {
      setAnnouncement(t('route.pointRemoved'));
      removePoint(index);
    },
    [removePoint, t],
  );
  const dragStarted = useCallback(() => setAnnouncement(t('route.dragStarted')), [t]);
  const dragCancelled = useCallback(() => setAnnouncement(t('route.dragCancelled')), [t]);
  const pointNames = useMemo(
    () => state.points.map((p, i) => pointName(t, state.rows, p, i)),
    [state.points, state.rows, t],
  );
  const { markers, pending } = useMemo(
    () => pointMarkers({ points: state.points, converting: state.converting }),
    [state.points, state.converting],
  );
  /** A drop or a move is on its way to a place and a route: no other point change yet. */
  const pointsLocked = state.converting !== null;

  const chosen = selectedRoute(state);
  const payload = acceptPayload(state, unit);
  const quote = useMileageQuote(
    pricing,
    payload && chosen ? metersToDistance(chosen.totalMeters, unit) : null,
    unit,
  );

  /** Set before the write and cleared when it settles: two presses in one frame are one. */
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const priceBlocks = Boolean(pricing) && (quote.refused || quote.pending);
  const canAccept = payload !== null && !priceBlocks && !saving;

  const accept = async () => {
    if (!canAccept || submitting.current || !payload) return;
    submitting.current = true;
    setSaving(true);
    setWriteError(null);
    try {
      await onAccept(payload);
    } catch (e) {
      setWriteError(messageOf(e));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  /**
   * Cancel, Escape, the close button and the backdrop, refused while the write is in
   * flight: closing then would drop the workspace while the line may still be written,
   * with nothing left on screen to say whether it was. The ref, so a press in the same
   * frame as Use this route is refused too.
   */
  const close = () => {
    if (submitting.current) return;
    onClose();
  };

  // Initial focus: From for a new route, Use this route for one that arrives loaded.
  const fromRef = useRef<HTMLInputElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const initialFocus = seed.kind === 'new' ? fromRef : useButton;

  const distanceText = chosen
    ? t('route.picker.footerDistance', {
        distance: metersToDistance(chosen.totalMeters, unit),
        unit,
      })
    : null;
  const priceText =
    quote.amountMinor != null && pricing
      ? formatMinor(BigInt(quote.amountMinor), pricing.currency, locale)
      : pricing && quote.pending
        ? '…'
        : '—';

  const footer = (
    <div className="flex flex-col gap-2 border-border border-t pt-3">
      {/* An `output`: the figure is the result of the selection, and it is announced when
          a new selection changes it. An em dash, never $0.00, while nothing is priced. */}
      <output className="block text-foreground text-sm tabular-nums">
        {distanceText
          ? t('route.picker.footerPrice', { distance: distanceText, price: priceText })
          : '—'}
      </output>
      {pricing && quote.refused && (
        <p role="alert" className="text-destructive text-xs">
          {quote.reason ?? t('route.picker.noPrice')}
        </p>
      )}
      {writeError !== null && (
        <p role="alert" className="text-destructive text-xs">
          {writeError ? `${writeError} ` : ''}
          {t('route.picker.useFailed')}
        </p>
      )}
      <DialogFooter className="gap-2">
        <Button variant="secondary" aria-disabled={saving || undefined} onClick={close}>
          {t('addLine.cancel')}
        </Button>
        <Button
          ref={useButton}
          // `aria-disabled`, not `disabled`: the button keeps its focus (a loaded route
          // opens on it) while it waits for a price, and the handler is what refuses.
          aria-disabled={!canAccept || undefined}
          aria-busy={saving || undefined}
          onClick={accept}
          // The design system's `primary` orange under white text is 2.97:1, short of the
          // 4.5:1 WCAG AA asks of 14 px text; the brand's dark orange is 5.19:1, and 4.82:1
          // on hover (95 % over the dialog's white). Disabled, it is exempt (WCAG 1.4.3).
          className="bg-brand-orange-dark hover:bg-brand-orange-dark/95 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          {saving ? t('route.picker.saving') : t('route.picker.useRoute')}
        </Button>
      </DialogFooter>
    </div>
  );

  const mapPane = showMap ? (
    <MapPane
      routes={state.routes}
      names={names}
      selected={state.selected}
      onSelect={selectOnMap}
      onUnavailable={onMapUnavailable}
      fitKey={fitKey}
      points={markers}
      pending={pending}
      pointNames={pointNames}
      // Nothing changes the route while its write is in flight, nor the points while a
      // drop is being placed.
      {...(saving || pointsLocked
        ? {}
        : {
            onDropPoint: dropPoint,
            onMovePoint: movePointOnMap,
            onRemovePoint: removePointAt,
            onDragStart: dragStarted,
            onDragCancel: dragCancelled,
          })}
    />
  ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(e) => {
          const el = initialFocus.current;
          if (!el) return;
          e.preventDefault();
          el.focus();
        }}
        onCloseAutoFocus={(e) => {
          const el = finalFocus?.current;
          if (!el) return;
          e.preventDefault();
          el.focus();
        }}
        className={cn(
          'flex max-h-[90dvh] flex-col',
          // ≥768 px with a map: the workspace — 70vw capped at 1200 px by 80vh, the fixed
          // 380 px panel first, the map taking whatever it leaves.
          showMap &&
            'md:grid md:h-[80vh] md:max-h-[80vh] md:w-[70vw] md:max-w-[1200px] md:grid-cols-[380px_minmax(0,1fr)] md:gap-0 md:p-0',
          // ≥768 px without a map: the panel alone, at its own width.
          !showMap && 'md:max-w-[428px]',
          // ≤767 px: a full-height sheet, edge to edge, buttons above the safe area.
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:max-w-none',
          'max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0',
          'max-md:p-4 max-md:pb-[max(1rem,var(--safe-area-bottom))]',
        )}
      >
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            // The border only against a map: a lone panel has nothing to its right.
            showMap && 'md:h-full md:border-border md:border-r md:p-6',
          )}
        >
          <RouteWorkspacePanel
            titleId={titleId}
            // VeloExpense: Radix names the dialog by the id IT gives its Title, so the
            // Title keeps that id and the panel's own label points at the text inside.
            title={
              <DialogTitle className="text-left">
                <span id={titleId}>{t('route.picker.title')}</span>
              </DialogTitle>
            }
            previous={previous}
            onPrevious={(entry) => workspace.reset({ kind: 'previous', entry })}
            rows={state.rows}
            onSetStop={workspace.setStop}
            onInsertAfter={workspace.insertAfter}
            onRemove={workspace.removeAt}
            fromRef={fromRef}
            routes={state.routes}
            names={names}
            selected={state.selected}
            onSelect={workspace.select}
            unit={unit}
            badges={showMap}
            phase={state.phase}
            error={state.error}
            storedOnly={state.stored !== null}
            complete={requestKey(state) !== null}
            onRetry={workspace.retry}
            mapUnavailable={!showMap}
            announcement={announcement}
            disabled={saving}
            points={state.points}
            onRemovePoint={removePointAt}
            pointsLocked={pointsLocked}
            // The hint only where it can be acted on: a map, and a selected route drawn on it.
            pointsHint={
              showMap &&
              Boolean(chosen?.encodedPolyline) &&
              (state.phase === 'ready' || state.phase === 'loading')
            }
            pointNotice={state.pointNotice}
            reopenFallback={state.reopenFallback}
            footer={footer}
            map={phone ? mapPane : null}
          />
        </div>
        {/* After the panel in the DOM, so Tab reaches the stops before anything in the map.
            `md:pt-12`: the dialog's close button (top-4 right-4) sits above the map. */}
        {mapPane && !phone && (
          <div className="shrink-0 md:h-full md:min-h-0 md:p-4 md:pt-12">{mapPane}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The map: its key read, the lazy chunk, and the watchdog. Mounted only while the
 * workspace is open with `mapAvailable`, and unmounted on any failure — a broken map is
 * not left on screen beside the hint.
 */
function MapPane({
  onUnavailable,
  ...drawn
}: Omit<RouteMapProps, 'apiKey' | 'region' | 'language' | 'onReady'>) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  /**
   * The key is read when the workspace opens — never prefetched, never rendered on the
   * server, never in a `NEXT_PUBLIC_*` variable (NFR-8). No retry: a refusal falls back
   * to the panel at once rather than after three attempts.
   */
  const config = trpc.mileageRoute.mapConfig.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const apiKey = config.data?.browserApiKey ?? null;
  const noKey = config.isError || (config.data !== undefined && !apiKey);
  useEffect(() => {
    if (noKey) onUnavailable();
  }, [noKey, onUnavailable]);

  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  useEffect(() => {
    if (ready) return;
    const id = setTimeout(onUnavailable, MAP_WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [ready, onUnavailable]);

  return (
    <section
      aria-label={t('route.picker.mapLabel')}
      className={cn(
        // A small radius and no overlay, so Google's logo and attribution are never cut.
        'relative h-60 w-full shrink-0 overflow-hidden rounded-md border border-border bg-muted',
        'md:h-full',
        // ≤767 px: between the inputs and the docked list, taking the height they leave
        // and never under 28dvh. No browser gesture on it, and no text selection or
        // callout under a long-press: a finger on the map is Google's alone (FR-4, TR-18).
        'max-md:h-auto max-md:min-h-[28dvh] max-md:flex-1',
        'max-md:touch-none max-md:select-none max-md:[-webkit-touch-callout:none]',
      )}
    >
      {/* Until the tiles are drawn. A failure or the watchdog unmounts this whole pane
          (the "Map unavailable" fallback), so the spinner is never left turning. */}
      {!ready && <MapSpinner mode="modal" />}
      {apiKey && (
        <Suspense fallback={null}>
          <RouteMap
            apiKey={apiKey}
            region={config.data?.region ?? null}
            language={locale}
            {...drawn}
            onReady={onReady}
            onUnavailable={onUnavailable}
          />
        </Suspense>
      )}
    </section>
  );
}

'use client';

/**
 * The workspace hook: the state in `routeWorkspace.ts`, plus the one thing a reducer
 * cannot do — ask Google (FR-3).
 *
 * No Calculate. The moment every row holds a picked place there is a request key, and a
 * key that has not been asked yet is sent ONCE: `requested` remembers it across renders,
 * and `inFlight` remembers it within one (a StrictMode double effect, or a re-render
 * before the reducer has recorded the send, would otherwise bill it twice). The answer is
 * applied only while its token is still current, so any edit made while it was in flight
 * — which bumps the token — discards it, and the edit's own key is sent instead.
 *
 * `inFlight` holds the key AND the token it was sent under. Keyed on the key alone, an
 * edit that comes back to the key still in flight (a stop row added, then removed before
 * the answer) would be skipped as already sent — while that send's answer, stale under
 * the bumped token, is dropped — and the workspace would sit with every stop picked, no
 * routes and no Try again.
 *
 * A refusal is not retried on its own: the same key stays `requested` until a stop is
 * edited or the person presses Try again (`retry`). Throttling is the one refusal
 * translated here, because the server leaves that code's generic message.
 *
 * A dropped or moved point is first turned into a place ID: while the reducer holds a
 * conversion waiting for its place, ONE `pointToPlace` goes out for it — the conversion's
 * `ticket` is remembered, so a re-render or a StrictMode double effect sends nothing more
 * — with `method: 'geocoding'` once the session has learnt that Routes refuses Roads place
 * IDs. Its answer is applied only while that ticket is still waiting. A refused route for
 * a point is told apart by its refusal KEY (`mileage.viaPlaceRefused`), never by its code,
 * which zod's input refusals share; the reducer decides whether the one Geocoding retry
 * is made. Every Google-calling procedure is a mutation with no retry of its own, so each
 * paid call is one the person caused.
 *
 * A reopened stored route (FR-4) places its points with ONE `viaLocations` for them all,
 * sent only once its route call has drawn it, and only once per `locating` ticket — so a
 * re-render or a StrictMode double effect sends nothing more. Its answer is matched to the
 * points by place ID; a refused call leaves every one of them unplaced (listed, no marker).
 * The locations are display-only: held in this modal session, never sent to Save. They are
 * asked for only while a map is shown (`mapShown`): with no browser key, or once the map
 * has failed or its watchdog fired, nobody would see a marker, so no lookup is paid for —
 * the points stay listed and removable in the panel, with no marker.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { RouteStop } from '@/lib/mileageRouteSchema';
import { trpc } from '@/lib/trpc/client';
import { refusalDataOf } from '@/lib/trpc/refusal';
import {
  type LatLngLiteral,
  type PickerRoute,
  type PointFailure,
  type PointSource,
  requestInput,
  requestKey,
  seedState,
  type ViaLocation,
  type WorkspaceSeed,
  type WorkspaceState,
  workspaceReducer,
} from './routeWorkspace';

/**
 * The refusal keys the workspace branches on, as the server names them in
 * `REFUSAL_KEYS` (`server/refusal.ts`, which is not imported into the browser bundle; a
 * test pins that these are the same strings).
 */
export const MILEAGE_REFUSALS = {
  noRoadNear: 'refusals.mileage.noRoadNear',
  dragApisUnavailable: 'refusals.mileage.dragApisUnavailable',
  viaPlaceRefused: 'refusals.mileage.viaPlaceRefused',
} as const;

type WireError = { message?: string; data?: { code?: string } | null } | null | undefined;

/**
 * Why `pointToPlace` gave no place, from its tRPC error: the code for a throttle, the
 * refusal key for the two outcomes the server names, and the server's sentence for
 * anything else (lookup not configured, a Google failure).
 */
export function pointFailureOf(error: unknown): PointFailure {
  const e = error as WireError;
  if (e?.data?.code === 'TOO_MANY_REQUESTS') return { kind: 'throttled' };
  const refusal = refusalDataOf(error);
  if (refusal?.key === MILEAGE_REFUSALS.noRoadNear) return { kind: 'noRoad' };
  if (refusal?.key === MILEAGE_REFUSALS.dragApisUnavailable) {
    const apis = refusal.params?.apis;
    return { kind: 'apisOff', apis: typeof apis === 'string' ? apis : '' };
  }
  return { kind: 'failed', message: e?.message ?? '' };
}

const newRowId = () => `row-${crypto.randomUUID()}`;
const newPointId = () => `point-${crypto.randomUUID()}`;

/** Enough ids for any seed: the stop cap is 25. */
const idsFor = (seed: WorkspaceSeed) => {
  const count =
    seed.kind === 'new' ? 2 : seed.kind === 'stops' ? seed.stops.length : seed.entry.stops.length;
  return Array.from({ length: Math.max(2, count) }, newRowId);
};

export interface RouteWorkspace {
  state: WorkspaceState;
  setStop: (index: number, stop: RouteStop) => void;
  insertAfter: (index: number) => void;
  removeAt: (index: number) => void;
  select: (index: number) => void;
  /** Replace the whole workspace: New route, or a previous route picked in the panel. */
  reset: (seed: WorkspaceSeed) => void;
  retry: () => void;
  /** A drop on the selected route, with that route's decoded path (FR-4). */
  addPoint: (point: LatLngLiteral, path: readonly LatLngLiteral[]) => void;
  movePoint: (index: number, point: LatLngLiteral) => void;
  removePoint: (index: number) => void;
}

export function useRouteWorkspace(
  seed: WorkspaceSeed,
  unit: 'KM' | 'MI',
  /** A map is on screen to put the points on: without one, `viaLocations` is never sent. */
  mapShown: boolean,
): RouteWorkspace {
  const [state, dispatch] = useReducer(workspaceReducer, seed, (s) => seedState(s, idsFor(s)));
  // A plain `mutateAsync`: every request gets its own promise, and the token decides
  // which answer counts. `gcTime: 0` so no answer (paths included) outlives the modal.
  const compute = trpc.mileageRoute.computeRoutes.useMutation({ gcTime: 0 });
  const send = compute.mutateAsync;
  /** The send this render already made: its key under the token it was made from. */
  const inFlight = useRef<string | null>(null);
  // The same for a point: the snapped location lives in this modal session only.
  const toPlace = trpc.mileageRoute.pointToPlace.useMutation({ gcTime: 0 });
  const place = toPlace.mutateAsync;
  /** The conversion already sent: tickets only grow, so one is never sent twice. */
  const placing = useRef<number | null>(null);
  // The reopened route's points: their locations live in this modal session only.
  const locate = trpc.mileageRoute.viaLocations.useMutation({ gcTime: 0 }).mutateAsync;
  /** The `locating` ticket already sent: tokens only grow, so one is never sent twice. */
  const locatingSent = useRef<number | null>(null);

  const key = requestKey(state);
  const { requested, token } = state;
  useEffect(() => {
    const sending = `${token}|${key}`;
    if (key === null || key === requested || inFlight.current === sending) return;
    const next = token + 1;
    inFlight.current = sending;
    dispatch({ type: 'request', token: next, key });
    send(requestInput(key, unit))
      .then((res: { routes: PickerRoute[] }) =>
        dispatch({ type: 'answer', token: next, routes: res.routes }),
      )
      .catch((e: unknown) =>
        dispatch({
          type: 'failed',
          token: next,
          throttled: (e as WireError)?.data?.code === 'TOO_MANY_REQUESTS',
          message: (e as WireError)?.message ?? '',
          viaRefused: refusalDataOf(e)?.key === MILEAGE_REFUSALS.viaPlaceRefused,
        }),
      )
      .finally(() => {
        if (inFlight.current === sending) inFlight.current = null;
      });
  }, [key, requested, token, unit, send]);

  const waiting = state.converting?.stage === 'converting' ? state.converting : null;
  const ticket = waiting?.ticket ?? null;
  const lat = waiting?.at.lat;
  const lng = waiting?.at.lng;
  const method = waiting?.method;
  useEffect(() => {
    if (ticket === null || lat === undefined || lng === undefined || !method) return;
    if (placing.current === ticket) return;
    placing.current = ticket;
    place({ lat, lng, method })
      .then((res: { placeId: string; location: LatLngLiteral; source: PointSource }) =>
        dispatch({
          type: 'placed',
          ticket,
          placeId: res.placeId,
          location: { lat: res.location.lat, lng: res.location.lng },
          source: res.source,
        }),
      )
      .catch((e: unknown) => dispatch({ type: 'placeFailed', ticket, failure: pointFailureOf(e) }));
  }, [ticket, lat, lng, method, place]);

  const locating = state.locating;
  useEffect(() => {
    if (!locating || !mapShown || locatingSent.current === locating.ticket) return;
    const sent = locating.ticket;
    locatingSent.current = sent;
    locate({ placeIds: locating.placeIds })
      .then((res: { results?: ViaLocation[] } | undefined) =>
        dispatch({
          type: 'located',
          ticket: sent,
          // Only the place ID and where it is: a `reason` decides nothing here.
          results: (res?.results ?? []).map((r) => ({
            placeId: r.placeId,
            location: r.location ? { lat: r.location.lat, lng: r.location.lng } : null,
          })),
        }),
      )
      .catch(() => dispatch({ type: 'locateFailed', ticket: sent }));
  }, [locating, mapShown, locate]);

  const setStop = useCallback(
    (index: number, stop: RouteStop) => dispatch({ type: 'setStop', index, stop }),
    [],
  );
  const insertAfter = useCallback(
    (index: number) => dispatch({ type: 'insertAfter', index, id: newRowId() }),
    [],
  );
  const removeAt = useCallback((index: number) => dispatch({ type: 'removeAt', index }), []);
  const select = useCallback((index: number) => dispatch({ type: 'select', index }), []);
  const reset = useCallback((s: WorkspaceSeed) => {
    inFlight.current = null;
    dispatch({ type: 'reset', seed: s, ids: idsFor(s) });
  }, []);
  const retry = useCallback(() => dispatch({ type: 'retry' }), []);
  // A removal changes the request key once: one request. A drop or a move is one
  // conversion and then one request — two of each when Routes refuses a Roads place ID
  // and Geocoding is asked once more. A refused one (the 25 limit) sends nothing.
  const addPoint = useCallback(
    (point: LatLngLiteral, path: readonly LatLngLiteral[]) =>
      dispatch({ type: 'addPoint', point, path, id: newPointId() }),
    [],
  );
  const movePoint = useCallback(
    (index: number, point: LatLngLiteral) => dispatch({ type: 'movePoint', index, point }),
    [],
  );
  const removePoint = useCallback((index: number) => dispatch({ type: 'removePoint', index }), []);

  return {
    state,
    setStop,
    insertAfter,
    removeAt,
    select,
    reset,
    retry,
    addPoint,
    movePoint,
    removePoint,
  };
}

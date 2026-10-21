/**
 * The route workspace's state, as pure data and one reducer (FR-2, FR-3, FR-5).
 *
 * No React and no map library here, so every rule of the workspace is a table test:
 *
 *   · **A request key** is the stops' place ids and the pass-through points' place ids
 *     with their legs (`via`), and exists only when EVERY row holds a picked place. It
 *     holds no coordinate. The hook sends one `computeRoutes` per new key and none while
 *     the key is missing (FR-3 1.A).
 *   · **The in-flight token.** Every request takes a fresh `token`, and every edit bumps it,
 *     so an answer is applied only when its token is still the current one: an answer for
 *     stops that have since changed describes a route nobody is claiming, and is dropped.
 *   · **The default selection** is the shortest route by total distance; a tie goes to the
 *     first in Google's order (strict `<`, FR-3 4.A).
 *   · **A named-stop edit** (pick, retype, add, remove) clears the routes, the selection
 *     and any pass-through points: they describe stops that no longer exist.
 *   · **Pass-through points** (FR-4, spec FR-2) are added by a drop on the selected route,
 *     moved by a drag of their marker and removed by a click or from the panel. Each gets
 *     its `leg` at the drop (`legForPoint`) and keeps it; the list stays in route order. A
 *     point is held as a Google place ID: a drop or a move is first turned into one
 *     (`converting`, the hook's `pointToPlace`), and only then routed. `at` — where the
 *     marker sits — is Google's location for that place, for this modal session only: it
 *     is never in a request key and never in the accept payload. A point change keeps the
 *     routes drawn until its answers land: any refusal on the way (the conversion's or the
 *     route's), a throttle or no route puts the points and the routes back as they were
 *     and says why (4.A). One drop or move is changed at a time.
 *   · **A Roads place ID Routes will not take** (spec TR-13 check 1). When the route call
 *     for a drop is refused with `viaPlaceRefused` and the newest point came from the Roads
 *     API, the same coordinate is converted ONCE more through Geocoding and routed once
 *     more; a second refusal, or a failed retry, undoes the drop. Never a third attempt.
 *     Once a Geocoding place ID has routed where a Roads one was refused, `roadsRefused`
 *     sends every later drop of the session straight to Geocoding.
 *   · **The 25-stop total** is shared: From, To, the named stops and the points together
 *     never exceed `MAX_ROUTE_STOPS`. At the limit a drop is refused with no request (3.A),
 *     and Add stop adds nothing.
 *   · **A stored route reopened** (spec FR-4: Change route, or a previous route) opens on
 *     its stops AND its `via` points, and is routed by ONE request for both. Its answer is
 *     shown as ONE card that is the stored route: the stored label, position and distance,
 *     drawn with the path of the alternative closest to the stored distance (with `via`
 *     Google gives one; without it, on two stops, it may give three). An unchanged accept
 *     writes the stored value back exactly (`stored`); any change — a stop, a point moved
 *     or removed, a route picked — routes again and writes what that answer says. Only
 *     once the route is drawn are the points placed: ONE `viaLocations` for them all
 *     (`locating`). A point Google cannot place has no marker and is listed `unplaced`, and
 *     the route still runs through it. If the reopening request fails or finds nothing,
 *     the points are dropped and the stops are routed alone, with the reason said (2.A).
 *
 * The accept payload is built here too (`acceptPayload`), so the write's shape — the
 * route and its `via` place IDs, never a coordinate or a path — is one function with one
 * test.
 */

import {
  MAX_ROUTE_STOPS,
  metersToDistance,
  type RouteStop,
  type RouteValue,
  type RouteVia,
  routeChainMeters,
} from '@/lib/mileageRouteSchema';

/** One route as `mileageRoute.computeRoutes` returns it. */
export interface PickerRoute {
  /** Position among the routes offered, 0-based — what the pick is stored as. */
  index: number;
  /** Google's name for the route; null when it gave none ("Route n" is shown). */
  label: string | null;
  totalMeters: number;
  /** "123.45" in the unit the request was made in. */
  distance: string;
  durationSeconds: number | null;
  legs: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  /**
   * The drawn path, Google-encoded. Null when the server could not keep it (over the cap
   * or off the charset): the route still lists, selects and saves, without a map.
   */
  encodedPolyline: string | null;
}

/**
 * One of the person's previous routes, as `mileageRoute.recentRoutes` returns it. Nothing
 * Google drew comes with it: it is reused by its stops.
 */
export interface PreviousRoute {
  stops: { placeId: string; description: string }[];
  legs: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  routeLabel?: string;
  routeIndex?: number;
  routeCount?: number;
  /** The points the route passes through, as stored; absent when it has none. */
  via?: RouteVia[];
  /** The total of the legs, already formatted in each unit. */
  distance: { KM: string; MI: string };
}

/** One input row: From, a stop, or To. The id is the row's identity, never its position. */
export interface WorkspaceRow {
  id: string;
  stop: RouteStop;
}

/**
 *   · `idle` — no complete set of places yet, or nothing asked since the last edit;
 *   · `loading` — one request in flight;
 *   · `ready` — routes on offer (one is selected);
 *   · `empty` — Google found no driving route;
 *   · `throttled` / `failed` — the request was refused.
 */
export type WorkspacePhase = 'idle' | 'loading' | 'ready' | 'empty' | 'throttled' | 'failed';

/** What the workspace opens on. */
export type WorkspaceSeed =
  /** New route: an empty From and To. */
  | { kind: 'new' }
  /** These stops, routed as soon as every one is a picked place. */
  | { kind: 'stops'; stops: RouteStop[] }
  /**
   * A stored route — a previous route, or the line's own (Change route): reopened on its
   * stops and its `via`, and shown as stored while it is unchanged (FR-4).
   */
  | { kind: 'previous'; entry: PreviousRoute };

/**
 * A pass-through point: a Google place ID on the leg it lies on (`stops[leg]` to
 * `stops[leg + 1]`). Only `placeId` and `leg` are ever sent — to the route call and to
 * Save; the rest lives in this modal session alone.
 */
export interface WorkspacePoint {
  /** The point's identity in this session (list keys, a move). Never sent. */
  id: string;
  placeId: string;
  leg: number;
  /** Where its marker sits: Google's location for the place. Never sent, never stored. */
  at?: LatLngLiteral;
  /**
   * A reopened route's point that Google could not place (FR-4 3.A, 3.B): listed, with no
   * marker. The route still passes through it, and it is sent like any other point.
   */
  unplaced?: true;
}

/** One answer of `mileageRoute.viaLocations`: where a place is, or null when unplaced. */
export interface ViaLocation {
  placeId: string;
  location: LatLngLiteral | null;
}

/** Why a reopened route was routed through its stops alone (FR-4 2.A). */
export type ReopenFallback =
  | { kind: 'throttled' }
  /** Google found no route through the stored stops and points. */
  | { kind: 'empty' }
  /** Google would not route through one of the stored points. */
  | { kind: 'viaRefused' }
  | { kind: 'failed'; message: string };

/** How `pointToPlace` is asked: Roads first (`auto`), or Geocoding alone. */
export type PointMethod = 'auto' | 'geocoding';
/** Which API answered `pointToPlace`. */
export type PointSource = 'roads' | 'geocoding';

/**
 * A drop or a move on its way to a place ID and then to its route. While it is
 * `converting`, `pointToPlace` is out for `at`; once `routing`, the point is in `points`
 * and its route call is out. Gone when the route lands or the change is undone.
 */
export interface PointConversion {
  /** The point added (not in `points` until placed) or moved (in `points`). */
  id: string;
  /** Where it was dropped: what `pointToPlace` is asked about. Never stored. */
  at: LatLngLiteral;
  leg: number;
  /** Where an added point goes in `points`; null for a move. */
  insertAt: number | null;
  /** Which conversion an answer is for; any other answer is stale. */
  ticket: number;
  stage: 'converting' | 'routing';
  method: PointMethod;
  /** Which API made the place ID, once one has. */
  source: PointSource | null;
  /** The one Geocoding retry for this drop has been made. */
  retried: boolean;
}

/**
 * Why the last point change was not kept, or a drop refused at the 25-stop limit. Shown
 * beside the points until the next change.
 */
export type PointNotice =
  | { kind: 'maxStops' }
  | { kind: 'throttled' }
  | { kind: 'empty' }
  /** No road and no address near the dropped point (spec FR-2 2.C). */
  | { kind: 'noRoad' }
  /** The server key may use neither API that turns a point into a place (FR-2 2.B). */
  | { kind: 'apisOff'; apis: string }
  /** Google would not route through the point's place ID, and no retry is left. */
  | { kind: 'viaRefused' }
  | { kind: 'failed'; message: string };

/** Why `pointToPlace` gave no place: the notices a conversion can end in. */
export type PointFailure = Extract<
  PointNotice,
  { kind: 'throttled' } | { kind: 'noRoad' } | { kind: 'apisOff' } | { kind: 'failed' }
>;

/** The routes on offer before a point change, until its answer lands. */
interface PointsUndo {
  points: WorkspacePoint[];
  routes: PickerRoute[];
  selected: number | null;
  stored: RouteValue | null;
}

export interface WorkspaceState {
  rows: WorkspaceRow[];
  /** Points the route was dragged through, in route order (sorted by `leg`). */
  points: WorkspacePoint[];
  routes: PickerRoute[];
  /** `PickerRoute.index` of the selected route. */
  selected: number | null;
  phase: WorkspacePhase;
  /** The server's sentence for a `failed` request. */
  error: string | null;
  /** The current request's token; any other answer is stale. */
  token: number;
  /** The key last sent (or seeded): the hook sends a key once. */
  requested: string | null;
  /** The previous route as stored, while it is on offer unchanged; what accept writes. */
  stored: RouteValue | null;
  /** What a refused point change goes back to; null when no point change is waiting. */
  pointsUndo: PointsUndo | null;
  pointNotice: PointNotice | null;
  /** The drop or move being turned into a place ID and routed; null when none is. */
  converting: PointConversion | null;
  /**
   * Routes refused a Roads place ID this session and took a Geocoding one for the same
   * point, so later drops ask Geocoding straight away. Held for the modal session only:
   * never in a payload, never stored.
   */
  roadsRefused: boolean;
  /**
   * The stored route being reopened, until its first route answer lands: that answer is
   * shown as the stored route's one card (FR-4 step 2). Null for any other workspace.
   */
  reopen: PreviousRoute | null;
  /**
   * The reopened route's points waiting for their ONE `viaLocations` (FR-4 step 3), named
   * by `ticket`; the hook sends it once per ticket. Null when nothing is to be placed.
   */
  locating: { ticket: number; placeIds: string[] } | null;
  /** The reopened route could not be drawn with its points: routed by its stops (2.A). */
  reopenFallback: ReopenFallback | null;
}

export type WorkspaceAction =
  | { type: 'reset'; seed: WorkspaceSeed; ids: string[] }
  | { type: 'setStop'; index: number; stop: RouteStop }
  | { type: 'insertAfter'; index: number; id: string }
  | { type: 'removeAt'; index: number }
  | { type: 'request'; token: number; key: string }
  | { type: 'answer'; token: number; routes: PickerRoute[] }
  | {
      type: 'failed';
      token: number;
      throttled: boolean;
      message: string;
      /** The refusal was `mileage.viaPlaceRefused`: Google would not route through a point. */
      viaRefused?: boolean;
    }
  | { type: 'select'; index: number }
  | { type: 'retry' }
  /** A drop on the selected route: `path` is that route's decoded path; `id` names the point. */
  | { type: 'addPoint'; point: LatLngLiteral; path: readonly LatLngLiteral[]; id: string }
  /** A point's marker dragged elsewhere: it keeps its leg and its place in the order. */
  | { type: 'movePoint'; index: number; point: LatLngLiteral }
  | { type: 'removePoint'; index: number }
  /** `pointToPlace` answered for the conversion `ticket`. */
  | {
      type: 'placed';
      ticket: number;
      placeId: string;
      location: LatLngLiteral;
      source: PointSource;
    }
  /** `pointToPlace` was refused or failed for the conversion `ticket`. */
  | { type: 'placeFailed'; ticket: number; failure: PointFailure }
  /** `viaLocations` answered for `ticket`: one entry per distinct place ID. */
  | { type: 'located'; ticket: number; results: readonly ViaLocation[] }
  /** `viaLocations` was refused as a whole: every point it was for is unplaced. */
  | { type: 'locateFailed'; ticket: number };

export interface LatLngLiteral {
  lat: number;
  lng: number;
}

/** A route always has at least an origin and a destination. */
export const MIN_ROWS = 2;

/**
 * The route chosen in the workspace, as the line stores it.
 *
 * A null or blank Google label is OMITTED, never written as `''` or as the "Route n"
 * the card showed: that fallback is display text in the reader's language, and a
 * stored route is a filed fact (the write schema drops an empty label the same way).
 */
export function chosenRoute(
  stops: RouteStop[],
  route: Pick<PickerRoute, 'index' | 'label' | 'legs'>,
  offered: number,
): RouteValue {
  const label = route.label?.trim();
  return {
    stops,
    legs: route.legs.map((l) => ({
      fromPlaceId: l.fromPlaceId,
      toPlaceId: l.toPlaceId,
      meters: l.meters,
    })),
    ...(label ? { routeLabel: label } : {}),
    routeIndex: route.index,
    routeCount: offered,
  };
}

/**
 * A previous route as the line stores it: the stored route, copied field by field, with
 * a label, position or count only when the stored route had one.
 */
export function previousRouteValue(entry: PreviousRoute): RouteValue {
  return {
    stops: entry.stops.map((s) => ({ placeId: s.placeId, description: s.description })),
    legs: entry.legs.map((l) => ({
      fromPlaceId: l.fromPlaceId,
      toPlaceId: l.toPlaceId,
      meters: l.meters,
    })),
    ...(entry.routeLabel ? { routeLabel: entry.routeLabel } : {}),
    ...(entry.routeIndex !== undefined ? { routeIndex: entry.routeIndex } : {}),
    ...(entry.routeCount !== undefined ? { routeCount: entry.routeCount } : {}),
    ...(entry.via && entry.via.length > 0
      ? { via: entry.via.map((v) => ({ placeId: v.placeId, leg: v.leg })) }
      : {}),
  };
}

/**
 * A line's stored route as a previous route, to reopen it as stored (Change route,
 * FR-4); null when it cannot be: a stop without a place, or legs that do not chain
 * through the stops (`routeChainMeters`). The distance is the legs' total.
 */
export function storedRouteEntry(route: RouteValue): PreviousRoute | null {
  if (route.stops.length < MIN_ROWS || !route.legs) return null;
  const meters = routeChainMeters(route.stops, route.legs);
  if (meters === null) return null;
  return {
    // `routeChainMeters` matched every stop's place ID to a leg end, so each one is set.
    stops: route.stops.map((s) => ({ placeId: s.placeId ?? '', description: s.description })),
    legs: route.legs.map((l) => ({
      fromPlaceId: l.fromPlaceId,
      toPlaceId: l.toPlaceId,
      meters: l.meters,
    })),
    ...(route.routeLabel ? { routeLabel: route.routeLabel } : {}),
    ...(route.routeIndex !== undefined ? { routeIndex: route.routeIndex } : {}),
    ...(route.routeCount !== undefined ? { routeCount: route.routeCount } : {}),
    ...(route.via && route.via.length > 0
      ? { via: route.via.map((v) => ({ placeId: v.placeId, leg: v.leg })) }
      : {}),
    distance: { KM: metersToDistance(meters, 'KM'), MI: metersToDistance(meters, 'MI') },
  };
}

/**
 * The answer closest to `meters` by total distance; a tie keeps Google's order. With
 * `via` Google gives one route; without it, on two stops, up to three.
 */
function closestTo(routes: readonly PickerRoute[], meters: number): PickerRoute | undefined {
  let best: PickerRoute | undefined;
  for (const route of routes) {
    if (!best || Math.abs(route.totalMeters - meters) < Math.abs(best.totalMeters - meters)) {
      best = route;
    }
  }
  return best;
}

/**
 * The stored route as its one card: its own label, position and distance, drawn with the
 * path of the answer closest to it. No drive time: none was ever stored, and the answer's
 * is for a route that may not be this one's distance.
 */
function storedCard(entry: PreviousRoute, drawn: PickerRoute): PickerRoute {
  const totalMeters = entry.legs.reduce((sum, l) => sum + l.meters, 0);
  // The answer's distance is in the unit it was asked in; the card's is the stored one's.
  const inMiles = drawn.distance !== metersToDistance(drawn.totalMeters, 'KM');
  return {
    index: entry.routeIndex ?? 0,
    label: entry.routeLabel ?? null,
    totalMeters,
    distance: inMiles ? entry.distance.MI : entry.distance.KM,
    durationSeconds: null,
    legs: entry.legs.map((l) => ({
      fromPlaceId: l.fromPlaceId,
      toPlaceId: l.toPlaceId,
      meters: l.meters,
    })),
    encodedPolyline: drawn.encodedPolyline,
  };
}

/** The `index` of the shortest route by total distance; a tie keeps Google's order. */
export function shortestIndex(routes: readonly PickerRoute[]): number | null {
  let best: PickerRoute | undefined;
  for (const route of routes) {
    if (!best || route.totalMeters < best.totalMeters) best = route;
  }
  return best?.index ?? null;
}

/** Whether the 25-stop total has room for one more stop or point. */
export function hasRoomForStop(state: Pick<WorkspaceState, 'rows' | 'points'>): boolean {
  return state.rows.length + state.points.length < MAX_ROUTE_STOPS;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle metres between two positions. */
function metersBetween(a: LatLngLiteral, b: LatLngLiteral): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far along `path` a position lies, in the path's own metres: the distance from the
 * start to the point of the path nearest to it. Each segment is projected on a local flat
 * plane, which is exact enough at the scale of one road segment.
 */
export function metersAlong(path: readonly LatLngLiteral[], point: LatLngLiteral): number {
  let best = Number.POSITIVE_INFINITY;
  let bestAlong = 0;
  let walked = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as LatLngLiteral;
    const b = path[i + 1] as LatLngLiteral;
    const k = Math.cos(rad((a.lat + b.lat) / 2));
    const bx = (b.lng - a.lng) * k;
    const by = b.lat - a.lat;
    const px = (point.lng - a.lng) * k;
    const py = point.lat - a.lat;
    const len2 = bx * bx + by * by;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * bx + py * by) / len2));
    const off = (px - t * bx) ** 2 + (py - t * by) ** 2;
    const segment = metersBetween(a, b);
    if (off < best) {
      best = off;
      bestAlong = walked + t * segment;
    }
    walked += segment;
  }
  return bestAlong;
}

/**
 * The leg a dropped point lies on (`stops[leg]` to `stops[leg + 1]`), from the selected
 * route's path and its legs (C1). The distance along the path is scaled to the legs'
 * metres — the drawn path and Google's leg lengths are measured differently — and the
 * first leg that reaches that far is the one. A point dropped exactly on a named stop goes
 * to the leg that ends there. Never outside the route: 0 to `legs.length - 1`.
 */
export function legForPoint(
  path: readonly LatLngLiteral[],
  legs: readonly { meters: number }[],
  point: LatLngLiteral,
): number {
  if (legs.length <= 1 || path.length < 2) return 0;
  let pathMeters = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    pathMeters += metersBetween(path[i] as LatLngLiteral, path[i + 1] as LatLngLiteral);
  }
  const legMeters = legs.reduce((sum, l) => sum + l.meters, 0);
  if (pathMeters === 0 || legMeters === 0) return 0;
  const along = (metersAlong(path, point) / pathMeters) * legMeters;
  let reached = 0;
  for (let leg = 0; leg < legs.length; leg++) {
    reached += (legs[leg] as { meters: number }).meters;
    // A centimetre of slack, so a point on a named stop is not pushed on by float error.
    if (along <= reached + 0.01) return leg;
  }
  return legs.length - 1;
}

/**
 * Where a point dropped at `at` on `leg` goes in `points`, in route order: after every
 * point on an earlier leg, and among the points on its own leg by how far along the path
 * each lies. A point with no marker position is taken to lie before it on its leg.
 */
export function insertIndex(
  points: readonly WorkspacePoint[],
  point: { at: LatLngLiteral; leg: number },
  path: readonly LatLngLiteral[],
): number {
  const along = metersAlong(path, point.at);
  const at = points.findIndex(
    (p) => p.leg > point.leg || (p.leg === point.leg && p.at && metersAlong(path, p.at) > along),
  );
  return at === -1 ? points.length : at;
}

/** The points as the route call and Save take them: place ID and leg, nothing else. */
export function viaOf(points: readonly WorkspacePoint[]): RouteVia[] {
  return points.map((p) => ({ placeId: p.placeId, leg: p.leg }));
}

/** The one comparable key for a request, or null unless every row holds a picked place. */
export function keyFor(rows: readonly WorkspaceRow[], points: readonly WorkspacePoint[]) {
  if (rows.length < MIN_ROWS || rows.some((r) => !r.stop.placeId)) return null;
  return JSON.stringify({ placeIds: rows.map((r) => r.stop.placeId), via: viaOf(points) });
}

export const requestKey = (s: WorkspaceState): string | null => keyFor(s.rows, s.points);

/**
 * The `computeRoutes` input for a key. `via` is sent only when there is one: the server
 * defaults it to `[]`, and a route with no points is the same request as before.
 */
export function requestInput(
  key: string,
  unit: 'KM' | 'MI',
): { placeIds: string[]; unit: 'KM' | 'MI'; via?: RouteVia[] } {
  const parsed = JSON.parse(key) as { placeIds: string[]; via: RouteVia[] };
  return {
    placeIds: parsed.placeIds,
    unit,
    ...(parsed.via.length > 0 ? { via: parsed.via } : {}),
  };
}

/**
 * Where the map draws each point, in `points` order, and the drop still being converted.
 * A point being moved is drawn where it was dropped until its place lands, so undoing the
 * move visibly puts it back; null for a point with no position to draw.
 */
export function pointMarkers(state: Pick<WorkspaceState, 'points' | 'converting'>): {
  markers: (LatLngLiteral | null)[];
  pending: LatLngLiteral | null;
} {
  const c = state.converting?.stage === 'converting' ? state.converting : null;
  const markers = state.points.map((p) => (c && c.id === p.id ? c.at : (p.at ?? null)));
  const pending = c && !state.points.some((p) => p.id === c.id) ? c.at : null;
  return { markers, pending };
}

/** The workspace for a seed. `ids` names the rows (at least as many as the seed has). */
export function seedState(
  seed: WorkspaceSeed,
  ids: readonly string[],
  token = 0,
  roadsRefused = false,
): WorkspaceState {
  const idAt = (i: number) => ids[i] ?? `row-${i}`;
  const stops: RouteStop[] =
    seed.kind === 'new'
      ? [{ description: '' }, { description: '' }]
      : seed.kind === 'stops'
        ? seed.stops
        : seed.entry.stops;
  const padded = stops.length >= MIN_ROWS ? stops : [...stops, { description: '' }];
  const rows = padded.map((stop, i) => ({
    id: idAt(i),
    stop: {
      ...(stop.placeId ? { placeId: stop.placeId } : {}),
      description: stop.description,
    },
  }));
  const blank: WorkspaceState = {
    rows,
    points: [],
    routes: [],
    selected: null,
    phase: 'idle',
    error: null,
    token,
    requested: null,
    stored: null,
    pointsUndo: null,
    pointNotice: null,
    converting: null,
    roadsRefused,
    reopen: null,
    locating: null,
    reopenFallback: null,
  };
  if (seed.kind !== 'previous') return blank;
  const entry = seed.entry;
  // Legs that do not chain through the stops are not a route to reopen: its stops alone.
  if (routeChainMeters(entry.stops, entry.legs) === null) return blank;
  return {
    ...blank,
    // No position yet: placed by the one `viaLocations` once the route is drawn.
    points: (entry.via ?? []).map((v, i) => ({ id: `via-${i}`, placeId: v.placeId, leg: v.leg })),
    stored: previousRouteValue(entry),
    reopen: entry,
  };
}

/** A named-stop edit: the rows change, and everything that described the old stops goes. */
function edited(state: WorkspaceState, rows: WorkspaceRow[]): WorkspaceState {
  return {
    ...state,
    rows,
    points: [],
    routes: [],
    selected: null,
    phase: 'idle',
    error: null,
    token: state.token + 1,
    requested: null,
    stored: null,
    pointsUndo: null,
    pointNotice: null,
    converting: null,
    reopen: null,
    locating: null,
    reopenFallback: null,
  };
}

/**
 * The reopened route could not be drawn through its points (FR-4 2.A): the points go,
 * nothing stored is on offer any more, and the stops are routed alone — the key changes,
 * so the hook asks once for it. No point is looked up.
 */
function reopenWithoutPoints(state: WorkspaceState, why: ReopenFallback): WorkspaceState {
  return {
    ...state,
    points: [],
    routes: [],
    selected: null,
    phase: 'idle',
    error: null,
    token: state.token + 1,
    requested: null,
    stored: null,
    reopen: null,
    locating: null,
    reopenFallback: why,
  };
}

/** The reopened route's first answer: the stored route as its one card (FR-4 step 2). */
function reopened(
  state: WorkspaceState,
  entry: PreviousRoute,
  routes: readonly PickerRoute[],
): WorkspaceState {
  const drawn = closestTo(
    routes,
    entry.legs.reduce((sum, l) => sum + l.meters, 0),
  );
  if (!drawn) {
    if (state.points.length > 0) return reopenWithoutPoints(state, { kind: 'empty' });
    return { ...state, phase: 'empty', routes: [], selected: null };
  }
  const card = storedCard(entry, drawn);
  const placeIds = [...new Set(state.points.map((p) => p.placeId))];
  return {
    ...state,
    phase: 'ready',
    routes: [card],
    selected: card.index,
    reopen: null,
    locating: placeIds.length > 0 ? { ticket: state.token, placeIds } : null,
  };
}

/**
 * Where the reopened route's points are, from `viaLocations`: each point still waiting
 * for a position takes its place's, matched by place ID, or is `unplaced`. `found` is
 * null when the call was refused: every one of them is unplaced.
 */
function locatePoints(
  points: readonly WorkspacePoint[],
  found: ReadonlyMap<string, LatLngLiteral | null> | null,
): WorkspacePoint[] {
  return points.map((p) => {
    if (p.at || p.unplaced) return p;
    const at = found?.get(p.placeId);
    return at ? { ...p, at: { lat: at.lat, lng: at.lng } } : { ...p, unplaced: true };
  });
}

function located(
  state: WorkspaceState,
  ticket: number,
  results: readonly ViaLocation[] | null,
): WorkspaceState {
  if (state.locating?.ticket !== ticket) return state;
  const found = results ? new Map(results.map((r) => [r.placeId, r.location])) : null;
  return {
    ...state,
    points: locatePoints(state.points, found),
    // A removal still waiting for its route goes back to points that are placed too.
    pointsUndo: state.pointsUndo
      ? { ...state.pointsUndo, points: locatePoints(state.pointsUndo.points, found) }
      : null,
    locating: null,
  };
}

/**
 * The point change begins: the routes stay drawn while its requests are out, and what was
 * on offer before is kept to go back to. A second change before the first answers keeps
 * the FIRST snapshot: that is the last route an answer confirmed.
 */
function pointsChanging(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    // Loading at once: the routes on screen no longer match the points, so there is
    // nothing to accept until the answer lands.
    phase: 'loading',
    error: null,
    token: state.token + 1,
    pointsUndo: state.pointsUndo ?? {
      points: state.points,
      routes: state.routes,
      selected: state.selected,
      stored: state.stored,
    },
    pointNotice: null,
  };
}

/** New points for the same named stops (a removal): one route request for them. */
function withPoints(state: WorkspaceState, points: WorkspacePoint[]): WorkspaceState {
  return { ...pointsChanging(state), points };
}

/**
 * A drop or a move: first turned into a place ID (the hook's `pointToPlace`), then routed.
 * The points are unchanged until the place lands, so the key is too and nothing is routed
 * yet. The fresh token drops any route answer still out for the points as they were.
 */
function convertPoint(
  state: WorkspaceState,
  point: Pick<PointConversion, 'id' | 'at' | 'leg' | 'insertAt'>,
): WorkspaceState {
  const next = pointsChanging(state);
  return {
    ...next,
    converting: {
      ...point,
      ticket: next.token,
      stage: 'converting',
      method: state.roadsRefused ? 'geocoding' : 'auto',
      source: null,
      retried: false,
    },
  };
}

/** A point change that was not kept: everything as it was, and why (FR-4 4.A). */
function undoPoints(state: WorkspaceState, notice: PointNotice): WorkspaceState {
  const undo = state.pointsUndo as PointsUndo;
  return {
    ...state,
    ...undo,
    phase: 'ready',
    error: null,
    // Already answered: the hook does not send it again.
    requested: keyFor(state.rows, undo.points),
    pointsUndo: null,
    pointNotice: notice,
    converting: null,
  };
}

/**
 * Whether a point can be changed now: a route is drawn and selected, and no drop or move
 * is still on its way to a place and a route.
 */
function pointsEditable(state: WorkspaceState): boolean {
  return (
    (state.phase === 'ready' || state.phase === 'loading') &&
    selectedRoute(state) !== undefined &&
    state.converting === null
  );
}

/** The conversion `ticket` names, while it is still waiting for its place. */
function waitingFor(state: WorkspaceState, ticket: number): PointConversion | null {
  const c = state.converting;
  return c && c.stage === 'converting' && c.ticket === ticket ? c : null;
}

/** The place landed: the point takes it, and its route is asked for (a new key). */
function placePoint(
  state: WorkspaceState,
  c: PointConversion,
  action: Extract<WorkspaceAction, { type: 'placed' }>,
): WorkspaceState {
  const point: WorkspacePoint = {
    id: c.id,
    placeId: action.placeId,
    leg: c.leg,
    at: { lat: action.location.lat, lng: action.location.lng },
  };
  const points = state.points.some((p) => p.id === c.id)
    ? state.points.map((p) => (p.id === c.id ? point : p))
    : [
        ...state.points.slice(0, c.insertAt ?? state.points.length),
        point,
        ...state.points.slice(c.insertAt ?? state.points.length),
      ];
  const undo = state.pointsUndo;
  const key = keyFor(state.rows, points);
  // A move to the same place: the route on offer already goes through it.
  if (undo && key === keyFor(state.rows, undo.points)) {
    return {
      ...state,
      points,
      routes: undo.routes,
      selected: undo.selected,
      stored: undo.stored,
      phase: 'ready',
      requested: key,
      pointsUndo: null,
      converting: null,
      // Reached through the Geocoding retry, Routes has refused a Roads place ID this
      // session all the same: later drops go straight to Geocoding, as after an answer.
      roadsRefused: state.roadsRefused || c.retried,
    };
  }
  const placed = {
    ...state,
    points,
    converting: { ...c, stage: 'routing' as const, source: action.source },
  };
  if (key !== state.requested) return placed;
  // The key was already asked and its answer is gone (stale): the Geocoding retry got the
  // very place Routes refused, so it is refused; anything else is asked again.
  if (c.retried) return undoPoints(state, { kind: 'viaRefused' });
  return { ...placed, requested: null };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'reset':
      // A fresh token, so an answer still in flight for the old route is dropped. What
      // the session learnt about Roads place IDs stays: it is the same server key.
      return seedState(action.seed, action.ids, state.token + 1, state.roadsRefused);
    case 'setStop': {
      if (!state.rows[action.index]) return state;
      const rows = state.rows.map((r, i) => (i === action.index ? { ...r, stop: action.stop } : r));
      return edited(state, rows);
    }
    case 'insertAfter': {
      // The 25 are shared with the points (FR-4 3.A): Add stop is refused the same way.
      if (!hasRoomForStop(state)) return state;
      const rows = [...state.rows];
      rows.splice(action.index + 1, 0, { id: action.id, stop: { description: '' } });
      return edited(state, rows);
    }
    case 'removeAt':
      // Never below two: a route without an origin and a destination isn't one.
      if (state.rows.length <= MIN_ROWS || !state.rows[action.index]) return state;
      return edited(
        state,
        state.rows.filter((_, i) => i !== action.index),
      );
    case 'request':
      return {
        ...state,
        phase: 'loading',
        error: null,
        token: action.token,
        requested: action.key,
      };
    case 'answer': {
      if (action.token !== state.token) return state;
      if (state.reopen) return reopened(state, state.reopen, action.routes);
      if (action.routes.length === 0) {
        if (state.pointsUndo) return undoPoints(state, { kind: 'empty' });
        return { ...state, phase: 'empty', routes: [], selected: null };
      }
      return {
        ...state,
        phase: 'ready',
        routes: action.routes,
        selected: shortestIndex(action.routes),
        stored: null,
        pointsUndo: null,
        pointNotice: null,
        converting: null,
        // A Geocoding place ID routed where a Roads one was refused: Roads place IDs are
        // not worth asking for again this session.
        roadsRefused: state.roadsRefused || state.converting?.retried === true,
      };
    }
    case 'failed': {
      if (action.token !== state.token) return state;
      // The reopened route's own request failed: its stops alone, and why (2.A). Without
      // points that is the same request, so it is today's failure, with Try again.
      if (state.reopen && state.points.length > 0) {
        return reopenWithoutPoints(
          state,
          action.viaRefused
            ? { kind: 'viaRefused' }
            : action.throttled
              ? { kind: 'throttled' }
              : { kind: 'failed', message: action.message },
        );
      }
      if (state.pointsUndo) {
        const c = state.converting;
        // Routes refused the newest point's Roads place ID: the same spot once more,
        // through Geocoding. Only once per drop, and only for a Roads place.
        if (action.viaRefused && c?.stage === 'routing' && c.source === 'roads' && !c.retried) {
          const token = state.token + 1;
          return {
            ...state,
            token,
            converting: {
              ...c,
              ticket: token,
              stage: 'converting',
              method: 'geocoding',
              source: null,
              retried: true,
            },
          };
        }
        return undoPoints(
          state,
          action.viaRefused
            ? { kind: 'viaRefused' }
            : action.throttled
              ? { kind: 'throttled' }
              : { kind: 'failed', message: action.message },
        );
      }
      return {
        ...state,
        phase: action.throttled ? 'throttled' : 'failed',
        error: action.throttled ? null : action.message,
        routes: [],
        selected: null,
      };
    }
    case 'select':
      if (!state.routes.some((r) => r.index === action.index)) return state;
      return { ...state, selected: action.index };
    case 'retry':
      // The same key may be sent again; nothing else changes.
      return { ...state, requested: null };
    case 'addPoint': {
      const route = selectedRoute(state);
      if (!route || !pointsEditable(state)) return state;
      // At the limit: refused, and the key is unchanged, so nothing is sent (3.A).
      if (!hasRoomForStop(state)) return { ...state, pointNotice: { kind: 'maxStops' } };
      const at = { lat: action.point.lat, lng: action.point.lng };
      const leg = legForPoint(action.path, route.legs, at);
      return convertPoint(state, {
        id: action.id,
        at,
        leg,
        insertAt: insertIndex(state.points, { at, leg }, action.path),
      });
    }
    case 'movePoint': {
      const moved = state.points[action.index];
      if (!moved || !pointsEditable(state)) return state;
      return convertPoint(state, {
        id: moved.id,
        at: { lat: action.point.lat, lng: action.point.lng },
        leg: moved.leg,
        insertAt: null,
      });
    }
    case 'removePoint':
      if (!state.points[action.index] || !pointsEditable(state)) return state;
      return withPoints(
        state,
        state.points.filter((_, i) => i !== action.index),
      );
    case 'placed': {
      const c = waitingFor(state, action.ticket);
      return c ? placePoint(state, c, action) : state;
    }
    case 'placeFailed': {
      const c = waitingFor(state, action.ticket);
      if (!c) return state;
      // The retry was for a refused route: unless it was throttled, that refusal is the
      // reason the drop is not kept.
      const notice: PointNotice =
        c.retried && action.failure.kind !== 'throttled' ? { kind: 'viaRefused' } : action.failure;
      return undoPoints(state, notice);
    }
    case 'located':
      return located(state, action.ticket, action.results);
    case 'locateFailed':
      return located(state, action.ticket, null);
  }
}

export function selectedRoute(state: WorkspaceState): PickerRoute | undefined {
  return state.selected === null ? undefined : state.routes.find((r) => r.index === state.selected);
}

/** What Use this route sends, beside the line's category and ids. */
export interface AcceptPayload {
  mileageDistance: string;
  mileageUnit: 'KM' | 'MI';
  mileageRoute: RouteValue;
}

/**
 * The write for the selected route, or null when there is none to accept.
 *
 * The route's stops and legs, and its pass-through points as `via` — each a place ID and
 * its leg, nothing else. Nothing Google drew and no coordinate goes out: not the path,
 * not where a marker sits. No points, no `via` key.
 *
 * A stored route still on offer unchanged is written back exactly as stored — stops,
 * legs, label, position, count and `via` — with its stored distance (FR-4 step 5): the
 * route call and the lookups that drew it are display-only, so the claim never drifts
 * with Google's distances.
 */
export function acceptPayload(state: WorkspaceState, unit: 'KM' | 'MI'): AcceptPayload | null {
  const route = state.phase === 'ready' ? selectedRoute(state) : undefined;
  if (!route) return null;
  return {
    mileageDistance: metersToDistance(route.totalMeters, unit),
    mileageUnit: unit,
    mileageRoute: state.stored ?? newRoute(state, route),
  };
}

/** The route the workspace computed, with its points as `via` when it has any. */
function newRoute(state: WorkspaceState, route: PickerRoute): RouteValue {
  const chosen = chosenRoute(
    state.rows.map((r) => r.stop),
    route,
    state.routes.length,
  );
  const via = viaOf(state.points);
  return via.length > 0 ? { ...chosen, via } : chosen;
}

/**
 * Google Maps Platform access for mileage — address search and driving distance.
 *
 * Everything here runs SERVER-SIDE. The server API key (`apiKey`) never reaches the
 * browser: a key in client JavaScript is a key anyone can lift and spend, and Maps
 * Platform bills per request. The one key that does is a SECOND, separate key
 * (`browserApiKey`) for drawing the route picker's map — referrer-restricted, allowed
 * only "Maps JavaScript API", and under a daily quota cap — and it leaves only through
 * `getBrowserMapsConfig`, which returns nothing else. `server-only` makes a client
 * import of this module a build error rather than a leak.
 *
 * Two APIs, for two different jobs:
 *   · Places Autocomplete (New) turns what someone is typing into address
 *     suggestions. Billed per session, so the caller passes a session token that
 *     ties the keystrokes and the eventual selection into one billable unit.
 *   · Routes API computes the driving distance across the ordered stops, through any
 *     points the traveller dragged the route through — each sent as its place ID, never
 *     as a coordinate. Called once per lookup — never per keystroke or per pointer move.
 *     `computeRoutes` asks for up to three alternatives and their drawn paths so the
 *     traveller can pick one.
 *
 * And three that turn a point into something we may keep (ADR 0020):
 *   · Roads API (`nearestRoad`) turns a point dropped on the route into the place ID of
 *     the road segment under it; Geocoding API (`reverseGeocode`) is the fallback, the
 *     nearest address's place ID. `placeForPoint` is the rule between the two.
 *   · Place Details (`placeLocation`, part of "Places API (New)") turns a stored place ID
 *     back into a point to draw, for the session only.
 *   Roads and Geocoding take the key and the coordinate in the query string, so they go
 *   through `get`, which never logs or throws its URL.
 *
 * ON STORING RESULTS. The Maps Platform terms restrict retaining place data.
 * `placeId` is the durable handle and may be kept; the descriptive fields are
 * cached only as a display convenience on the line item's route snapshot, which
 * a filed expense needs in order to stand as filed. Worth a legal read before
 * this is switched on — see the note on the PR. The drawn path `computeRoutes` returns
 * is never stored: it goes to the writer's browser for the current view only, and a line
 * keeps its stops, legs and the place IDs it passes through (ADR 0020). Snapped points
 * and Place Details locations travel the same way, for the session only.
 *
 * VeloExpense: ported from ExpenseOS (550b2945) for w2-10, and its route-on-a-map
 * changes (67db2e33, #591/#593/#594) in eos batch 5. One difference, in where the keys
 * come from: ExpenseOS reads an installed `google-maps` integration (pasted per tenant on
 * its admin integrations screen) and falls back to the environment. VeloExpense has no
 * such per-tenant installation: Maps Platform is Velotech's account, paid for once, so
 * both keys are platform settings from the environment (Secrets Manager in a deployed
 * stage) — `GOOGLE_PLACES_API_KEY` for the server, `GOOGLE_MAPS_BROWSER_KEY` for the map.
 * With no server key the answer is null and the mileage form takes typed addresses and a
 * typed distance, as ExpenseOS's does; with no browser key there is no map.
 */

import 'server-only';

import { MAX_ROUTE_LABEL, MAX_ROUTES_OFFERED, type RouteVia } from '@/lib/mileageRouteSchema';

/** Defined beside the stored-route schema, which the browser shares; re-exported
 *  here so the route lookup's callers keep one import. */
export { metersToDistance } from '@/lib/mileageRouteSchema';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete';
/** Place Details (New): the place ID is appended, checked and encoded, by `placeLocation`. */
const PLACE_DETAILS_ENDPOINT = 'https://places.googleapis.com/v1/places/';
const ROADS_NEAREST_ENDPOINT = 'https://roads.googleapis.com/v1/nearestRoads';
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/**
 * What `computeRoutes` asks Routes for (TR-12). Routes bills by field mask, so every
 * entry is one somebody reads: the label, the per-leg metres that become the claim,
 * the duration on the card, and the drawn path for the map. `routes.distanceMeters`
 * and `routes.routeLabels` are fetched but not read — the total is summed from the
 * legs so that it equals what is stored, and the labels are an enum of
 * DEFAULT_ROUTE / DEFAULT_ROUTE_ALTERNATE that the position already says.
 */
const ROUTES_FIELD_MASK = [
  'routes.description',
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.distanceMeters',
  'routes.routeLabels',
].join(',');
/** Give up rather than hold a request open — a slow map lookup must not wedge
 *  the expense form. */
const TIMEOUT_MS = 6_000;

/**
 * Longest drawn path handed to the browser, in characters. Google's default polyline
 * quality is `OVERVIEW`, "composed using a small number of points", so a long 25-stop
 * route sits well under this; a path over it is not offered and the map shows none.
 */
const MAX_ENCODED_POLYLINE = 65_536;
/** An encoded polyline is printable ASCII from `?` to `~`, and nothing else. */
const ENCODED_POLYLINE_CHARSET = /^[?-~]+$/;

/** A drawn path as Google encodes it — bounded, one charset — or null. The guard on the
 *  answer before any of it reaches the browser. */
function encodedPolyline(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= MAX_ENCODED_POLYLINE &&
    ENCODED_POLYLINE_CHARSET.test(value)
    ? value
    : null;
}

export interface MapsConfig {
  apiKey: string;
  region?: string;
}

export interface PlaceSuggestion {
  /** The durable handle. Safe to retain. */
  placeId: string;
  /** "Bloor St W, Toronto, ON, Canada" — display only. */
  description: string;
}

export interface RouteLeg {
  fromPlaceId: string;
  toPlaceId: string;
  /** Metres, as returned. */
  meters: number;
}

/** One of the routes Google offered for the same ordered stops. */
export interface RouteOption {
  /** Position among the routes OFFERED (after any unusable one is dropped), 0-based —
   *  what the traveller's pick is stored as, so it is always below the count offered. */
  index: number;
  /** Google's own name for the route ("Hwy 401"), one line, at most
   *  `MAX_ROUTE_LABEL`. Null when Google gave none: the picker shows "Route n". */
  label: string | null;
  /** Sum of the legs, so the figure picked is the figure stored. */
  totalMeters: number;
  /** Driving time ignoring traffic, in whole seconds; null when Google gave none. */
  durationSeconds: number | null;
  legs: RouteLeg[];
  /** The drawn path, for the map on the current view only — never stored. Null when
   *  Google sent none, or one over `MAX_ENCODED_POLYLINE` or outside the polyline
   *  charset: such a path is not handed to the browser. Never logged. */
  encodedPolyline: string | null;
}

/** VeloExpense: kept for ExpenseOS's call sites (`getMapsConfig(ctx.db)`); not read. */
type Db = unknown;

/**
 * The active installation's config, else the environment, else null.
 *
 * Null is a first-class answer, not an error: the mileage form falls back to
 * typed addresses and a manually entered distance, so the feature ships before
 * anyone has procured a key.
 *
 * Precedence is installation-then-env, the same order and for the same reasons as
 * `resolveAnthropicConfig` in @expenseos/db. The installation is the source of truth
 * because rotating the key in the admin UI has to beat whatever a stale task definition
 * exported, or saving there would appear to do nothing. The environment stays a FALLBACK
 * rather than the mechanism because a developer and CI have a GOOGLE_PLACES_API_KEY and
 * no installation row — and without the fallback the city picker reports itself
 * unavailable there while offering no clue why.
 */
export async function getMapsConfig(
  _db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MapsConfig | null> {
  // VeloExpense: no per-tenant installation to read — see the file header.

  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return null;
  // No region alongside it. Restricting results is an admin decision that belongs on the
  // installation next to the key, and a restriction nobody asked for is how every city
  // outside one country becomes unfindable.
  return { apiKey };
}

/** What the browser may hold to draw the route picker's map. */
export interface BrowserMapsConfig {
  /** The referrer-restricted, Maps-JavaScript-only key. Never the server key. */
  browserApiKey: string;
  /** One CLDR region code ("CA") to bias the map, or null — see `mapRegion`. */
  region: string | null;
}

/**
 * The browser key, else null.
 *
 * Deliberately NOT `getMapsConfig` with a different field. It reads ONE variable,
 * `GOOGLE_MAPS_BROWSER_KEY`, and never `GOOGLE_PLACES_API_KEY`: that variable is a SERVER
 * key — unrestricted or IP-restricted — and handing it to a browser is the one leak this
 * whole split exists to prevent.
 *
 * A browser key equal to the server key is refused (null) rather than returned: one key
 * set in both variables would otherwise publish the unrestricted server key to every
 * signed-in browser.
 *
 * The result is built field by field, so nothing else can ride along to the browser.
 *
 * VeloExpense (eos batch 5): ExpenseOS reads the browser key off the tenant's
 * `google-maps` installation and takes no environment. VeloExpense's keys are platform
 * settings (see the file header), so this reads the environment — a server variable,
 * never a `NEXT_PUBLIC_*` one (mapsKeyBoundary.test.ts), served only by the signed-in
 * `mileageRoute.mapConfig` read. `GOOGLE_MAPS_REGION` is the optional country bias.
 */
export async function getBrowserMapsConfig(
  _db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserMapsConfig | null> {
  const browserApiKey = env.GOOGLE_MAPS_BROWSER_KEY?.trim();
  if (!browserApiKey) return null;
  if (browserApiKey === env.GOOGLE_PLACES_API_KEY?.trim()) return null;
  return { browserApiKey, region: mapRegion(env.GOOGLE_MAPS_REGION) };
}

/**
 * The installation's country restriction as the map's `region`: the code when exactly
 * one is configured, otherwise null.
 *
 * The admin field holds a LIST ("CA, US") because it restricts address search, while
 * the map takes a single code that biases it (frontend slice, `APIProvider.region`).
 * Picking the first of several would bias every map toward whichever country the admin
 * happened to type first, so several codes means no bias at all.
 */
function mapRegion(region: string | undefined): string | null {
  const codes = regionCodes(region);
  return codes.length === 1 ? codes[0].toUpperCase() : null;
}

/**
 * What to actually DO about a Google rejection.
 *
 * Google's messages are accurate and unactionable: "Requests to this API ...
 * method google.maps.places.v1.Places.AutocompletePlaces are blocked" is precisely
 * true and tells you nothing about which of four console settings to change. Every
 * one of these was diagnosed by hand once; the point of putting them here is that
 * nobody has to do it twice.
 *
 * Matched on the message text rather than a status code because Google reuses 403
 * for four unrelated causes, and the wording is the only thing that separates them.
 */
export function mapsRemedy(status: number, body: string): string | null {
  const text = `${body}`.toLowerCase();

  // API_KEY_SERVICE_BLOCKED — the key is real, the project just won't let it call
  // this method. Almost always the key's "API restrictions" list.
  if (text.includes('are blocked') && text.includes('method')) {
    return (
      'The key is valid but not allowed to call this API. In Google Cloud Console → ' +
      'Credentials → this key → API restrictions, add "Places API (New)" and "Routes API" ' +
      '(and "Roads API" and "Geocoding API", which dragging a route needs). ' +
      'Note that "Places API" and "Places API (New)" are SEPARATE entries — a key allowed ' +
      'only the legacy one is blocked for autocomplete.'
    );
  }
  // SERVICE_DISABLED — the API was never turned on for the project.
  if (
    text.includes('has not been used in project') ||
    text.includes('service_disabled') ||
    // Geocoding's own wording for an API the project has not enabled.
    text.includes('not authorized to use this api')
  ) {
    return (
      'Enable "Places API (New)" and "Routes API" on the project (APIs & Services → ' +
      'Enabled APIs), and "Roads API" and "Geocoding API" for dragging a route.'
    );
  }
  // Application restrictions. A server-side call sends no referrer, so a
  // referrer-restricted key can never work here.
  if (text.includes('referer') || text.includes('referrer')) {
    return (
      'This key is restricted by HTTP referrer, which a server-side call cannot satisfy — ' +
      'these requests are made from the container, not the browser. Set Application ' +
      "restrictions to None, or to the egress IP (on AWS, the NAT gateway's Elastic IP)."
    );
  }
  if (text.includes('ip address') || text.includes('ip_address')) {
    return (
      'This key is restricted to specific IP addresses and the caller is not one of them. ' +
      "On AWS the address to allow is the NAT gateway's Elastic IP — tasks egress through " +
      'it, not from their own address.'
    );
  }
  if (
    text.includes('api key not valid') ||
    text.includes('api_key_invalid') ||
    // Geocoding's wording for the same thing.
    text.includes('provided api key is invalid')
  ) {
    return 'The key itself was rejected — check it was pasted whole and belongs to this project.';
  }
  if (text.includes('billing')) {
    return 'Billing is not enabled on the project. Maps Platform bills per request and refuses to serve without it.';
  }
  if (status === 429 || text.includes('quota')) {
    return 'The project is over its quota for this API. Raise the quota or wait for the window to reset.';
  }
  return null;
}

/**
 * A Google failure as text that is safe to show an admin or write to a log.
 *
 * Google's error bodies are verbose and echo the request. Keep the useful part and
 * never let a key fragment or a location through: anything key-shaped — a long unbroken
 * run of key characters — and any decimal coordinate are redacted (see `redactMapsText`).
 * The length limit is generous enough to keep a readable message.
 *
 * Lives beside the client rather than in one caller so every path that turns a Google
 * failure into words (Test Connection, the route lookup) redacts the same way.
 */
export function mapsError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return redactMapsText(raw).slice(0, 600);
}

/**
 * Google text with the two things it must never carry onward removed:
 *   · anything key-shaped (a long unbroken run of key characters). Bounded to tokens
 *     with no spaces so it cannot swallow the remedy sentence.
 *   · any decimal coordinate (`43.6532101`, `-79.383`): Google echoes the request in its
 *     error bodies, and a route request carries the points a traveller dragged their
 *     route through. Three or more decimals is street-level precision; a version number
 *     or a count in Google's wording has fewer, and so does a two-decimal coordinate
 *     (`-79.38`, about 1 km), which is left as it is.
 */
export function redactMapsText(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9_-]{30,}\b/g, '<redacted>')
    .replace(/-?\d{1,3}\.\d{3,}/g, '<redacted>');
}

/**
 * A non-2xx answer from Google, typed so a caller can decide what it means without
 * parsing the message: `httpStatus` is the HTTP status, `googleStatus` Google's own
 * `error.status` enum (`INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, …) when the
 * body carried one. The message reads exactly as it always did — "Google Maps <status>:
 * <reason> — <remedy>" — with the reason redacted, so `mapsError` and every caller that
 * shows it are unaffected.
 */
export class GoogleMapsHttpError extends Error {
  readonly httpStatus: number;
  readonly googleStatus: string | null;

  constructor(message: string, httpStatus: number, googleStatus: string | null) {
    super(message);
    this.name = 'GoogleMapsHttpError';
    this.httpStatus = httpStatus;
    this.googleStatus = googleStatus;
  }
}

/** Google's `error.status` enum from an error body, or null. Only an UPPER_SNAKE token is
 *  taken, so nothing the request echoed can ride along into a log line. */
export function googleStatus(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { status?: unknown } };
    const status = parsed.error?.status;
    return typeof status === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(status) ? status : null;
  } catch {
    return null;
  }
}

/**
 * The one transport to Google. Exported for its own tests only; every caller goes through
 * `searchPlaces`, `searchCities` or `computeRoutes`.
 *
 * A rejection is logged as the endpoint, the HTTP status and Google's status enum — never
 * the request body and never the raw response. The body of a route request carries the
 * traveller's chosen points, and Google's error body echoes the request back, so either
 * would put a location in the server log. The reason and the remedy travel in the thrown
 * error, redacted, for the caller to show.
 */
export async function post(url: string, apiKey: string, fieldMask: string | null, body: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Routes REQUIRES a field mask and bills by what you ask for, so asking
        // for less costs less. Autocomplete (New) does NOT take one — it returns
        // a fixed prediction shape — and sending the header there is rejected.
        // Hence nullable rather than always-on.
        ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const status = googleStatus(text);
      // The endpoint is a constant and the key rides in a header, so this line names
      // what failed and how without anything the caller sent.
      console.error(
        `[googleMaps] ${url} rejected: HTTP ${res.status}${status ? ` · ${status}` : ''}`,
      );
      // Google's reason, then what to do about it. The reason alone is what sent
      // somebody into the console guessing which of four settings was wrong.
      const reason = redactMapsText(googleMessage(text) ?? text.slice(0, 300));
      const remedy = mapsRemedy(res.status, text);
      throw new GoogleMapsHttpError(
        `Google Maps ${res.status}: ${reason}${remedy ? ` — ${remedy}` : ''}`,
        res.status,
        status,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The GET transport, for the three Google APIs that take their input in the URL: Roads
 * and Geocoding (the coordinate, and the key as `key=`) and Place Details (the place ID).
 * Exported for its own tests only.
 *
 * It never logs its URL and never throws it. A rejection is logged as the caller's
 * constant `label`, the HTTP status and Google's status enum; the reason travels in the
 * thrown `GoogleMapsHttpError`, redacted, exactly as `post` does. A failure with no HTTP
 * answer (timeout, network) is rethrown as a new error naming only the label and the
 * error's type, with no `cause`: fetch's own error can carry the URL, and with it a
 * dropped location and the server key.
 *
 * `apiKey` goes in the `X-Goog-Api-Key` header when given (Place Details); Roads and
 * Geocoding are called with the documented `key=` parameter instead, already in `url`.
 */
export async function get(
  label: string,
  url: string,
  opts: { apiKey?: string; fieldMask?: string } = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          ...(opts.apiKey ? { 'X-Goog-Api-Key': opts.apiKey } : {}),
          ...(opts.fieldMask ? { 'X-Goog-FieldMask': opts.fieldMask } : {}),
        },
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(`Google Maps ${label} request failed: ${errorName(e)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const status = googleStatus(text);
      console.error(
        `[googleMaps] ${label} rejected: HTTP ${res.status}${status ? ` · ${status}` : ''}`,
      );
      const reason = redactMapsText(googleMessage(text) ?? text.slice(0, 300));
      const remedy = mapsRemedy(res.status, text);
      throw new GoogleMapsHttpError(
        `Google Maps ${res.status}: ${reason}${remedy ? ` — ${remedy}` : ''}`,
        res.status,
        status,
      );
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Google Maps ${label} answer could not be read: ${errorName(e)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** An error's type name and nothing else: its message may carry what was sent. */
function errorName(e: unknown): string {
  return e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
}

/** A point on the map, in degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** A Google place ID for a point, and where Google puts that place. The location is for
 *  drawing in the current session only — never stored, never logged. */
export interface PointPlace {
  placeId: string;
  location: LatLng;
}

/**
 * A place ID that may go into a Google URL: Google's URL-safe base64 alphabet, 1–500
 * characters. Checked BEFORE any URL is built, so a crafted `..` or `/` cannot steer a
 * server-key request to a path we did not choose (security C1). Applied to IDs Google
 * returns too, so only an ID that could be sent back is ever handed on.
 */
const URL_SAFE_PLACE_ID = /^[A-Za-z0-9_-]{1,500}$/;

export function isUrlSafePlaceId(value: unknown): value is string {
  return typeof value === 'string' && URL_SAFE_PLACE_ID.test(value);
}

function latLngOf(lat: unknown, lng: unknown): LatLng | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** A coordinate as Google's query string wants it: plain decimal (never `1e-7`), to the
 *  centimetre. */
function coordinate(value: number): string {
  return value.toFixed(7);
}

/** Great-circle distance in metres — used only to rank candidate points. */
function metresBetween(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A refusal of the KEY for this API — disabled, blocked by the key's API restrictions,
 * not valid, or no billing — as opposed to a failure that may pass (429, 5xx, timeout).
 * Only a refusal falls back to another API (security C6): falling back on a transient
 * failure would double the calls during a Google incident.
 */
export function isKeyRefusal(e: unknown): boolean {
  if (!(e instanceof GoogleMapsHttpError)) return false;
  if (e.httpStatus === 401 || e.httpStatus === 403) return true;
  if (
    e.googleStatus === 'PERMISSION_DENIED' ||
    e.googleStatus === 'UNAUTHENTICATED' ||
    e.googleStatus === 'REQUEST_DENIED'
  ) {
    return true;
  }
  return e.httpStatus === 400 && /api key not valid/i.test(e.message);
}

/**
 * Google's own word that a place in a route request does not exist. Matched by cause — the
 * typed status `post()` carries — never by "any 4xx": a 400 or 403 about the key is the
 * whole organisation's problem, not the answer "this route has no path". *Unverified*:
 * that the Routes API answers a stale place ID with HTTP 404 and status `NOT_FOUND` is
 * assumed, not checked against Google's documentation or a live call.
 */
export function isUnroutableWaypoint(err: unknown): boolean {
  return (
    err instanceof GoogleMapsHttpError && err.httpStatus === 404 && err.googleStatus === 'NOT_FOUND'
  );
}

/**
 * Google's refusal of a place ID it was asked to route THROUGH: HTTP 400 or 404 with
 * status `INVALID_ARGUMENT` or `NOT_FOUND`, and no key cause (`isKeyRefusal`). The caller
 * reads it so only when the request carried at least one `via` point (spec TR-13 check 1:
 * whether Routes takes a Roads road-segment ID as a waypoint is unverified until a live
 * check). *Unverified*: which status Routes answers for such an ID. The match is
 * deliberately broad — a stale named stop answers the same way — and a misreading costs
 * the modal one Geocoding retry and one more route call, never a wrong route.
 */
export function isRefusedViaPlace(err: unknown): boolean {
  if (!(err instanceof GoogleMapsHttpError) || isKeyRefusal(err)) return false;
  return (
    (err.httpStatus === 400 || err.httpStatus === 404) &&
    (err.googleStatus === 'INVALID_ARGUMENT' || err.googleStatus === 'NOT_FOUND')
  );
}

/**
 * The road segment nearest to `point`, as a Roads API place ID and its snapped point, or
 * null when Roads found no road near it.
 *
 * `nearestRoads` rather than `snapToRoads`: it is the endpoint Google documents for
 * points that "don't need to be part of a continuous path", which a single drop is. It
 * may answer several snapped points for one input, so the one nearest the drop is taken
 * (ties to the first), never simply the first. A point whose place ID is not URL-safe, or
 * whose location is not a coordinate, is skipped.
 */
export async function nearestRoad(cfg: MapsConfig, point: LatLng): Promise<PointPlace | null> {
  const url =
    `${ROADS_NEAREST_ENDPOINT}?points=${coordinate(point.lat)},${coordinate(point.lng)}` +
    `&key=${encodeURIComponent(cfg.apiKey)}`;
  const json = await get('Roads nearestRoads', url);
  const snapped = Array.isArray(json.snappedPoints)
    ? (json.snappedPoints as Array<{
        placeId?: unknown;
        location?: { latitude?: unknown; longitude?: unknown };
      }>)
    : [];
  let best: PointPlace | null = null;
  let bestMetres = Number.POSITIVE_INFINITY;
  for (const candidate of snapped) {
    const location = latLngOf(candidate?.location?.latitude, candidate?.location?.longitude);
    if (!location || !isUrlSafePlaceId(candidate.placeId)) continue;
    const metres = metresBetween(point, location);
    if (metres < bestMetres) {
      best = { placeId: candidate.placeId, location };
      bestMetres = metres;
    }
  }
  return best;
}

/**
 * Geocoding's body status as the error `get` would have thrown for an HTTP refusal, so
 * one classifier (`isKeyRefusal`) covers both APIs. Geocoding answers HTTP 200 and puts
 * the refusal in `status`; the status is taken only when it is an enum token, and the
 * message is redacted.
 */
function geocodingStatusError(status: string | null, message: unknown): GoogleMapsHttpError {
  const token = status && /^[A-Z][A-Z_]{0,63}$/.test(status) ? status : null;
  const httpStatus =
    token === 'REQUEST_DENIED' || token === 'OVER_DAILY_LIMIT'
      ? 403
      : token === 'OVER_QUERY_LIMIT'
        ? 429
        : 502;
  const text = typeof message === 'string' ? message.slice(0, 300) : '';
  console.error(`[googleMaps] Geocoding reverse rejected: status ${token ?? 'unknown'}`);
  const remedy = mapsRemedy(httpStatus, text);
  return new GoogleMapsHttpError(
    `Google Maps ${httpStatus}: ${redactMapsText(text) || (token ?? 'unknown status')}${
      remedy ? ` — ${remedy}` : ''
    }`,
    httpStatus,
    token,
  );
}

/**
 * The nearest street address (or, failing one, road) to `point`, as a Geocoding place ID
 * and the place's own location, or null when Geocoding has nothing there. The fallback
 * when Roads cannot be used. The location is the address's, not the drop's: it is where
 * the route will actually pass, and where Place Details will put the point on reopen.
 */
export async function reverseGeocode(cfg: MapsConfig, point: LatLng): Promise<PointPlace | null> {
  const url =
    `${GEOCODE_ENDPOINT}?latlng=${coordinate(point.lat)},${coordinate(point.lng)}` +
    `&result_type=street_address|route&key=${encodeURIComponent(cfg.apiKey)}`;
  const json = await get('Geocoding reverse', url);
  const status = typeof json.status === 'string' ? json.status : null;
  if (status === 'ZERO_RESULTS') return null;
  if (status !== 'OK') throw geocodingStatusError(status, json.error_message);
  const results = Array.isArray(json.results)
    ? (json.results as Array<{
        place_id?: unknown;
        geometry?: { location?: { lat?: unknown; lng?: unknown } };
      }>)
    : [];
  for (const result of results) {
    const location = latLngOf(result?.geometry?.location?.lat, result?.geometry?.location?.lng);
    if (location && isUrlSafePlaceId(result.place_id)) {
      return { placeId: result.place_id, location };
    }
  }
  return null;
}

/**
 * Where Google puts a place, from Place Details (Places API New) with a field mask of the
 * location alone, or null when the place cannot be placed.
 *
 * Null — never a throw — when the ID is not URL-safe (no request is made at all, C1), when
 * Google answers without a location, and when Google does not know the ID (404, or 400
 * `INVALID_ARGUMENT` / `NOT_FOUND` that is not a key problem). Whether Place Details
 * resolves a Roads road-segment ID is unverified until checked against a live key
 * (spec TR-13 check 2); this handles both answers. A key refusal, a quota or server
 * failure, or a timeout is thrown for the caller to report.
 */
export async function placeLocation(cfg: MapsConfig, placeId: string): Promise<LatLng | null> {
  if (!isUrlSafePlaceId(placeId)) return null;
  let json: Record<string, unknown>;
  try {
    json = await get('Places details', `${PLACE_DETAILS_ENDPOINT}${encodeURIComponent(placeId)}`, {
      apiKey: cfg.apiKey,
      fieldMask: 'location',
    });
  } catch (e) {
    if (isUnknownPlace(e)) return null;
    throw e;
  }
  const location = json.location as { latitude?: unknown; longitude?: unknown } | undefined;
  return latLngOf(location?.latitude, location?.longitude);
}

/** Google does not know this place ID — as opposed to refusing the key or failing. */
function isUnknownPlace(e: unknown): boolean {
  if (!(e instanceof GoogleMapsHttpError) || isKeyRefusal(e)) return false;
  if (e.httpStatus === 404) return true;
  return (
    e.httpStatus === 400 &&
    (e.googleStatus === 'INVALID_ARGUMENT' || e.googleStatus === 'NOT_FOUND')
  );
}

/** The two APIs a dropped point can be turned into a place with, by their console names. */
export type DragApi = 'Roads API' | 'Geocoding API';

/** What became of a dropped point. */
export type PointPlaceOutcome =
  | ({ kind: 'found'; source: 'roads' | 'geocoding' } & PointPlace)
  | { kind: 'none' }
  | { kind: 'refused'; apis: DragApi[] };

/**
 * A dropped point as a place ID: Roads first, Geocoding when Roads cannot help.
 *
 *   · `method: 'auto'` asks Roads. A road found is the answer. Roads finding no road, or
 *     refusing the key, falls back to Geocoding. A Roads failure that may pass (429, 5xx,
 *     timeout) is thrown, never fallen back from (security C6).
 *   · `method: 'geocoding'` skips Roads — the modal's retry when Routes refused a Roads
 *     road-segment ID as a waypoint (spec TR-13 check 1), and every later drop of that
 *     modal session.
 *
 * Geocoding then decides: an address is the answer; nothing there is `none`; a key
 * refusal is `refused`, naming every API that refused (both when Roads refused too), or
 * `none` when Roads answered and simply found no road; any other failure is thrown.
 *
 * At most two Google requests. The clients are a parameter so both outcomes of each
 * check can be proven with stubs.
 */
export async function placeForPoint(
  cfg: MapsConfig,
  point: LatLng,
  method: 'auto' | 'geocoding',
  clients: {
    nearestRoad: typeof nearestRoad;
    reverseGeocode: typeof reverseGeocode;
  } = { nearestRoad, reverseGeocode },
): Promise<PointPlaceOutcome> {
  let roadsRefused = false;
  if (method === 'auto') {
    try {
      const road = await clients.nearestRoad(cfg, point);
      if (road) return { kind: 'found', source: 'roads', ...road };
    } catch (e) {
      if (!isKeyRefusal(e)) throw e;
      roadsRefused = true;
    }
  }
  try {
    const address = await clients.reverseGeocode(cfg, point);
    return address ? { kind: 'found', source: 'geocoding', ...address } : { kind: 'none' };
  } catch (e) {
    if (!isKeyRefusal(e)) throw e;
    if (method === 'geocoding') return { kind: 'refused', apis: ['Geocoding API'] };
    return roadsRefused
      ? { kind: 'refused', apis: ['Roads API', 'Geocoding API'] }
      : { kind: 'none' };
  }
}

/**
 * Address suggestions for a partial query.
 *
 * `sessionToken` should be a UUID the client keeps for one "pick an address"
 * interaction and discards after the selection — that's what makes the whole
 * sequence bill as one autocomplete session instead of per keystroke.
 */
export async function searchPlaces(
  cfg: MapsConfig,
  query: string,
  sessionToken: string,
): Promise<PlaceSuggestion[]> {
  const regions = regionCodes(cfg.region);
  const json = await post(PLACES_ENDPOINT, cfg.apiKey, null, {
    input: query,
    sessionToken,
    // `includedRegionCodes` RESTRICTS — it does not merely bias. One code here
    // means addresses anywhere else return nothing at all, which is why this
    // takes a LIST: a company with Canadian and US employees needs both, and a
    // lone "CA" silently made every US address unfindable. Empty = no restriction.
    ...(regions.length > 0 ? { includedRegionCodes: regions } : {}),
  });
  const suggestions = (json.suggestions ?? []) as Array<{
    placePrediction?: { placeId?: string; text?: { text?: string } };
  }>;
  return suggestions
    .map((s) => ({
      placeId: s.placePrediction?.placeId ?? '',
      description: s.placePrediction?.text?.text ?? '',
    }))
    .filter((s) => s.placeId && s.description);
}

export interface CitySuggestion extends PlaceSuggestion {
  /** "Toronto" — matched against a PerDiemRate's city and used as the hotel query. */
  city: string;
  /** "Canada", as Google renders it in the user's language. */
  country: string | null;
}

/**
 * City suggestions for a travel destination.
 *
 * Restricted to localities, which is the whole point: you fly to a city, not to a
 * street address. It also solves the field problem — per-diem matches on a city and
 * the hotel search takes one, and picking "123 Bloor St W, Toronto, ON, Canada"
 * gives neither without a second (billable) Place Details call.
 *
 * `structuredFormat` splits the answer for us: mainText is the city, secondaryText
 * is "ON, Canada", whose last segment is the country. Parsing the flat description
 * instead would need to know how many administrative levels a country has.
 */
export async function searchCities(
  cfg: MapsConfig,
  query: string,
  sessionToken: string,
): Promise<CitySuggestion[]> {
  const regions = regionCodes(cfg.region);
  const json = await post(PLACES_ENDPOINT, cfg.apiKey, null, {
    input: query,
    sessionToken,
    // `locality` alone misses places Google files one level down (a lot of
    // European towns), so the coarser administrative level is included too.
    includedPrimaryTypes: ['locality', 'administrative_area_level_3'],
    ...(regions.length > 0 ? { includedRegionCodes: regions } : {}),
  });
  const suggestions = (json.suggestions ?? []) as Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }>;
  return suggestions
    .map((s) => {
      const p = s.placePrediction;
      const description = p?.text?.text ?? '';
      const city = p?.structuredFormat?.mainText?.text ?? description.split(',')[0]?.trim() ?? '';
      const secondary = p?.structuredFormat?.secondaryText?.text ?? '';
      const parts = secondary
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return {
        placeId: p?.placeId ?? '',
        description,
        city,
        country: parts.length > 0 ? parts[parts.length - 1] : null,
      };
    })
    .filter((s) => s.placeId && s.city);
}

/**
 * Driving distance across `placeIds` in order, leg by leg.
 *
 * Legs rather than a single total because a route the traveller can check is a
 * route they can correct — and an auditor looking at a 340 km claim wants to see
 * which hop accounts for it.
 *
 * Intermediate stops are passed in order and NOT optimized: the traveller drove
 * the route they drove, and reordering it to be shorter would change the claim.
 */
/**
 * Region codes as the Places API wants them: lowercase CLDR two-letter codes.
 *
 * Accepts the comma/space-separated list an admin types ("CA, US") because the
 * field restricts results and one country is rarely the honest answer. Anything
 * that isn't two letters is dropped rather than sent — a malformed code makes the
 * whole request fail, taking every valid one with it.
 */
export function regionCodes(region: string | undefined): string[] {
  if (!region) return [];
  return [
    ...new Set(
      region
        .split(/[\s,;]+/)
        .map((c) => c.trim().toLowerCase())
        .filter((c) => /^[a-z]{2}$/.test(c)),
    ),
  ].slice(0, 15);
}

/** Google's error envelope carries the real reason in `error.message`; the rest
 *  of the body is the request echoed back. */
export function googleMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === 'string' && message.trim() ? message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * The waypoints between origin and destination, in the order they are driven: on each
 * leg `placeIds[i] -> placeIds[i + 1]`, first the `via` points on that leg (in the order
 * given), then the named stop that ends it — unless that stop is the destination.
 *
 * A `via` point is a waypoint at its place ID with `via: true`: Google routes through it
 * but starts no leg there (the Routes API `Waypoint.via` field), so the legs in the answer
 * still match the named stops one for one. Built by name — the place ID and the flag, never
 * a coordinate: nothing a traveller dropped travels to Routes as a lat/lng. `viaIssue` (on
 * the lookup's input, and on Save) has already checked every `leg` lies on this route and
 * never decreases.
 */
export function routeIntermediates(placeIds: readonly string[], via: readonly RouteVia[]) {
  const waypoints: Array<{ placeId: string } | { placeId: string; via: true }> = [];
  for (let leg = 0; leg < placeIds.length - 1; leg += 1) {
    for (const point of via) {
      if (point.leg !== leg) continue;
      waypoints.push({ placeId: point.placeId, via: true });
    }
    if (leg + 1 < placeIds.length - 1) waypoints.push({ placeId: placeIds[leg + 1] as string });
  }
  return waypoints;
}

/**
 * The route request: stops in order, driving, traffic ignored, and never reordered.
 * Kept apart from the alternatives flag `computeRoutes` adds, so the fixed part of the
 * request reads in one place. Exported for its own tests only.
 */
export function routesBody(placeIds: readonly string[], via: readonly RouteVia[]) {
  const intermediates = routeIntermediates(placeIds, via);
  return {
    origin: { placeId: placeIds[0] },
    destination: { placeId: placeIds[placeIds.length - 1] },
    ...(intermediates.length > 0 ? { intermediates } : {}),
    travelMode: 'DRIVE',
    // Distance is what a mileage claim is about; a traffic-aware duration would
    // make the same route return a different answer every time it's recomputed.
    routingPreference: 'TRAFFIC_UNAWARE',
    optimizeWaypointOrder: false,
  };
}

/** No C0/C1 control characters in a label: the stored-route schema refuses them. */
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

/**
 * Google's route description as a label the stored-route schema accepts: one line,
 * trimmed, at most `MAX_ROUTE_LABEL` UTF-16 units (the unit zod counts), never ending
 * on half a surrogate pair. Empty → null, so a missing name is never sent as `''`.
 */
function routeLabel(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  const label = description
    .replace(CONTROL_CHARACTERS, ' ')
    .trim()
    .slice(0, MAX_ROUTE_LABEL)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
  return label || null;
}

/** A protobuf Duration as JSON ("1234s", "12.5s") → whole seconds, else null. */
function durationSeconds(duration: unknown): number | null {
  if (typeof duration !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  return match ? Math.round(Number(match[1])) : null;
}

/**
 * Up to `MAX_ROUTES_OFFERED` driving routes across `placeIds`, through the `via` place
 * IDs, in Google's order, each with its legs and its drawn path.
 *
 * Alternatives are asked for only when there is no waypoint at all — two named stops and
 * no pass-through point. Google states that "no alternative routes are returned for
 * requests that have intermediate waypoints" (Routes API reference,
 * `computeAlternativeRoutes`), and a via point is an intermediate waypoint too, so
 * otherwise the flag could only add cost or a refusal, and the picker gets the one route
 * there is.
 *
 * A leg Google returns without `distanceMeters` counts as 0 m — proto3 JSON omits a
 * zero, which is exactly what the same-place Test Connection probe gets back. A route
 * whose legs do not match the NAMED stops one for one is dropped (it could not be stored
 * as a chain of these stops), so `index` is the position among the routes OFFERED. A via
 * point adds no leg, so it changes neither that check nor which place ids a leg joins.
 *
 * The drawn path is handed on only when it passes the guard: over `MAX_ENCODED_POLYLINE`
 * or outside the polyline charset, it is null and the route is still offered — its legs
 * price the claim, and the map shows no path.
 *
 * Zero routes is a normal answer (no drivable route), not an error. A Google refusal is
 * thrown as `post` typed it; `isRefusedViaPlace` tells the caller when it may be about a
 * `via` place ID. Nothing here logs the request, the drawn path or a place ID: a
 * successful response is never logged, a rejection
 * is logged by `post` as endpoint and status only, and the one warning carries counts.
 */
export async function computeRoutes(
  cfg: MapsConfig,
  placeIds: readonly string[],
  via: readonly RouteVia[] = [],
): Promise<RouteOption[]> {
  if (placeIds.length < 2) return [];

  const json = await post(ROUTES_ENDPOINT, cfg.apiKey, ROUTES_FIELD_MASK, {
    ...routesBody(placeIds, via),
    ...(placeIds.length === 2 && via.length === 0 ? { computeAlternativeRoutes: true } : {}),
  });

  const raw = (json.routes ?? []) as Array<{
    description?: unknown;
    duration?: unknown;
    polyline?: { encodedPolyline?: unknown };
    legs?: Array<{ distanceMeters?: number }>;
  }>;

  const options: RouteOption[] = [];
  for (const route of raw) {
    if (options.length === MAX_ROUTES_OFFERED) break;
    const rawLegs = route.legs ?? [];
    if (rawLegs.length !== placeIds.length - 1) {
      console.warn(
        `[googleMaps] computeRoutes dropped a route with ${rawLegs.length} legs for ${placeIds.length} stops`,
      );
      continue;
    }
    const legs: RouteLeg[] = rawLegs.map((leg, i) => ({
      fromPlaceId: placeIds[i],
      toPlaceId: placeIds[i + 1],
      meters: leg.distanceMeters ?? 0,
    }));
    options.push({
      index: options.length,
      label: routeLabel(route.description),
      totalMeters: legs.reduce((a, l) => a + l.meters, 0),
      durationSeconds: durationSeconds(route.duration),
      legs,
      encodedPolyline: encodedPolyline(route.polyline?.encodedPolyline),
    });
  }
  return options;
}

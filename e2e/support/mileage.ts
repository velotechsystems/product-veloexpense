import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Locator, type Page, type Route } from '@playwright/test';
import { pickCombobox } from './combobox';
import { testDb } from './test-db';

/**
 * The route picker's Google side, stubbed — and nothing else.
 *
 * ─── WHY A STUB AND NOT THE REAL LOOKUP ──────────────────────────────────────────────────
 *
 * Locally and in CI there is no `GOOGLE_PLACES_API_KEY` and nothing installs the
 * `google-maps` integration, so `mileageRoute.status` answers `available: false` and the
 * mileage form never renders the stops, Calculate or the picker at all
 * (`MileageFields.tsx` branches on it). Installing a real key is not an option either: every
 * `computeRoutes` is a paid Routes request on a key the whole organisation shares, and the
 * answers change with the traffic. So the browser's `mileageRoute.*` calls are answered here,
 * from handlers each test writes, and EVERYTHING ELSE the page asks for still goes to the
 * real server — the line is created, priced and stored by the real `expenses.*` procedures,
 * which is the half these specs are about.
 *
 * ─── THE WIRE, AND WHY THE STUB SPLITS BATCHES ───────────────────────────────────────────
 *
 * The workbench's client is an `httpBatchLink` with superjson
 * (`apps/web/src/lib/trpc/client.tsx`). Read off `@trpc/client` 11.18
 * (`dist/httpUtils-*.mjs` `getUrl` / `getBody` / `arrayToDict`, `dist/httpBatchLink-*.mjs`):
 *
 *   · the procedure names are joined with commas in the PATH, `/api/trpc/a,b?batch=1`;
 *   · a QUERY sends its inputs as `input={"0":{"json":…},"1":{"json":…}}` in the query string;
 *   · a MUTATION sends the same dict as its POST body;
 *   · the answer is an ARRAY matched to the ops BY POSITION, each entry
 *     `{ result: { data: { json } } }` or `{ error: { json: { message, code, data } } }`. The
 *     client reads the JSON whatever the HTTP status, and an error entry reaches the hook as
 *     `e.message` and `e.data.code` (`TRPCClientError.from` on the deserialised error).
 *
 * Queries fired in one tick share a batch, so `mileageRoute.status` routinely rides beside
 * `expenses.report` or `expenses.mileagePreview`. Answering the whole batch here would mean
 * faking the report; forwarding it whole would send `mileageRoute.status` to a server that
 * says "off". So a mixed batch is SPLIT: the mileage ops are answered locally, the rest are
 * re-sent to the real server with `route.fetch` as a re-indexed batch of their own (the path
 * rewritten, and the `input` parameter for a GET or the body for a POST renumbered from 0),
 * and the two sets of answers are merged back into one array in the ORIGINAL order.
 *
 * ─── FAIL CLOSED ─────────────────────────────────────────────────────────────────────────
 *
 *   · A `mileageRoute.*` procedure with no handler is answered with an ERROR and its name is
 *     pushed onto `unexpected`, which every spec asserts empty at the end. A new procedure the
 *     picker grows is therefore a red run naming it, never a silent trip to the server.
 *   · Nothing under `mileageRoute.` is ever forwarded, with ONE opt-in exception:
 *     `recentRoutes: 'passthrough'`, which reads the person's own stored routes and costs no
 *     Google request. Every procedure that bills Google — `searchPlaces`, and the mutations
 *     `computeRoutes`, `lineRoutePath`, `pointToPlace` and `viaLocations` — cannot be
 *     forwarded by construction (its handler slot takes a function only), and `forwardable`
 *     re-checks the name before every forward as the belt to that brace.
 *
 * ─── HANDLERS ARE READ AT CALL TIME ──────────────────────────────────────────────────────
 *
 * The `handlers` object is kept by reference, so a test can swap one between two presses —
 * "no route", then "an error", then three new routes after Edit route — without
 * re-installing the interceptor.
 *
 * ─── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────────────────
 *
 * `page.route` does not intercept a request a service worker answers itself. The app's worker
 * never touches `/api/*` (`e2e/pwa-offline.spec.ts`, NFR-8), and `stubEnrollMfa` in
 * `authPageFixtures.ts` relies on the same fact for its tRPC route. If the worker ever starts
 * answering `/api/trpc`, the symptom here is `status` going to the real server and the stops
 * never rendering.
 */

/** The prefix every tRPC path carries. */
const TRPC_PREFIX = '/api/trpc/';

/** The namespace this stub owns. */
const NAMESPACE = 'mileageRoute.';

/**
 * A valid encoded polyline (Google's own documentation example): the path every stubbed
 * route and every stubbed line path carries. Nothing stores it — the line map asks for it
 * again on every view (`lineRoutePath`) — and with Google aborted nothing draws it either.
 */
export const ENCODED_POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

/** `mileageRoute.status`. */
export interface StatusAnswer {
  available: boolean;
  mapAvailable: boolean;
}

/** `mileageRoute.mapConfig`. */
export interface MapConfigAnswer {
  browserApiKey: string | null;
  region: string | null;
}

/** One address suggestion, as `mileageRoute.searchPlaces` returns it. */
export interface FakePlace {
  placeId: string;
  description: string;
}

/** `mileageRoute.searchPlaces`. */
export interface SearchPlacesAnswer {
  available: boolean;
  items: FakePlace[];
  error: string | null;
}

/** One route, as `mileageRoute.computeRoutes` returns it. */
export interface StubRoute {
  index: number;
  label: string | null;
  totalMeters: number;
  distance: string;
  durationSeconds: number | null;
  legs: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  encodedPolyline: string | null;
}

/**
 * One point a route passes through (`via`): a Google place ID on the leg it lies on. The
 * stored shape — never a coordinate (`mileageRouteSchema.ts`, `routeViaSchema`).
 */
export interface StubVia {
  placeId: string;
  leg: number;
}

/** One entry of `mileageRoute.recentRoutes`: a stored route, with nothing Google drew. */
export interface RecentRouteAnswer {
  stops: FakePlace[];
  legs: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  routeLabel?: string;
  routeIndex?: number;
  routeCount?: number;
  distance: { KM: string; MI: string };
  /** The points the route passes through; absent when it has none, never `[]`. */
  via?: StubVia[];
}

/** `mileageRoute.computeRoutes`'s input. `via` is absent when there are no points. */
export interface ComputeRoutesInput {
  placeIds: string[];
  unit: 'KM' | 'MI';
  via?: StubVia[];
}

/** `mileageRoute.computeRoutes`'s answer: the routes, and no stamp. */
export interface ComputeRoutesAnswer {
  routes: StubRoute[];
}

/** `mileageRoute.lineRoutePath`'s answer: the path to draw, or null for nothing to draw. */
export interface LineRoutePathAnswer {
  encodedPolyline: string | null;
}

/** `mileageRoute.pointToPlace`'s input: where a point was dropped, and how to place it. */
export interface PointToPlaceInput {
  lat: number;
  lng: number;
  method: 'auto' | 'geocoding';
}

/** `mileageRoute.pointToPlace`'s answer: the place a dropped point becomes. */
export interface PointToPlaceAnswer {
  placeId: string;
  location: { lat: number; lng: number };
  source: 'roads' | 'geocoding';
}

/** Why `viaLocations` could not place a point. */
export type ViaUnplacedReason = 'unresolved' | 'throttled' | 'failed';

/** One entry of `mileageRoute.viaLocations`'s answer: where a place is, or why not. */
export type ViaLocationAnswer =
  | { placeId: string; location: { lat: number; lng: number } }
  | { placeId: string; location: null; reason: ViaUnplacedReason };

type Handler<I, O> = (input: I) => O | Promise<O>;

/**
 * What answers each `mileageRoute.*` procedure. A missing key is a procedure the test does
 * not expect the page to call: it is answered with an error and recorded in `unexpected`.
 */
export interface MileageHandlers {
  status?: Handler<undefined, StatusAnswer>;
  mapConfig?: Handler<undefined, MapConfigAnswer>;
  searchPlaces?: Handler<{ query: string; sessionToken: string }, SearchPlacesAnswer>;
  computeRoutes?: Handler<ComputeRoutesInput, ComputeRoutesAnswer>;
  /** `'passthrough'` sends it to the real server — the one procedure allowed to go there. */
  recentRoutes?: Handler<undefined, { routes: RecentRouteAnswer[] }> | 'passthrough';
  /** A saved line's path, asked for each time its small map mounts. Bills Google. */
  lineRoutePath?: Handler<{ lineItemId: string }, LineRoutePathAnswer>;
  /**
   * A dropped or moved point turned into a place ID. Bills Google. No spec here can make
   * the page send it — a drop is a press on Google's own polyline, and Google is aborted —
   * so the slot exists to keep the stub's contract whole, and an unexpected call is still
   * a red run naming it.
   */
  pointToPlace?: Handler<PointToPlaceInput, PointToPlaceAnswer>;
  /** A reopened route's points, placed with one call for them all. Bills Google. */
  viaLocations?: Handler<{ placeIds: string[] }, { results: ViaLocationAnswer[] }>;
}

/** One `mileageRoute.*` op the page sent, with its decoded input. */
export interface MileageCall {
  /** The full name, `mileageRoute.computeRoutes`. */
  procedure: string;
  input: unknown;
}

export interface MileageStub {
  /** Every `mileageRoute.*` op, in the order it arrived, passthrough ones included. */
  calls: MileageCall[];
  /** Procedures that had no handler. Every spec asserts this is empty. */
  unexpected: string[];
}

/** tRPC's JSON-RPC code and HTTP status per error code (`@trpc/server` 11, `codes-*.mjs`). */
const ERROR_CODES = {
  BAD_REQUEST: { code: -32600, httpStatus: 400 },
  NOT_FOUND: { code: -32004, httpStatus: 404 },
  PRECONDITION_FAILED: { code: -32012, httpStatus: 412 },
  TOO_MANY_REQUESTS: { code: -32029, httpStatus: 429 },
  INTERNAL_SERVER_ERROR: { code: -32603, httpStatus: 500 },
} as const;

export type StubErrorCode = keyof typeof ERROR_CODES;

/** Throw from a handler to answer with a tRPC error the hook reads as `e.message` / `e.data.code`. */
export class MileageStubError extends Error {
  constructor(
    readonly code: StubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MileageStubError';
  }
}

interface Envelope {
  json?: unknown;
  meta?: unknown;
}

type Answer =
  | { result: { data: { json: unknown } } }
  | {
      error: {
        json: {
          message: string;
          code: number;
          data: { code: string; httpStatus: number; path: string };
        };
      };
    };

const ok = (json: unknown): Answer => ({ result: { data: { json } } });

function errorAnswer(path: string, code: StubErrorCode, message: string): Answer {
  const known = ERROR_CODES[code];
  return {
    error: {
      json: { message, code: known.code, data: { code, httpStatus: known.httpStatus, path } },
    },
  };
}

const httpStatusOf = (a: Answer): number => ('error' in a ? a.error.json.data.httpStatus : 200);

/** The comma-separated procedure names in a tRPC URL, or `[]` when it is not one. */
export function proceduresIn(url: string): string[] {
  const path = new URL(url).pathname;
  const at = path.indexOf(TRPC_PREFIX);
  if (at === -1) return [];
  return decodeURIComponent(path.slice(at + TRPC_PREFIX.length)).split(',');
}

/** Whether a request's comma-separated path names `procedure`. */
export function carries(url: string, procedure: string): boolean {
  return proceduresIn(url).includes(procedure);
}

/** The only `mileageRoute.*` op that may ever reach the server, and only when opted in. */
function forwardable(name: string, handlers: MileageHandlers): boolean {
  if (!name.startsWith(NAMESPACE)) return true;
  return name === `${NAMESPACE}recentRoutes` && handlers.recentRoutes === 'passthrough';
}

/** The ops' envelopes, by position. Batched: a dict keyed "0", "1", …; else one envelope. */
function envelopesOf(raw: unknown, count: number, batched: boolean): (Envelope | undefined)[] {
  if (!batched) return [raw as Envelope | undefined];
  const dict = (raw ?? {}) as Record<string, Envelope | undefined>;
  return Array.from({ length: count }, (_, i) => dict[String(i)]);
}

function parseJson(text: string | null): unknown {
  if (text == null || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Run one local handler and turn its outcome into an answer. */
async function answerLocally(
  name: string,
  input: unknown,
  handlers: MileageHandlers,
  stub: MileageStub,
): Promise<Answer> {
  const key = name.slice(NAMESPACE.length) as keyof MileageHandlers;
  const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
  if (typeof handler !== 'function') {
    stub.unexpected.push(name);
    return errorAnswer(
      name,
      'INTERNAL_SERVER_ERROR',
      `e2e: ${name} has no handler in stubMileageRoute, so the stub refused it rather than ` +
        'send it to the server. Add a handler, or find out why the page called it.',
    );
  }
  try {
    // Each handler is typed by its own slot; the decoded input is the page's, unchecked.
    return ok(await (handler as (i: unknown) => unknown)(input));
  } catch (err) {
    if (err instanceof MileageStubError) return errorAnswer(name, err.code, err.message);
    return errorAnswer(name, 'INTERNAL_SERVER_ERROR', `e2e: the ${name} handler threw: ${err}`);
  }
}

/**
 * Send the non-mileage part of a batch to the real server, as a batch of its own, and
 * return its answers in the order they were sent.
 */
async function forward(
  route: Route,
  url: URL,
  names: string[],
  envelopes: (Envelope | undefined)[],
): Promise<Answer[]> {
  const request = route.request();
  const dict = Object.fromEntries(envelopes.map((e, i) => [String(i), e]));
  const at = url.pathname.indexOf(TRPC_PREFIX);
  const target = new URL(url.href);
  target.pathname = `${url.pathname.slice(0, at + TRPC_PREFIX.length)}${names.join(',')}`;
  const isGet = request.method() === 'GET';
  if (isGet && url.searchParams.has('input')) {
    target.searchParams.set('input', JSON.stringify(dict));
  }

  const response = await route.fetch({
    url: target.href,
    ...(isGet ? {} : { postData: JSON.stringify(dict) }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return names.map((n) =>
      errorAnswer(
        n,
        'INTERNAL_SERVER_ERROR',
        `e2e: the forwarded part of a split batch answered ${response.status()} with no JSON`,
      ),
    );
  }
  // The client does the same with a non-array answer: every op gets the one body.
  return Array.isArray(body) ? (body as Answer[]) : names.map(() => body as Answer);
}

/**
 * Install the interceptor. Call BEFORE the page first navigates to the workbench.
 *
 * Only requests whose path names a `mileageRoute.*` procedure are routed here; every other
 * tRPC request goes to the server untouched, without a hop through this handler.
 */
export async function stubMileageRoute(
  page: Page,
  handlers: MileageHandlers,
): Promise<MileageStub> {
  const stub: MileageStub = { calls: [], unexpected: [] };

  await page.route(/\/api\/trpc\/[^?]*mileageRoute\./, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const names = proceduresIn(url.href);
    const batched = url.searchParams.get('batch') === '1';
    const raw =
      request.method() === 'GET'
        ? parseJson(url.searchParams.get('input'))
        : parseJson(request.postData());
    const envelopes = envelopesOf(raw, names.length, batched);

    const answers: (Answer | undefined)[] = new Array(names.length);
    const toForward: number[] = [];
    for (const [i, name] of names.entries()) {
      if (name.startsWith(NAMESPACE)) {
        stub.calls.push({ procedure: name, input: envelopes[i]?.json });
      }
      if (forwardable(name, handlers)) toForward.push(i);
      else answers[i] = await answerLocally(name, envelopes[i]?.json, handlers, stub);
    }

    // Everything in it may go to the server as it is: no rewriting needed.
    if (toForward.length === names.length) {
      await route.continue();
      return;
    }

    if (toForward.length > 0) {
      const forwardedNames = toForward.map((i) => names[i] ?? '');
      // The belt to the brace in `forwardable`: never let a Google-billed op through.
      for (const n of forwardedNames) {
        if (!forwardable(n, handlers)) throw new Error(`e2e: refused to forward ${n}`);
      }
      const forwarded = await forward(
        route,
        url,
        forwardedNames,
        toForward.map((i) => envelopes[i]),
      );
      toForward.forEach((original, j) => {
        answers[original] =
          forwarded[j] ??
          errorAnswer(
            names[original] ?? '',
            'INTERNAL_SERVER_ERROR',
            'e2e: the forwarded part of a split batch came back short',
          );
      });
    }

    const merged = answers.map(
      (a, i) =>
        a ?? errorAnswer(names[i] ?? '', 'INTERNAL_SERVER_ERROR', 'e2e: no answer was produced'),
    );
    const statuses = merged.map(httpStatusOf);
    // tRPC's own convention: 200 when every op succeeded, 207 for a mix, and the shared
    // status when they all failed. The client reads the body regardless.
    const status = statuses.every((s) => s === 200)
      ? 200
      : statuses.some((s) => s === 200)
        ? 207
        : (statuses[0] ?? 500);

    await route.fulfill({
      status: batched ? status : (statuses[0] ?? 500),
      contentType: 'application/json',
      body: JSON.stringify(batched ? merged : merged[0]),
    });
  });

  return stub;
}

/** The calls the stub recorded for one procedure (`'computeRoutes'`, not the full name). */
export function callsTo(stub: MileageStub, procedure: keyof MileageHandlers): MileageCall[] {
  return stub.calls.filter((c) => c.procedure === `${NAMESPACE}${procedure}`);
}

// ── Handler builders ──────────────────────────────────────────────────────────────────────

/** A fake place with an id no real lookup could return, unique per test through `tag`. */
export function fakePlace(tag: string, slug: string, description: string): FakePlace {
  return { placeId: `e2e-place-${tag}-${slug}`, description };
}

/**
 * A `searchPlaces` handler offering every place whose description contains the typed text,
 * case-insensitively. Specs type a distinctive prefix of the description.
 */
export function placesHandler(places: FakePlace[]): NonNullable<MileageHandlers['searchPlaces']> {
  return ({ query }) => {
    const q = query.trim().toLowerCase();
    return {
      available: true,
      items: places.filter((p) => p.description.toLowerCase().includes(q)),
      error: null,
    };
  };
}

/** One route to offer: its name, length and drive time. The legs are derived. */
export interface RouteSpec {
  label: string | null;
  totalMeters: number;
  durationSeconds: number | null;
}

/** Metres as "123.45" — the same arithmetic as `metersToDistance` in `mileageRouteSchema.ts`. */
export function metersToDistance(meters: number, unit: 'KM' | 'MI'): string {
  return (unit === 'MI' ? meters / 1609.344 : meters / 1000).toFixed(2);
}

/**
 * Routes across exactly the stops the page asked about.
 *
 * With `via` in the request, only the first spec comes back, as Google does: it offers no
 * alternatives once a route has any intermediate (spec FR-4 step 2).
 *
 * The legs chain through the place ids in the order received — one fewer leg than stops,
 * `fromPlaceId` of each equal to the previous `toPlaceId` — because that is what the server's
 * route view (`routeChainMeters`) checks before it believes a stored route. The metres are
 * split evenly and the remainder goes to the last leg, so the legs sum to `totalMeters`.
 */
export function routesFor(
  specs: readonly RouteSpec[],
): NonNullable<MileageHandlers['computeRoutes']> {
  return ({ placeIds, unit, via }) => ({
    routes: buildRoutes(via?.length ? specs.slice(0, 1) : specs, placeIds, unit),
  });
}

function buildRoutes(
  specs: readonly RouteSpec[],
  placeIds: readonly string[],
  unit: 'KM' | 'MI',
): StubRoute[] {
  return specs.map((spec, index) => {
    const legCount = Math.max(placeIds.length - 1, 1);
    const each = Math.floor(spec.totalMeters / legCount);
    const legs = Array.from({ length: legCount }, (_, i) => ({
      fromPlaceId: placeIds[i] ?? '',
      toPlaceId: placeIds[i + 1] ?? '',
      meters: i === legCount - 1 ? spec.totalMeters - each * (legCount - 1) : each,
    }));
    return {
      index,
      label: spec.label,
      totalMeters: spec.totalMeters,
      distance: metersToDistance(spec.totalMeters, unit),
      durationSeconds: spec.durationSeconds,
      legs,
      encodedPolyline: ENCODED_POLYLINE,
    };
  });
}

/**
 * The route exactly as the line stores it once `spec` — offered at `index` of `offered` — is
 * used: the write schema's output (`mileageRouteWriteSchema`), so no distance, no
 * `routeLabel` key at all when Google gave none, and no `via` key when there are no points.
 * Nothing Google drew is in it: no path, no stamp, no coordinate.
 */
export function storedRoute(
  stops: readonly FakePlace[],
  spec: RouteSpec,
  index: number,
  offered: number,
  via: readonly StubVia[] = [],
): Record<string, unknown> {
  const [route] = buildRoutes(
    [spec],
    stops.map((s) => s.placeId),
    'KM',
  );
  return {
    stops: stops.map((s) => ({ placeId: s.placeId, description: s.description })),
    legs: route?.legs ?? [],
    ...(spec.label ? { routeLabel: spec.label } : {}),
    routeIndex: index,
    routeCount: offered,
    ...(via.length > 0 ? { via: via.map((v) => ({ placeId: v.placeId, leg: v.leg })) } : {}),
  };
}

/** A `lineRoutePath` handler that answers the stub's path for any line. */
export function linePathHandler(): NonNullable<MileageHandlers['lineRoutePath']> {
  return () => ({ encodedPolyline: ENCODED_POLYLINE });
}

/**
 * A `viaLocations` handler: every distinct place ID it is asked about is placed somewhere
 * near Cobourg, except those named in `unplaced`, which come back with no location and the
 * reason given — Place Details refusing the ID (`unresolved`), the per-person limit
 * (`throttled`) or Google failing (`failed`).
 */
export function viaLocationsHandler(
  unplaced: Readonly<Record<string, ViaUnplacedReason>> = {},
): NonNullable<MileageHandlers['viaLocations']> {
  return ({ placeIds }) => ({
    results: [...new Set(placeIds)].map((placeId, i): ViaLocationAnswer => {
      const reason = unplaced[placeId];
      return reason
        ? { placeId, location: null, reason }
        : { placeId, location: { lat: 43.96 + i / 1000, lng: -78.17 - i / 1000 } };
    }),
  });
}

// ── The stored row ───────────────────────────────────────────────────────────────────────

/**
 * `md5("mileageRoute"::text)` for one line, read from the database the server writes to
 * (spec FR-4: an unchanged accept leaves it equal). JSONB keeps no key order and prints
 * one canonical text, so two equal md5s mean two equal JSONB values — "byte-identical" in
 * the only sense a JSONB column has (QA slice §3). `null` when the line has no route.
 *
 * Needs `DATABASE_URL` in the Playwright process (`testDb` says so when it is missing).
 */
export async function routeVersion(caller: string, lineId: string): Promise<string | null> {
  const db = await testDb(caller);
  // VeloExpense: SQL through the e2e pool (`testDb`), VeloExpense's table and column names.
  const rows = (
    await db.query(
      'SELECT md5(mileage_route::text) AS version FROM expense_line_item WHERE id = $1',
      [lineId],
    )
  ).rows as { version: string | null }[];
  if (rows.length !== 1) throw new Error(`line ${lineId} is not in the database`);
  return rows[0]?.version ?? null;
}

// ── Google, kept off the network ─────────────────────────────────────────────────────────

/** The hosts the Maps JavaScript API loads from: `maps.googleapis.com`, `maps.gstatic.com`. */
function isGoogleMaps(url: URL): boolean {
  return /(^|\.)googleapis\.com$|(^|\.)gstatic\.com$/.test(url.hostname);
}

/** Origin and path of each Google request the page made — never the query, which holds a key. */
export interface GoogleWatch {
  requests(): string[];
}

/**
 * ABORT every Google Maps request, at the context level, and record each one.
 *
 * The context's `request` event fires before routing, so an aborted request is still
 * recorded (`playwright-core/types/types.d.ts`, `BrowserContext` `request`). Installed in every
 * desktop test as a safety net, and it is the whole mechanism of the map-failure test: the
 * script's load error is what the picker is meant to fall back on.
 */
export async function abortGoogleMaps(context: BrowserContext): Promise<GoogleWatch> {
  const seen: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (isGoogleMaps(url)) seen.push(`${url.origin}${url.pathname}`);
  });
  await context.route(isGoogleMaps, (route) => route.abort());
  return { requests: () => [...seen] };
}

/**
 * HOLD every Google Maps request from this page unanswered, so the map stays in its loading
 * state for as long as the test needs it.
 *
 * The handler returns without calling `fulfill`, `continue`, `abort` or `fallback`, which
 * leaves the request pending. A page route takes precedence over a context route
 * (`Page.route` in `playwright-core/types/types.d.ts`). The caller MUST end with
 * `page.unrouteAll({ behavior: 'ignoreErrors' })`, or the test waits on the held handlers.
 */
export async function holdGoogleMaps(page: Page): Promise<GoogleWatch> {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (isGoogleMaps(url)) seen.push(`${url.origin}${url.pathname}`);
  });
  await page.route(isGoogleMaps, () => {
    // Deliberately never answered: see above.
  });
  return { requests: () => [...seen] };
}

// ── Recording a real procedure ───────────────────────────────────────────────────────────

/** One call of a real (not stubbed) procedure, with the input it carried. */
export interface RecordedCall {
  url: string;
  input: Record<string, unknown> | undefined;
}

/**
 * Record every call of `procedure` the page sends from now on, batched or not.
 *
 * A `request` listener rather than a route: nothing is intercepted, this only watches. The
 * same reader as `e2e/mileage-route-lookup-off.spec.ts`, which explains the batch body.
 */
export function recordProcedure(page: Page, procedure: string): RecordedCall[] {
  const calls: RecordedCall[] = [];
  page.on('request', (request) => {
    const names = proceduresIn(request.url());
    if (!names.includes(procedure)) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const batched = new URL(request.url()).searchParams.get('batch') === '1';
    names.forEach((name, index) => {
      if (name !== procedure) return;
      const envelope = batched
        ? (body as Record<string, Envelope | undefined> | null)?.[String(index)]
        : (body as Envelope | null);
      calls.push({
        url: request.url(),
        input: envelope?.json as Record<string, unknown> | undefined,
      });
    });
  });
  return calls;
}

// ── Driving the form ─────────────────────────────────────────────────────────────────────

/**
 * Type into one stop and pick the suggestion — the only way a stop gets a place id, and no
 * route is asked for until every stop has one.
 *
 * The suggestions are plain buttons under the field (`PlaceInput` in `RouteStopRows.tsx`),
 * named by their description.
 */
export async function pickPlace(
  scope: Locator,
  stopLabel: string,
  place: FakePlace,
  typed: string,
): Promise<void> {
  const field = scope.getByLabel(stopLabel, { exact: true });
  await field.fill(typed);
  const suggestion = scope.getByRole('button', { name: place.description, exact: true });
  await expect(
    suggestion,
    `typing "${typed}" into ${stopLabel} should offer "${place.description}" from the stub`,
  ).toBeVisible({ timeout: 15_000 });
  await suggestion.click();
  await expect(field).toHaveValue(place.description);
}

/**
 * Open the route workspace from a line's route dropdown — a new line's, or a saved one's —
 * on `entry` (New route by default), and return the dialog.
 */
export async function openWorkspace(
  page: Page,
  scope: Locator,
  copy: RoutePickerCopy,
  entry: string | RegExp = copy.newRoute,
): Promise<Locator> {
  await pickCombobox(
    page,
    scope.getByRole('combobox', { name: copy.routeDropdown, exact: true }),
    typeof entry === 'string' ? new RegExp(`^${escapeRegExp(entry)}$`) : entry,
  );
  const dialog = page.getByRole('dialog', { name: copy.title });
  await expect(dialog, 'a route dropdown entry opens the workspace').toBeVisible({
    timeout: 15_000,
  });
  return dialog;
}

/**
 * Add an expense with a vendor and NO line, on the open report, and wait for its row.
 *
 * The same steps as `addLockedMileageLine` in `mileage-route-lookup-off.spec.ts`: the editor
 * lags the click, and an empty Vendor is the signal it has switched to the new expense.
 */
export async function addBlankExpense(page: Page, vendor: string): Promise<void> {
  await page.getByRole('button', { name: 'Add expense' }).first().click();
  const vendorField = page.getByLabel('Vendor');
  await expect(vendorField).toHaveValue('', { timeout: 30_000 });
  await vendorField.fill(vendor);
  await vendorField.blur();
  await expect(
    page.getByRole('button', { name: new RegExp(escapeRegExp(vendor)) }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Layout boxes ─────────────────────────────────────────────────────────────────────────

/** Where a line's route block sits, measured in the browser (spec FR-7). */
export interface RouteBlockLayout {
  /** From the bottom of what comes before the block to the block's top, in px. */
  gap: number;
  /** The block's left edge and width. */
  left: number;
  width: number;
  /** The left edge and width of its parent's content box. */
  rowLeft: number;
  rowWidth: number;
}

/**
 * Measure the block a line's route dropdown sits in: the nearest ancestor of `dropdown`
 * that has something laid out before it, and the gap between the two.
 *
 * "Before" is every earlier sibling with a box of its own in the flow — taller than 2 px,
 * not `position: absolute` or `fixed` (a visually hidden input is neither), and not
 * `display: none` — and the gap is to the LOWEST of them. That reads both layouts the same
 * way: a saved line, where the block follows its row's fields in a column, and a new line,
 * where it wraps onto its own line of a `flex-wrap` row whose items are centred, so the
 * tallest item on the line above is the one that ends lowest.
 */
export async function routeBlockLayout(dropdown: Locator): Promise<RouteBlockLayout> {
  const found = await dropdown.evaluate((trigger) => {
    const inFlow = (el: Element) => {
      const r = el.getBoundingClientRect();
      const position = getComputedStyle(el).position;
      return r.height > 2 && r.width > 0 && position !== 'absolute' && position !== 'fixed';
    };
    for (let block: Element | null = trigger; block?.parentElement; block = block.parentElement) {
      const before: Element[] = [];
      for (let s = block.previousElementSibling; s; s = s.previousElementSibling) {
        if (inFlow(s)) before.push(s);
      }
      if (before.length === 0) continue;
      const parent = block.parentElement;
      const style = getComputedStyle(parent);
      const outer = parent.getBoundingClientRect();
      const box = block.getBoundingClientRect();
      const padLeft = Number.parseFloat(style.paddingLeft);
      const padRight = Number.parseFloat(style.paddingRight);
      return {
        gap: box.top - Math.max(...before.map((s) => s.getBoundingClientRect().bottom)),
        left: box.left,
        width: box.width,
        rowLeft: outer.left + Number.parseFloat(style.borderLeftWidth) + padLeft,
        rowWidth: parent.clientWidth - padLeft - padRight,
      };
    }
    return null;
  });
  if (!found) throw new Error('the route dropdown has nothing laid out above it to measure from');
  return found;
}

/**
 * Wait for the route dialog to finish opening: fully opaque, and no animation of its own
 * still running. `DialogContent` opens with `animate-in fade-in-0 zoom-in-95` over 200 ms
 * (`packages/design-system/src/components/ui/dialog.tsx`), and `tailwindcss-animate`'s
 * `enter` keyframe scales the whole sheet from 0.95 about its centre. A box read in that
 * window is scaled, and two reads taken a few milliseconds apart are scaled differently, so
 * a gap between them comes out short. Only the dialog's own animations count: a spinner
 * inside it (`animate-spin`) never finishes.
 */
export async function dialogSettled(dialog: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        dialog.evaluate(
          (el) =>
            getComputedStyle(el).opacity === '1' &&
            el.getAnimations().every((a) => a.playState !== 'running'),
        ),
      { message: 'the dialog has finished fading and zooming in' },
    )
    .toBe(true);
}

/** The vertical gap from the bottom of `upper` to the top of `lower`, in px. */
export async function verticalGap(upper: Locator, lower: Locator): Promise<number> {
  const a = await upper.boundingBox();
  const b = await lower.boundingBox();
  if (!a || !b) throw new Error('one of the two elements has no box to measure');
  return b.y - (a.y + a.height);
}

// ── Copy, per locale ─────────────────────────────────────────────────────────────────────

/** `expenses.json` and `expense-categories.json` are read from disk: no `resolveJsonModule`. */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function at(root: unknown, path: string, where: string): string {
  let node = root;
  for (const key of path.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`${path} is missing from ${where}`);
  return node;
}

/** The picker's copy, read from the catalog the app renders, so the FR-CA run asserts French. */
export interface RoutePickerCopy {
  addLineOpener: string;
  categoryPlaceholder: string;
  mileageCategory: string;
  from: string;
  to: string;
  /** The retired Calculate button's words, for absence checks only. */
  calculate: string;
  /** A line's route dropdown, new or saved, by its accessible name. */
  routeDropdown: string;
  /** A saved line's dropdown entry that reopens its route. */
  changeRoute: string;
  newRoute: string;
  previousRoutes: string;
  title: string;
  useRoute: string;
  cancel: string;
  mapUnavailable: string;
  /** The map area's accessible name (`role="region"`). */
  mapLabel: string;
  /** The panel's accessible name (`role="region"`): the modal's left column on desktop. */
  panelLabel: string;
  addStop: string;
  /** "A route can have at most {max} stops." — ICU, filled by `fill`. */
  maxStops: string;
  /** "Remove point {n} (between {from} and {to})" — ICU, filled by `fill`. */
  removePoint: string;
  /** A reopened route's point Google could not place: listed, with no marker. */
  pointUnplaced: string;
  /** The map's loading text: the modal's `role="status"`, the line map's busy name. */
  mapLoading: string;
  /** Under a line's summary when five line maps are already open on the page. */
  lineMapCapped: string;
}

/** A catalog message with its simple `{name}` arguments filled in. */
export function fill(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export function routePickerCopy(locale: string): RoutePickerCopy {
  const where = `the ${locale} expenses catalog`;
  const c = readJson(`packages/i18n/src/catalogs/${locale}/expenses.json`);
  // VeloExpense: no `seed-data/expense-categories.json`; the demo seed writes ExpenseOS's
  // `travelMileage` category itself (`seedMileage`, scripts/seed.mjs), with these labels.
  const categories = [
    { code: 'travelMileage', label: { en: 'Travel - Mileage', 'fr-CA': 'Voyage - Kilométrage' } },
  ] as { code: string; label: Record<string, string> }[];
  const mileage = categories.find((cat) => cat.code === 'travelMileage')?.label[locale];
  if (!mileage) throw new Error(`travelMileage has no ${locale} label in the category seed`);
  return {
    addLineOpener: at(c, 'drawer.addLine', where),
    categoryPlaceholder: at(c, 'addLine.categoryPlaceholder', where),
    mileageCategory: mileage,
    from: at(c, 'route.from', where),
    to: at(c, 'route.to', where),
    // The Calculate button and its catalog key are gone (routes are asked for on their own).
    // Its old words, kept as a literal so the absence checks still look for something.
    calculate: locale === 'fr-CA' ? 'Calculer l’itinéraire' : 'Calculate route',
    routeDropdown: at(c, 'route.dropdownLabel', where),
    changeRoute: at(c, 'route.changeRoute', where),
    newRoute: at(c, 'route.newRoute', where),
    previousRoutes: at(c, 'route.previousRoutes', where),
    title: at(c, 'route.picker.title', where),
    useRoute: at(c, 'route.picker.useRoute', where),
    cancel: at(c, 'addLine.cancel', where),
    mapUnavailable: at(c, 'route.picker.mapUnavailable', where),
    mapLabel: at(c, 'route.picker.mapLabel', where),
    panelLabel: at(c, 'route.picker.panelLabel', where),
    addStop: at(c, 'route.addStop', where),
    maxStops: at(c, 'route.maxStops', where),
    removePoint: at(c, 'route.removePoint', where),
    pointUnplaced: at(c, 'route.pointUnplaced', where),
    mapLoading: at(c, 'route.picker.mapLoading', where),
    lineMapCapped: at(c, 'route.lineMapCapped', where),
  };
}

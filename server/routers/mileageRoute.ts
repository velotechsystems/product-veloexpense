/**
 * Address search + route distance for a mileage line.
 *
 * A thin server-side proxy over the Google Maps Platform, for one reason: the API
 * key must never reach the browser. It also means the whole feature degrades
 * cleanly — every procedure answers `available: false` when the integration
 * isn't installed or has no key, and the form falls back to typed addresses and a
 * manually entered distance.
 *
 * Gated on the same permission as editing an expense: this is part of filling in
 * a mileage line, not an admin surface.
 *
 * The one key that leaves the server is the separate, referrer-restricted browser key,
 * through `mapConfig` alone — signed in, with this permission, never from a server
 * component, a prefetch or a `NEXT_PUBLIC_*` variable.
 *
 * VeloExpense: ExpenseOS's router (550b2945, then 67db2e33's route-on-a-map procedures in
 * eos batch 5). Both keys are platform settings from the environment rather than a
 * per-tenant installation (see `server/platform/googleMaps.ts`), so on a deployment with
 * none every procedure answers `available: false`, as above.
 */

import 'server-only';

import { Prisma, type PrismaClient } from '@expenseos/db';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { claimedMeters, pickClosestRoute } from '@/lib/closestRoute';
import {
  MAX_PLACE_ID,
  MAX_ROUTE_STOPS,
  MAX_VIA,
  mileageRouteWriteSchema,
  type RouteVia,
  routeChainMeters,
  routeViaSchema,
  viaIssue,
} from '@/lib/mileageRouteSchema';
import { assertExpenseDraft } from '@/server/lib/expenseWriteGuard';
import { storedRoute } from '@/server/lib/mileageRouteView';
import { throttle } from '@/server/lib/rateLimit';
import {
  computeRoutes,
  getBrowserMapsConfig,
  getMapsConfig,
  isRefusedViaPlace,
  isUnroutableWaypoint,
  isUrlSafePlaceId,
  type MapsConfig,
  mapsError,
  metersToDistance,
  placeForPoint,
  placeLocation,
  searchPlaces,
} from '@/server/platform/googleMaps';
import { REFUSAL_KEYS, refusal } from '@/server/refusal';
import { router, withPermission } from '@/server/trpc';

const mileageProcedure = withPermission(P.expense.report.updateOwn);

/**
 * Route lookups one person may make per hour (NFR-14).
 *
 * Every lookup is a paid Google request, on a key the whole organisation shares — one
 * looping session could spend the project's quota and switch route lookup off for
 * everybody. Every lookup counts, whatever asked for it: the picker's automatic routing,
 * a dropped or removed pass-through point, turning a dropped point into a place
 * (`pointToPlace`, one count even when Roads falls back to Geocoding — spec NFR-8), a
 * saved line's map drawn on view (`lineRoutePath`, one per mounted line map, at most five
 * on a page), placing a reopened route's `via` points (`viaLocations`, one per distinct
 * place ID asked). They share the one key below. 300 an hour leaves
 * room for one route adjusted through all 23 points plus a report's line maps, viewed
 * several times, and still caps a looping session. Fixed window,
 * keyed by user, failing open when Redis is unreachable (`throttle` in
 * server/lib/rateLimit.ts): a limiter outage must not block a claim.
 */
const ROUTE_LOOKUPS_PER_HOUR = { max: 300, windowSec: 3600 } as const;

/** Count one route lookup against the caller's hourly budget; refuse past it. No message
 *  of our own: the code's generic one stands, and the form maps the code to its
 *  translated refusal. */
async function countRouteLookup(userId: string) {
  if (!(await takeRouteLookup(userId))) throw new TRPCError({ code: 'TOO_MANY_REQUESTS' });
}

/** Count one route lookup against the caller's hourly budget: whether it was within it. */
async function takeRouteLookup(userId: string): Promise<boolean> {
  return (await throttle(`mileage-routes:${userId}`, ROUTE_LOOKUPS_PER_HOUR)).allowed;
}

/** Place Details requests `viaLocations` keeps in flight at once. */
const VIA_LOOKUPS_IN_FLIGHT = 5;

/**
 * Where one `via` place ID is, for the modal's marker, or why it is not placed:
 *   · `unresolved` — Google does not know the ID or gives it no location, or the ID is not
 *     one that may go into a Google URL (security C1: no request, no count);
 *   · `throttled`  — the per-person limit was reached before this ID's turn (no request);
 *   · `failed`     — the request failed (a key refusal, a quota or server error, a timeout).
 * `location` is display-only: never stored, never logged (spec NFR-9).
 */
type ViaLocation =
  | { placeId: string; location: { lat: number; lng: number } }
  | { placeId: string; location: null; reason: 'unresolved' | 'throttled' | 'failed' };

/** One counted Place Details lookup, its failure as data — never a throw. */
async function locateVia(cfg: MapsConfig, placeId: string): Promise<ViaLocation> {
  try {
    const at = await placeLocation(cfg, placeId);
    return at
      ? { placeId, location: { lat: at.lat, lng: at.lng } }
      : { placeId, location: null, reason: 'unresolved' };
  } catch (err) {
    // Redacted (`mapsError`); the request carried no coordinate, and the answer is not logged.
    console.warn(`[mileage.viaLocations] place lookup failed: ${mapsError(err)}`);
    return { placeId, location: null, reason: 'failed' };
  }
}

/** The refusal when no server key is configured: nothing to look a route up with. */
function lookupNotConfigured() {
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'Address lookup is not configured. Enter the distance manually.',
  });
}

/**
 * The browser key, only when lookup is on and it is not the server key in use.
 *
 * The resolver already refuses a browser key equal to the installation's own `apiKey`.
 * This catches the remaining case: the server key in use came from the environment
 * (`GOOGLE_PLACES_API_KEY`), which the resolver deliberately never reads.
 */
function usableBrowserKey(
  cfg: Awaited<ReturnType<typeof getMapsConfig>>,
  browser: Awaited<ReturnType<typeof getBrowserMapsConfig>>,
) {
  if (!cfg || !browser) return null;
  return browser.browserApiKey === cfg.apiKey ? null : browser;
}

/**
 * The "Previous routes" read: how many to offer, and how far back to look for them.
 *
 * Lines are read newest first, 50 at a time, and never more than 200 in all. The cap is
 * what bounds one open of the dropdown: somebody whose last 200 mileage lines are the
 * same commute is offered that one route, rather than the read walking their whole
 * history looking for a fifth. De-duplication runs on every page BEFORE the count of 5 is
 * reached — a plain `take 5` on lines would return the same commute five times.
 */
const RECENT_ROUTES = 5;
const RECENT_PAGE_SIZE = 50;
const RECENT_MAX_PAGES = 4;

/**
 * One previous route, as the dropdown offers it and a pick puts it on the line. It carries
 * no drawn path: a pick routes its stops, through its `via`, again.
 */
type RecentRoute = {
  stops: { placeId: string; description: string }[];
  legs: { fromPlaceId: string; toPlaceId: string; meters: number }[];
  routeLabel?: string;
  routeIndex?: number;
  routeCount?: number;
  /** The points the route passes through, as stored; absent when it has none. */
  via?: RouteVia[];
  /** The total of the legs, in both units, so the line takes the one it is showing. */
  distance: { KM: string; MI: string };
};

/**
 * A stored route as a previous-route entry, or null when it cannot be one.
 *
 * Two gates, both needed:
 *   · the WRITE schema, so an entry is only offered when Save would accept it as it
 *     stands — a pre-schema row with an over-long description would otherwise fill the
 *     line and then fail on Save, which is worse than not offering it;
 *   · `routeChainMeters`, the same eligibility check the approver view uses: every stop
 *     has a place id, the legs are there, there is one fewer leg than stops, and they
 *     chain through exactly these stops. A route without that has no measured distance
 *     to reuse.
 *
 * Rebuilt field by field from the parsed value, so nothing else in the stored JSON
 * reaches the browser; the label, position, count and `via` are present only when stored.
 *
 * The schema parses only the keys a route may be stored with (`storedRoute`), so a key
 * left on an old row — a drawn path, dragged lat/lng points — never decides whether the
 * route is listed, and never reaches the browser.
 */
function toRecentRoute(stored: unknown): { key: string; route: RecentRoute } | null {
  const parsed = mileageRouteWriteSchema.safeParse(storedRoute(stored));
  if (!parsed.success) return null;
  const route = parsed.data;
  const meters = routeChainMeters(route.stops, route.legs);
  if (meters === null || !route.legs) return null;
  // `routeChainMeters` matched every stop's place id to a leg end, so each one is set.
  const stops = route.stops.map((s) => ({ placeId: s.placeId ?? '', description: s.description }));
  const via = route.via?.map((v) => ({ placeId: v.placeId, leg: v.leg }));
  return {
    // Two routes are the same route when they visit the same places in the same order and
    // pass through the same points on the same legs: the same stops with a different `via`
    // is a different road, and a different distance.
    key: JSON.stringify([stops.map((s) => s.placeId), (via ?? []).map((v) => [v.placeId, v.leg])]),
    route: {
      stops,
      legs: route.legs.map((l) => ({
        fromPlaceId: l.fromPlaceId,
        toPlaceId: l.toPlaceId,
        meters: l.meters,
      })),
      ...(route.routeLabel !== undefined ? { routeLabel: route.routeLabel } : {}),
      ...(route.routeIndex !== undefined ? { routeIndex: route.routeIndex } : {}),
      ...(route.routeCount !== undefined ? { routeCount: route.routeCount } : {}),
      ...(via ? { via } : {}),
      distance: { KM: metersToDistance(meters, 'KM'), MI: metersToDistance(meters, 'MI') },
    },
  };
}

/** A saved line, as `lineRoutePath` reads it: its expense, its kind, its route and its
 *  claim in text (decimals as PostgreSQL holds them). */
interface PathLine {
  expenseId: string;
  kind: string;
  route: unknown;
  distance: string | null;
  override: string | null;
  unit: string | null;
}

async function readPathLine(db: PrismaClient, lineItemId: string): Promise<PathLine | null> {
  // VeloExpense: VeloExpense's table and column names (snake_case), under the tenant's RLS.
  const rows: PathLine[] = await db.$queryRaw`
    SELECT li.expense_id AS "expenseId",
           li.kind::text AS "kind",
           li.mileage_route AS "route",
           li.mileage_distance::text AS "distance",
           li.mileage_distance_override::text AS "override",
           li.mileage_unit::text AS "unit"
      FROM expense_line_item li
     WHERE li.id = ${lineItemId}::uuid`;
  return rows[0] ?? null;
}

/**
 * The stored `via` points, rebuilt by name, for `stopCount` named stops: `[]` when the
 * route has none, null when what is stored is not a `via` Save would accept (a malformed
 * entry, out of order, off this route, past the 25) — a path drawn without them would not
 * be the route that was filed.
 */
function storedVia(route: unknown, stopCount: number): RouteVia[] | null {
  const raw = (route as { via?: unknown }).via;
  if (raw === undefined) return [];
  const parsed = z.array(routeViaSchema).max(MAX_VIA).safeParse(raw);
  if (!parsed.success || viaIssue(stopCount, parsed.data)) return null;
  return parsed.data.map((v) => ({ placeId: v.placeId, leg: v.leg }));
}

/** The stored named stops' place IDs, when every stop has one and there are 2 to 25. */
function storedStopPlaceIds(route: unknown): string[] | null {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const stops = (route as { stops?: unknown }).stops;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > MAX_ROUTE_STOPS) return null;
  const ids: string[] = [];
  for (const stop of stops) {
    const placeId = (stop as { placeId?: unknown } | null)?.placeId;
    if (typeof placeId !== 'string' || placeId.length === 0) return null;
    ids.push(placeId);
  }
  return ids;
}

export const mileageRouteRouter = router({
  /**
   * Whether address lookup is usable, so the form knows which shape to render before
   * the user types anything — and whether the route picker can draw its map
   * (`mapAvailable`: lookup is on AND a browser key is set). Booleans only; no key.
   */
  status: mileageProcedure.query(async ({ ctx }) => {
    const cfg = await getMapsConfig(ctx.db);
    // No lookup, no picker to draw a map in — so the browser key is not even read.
    const browser = cfg ? await getBrowserMapsConfig(ctx.db) : null;
    return { available: cfg !== null, mapAvailable: usableBrowserKey(cfg, browser) !== null };
  }),

  /**
   * What the picker's map needs: the browser key and a single-country bias, or nulls.
   *
   * Built field by field from the browser-key resolver, which never reads the environment
   * and reads the server key only to refuse a browser key equal to it. `browserApiKey` is null when lookup is off (there is no picker to
   * draw in) and when no browser key is set — never the server key in its place,
   * including when the server key came from `GOOGLE_PLACES_API_KEY`.
   */
  mapConfig: mileageProcedure.query(async ({ ctx }) => {
    const cfg = await getMapsConfig(ctx.db);
    const browser = usableBrowserKey(cfg, cfg ? await getBrowserMapsConfig(ctx.db) : null);
    return {
      browserApiKey: browser ? browser.browserApiKey : null,
      region: browser ? browser.region : null,
    };
  }),

  /**
   * The signed-in person's last five distinct routes, newest trip first, for the
   * "Previous routes" dropdown. A pick fills the line from what is returned here, so it
   * costs no Google request.
   *
   * Whose routes: the caller's, from the session — there is no input at all, so no
   * request can name another person. Matched on `Expense.ownerId` alone: a line on an
   * expense somebody else owns is that person's trip even when the caller submitted the
   * report. Every report status counts, REJECTED and RETURNED included — these are the
   * caller's own places, offered as a convenience, not a statement about the claim.
   *
   * Order: expense date, then when the line was created, then the line id, all newest
   * first — `id` makes the order total, which the keyset paging below depends on.
   * Paged by keyset rather than offset: each page starts strictly after the last line of
   * the previous one, compared on all three columns in the database, so a line is never
   * read twice or skipped. Raw SQL because the order runs across the join; the cursor is
   * the last line's id, looked up again in the query, so no timestamp makes a round trip
   * through JavaScript. (If that line is deleted between two pages, the lookup finds
   * nothing, the comparison matches no row, and the list simply ends early.)
   *
   * The route test excludes both a SQL NULL and the JSON `null` a line saved without a
   * route carries (`Prisma.JsonNull`); anything else that is not a route is refused by
   * the schema below. Written as `IS NOT NULL AND <> 'null'` rather than
   * `jsonb_typeof(...) = 'object'` on purpose: the planner estimates those two from the
   * column statistics, whereas the function call got a default guess (77 rows estimated,
   * 15,350 actual, in the measurement), and on a 200k-line EXPLAIN that guess tipped the
   * plan into a sequential scan of every line in the table instead of walking the
   * caller's own expenses.
   */
  recentRoutes: mileageProcedure.query(async ({ ctx }) => {
    const ownerId = ctx.session.user.id;
    const seen = new Set<string>();
    const routes: RecentRoute[] = [];
    let after: string | null = null;

    for (let page = 0; page < RECENT_MAX_PAGES && routes.length < RECENT_ROUTES; page += 1) {
      // VeloExpense: VeloExpense's names, and its expense date (`txn_date`) may be blank,
      // where ExpenseOS's `date` is required — an undated trip sorts as the oldest
      // (`-infinity`), so a NULL neither leads the list nor breaks the row comparison.
      const cursor: Prisma.Sql = after
        ? Prisma.sql`AND (COALESCE(e.txn_date, '-infinity'::date), li.created_at, li.id) < (
            SELECT COALESCE(ce.txn_date, '-infinity'::date), cl.created_at, cl.id
            FROM expense_line_item cl
            JOIN expense ce ON ce.id = cl.expense_id
            WHERE cl.id = ${after}::uuid
          )`
        : Prisma.empty;
      const rows: { id: string; route: unknown }[] = await ctx.db.$queryRaw`
        SELECT li.id, li.mileage_route AS "route"
        FROM expense_line_item li
        JOIN expense e ON e.id = li.expense_id
        WHERE e.owner_id = ${ownerId}::uuid
          AND li.kind = 'MILEAGE'
          AND li.mileage_route IS NOT NULL
          AND li.mileage_route <> 'null'::jsonb
          ${cursor}
        ORDER BY COALESCE(e.txn_date, '-infinity'::date) DESC, li.created_at DESC, li.id DESC
        LIMIT ${RECENT_PAGE_SIZE}
      `;

      for (const row of rows) {
        const entry = toRecentRoute(row.route);
        // Only the newest copy of a route is listed; older ones are the same places.
        if (!entry || seen.has(entry.key)) continue;
        seen.add(entry.key);
        routes.push(entry.route);
        if (routes.length === RECENT_ROUTES) break;
      }
      if (rows.length < RECENT_PAGE_SIZE) break;
      after = rows[rows.length - 1].id;
    }

    return { routes };
  }),

  /**
   * Address suggestions. `sessionToken` should be one UUID per "pick an address"
   * interaction, discarded after the selection — that bills the keystrokes and
   * the pick as a single autocomplete session rather than one call each.
   */
  searchPlaces: mileageProcedure
    .input(
      z.object({
        query: z.string().trim().min(3).max(200),
        sessionToken: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) return { available: false as const, items: [], error: null };
      try {
        return {
          available: true as const,
          items: await searchPlaces(cfg, input.query, input.sessionToken),
          error: null,
        };
      } catch (err) {
        // A lookup failure must not BLOCK the claim — the traveller can still type
        // the address and the distance by hand. But it must not be silent either:
        // returning an empty list made a rejected API call indistinguishable from
        // "no such address", so a misconfigured key looked like every address in
        // North America having vanished. The reason goes back to the caller.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mileage.searchPlaces] "${input.query}": ${message}`);
        return { available: true as const, items: [], error: message };
      }
    }),

  /**
   * Up to three driving routes across the ordered stops, through any points the
   * traveller dragged the route through, for the traveller to pick from.
   *
   * `via` is those points as place IDs (`pointToPlace` made them), each on its leg, in
   * route order; stops plus points stay within the same 25 (`viaIssue`, shared with Save,
   * so a route this accepts is one Save accepts). They travel to Google as `{ placeId,
   * via: true }` waypoints — never as a coordinate — and are not echoed back. The input is
   * `.strict()`, and so is each `via` entry: a coordinate, an older client's lat/lng points
   * or any other key is refused (BAD_REQUEST) before anything is counted, rather than
   * dropped and routed without.
   *
   * Order matters: the permission, then whether lookup is configured at all, then the
   * per-person limit — all before anything is sent to Google, so a refused call costs
   * nothing. Each route is rebuilt field by field: nothing from Google's JSON or the
   * config is spread onto the wire. The drawn path goes to the browser for the picker's
   * map in this session only; Save never stores it (the write schema names no path). It
   * is null when it is over the cap or off the charset, and it is never logged.
   *
   * Refusals:
   *   · Google refused a place ID it was asked to route through (`isRefusedViaPlace`),
   *     on a request that carried at least one `via` → BAD_REQUEST with the refusal key
   *     `mileage.viaPlaceRefused` (spec TR-13 check 1). The modal tells it apart by that
   *     key — never by the code, which zod's input refusals share — and may convert its
   *     newest Roads point once more through Geocoding and route again. No `cause` but the
   *     refusal, and our own words (security C7).
   *   · Any other Google failure → INTERNAL_SERVER_ERROR, redacted, no `cause`.
   */
  computeRoutes: mileageProcedure
    .input(
      z
        .object({
          placeIds: z.array(z.string().min(1).max(MAX_PLACE_ID)).min(2).max(MAX_ROUTE_STOPS),
          unit: z.enum(['KM', 'MI']),
          via: z.array(routeViaSchema.strict()).max(MAX_VIA).default([]),
        })
        .strict()
        .superRefine((input, zctx) => {
          const issue = viaIssue(input.placeIds.length, input.via);
          if (issue) zctx.addIssue({ code: 'custom', message: issue, path: ['via'] });
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) throw lookupNotConfigured();
      await countRouteLookup(ctx.session.user.id);

      let routes: Awaited<ReturnType<typeof computeRoutes>>;
      try {
        routes = await computeRoutes(
          cfg,
          input.placeIds,
          input.via.map((v) => ({ placeId: v.placeId, leg: v.leg })),
        );
      } catch (err) {
        if (input.via.length > 0 && isRefusedViaPlace(err)) {
          throw refusal(
            'BAD_REQUEST',
            REFUSAL_KEYS.mileageViaPlaceRefused,
            'Google could not route through a point the route was dragged through.',
          );
        }
        // Still an INTERNAL_SERVER_ERROR, so the person sees the generic "something went
        // wrong" and the reason reaches the server log — but redacted, and without the
        // raw error as `cause`, which the error formatter would log unredacted.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Route lookup failed: ${mapsError(err)}`,
        });
      }

      return {
        routes: routes.map((r) => ({
          index: r.index,
          label: r.label,
          totalMeters: r.totalMeters,
          // Pre-formatted in the unit the form is showing at the time of the press.
          distance: metersToDistance(r.totalMeters, input.unit),
          durationSeconds: r.durationSeconds,
          legs: r.legs.map((l) => ({
            fromPlaceId: l.fromPlaceId,
            toPlaceId: l.toPlaceId,
            meters: l.meters,
          })),
          encodedPolyline: r.encodedPolyline,
        })),
      };
    }),

  /**
   * A point the traveller dropped on the route, as a Google place ID the route can pass
   * through and the line can keep (spec FR-2). Roads first, Geocoding when Roads cannot
   * help; `method: 'geocoding'` skips Roads (`placeForPoint`).
   *
   * A mutation, so the coordinate travels in a POST body and never in a GET query string
   * an access log keeps (security C3). Order, as `computeRoutes`: the permission, whether
   * lookup is configured, then ONE count against the per-person limit — before anything
   * is sent to Google, so a refused call costs nothing; one count however many of the two
   * APIs answer it.
   *
   * Answers `{ placeId, location, source }`, built by name. `location` is where Google puts
   * that place, for the marker in this modal session only: it is never stored, and Save
   * takes only the place ID. Refusals carry our own words and a catalog key, never
   * Google's text (security C7):
   *   · nothing near the point          → NOT_FOUND, `mileage.noRoadNear`;
   *   · the key may not use the API(s)  → PRECONDITION_FAILED, `mileage.dragApisUnavailable`
   *                                        with `{ apis }`, naming only those refused;
   *   · any other Google failure        → INTERNAL_SERVER_ERROR, redacted, no `cause`.
   */
  pointToPlace: mileageProcedure
    .input(
      z
        .object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          method: z.enum(['auto', 'geocoding']).default('auto'),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) throw lookupNotConfigured();
      await countRouteLookup(ctx.session.user.id);

      let outcome: Awaited<ReturnType<typeof placeForPoint>>;
      try {
        outcome = await placeForPoint(cfg, { lat: input.lat, lng: input.lng }, input.method);
      } catch (err) {
        // As `computeRoutes`: redacted, and without the raw error as `cause`.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Point lookup failed: ${mapsError(err)}`,
        });
      }

      if (outcome.kind === 'none') {
        throw refusal(
          'NOT_FOUND',
          REFUSAL_KEYS.mileageNoRoadNear,
          'No road or address was found near that point.',
        );
      }
      if (outcome.kind === 'refused') {
        const apis = outcome.apis.join(', ');
        throw refusal(
          'PRECONDITION_FAILED',
          REFUSAL_KEYS.mileageDragApisUnavailable,
          `Dragging a route needs ${apis} enabled on the Maps Platform key.`,
          { apis },
        );
      }
      return {
        placeId: outcome.placeId,
        location: { lat: outcome.location.lat, lng: outcome.location.lng },
        source: outcome.source,
      };
    }),

  /**
   * Where a reopened route's `via` points are, for the modal's markers (spec FR-4 step 3):
   * one Place Details request per point, with the location field alone, when Change route
   * or a previous route opens the modal on a stored route. Never on a line-map view.
   *
   * One batched call, so the server — which owns the paid-call budget — sees every ID:
   * duplicates are looked up once, and the answer has one entry per distinct ID, in the
   * order first asked. A mutation, so it is never prefetched, cached or retried.
   *
   * Order: the permission, whether lookup is configured, then the counts — all before
   * Google, so a refused call costs nothing (C6). Then ONE count per distinct ID, taken in
   * order and before any request; the first ID over the limit stops the counting, and it
   * and every ID after it come back `throttled` with no request. An ID that may not go
   * into a Google URL (security C1) is `unresolved` with no count and no request. Then up
   * to `VIA_LOOKUPS_IN_FLIGHT` requests at a time.
   *
   * A point that cannot be placed is data, never a throw: the route is still drawn through
   * it, and the modal lists it without a marker (FR-4 3.A, 3.B). Thrown only before any
   * count: FORBIDDEN, BAD_REQUEST (input), PRECONDITION_FAILED (not configured).
   *
   * Each `location` is for this modal session only. Nothing is written — no row, no audit
   * entry, no cache — and no location is logged (NFR-9).
   */
  viaLocations: mileageProcedure
    .input(
      z
        .object({
          placeIds: z.array(routeViaSchema.shape.placeId).min(1).max(MAX_VIA),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }): Promise<{ results: ViaLocation[] }> => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) throw lookupNotConfigured();

      const placeIds = [...new Set(input.placeIds)];
      const results: ViaLocation[] = [];
      const toLocate: number[] = [];
      let overLimit = false;
      for (const [i, placeId] of placeIds.entries()) {
        if (!isUrlSafePlaceId(placeId)) {
          results[i] = { placeId, location: null, reason: 'unresolved' };
          continue;
        }
        if (!overLimit) overLimit = !(await takeRouteLookup(ctx.session.user.id));
        if (overLimit) {
          results[i] = { placeId, location: null, reason: 'throttled' };
          continue;
        }
        toLocate.push(i);
      }

      // A small pool: `locateVia` never throws, so no request is left unawaited.
      let next = 0;
      const worker = async () => {
        while (next < toLocate.length) {
          const i = toLocate[next++] as number;
          results[i] = await locateVia(cfg, placeIds[i] as string);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(VIA_LOOKUPS_IN_FLIGHT, toLocate.length) }, worker),
      );
      return { results };
    }),

  /**
   * The path of a saved line's route, to draw its small map on this view (spec FR-3). The
   * writer's line view calls it once per mounted line map; nothing about the answer is
   * kept — not on the row, not in a cache — so the next view asks again.
   *
   * Read-only: it writes no row and no audit entry, so the line's distance, legs, amount
   * and `updatedAt` are exactly as filed (NFR-9). A mutation, never a query, so it is never
   * prefetched, cached or retried by the client, and never sent as a GET. The input is the
   * line id and nothing else (security C5): every stop comes from the row.
   *
   * Order: the permission, then the line is the caller's to write on an editable report
   * (`assertExpenseDraft` — NOT_FOUND for anybody else, `reportNotEditable` once filed),
   * then whether there is anything to route — then whether lookup is configured and ONE
   * count against the per-person limit, all before Google (C6), so a refused call costs
   * nothing.
   *
   * Routes the stored named stops through the stored `via` place IDs, so the map draws the
   * route that was filed. With two stops and no `via` Google may offer up to three routes;
   * the one drawn is the one closest in distance to what the line claims
   * (`pickClosestRoute`), so the map beside a 412 km claim is the 415 km route. With a
   * `via` there is one route, and it is drawn.
   *
   * Answers `{ encodedPolyline }`, null when there is nothing to draw: not a mileage line,
   * no route, a stop without a place ID or a stored `via` Save would not accept (no call,
   * no count), no route from Google, no route whose path could be sent, Google's NOT_FOUND
   * on a stale place ID, or Google refusing a stored `via` place ID. Any other Google
   * failure is a redacted INTERNAL_SERVER_ERROR. The path is never logged.
   */
  lineRoutePath: mileageProcedure
    .input(z.object({ lineItemId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const line = await readPathLine(ctx.db, input.lineItemId);
      if (!line) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertExpenseDraft(ctx, line.expenseId);

      const placeIds = line.kind === 'MILEAGE' ? storedStopPlaceIds(line.route) : null;
      const via = placeIds ? storedVia(line.route, placeIds.length) : null;
      if (!placeIds || !via) return { encodedPolyline: null };

      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) throw lookupNotConfigured();
      await countRouteLookup(ctx.session.user.id);

      let routes: Awaited<ReturnType<typeof computeRoutes>>;
      try {
        routes = await computeRoutes(cfg, placeIds, via);
      } catch (err) {
        // A stale place ID, or a stored `via` Routes will not route through: the line keeps
        // its text summary, with no error.
        if (!isUnroutableWaypoint(err) && !(via.length > 0 && isRefusedViaPlace(err))) {
          // As `computeRoutes`: redacted, and without the raw error as `cause`.
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Route path lookup failed: ${mapsError(err)}`,
          });
        }
        routes = [];
      }

      const picked = pickClosestRoute(
        routes.filter((r) => r.encodedPolyline !== null),
        claimedMeters({
          mileageDistance: line.distance,
          mileageDistanceOverride: line.override,
          mileageUnit: line.unit === 'MI' ? 'MI' : line.unit === 'KM' ? 'KM' : null,
        }),
      );
      return { encodedPolyline: picked?.encodedPolyline ?? null };
    }),
});

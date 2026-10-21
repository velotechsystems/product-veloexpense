/**
 * The stored mileage route — one definition for the editor that builds it, the
 * save path that checks it and the approver view that reads it back.
 *
 * Why it lives in `lib/` and imports nothing but zod. The editor ships to the
 * browser and needs the same bounds and the same `RouteValue` type the server
 * checks; anything under `server/` drags the database and secrets code with it.
 * `mileageRouteSchema.test.ts` pins the imports to `zod` alone, so a convenience
 * import cannot quietly pull server code into the client bundle.
 *
 * Two schemas, on purpose:
 *   · **Write** (`mileageRouteWriteSchema`) — strict. `expenses.lineItemCreate` and
 *     `lineItemUpdate` parse the route with it and store ONLY its output, rebuilt
 *     field by field: an unknown key (a stop's lat/lng, say) is dropped, never stored.
 *     It is a superset of every route the editor has ever written — stops with or
 *     without a place id, empty descriptions, optional legs — so a line saved
 *     before this schema existed saves again unchanged.
 *   · **Read** (`mileageRouteReadSchema`) — lenient where the old rows need it. A
 *     malformed leg hides the route distance, never the stops, so `legs` and
 *     `placeId` are read loosely and checked only by `routeChainMeters`. Every
 *     value the write schema accepts also passes here (a test pins it).
 *
 * `routeLabel`, `routeIndex` and `routeCount` record which of Google's routes the
 * traveller picked and how many were offered. They are claimant-written text and
 * numbers: an approver sees them "as filed", never as verified. An empty label is
 * stored as NO key — never `''`, `null` or a made-up "Route 2": the reader shows
 * nothing for it, and a picker renders its own fallback at display time.
 *
 * A route is stored as its claim and nothing Google drew (ADR 0020). The only
 * Google-derived values in it are place IDs — on the stops, on the legs and in `via` —
 * because a place ID is the one Google value its terms let us keep indefinitely. No
 * drawn path, no coordinate and no Google timestamp is named here, so none can be
 * stored: a client that still sends one has it dropped silently by the plain
 * `z.object`, and its save goes through with whatever else was valid. The server holds
 * the column to the same keys a second way (`storedRoute` in
 * `server/lib/mileageRouteView.ts`), on every write and on the writer's read.
 *
 * `via` is each point the route was dragged through, kept as a Google place ID and the
 * leg it lies on, in route order. The route lookup routes through those place IDs, so
 * the route the traveller accepted is the route that is stored and priced; `via` never
 * changes the price, which comes from `legs`. It is held to the pass-through rules
 * (`viaIssue`) — out of range, out of order or past the shared 25-stop limit IS refused,
 * since the honest editor cannot produce one — an empty list is stored as NO key, and
 * anything else on an entry (the modal's session-only snapped `lat`/`lng`) is dropped
 * on save.
 */

import { z } from 'zod';

/** Most stops a route may carry — the same bound the route lookup puts on the
 *  place ids it measures. */
export const MAX_ROUTE_STOPS = 25;
/** Longest stop description stored or sent to an approver. */
export const MAX_STOP_DESCRIPTION = 300;
/** Longest route label ("via Hwy 401") stored or sent to an approver. */
export const MAX_ROUTE_LABEL = 120;
/** Longest Google place id accepted on write. */
export const MAX_PLACE_ID = 500;
/** One leg can be no longer than the Earth's circumference, in metres. */
export const MAX_LEG_METERS = 40_075_000;
/** Most alternative routes the picker offers. */
export const MAX_ROUTES_OFFERED = 3;

/** No C0/C1 control characters (`\p{Cc}`): a place id or a label is one line of text. */
const NO_CONTROL_CHARACTERS = /^\P{Cc}*$/u;

const placeIdSchema = z.string().min(1).max(MAX_PLACE_ID).regex(NO_CONTROL_CHARACTERS);

/** One stop. `description` may be empty: an untouched From/To row is `''`. */
export const routeStopSchema = z.object({
  placeId: placeIdSchema.optional(),
  description: z.string().max(MAX_STOP_DESCRIPTION),
});

/** One leg of the chosen route, from a lookup. */
export const routeLegSchema = z.object({
  fromPlaceId: placeIdSchema,
  toPlaceId: placeIdSchema,
  // `z.number()` already refuses NaN and ±Infinity (zod 4).
  meters: z.number().min(0).max(MAX_LEG_METERS),
});

/**
 * The route label as stored: trimmed, at most `MAX_ROUTE_LABEL`, one line. `null`,
 * `''` and whitespace become `undefined`, which the route builders below turn into
 * an absent key. Shared by both schemas, so a label the write path refuses is one
 * the read path refuses too.
 */
const routeLabelSchema = z
  .string()
  .trim()
  .max(MAX_ROUTE_LABEL)
  .regex(NO_CONTROL_CHARACTERS)
  .nullish()
  .transform((label) => (label ? label : undefined));

/** Most `via` points: the 25-stop limit less a From and a To. */
export const MAX_VIA = MAX_ROUTE_STOPS - 2;

/**
 * One point the route passes through, as a Google place ID on the leg it lies on
 * (`stops[leg] -> stops[leg + 1]`). The place ID gets the same check as a stop's. A plain
 * `z.object`, so an unknown key on an entry — the modal's session-only snapped `lat`/`lng`
 * — is dropped, never stored. The URL-safe charset a place ID must also have before it is
 * put in a Google URL is checked at the Google client, which stored values reach too.
 */
export const routeViaSchema = z.object({
  placeId: placeIdSchema,
  leg: z
    .int()
    .min(0)
    .max(MAX_ROUTE_STOPS - 2),
});

export type RouteVia = z.output<typeof routeViaSchema>;

/**
 * What is wrong with these pass-through points (`via`) on a route of `stopCount` stops,
 * or null when nothing is. Shared by the write schema and the route lookup's input, so a
 * route the lookup accepts is one Save accepts. The messages keep the traveller's word, "pass-through points".
 *
 *   · stops plus points may not exceed `MAX_ROUTE_STOPS` — the same 25 the stops alone
 *     are held to, so the editor's existing "at most 25 stops" stays true;
 *   · every point lies on a leg of THIS route (`leg < stopCount - 1`);
 *   · points are listed in route order: `leg` never decreases along the array.
 */
export function viaIssue(
  stopCount: number,
  points: readonly { leg: number }[] | undefined,
): string | null {
  if (!points || points.length === 0) return null;
  if (stopCount + points.length > MAX_ROUTE_STOPS) {
    return `A route can have at most ${MAX_ROUTE_STOPS} stops`;
  }
  if (points.some((p) => p.leg >= stopCount - 1)) {
    return 'Pass-through points must lie on a leg of the route';
  }
  if (points.some((p, i) => i > 0 && p.leg < (points[i - 1] as { leg: number }).leg)) {
    return 'Pass-through points must follow the route order';
  }
  return null;
}

export type RouteStop = z.output<typeof routeStopSchema>;
export type RouteLeg = z.output<typeof routeLegSchema>;

/** A mileage line's route, as the editor builds it and the server stores it. */
export interface RouteValue {
  stops: RouteStop[];
  /** Per-leg metres of the chosen route, from the lookup. */
  legs?: RouteLeg[];
  /** Google's own name for the chosen route ("via Hwy 401"). Absent when Google gave none. */
  routeLabel?: string;
  /** Position of the chosen route among those offered, 0-based. */
  routeIndex?: number;
  /** How many routes were offered. */
  routeCount?: number;
  /** Points the route passes through, as place IDs, in route order. Absent when none. */
  via?: RouteVia[];
}

/**
 * The strict write schema. Its output is the only thing ever stored: rebuilt by
 * name, so no key the schema does not name survives, and an absent optional field
 * is an absent key rather than `undefined` or `null`.
 */
export const mileageRouteWriteSchema = z
  .object({
    stops: z.array(routeStopSchema).min(2).max(MAX_ROUTE_STOPS),
    // A chain of N stops has N - 1 legs. No chain check here: an old line whose legs
    // no longer match its stops must still save; the read side decides what they mean.
    legs: z
      .array(routeLegSchema)
      .max(MAX_ROUTE_STOPS - 1)
      .optional(),
    routeLabel: routeLabelSchema,
    routeIndex: z
      .int()
      .min(0)
      .max(MAX_ROUTES_OFFERED - 1)
      .optional(),
    routeCount: z.int().min(1).max(MAX_ROUTES_OFFERED).optional(),
    via: z.array(routeViaSchema).max(MAX_VIA).optional(),
  })
  .refine(
    (r) => r.routeIndex === undefined || r.routeCount === undefined || r.routeIndex < r.routeCount,
    { message: 'The chosen route must be one of those offered.', path: ['routeIndex'] },
  )
  .superRefine((r, ctx) => {
    const via = viaIssue(r.stops.length, r.via);
    if (via) ctx.addIssue({ code: 'custom', message: via, path: ['via'] });
  })
  .transform(
    (r): RouteValue => ({
      stops: r.stops.map((s) => ({
        ...(s.placeId !== undefined ? { placeId: s.placeId } : {}),
        description: s.description,
      })),
      ...(r.legs !== undefined
        ? {
            legs: r.legs.map((l) => ({
              fromPlaceId: l.fromPlaceId,
              toPlaceId: l.toPlaceId,
              meters: l.meters,
            })),
          }
        : {}),
      ...(r.routeLabel !== undefined ? { routeLabel: r.routeLabel } : {}),
      ...(r.routeIndex !== undefined ? { routeIndex: r.routeIndex } : {}),
      ...(r.routeCount !== undefined ? { routeCount: r.routeCount } : {}),
      // An empty list is no key — never `[]` or `null`: a route without pass-through
      // points reads the same as one saved before `via` existed.
      ...(r.via !== undefined && r.via.length > 0
        ? { via: r.via.map((v) => ({ placeId: v.placeId, leg: v.leg })) }
        : {}),
    }),
  );

/**
 * The lenient read schema, for a route as stored (whatever the write path accepted
 * when it was saved). Descriptions and the label are typed and capped: a route that
 * fails here is shown as unavailable, never trimmed to fit. `placeId` and `legs` are
 * read loosely — they feed only `routeChainMeters`. A `routeCount` that is not an
 * integer 1–3 is dropped rather than failing the route; `routeIndex` is not read.
 *
 * It deliberately names no `via`. It is a plain `z.object`, so `via` — and any key an
 * old row may still carry — is stripped from everything it parses: the approver's view
 * cannot carry the points a route passes through, by construction.
 */
export const mileageRouteReadSchema = z.object({
  stops: z.array(routeStopSchema.extend({ placeId: z.unknown().optional() })).max(MAX_ROUTE_STOPS),
  legs: z.unknown().optional(),
  routeLabel: routeLabelSchema,
  routeCount: z.int().min(1).max(MAX_ROUTES_OFFERED).optional().catch(undefined),
});

export type StoredRoute = z.output<typeof mileageRouteReadSchema>;

/** Legs as the read side accepts them: looser than on write, checked by the chain. */
const storedLegsSchema = z
  .array(
    z.object({
      fromPlaceId: z.string().min(1),
      toPlaceId: z.string().min(1),
      meters: z.number(),
    }),
  )
  .min(1)
  // A chain of N stops has N - 1 legs; more than the stop cap allows is not a route.
  .max(MAX_ROUTE_STOPS - 1);

/**
 * Total metres of `legs`, or null when they do not describe THESE stops.
 *
 * The editor clears the legs on every stop edit and only a lookup rewrites them,
 * so a normal save cannot carry stale legs. Old rows were stored unchecked, though,
 * so the check is made here regardless: the legs must form one chain (each leg
 * starts where the previous ended), every leg's metres must be a finite number ≥ 0,
 * and the chain's place ids must be exactly the stops' place ids, in order. Every
 * stop must have one — a lookup only runs once every stop is a real place, so a
 * hand-typed stop beside legs means the legs are not its own.
 */
export function routeChainMeters(
  stops: readonly { placeId?: unknown }[],
  legs: unknown,
): number | null {
  const parsed = storedLegsSchema.safeParse(legs);
  if (!parsed.success) return null;
  const chain = parsed.data;
  if (stops.length !== chain.length + 1) return null;

  let total = 0;
  for (const [i, leg] of chain.entries()) {
    if (!Number.isFinite(leg.meters) || leg.meters < 0) return null;
    if (leg.fromPlaceId !== stops[i]?.placeId) return null;
    if (leg.toPlaceId !== stops[i + 1]?.placeId) return null;
    total += leg.meters;
  }
  return total;
}

/** Metres → a "123.45" distance string in the requested unit. */
export function metersToDistance(meters: number, unit: 'KM' | 'MI'): string {
  const value = unit === 'MI' ? meters / 1609.344 : meters / 1000;
  return value.toFixed(2);
}

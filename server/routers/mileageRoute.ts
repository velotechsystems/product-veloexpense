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
 * VeloExpense: ExpenseOS's router (550b2945), unchanged, ported with w2-10. The key comes
 * from the environment only until the integrations screen is ported (see
 * `server/platform/googleMaps.ts`), so on a deployment with none every procedure answers
 * `available: false`, as above.
 */

import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  computeRoute,
  getMapsConfig,
  metersToDistance,
  searchPlaces,
} from '@/server/platform/googleMaps';
import { router, withPermission } from '@/server/trpc';

const mileageProcedure = withPermission(P.expense.report.updateOwn);

export const mileageRouteRouter = router({
  /** Whether address lookup is usable, so the form knows which shape to render
   *  before the user types anything. */
  status: mileageProcedure.query(async ({ ctx }) => {
    const cfg = await getMapsConfig(ctx.db);
    return { available: cfg !== null };
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
   * Driving distance across the ordered stops.
   *
   * Returns the legs as well as the total: a route the traveller can check is a
   * route they can correct, and an auditor looking at a long claim wants to see
   * which hop accounts for it.
   */
  computeRoute: mileageProcedure
    .input(
      z.object({
        placeIds: z.array(z.string().min(1).max(500)).min(2).max(25),
        unit: z.enum(['KM', 'MI']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await getMapsConfig(ctx.db);
      if (!cfg) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Address lookup is not configured. Enter the distance manually.',
        });
      }
      const route = await computeRoute(cfg, input.placeIds);
      return {
        legs: route.legs,
        totalMeters: route.totalMeters,
        // Pre-formatted in the unit the form is showing, so the client isn't
        // re-deriving a number the server already knows.
        distance: metersToDistance(route.totalMeters, input.unit),
      };
    }),
});

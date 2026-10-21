'use client';

/**
 * What is left of the saved line's inline route editor, now that a saved line changes its
 * route through the workspace (`RouteLine` → `RoutePickerModal`, FR-6):
 *
 *   · `RouteSummary` — a route as one line of text, for lookup off, for a line with no map,
 *     and for the approver's `MileageLineDetail`;
 *   · `EMPTY_ROUTE` and `LOCKED_FIELD`, which the typed path still uses;
 *   · the route shape, re-exported so the workbench keeps importing it from here.
 */

import type { RouteValue } from '@/lib/mileageRouteSchema';

/**
 * The route shape is defined once, beside the schema the server checks it with
 * (`lib/mileageRouteSchema.ts`). Re-exported so the workbench keeps importing it from here.
 */
export type { RouteValue };

/**
 * How a field reads while its saved line is locked (FR-6): still a real `disabled` input,
 * but in the muted text token on the muted surface instead of the primitive's
 * `opacity-50`. Half-opacity grey text fails contrast, and a locked distance is still the
 * claim the traveller has to be able to read. `muted-foreground` on `muted` is about
 * 5.1:1 by the token values in `globals.css` (light theme; there is no dark one).
 */
export const LOCKED_FIELD =
  'disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100';

/** A route always has at least an origin and a destination, even when empty. */
export const EMPTY_ROUTE: RouteValue = { stops: [{ description: '' }, { description: '' }] };

/**
 * A route already on the line, as text: when address lookup is off, when the line has no
 * map, and in the approver's view.
 *
 * Collection stops when the integration does; DISPLAY doesn't. A route recorded
 * while it was on is part of a filed claim, and hiding it because a setting
 * changed later would lose evidence an approver may be relying on.
 */
export function RouteSummary({ value }: { value: RouteValue }) {
  const named = value.stops.filter((s) => s.description.trim());
  if (named.length === 0) return null;
  return (
    <p className="text-muted-foreground text-xs">{named.map((s) => s.description).join(' → ')}</p>
  );
}

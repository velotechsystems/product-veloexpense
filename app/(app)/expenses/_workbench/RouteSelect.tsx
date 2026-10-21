'use client';

/**
 * THE route dropdown (FR-1, FR-6): New route, then a "Previous routes" group with up to five
 * of the person's own routes, newest first. The same control sits on a new mileage line, on
 * a saved one, and at the top of the workspace panel. On a saved line it opens with
 * **Change route** above New route, and its closed state reads the line's route. In the
 * workspace panel it has no New route (`includeNewRoute={false}`, spec FR-6 step 2): the
 * workspace is already where a route is made, so the panel's dropdown is previous routes only.
 *
 * Every entry is an ACTION, not a value: each opens (or, in the panel, replaces) the
 * workspace. So the Select is controlled with no value at all and its change event is the
 * action, so New route opens the workspace however many times it is chosen.
 *
 * The group title is the design-system `SelectGroupLabel`: the group is announced by it
 * ("Previous routes, group") and it is never read as an option. With no previous routes
 * there is no group and no empty title (FR-1 3.A).
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import type { ReactNode, Ref } from 'react';
import type { PreviousRoute } from './routeWorkspace';

/** The dropdown's own value for New route — never a position in the list. */
const NEW_ROUTE = 'new';
/** Change route's own value: distinct, so picking it twice in a row opens it twice. */
const CHANGE_ROUTE = 'change';

/** At most this many previous routes are offered (the server sends no more). */
export const MAX_PREVIOUS_ROUTES = 5;

export function RouteSelect({
  entries,
  onChangeRoute,
  includeNewRoute = true,
  onNewRoute,
  onPrevious,
  disabled,
  triggerRef,
  triggerId,
  label,
  placeholder,
}: {
  entries: readonly PreviousRoute[];
  /** A saved line's route: offered first as Change route, which reopens it (FR-6). */
  onChangeRoute?: () => void;
  /** Offer New route (default). The workspace panel's dropdown leaves it out. */
  includeNewRoute?: boolean;
  /** New route was picked; needed only when it is offered. */
  onNewRoute?: () => void;
  onPrevious: (entry: PreviousRoute) => void;
  disabled?: boolean;
  /** Where focus returns when the workspace closes (NFR-12). */
  triggerRef?: Ref<HTMLButtonElement>;
  /** For a visible `<label htmlFor>` beside it. */
  triggerId?: string;
  /** The trigger's accessible name; omit when a visible label names it. */
  label?: string;
  /** What the closed trigger reads: a placeholder, or a saved line's route. */
  placeholder: ReactNode;
}) {
  const t = useTranslations('expenses.route');
  const shown = entries.slice(0, MAX_PREVIOUS_ROUTES);

  const ends = (entry: PreviousRoute) =>
    t('previousRouteEnds', {
      from: entry.stops[0]?.description ?? '',
      to: entry.stops[entry.stops.length - 1]?.description ?? '',
    });
  /** Intermediate stops and the stored label, when there are any; nothing made up. */
  const detail = (entry: PreviousRoute) => {
    const between = entry.stops.length - 2;
    const stops = between > 0 ? t('previousRouteStops', { count: between }) : null;
    const via = entry.routeLabel ? t('picker.via', { label: entry.routeLabel }) : null;
    if (stops && via) return t('previousRouteDetail', { stops, via });
    return stops ?? via;
  };

  const choose = (next: string) => {
    if (!next) return;
    if (next === CHANGE_ROUTE) {
      onChangeRoute?.();
      return;
    }
    if (next === NEW_ROUTE) {
      onNewRoute?.();
      return;
    }
    const entry = shown[Number(next)];
    if (entry) onPrevious(entry);
  };

  return (
    // VeloExpense: the kit's Select is Radix, not Base UI. Radix has no `null` value: the
    // empty string is its "nothing chosen" (the placeholder shows), and it never equals an
    // item's value, so every press is a change and `onValueChange` fires each time, as
    // Base UI's does. The placeholder is `SelectValue`'s own prop rather than a render
    // function.
    <Select value="" onValueChange={choose} disabled={disabled}>
      <SelectTrigger ref={triggerRef} id={triggerId} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {onChangeRoute && <SelectItem value={CHANGE_ROUTE}>{t('changeRoute')}</SelectItem>}
        {includeNewRoute && <SelectItem value={NEW_ROUTE}>{t('newRoute')}</SelectItem>}
        {shown.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>{t('previousRoutes')}</SelectGroupLabel>
            {shown.map((entry, i) => {
              const more = detail(entry);
              return (
                // At most five, replaced whole, so a position is a stable enough key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <SelectItem key={i} value={String(i)}>
                  <span className="block">{ends(entry)}</span>
                  {more && <span className="block text-muted-foreground text-xs">{more}</span>}
                </SelectItem>
              );
            })}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

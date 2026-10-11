'use client';

/**
 * The mileage inputs a line needs: a distance, the unit it was entered in, and
 * the route that measured it.
 *
 * ONE component, used by both the add-a-line form and the edit-a-line row.
 *
 * That is the whole point of it. The two forms each had their own copy, and only
 * the edit row ever got the unit toggle and the route picker — so a traveller
 * adding a mileage line saw a bare box hinting "km" with no way to say miles, and
 * the add path never sent `mileageUnit` at all. The server falls back to the
 * rule's unit when it isn't told, so 100 entered as miles was priced as 100 km:
 * a wrong reimbursement, not just a missing control. Two copies of one form is
 * how that happened, so there is now one.
 */

import { Input } from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import type React from 'react';
import { useEffect, useState } from 'react';
import { type CurrencyLike, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { EMPTY_ROUTE, RouteEditor, RouteSummary, type RouteValue } from './RouteEditor';

export type DistanceUnit = 'KM' | 'MI';

/** A distance is a positive decimal with at most two places. */
export function isValidDistance(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value.trim());
}

/**
 * Kilometres per mile, matching `convertScaled` on the server exactly.
 *
 * Duplicated rather than imported because the server module reaches for Prisma,
 * and a form must not drag the database client into the browser bundle. The
 * number is a definition, not a policy, so it cannot drift — but the two are
 * cross-checked in the tests.
 */
const KM_PER_MI = 1.609344;

/**
 * Restate a measured distance in the other unit.
 *
 * Only ever applied to a distance the ROUTE produced. A hand-typed number is not
 * converted: type 100 and switch to MI and you meant a hundred miles, whereas a
 * measured 100 km IS 62.14 mi. Same control, two honest meanings, depending on
 * where the number came from.
 */
export function convertDistance(value: string, from: DistanceUnit, to: DistanceUnit): string {
  if (from === to) return value;
  const trimmed = value.trim();
  // `Number('')` is 0, not NaN — without this an empty field would convert itself
  // into "0.00" and start claiming a zero-distance trip.
  if (trimmed === '') return value;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return value;
  const converted = from === 'MI' ? n * KM_PER_MI : n / KM_PER_MI;
  // Two places, the same precision the field accepts and the server parses.
  return converted.toFixed(2);
}

/**
 * Hold a value still until it stops changing.
 *
 * The priced amount is a server round-trip, and the distance changes per keystroke:
 * typing "25.66" is five values, of which only the last is worth pricing.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface MileageFieldsProps {
  distance: string;
  onDistanceChange: (value: string) => void;
  unit: DistanceUnit;
  onUnitChange: (unit: DistanceUnit) => void;
  route: RouteValue;
  onRouteChange: (route: RouteValue) => void;
  /**
   * A distance the ROUTE measured, as distinct from one that was typed.
   *
   * Separate because the edit row saves on blur but a measured distance arrives
   * without one — it has to commit immediately, or the field would show a figure
   * the server hasn't priced. Typing must not commit per keystroke, hence two
   * callbacks rather than one. Defaults to `onDistanceChange`.
   */
  onMeasuredDistance?: (value: string) => void;
  /** Called when the distance field loses focus — the edit row commits here; the
   *  add form has an explicit Save and passes nothing. */
  onDistanceBlur?: () => void;
  onDistanceFocus?: () => void;
  disabled?: boolean;
  /**
   * Caller controls that belong on the same line as the distance — the edit row's
   * delete button.
   *
   * They have to be rendered HERE rather than after the component, because the
   * From/To block is full-width: anything following it wraps onto a line of its own.
   * That is what pushed the amount and the trash icon below the route instead of
   * leaving them where every other line item puts them. Ordering the row is this
   * component's job, so the slot is this component's to offer.
   */
  trailing?: React.ReactNode;
  /**
   * What the distance is worth, priced live by the server.
   *
   * Omit `expenseId`/`categoryId` and no figure is shown — the amount is derived
   * from the traveller and the date, so there is nothing to compute without the
   * expense it belongs to.
   */
  pricing?: {
    expenseId: string;
    categoryId: string | null;
    /** Set on an existing line, so its own distance leaves the YTD basis. */
    lineItemId?: string;
    /** The expense's currency — mileage rates are denominated in it. */
    currency: CurrencyLike;
    /**
     * What an existing line already carries, and the distance it was priced from.
     *
     * Shown immediately while the distance is untouched, so an already-saved line
     * doesn't blink through an em dash on every mount waiting for a round-trip.
     * The distance is part of it deliberately: the saved amount is only the right
     * answer for the saved distance, so the moment the field differs this stops
     * being used rather than sitting there as a stale figure.
     */
    saved?: { amountMinor: string; distance: string } | null;
  };
}

export function MileageFields({
  distance,
  onDistanceChange,
  unit,
  onUnitChange,
  route,
  onRouteChange,
  onMeasuredDistance,
  onDistanceBlur,
  onDistanceFocus,
  disabled,
  pricing,
  trailing,
}: MileageFieldsProps) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  // Deduped by react-query, so every row asking is one request for the page.
  const routeLookup = trpc.mileageRoute.status.useQuery();
  const routeAvailable = routeLookup.data?.available ?? false;
  const hasStoredRoute = route.stops.some((s) => s.description.trim());
  const valid = isValidDistance(distance);

  // Priced off the SETTLED distance, and only once there is a valid one to price.
  const settledDistance = useSettled(distance.trim(), 400);
  /**
   * The saved amount answers for the saved distance and nothing else — so while the
   * field still holds it, there is nothing to ask the server. This is what keeps a
   * report with thirty mileage lines from firing thirty pricing requests on open to
   * recompute figures it was already sent.
   */
  const savedIsCurrent = pricing?.saved != null && pricing.saved.distance === distance.trim();
  const priceable =
    Boolean(pricing?.categoryId) && isValidDistance(settledDistance) && !savedIsCurrent;
  const preview = trpc.expenses.mileagePreview.useQuery(
    {
      expenseId: pricing?.expenseId ?? '',
      categoryId: pricing?.categoryId ?? '',
      mileageDistance: settledDistance,
      mileageUnit: unit,
      lineItemId: pricing?.lineItemId,
    },
    { enabled: Boolean(pricing) && priceable, staleTime: 30_000 },
  );
  /**
   * The figure goes stale the moment the distance changes, and a number that lags
   * the field it describes is worse than no number — it is the OLD amount sitting
   * beside the NEW distance, which reads as the answer. So a live price counts only
   * while the query's input still matches what is on screen.
   */
  const priceIsCurrent = settledDistance === distance.trim();
  const livePrice = preview.data?.ok && priceIsCurrent ? preview.data.amountMinor : null;
  const priceRefusal = preview.data?.ok === false && priceIsCurrent ? preview.data.reason : null;
  const shownAmount = savedIsCurrent ? (pricing?.saved?.amountMinor ?? null) : livePrice;
  /** Between a changed distance and its price arriving. Neither figure is true yet. */
  const pricePending = shownAmount == null && priceable && !priceRefusal;

  return (
    <>
      {routeAvailable ? (
        // With address lookup on, the distance is MEASURED, not typed — the route
        // below produces it. Showing an editable box invites a number that
        // contradicts the stops right underneath it.
        <span className="flex h-10 min-w-24 items-center justify-end px-2 text-right">
          {distance ? (
            <span className="font-medium text-foreground text-sm tabular-nums">{distance}</span>
          ) : (
            <span className="text-muted-foreground text-xs">{t('line.distancePending')}</span>
          )}
        </span>
      ) : (
        <Input
          inputMode="decimal"
          aria-label={t('line.distance')}
          placeholder={t('line.distance')}
          value={distance}
          disabled={disabled}
          onFocus={onDistanceFocus}
          onChange={(e) => onDistanceChange(e.target.value)}
          onBlur={onDistanceBlur}
          className={`w-24 ${valid ? '' : 'border-destructive'}`}
        />
      )}
      {/* Text buttons, not a select: two options, and the chosen one has to be
          readable at a glance beside the number it qualifies. */}
      <div className="flex shrink-0 overflow-hidden rounded-md border border-input">
        {(['KM', 'MI'] as const).map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={unit === u}
            disabled={disabled}
            onClick={() => {
              if (unit === u) return;
              onUnitChange(u);
            }}
            className={`px-2 py-1 text-xs disabled:opacity-50 ${
              unit === u
                ? 'bg-primary font-semibold text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {u}
          </button>
        ))}
      </div>
      {/* The derived cost, in the same row and the same place a typed amount would
          sit on any other line — so "Travel - Mileage · 25.66 · KM · $10.00" reads
          left to right as one sentence. Reserved width, right-aligned, tabular
          figures: the number must not shift the controls beside it as it changes. */}
      {/* `output`, not a span: this IS the result of a calculation over the fields
          beside it, which is what the element means. It also carries role=status, so
          a screen reader hears the new figure when the distance changes instead of
          the change happening silently. */}
      {pricing && (
        <output
          aria-label={t('line.amount')}
          className="flex h-10 min-w-24 shrink-0 items-center justify-end px-2 text-right tabular-nums"
        >
          {shownAmount != null ? (
            <span className="font-medium text-foreground text-sm">
              {formatMinor(BigInt(shownAmount), pricing.currency, locale)}
            </span>
          ) : (
            // An em dash, not a zero: nothing has been priced yet, and "$0.00" is a
            // claim that the trip is worth nothing.
            <span className="text-muted-foreground text-sm">{pricePending ? '…' : '—'}</span>
          )}
        </output>
      )}
      {trailing}
      {/* Why there is no figure, when the server can say. This is the same refusal
          the save would have raised ("No mileage rate in force for US on this
          date."), surfaced while the form is still open rather than after it is
          submitted. */}
      {priceRefusal && <p className="w-full text-destructive text-xs">{priceRefusal}</p>}
      {/* Nothing is said when lookup is off. The notice that used to sit here told
          the traveller about an integration they cannot install, next to a field
          that already works — the distance box is right there and typing in it is
          the whole job. Whether address search exists is an admin's problem, and
          the admin surface (Integrations → Google Maps) is where it is now stated. */}
      {routeAvailable && (
        // Always visible, never behind an "Add route" button: the From and To ARE
        // the mileage line when lookup works, and a claim that starts by hiding
        // its own inputs behind a disclosure is a claim people fill in wrong.
        // No border of its own: the line item already draws one, and a second box
        // inside it framed the same mileage context twice.
        <div className="mt-2 w-full">
          <RouteEditor
            value={route}
            onChange={onRouteChange}
            unit={unit}
            onDistance={onMeasuredDistance ?? onDistanceChange}
            disabled={disabled}
          />
        </div>
      )}
      {/* Lookup off but the line already carries a route: still show it. It is
          part of a filed claim, and hiding it because a setting changed later
          would lose evidence an approver may be relying on. */}
      {!routeAvailable && hasStoredRoute && (
        <div className="mt-1 w-full pl-6">
          <RouteSummary value={route} />
        </div>
      )}
    </>
  );
}

export type { RouteValue };
export { EMPTY_ROUTE };

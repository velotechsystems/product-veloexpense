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
 *
 * Four modes (FR-6). `new` is the add-a-line form. A saved line measured by its route,
 * with lookup on, is `route`: its distance as text, a KM/MI toggle that only changes what
 * is shown (the caller converts from the legs and writes nothing), its saved price, and
 * the caller's route control (`routeControl`, the line's dropdown and small map) — no
 * Edit, no Save. Every other saved line takes the TYPED path: `locked`, every input on
 * screen but disabled in a legible muted colour with Edit as its only control, and
 * `editing` after Edit, where nothing here writes anything — the row's Save does, once.
 *
 * A NEW line with address lookup on is the route dropdown and nothing else (FR-1): no
 * From/To, no Calculate, no KM/MI and no price. Any entry opens the route workspace,
 * whose Use this route creates the line through `onAccept` in one step (FR-5), and whose
 * Cancel writes nothing and drops the draft through `onAbandon`. With lookup off the new
 * line is today's typed distance.
 */

import { Button, Input } from '@expenseos/design-system';
import { useLocale, useTranslations } from 'next-intl';
import type React from 'react';
import { type ComponentProps, useEffect, useId, useRef, useState } from 'react';
import { type CurrencyLike, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { EMPTY_ROUTE, LOCKED_FIELD, RouteSummary, type RouteValue } from './RouteEditor';
import { RoutePickerModal } from './RoutePickerModal';
import { RouteSelect } from './RouteSelect';
import type { AcceptPayload, WorkspaceSeed } from './routeWorkspace';
import { useRecentRoutes } from './useRecentRoutes';

export type DistanceUnit = 'KM' | 'MI';

/**
 * Where a mileage line is in its life (FR-6).
 *
 *   · `new` — the add-a-line form. Nothing is saved until Add line.
 *   · `route` — a saved line with lookup on, measured by its route: the route control is
 *     the way to change it, and the unit toggle writes nothing.
 *   · `locked` — a saved line on the typed path. Read-only until Edit.
 *   · `editing` — a typed-path line reopened by Edit. Nothing is saved until Save.
 */
export type MileageMode = 'new' | 'route' | 'locked' | 'editing';

/** The stops a person actually named, as one line: "Toronto → Ottawa". */
function namedStops(route: RouteValue): string {
  return route.stops
    .map((s) => s.description.trim())
    .filter(Boolean)
    .join(' → ');
}

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
  /** Where the line is in its life; `new` when omitted. See `MileageMode`. */
  mode?: MileageMode;
  /**
   * A NEW line with lookup on: the one write, from the workspace's Use this route.
   * Resolve once the line exists; reject with the server's error to keep the workspace
   * open with it. Omitted: the chosen route only fills the draft — `onRouteChange`, then
   * `onDistanceChange` with the distance it measured.
   */
  onAccept?: (payload: AcceptPayload) => Promise<void>;
  /** A NEW line with lookup on: the workspace was cancelled, so the draft goes. */
  onAbandon?: () => void;
  /**
   * Where focus goes when the workspace closes on a new line — the draft (and so the
   * dropdown that opened it) goes with a cancel or an accept, so focus needs a control
   * that stays (NFR-12).
   */
  finalFocus?: ComponentProps<typeof RoutePickerModal>['finalFocus'];
  /**
   * Locked mode's one control: Edit. Rendered only while `locked`, and only when given.
   * The caller flips the row to `editing`.
   */
  onEdit?: () => void;
  /**
   * A saved line's route control, with lookup on: the line's dropdown and its small map
   * (`RouteLine`). Rendered full width under the row, where the stops used to be.
   */
  routeControl?: React.ReactNode;
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
  mode = 'new',
  onEdit,
  routeControl,
  onAccept,
  onAbandon,
  finalFocus,
  disabled,
  pricing,
  trailing,
}: MileageFieldsProps) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const locked = mode === 'locked';
  /** Measured by the route: the distance is text, and its unit only changes the view. */
  const routeMode = mode === 'route';
  /** Locked fields are still real `disabled` inputs — only their colour differs. */
  const inputsDisabled = disabled || locked;
  const summaryId = useId();
  // Deduped by react-query, so every row asking is one request for the page.
  const routeLookup = trpc.mileageRoute.status.useQuery();
  const routeAvailable = routeLookup.data?.available ?? false;
  const mapAvailable = routeLookup.data?.mapAvailable ?? false;
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
  /**
   * On a route line the distance shown may be the other unit's restatement of the same
   * claim (display-only KM/MI), so the saved figure is the price whatever is shown: asking
   * the server to price the restated number would re-round it into a different claim.
   */
  const savedIsCurrent =
    pricing?.saved != null && (routeMode || pricing.saved.distance === distance.trim());
  const priceable =
    !routeMode &&
    Boolean(pricing?.categoryId) &&
    isValidDistance(settledDistance) &&
    !savedIsCurrent;
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
  /**
   * Distance carried over from Concur into this year's bands — shown only when there is
   * some, because "incl. 0 km carried over" on every line would be noise. Without it the
   * traveller sees a lower band rate than they expect and no reason for it.
   */
  const carried =
    preview.data?.ok && priceIsCurrent && Number(preview.data.carriedOver) > 0
      ? preview.data
      : null;
  /** Between a changed distance and its price arriving. Neither figure is true yet. */
  const pricePending = shownAmount == null && priceable && !priceRefusal;

  /**
   * What Edit route says aloud, and what a sighted reader sees beside it: the route and
   * the distance. The locked inputs are disabled, which takes them out of the tab order
   * and makes many screen readers skip them — so without this the one focusable control
   * on a locked line would be "Edit route" with nothing to say which route it edits.
   */
  const stopsText = namedStops(route);
  const distanceText = distance.trim()
    ? t('line.distanceValue', {
        distance: distance.trim(),
        unit: unit === 'MI' ? t('line.mi') : t('line.km'),
      })
    : '';
  // With a route control on the line the route is already said there, so the locked
  // summary is the distance alone.
  const lockedSummary =
    stopsText && distanceText && !routeControl
      ? t('route.lockedSummary', { route: stopsText, distance: distanceText })
      : routeControl
        ? distanceText
        : stopsText || distanceText;

  /**
   * Keep focus with the person across the switch between locked and editing.
   *
   * Edit route disappears when it is pressed, and so do Save and Cancel when they are,
   * so the focused element is removed and focus falls to the page — a keyboard user
   * would be thrown back to the top. Moving it is ONLY a repair of that loss: when focus
   * is anywhere but the page body (somebody has already tabbed on), it is left alone.
   */
  const editButton = useRef<HTMLButtonElement>(null);
  const distanceInput = useRef<HTMLInputElement>(null);
  const previousMode = useRef(mode);
  useEffect(() => {
    const was = previousMode.current;
    previousMode.current = mode;
    if (was === mode) return;
    const lost = document.activeElement == null || document.activeElement === document.body;
    if (!lost) return;
    if (was === 'locked' && mode === 'editing') {
      // The first control the person can use: the distance.
      distanceInput.current?.focus();
    } else if (was === 'editing' && mode === 'locked') {
      editButton.current?.focus();
    }
  }, [mode]);

  if (mode === 'new' && routeAvailable) {
    return (
      <NewLineRoute
        unit={unit}
        mapAvailable={mapAvailable}
        pricing={pricing}
        disabled={disabled}
        finalFocus={finalFocus}
        onAbandon={onAbandon}
        onAccept={
          onAccept ??
          (async (payload) => {
            onRouteChange(payload.mileageRoute);
            onDistanceChange(payload.mileageDistance);
          })
        }
      />
    );
  }

  return (
    <>
      {routeMode ? (
        // Measured by the route, not typed — the route below produces it. Showing an
        // editable box invites a number that contradicts the route right underneath it.
        <span className="flex h-10 min-w-24 items-center justify-end px-2 text-right">
          {distance ? (
            <span className="font-medium text-foreground text-sm tabular-nums">{distance}</span>
          ) : (
            <span className="text-muted-foreground text-xs">{t('line.distancePending')}</span>
          )}
        </span>
      ) : (
        <Input
          ref={distanceInput}
          inputMode="decimal"
          aria-label={t('line.distance')}
          placeholder={t('line.distance')}
          value={distance}
          disabled={inputsDisabled}
          onChange={(e) => onDistanceChange(e.target.value)}
          className={`w-full lg:w-24 ${valid ? '' : 'border-destructive'} ${locked ? LOCKED_FIELD : ''}`}
        />
      )}
      {/* Text buttons, not a select: two options, and the chosen one has to be
          readable at a glance beside the number it qualifies.

          Locked, the unit is locked with the route (FR-6) — but the chosen unit still
          has to be readable, so it is drawn in the muted tokens rather than faded to
          half opacity, and still bold. */}
      <div className="flex shrink-0 overflow-hidden rounded-md border border-input">
        {(['KM', 'MI'] as const).map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={unit === u}
            // A route line with no distance yet has nothing to restate.
            disabled={inputsDisabled || (routeMode && !distance)}
            onClick={() => {
              if (unit === u) return;
              onUnitChange(u);
            }}
            className={`flex-1 px-2 py-1 text-xs lg:flex-initial ${
              locked
                ? unit === u
                  ? 'bg-muted font-semibold text-foreground'
                  : 'text-muted-foreground'
                : `disabled:opacity-50 ${
                    unit === u
                      ? 'bg-primary font-semibold text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`
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
      {carried && (
        <p className="w-full text-muted-foreground text-xs">
          {t('line.mileageCarried', {
            ytd: Number(carried.ytdBefore ?? 0).toLocaleString(locale, {
              maximumFractionDigits: 2,
            }),
            carried: Number(carried.carriedOver).toLocaleString(locale, {
              maximumFractionDigits: 2,
            }),
            unit: t(`line.mileageUnitShort.${carried.unit === 'MI' ? 'MI' : 'KM'}`),
            date: carried.carriedThrough
              ? new Date(carried.carriedThrough).toLocaleDateString(locale, {
                  timeZone: 'UTC',
                  dateStyle: 'medium',
                })
              : '—',
          })}
        </p>
      )}
      {/* Nothing is said when lookup is off. The notice that used to sit here told
          the traveller about an integration they cannot install, next to a field
          that already works — the distance box is right there and typing in it is
          the whole job. Whether address search exists is an admin's problem, and
          the admin surface (Integrations → Google Maps) is where it is now stated. */}
      {routeAvailable && routeControl && (
        // The line's route: its dropdown and its small map, never behind a disclosure.
        // No border of its own: the line item already draws one. This fragment renders
        // straight into the saved row (`parts.tsx`, `flex flex-col gap-1.5`; at `lg` `w-full`
        // wraps it onto its own flex line). With no route yet: 6 px row gap + `mt-1.5` = 12 px,
        // as on a new line (`NewLineRoute`). With a route (dropdown + map): `mt-3`, 18 px, so
        // the full-width dropdown and its map stand clear of the category row.
        <div className={hasStoredRoute ? 'mt-3 w-full' : 'mt-1.5 w-full'}>{routeControl}</div>
      )}
      {/* Lookup off but the line already carries a route: still show it. It is
          part of a filed claim, and hiding it because a setting changed later
          would lose evidence an approver may be relying on. Locked, the summary
          beside Edit route already carries it, so it is not said twice. */}
      {!routeAvailable && hasStoredRoute && !locked && (
        <div className="mt-1 w-full pl-6">
          <RouteSummary value={route} />
        </div>
      )}
      {/* Locked: the route as one line of text, and Edit route described by it — the
          one route control on a saved line. It sits where Add line sits on a new line
          and Save sits in Edit mode, so the row's action is always in the same place. */}
      {locked && (
        <div className="flex w-full flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-end">
          <p id={summaryId} className="min-w-0 break-words text-muted-foreground text-xs lg:flex-1">
            {lockedSummary}
          </p>
          {onEdit && (
            <Button
              ref={editButton}
              size="sm"
              // VeloExpense kit: the kit's Button has no `soft`; `secondary` is its tinted fill.
              variant="secondary"
              aria-describedby={summaryId}
              onClick={onEdit}
              className="self-end lg:self-auto"
            >
              {routeControl ? t('line.editDistance') : t('route.editRoute')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A new mileage line with lookup on (FR-1): the route dropdown, and the workspace it
 * opens. Nothing is written until Use this route; a cancel drops the draft.
 */
function NewLineRoute({
  unit,
  mapAvailable,
  pricing,
  disabled,
  finalFocus,
  onAccept,
  onAbandon,
}: {
  unit: DistanceUnit;
  mapAvailable: boolean;
  pricing: MileageFieldsProps['pricing'];
  disabled?: boolean;
  finalFocus?: MileageFieldsProps['finalFocus'];
  onAccept: (payload: AcceptPayload) => Promise<void>;
  onAbandon?: () => void;
}) {
  const t = useTranslations('expenses');
  const previous = useRecentRoutes();
  const [seed, setSeed] = useState<WorkspaceSeed | null>(null);
  return (
    // Full width under the category row (FR-7): `lg:basis-full` wraps it onto its own line
    // in the new-line row's `lg:flex-wrap`, from the form's left edge across its width.
    // 12 px above it, as on a saved line: the row's 6 px `gap-1.5` + `mt-1.5`.
    <div className="mt-1.5 w-full lg:basis-full">
      <RouteSelect
        entries={previous}
        onNewRoute={() => setSeed({ kind: 'new' })}
        onPrevious={(entry) => setSeed({ kind: 'previous', entry })}
        label={t('route.dropdownLabel')}
        placeholder={t('route.dropdownPlaceholder')}
        disabled={disabled}
      />
      {seed && (
        <RoutePickerModal
          seed={seed}
          unit={unit}
          mapAvailable={mapAvailable}
          pricing={
            pricing
              ? {
                  expenseId: pricing.expenseId,
                  categoryId: pricing.categoryId,
                  lineItemId: pricing.lineItemId,
                  currency: pricing.currency,
                }
              : undefined
          }
          finalFocus={finalFocus}
          onAccept={async (payload) => {
            await onAccept(payload);
            setSeed(null);
          }}
          onClose={() => {
            setSeed(null);
            onAbandon?.();
          }}
        />
      )}
    </div>
  );
}

export type { RouteValue };
export { EMPTY_ROUTE };

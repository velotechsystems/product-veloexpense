'use client';

/**
 * From / stops / To for a mileage line, laid out the way a maps app does it: the
 * origin at the top, the destination at the bottom, and a way to insert a stop
 * between any two.
 *
 * Only rendered when the `google-maps` integration is active. Without it there is
 * no route at all — the line collects a distance and nothing else — because
 * hand-typed stops nobody measured are a data-entry chore that buys nothing.
 * The caller decides; this component assumes address lookup works.
 *
 * The computed distance is never silently authoritative. It fills the field, and
 * the traveller can overwrite it — a detour or a closed road is real, and an
 * override is recorded rather than hidden.
 */

import { Button, Input } from '@expenseos/design-system';
import { IconMapPin, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';

export interface RouteStop {
  /** Google's durable handle. Absent for a hand-typed stop. */
  placeId?: string;
  /** What to show. Typed verbatim, or the suggestion's description. */
  description: string;
}

export interface RouteValue {
  stops: RouteStop[];
  /** Per-leg metres from the last lookup, for the audit snapshot. */
  legs?: { fromPlaceId: string; toPlaceId: string; meters: number }[];
}

/** A route always has at least an origin and a destination, even when empty. */
export const EMPTY_ROUTE: RouteValue = { stops: [{ description: '' }, { description: '' }] };

/** Label a row by position: first is From, last is To, the rest are stops. */
export function rowKind(index: number, total: number): 'from' | 'to' | 'stop' {
  if (index === 0) return 'from';
  if (index === total - 1) return 'to';
  return 'stop';
}

export function RouteEditor({
  value,
  onChange,
  unit,
  onDistance,
  disabled,
}: {
  value: RouteValue;
  onChange: (next: RouteValue) => void;
  unit: 'KM' | 'MI';
  /** Called with a "123.45" distance once a route resolves. */
  onDistance: (distance: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('expenses.route');
  const [error, setError] = useState<string | null>(null);

  /**
   * A stable identity per ROW, held alongside the stops rather than inside them.
   *
   * The rows were keyed by array index, and `PlaceInput` keeps the text you are
   * typing in its own state. So deleting the From made React reuse the component
   * at index 0 with the next stop's props while its internal text stayed put — the
   * field kept showing the address that had just been removed. Keying by content
   * instead would remount on every keystroke and steal focus mid-word.
   *
   * Kept out of `RouteValue` on purpose: that shape is persisted as the line's
   * route snapshot, and a render detail has no business in a filed claim.
   */
  const rowIds = useRef<string[]>([]);
  if (rowIds.current.length !== value.stops.length) {
    // First render, or a length the tracker hasn't seen (a route loaded from the
    // server). Rebuild rather than guess which row moved.
    rowIds.current = value.stops.map((_, i) => rowIds.current[i] ?? `row-${crypto.randomUUID()}`);
  }

  const compute = trpc.mileageRoute.computeRoute.useMutation({
    onSuccess: (res) => {
      setError(null);
      onChange({ ...value, legs: res.legs });
      onDistance(res.distance);
    },
    onError: (e) => setError(e.message),
  });

  /**
   * The stop set the last measurement was for.
   *
   * The route measures ITSELF the moment every stop is a real place — pressing a
   * button to find out how far you drove is a step that can only be forgotten, and
   * a mileage line whose distance is blank because nobody clicked is a claim that
   * gets rejected for no reason.
   *
   * Keyed on the place ids, NOT the unit: a unit switch is converted locally from
   * the number Google already returned, and re-measuring for it would bill a
   * request to learn something arithmetic already knows.
   */
  const measuredFor = useRef<string | null>(null);

  const setStop = (i: number, stop: RouteStop) => {
    const stops = [...value.stops];
    stops[i] = stop;
    // Legs describe the previous route; keeping them beside changed stops would
    // be a snapshot of something that no longer happened.
    onChange({ stops, legs: undefined });
  };

  /** Insert after `i` — the button sits between two rows and adds between them. */
  const insertAfter = (i: number) => {
    const stops = [...value.stops];
    stops.splice(i + 1, 0, { description: '' });
    rowIds.current.splice(i + 1, 0, `row-${crypto.randomUUID()}`);
    onChange({ stops, legs: undefined });
  };

  const removeAt = (i: number) => {
    // Never below two: a route without an origin and a destination isn't one, so
    // at exactly two the delete buttons are disabled rather than destructive.
    if (value.stops.length <= 2) return;
    // Positions carry the meaning, so removing an END promotes its neighbour: drop
    // the From and the second stop becomes the From; drop the To and the
    // second-to-last becomes the To. `rowKind` re-derives the labels from the new
    // length, so nothing else has to know this happened.
    rowIds.current = rowIds.current.filter((_, j) => j !== i);
    onChange({ stops: value.stops.filter((_, j) => j !== i), legs: undefined });
  };

  const placeIds = useMemo(
    () => value.stops.map((s) => s.placeId).filter((id): id is string => Boolean(id)),
    [value.stops],
  );
  const canCompute = placeIds.length === value.stops.length && placeIds.length >= 2;
  const routeKey = canCompute ? placeIds.join('|') : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `compute` is a new object every render, so depending on it would re-fire this effect forever; `unit` is deliberately excluded because a unit switch is converted locally rather than re-measured (a billed request for something arithmetic already knows).
  useEffect(() => {
    // Nothing to measure, or already measured for exactly these stops. The ref is
    // set BEFORE the call so a re-render mid-flight can't fire a second one, and
    // it is cleared on failure so a fixed stop is retried.
    if (!routeKey || disabled) return;
    if (measuredFor.current === routeKey) return;
    measuredFor.current = routeKey;
    compute.mutate(
      { placeIds: routeKey.split('|'), unit },
      {
        onError: () => {
          measuredFor.current = null;
        },
      },
    );
  // VeloExpense: ExpenseOS's Biome suppression above, for ESLint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, disabled]);

  return (
    <div className="space-y-2">
      {value.stops.map((stop, i) => {
        const kind = rowKind(i, value.stops.length);
        return (
          // Keyed by the row's own identity, so a removed row takes its input state
          // with it instead of handing it to the row that shuffles up.
          //
          // `space-y-2` matches the parent's, which is what makes the add-a-stop
          // block sit CENTRED between the two places. Without it the connector was a
          // sibling with no gap above and the parent's 8px below, so "Add stop" hugged
          // the place above it and floated away from the one below.
          <div key={rowIds.current[i]} className="space-y-2">
            <div className="flex items-center gap-2">
              {/* Fixed 14px box: the pin and the connector arrow below it must
                  share a centre line, and two differently-sized icons in
                  auto-width boxes never do. */}
              <span className="flex w-3.5 shrink-0 justify-center">
                <IconMapPin
                  size={14}
                  className={kind === 'stop' ? 'text-muted-foreground' : 'text-foreground'}
                />
              </span>
              <div className="min-w-0 flex-1">
                <PlaceInput
                  value={stop}
                  onChange={(next) => setStop(i, next)}
                  placeholder={t(kind)}
                  disabled={disabled}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('removeStop')}
                // Two stops ARE the route; there is nothing to remove without
                // destroying it.
                title={value.stops.length <= 2 ? t('removeStopDisabled') : t('removeStop')}
                disabled={disabled || value.stops.length <= 2}
                onClick={() => removeAt(i)}
              >
                <IconTrash size={13} />
              </Button>
            </div>
            {/* The add-a-stop affordance lives BETWEEN rows, like the maps app
                this is modelled on — so it's obvious the new stop goes there and
                not at the end. */}
            {i < value.stops.length - 1 && (
              // `items-stretch` so the rule fills the gap: a short arrow floating
              // between two pins reads as decoration, whereas a line that runs from
              // one pin nearly to the next reads as the leg it represents. Same
              // 14px column as the pins, so all three share a centre line.
              <div className="flex items-stretch gap-2">
                <span className="flex w-3.5 shrink-0 flex-col items-center py-0.5">
                  <span className="w-px flex-1 bg-border" aria-hidden />
                </span>
                {/* min-h gives the rule something to span, and items-center puts
                    the button exactly halfway between the two places. */}
                <div className="flex min-h-7 items-center">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => insertAfter(i)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <IconPlus size={11} className="mr-0.5 inline" />
                    {t('addStop')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* No button: the route measures itself. What's left is saying which state
          it's in, because a silent form is one people poke at. */}
      {compute.isPending ? (
        <p className="text-muted-foreground text-xs">{t('computing')}</p>
      ) : !canCompute ? (
        <p className="text-muted-foreground text-xs">{t('pickAllStops')}</p>
      ) : null}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

/**
 * A route already on the line, shown when address lookup is off.
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

// ── One address row ────────────────────────────────────────────────

/**
 * Address search for a single stop.
 *
 * The session token is minted once per row and thrown away on selection, which
 * is what bills a whole typing-then-picking interaction as one autocomplete
 * session rather than one call per keystroke.
 */
function PlaceInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: RouteStop;
  onChange: (next: RouteStop) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const t = useTranslations('expenses.route');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const sessionToken = useRef(crypto.randomUUID());

  const search = trpc.mileageRoute.searchPlaces.useQuery(
    { query, sessionToken: sessionToken.current },
    // Below three characters every provider returns noise, and it's billable
    // noise.
    { enabled: open && query.trim().length >= 3, staleTime: 30_000 },
  );

  const pick = useCallback(
    (s: { placeId: string; description: string }) => {
      onChange({ placeId: s.placeId, description: s.description });
      setQuery('');
      setOpen(false);
      // A new token for the next interaction — reusing one would bill the next
      // search into the session that already closed.
      sessionToken.current = crypto.randomUUID();
    },
    [onChange],
  );

  const items = search.data?.items ?? [];
  // A rejected API call is not "no matches". Saying so is the difference between
  // "that address doesn't exist" and "somebody needs to fix the key".
  const lookupError = search.data?.error ?? (search.error ? search.error.message : null);

  return (
    <div className="relative">
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        disabled={disabled}
        value={open ? query : value.description}
        onFocus={() => {
          setOpen(true);
          setQuery(value.description);
        }}
        onBlur={() => {
          // Late enough for a click on a suggestion to land first.
          window.setTimeout(() => {
            setOpen(false);
            /**
             * Keep typed text that was never matched to a place.
             *
             * The input renders `open ? query : value.description`, so closing the
             * dropdown used to revert the field to the stored description and the
             * user's typing vanished with no explanation — the failure mode of a
             * control that looks like a text box and behaves like a picker. It also
             * cost a CI flake and made one test pass against the bug it was written
             * to catch.
             *
             * Committed WITHOUT a placeId, which is the honest representation: the
             * text is what they wrote, and the route cannot auto-measure until every
             * stop resolves to a real place — a state `canCompute` already handles.
             * A pick needs no guard here: `pick` clears `query`, and this only
             * commits non-empty text. An explicit `picked` flag was written first and
             * then removed — no mutation of it changed any behaviour, and a guard
             * that cannot be shown to matter reads as load-bearing when it is not.
             */
            const typed = query.trim();
            if (typed && typed !== value.description) {
              onChange({ description: typed });
            }
          }, 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          // Typing after a pick invalidates the placeId — the text no longer
          // describes the place it pointed at.
          if (value.placeId) onChange({ description: e.target.value });
        }}
      />
      {open && query.trim().length >= 3 && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-input bg-popover shadow-md">
          {items.length === 0 ? (
            <p
              className={`px-3 py-2 text-xs ${lookupError ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {search.isFetching
                ? t('searching')
                : lookupError
                  ? t('lookupFailed', { reason: lookupError })
                  : t('noMatches')}
            </p>
          ) : (
            items.map((s) => (
              <button
                key={s.placeId}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className="block w-full px-3 py-1.5 text-left text-foreground text-xs hover:bg-muted"
              >
                {s.description}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * From / stops / To, laid out the way a maps app does it: the origin at the top, the
 * destination at the bottom, and a way to insert a stop between any two (FR-2).
 *
 * The rows only; whoever renders them owns the stops. The workspace panel uses them for
 * the route being built (a saved line changes its route there too, through Change route).
 * Each row is keyed by its caller-supplied id, never by position (see `rowId` below).
 */

import { Button, Input } from '@expenseos/design-system';
import { IconMapPin, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { type Ref, useCallback, useEffect, useId, useRef, useState } from 'react';
import { MAX_ROUTE_STOPS, MAX_STOP_DESCRIPTION, type RouteStop } from '@/lib/mileageRouteSchema';
import { trpc } from '@/lib/trpc/client';

/** Label a row by position: first is From, last is To, the rest are stops. */
export function rowKind(index: number, total: number): 'from' | 'to' | 'stop' {
  if (index === 0) return 'from';
  if (index === total - 1) return 'to';
  return 'stop';
}

export interface RouteStopRowsProps {
  /**
   * The rows, each with a stable identity of its own.
   *
   * `PlaceInput` keeps the text being typed in its own state, so keying by index made
   * deleting the From hand the next stop's props to the component at index 0 while its
   * typed text stayed put. Keying by content would remount on every keystroke and steal
   * focus mid-word. So the caller names each row once and keeps the name with it.
   */
  rows: readonly { id: string; stop: RouteStop }[];
  onSetStop: (index: number, stop: RouteStop) => void;
  /** Insert an empty stop after `index` — the button sits between two rows. */
  onInsertAfter: (index: number) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
  /**
   * The stops stay on screen as disabled fields and nothing that could change them is
   * rendered — no add, no remove (FR-6 lock on a saved line).
   */
  locked?: boolean;
  /** Classes for a locked field, so it stays legible rather than half-opacity grey. */
  lockedClassName?: string;
  /** The From input, for the workspace's initial focus (NFR-12). */
  fromRef?: Ref<HTMLInputElement>;
  /**
   * Pass-through points on the route: they count toward the same 25 as the stops
   * (FR-4 3.A), so Add stop stops adding when stops and points reach it together.
   */
  pointCount?: number;
}

export function RouteStopRows({
  rows,
  onSetStop,
  onInsertAfter,
  onRemove,
  disabled,
  locked,
  lockedClassName,
  fromRef,
  pointCount = 0,
}: RouteStopRowsProps) {
  const t = useTranslations('expenses.route');
  const maxStopsId = useId();
  /** At the stop cap, "Add stop" stops adding: the save path refuses a longer route. */
  const atMaxStops = rows.length + pointCount >= MAX_ROUTE_STOPS;
  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        const kind = rowKind(i, rows.length);
        return (
          // `space-y-2` matches the parent's, which is what makes the add-a-stop block sit
          // CENTRED between the two places.
          <div key={row.id} className="space-y-2">
            <div className="flex items-center gap-2">
              {/* Fixed 14px box: the pin and the connector below it share a centre line. */}
              <span className="flex w-3.5 shrink-0 justify-center">
                <IconMapPin
                  size={14}
                  className={kind === 'stop' ? 'text-muted-foreground' : 'text-foreground'}
                />
              </span>
              <div className="min-w-0 flex-1">
                <PlaceInput
                  value={row.stop}
                  onChange={(next) => onSetStop(i, next)}
                  placeholder={t(kind)}
                  disabled={disabled || locked}
                  className={locked ? lockedClassName : undefined}
                  inputRef={i === 0 ? fromRef : undefined}
                />
              </div>
              {!locked && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('removeStop')}
                  // Two stops ARE the route; there is nothing to remove without destroying it.
                  title={rows.length <= 2 ? t('removeStopDisabled') : t('removeStop')}
                  disabled={disabled || rows.length <= 2}
                  onClick={() => onRemove(i)}
                >
                  <IconTrash size={13} />
                </Button>
              )}
            </div>
            {/* The add-a-stop affordance lives BETWEEN rows, like the maps app this is
                modelled on — so it's obvious the new stop goes there and not at the end. */}
            {i < rows.length - 1 && (
              <div className="flex items-stretch gap-2">
                <span className="flex w-3.5 shrink-0 flex-col items-center py-0.5">
                  <span className="w-px flex-1 bg-border" aria-hidden />
                </span>
                <div className="flex min-h-7 items-center">
                  {!locked && (
                    <button
                      type="button"
                      disabled={disabled || atMaxStops}
                      aria-describedby={atMaxStops ? maxStopsId : undefined}
                      onClick={() => onInsertAfter(i)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <IconPlus size={11} className="mr-0.5 inline" />
                      {t('addStop')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {!locked && atMaxStops && (
        <p id={maxStopsId} className="text-muted-foreground text-xs">
          {t('maxStops', { max: MAX_ROUTE_STOPS })}
        </p>
      )}
    </div>
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
  className,
  inputRef,
}: {
  value: RouteStop;
  onChange: (next: RouteStop) => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const t = useTranslations('expenses.route');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const sessionToken = useRef(crypto.randomUUID());
  // The blur commit runs 150ms later, so it must read the LATEST query, stop and
  // setter, not the ones captured by the render that saw the blur.
  const latest = useRef({ query, value, onChange });
  latest.current = { query, value, onChange };
  /**
   * The blur's commit, while it waits out its 150ms. Focus that comes back to the field
   * first cancels it: the field is in use again, so its suggestions stay open and nothing
   * typed is committed behind the person's back. Left running, it closed the list under a
   * pointer about to press a suggestion — focus out and straight back in (a press on Add
   * stop, then the field) was all it took. A pick cancels it too: the pick is the commit.
   */
  const blurCommit = useRef<number | null>(null);
  const cancelBlurCommit = useCallback(() => {
    if (blurCommit.current === null) return false;
    window.clearTimeout(blurCommit.current);
    blurCommit.current = null;
    return true;
  }, []);
  useEffect(
    () => () => {
      cancelBlurCommit();
    },
    [cancelBlurCommit],
  );

  const search = trpc.mileageRoute.searchPlaces.useQuery(
    { query, sessionToken: sessionToken.current },
    // Below three characters every provider returns noise, and it's billable
    // noise.
    { enabled: open && query.trim().length >= 3, staleTime: 30_000 },
  );

  const pick = useCallback(
    (s: { placeId: string; description: string }) => {
      cancelBlurCommit();
      // Capped like typed text: the save path refuses a longer description, and a
      // picked place could not be shortened without losing its place id.
      onChange({ placeId: s.placeId, description: s.description.slice(0, MAX_STOP_DESCRIPTION) });
      latest.current.query = '';
      setQuery('');
      setOpen(false);
      // A new token for the next interaction — reusing one would bill the next
      // search into the session that already closed.
      sessionToken.current = crypto.randomUUID();
    },
    [onChange, cancelBlurCommit],
  );

  const items = search.data?.items ?? [];
  // A rejected API call is not "no matches". Saying so is the difference between
  // "that address doesn't exist" and "somebody needs to fix the key".
  const lookupError = search.data?.error ?? (search.error ? search.error.message : null);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        aria-label={placeholder}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        maxLength={MAX_STOP_DESCRIPTION}
        value={open ? query : value.description}
        onFocus={() => {
          setOpen(true);
          // Back before the blur committed: the dropdown never closed and the text being
          // typed is still the query, so both stay as they are.
          if (cancelBlurCommit()) return;
          setQuery(value.description);
        }}
        onBlur={() => {
          // Late enough for a click on a suggestion to land first.
          cancelBlurCommit();
          blurCommit.current = window.setTimeout(() => {
            blurCommit.current = null;
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
             * text is what they wrote, and no route is asked for until every
             * stop resolves to a real place — the request key needs every place id.
             * A pick must not be overwritten by the text that found it. This runs 150ms
             * after the blur, and on a touch screen the blur lands BEFORE the click on the
             * suggestion, so the query and the stop captured by the blur's render are the
             * typed text and the empty stop. Reading `latest` instead sees the pick, whose
             * cleared query commits nothing.
             */
            const cur = latest.current;
            const typed = cur.query.trim();
            if (typed && typed !== cur.value.description) {
              cur.onChange({ description: typed });
            }
          }, 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          latest.current.query = e.target.value;
          // A pick closes the dropdown but leaves focus here, so onFocus never
          // re-opens it. Typing must, or the field keeps rendering the stored
          // description and swallows every keystroke.
          setOpen(true);
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

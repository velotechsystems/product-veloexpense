'use client';

/**
 * Destination picker — cities, not addresses.
 *
 * You fly to a city, and a city is also what per-diem matches on and what the hotel
 * query takes. Picking a street address would give neither without a second billable
 * Place Details call, so the server restricts the search to localities and returns
 * the parts already split out.
 *
 * Degrades to a plain text box when Google Maps isn't installed: a typed
 * destination still prices from per-diem if it happens to name a rate's city, which
 * is worth more than a disabled field.
 */

import { Input } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc/client';

export interface CityValue {
  placeId: string | null;
  label: string;
  city: string | null;
  country: string | null;
}

export const EMPTY_CITY: CityValue = { placeId: null, label: '', city: null, country: null };

export function CityPicker({
  value,
  onChange,
  available,
  placeholder,
  disabled,
}: {
  value: CityValue;
  onChange: (next: CityValue) => void;
  /** Whether the Maps integration is usable. False → a plain text field. */
  available: boolean;
  placeholder: string;
  disabled?: boolean;
}) {
  const t = useTranslations('travel.form');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const sessionToken = useRef(crypto.randomUUID());

  const search = trpc.travelRequests.searchDestinations.useQuery(
    { query, sessionToken: sessionToken.current },
    // Below three characters every provider returns noise, and it is billable noise.
    { enabled: available && open && query.trim().length >= 3, staleTime: 30_000 },
  );

  const pick = useCallback(
    (s: { placeId: string; description: string; city: string; country: string | null }) => {
      onChange({
        placeId: s.placeId,
        label: s.description,
        city: s.city,
        country: s.country,
      });
      setQuery('');
      setOpen(false);
      // A new token for the next interaction — reusing one bills the next search
      // into a session that has already closed.
      sessionToken.current = crypto.randomUUID();
    },
    [onChange],
  );

  if (!available) {
    return (
      <Input
        aria-label={placeholder}
        placeholder={t('typeDestination')}
        disabled={disabled}
        value={value.label}
        // No placeId and no country: the text is all we have, and `city` seeds the
        // per-diem match on the chance that it names one.
        onChange={(e) =>
          onChange({ placeId: null, label: e.target.value, city: e.target.value, country: null })
        }
      />
    );
  }

  const items = search.data?.items ?? [];
  // A rejected API call is not "no matches". Saying so is the difference between
  // "that city doesn't exist" and "somebody needs to fix the key".
  const lookupError = search.data?.error ?? (search.error ? search.error.message : null);

  return (
    <div className="relative">
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        disabled={disabled}
        value={open ? query : value.label}
        onFocus={() => {
          setOpen(true);
          setQuery(value.label);
        }}
        onBlur={() => {
          /**
           * Keep what was typed, even when no suggestion was picked.
           *
           * This input renders `open ? query : value.label`, and typing only ever set
           * `query` — `onChange` ran solely to invalidate a `placeId`. So a destination
           * that was typed but never picked from the list was never committed anywhere,
           * and closing the list rendered `value.label`, which was still empty: the text
           * vanished on blur, Submit stayed disabled, and nothing said why. The free-text
           * fallback branch above has always kept typed text; this makes the two agree.
           *
           * On blur rather than on each keystroke, because committing per keystroke
           * re-renders the parent mid-typing and the input loses focus.
           *
           * `city` is seeded with the same text because per-diem matches the city as a
           * substring — a typed "Toronto" still prices. Guarded on `placeId` so a real
           * pick is never overwritten: `pick` clears `query` and sets `placeId`, and it
           * lands after this blur.
           */
          if (!value.placeId && query.trim()) {
            onChange({ ...EMPTY_CITY, label: query, city: query });
          }
          // Late enough for a click on a suggestion to land first.
          window.setTimeout(() => setOpen(false), 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          // Typing after a pick invalidates the placeId — the text no longer
          // describes the place it pointed at.
          if (value.placeId) onChange({ ...EMPTY_CITY, label: e.target.value });
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
                /**
                 * 44px on a coarse pointer, bought with the row's OWN BOX.
                 *
                 * At rest this row is `py-2` (8px) around a `text-sm` line box. `text-sm`
                 * is 14px with a `calc(1.25 / 0.875)` unitless line-height
                 * (`tailwindcss/theme.css`), i.e. 20px, so the row measures 8 + 20 + 8 =
                 * 36px — 8px short of WCAG 2.2 SC 2.5.5. `pointer-coarse:py-3` (12px)
                 * makes that 12 + 20 + 12 = 44px exactly, and `pointer-coarse:min-h-11`
                 * holds the floor if that line-height ever moves.
                 *
                 * NOT `einc-tap-slop`, and the reason is the stack rather than the class.
                 * That utility floors an invisible `::after` at 44px centred on a 36px
                 * box, so it reaches 4px past each edge — and these rows are SIBLINGS in a
                 * vertical list with no gutter between them. Every row's slop would cover
                 * the last 4px of the row above and the first 4px of the row below, and
                 * the later sibling paints on top, so the bottom 4px of each visible row
                 * would pick the NEXT city. `globals.css:152-157` makes exactly this
                 * argument for the horizontal axis; a stacked list is the vertical case of
                 * it. A real box floors the target without reaching over anything.
                 *
                 * BOTH classes carry `pointer-coarse:`, not just the padding: an unprefixed
                 * `min-h-11` would give a mouse-driven list 44px rows with the label
                 * sitting 4px above centre (a `block` does not centre its line box in a
                 * min-height it did not fill). This is a hit-target fix, not a density
                 * change, so desktop keeps its 36px rows unchanged.
                 */
                className="block pointer-coarse:min-h-11 w-full px-3 pointer-coarse:py-3 py-2 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
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

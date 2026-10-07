'use client';

import { Combobox as ComboboxPrimitive } from '@base-ui-components/react/combobox';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Combobox — a searchable single-select built on the Base UI Combobox.
 *
 * Differs from <Select>: the field is a text input you can type into to
 * filter, and the options panel opens *below* the field (not overlaid on
 * top of it). Values are constrained to `items` — free text isn't accepted;
 * it only filters. Pass plain `{ value, label }` items; Base UI uses `label`
 * for display/filtering and `value` for the selected value automatically.
 */

export interface ComboboxItem {
  value: string;
  label: string;
  /**
   * Optional leading glyph — an emoji, not markup, because these lists are
   * built from data (an expense category's `icon`, a country's flag) rather than
   * from components.
   *
   * Rendered in the option row AND folded into the field's display string, so a
   * chosen item still looks like the thing that was chosen. Showing it only in
   * the dropdown is what makes a picked category read as a different, plainer
   * entry than the one clicked.
   */
  icon?: string;
}

export interface ComboboxProps {
  items: ComboboxItem[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Shown when the filter matches no items. */
  emptyText?: string;
  /**
   * Label for the current value when it is not (yet) in `items`.
   *
   * `selected` is otherwise found only by scanning `items`, so a field whose options
   * load asynchronously renders blank on the first pass even though the value is known.
   * Same escape hatch AsyncCombobox has, for the same reason. Ignored unless its
   * `value` matches — a leftover from a previously-rendered row must never label a
   * different selection.
   */
  selectedItem?: ComboboxItem | null;
  /**
   * Accessible name for the input.
   *
   * A combobox whose visible label is a plain `<span>` beside it — the common
   * shape in this app — is announced as an unnamed "combobox": a screen reader
   * user is told a control exists but not what it chooses. Pass this wherever
   * there is no `<label htmlFor={id}>`.
   */
  'aria-label'?: string;
}

export function Combobox({
  items,
  value,
  onValueChange,
  placeholder,
  disabled,
  id,
  className,
  emptyText = 'No results',
  selectedItem = null,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const selected = React.useMemo(
    () =>
      items.find((i) => i.value === value) ??
      // The fallback stands in only while the real option is missing, and only for the
      // value actually selected.
      (selectedItem && selectedItem.value === value ? selectedItem : null),
    [items, value, selectedItem],
  );
  // Base UI seeds the input's text by locating the controlled `value` inside `items`, so
  // a selection that is not in the list has no label to render and the field shows blank.
  // Splicing it in fixes the display AND means the dropdown shows the current selection
  // rather than looking like it vanished — for the async picker that is the state before
  // anyone has typed a query.
  const rootItems = React.useMemo(
    () =>
      selected && !items.some((i) => i.value === selected.value) ? [selected, ...items] : items,
    [items, selected],
  );
  return (
    <ComboboxPrimitive.Root
      items={rootItems}
      // Stay controlled for the component's lifetime. `selected` is
      // ComboboxItem | null (never undefined); Base UI reads `undefined` as
      // UNCONTROLLED, so coercing null → undefined flips uncontrolled→controlled
      // once a value (or the async `items`) arrives — a React error. Pass null
      // (controlled-empty). The Base UI RC types `value` as `ComboboxItem |
      // undefined` though the runtime accepts null (cf. onValueChange /
      // defaultValue, both typed with null) — cast the type gap.
      value={selected as ComboboxItem | undefined}
      onValueChange={(item: ComboboxItem | null) => onValueChange(item ? item.value : null)}
      // Compare by `value` so a re-rendered/rebuilt `items` array (new object
      // identities for the same options) doesn't read as a value change and
      // resync/flicker the field.
      isItemEqualToValue={(a: ComboboxItem, b: ComboboxItem) => a?.value === b?.value}
      // What the text field shows for the selected item. The icon rides along so
      // it survives selection; filtering still matches on the label because the
      // glyph is a prefix, not a substitute.
      itemToStringLabel={(item: ComboboxItem) =>
        item?.icon ? `${item.icon} ${item.label}` : (item?.label ?? '')
      }
      disabled={disabled}
    >
      <div className={cn('relative', className)}>
        <ComboboxPrimitive.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          // Select the existing text on focus, so the first keystroke REPLACES the
          // selected item's label instead of appending to it. Before the field showed a
          // label at all this was moot; now that it does, typing "acme" into a field
          // reading "Acme Corp" would search for "Acme Corpacme".
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background py-2 pr-9 pl-3 text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:border-ring focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <ComboboxPrimitive.Trigger
          aria-label="Toggle options"
          className="absolute top-1/2 right-2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground disabled:opacity-50"
        >
          <IconChevronDown className="h-4 w-4 opacity-50" />
        </ComboboxPrimitive.Trigger>
      </div>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          positionMethod="fixed"
          className="z-[70]"
        >
          <ComboboxPrimitive.Popup
            className={cn(
              // Width: AT LEAST the trigger, free to grow to fit the longest option, capped to
              // the viewport. Pinning it to the trigger width (`w-[var(--anchor-width)]`) clipped
              // option text on narrow fields and small screens — reported twice from UAT as
              // "fields cut off in the dropdown because of screen size". So `--anchor-width` is a
              // FLOOR here, never a ceiling, and the 92vw cap is what keeps the widening bounded.
              //
              // Two deliberate departures from `select.tsx`, which set this precedent, so that a
              // later make-it-consistent pass does not undo them: `max-h-72` is kept rather than
              // normalised to select's `max-h-96`, and `relative` is NOT added. Select's popup
              // needs `relative` to be the containing block for its `ScrollUpArrow` /
              // `ScrollDownArrow`; this popup has no absolutely-positioned children of its own —
              // the check indicator's containing block is the `Item`, which carries its own
              // `relative`, and that is also what makes the indicator's `top-2` resolve against
              // the row. `combobox.test.tsx` pins this string on BOTH twins.
              'z-[70] max-h-72 w-auto min-w-[max(8rem,var(--anchor-width))] max-w-[min(92vw,32rem)] overflow-y-auto rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-md',
              'data-[closed]:animate-out data-[open]:animate-in',
            )}
          >
            {/* Base UI keeps Empty in the DOM as a polite aria-live region.
                `empty:hidden` collapses it to zero height when there's no
                visible content, so the popup doesn't show a blank top row
                when the filter has matches. */}
            <ComboboxPrimitive.Empty className="px-2 py-4 text-center text-muted-foreground text-sm empty:hidden">
              {emptyText}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List>
              {(item: ComboboxItem) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item}
                  className={cn(
                    'relative flex w-full cursor-default select-none items-start rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none',
                    // Wrap instead of clipping, and `break-words` is the load-bearing half rather
                    // than decoration. The labels that actually clipped are slash-joined —
                    // "Courier/Shipping/Freight/Postage",
                    // "Messagerie/Expédition/Fret/Affranchissement" — and CSS does not break after
                    // a slash, so `whitespace-normal` alone leaves the row unable to wrap and the
                    // popup unable to fit it.
                    //
                    // `items-start` and the indicator's `top-2` below are the same decision, not
                    // two: once a row can be two lines tall, a vertically centred check floats in
                    // the middle of the block instead of marking the row it belongs to. Change one
                    // and the other is wrong. Measured in `e2e/combobox-popup-width.spec.ts`.
                    'whitespace-normal break-words',
                    'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  )}
                >
                  <span className="absolute top-2 left-2 flex h-3.5 w-3.5 items-center justify-center">
                    <ComboboxPrimitive.ItemIndicator>
                      <IconCheck className="h-4 w-4" />
                    </ComboboxPrimitive.ItemIndicator>
                  </span>
                  {item.icon && <span className="mr-1.5 shrink-0">{item.icon}</span>}
                  {item.label}
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
Combobox.displayName = 'Combobox';

/**
 * AsyncCombobox — server-search variant of {@link Combobox}, built on the same
 * Base UI primitive. Instead of filtering a pre-loaded `items` array on the
 * client, it observes what the user types, debounces it, and (only once at
 * least `minChars` characters are entered) calls `onSearchChange` so the parent
 * can run a server query and feed back the matching `items`. Client-side
 * filtering is disabled (`filter={null}`) so the server's results render as-is.
 *
 * This is the shared pattern for high-cardinality pickers (vendors, GL
 * accounts, users …) where loading the full list would freeze the browser.
 * The parent owns the data; this component owns the UX (debounce, min-chars
 * gate, loading / empty hints, selected-label display).
 *
 * Selected-label display: pass `selectedItem` so the field can show the label
 * of the current `value` even when that item isn't in the latest search
 * `items` (e.g. when editing a record whose vendor is already set).
 */
export interface AsyncComboboxProps {
  /** Currently selected value id (or null). */
  value: string | null;
  /** Fired when the selection changes; `item` is null when cleared. */
  onValueChange: (value: string | null, item: ComboboxItem | null) => void;
  /** Result items for the current query (parent supplies from its search). */
  items: ComboboxItem[];
  /**
   * Called with the trimmed query the parent should search — debounced, and
   * only once `minChars` is reached. Called with `''` when the input is below
   * the threshold or cleared (parent should disable / reset its query then).
   * Pass a stable reference (e.g. a `useState` setter or `useCallback`).
   */
  onSearchChange: (query: string) => void;
  /** The selected item, so its label shows when not present in `items`. */
  selectedItem?: ComboboxItem | null;
  /** True while the parent's search query is in flight. */
  loading?: boolean;
  /** Characters required before a search fires. Default 3. */
  minChars?: number;
  /** Debounce before `onSearchChange` fires, in ms. Default 300. */
  debounceMs?: number;
  placeholder?: string;
  /** Hint shown before `minChars` are typed. */
  minCharsHint?: string;
  /** Shown while `loading`. */
  loadingText?: string;
  /** Shown when a search returned no matches. */
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Focus the input on mount — useful for inline (in-cell) editors. */
  autoFocus?: boolean;
  /** Called when the popup is dismissed by outside-click or Escape (NOT on
   *  selection). Lets an inline editor exit edit mode on a click-away / Esc. */
  onClose?: () => void;
  /** Accessible name for the input — see ComboboxProps. */
  'aria-label'?: string;
}

export function AsyncCombobox({
  value,
  onValueChange,
  items,
  onSearchChange,
  selectedItem = null,
  loading = false,
  minChars = 3,
  debounceMs = 300,
  placeholder,
  minCharsHint = `Type ${3} or more characters to search`,
  loadingText = 'Searching…',
  emptyText = 'No matches',
  disabled,
  id,
  className,
  autoFocus,
  onClose,
  'aria-label': ariaLabel,
}: AsyncComboboxProps) {
  const [query, setQuery] = React.useState('');
  const trimmed = query.trim();
  const belowMin = trimmed.length < minChars;

  // `onSearchChange` is read through a ref so an inline arrow at the call site
  // (the common case) can't put a new identity in the dep array below and re-run
  // the effect on every parent render — which, sub-threshold, fired
  // `onSearchChange('')` continuously and reset the caller's query mid-typing.
  const onSearchChangeRef = React.useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  // Debounce the typed query; only search past the min-chars threshold. A
  // sub-threshold / empty input resets the parent's query immediately.
  React.useEffect(() => {
    if (belowMin) {
      onSearchChangeRef.current('');
      return;
    }
    const handle = setTimeout(() => onSearchChangeRef.current(trimmed), debounceMs);
    return () => clearTimeout(handle);
  }, [trimmed, belowMin, debounceMs]);

  // Resolve the object to display for the current value: prefer the
  // caller-provided selected item (survives when it's not in `items`).
  //
  // Held in a ref and replaced only when the (value, label) PAIR changes, not
  // when the object identity does. Callers routinely build `selectedItem` as an
  // inline literal — `initialItem={row.vendor ? { value: …, label: … } : null}` —
  // so it gets a fresh identity on every parent render. Feeding that straight to
  // Base UI made it treat the selection as changed and rewrite the input text
  // from the selected label, which wiped whatever the user had just typed. Since
  // this component's own `query` state re-renders the parent chain on each
  // keystroke, the effect was that typing cleared itself.
  const selectedRef = React.useRef<ComboboxItem | null>(null);
  const nextSelected = selectedItem ?? items.find((i) => i.value === value) ?? null;
  if (
    (nextSelected?.value ?? null) !== (selectedRef.current?.value ?? null) ||
    (nextSelected?.label ?? null) !== (selectedRef.current?.label ?? null)
  ) {
    selectedRef.current = nextSelected;
  }
  const selected = selectedRef.current;

  // Base UI seeds the input's text by locating the controlled `value` inside `items`, so
  // a selection that is not in the list has no label to render and the field shows blank.
  // Splicing it in fixes the display AND means the dropdown shows the current selection
  // rather than looking like it vanished — for the async picker that is the state before
  // anyone has typed a query.
  const rootItems = React.useMemo(
    () =>
      selected && !items.some((i) => i.value === selected.value) ? [selected, ...items] : items,
    [items, selected],
  );

  return (
    <ComboboxPrimitive.Root
      items={rootItems}
      // Pass null (not undefined) for the empty state so the field stays
      // controlled — Base UI reads `undefined` as uncontrolled. The RC types
      // `value` without null though the runtime accepts it — cast the gap.
      value={selected as ComboboxItem | undefined}
      onValueChange={(item: ComboboxItem | null) => onValueChange(item ? item.value : null, item)}
      // Match the controlled value to list items by `value`, not object
      // identity. Search results arrive as fresh objects every query, so an
      // identity comparison would see the selection "change" on every refetch
      // and resync the input — the value blinking. Comparing by `.value` keeps
      // it stable across refetches.
      isItemEqualToValue={(a: ComboboxItem, b: ComboboxItem) => a?.value === b?.value}
      // What the text field shows for the selected item — the same mapping the plain
      // Combobox passes. Without it Base UI has no way to render a selection as text, so
      // a field with a perfectly good `selectedItem` displayed BLANK and only filled in
      // after a focus/blur resync. That is the "all fields empty until you click in and
      // out" report; the value was never missing, only unprintable.
      itemToStringLabel={(item: ComboboxItem) =>
        item?.icon ? `${item.icon} ${item.label}` : (item?.label ?? '')
      }
      onInputValueChange={(v: string, details: { reason?: string }) => {
        // Only a genuine keystroke/paste/clear drives a new search. Base UI
        // also fires this when it writes the selected item's label back into
        // the field on selection; feeding THAT into the query re-searched for
        // the label, producing new items → selection churn → flicker. Ignore
        // every non-user-input reason so selection never re-triggers a search.
        if (
          details.reason === 'input-change' ||
          details.reason === 'input-paste' ||
          details.reason === 'input-clear'
        ) {
          setQuery(v);
        }
      }}
      onOpenChange={(open, details) => {
        // Only an explicit dismissal (outside-click / Esc) exits an inline
        // editor — a selection-driven close is handled by onValueChange.
        if (!open && (details.reason === 'outside-press' || details.reason === 'escape-key')) {
          onClose?.();
        }
      }}
      // Server already filtered — don't filter again on the client.
      filter={null}
      disabled={disabled}
    >
      <div className={cn('relative', className)}>
        <ComboboxPrimitive.Input
          id={id}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          placeholder={placeholder}
          // Select the existing text on focus, so the first keystroke REPLACES the
          // selected item's label instead of appending to it. Before the field showed a
          // label at all this was moot; now that it does, typing "acme" into a field
          // reading "Acme Corp" would search for "Acme Corpacme".
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background py-2 pr-9 pl-3 text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:border-ring focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <ComboboxPrimitive.Trigger
          aria-label="Toggle options"
          className="absolute top-1/2 right-2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground disabled:opacity-50"
        >
          <IconChevronDown className="h-4 w-4 opacity-50" />
        </ComboboxPrimitive.Trigger>
      </div>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          positionMethod="fixed"
          className="z-[70]"
        >
          <ComboboxPrimitive.Popup
            className={cn(
              // Same width contract as `Combobox`'s popup above, and deliberately identical:
              // `--anchor-width` is a floor, not a ceiling. Re-pinning this to
              // `w-[var(--anchor-width)]` is precisely the revert that clipped option text on
              // narrow fields — see that comment for the UAT provenance and for the two
              // deliberate departures from `select.tsx`. `combobox.test.tsx` asserts both twins,
              // because a half-applied fix on this one is the easy miss.
              'z-[70] max-h-72 w-auto min-w-[max(8rem,var(--anchor-width))] max-w-[min(92vw,32rem)] overflow-y-auto rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-md',
              'data-[closed]:animate-out data-[open]:animate-in',
            )}
          >
            {/* Status row: below-threshold hint, loading, or no-matches. Only
                rendered when there are no items, so it collapses (empty:hidden)
                as soon as the server returns matches. */}
            <ComboboxPrimitive.Empty className="px-2 py-4 text-center text-muted-foreground text-sm empty:hidden">
              {items.length === 0
                ? belowMin
                  ? minCharsHint
                  : loading
                    ? loadingText
                    : emptyText
                : null}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List>
              {(item: ComboboxItem) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item}
                  className={cn(
                    'relative flex w-full cursor-default select-none items-start rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none',
                    // Same wrap contract as `Combobox`'s item above: `break-words` is required
                    // because the labels that clip are slash-joined and CSS does not break after a
                    // slash, and `items-start` plus the indicator's `top-2` are one decision rather
                    // than two.
                    'whitespace-normal break-words',
                    'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  )}
                >
                  <span className="absolute top-2 left-2 flex h-3.5 w-3.5 items-center justify-center">
                    <ComboboxPrimitive.ItemIndicator>
                      <IconCheck className="h-4 w-4" />
                    </ComboboxPrimitive.ItemIndicator>
                  </span>
                  {item.label}
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
AsyncCombobox.displayName = 'AsyncCombobox';

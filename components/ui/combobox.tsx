'use client';

import { Command as CommandPrimitive } from 'cmdk';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';
import { Command, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Combobox — the suite's searchable single-select, on Radix Popover + cmdk.
 *
 * The kit standard (Oct 2026). Built on the same primitives as the kit's dialog,
 * popover and dropdown, so a combobox opened inside a dialog shares one focus /
 * dismiss / scroll-lock stack instead of two libraries contending for it. It
 * replaces the Base UI combobox ported from ExpenseOS; the exported API —
 * `Combobox`, `AsyncCombobox`, `ComboboxItem` and their props — is unchanged, so
 * call sites need no edits. Its interaction comes from VeloCRM's SearchableSelect
 * and VeloLedger's AccountSelect.
 *
 * The field is a button showing the selected label; it opens a panel with a search
 * box and the options. Values are constrained to `items` — typing only filters.
 *
 * Decisions carried by both variants (see `ComboboxShell`):
 *  - The popover is `modal`. Inside a Radix dialog the dialog's scroll lock
 *    swallows wheel events on anything portalled outside it; a modal popover puts
 *    its own lock on top, so its list scrolls and focus stays in it until it closes.
 *  - It opens on mouse-down, as a native <select> does. Opening a form focuses its
 *    first field; clicking a picker blurs that field, a "required" message appears,
 *    the layout shifts between mouse-down and mouse-up and the click lands beside
 *    the trigger — the popover never opened.
 *  - In async mode cmdk's highlight is controlled: when server results replace the
 *    list, cmdk can be left highlighting nothing (seen with React Query results),
 *    so Enter did nothing. The highlight is moved to the first result.
 *  - Items are keyed by `value` (labels need not be unique) with a word-substring
 *    filter on the label: every word typed must appear in it.
 *  - Popup width: at least the trigger, free to grow to the longest option, capped
 *    to the viewport; options wrap (`break-words` — slash-joined labels such as
 *    "Courier/Shipping/Freight/Postage" have no soft break point) and the check
 *    pins to the top of a wrapped row. Both are UAT fixes from ExpenseOS;
 *    `combobox.test.tsx` pins them on both variants.
 */

export interface ComboboxItem {
  value: string;
  label: string;
  /**
   * Optional leading glyph — an emoji, not markup, because these lists are
   * built from data (an expense category's `icon`, a country's flag) rather than
   * from components.
   *
   * Rendered in the option row AND in the field, so a chosen item still looks
   * like the thing that was chosen.
   */
  icon?: string;
  /** Secondary text shown muted after the label in the row (e.g. a contact's email);
   *  searchable, not shown in the field. */
  description?: string;
  /** Extra text the client-side filter matches on (e.g. a contact's company). */
  keywords?: string[];
}

/** Options both variants take. */
interface SharedProps {
  /** Placeholder of the search box inside the panel. Default "Search…". */
  searchPlaceholder?: string;
  /**
   * Adds a first row that clears the selection (`onValueChange(null)`), labelled with
   * `clearLabel` (default: the placeholder). For optional fields, where "none" is a
   * valid answer the user must be able to get back to.
   */
  clearable?: boolean;
  clearLabel?: string;
}

export interface ComboboxProps extends SharedProps {
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
   * Ignored unless its `value` matches — a leftover from a previously-rendered row must
   * never label a different selection.
   */
  selectedItem?: ComboboxItem | null;
  /**
   * Accessible name for the field.
   *
   * A combobox whose visible label is a plain `<span>` beside it is announced as an
   * unnamed "combobox". Pass this wherever there is no `<label htmlFor={id}>`.
   */
  'aria-label'?: string;
}

/** Label shown in the field for an item — the icon rides along. */
function itemText(item: ComboboxItem): string {
  return item.icon ? `${item.icon} ${item.label}` : item.label;
}

/** Every word typed must appear in the label, description or keywords (case-insensitive). */
function wordFilter(value: string, search: string, keywords?: string[]): number {
  // The clear row shows only while nothing is typed.
  if (value === CLEAR_VALUE) return search.trim() ? 0 : 1;
  const text = (keywords ?? []).join(' ').toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w)) ? 1 : 0;
}

/**
 * Selected item and the list with it spliced in when the list does not hold it.
 *
 * Label sources, in order: the item in `items`; the caller's `selectedItem`; the item
 * the user last picked here. The last matters for AsyncCombobox: closing the picker
 * clears the query, the parent resets its results to [], and without it the field of a
 * caller that passes no `selectedItem` went blank right after a pick. (Base UI kept the
 * label as the input's own text, so the old component never showed this.) Every
 * fallback counts only for the value actually selected — a leftover must never label a
 * different selection.
 */
function useSelection(
  items: ComboboxItem[],
  value: string | null,
  selectedItem: ComboboxItem | null,
  picked: ComboboxItem | null,
) {
  const selected = React.useMemo(() => {
    if (value == null) return null;
    return (
      items.find((i) => i.value === value) ??
      (selectedItem?.value === value ? selectedItem : null) ??
      (picked?.value === value ? picked : null)
    );
  }, [items, value, selectedItem, picked]);
  // The dropdown shows the current selection rather than looking like it vanished —
  // for the async picker that is the state before anyone has typed a query.
  const listItems = React.useMemo(
    () =>
      selected && !items.some((i) => i.value === selected.value) ? [selected, ...items] : items,
    [items, selected],
  );
  return { selected, listItems };
}

const ITEM_CLASS = cn(
  'relative flex w-full cursor-default select-none items-start rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none',
  // Wrap instead of clipping; `break-words` is the load-bearing half — CSS does not
  // break after a slash. `items-start` and the indicator's `top-2` are one decision:
  // a wrapped row is tall, and a centred check would float mid-block.
  'whitespace-normal break-words',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
  'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
);

function OptionRow({
  item,
  checked,
  onPick,
  filterable,
}: {
  item: ComboboxItem;
  checked: boolean;
  onPick: (item: ComboboxItem) => void;
  filterable: boolean;
}) {
  return (
    <CommandPrimitive.Item
      value={item.value}
      keywords={
        filterable ? [item.label, item.description ?? '', ...(item.keywords ?? [])] : undefined
      }
      onSelect={() => onPick(item)}
      data-checked={checked}
      className={ITEM_CLASS}
    >
      <span className="absolute top-2 left-2 flex h-3.5 w-3.5 items-center justify-center">
        <CheckIcon className={cn('h-4 w-4', checked ? 'opacity-100' : 'opacity-0')} />
      </span>
      {item.icon && <span className="mr-1.5 shrink-0">{item.icon}</span>}
      <span>
        {item.label}
        {item.description && <span className="text-muted-foreground"> · {item.description}</span>}
      </span>
    </CommandPrimitive.Item>
  );
}

const CLEAR_VALUE = '__combobox_clear__';

/** The "no selection" row a `clearable` field starts with. */
function ClearRow({ label, checked, onClear }: { label: string; checked: boolean; onClear: () => void }) {
  return (
    <CommandPrimitive.Item
      value={CLEAR_VALUE}
      keywords={[]}
      onSelect={onClear}
      data-checked={checked}
      className={ITEM_CLASS}
    >
      <span className="absolute top-2 left-2 flex h-3.5 w-3.5 items-center justify-center">
        <CheckIcon className={cn('h-4 w-4', checked ? 'opacity-100' : 'opacity-0')} />
      </span>
      <span className="text-muted-foreground">{label}</span>
    </CommandPrimitive.Item>
  );
}

interface ShellProps {
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  searchPlaceholder?: string;
  selected: ComboboxItem | null;
  /** Typed search text (owned by the variant). */
  query: string;
  onQueryChange: (q: string) => void;
  /** false = the caller already filtered (server search). */
  filter: boolean;
  /** Async mode: first listed value — the highlight follows it when results change. */
  firstValue?: string;
  autoFocus?: boolean;
  /** Called on Escape / outside-click, never on selection. */
  onDismiss?: () => void;
  children: (close: () => void) => React.ReactNode;
}

function ComboboxShell({
  id,
  className,
  placeholder,
  disabled,
  ariaLabel,
  searchPlaceholder = 'Search…',
  selected,
  query,
  onQueryChange,
  filter,
  firstValue = '',
  autoFocus,
  onDismiss,
  children,
}: ShellProps) {
  const [open, setOpen] = React.useState(!!autoFocus && !disabled);
  const openedOnPointerDown = React.useRef(false);
  // Highlight, reset to the first result whenever the first result changes — adjusted
  // during render (React's pattern for state derived from props), not in an effect.
  const [highlight, setHighlight] = React.useState({ first: firstValue, value: firstValue });
  let active = highlight.value;
  if (!filter && highlight.first !== firstValue) {
    setHighlight({ first: firstValue, value: firstValue });
    active = firstValue;
  }
  const setActive = (v: string) => setHighlight((h) => ({ ...h, value: v }));

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && query) onQueryChange('');
  };
  const close = () => handleOpenChange(false);

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal>
      <PopoverTrigger asChild>
        {/* Radix's trigger adds aria-controls and aria-haspopup at runtime, so
            jsx-a11y's static "combobox needs aria-controls" warning is a false alarm. */}
        <button
          type="button"
          role="combobox"
          id={id}
          disabled={disabled}
          aria-expanded={open}
          aria-label={ariaLabel}
          onPointerDown={(e) => {
            if (disabled || e.button !== 0 || e.pointerType !== 'mouse') return;
            openedOnPointerDown.current = true;
            handleOpenChange(!open);
          }}
          onClick={(e) => {
            // Already toggled on pointer-down; stop Radix toggling it back.
            if (openedOnPointerDown.current) {
              openedOnPointerDown.current = false;
              e.preventDefault();
            }
          }}
          className={cn(
            'relative flex h-10 w-full items-center rounded-md border border-input bg-background py-2 pr-9 pl-3 text-left text-sm',
            'focus-visible:border-ring focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? itemText(selected) : (placeholder ?? '')}
          </span>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        onEscapeKeyDown={() => onDismiss?.()}
        onInteractOutside={() => onDismiss?.()}
        className={cn(
          // Width: AT LEAST the trigger, free to grow to fit the longest option, capped
          // to the viewport. Pinning it to the trigger width clipped option text on narrow
          // fields and small screens (ExpenseOS UAT, reported twice).
          'z-[70] w-auto min-w-[max(8rem,var(--radix-popover-trigger-width))] max-w-[min(92vw,32rem)] gap-0 p-0',
        )}
      >
        <Command
          // Controlled only in async mode; cmdk manages it when it filters itself.
          {...(filter ? {} : { value: active, onValueChange: setActive })}
          shouldFilter={filter}
          filter={wordFilter}
        >
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={onQueryChange} />
          {children(close)}
        </Command>
      </PopoverContent>
    </Popover>
  );
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
  searchPlaceholder,
  clearable = false,
  clearLabel,
}: ComboboxProps) {
  const [picked, setPicked] = React.useState<ComboboxItem | null>(null);
  const { selected, listItems } = useSelection(items, value, selectedItem, picked);
  const [query, setQuery] = React.useState('');
  return (
    <ComboboxShell
      id={id}
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      ariaLabel={ariaLabel}
      searchPlaceholder={searchPlaceholder}
      selected={selected}
      query={query}
      onQueryChange={setQuery}
      filter
    >
      {(close) => (
        <CommandList className="max-h-72 p-1">
          <CommandEmpty>{emptyText}</CommandEmpty>
          {clearable && (
            <ClearRow
              label={clearLabel ?? placeholder ?? 'None'}
              checked={value == null}
              onClear={() => {
                onValueChange(null);
                close();
              }}
            />
          )}
          {listItems.map((item) => (
            <OptionRow
              key={item.value}
              item={item}
              checked={item.value === value}
              filterable
              onPick={(item) => {
                setPicked(item);
                onValueChange(item.value);
                close();
              }}
            />
          ))}
        </CommandList>
      )}
    </ComboboxShell>
  );
}
Combobox.displayName = 'Combobox';

/**
 * AsyncCombobox — server-search variant of {@link Combobox}. Instead of filtering a
 * pre-loaded `items` array on the client, it observes what the user types, debounces
 * it, and (only once at least `minChars` characters are entered) calls
 * `onSearchChange` so the parent can run a server query and feed back the matching
 * `items`. Client-side filtering is off, so the server's results render as-is.
 *
 * The shared pattern for high-cardinality pickers (vendors, GL accounts, users …).
 * The parent owns the data; this component owns the UX (debounce, min-chars gate,
 * loading / empty hints, selected-label display).
 *
 * Pass `selectedItem` so the field shows the label of the current `value` even when
 * that item isn't in the latest search `items` (e.g. editing a record whose GL
 * account is already set).
 */
export interface AsyncComboboxProps extends SharedProps {
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
  /** More records match than `items` holds (the parent fetched a page). */
  hasMore?: boolean;
  /** Shown under the results when `hasMore`. */
  moreText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Open the picker on mount — useful for inline (in-cell) editors. */
  autoFocus?: boolean;
  /** Called when the popup is dismissed by outside-click or Escape (NOT on
   *  selection). Lets an inline editor exit edit mode on a click-away / Esc. */
  onClose?: () => void;
  /** Accessible name for the field — see ComboboxProps. */
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
  minCharsHint,
  loadingText = 'Searching…',
  emptyText = 'No matches',
  hasMore = false,
  moreText = 'More matches — keep typing to narrow the list.',
  disabled,
  id,
  className,
  autoFocus,
  onClose,
  'aria-label': ariaLabel,
  searchPlaceholder,
  clearable = false,
  clearLabel,
}: AsyncComboboxProps) {
  const [query, setQuery] = React.useState('');
  const trimmed = query.trim();
  const belowMin = trimmed.length < minChars;

  // Read through a ref so an inline arrow at the call site can't put a new identity
  // in the dep array below and re-run the effect on every parent render — which,
  // sub-threshold, fired `onSearchChange('')` continuously and reset the caller's
  // query mid-typing.
  const onSearchChangeRef = React.useRef(onSearchChange);
  React.useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  });

  React.useEffect(() => {
    if (belowMin) {
      onSearchChangeRef.current('');
      return;
    }
    const handle = setTimeout(() => onSearchChangeRef.current(trimmed), debounceMs);
    return () => clearTimeout(handle);
  }, [trimmed, belowMin, debounceMs]);

  const [picked, setPicked] = React.useState<ComboboxItem | null>(null);
  const { selected, listItems } = useSelection(items, value, selectedItem, picked);
  // While a query is typed, show only the server's results; before that, the
  // current selection (if any) so the panel doesn't look like it lost it.
  const shown = trimmed ? items : listItems;
  const showClear = clearable && !trimmed;
  const status =
    shown.length > 0
      ? null
      : belowMin
        ? (minCharsHint ?? `Type ${minChars} or more characters to search`)
        : loading
          ? loadingText
          : emptyText;

  return (
    <ComboboxShell
      id={id}
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      ariaLabel={ariaLabel}
      searchPlaceholder={searchPlaceholder}
      selected={selected}
      query={query}
      onQueryChange={setQuery}
      filter={false}
      firstValue={showClear ? CLEAR_VALUE : (shown[0]?.value ?? '')}
      autoFocus={autoFocus}
      onDismiss={onClose}
    >
      {(close) => (
        <CommandList className="max-h-72 p-1">
          {showClear && (
            <ClearRow
              label={clearLabel ?? placeholder ?? 'None'}
              checked={value == null}
              onClear={() => {
                onValueChange(null, null);
                close();
              }}
            />
          )}
          {status && (
            <div className="px-2 py-4 text-center text-muted-foreground text-sm" role="status">
              {status}
            </div>
          )}
          {shown.map((item) => (
            <OptionRow
              key={item.value}
              item={item}
              checked={item.value === value}
              filterable={false}
              onPick={(item) => {
                setPicked(item);
                onValueChange(item.value, item);
                close();
              }}
            />
          ))}
          {hasMore && shown.length > 0 && (
            <div className="px-2 py-1.5 text-muted-foreground text-xs">{moreText}</div>
          )}
        </CommandList>
      )}
    </ComboboxShell>
  );
}
AsyncCombobox.displayName = 'AsyncCombobox';

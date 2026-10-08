'use client';

/**
 * Entity pickers — thin wrappers around the design-system `AsyncCombobox` that
 * wire it to the `pickers.*` server search. Use these everywhere a vendor, GL
 * account, or user is selected: they query only after the min-chars threshold
 * (so the full table is never loaded) and resolve the label of an already-
 * selected value via `byId` (or an `initialItem` the caller already has).
 *
 * All three share one presentational core (identical UX + i18n hints); only the
 * tRPC procedure differs. Add a new entity picker by copying one wrapper.
 *
 * Ported from ExpenseOS `apps/web/src/components/pickers/EntityPickers.tsx` (550b2945);
 * VeloExpense ports two of the three (see the note where `VendorCombobox` was).
 */
import { AsyncCombobox, type ComboboxItem } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { trpc } from '@/lib/trpc/client';

/** Kept in sync with AsyncCombobox + the pickers router MIN_CHARS. */
const MIN_CHARS = 3;

/** Stable empty reference so `items` doesn't get a new array identity on every
 *  render while a search is empty/pending (which would churn the combobox). */
const EMPTY_ITEMS: ComboboxItem[] = [];

export interface EntityPickerProps {
  value: string | null;
  /** `item` carries the selected `{ value, label }` (null when cleared) so
   *  callers can use the label (e.g. to default a name field). */
  onValueChange: (value: string | null, item: ComboboxItem | null) => void;
  /** Known label for the current value — skips the `byId` lookup when set. */
  initialItem?: ComboboxItem | null;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Focus on mount — for inline (in-cell) editors. */
  autoFocus?: boolean;
  /** Called on outside-click / Esc dismissal — for inline editors to exit. */
  onClose?: () => void;
}

interface CoreProps extends Omit<EntityPickerProps, 'initialItem'> {
  items: ComboboxItem[];
  loading: boolean;
  onSearchChange: (q: string) => void;
  selectedItem: ComboboxItem | null;
}

/** Shared AsyncCombobox shell with localized hints — identical for every entity. */
function EntityAsyncCombobox({
  value,
  onValueChange,
  items,
  loading,
  onSearchChange,
  selectedItem,
  placeholder,
  disabled,
  id,
  className,
  autoFocus,
  onClose,
}: CoreProps) {
  const t = useTranslations('common');
  return (
    <AsyncCombobox
      value={value}
      onValueChange={onValueChange}
      items={items}
      loading={loading}
      onSearchChange={onSearchChange}
      selectedItem={selectedItem}
      minChars={MIN_CHARS}
      placeholder={placeholder}
      minCharsHint={t('picker.minChars', { count: MIN_CHARS })}
      loadingText={t('picker.searching')}
      emptyText={t('picker.empty')}
      disabled={disabled}
      id={id}
      className={className}
      autoFocus={autoFocus}
      onClose={onClose}
    />
  );
}

/**
 * The seed item, but only while it still describes the CURRENT selection.
 *
 * `initialItem` exists so a picker can render its saved value without a round trip — the
 * host already has the label. But hosts derive it from the SAVED row (`txn.vendor`), so the
 * moment somebody picks something else it describes the old selection, and it was winning:
 * `selectedItem={initialItem ?? byId.data}` displayed the previous vendor while `value` held
 * the new one, and the `byId` lookup that would have resolved the new label was disabled
 * because `initialItem` was set.
 *
 * Reported as "when I attempt to change vendor it keeps reverting to previous value" — not
 * a revert at all: the write was fine, the control was showing a stale label. Matching on
 * the id keeps the no-round-trip case and drops the seed as soon as the selection moves.
 */
function seedFor(
  initialItem: ComboboxItem | null | undefined,
  value: string | null | undefined,
): ComboboxItem | null {
  return initialItem && value && initialItem.value === value ? initialItem : null;
}

// VeloExpense: ExpenseOS's `VendorCombobox` is not ported — VeloExpense has no vendor
// list yet (server/routers/pickers.ts). It returns with the screen that needs it.

export function GlAccountCombobox({ value, initialItem, ...rest }: EntityPickerProps) {
  const [q, setQ] = useState('');
  const results = trpc.pickers.glAccounts.search.useQuery(
    { q },
    { enabled: q.length >= MIN_CHARS, staleTime: 30_000 },
  );
  const seed = seedFor(initialItem, value);
  const byId = trpc.pickers.glAccounts.byId.useQuery(
    { id: value ?? '' },
    { enabled: !!value && !seed },
  );
  return (
    <EntityAsyncCombobox
      {...rest}
      value={value}
      items={results.data ?? EMPTY_ITEMS}
      loading={results.isFetching}
      onSearchChange={setQ}
      selectedItem={seed ?? byId.data ?? null}
    />
  );
}

export function UserCombobox({ value, initialItem, ...rest }: EntityPickerProps) {
  const [q, setQ] = useState('');
  const results = trpc.pickers.users.search.useQuery(
    { q },
    { enabled: q.length >= MIN_CHARS, staleTime: 30_000 },
  );
  const seed = seedFor(initialItem, value);
  const byId = trpc.pickers.users.byId.useQuery({ id: value ?? '' }, { enabled: !!value && !seed });
  return (
    <EntityAsyncCombobox
      {...rest}
      value={value}
      items={results.data ?? EMPTY_ITEMS}
      loading={results.isFetching}
      onSearchChange={setQ}
      selectedItem={seed ?? byId.data ?? null}
    />
  );
}

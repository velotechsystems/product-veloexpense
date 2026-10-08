'use client';

/**
 * One way to show a country, and one way to pick one.
 *
 * Mileage rates rendered the raw code in a grey monospace chip; legal entities
 * rendered it in an outline badge. Same data, two looks, so the same country read
 * as two different things depending on which page you were on. This is the single
 * rendering, used by both.
 *
 * Currency gets the same treatment for the same reason: a free-text box that
 * accepts any three uppercase letters will eventually hold a currency the system
 * has no `Currency` row for, and nothing downstream can convert it.
 */

import { Combobox } from '@expenseos/design-system';
import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import { countryFlag, countryItems, countryName } from '@/lib/countries';
import { trpc } from '@/lib/trpc/client';

/** A country, as every surface should show it: flag, name, code. */
export function CountryLabel({ code }: { code: string | null | undefined }) {
  const locale = useLocale();
  if (!code) return <span className="text-muted-foreground text-xs">—</span>;
  const flag = countryFlag(code);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {flag && (
        <span aria-hidden className="shrink-0 leading-none">
          {flag}
        </span>
      )}
      <span className="truncate text-foreground text-sm">{countryName(code, locale)}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {code.toUpperCase()}
      </span>
    </span>
  );
}

export function CountryCombobox({
  id,
  value,
  onValueChange,
  disabled,
  placeholder,
}: {
  id?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const locale = useLocale();
  // ~250 entries with a locale-sorted label each. Memoised per locale so typing
  // in the field doesn't rebuild and re-sort the list on every keystroke.
  const items = useMemo(() => countryItems(locale), [locale]);
  return (
    <Combobox
      id={id}
      items={items}
      value={value ? value.toUpperCase() : null}
      onValueChange={onValueChange}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

/**
 * Currency picker over the ACTIVE `Currency` rows — the same table the money
 * helpers read, so anything selectable here is something the system can format
 * and convert.
 */
export function CurrencyCodeCombobox({
  id,
  value,
  onValueChange,
  disabled,
  placeholder,
}: {
  id?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const locale = useLocale();
  const currencies = trpc.appSettings.currencies.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const items = useMemo(
    () =>
      (currencies.data ?? []).map((c) => {
        const label = (c.label ?? {}) as Record<string, string>;
        const name = label[locale] ?? label.en ?? '';
        return {
          value: c.code,
          label: name ? `${name} (${c.code})` : c.code,
          icon: c.symbol || undefined,
        };
      }),
    [currencies.data, locale],
  );
  return (
    <Combobox
      id={id}
      items={items}
      value={value ? value.toUpperCase() : null}
      onValueChange={onValueChange}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

/**
 * The same picker, emitting the currency's ID rather than its code.
 *
 * Needed because `LegalEntity.homeCurrency` is a foreign key: the form has to hand
 * back something the column can hold. The code variant above is still right
 * wherever a code IS the stored value — `Expense.homeCurrency`, for instance, which
 * is a snapshot of a code and deliberately not a relation.
 */
export function CurrencyIdCombobox({
  id,
  value,
  onValueChange,
  disabled,
  placeholder,
}: {
  id?: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const locale = useLocale();
  const currencies = trpc.appSettings.currencies.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const items = useMemo(
    () =>
      (currencies.data ?? []).map((c) => {
        const label = (c.label ?? {}) as Record<string, string>;
        const name = label[locale] ?? label.en ?? '';
        return {
          value: c.id,
          // The code stays in the label: it is what people recognise, and the id
          // is not something anyone should have to see.
          label: name ? `${name} (${c.code})` : c.code,
          icon: c.symbol || undefined,
        };
      }),
    [currencies.data, locale],
  );
  return (
    <Combobox
      id={id}
      items={items}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

// ── RJSF widgets ────────────────────────────────────────────────────
//
// The admin-lookup drawers are schema-driven (RJSF), so a searchable picker gets
// in via `ui:widget` rather than by hand-writing the field. Registered here, next
// to the components they wrap, so a page that wants a country picker declares
// `'ui:widget': 'country'` and gets exactly the same control the bespoke drawers
// use — which is the point: one country picker, not two that drift.

/** Minimal slice of RJSF's WidgetProps this needs. Typing against RJSF's own
 *  generic here would drag the whole `@rjsf/utils` generic chain through a file
 *  that only reads three fields. */
interface WidgetLike {
  id?: string;
  value?: unknown;
  disabled?: boolean;
  readonly?: boolean;
  placeholder?: string;
  onChange: (value: unknown) => void;
}

export function CountryWidget({
  id,
  value,
  disabled,
  readonly,
  placeholder,
  onChange,
}: WidgetLike) {
  return (
    <CountryCombobox
      id={id}
      value={typeof value === 'string' && value ? value : null}
      // RJSF drops a field from formData when it's undefined; '' keeps the key
      // present so clearing a country persists as "no country" rather than as
      // "leave whatever was there".
      onValueChange={(v) => onChange(v ?? '')}
      disabled={disabled || readonly}
      placeholder={placeholder}
    />
  );
}

export function CurrencyWidget({
  id,
  value,
  disabled,
  readonly,
  placeholder,
  onChange,
}: WidgetLike) {
  return (
    <CurrencyCodeCombobox
      id={id}
      value={typeof value === 'string' && value ? value : null}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={disabled || readonly}
      placeholder={placeholder}
    />
  );
}

export function CurrencyIdWidget({
  id,
  value,
  disabled,
  readonly,
  placeholder,
  onChange,
}: WidgetLike) {
  return (
    <CurrencyIdCombobox
      id={id}
      value={typeof value === 'string' && value ? value : null}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={disabled || readonly}
      placeholder={placeholder}
    />
  );
}

/** The widget map every admin drawer passes to `SchemaForm`. */
export const ADMIN_PICKER_WIDGETS = {
  country: CountryWidget,
  currency: CurrencyWidget,
  currencyId: CurrencyIdWidget,
  // biome-ignore lint/suspicious/noExplicitAny: RJSF's WidgetProps generic is structurally compatible; narrowing it here would require re-declaring its whole generic chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- VeloExpense: the same exemption for ESLint
} as unknown as Record<string, React.ComponentType<any>>;

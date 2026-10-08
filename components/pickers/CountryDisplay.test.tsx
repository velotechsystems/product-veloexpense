import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import {
  ADMIN_PICKER_WIDGETS,
  CountryLabel,
  CountryWidget,
  CurrencyIdCombobox,
  CurrencyIdWidget,
  CurrencyWidget,
} from './CountryDisplay';

/**
 * One way to show a country, and one way to pick one.
 *
 * The point of the file is de-duplication: mileage rates rendered a raw code in a grey
 * monospace chip while legal entities rendered it in an outline badge, so the same
 * country read as two different things depending on which page you were on. What the
 * tests below actually protect is the pair of correctness rules underneath that:
 *
 *   · **Currency options come from the `Currency` table**, not from free text. A box
 *     that accepts any three uppercase letters eventually holds a currency with no
 *     `Currency` row, and nothing downstream can format or convert it.
 *   · **A cleared picker emits `''`, never `undefined`.** RJSF drops an undefined key
 *     from formData, so "no country" would be indistinguishable from "don't touch the
 *     country" — and clearing one would silently keep the old value.
 *
 * The Combobox itself is stubbed: it has its own suite in the design system, and
 * driving Base UI's popup here would test that library rather than this mapping.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@expenseos/design-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/design-system')>()),
  Combobox: ({
    id,
    items,
    value,
    onValueChange,
    disabled,
    placeholder,
  }: {
    id?: string;
    items: { value: string; label: string; icon?: string }[];
    value: string | null;
    onValueChange: (v: string | null) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <div>
      <input
        id={id}
        data-testid="value"
        readOnly
        value={value ?? ''}
        disabled={!!disabled}
        placeholder={placeholder}
      />
      <button type="button" onClick={() => onValueChange(items[0]?.value ?? null)}>
        pick-first
      </button>
      <button type="button" onClick={() => onValueChange(null)}>
        clear
      </button>
      <ul data-testid="items">
        {items.map((i) => (
          <li key={i.value}>{`${i.icon ?? ''}|${i.value}|${i.label}`}</li>
        ))}
      </ul>
    </div>
  ),
}));

const CURRENCIES = [
  {
    id: 'cur-cad',
    code: 'CAD',
    symbol: '$',
    label: { en: 'Canadian Dollar', 'fr-CA': 'Dollar canadien' },
  },
  { id: 'cur-jpy', code: 'JPY', symbol: '¥', label: {} },
  { id: 'cur-xxx', code: 'XXX', symbol: '', label: null },
];

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'appSettings.currencies.list': { data: CURRENCIES }, ...over.queries },
  });
}

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('<CountryLabel>', () => {
  it('shows the flag, the localized name and the code', () => {
    render(<CountryLabel code="CA" />);
    expect(screen.getByText('Canada')).toBeInTheDocument();
    expect(screen.getByText('CA')).toBeInTheDocument();
    expect(screen.getByText('🇨🇦')).toBeInTheDocument();
  });

  it('hides the flag from screen readers, because the name already says it', () => {
    // Announcing "flag: Canada, Canada, C A" is three readings of one fact.
    render(<CountryLabel code="CA" />);
    expect(screen.getByText('🇨🇦')).toHaveAttribute('aria-hidden');
  });

  it('normalizes a lowercase code', () => {
    // Codes are compared byte-for-byte downstream; the display should not imply that
    // `ca` and `CA` are different countries.
    render(<CountryLabel code="ca" />);
    expect(screen.getByText('CA')).toBeInTheDocument();
    expect(screen.getByText('Canada')).toBeInTheDocument();
  });

  it('shows an em dash for no country rather than an empty cell', () => {
    // An empty table cell reads as a rendering bug; a dash reads as "not set".
    const { container } = render(<CountryLabel code={null} />);
    expect(container.textContent).toBe('—');
  });

  it('falls back to the code when the platform has no name for it', () => {
    // `Intl.DisplayNames` returns nothing for a code it does not recognise; the raw
    // code is still more useful than a blank.
    render(<CountryLabel code="ZZ" />);
    expect(screen.getAllByText('ZZ').length).toBeGreaterThan(0);
  });

  it('renders no flag for something that is not a two-letter code', () => {
    // The flag is arithmetic on the code points; a three-letter value would produce a
    // pair of unrelated glyphs.
    const { container } = render(<CountryLabel code="CAN" />);
    expect(container.textContent).not.toMatch(/🇨/);
  });
});

describe('the currency pickers', () => {
  it('offers only currencies the system has a row for', () => {
    /**
     * This is the whole reason the picker exists instead of a text input: everything
     * selectable here is something `@expenseos/money` can format and convert.
     */
    setTrpc();
    render(<CurrencyIdCombobox value={null} onValueChange={() => {}} />);
    const items = screen.getByTestId('items').textContent ?? '';
    expect(items).toContain('cur-cad');
    expect(items).toContain('Canadian Dollar (CAD)');
  });

  it('labels a currency by name, and by code alone when it has no name', () => {
    // A row whose label JSON is empty or null still has to be pickable.
    setTrpc();
    render(<CurrencyIdCombobox value={null} onValueChange={() => {}} />);
    const items = screen.getByTestId('items').textContent ?? '';
    expect(items).toContain('|cur-jpy|JPY');
    expect(items).toContain('|cur-xxx|XXX');
  });

  it('uses the symbol as the leading glyph, and none when there is not one', () => {
    setTrpc();
    render(<CurrencyIdCombobox value={null} onValueChange={() => {}} />);
    const items = screen.getByTestId('items').textContent ?? '';
    expect(items).toContain('$|cur-cad');
    expect(items).toContain('|cur-xxx|'); // empty symbol → no glyph
  });

  it('emits the row id, not the code — the column is a foreign key', () => {
    /**
     * `LegalEntity.homeCurrency` is a relation, so the form has to hand back something
     * the column can hold. The code variant is right where a code IS the stored value
     * (`Expense.homeCurrency`, a deliberate snapshot).
     */
    const onChange = vi.fn();
    setTrpc();
    render(<CurrencyIdWidget value={null} onChange={onChange} />);
    return userEvent.click(screen.getByText('pick-first')).then(() => {
      expect(onChange).toHaveBeenCalledWith('cur-cad');
    });
  });

  it('emits the ISO code from the code variant', async () => {
    const onChange = vi.fn();
    setTrpc();
    render(<CurrencyWidget value={null} onChange={onChange} />);
    await userEvent.click(screen.getByText('pick-first'));
    expect(onChange).toHaveBeenCalledWith('CAD');
  });

  it('renders an empty list rather than failing while the query is in flight', async () => {
    setTrpc({ queries: { 'appSettings.currencies.list': { isLoading: true } } });
    render(<CurrencyIdCombobox value={null} onValueChange={() => {}} />);
    expect(screen.getByTestId('items').textContent).toBe('');
  });
});

describe('the RJSF widgets', () => {
  it('emits an empty string when cleared, so the key survives', async () => {
    /**
     * The rule with teeth. RJSF drops an undefined key from formData, so `undefined`
     * would mean "leave whatever was there" — clearing a country would silently keep
     * the old one.
     */
    const onChange = vi.fn();
    render(<CountryWidget value="CA" onChange={onChange} />);
    await userEvent.click(screen.getByText('clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('treats a non-string or empty value as no selection', () => {
    // A schema default or a half-migrated row can put anything here; only a non-empty
    // string is a country.
    const { rerender } = render(<CountryWidget value={undefined} onChange={() => {}} />);
    expect(screen.getByTestId('value')).toHaveValue('');
    rerender(<CountryWidget value={42} onChange={() => {}} />);
    expect(screen.getByTestId('value')).toHaveValue('');
    rerender(<CountryWidget value="" onChange={() => {}} />);
    expect(screen.getByTestId('value')).toHaveValue('');
  });

  it('normalizes the incoming value to upper case', () => {
    render(<CountryWidget value="ca" onChange={() => {}} />);
    expect(screen.getByTestId('value')).toHaveValue('CA');
  });

  it('passes the id and placeholder through, so the form label points at the input', () => {
    // A picker whose visible label is not associated with its input is announced as an
    // unnamed combobox.
    render(
      <CountryWidget id="root_country" placeholder="Search…" value={null} onChange={() => {}} />,
    );
    expect(screen.getByTestId('value')).toHaveAttribute('id', 'root_country');
    expect(screen.getByTestId('value')).toHaveAttribute('placeholder', 'Search…');
  });

  it('treats RJSF’s readonly as disabled, not just its disabled', async () => {
    /**
     * RJSF has both flags and uses `readonly` for a field the schema locked. Honouring
     * only `disabled` would leave a locked field editable.
     */
    const { rerender } = render(<CountryWidget readonly value={null} onChange={() => {}} />);
    expect(screen.getByTestId('value')).toBeDisabled();
    rerender(<CountryWidget disabled value={null} onChange={() => {}} />);
    expect(screen.getByTestId('value')).toBeDisabled();
    rerender(<CountryWidget value={null} onChange={() => {}} />);
    expect(screen.getByTestId('value')).not.toBeDisabled();
  });

  it('does not offer the id variant’s value uppercased — an id is not a code', () => {
    // Upper-casing a UUID would produce a value no row matches.
    setTrpc();
    render(<CurrencyIdWidget value="cur-cad" onChange={() => {}} />);
    expect(screen.getByTestId('value')).toHaveValue('cur-cad');
  });

  it('registers exactly the three widgets the admin drawers declare', () => {
    // A `ui:widget` naming something absent renders RJSF's fallback text box, silently.
    expect(Object.keys(ADMIN_PICKER_WIDGETS).sort()).toEqual(['country', 'currency', 'currencyId']);
  });
});

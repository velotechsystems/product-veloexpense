import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Asking for a trip, and picking the city it is to.
 *
 * The form is deliberately short: the traveller supplies a purpose, a destination and
 * dates, and **everything with a number on it is the server's to compute**. The archived
 * prototype had the browser post a budget, which is how the approved amount became
 * whatever the client felt like sending — so the tests assert what is sent as much as
 * what is refused.
 *
 * Two other properties matter:
 *
 *   · **Dates go over as midnight UTC.** A trip is a range of calendar dates and the
 *     server budgets it in UTC; attaching the browser's offset shifts a departure across
 *     midnight for everybody west of Greenwich.
 *   · **The city picker degrades to a text box** when Maps is not installed — a typed
 *     destination still prices from per-diem if it names a rate's city, which is worth
 *     more than a disabled field.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const t = (k: string, v?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return v ? `${full}:${Object.values(v).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
/** Select becomes plain buttons; Base UI's popup has its own suite. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => undefined,
  });
  return {
    ...actual,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: ReactNode;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div data-testid="select" data-value={value}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children?: ReactNode }) => {
      const { value } = React.useContext(Ctx);
      return <span>{children ?? value}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" data-option={value} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

import { NewTravelRequestDrawer } from './NewTravelRequestDrawer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPTIONS = {
  currencies: [
    { id: 'cur-cad', code: 'CAD', symbol: '$' },
    { id: 'cur-usd', code: 'USD', symbol: 'US$' },
  ],
  defaultCurrencyId: 'cur-cad',
  placeLookup: false,
};

/**
 * `lineKind` rides on every category, because it is what decides which fields a row
 * offers. Without it every row falls back to `STANDARD` and the kind-specific tests
 * below would pass against a component that renders nothing.
 */
const CATEGORIES = {
  items: [
    { id: 'cat-air', label: { en: 'Airfare' }, icon: '✈️', lineKind: 'AIRFARE' },
    { id: 'cat-meal', label: { en: 'Meals' }, icon: '🍽️', lineKind: 'DEPARTMENT_MEAL' },
    { id: 'cat-car', label: { en: 'Car rental' }, icon: '🚗', lineKind: 'CAR_RENTAL' },
    // A second airfare category, so switching between two categories of the SAME kind is
    // exercised — that must NOT clear what has been typed.
    { id: 'cat-air-intl', label: { en: 'Airfare (intl)' }, icon: '🌍', lineKind: 'AIRFARE' },
    // No icon, deliberately: a category is allowed to have none, and the row has to
    // render it without a stray leading space.
    { id: 'cat-hotel', label: { en: 'Hotel' }, icon: null, lineKind: 'LODGING' },
    // A STANDARD category with a per-diem behind it, and one without: the populated
    // amount is about the difference between the two.
    { id: 'cat-perdiem', label: { en: 'Meals (per-diem)' }, icon: '🍽️', lineKind: 'STANDARD' },
    { id: 'cat-parking', label: { en: 'Parking' }, icon: null, lineKind: 'STANDARD' },
  ],
  carCode: 'car',
};

const NO_DERIVATION = {
  derivedAmountMinor: null,
  basis: null,
  days: 0,
  dailyRateMinor: null,
  edgeDaysHalved: false,
  city: null,
};

/**
 * What the policy derives, by category and by trip length.
 *
 * `dataFor` rather than `data`, because the drawer re-asks as the trip above the rows
 * changes and "an untouched figure follows the dates" is only assertable if a shorter trip
 * answers with a smaller figure. $80.00 a day, no edge halving: 5 days is $400, 4 is $320.
 */
function derivationFor(input: unknown) {
  const { categoryId, departDate, returnDate } = input as {
    categoryId: string;
    departDate: string | null;
    returnDate: string | null;
  };
  if (categoryId === 'cat-perdiem' && departDate) {
    const days = returnDate
      ? Math.round((Date.parse(returnDate) - Date.parse(departDate)) / 86_400_000) + 1
      : 1;
    return {
      derivedAmountMinor: String(days * 8000),
      basis: 'PER_DIEM',
      days,
      dailyRateMinor: '8000',
      edgeDaysHalved: false,
      city: 'Toronto',
    };
  }
  // The meal kind: the total is heads × occurrences × days × the rate, derived from the
  // attendee payload — only the DAILY rate is of any use to its row.
  if (categoryId === 'cat-meal') {
    return { ...NO_DERIVATION, derivedAmountMinor: '32000', dailyRateMinor: '8000', days: 4 };
  }
  return NO_DERIVATION;
}

function setTrpc(over: TrpcMockConfig = {}, options: unknown = OPTIONS) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'travelRequests.formOptions': { data: options },
      'travelRequests.searchDestinations': { data: { items: [], error: null } },
      'travelRequests.categories': { data: CATEGORIES },
      'travelRequests.previewLine': { dataFor: derivationFor },
      ...over.queries,
    },
  });
}

const onClose = vi.fn();
const onCreated = vi.fn();

const show = () => render(<NewTravelRequestDrawer onClose={onClose} onCreated={onCreated} />);

const option = (value: string) => document.querySelector(`[data-option="${value}"]`) as HTMLElement;
const submit = () => screen.getByRole('button', { name: 'travel.form.submit' });
/**
 * The date and free-text fields carry no accessible name of their own (the FormField
 * label is not associated), so address them by position: depart then return, purpose
 * then notes.
 */
const dates = () =>
  Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
const departInput = () => dates()[0];
const returnInput = () => dates()[1];
const purposeInput = () => document.querySelectorAll('textarea')[0] as HTMLTextAreaElement;

/** Fill the minimum the form needs, so a test about one field is about that field. */
async function fillValid(
  user: ReturnType<typeof userEvent.setup>,
  over: { purpose?: string; destination?: string; depart?: string; ret?: string } = {},
) {
  await user.type(purposeInput(), over.purpose ?? 'Client visit');
  await user.type(
    screen.getAllByLabelText('travel.form.searchCity')[0],
    over.destination ?? 'Toronto',
  );
  fireEvent.change(departInput(), { target: { value: over.depart ?? '2026-09-01' } });
  if (over.ret !== '') {
    fireEvent.change(returnInput(), { target: { value: over.ret ?? '2026-09-05' } });
  }
}

const created = (onCall: ReturnType<typeof vi.fn>) =>
  onCall.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  onClose.mockReset();
  onCreated.mockReset();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── What it refuses ───────────────────────────────────────────────────────────

describe('what it refuses to submit', () => {
  it('starts disabled', () => {
    setTrpc();
    show();
    expect(submit()).toBeDisabled();
  });

  it('enables once purpose, destination, a departure and a currency are there', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    expect(submit()).toBeEnabled();
  });

  it('will not take a purpose too short to be one', async () => {
    // An approver reads the purpose; "x" is not a justification for a trip.
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user, { purpose: 'xy' });
    expect(submit()).toBeDisabled();
  });

  it('will not take a destination of only spaces', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user, { destination: '   ' });
    expect(submit()).toBeDisabled();
  });

  it('tells the traveller a round trip needs a return date, before sending', async () => {
    /**
     * The server enforces it too. Mirroring it here is the difference between a form
     * that explains itself and one that fails after the click.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user, { ret: '' });
    expect(screen.getByText('travel.errors.roundTripNeedsReturn')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('refuses a return before the departure', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user, { depart: '2026-09-10', ret: '2026-09-01' });
    expect(screen.getByText('travel.errors.returnBeforeDepart')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('needs no return date for a one-way trip, and locks the field', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user, { ret: '' });
    await user.click(option('ONE_WAY'));
    expect(returnInput()).toBeDisabled();
    expect(submit()).toBeEnabled();
  });

  it('will not submit without a currency to price it in', async () => {
    // The server computes the budget; it cannot pick the currency to compute it in.
    const user = userEvent.setup();
    setTrpc({}, { ...OPTIONS, defaultCurrencyId: null, currencies: [] });
    show();
    await fillValid(user);
    expect(submit()).toBeDisabled();
  });
});

// ── What it sends ─────────────────────────────────────────────────────────────

describe('what it sends', () => {
  it('sends the trip, and no figures of its own', async () => {
    /**
     * The archived prototype posted a budget from the browser. Everything with a number
     * on it is the server's, and this payload is the boundary that keeps it that way.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(submit());
    const payload = created(onCall);
    expect(payload).toMatchObject({
      purpose: 'Client visit',
      tripType: 'ROUND_TRIP',
      includeCar: false,
      currencyId: 'cur-cad',
    });
    expect(payload).not.toHaveProperty('budgetMinor');
    expect(payload).not.toHaveProperty('estimate');
  });

  it('sends the dates as midnight UTC', async () => {
    /**
     * A trip is a range of calendar dates. Attaching the browser's offset shifts a
     * departure across midnight for everybody west of Greenwich, and the server budgets
     * per UTC day.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(submit());
    expect(created(onCall).departDate).toBe('2026-09-01T00:00:00.000Z');
    expect(created(onCall).returnDate).toBe('2026-09-05T00:00:00.000Z');
  });

  it('sends no return date for a one-way trip, whatever was typed before', async () => {
    // Switching to one-way after picking a return must not send the stale date.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(option('ONE_WAY'));
    await user.click(submit());
    expect(created(onCall).returnDate).toBeNull();
  });

  it('trims the purpose and drops an empty note', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user, { purpose: '  Client visit  ' });
    await user.click(submit());
    expect(created(onCall).purpose).toBe('Client visit');
    expect(created(onCall).notes).toBeNull();
  });

  it('seeds the per-diem match from a typed destination', async () => {
    /**
     * Without Maps there is no placeId, so the typed text is all there is — and `city`
     * is what a per-diem rate matches on, so it gets the text too.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user, { destination: 'Tokyo' });
    await user.click(submit());
    expect(created(onCall).destination).toEqual({
      placeId: null,
      label: 'Tokyo',
      city: 'Tokyo',
      country: null,
    });
  });

  it('sends an empty origin rather than omitting it', async () => {
    // The server reads a blank origin as "from home base", which is a real answer.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(submit());
    expect(created(onCall).origin).toEqual({
      placeId: null,
      label: '',
      city: null,
      country: null,
    });
  });

  it('carries the car request', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(screen.getByText('travel.form.includeCar'));
    await user.click(submit());
    expect(created(onCall).includeCar).toBe(true);
  });

  it('uses the chosen currency over the default', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(option('cur-usd'));
    await user.click(submit());
    expect(created(onCall).currencyId).toBe('cur-usd');
  });

  it('closes and refreshes once the request exists', async () => {
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { outcome: 'success' } } });
    show();
    await fillValid(user);
    await user.click(submit());
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a refusal and stays open', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.create': {
          outcome: 'error',
          error: { message: 'Travel is frozen this quarter' },
        },
      },
    });
    show();
    await fillValid(user);
    await user.click(submit());
    expect(await screen.findByText('Travel is frozen this quarter')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says it is saving while in flight', () => {
    setTrpc({ mutations: { 'travelRequests.create': { isPending: true } } });
    show();
    expect(screen.getByRole('button', { name: 'travel.form.saving' })).toBeDisabled();
  });

  it('closes without asking on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await user.click(screen.getByRole('button', { name: 'travel.form.cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── The city picker ───────────────────────────────────────────────────────────

describe('the city picker', () => {
  const withMaps = (over: TrpcMockConfig = {}) => setTrpc(over, { ...OPTIONS, placeLookup: true });

  it('degrades to a plain text field without the Maps integration', () => {
    /**
     * A typed destination still prices from per-diem if it names a rate's city, which is
     * worth more than a disabled field.
     */
    setTrpc();
    show();
    expect(screen.getAllByLabelText('travel.form.searchCity')[0]).toBeEnabled();
  });

  it('searches only once there is enough to search on', async () => {
    /**
     * Below three characters every provider returns noise, and it is BILLABLE noise.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    withMaps({
      queries: {
        'travelRequests.searchDestinations': { data: { items: [], error: null }, onCall },
      },
    });
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'To');
    expect(onCall.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
    await user.type(field, 'r');
    expect(onCall.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
  });

  it('keeps a typed city that was never picked from the list', async () => {
    /**
     * The regression that took three end-to-end tests down with it.
     *
     * The autocomplete input renders `open ? query : value.label`, and typing only ever
     * set `query` — `onChange` ran solely to invalidate an existing `placeId`. So text
     * that was typed but never picked was committed nowhere, and the moment the list
     * closed the field rendered `value.label`: still empty. The destination silently
     * emptied itself, Submit stayed disabled, and nothing explained why.
     *
     * It hid behind the environment. Without a Places key the fallback branch renders a
     * plain text input that has always kept what it was given, so this only became
     * reachable once a key existed — and the end-to-end suite carried a comment asserting
     * that no local environment would ever have one.
     *
     * Asserted on what `create` receives, not on the input's value, because the point is
     * that the typed city reaches the server.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    withMaps({
      queries: {
        // A real key that finds nothing for this string: the list opens and is empty,
        // which is exactly the case where there is no suggestion to pick.
        'travelRequests.searchDestinations': { data: { items: [], error: null } },
      },
      mutations: { 'travelRequests.create': { onCall } },
    });
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'Toronto');
    // Leaving the field is what used to erase it.
    await user.type(purposeInput(), 'Client visit');
    fireEvent.change(departInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(returnInput(), { target: { value: '2026-09-05' } });
    await user.click(submit());
    expect(created(onCall).destination).toMatchObject({
      placeId: null,
      label: 'Toronto',
      // Seeded with the same text, because per-diem matches the city as a substring.
      city: 'Toronto',
    });
  });

  it('offers the cities it found, and takes the pick apart into its fields', async () => {
    /**
     * A city — not an address — is what per-diem matches on and what the hotel query
     * takes, so the server returns the parts already split out.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    withMaps({
      queries: {
        'travelRequests.searchDestinations': {
          data: {
            items: [
              {
                placeId: 'p-1',
                description: 'Toronto, ON, Canada',
                city: 'Toronto',
                country: 'CA',
              },
            ],
            error: null,
          },
        },
      },
      mutations: { 'travelRequests.create': { onCall } },
    });
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'Toronto');
    await user.click(screen.getByRole('button', { name: 'Toronto, ON, Canada' }));
    await user.type(purposeInput(), 'Client visit');
    fireEvent.change(departInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(returnInput(), { target: { value: '2026-09-05' } });
    await user.click(submit());
    expect(created(onCall).destination).toEqual({
      placeId: 'p-1',
      label: 'Toronto, ON, Canada',
      city: 'Toronto',
      country: 'CA',
    });
  });

  it('says a lookup FAILED rather than saying there are no matches', async () => {
    /**
     * "That city doesn't exist" and "somebody needs to fix the key" are different
     * problems, and only one of them is the traveller's.
     */
    const user = userEvent.setup();
    withMaps({
      queries: {
        'travelRequests.searchDestinations': {
          data: { items: [], error: 'REQUEST_DENIED' },
        },
      },
    });
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'Toronto');
    expect(screen.getByText('travel.form.lookupFailed:REQUEST_DENIED')).toBeInTheDocument();
  });

  it('says there are genuinely no matches', async () => {
    const user = userEvent.setup();
    withMaps();
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'Zzzz');
    expect(screen.getByText('travel.form.noMatches')).toBeInTheDocument();
  });

  it('invalidates the picked place once the text is edited', async () => {
    /**
     * The text no longer describes the place the id pointed at, and sending both would
     * price a trip to somewhere the traveller did not type.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    withMaps({
      queries: {
        'travelRequests.searchDestinations': {
          data: {
            items: [
              {
                placeId: 'p-1',
                description: 'Toronto, ON, Canada',
                city: 'Toronto',
                country: 'CA',
              },
            ],
            error: null,
          },
        },
      },
      mutations: { 'travelRequests.create': { onCall } },
    });
    show();
    const field = screen.getAllByLabelText('travel.form.searchCity')[0];
    await user.click(field);
    await user.type(field, 'Toronto');
    await user.click(screen.getByRole('button', { name: 'Toronto, ON, Canada' }));
    await user.click(field);
    await user.type(field, 'Montreal');
    await user.type(purposeInput(), 'Client visit');
    fireEvent.change(departInput(), { target: { value: '2026-09-01' } });
    fireEvent.change(returnInput(), { target: { value: '2026-09-05' } });
    await user.click(submit());
    expect((created(onCall).destination as { placeId: unknown }).placeId).toBeNull();
  });
});

// ── The planned budget, filed with the request ────────────────────────────────

describe('the planned budget', () => {
  /**
   * A traveller used to have to save the trip, wait for the drawer to reopen on the saved
   * record, and only then start adding what they intended to spend — two screens and a
   * round trip for one act.
   */
  const addRow = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }));

  const amountBox = (i = 0) => screen.getAllByPlaceholderText('0.00')[i] as HTMLInputElement;

  /**
   * Pick a category on the row at `rowIndex`.
   *
   * Every row renders its own set of option buttons under the Select mock, so the option
   * has to be addressed by ROW as well as by id — `document.querySelector` would always
   * answer with the first row's.
   */
  const pickCategory = async (
    user: ReturnType<typeof userEvent.setup>,
    rowIndex: number,
    categoryId: string,
  ) => {
    const all = Array.from(
      document.querySelectorAll(`[data-option="${categoryId}"]`),
    ) as HTMLElement[];
    await user.click(all[rowIndex]);
  };
  const notesBox = (i = 0) =>
    screen.getAllByPlaceholderText('travel.line.notesPlaceholder')[i] as HTMLInputElement;

  it('starts with no rows at all', () => {
    // Nothing is invented: a request filed with no budget has none.
    setTrpc();
    show();
    expect(screen.queryByPlaceholderText('0.00')).not.toBeInTheDocument();
  });

  it('files the rows with the request, in the order they were written', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-air');
    await user.type(amountBox(), '1450');
    await user.type(notesBox(), 'Direct, meeting starts 09:00');
    await addRow(user);
    await pickCategory(user, 1, 'cat-meal');
    await user.click(submit());

    expect(created(onCall).lines).toEqual([
      {
        categoryId: 'cat-air',
        amountMinor: 145000n,
        notes: 'Direct, meeting starts 09:00',
      },
      { categoryId: 'cat-meal', notes: null },
    ]);
  });

  it('omits a blank amount rather than sending a zero', async () => {
    /**
     * The whole reason the browser is not allowed to post a total: an omitted amount is
     * the SERVER deriving one — a per-diem for the destination, a cap × the trip's days.
     * A zero would land as a MANUAL zero and suppress the derivation entirely.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-meal');
    await user.click(submit());

    expect(created(onCall).lines).toEqual([{ categoryId: 'cat-meal', notes: null }]);
  });

  it('will not submit while a row has no category', async () => {
    // A row somebody added and has not chosen on is not an item, and posting it would be
    // refused for a category that is not a uuid — a confusing way to learn you left a
    // row empty.
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    expect(submit()).toBeEnabled();
    await addRow(user);
    expect(submit()).toBeDisabled();
    await pickCategory(user, 0, 'cat-air');
    expect(submit()).toBeEnabled();
  });

  it('removes the row that was trashed, not the one below it', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-air');
    await addRow(user);
    await pickCategory(user, 1, 'cat-meal');
    await user.type(amountBox(1), '80');

    await user.click(screen.getAllByRole('button', { name: /plannedRemove/ })[0]);
    await user.click(submit());
    expect(created(onCall).lines).toEqual([
      { categoryId: 'cat-meal', amountMinor: 8000n, notes: null },
    ]);
  });

  it('sends no lines key at all when nothing was planned', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await user.click(submit());
    expect(created(onCall).lines).toEqual([]);
  });
});

// ── The kind's own fields, before the request exists ──────────────────────────

/**
 * A row here used to offer a category, an amount and notes and nothing else, whatever the
 * category was — so "department meal has number of people" and "airfare has fields" read
 * as missing features.
 *
 * They are two different cases, and the distinction is the whole design:
 *
 *   · Attendees, and days × a daily cap, are PAYLOAD. Nothing fetches them, and
 *     `travelRequests.create` has always taken a payload per line — so there was never a
 *     reason to make somebody file the trip first. These tests assert they reach the wire.
 *   · A fare search is not payload. Cabin and stops are ARGUMENTS to a provider call that
 *     writes its quote onto a line that exists, and there is no line until submit. That
 *     row says so instead of showing a Search button that cannot search.
 */
describe('a planned row of a kind that has its own fields', () => {
  const addRow = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }));

  const pickCategory = async (
    user: ReturnType<typeof userEvent.setup>,
    rowIndex: number,
    categoryId: string,
  ) => {
    const all = Array.from(
      document.querySelectorAll(`[data-option="${categoryId}"]`),
    ) as HTMLElement[];
    await user.click(all[rowIndex]);
  };

  it('offers days and a daily cap on a car, and files them as the payload', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-car');

    await user.type(screen.getByLabelText('travel.line.days'), '4');
    await user.type(screen.getByLabelText('travel.line.dailyCap'), '65');
    await user.click(submit());

    expect(created(onCall).lines).toEqual([
      {
        categoryId: 'cat-car',
        // No amount: the server multiplies the cap by the days. A figure computed here
        // and posted would be the browser pricing the trip, which is the one thing it
        // must never do.
        payload: { days: 4, dailyCapMinor: '6500' },
        notes: null,
      },
    ]);
  });

  it('offers the attendee editor on a department meal, and files who is at it', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-meal');

    // The editor writes on BLUR, which is what "as you add, the amount changes" has to
    // mean — a write per keystroke would post a half-typed name.
    await user.click(screen.getByRole('button', { name: 'travel.attendees.add' }));
    const name = screen.getByLabelText('travel.attendees.name');
    await user.type(name, 'Ada Lovelace');
    fireEvent.blur(name);
    await user.click(submit());

    const lines = created(onCall).lines as { payload: { attendees: unknown[] } }[];
    const line = lines[0];
    expect(line.payload.attendees).toEqual([
      { name: 'Ada Lovelace', company: null, isExternal: false },
    ]);
  });

  it('says the fare search opens once the request exists, rather than offering one', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addRow(user);
    await pickCategory(user, 0, 'cat-air');

    expect(screen.getByText('travel.detail.plannedSearchAfterCreateFlight')).toBeInTheDocument();
    // Emphatically not a button. One here would call a search keyed on a line that does
    // not exist, and the traveller would meet the failure as an error.
    expect(screen.queryByRole('button', { name: /search/i })).not.toBeInTheDocument();
  });

  it('drops the previous kind’s payload when the category changes', async () => {
    /**
     * A day count is not a head count. Leaving one behind would post a payload the server
     * validates against a kind that no longer applies — refused, and for a reason nobody
     * looking at the row could see.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-car');
    await user.type(screen.getByLabelText('travel.line.days'), '4');

    await pickCategory(user, 0, 'cat-air');
    expect(screen.queryByLabelText('travel.line.days')).not.toBeInTheDocument();

    await user.click(submit());
    expect(created(onCall).lines).toEqual([{ categoryId: 'cat-air', notes: null }]);
  });

  it('withholds the amount hint until there is a row to say it about', async () => {
    // It reads as an instruction about a field that is not on screen otherwise.
    const user = userEvent.setup();
    setTrpc();
    show();
    expect(screen.queryByText('travel.detail.plannedAmountHint')).not.toBeInTheDocument();
    await addRow(user);
    expect(screen.getByText('travel.detail.plannedAmountHint')).toBeInTheDocument();
  });

  it('labels the category and the amount from one row above both of them', async () => {
    /**
     * The alignment bug, asserted structurally.
     *
     * Each control used to sit in its own `Field`, and a `Field` sizes its own label
     * block — so "Category" rendered six pixels above "Amount" and took its control with
     * it. Measured in a browser: category at y=612, amount at y=618.
     *
     * One label ROW over one control ROW, sharing the same flex proportions, makes the
     * alignment structural rather than a coincidence of two computed heights. So: no
     * `<label>` may wrap either control.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await addRow(user);

    const amount = screen.getByLabelText('travel.detail.plannedAmount');
    expect(amount.closest('label')).toBeNull();
    const select = document.querySelector('[data-testid="select"]') as HTMLElement;
    expect(select.closest('label')).toBeNull();
  });

  it('says the hotel search opens once the request exists, on a lodging row', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addRow(user);
    await pickCategory(user, 0, 'cat-hotel');
    expect(screen.getByText('travel.detail.plannedSearchAfterCreateStay')).toBeInTheDocument();
  });

  it('keeps what was typed when the category changes but the kind does not', async () => {
    /**
     * The other half of the clearing rule. Moving from one airfare category to another is
     * a recategorisation, not a change of what the line IS — throwing away the fare
     * somebody typed would be a silent retype for no reason.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-air');
    await user.type(screen.getByLabelText('travel.detail.plannedAmount'), '1450');

    await pickCategory(user, 0, 'cat-air-intl');
    await user.click(submit());

    expect(created(onCall).lines).toEqual([
      { categoryId: 'cat-air-intl', amountMinor: 145000n, notes: null },
    ]);
  });
});

// ── The populated allowance ───────────────────────────────────────────────────

/**
 * Picking a category with a per-diem behind it fills the amount in.
 *
 * The figure is the SERVER's — `previewLine` runs the same ladder the save will — shown
 * before the save instead of after it. Two things have to stay true for that to be safe:
 * the populated figure, left alone, must go over as NO amount (the server derives, the
 * line lands PER_DIEM), and a figure typed over it must go over as the override it is,
 * with the note the server would otherwise refuse it for.
 */
describe('a category that carries a per-diem', () => {
  const addRow = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'travel.detail.plannedAddItem' }));
  const pickCategory = async (
    user: ReturnType<typeof userEvent.setup>,
    rowIndex: number,
    categoryId: string,
  ) => {
    const all = Array.from(
      document.querySelectorAll(`[data-option="${categoryId}"]`),
    ) as HTMLElement[];
    await user.click(all[rowIndex]);
  };
  const amountBox = (i = 0) => screen.getAllByPlaceholderText('0.00')[i] as HTMLInputElement;
  const notesBox = (i = 0) =>
    screen.getAllByPlaceholderText('travel.line.notesPlaceholder')[i] as HTMLInputElement;
  const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
  const warning = () => screen.queryByText(/travel\.line\.overrides:/);

  it('populates the amount with what the policy derives, and captions it', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    // Populated by an effect once the preview answers, so it is awaited.
    await waitFor(() => expect(amountBox()).toHaveValue(400));
    // The same sentence the saved line will carry under its figure.
    expect(screen.getByText(/travel\.line\.summary\.perDiem:5,Toronto/)).toBeInTheDocument();
    expect(warning()).toBeNull();
  });

  it('asks with the trip as typed — destination, dates and currency', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'travelRequests.previewLine': { dataFor: derivationFor, onCall } },
    });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    const asked = onCall.mock.calls.at(-1) as [unknown, { enabled: boolean }];
    expect(asked[0]).toEqual({
      categoryId: 'cat-perdiem',
      destinationCity: 'Toronto',
      departDate: '2026-09-01T00:00:00.000Z',
      returnDate: '2026-09-05T00:00:00.000Z',
      currencyId: 'cur-cad',
    });
    expect(asked[1].enabled).toBe(true);
  });

  it('does not ask until the dates are coherent', async () => {
    // A round trip with no return would price as one day and then jump — a figure that
    // moves under the traveller reads as unreliable.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'travelRequests.previewLine': { dataFor: derivationFor, onCall } },
    });
    show();
    await fillValid(user, { ret: '' });
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    const asked = onCall.mock.calls.at(-1) as [unknown, { enabled: boolean }];
    expect(asked[1].enabled).toBe(false);
    expect(amountBox()).toHaveValue(null);
  });

  it('sends NO amount when the populated figure is left alone', async () => {
    /**
     * The whole reason the browser is not allowed to post a total: the figure in the box is
     * the server's own derivation, and sending it back would only relabel it as typed. The
     * server derives it again on save, and the line lands as PER_DIEM.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    await waitFor(() => expect(amountBox()).toHaveValue(400));
    await user.click(submit());
    expect(created(onCall).lines).toEqual([{ categoryId: 'cat-perdiem', notes: null }]);
  });

  it('sends a figure typed over it as the override it is, once explained', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    await waitFor(() => expect(amountBox()).toHaveValue(400));

    change(amountBox(), '450');
    // Said WHILE it differs, before anything is sent — and the notes field says what it
    // is waiting for.
    expect(warning()).toHaveTextContent(/400/);
    expect(notesBox()).toHaveAttribute('aria-required', 'true');
    expect(notesBox()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('travel.line.noteRequiredForOverride')).toBeInTheDocument();
    // Create waits. The server would refuse this exact write; the traveller should not
    // have to press a button to be told so.
    expect(submit()).toBeDisabled();

    change(notesBox(), 'Client dinner ran over the allowance');
    expect(notesBox()).not.toHaveAttribute('aria-invalid');
    expect(submit()).toBeEnabled();
    await user.click(submit());
    expect(created(onCall).lines).toEqual([
      {
        categoryId: 'cat-perdiem',
        amountMinor: 45000n,
        notes: 'Client dinner ran over the allowance',
      },
    ]);
  });

  it('lets the figure be typed back to the derivation, and stops asking', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.create': { onCall } } });
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    await waitFor(() => expect(amountBox()).toHaveValue(400));
    change(amountBox(), '450');
    expect(submit()).toBeDisabled();
    change(amountBox(), '400');
    expect(warning()).toBeNull();
    expect(notesBox()).not.toHaveAttribute('aria-required');
    expect(submit()).toBeEnabled();
    await user.click(submit());
    expect(created(onCall).lines).toEqual([{ categoryId: 'cat-perdiem', notes: null }]);
  });

  it('re-prices an untouched figure when the trip changes, and leaves a typed one alone', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    await addRow(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    await pickCategory(user, 1, 'cat-perdiem');
    await waitFor(() => expect(amountBox(0)).toHaveValue(400));
    await waitFor(() => expect(amountBox(1)).toHaveValue(400));
    change(amountBox(1), '450');

    // One day shorter: $320 now.
    fireEvent.change(returnInput(), { target: { value: '2026-09-04' } });
    await waitFor(() => expect(amountBox(0)).toHaveValue(320));
    // The typed figure survives; the warning now names the NEW derivation.
    expect(amountBox(1)).toHaveValue(450);
    expect(warning()).toHaveTextContent(/320/);
  });

  it('clears a populated figure when the category changes to one with no rate', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-perdiem');
    await waitFor(() => expect(amountBox()).toHaveValue(400));
    // Same kind, so nothing else is cleared — but the derivation was the OLD category's.
    await pickCategory(user, 0, 'cat-parking');
    await waitFor(() => expect(amountBox()).toHaveValue(null));
    expect(screen.queryByText(/travel\.line\.summary\.perDiem/)).toBeNull();
  });

  it('hands the DAILY rate to the attendee editor, and leaves a meal’s amount alone', async () => {
    // A meal's total is heads × occurrences × days × the rate, derived server-side from the
    // attendees; populating its amount with the trip allowance would be the wrong number.
    const user = userEvent.setup();
    setTrpc();
    show();
    await fillValid(user);
    await addRow(user);
    await pickCategory(user, 0, 'cat-meal');
    await waitFor(() =>
      expect(screen.getByLabelText('travel.attendees.ratePerPerson')).toHaveValue(80),
    );
    expect(amountBox()).toHaveValue(null);
  });
});

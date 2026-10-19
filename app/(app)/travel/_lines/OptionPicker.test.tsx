import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The flight and stay pickers.
 *
 * Three properties here are the reason the component looks the way it does, and none of
 * them had a test:
 *
 *   · **searching SPENDS.** Every press consumes a SerpApi credit from a paid plan, so the
 *     search is a button and never an effect. A regression that made it search on mount —
 *     or on a date change — would bill the org per keystroke and pass every other gate.
 *   · **picking does not send a price.** A chosen option goes as a `candidateId` and
 *     nothing else; the server re-reads the amount from its own cache. This is the
 *     archived prototype's posted-total bug, and the assertion is that the mutation input
 *     carries no amount field.
 *   · **nothing found is FOUR different answers.** "No plan", "no airports", "no flights
 *     on this route" and "the provider failed" have three different owners between them,
 *     and an empty list tells none of them apart.
 */

const h: { trpc: ReturnType<typeof createTrpcMock> } = {
  trpc: createTrpcMock({}),
};

vi.mock('next-intl', () => ({
  // VeloExpense (w6-02): the registry's default (en-CA), not a literal (check:i18n).
  useLocale: () => DEFAULT_LOCALE,
  useTranslations: (ns?: string) => {
    const t = (k: string, v?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return v ? `${full}:${Object.values(v).join(',')}` : full;
    };
    t.has = () => false;
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

/**
 * `Select` as a plain listbox of buttons.
 *
 * Base UI renders its options into a portal and needs a pointer environment jsdom does not
 * provide. What matters here is that choosing a cabin reaches the SEARCH payload, not how
 * the popup animates.
 */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ onValueChange: (v: string) => void }>({
    onValueChange: () => {},
  });
  return {
    ...actual,
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange: (v: string) => void;
    }) => <Ctx.Provider value={{ onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children, ...rest }: { children: ReactNode }) => (
      <div {...rest}>{children}</div>
    ),
    SelectValue: ({ children }: { children: () => ReactNode }) => (
      <span>{typeof children === 'function' ? children() : children}</span>
    ),
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

import { FlightPicker, StayPicker } from './OptionPicker';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REQ = 'tr-1';
const LINE = 'bl-1';
const CURRENCY = { code: 'CAD', symbol: '$' };

const flightCandidate = (over: Record<string, unknown> = {}) => ({
  candidateId: 'cand-1',
  amountMinor: '85000',
  option: {
    legs: [
      { from: 'YYZ', to: 'LHR', flightNumber: 'AC 848' },
      { from: 'LHR', to: 'YYZ', flightNumber: 'AC 849' },
    ],
    airlines: ['Air Canada'],
    stops: 0,
    ...over,
  },
});

const stayCandidate = (over: Record<string, unknown> = {}) => ({
  candidateId: 'cand-2',
  amountMinor: '96000',
  option: { name: 'The Savoy', starClass: 5, rating: 8.9, ...over },
});

const outcome = (over: Record<string, unknown> = {}) => ({
  options: [flightCandidate()],
  found: 1,
  insight: null,
  reason: 'ok',
  ...over,
});

const onChosen = vi.fn();
const onError = vi.fn();

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock(over);
}

const showFlight = (props: Record<string, unknown> = {}) =>
  render(
    <FlightPicker
      requestId={REQ}
      lineId={LINE}
      currency={CURRENCY}
      tripType="ROUND_TRIP"
      onChosen={onChosen}
      onError={onError}
      {...props}
    />,
  );

const showStay = (props: Record<string, unknown> = {}) =>
  render(
    <StayPicker
      requestId={REQ}
      lineId={LINE}
      currency={CURRENCY}
      departDate="2026-09-01T00:00:00.000Z"
      returnDate="2026-09-04T00:00:00.000Z"
      onChosen={onChosen}
      onError={onError}
      {...props}
    />,
  );

const searchButton = () => screen.getByRole('button', { name: 'travel.picker.search' });
const chooseButtons = () => screen.getAllByRole('button', { name: 'travel.picker.choose' });

beforeEach(() => {
  onChosen.mockClear();
  onError.mockClear();
});
afterEach(cleanup);

// ── Searching spends ──────────────────────────────────────────────────────────

describe('searching is a deliberate act', () => {
  it('searches NOTHING on mount', () => {
    /**
     * The credit-spending property. A regression to an effect-driven search would bill the
     * org on every render of every airfare line in the drawer, and would look like an
     * improvement in a diff.
     */
    const onCall = vi.fn();
    setTrpc({ mutations: { 'travelRequests.searchFlightOptions': { onCall } } });
    showFlight();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('says the press costs money BEFORE it is pressed', () => {
    setTrpc();
    showFlight();
    expect(screen.getByText('travel.picker.costHint')).toBeInTheDocument();
  });

  it('sends the trip’s shape, the cabin, the stop limit and the deep-search flag', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchFlightOptions': { onCall, outcome: 'success' } },
    });
    showFlight();

    await user.click(screen.getByRole('button', { name: 'travel.picker.cabins.BUSINESS' }));
    await user.click(screen.getByRole('button', { name: 'travel.picker.stopsMax.0' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(searchButton());

    expect(onCall).toHaveBeenCalledWith({
      id: REQ,
      tripType: 'ROUND_TRIP',
      travelClass: 'BUSINESS',
      maxStops: 0,
      deepSearch: true,
    });
  });

  it('sends ONE_WAY when the trip is one-way, rather than a route of its own', async () => {
    // A search with its own route would price a journey the request does not describe.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchFlightOptions': { onCall, outcome: 'success' } },
    });
    showFlight({ tripType: 'ONE_WAY' });
    await user.click(searchButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ tripType: 'ONE_WAY' });
  });

  it('sends a null stop limit when none is chosen', async () => {
    // Not 0 — "any number of stops" and "nonstop only" are different searches.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchFlightOptions': { onCall, outcome: 'success' } },
    });
    showFlight();
    await user.click(searchButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ maxStops: null });
  });

  it('cannot be pressed while the row is busy', async () => {
    // The label flips too — the shell reads `disabled` through the same `searching` flag a
    // real in-flight search sets, so the button says so rather than just going grey.
    setTrpc();
    showFlight({ disabled: true });
    expect(screen.getByRole('button', { name: 'travel.picker.searching' })).toBeDisabled();
  });
});

// ── Picking sends no price ────────────────────────────────────────────────────

describe('picking', () => {
  const withResults = (over: Record<string, unknown> = {}, chooseOver = {}) => ({
    mutations: {
      'travelRequests.searchFlightOptions': { outcome: 'success' as const, data: outcome(over) },
      'travelRequests.chooseLineOption': { outcome: 'success' as const, ...chooseOver },
    },
  });

  it('sends the candidate id and NOTHING resembling a price', async () => {
    /**
     * The whole reason candidates are cached server-side. What is rendered here is
     * display-only; a tampered figure in the DOM changes nothing, because the input has no
     * amount field to carry it.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(withResults({}, { onCall }));
    showFlight();
    await user.click(searchButton());
    await user.click(chooseButtons()[0]);

    expect(onCall).toHaveBeenCalledWith({ id: REQ, lineId: LINE, candidateId: 'cand-1' });
    const sent = onCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['candidateId', 'id', 'lineId']);
  });

  it('clears the rival fares once a pick lands', async () => {
    /**
     * Leaving eleven rivals beside the chosen one invites a second press that silently
     * replaces a deliberate choice — and the server has cleared the cache by then anyway,
     * so the second press would fail rather than do nothing.
     */
    const user = userEvent.setup();
    setTrpc(withResults());
    showFlight();
    await user.click(searchButton());
    expect(chooseButtons()).toHaveLength(1);
    await user.click(chooseButtons()[0]);
    expect(screen.queryAllByRole('button', { name: 'travel.picker.choose' })).toHaveLength(0);
    expect(onChosen).toHaveBeenCalled();
  });

  it('reports a refused pick through onError rather than swallowing it', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': { outcome: 'success', data: outcome() },
        'travelRequests.chooseLineOption': {
          outcome: 'error',
          error: { message: 'that fare has expired — search again' },
        },
      },
    });
    showFlight();
    await user.click(searchButton());
    await user.click(chooseButtons()[0]);
    // react-query hands `onError` the variables alongside the error; the picker reports
    // only the message, so the assertion allows the second argument rather than pinning it.
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining('expired'),
    });
  });

  it('reports a failed search through onError too', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': {
          outcome: 'error',
          error: { message: 'no provider configured' },
        },
      },
    });
    showFlight();
    await user.click(searchButton());
    expect(onError).toHaveBeenCalled();
  });
});

// ── What a fare looks like ────────────────────────────────────────────────────

describe('a rendered fare', () => {
  const show = async (option: Record<string, unknown>) => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': {
          outcome: 'success',
          data: outcome({ options: [flightCandidate(option)] }),
        },
      },
    });
    showFlight();
    await user.click(searchButton());
    return screen.getAllByRole('listitem')[0];
  };

  it('names the route one-way, the airline, the flight numbers and the price', async () => {
    const row = await show({ legs: [{ from: 'YYZ', to: 'LHR', flightNumber: 'AC 848' }] });
    expect(row).toHaveTextContent('YYZ → LHR');
    expect(row).toHaveTextContent('Air Canada');
    // The single most useful thing on the line months later — the one field somebody can
    // check against a boarding pass.
    expect(row).toHaveTextContent('AC 848');
    expect(row).toHaveTextContent('850.00');
  });

  it('renders a ROUND trip as the whole path, including the turnaround', async () => {
    /**
     * This case used to pin `YYZ → YYZ` — the row read the first leg's origin and the last
     * leg's destination — and said so as observed behaviour awaiting a decision, because
     * changing how a fare is labelled is a product call. The decision came back: a row
     * that does not say where the trip went is useless for choosing between fares.
     */
    const row = await show({});
    expect(row).toHaveTextContent('YYZ → LHR → YYZ');
    expect(row).toHaveTextContent('AC 848 · AC 849');
  });

  it('shows a connection on a one-way fare', async () => {
    const row = await show({
      legs: [
        { from: 'YYZ', to: 'YYC', flightNumber: 'AC 101' },
        { from: 'YYC', to: 'MCO', flightNumber: 'AC 202' },
      ],
      stops: 1,
    });
    expect(row).toHaveTextContent('YYZ → YYC → MCO');
  });

  it('says nonstop rather than "0 stops"', async () => {
    expect(await show({ stops: 0 })).toHaveTextContent('travel.picker.nonstop');
  });

  it('counts the stops when there are any', async () => {
    expect(await show({ stops: 2 })).toHaveTextContent('travel.picker.stopCount:2');
  });

  it('renders a fare with no legs without crashing', async () => {
    // A provider response this component has never seen must degrade to an em dash, not
    // take the drawer down with it — and not print "? → ?" either, which reads as a route.
    const row = await show({ legs: [], airlines: [] });
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('?');
  });
});

// ── Nothing found is four answers ─────────────────────────────────────────────

describe('nothing found', () => {
  const searchWith = async (over: Record<string, unknown>) => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': {
          outcome: 'success',
          data: outcome({ options: [], found: 0, ...over }),
        },
      },
    });
    showFlight();
    await user.click(searchButton());
  };

  it.each([
    ['no-plan', 'travel.quote.no-plan'],
    ['no-airports', 'travel.quote.no-airports'],
    ['no-flights', 'travel.quote.no-flights'],
  ])('gives %s its own sentence', async (reason, key) => {
    await searchWith({ reason });
    expect(screen.getByRole('status')).toHaveTextContent(key);
  });

  it('names the provider failure when there is one', async () => {
    // "The provider failed" belongs to a different owner than "there are no flights", and
    // an empty list tells the two apart for nobody.
    await searchWith({ reason: 'provider-error', providerFailure: 'rate-limited' });
    expect(screen.getByRole('status')).toHaveTextContent('travel.quote.provider-rate-limited');
  });

  it('falls back to the generic reason when the failure is unnamed', async () => {
    await searchWith({ reason: 'provider-error' });
    expect(screen.getByRole('status')).toHaveTextContent('travel.quote.provider-error');
  });

  it('says nothing at all before a search has run', async () => {
    setTrpc();
    showFlight();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says nothing on a successful search', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': { outcome: 'success', data: outcome() },
      },
    });
    showFlight();
    await user.click(searchButton());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('a truncated list', () => {
  it('says it was truncated', async () => {
    /**
     * Presenting twelve of sixty as everything on offer is a silent cap, and a traveller
     * would reasonably conclude the cheapest of the twelve was the cheapest there is.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': {
          outcome: 'success',
          data: outcome({ options: [flightCandidate()], found: 60 }),
        },
      },
    });
    showFlight();
    await user.click(searchButton());
    expect(screen.getByText('travel.picker.truncated:1,60')).toBeInTheDocument();
  });

  it('stays quiet when everything found is shown', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': { outcome: 'success', data: outcome({ found: 1 }) },
      },
    });
    showFlight();
    await user.click(searchButton());
    expect(screen.queryByText(/truncated/)).not.toBeInTheDocument();
  });
});

// ── The stay picker ───────────────────────────────────────────────────────────

describe('the stay picker', () => {
  it('defaults the dates from the trip, in UTC', () => {
    /**
     * A stay is the nights between departure and return. Rendering those in the reader's
     * zone shifts them a day for anyone west of Greenwich — and the shifted value is what
     * would then be SEARCHED.
     */
    setTrpc();
    showStay();
    expect(screen.getByLabelText('travel.picker.checkIn')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('travel.picker.checkOut')).toHaveValue('2026-09-04');
  });

  it('falls back to the departure date when the trip has no return', () => {
    setTrpc();
    showStay({ returnDate: null });
    expect(screen.getByLabelText('travel.picker.checkOut')).toHaveValue('2026-09-01');
  });

  it('leaves the policy cap OFF by default', async () => {
    /**
     * A cap is a WARNING threshold on a quoted stay. Using it as a hard filter can hide
     * every hotel in an expensive city, which reads as "no results" rather than
     * "everything here is over policy".
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.searchStayOptions': { onCall, outcome: 'success' } } });
    showStay();
    await user.click(searchButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ applyCap: false, vacationRentals: false });
  });

  it('sends the cap once it is asked for, with the edited dates', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'travelRequests.searchStayOptions': { onCall, outcome: 'success' } } });
    showStay();
    await user.clear(screen.getByLabelText('travel.picker.checkOut'));
    await user.type(screen.getByLabelText('travel.picker.checkOut'), '2026-09-06');
    await user.click(screen.getByRole('checkbox'));
    await user.click(searchButton());
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      checkIn: '2026-09-01',
      checkOut: '2026-09-06',
      applyCap: true,
    });
  });

  it('names a stay, its stars and its rating', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchStayOptions': {
          outcome: 'success',
          data: outcome({ options: [stayCandidate()] }),
        },
      },
    });
    showStay();
    await user.click(searchButton());
    const row = screen.getAllByRole('listitem')[0];
    expect(row).toHaveTextContent('The Savoy');
    expect(within(row).getByText(/travel\.picker\.stars:5/)).toBeInTheDocument();
    expect(row).toHaveTextContent('960.00');
  });

  it('has a name for a stay the provider did not name', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchStayOptions': {
          outcome: 'success',
          data: outcome({ options: [stayCandidate({ name: undefined })] }),
        },
      },
    });
    showStay();
    await user.click(searchButton());
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('travel.picker.unnamedStay');
  });
});

describe('the results open in a modal', () => {
  /**
   * The list used to unfold inside the budget line's own block, and it pushed everything
   * below it down the drawer — with a dozen fares on screen the line stopped looking like
   * a line. It also competed for the same narrow column as the fields: a fare row wants a
   * route, an airline, a flight number and a price, and none of those fit beside a
   * category picker.
   *
   * A modal is also what the interaction is: searching spends a credit and picking
   * rewrites the amount, which has a beginning and an end.
   */
  const dialog = () => screen.queryByRole('dialog');

  it('shows nothing before a search', () => {
    setTrpc();
    showFlight();
    expect(dialog()).toBeNull();
  });

  it('opens on the results, naming what was searched', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchFlightOptions': { outcome: 'success', data: outcome() } },
    });
    showFlight();
    await user.click(searchButton());
    expect(dialog()).not.toBeNull();
    expect(screen.getByText('travel.picker.flightResults')).toBeInTheDocument();
  });

  it('opens on NOTHING FOUND too, because that is the search’s answer', async () => {
    /**
     * Pressing Search and having the page not visibly change is indistinguishable from the
     * button not working — and "no plan", "no airports", "no flights" and "the provider
     * failed" have three different owners between them.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': {
          outcome: 'success',
          data: { options: [], found: 0, insight: null, reason: 'no-plan' },
        },
      },
    });
    showFlight();
    await user.click(searchButton());
    expect(dialog()).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('travel.quote.no-plan');
  });

  it('closes once a fare is chosen, so a second press cannot replace it', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'travelRequests.searchFlightOptions': { outcome: 'success', data: outcome() },
        'travelRequests.chooseLineOption': { outcome: 'success' },
      },
    });
    showFlight();
    await user.click(searchButton());
    await user.click(chooseButtons()[0]);
    expect(dialog()).toBeNull();
  });

  it('names the stay search for what it is', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'travelRequests.searchStayOptions': { outcome: 'success', data: outcome() } },
    });
    showStay();
    await user.click(searchButton());
    expect(screen.getByText('travel.picker.stayResults')).toBeInTheDocument();
  });
});

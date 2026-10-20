import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { EMPTY_ROUTE, RouteEditor, RouteSummary, type RouteValue, rowKind } from './RouteEditor';

/**
 * The stops editor, which is only rendered when address lookup is available — the
 * line row gates it, and without the integration a mileage line collects a
 * distance and nothing else.
 *
 * What it has to get right: a route always keeps an origin and a destination, a
 * stop is inserted BETWEEN two rows rather than appended, and the measured
 * distance fills the field rather than being applied invisibly.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'mileageRoute.searchPlaces': { data: { available: true, items: [] } },
      ...over.queries,
    },
  });
}

/** Drives the editor as a controlled component, like the line row does. */
function Harness({
  initial = EMPTY_ROUTE,
  disabled,
}: {
  initial?: RouteValue;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [distance, setDistance] = useState('');
  return (
    <>
      <RouteEditor
        value={value}
        onChange={setValue}
        unit="KM"
        onDistance={setDistance}
        disabled={disabled}
      />
      <output data-testid="stops">{value.stops.length}</output>
      <output data-testid="distance">{distance}</output>
      <output data-testid="legs">{value.legs ? 'has-legs' : 'no-legs'}</output>
    </>
  );
}

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('row labelling', () => {
  it('names the ends From and To and everything else a stop', () => {
    expect(rowKind(0, 3)).toBe('from');
    expect(rowKind(1, 3)).toBe('stop');
    expect(rowKind(2, 3)).toBe('to');
  });

  it('is From and To with only two rows — no phantom stop', () => {
    expect(rowKind(0, 2)).toBe('from');
    expect(rowKind(1, 2)).toBe('to');
  });
});

describe('<RouteEditor>', () => {
  it('starts as an origin and a destination', () => {
    setTrpc();
    render(<Harness />);
    expect(screen.getByLabelText('from')).toBeInTheDocument();
    expect(screen.getByLabelText('to')).toBeInTheDocument();
    expect(screen.getByTestId('stops')).toHaveTextContent('2');
  });

  it('inserts a stop between the two ends, not after them', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(
      <Harness
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Ottawa' },
          ],
        }}
      />,
    );
    await user.click(screen.getByText('addStop'));

    expect(screen.getByTestId('stops')).toHaveTextContent('3');
    // The ends kept their values; the new row landed in the middle.
    expect(screen.getByLabelText('from')).toHaveValue('Toronto');
    expect(screen.getByLabelText('to')).toHaveValue('Ottawa');
    expect(screen.getByLabelText('stop')).toHaveValue('');
  });

  it('refuses to drop below an origin and a destination', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Harness />);
    // A route with one end isn't a route.
    for (const btn of screen.getAllByLabelText('removeStop')) expect(btn).toBeDisabled();
    await user.click(screen.getByText('addStop'));
    expect(screen.getAllByLabelText('removeStop')[0]).toBeEnabled();
  });

  /**
   * The promotion tests seed PICKED stops rather than typing into the rows.
   *
   * Typing is not the same thing as choosing a place. `PlaceInput` renders
   * `open ? query : value.description` and only commits text upward once a
   * suggestion has been picked (a placeId is what makes a stop measurable), so
   * typed-but-unpicked text lives in the row's own `query` and is displayed only
   * while that row is `open` — which a real `setTimeout(…, 150)` on blur ends.
   *
   * These tests used to type three addresses and then assert on the first row.
   * That row had blurred, so the assertion raced a 150ms wall-clock timer: it
   * passed on a fast machine and failed on a slower CI runner, where `open` had
   * already flipped and the field fell back to a description that was never
   * committed. It was also weak — the values it read were never in the editor's
   * `value.stops` at all, so `removeAt` could have mangled that array and the
   * test would still have passed.
   *
   * Seeding picked stops removes the timer from the test and puts the assertion
   * on the state the promotion logic actually operates on.
   */
  const THREE_PICKED: RouteValue = {
    stops: [
      { placeId: 'a', description: 'Toronto' },
      { placeId: 'b', description: 'Kingston' },
      { placeId: 'c', description: 'Ottawa' },
    ],
  };

  it('promotes the neighbour when an END is deleted', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Harness initial={THREE_PICKED} />);

    // Delete the From. Positions carry the meaning, so the middle stop becomes the
    // new origin and the row labels re-derive from the new length.
    await user.click(screen.getAllByLabelText('removeStop')[0]);
    expect(screen.getByLabelText('from')).toHaveValue('Kingston');
    expect(screen.getByLabelText('to')).toHaveValue('Ottawa');
    expect(screen.queryByLabelText('stop')).not.toBeInTheDocument();
    // …and back to two, so neither end can be removed any more.
    for (const btn of screen.getAllByLabelText('removeStop')) expect(btn).toBeDisabled();
  });

  it('promotes the second-to-last when the TO is deleted', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Harness initial={THREE_PICKED} />);

    const buttons = screen.getAllByLabelText('removeStop');
    await user.click(buttons[buttons.length - 1]);
    expect(screen.getByLabelText('from')).toHaveValue('Toronto');
    expect(screen.getByLabelText('to')).toHaveValue('Kingston');
    expect(screen.queryByLabelText('stop')).not.toBeInTheDocument();
  });

  it('says the LOOKUP failed rather than claiming there were no matches', async () => {
    const user = userEvent.setup();
    // An API rejection used to be swallowed into an empty list, so a broken key
    // looked like every address in North America having ceased to exist.
    setTrpc({
      queries: {
        'mileageRoute.searchPlaces': {
          data: { available: true, items: [], error: 'Google Maps 400: API key not valid' },
        },
      },
    });
    render(<Harness />);
    await user.type(screen.getByLabelText('from'), 'Toronto');
    expect(screen.getByText(/lookupFailed:.*API key not valid/)).toBeInTheDocument();
    expect(screen.queryByText('noMatches')).not.toBeInTheDocument();
  });

  it('still says "no matches" when the lookup genuinely found nothing', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Harness />);
    await user.type(screen.getByLabelText('from'), 'Zzzzzzz');
    expect(screen.getByText('noMatches')).toBeInTheDocument();
  });

  it('keeps typed text that was never matched to a place', async () => {
    /**
     * The input renders `open ? query : value.description`, so closing the dropdown
     * used to revert the field to the stored description and the typing vanished
     * with no explanation — a control that looks like a text box and behaves like a
     * picker. It cost a CI flake, and it made one test pass against the very bug it
     * was written to catch.
     *
     * The text is now committed WITHOUT a placeId, which is the honest state: it is
     * what they wrote, and the route still refuses to auto-measure until every stop
     * resolves to a real place.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setTrpc();
    render(<Harness />);

    const from = screen.getByLabelText('from');
    await user.type(from, '12 Nowhere Lane');
    await user.tab(); // blur without picking a suggestion
    // The commit is behind the 150ms click-grace timer.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect((screen.getByLabelText('from') as HTMLInputElement).value).toBe('12 Nowhere Lane');
    vi.useRealTimers();
  });

  it('does not clobber a PICKED suggestion when the field then blurs', async () => {
    // The other side of the blur commit. If it fired unconditionally it would
    // overwrite the chosen place with the stale search text and drop its placeId —
    // turning a measurable route back into an unmeasurable one, which is a worse
    // bug than the one being fixed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setTrpc({
      queries: {
        'mileageRoute.searchPlaces': {
          data: {
            available: true,
            items: [{ placeId: 'p-union', description: 'Union Station, Toronto' }],
          },
        },
      },
    });
    render(<Harness />);

    await user.type(screen.getByLabelText('from'), 'Union');
    await user.click(screen.getByText('Union Station, Toronto'));
    await user.tab();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // The picked description stands — not the 'Union' that was typed to find it.
    expect((screen.getByLabelText('from') as HTMLInputElement).value).toBe(
      'Union Station, Toronto',
    );
    vi.useRealTimers();
  });

  it('will not measure until every stop is a picked address', () => {
    const onCall = vi.fn();
    setTrpc({ mutations: { 'mileageRoute.computeRoute': { onCall, outcome: 'success' } } });
    render(<Harness />);
    // Typed text has no placeId, so there's nothing to send to the Routes API —
    // and nothing is sent, because a half-built route is a billed request for an
    // answer that can't exist.
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.getByText('pickAllStops')).toBeInTheDocument();
  });

  it('measures once every stop carries a placeId, and fills the distance', () => {
    const onCall = vi.fn();
    setTrpc({
      mutations: {
        'mileageRoute.computeRoute': {
          onCall,
          outcome: 'success',
          data: {
            legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 45_000 }],
            totalMeters: 45_000,
            distance: '45.00',
          },
        },
      },
    });
    render(
      <Harness
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Oshawa' },
          ],
        }}
      />,
    );
    // No click: a route with every stop resolved measures itself. A button you can
    // forget to press is a mileage line filed with a blank distance. Asserting the
    // INPUT only — the call also carries per-call error options.
    expect(onCall).toHaveBeenCalledOnce();
    expect(onCall.mock.calls[0][0]).toEqual({ placeIds: ['a', 'b'], unit: 'KM' });
    // The measured distance lands in the field rather than being applied
    // invisibly, so the traveller can still overwrite it.
    expect(screen.getByTestId('distance')).toHaveTextContent('45.00');
    expect(screen.getByTestId('legs')).toHaveTextContent('has-legs');
  });

  it('measures ONCE for a given stop set, not on every render', () => {
    const onCall = vi.fn();
    setTrpc({
      mutations: {
        'mileageRoute.computeRoute': {
          onCall,
          outcome: 'success',
          data: { legs: [], totalMeters: 45_000, distance: '45.00' },
        },
      },
    });
    const { rerender } = render(
      <Harness
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Oshawa' },
          ],
        }}
      />,
    );
    // Success writes legs back onto the value, which re-renders the editor. Without
    // the measured-for guard that write would trigger another measurement, and the
    // Routes API bills per request.
    rerender(
      <Harness
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Oshawa' },
          ],
        }}
      />,
    );
    expect(onCall).toHaveBeenCalledOnce();
  });

  it('does not measure while the row is locked', () => {
    const onCall = vi.fn();
    setTrpc({ mutations: { 'mileageRoute.computeRoute': { onCall, outcome: 'success' } } });
    render(
      <Harness
        disabled
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Oshawa' },
          ],
        }}
      />,
    );
    expect(onCall).not.toHaveBeenCalled();
  });

  it('drops stale legs the moment a stop changes', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(
      <Harness
        initial={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Oshawa' },
          ],
          legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 45_000 }],
        }}
      />,
    );
    expect(screen.getByTestId('legs')).toHaveTextContent('has-legs');
    await user.click(screen.getByText('addStop'));
    // Legs describe the route that was; keeping them beside changed stops would
    // snapshot something that didn't happen.
    expect(screen.getByTestId('legs')).toHaveTextContent('no-legs');
  });
});

describe('<RouteSummary>', () => {
  it('still shows a route recorded before lookup was switched off', () => {
    // Collection stops with the integration; display doesn't. The route is part
    // of a filed claim.
    render(
      <RouteSummary
        value={{
          stops: [
            { placeId: 'a', description: 'Toronto' },
            { placeId: 'b', description: 'Ottawa' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Toronto → Ottawa')).toBeInTheDocument();
  });

  it('renders nothing for a route with no named stops', () => {
    const { container } = render(<RouteSummary value={EMPTY_ROUTE} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * The add-a-stop block sits between two places, so it has to be equally far from
 * both. It was a sibling of the place row with no gap above it and the parent's
 * `space-y-2` below, which made it hug the place above and drift from the one below.
 *
 * Asserted structurally rather than by computed pixels: jsdom does not apply
 * Tailwind, so the class that produces the gap is the only honest thing to check.
 */
describe('add-a-stop spacing', () => {
  it('gives the connector the same gap above as the parent gives below', async () => {
    setTrpc();
    render(<Harness />);
    const addStop = await screen.findByRole('button', { name: /addStop/ });

    // The block wrapping the connector + button, and the row wrapper holding both it
    // and the place row above.
    const connector = addStop.closest('div')?.parentElement;
    const rowWrapper = connector?.parentElement;
    expect(rowWrapper).toBeTruthy();

    // Same spacing utility on both, which is what makes the two gaps equal.
    expect(rowWrapper?.className).toContain('space-y-2');
    expect(rowWrapper?.parentElement?.className).toContain('space-y-2');
  });
});

/**
 * "Frozen fields From/To once the route was sent, and the From is reset."
 *
 * A pick keeps focus in the field (the suggestion's mousedown is prevented) but closes the
 * dropdown, and the field renders `open ? query : value.description`. Re-opening was left
 * to `onFocus`, which cannot fire again while focus never left — so every keystroke after a
 * pick went into a `query` nothing displayed, the first one having already blanked the stop.
 */
describe('editing a stop after picking it', () => {
  const UNION = {
    'mileageRoute.searchPlaces': {
      data: {
        available: true,
        items: [{ placeId: 'p-union', description: 'Union Station, Toronto' }],
      },
    },
  };

  let last: RouteValue = EMPTY_ROUTE;
  function Spy() {
    const [value, setValue] = useState<RouteValue>(EMPTY_ROUTE);
    last = value;
    return <RouteEditor value={value} onChange={setValue} unit="KM" onDistance={() => {}} />;
  }

  it('lets you retype a stop you just picked without leaving the field', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: UNION });
    render(<Harness />);
    const from = screen.getByLabelText('from');
    await user.type(from, 'Union');
    await user.click(screen.getByText('Union Station, Toronto'));
    expect(from).toHaveFocus();
    await user.clear(from);
    await user.type(from, 'Kingston');
    expect(from).toHaveValue('Kingston');
  });

  it('keeps a pick when the blur lands before the click, as a tap does', async () => {
    // The blur's 150ms commit used to read the text that found the place and write it
    // over the place, dropping its id — so the route could never measure itself.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setTrpc({ queries: UNION });
      render(<Spy />);
      const from = screen.getByLabelText('from');
      await user.type(from, 'Union');
      fireEvent.blur(from);
      fireEvent.click(screen.getByText('Union Station, Toronto'));
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(last.stops[0]).toEqual({ placeId: 'p-union', description: 'Union Station, Toronto' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a measurement that comes back for stops that have since changed', () => {
  it('is dropped, rather than written over the current route', () => {
    /**
     * Writing it would attach legs for the old stops — or, where the row had re-synced to
     * an older server copy meanwhile, write that copy's From back to the server.
     */
    const pending: { vars?: { placeIds: string[] } } = {};
    let opts: { onSuccess?: (res: unknown, vars: unknown) => void } = {};
    h.trpc = {
      mileageRoute: {
        searchPlaces: {
          useQuery: () => ({
            data: { available: true, items: [] },
            isFetching: false,
            error: null,
          }),
        },
        computeRoute: {
          useMutation: (o: typeof opts) => {
            opts = o;
            return {
              isPending: false,
              mutate: (vars: { placeIds: string[] }) => {
                pending.vars = vars;
              },
            };
          },
        },
      },
    };
    const onChange = vi.fn();
    const onDistance = vi.fn();
    const route = (to: string): RouteValue => ({
      stops: [
        { placeId: 'a', description: 'A' },
        { placeId: to, description: to.toUpperCase() },
      ],
    });
    const { rerender } = render(
      <RouteEditor value={route('b')} onChange={onChange} unit="KM" onDistance={onDistance} />,
    );
    expect(pending.vars?.placeIds).toEqual(['a', 'b']);

    // The destination changes before the answer for A→B arrives.
    rerender(
      <RouteEditor value={route('c')} onChange={onChange} unit="KM" onDistance={onDistance} />,
    );
    act(() => {
      opts.onSuccess?.(
        { legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 }], distance: '1.00' },
        { placeIds: ['a', 'b'], unit: 'KM' },
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onDistance).not.toHaveBeenCalled();
  });
});

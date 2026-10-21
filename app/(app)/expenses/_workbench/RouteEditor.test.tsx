import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ROUTE_STOPS, MAX_STOP_DESCRIPTION } from '@/lib/mileageRouteSchema';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import { EMPTY_ROUTE, RouteSummary, type RouteValue } from './RouteEditor';
import { RouteStopRows, rowKind } from './RouteStopRows';
import { chosenRoute, type PreviousRoute, previousRouteValue } from './routeWorkspace';

/**
 * The route's stop rows (`RouteStopRows`, From / stops / To with address search), the
 * text summary, and the route builders (`routeWorkspace.ts`).
 *
 * What the rows have to get right: a route always keeps an origin and a destination, a
 * stop is inserted BETWEEN two rows rather than appended, and a stop holds a place id only
 * when a suggestion was picked. The workspace that hosts them, and its request rules, are
 * `RoutePickerModal.test.tsx`'s; a saved line's route control is `RouteLine.test.tsx`'s.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
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

/** Drives the rows as the workspace does: each row named once, the stops held above. */
let lastValue: RouteValue = EMPTY_ROUTE;
let nextId = 0;
function Harness({
  initial = EMPTY_ROUTE,
  disabled,
  locked,
}: {
  initial?: RouteValue;
  disabled?: boolean;
  locked?: boolean;
}) {
  const [rows, setRows] = useState(() =>
    initial.stops.map((stop) => ({ id: `row-${nextId++}`, stop })),
  );
  lastValue = { stops: rows.map((r) => r.stop) };
  return (
    <>
      <RouteStopRows
        rows={rows}
        onSetStop={(i, stop) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, stop } : r)))}
        onInsertAfter={(i) =>
          setRows((rs) => {
            const next = [...rs];
            next.splice(i + 1, 0, { id: `row-${nextId++}`, stop: { description: '' } });
            return next;
          })
        }
        onRemove={(i) => setRows((rs) => (rs.length <= 2 ? rs : rs.filter((_, j) => j !== i)))}
        disabled={disabled}
        locked={locked}
      />
      <output data-testid="stops">{rows.length}</output>
    </>
  );
}

afterEach(() => {
  h.trpc = undefined;
  lastValue = EMPTY_ROUTE;
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

describe('<RouteStopRows>', () => {
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

  it(`stops adding stops at ${MAX_ROUTE_STOPS} — the save path refuses more`, async () => {
    const user = userEvent.setup();
    setTrpc();
    const stops = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ placeId: `p${i}`, description: `Stop ${i}` }));

    const { unmount } = render(<Harness initial={{ stops: stops(MAX_ROUTE_STOPS - 1) }} />);
    expect(screen.queryByText(`maxStops:${MAX_ROUTE_STOPS}`)).not.toBeInTheDocument();
    await user.click(screen.getAllByText('addStop')[0]);
    expect(screen.getByTestId('stops')).toHaveTextContent(String(MAX_ROUTE_STOPS));
    for (const add of screen.getAllByRole('button', { name: /addStop/ }))
      expect(add).toBeDisabled();
    expect(screen.getByText(`maxStops:${MAX_ROUTE_STOPS}`)).toBeInTheDocument();
    unmount();
  });

  it(`caps a typed stop at ${MAX_STOP_DESCRIPTION} characters, the stored limit`, () => {
    setTrpc();
    render(<Harness />);
    expect(screen.getByLabelText('from')).toHaveAttribute(
      'maxLength',
      String(MAX_STOP_DESCRIPTION),
    );
  });

  it('caps a picked place’s description at the stored limit too', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(MAX_STOP_DESCRIPTION + 40);
    setTrpc({
      queries: {
        'mileageRoute.searchPlaces': {
          data: { available: true, items: [{ placeId: 'p-long', description: long }] },
        },
      },
    });
    render(<Harness />);
    await user.type(screen.getByLabelText('from'), 'Long');
    await user.click(screen.getByText(long));
    expect(lastValue.stops[0]).toEqual({
      placeId: 'p-long',
      description: long.slice(0, MAX_STOP_DESCRIPTION),
    });
  });
});

// ── The route builders ─────────────

const TWO_PICKED: RouteValue = {
  stops: [
    { placeId: 'a', description: 'Toronto' },
    { placeId: 'b', description: 'Ottawa' },
  ],
};

describe('previousRouteValue', () => {
  const PREVIOUS: PreviousRoute[] = [
    {
      stops: [
        { placeId: 'tor', description: 'Toronto' },
        { placeId: 'kin', description: 'Kingston' },
        { placeId: 'ott', description: 'Ottawa' },
      ],
      legs: [
        { fromPlaceId: 'tor', toPlaceId: 'kin', meters: 260_000 },
        { fromPlaceId: 'kin', toPlaceId: 'ott', meters: 190_000 },
      ],
      routeLabel: 'Hwy 401',
      routeIndex: 1,
      routeCount: 3,
      distance: { KM: '450.00', MI: '279.62' },
    },
    {
      stops: [
        { placeId: 'home', description: 'Home' },
        { placeId: 'office', description: 'Office' },
      ],
      legs: [{ fromPlaceId: 'home', toPlaceId: 'office', meters: 12_000 }],
      distance: { KM: '12.00', MI: '7.46' },
    },
  ];

  it('copies an entry field by field, so nothing else on the wire reaches the line', () => {
    const wire = {
      ...PREVIOUS[1],
      stops: [
        { placeId: 'a', description: 'A', extra: 1 },
        { placeId: 'b', description: 'B' },
      ],
      encodedPolyline: 'abc',
    } as unknown as PreviousRoute;
    expect(previousRouteValue(wire)).toEqual({
      stops: [
        { placeId: 'a', description: 'A' },
        { placeId: 'b', description: 'B' },
      ],
      legs: PREVIOUS[1]?.legs,
    });
  });
});

describe('chosenRoute', () => {
  const stops = TWO_PICKED.stops;
  const legs = [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 1000 }];

  it('records the label, the position among those offered, and how many were offered', () => {
    expect(chosenRoute(stops, { index: 2, label: 'Hwy 7', legs }, 3)).toEqual({
      stops,
      legs,
      routeLabel: 'Hwy 7',
      routeIndex: 2,
      routeCount: 3,
    });
  });

  it('omits a null or blank label — never "" and never a made-up name', () => {
    for (const label of [null, '', '   ']) {
      const out = chosenRoute(stops, { index: 0, label, legs }, 1);
      expect(out).not.toHaveProperty('routeLabel');
    }
  });

  it('copies legs field by field, so nothing else the wire carried is stored', () => {
    const out = chosenRoute(
      stops,
      { index: 0, label: 'X', legs: [{ ...legs[0], extra: 'y' } as (typeof legs)[number]] },
      1,
    );
    expect(out.legs).toEqual(legs);
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
      render(<Harness />);
      const from = screen.getByLabelText('from');
      await user.type(from, 'Union');
      fireEvent.blur(from);
      fireEvent.click(screen.getByText('Union Station, Toronto'));
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(lastValue.stops[0]).toEqual({
        placeId: 'p-union',
        description: 'Union Station, Toronto',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the suggestions open when focus leaves and comes straight back', async () => {
    // Focus out (a press on Add stop) and back into the field inside the blur's 150ms:
    // the blur's commit used to fire anyway, closing the list under the pointer about to
    // press a suggestion and committing the typed text with no place (E2E b).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setTrpc({ queries: UNION });
      render(<Harness />);
      const from = screen.getByLabelText('from');
      fireEvent.focus(from);
      fireEvent.blur(from);
      fireEvent.focus(from);
      await user.type(from, 'Union');
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(from).toHaveValue('Union');
      expect(lastValue.stops[0]).toEqual({ description: '' });
      await user.click(screen.getByText('Union Station, Toronto'));
      expect(lastValue.stops[0]).toEqual({
        placeId: 'p-union',
        description: 'Union Station, Toronto',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

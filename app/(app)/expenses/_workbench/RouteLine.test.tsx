import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteValue } from '@/lib/mileageRouteSchema';

/**
 * A saved line's route control (spec FR-3, NFR-8, NFR-10): the small map, drawn from a
 * fresh path call on every view, its five-map cap, and Change route.
 *
 * What is pinned:
 *   · the map — and its path call and key read — starts only once the line is on screen;
 *     before that the line holds an empty, hidden box the size of the map;
 *   · exactly ONE `lineRoutePath` per mounted map: not again on scroll-away and back, on a
 *     re-render, on a unit toggle, or under StrictMode; never retried; a changed route is
 *     a new mount that asks once and never shows the old path;
 *   · the spinner: the map's box is named "Loading the map…" and busy, with no live
 *     region, then named for the route once the tiles are drawn;
 *   · every failure is the text summary, with no error text and no spinner; a failed line
 *     frees its slot; a map-library failure (script, key, chunk, watchdog) stops the page
 *     from asking for any more paths;
 *   · at most five maps; a line past the cap shows the summary and the "five" sentence;
 *   · Change route opens on the stored stops.
 */

interface Pending {
  vars: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  done?: boolean;
}

const h = vi.hoisted(() => ({
  /** `lineRoutePath` calls, in the order sent, each waiting for its answer. */
  paths: [] as Pending[],
  /** The options every `lineRoutePath` mutation was created with. */
  pathOptions: [] as unknown[],
  /** How many times the browser key was asked for. */
  mapConfigReads: 0,
  /** What `mapConfig` answers. */
  config: {
    data: { browserApiKey: 'browser-key', region: null } as unknown,
    isError: false,
  },
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));

vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    mileageRoute: {
      recentRoutes: { useQuery: () => ({ data: { routes: [] } }) },
      mapConfig: {
        useQuery: () => {
          h.mapConfigReads += 1;
          return h.config;
        },
      },
      lineRoutePath: {
        useMutation: (options: unknown) => {
          h.pathOptions.push(options);
          return {
            isPending: false,
            mutateAsync: (vars: Record<string, unknown>) =>
              new Promise((resolve, reject) => h.paths.push({ vars, resolve, reject })),
          };
        },
      },
      searchPlaces: { useQuery: () => ({ data: { items: [], error: null } }) },
      computeRoutes: { useMutation: () => ({ mutateAsync: () => new Promise(() => {}) }) },
    },
    expenses: { mileagePreview: { useQuery: () => ({ data: undefined }) } },
  },
}));

/** The line map, stood in for: what RouteLine owes it is the right path and the callbacks. */
vi.mock('./RouteLineMap', () => ({
  default: (props: {
    encodedPolyline: string;
    onReady: () => void;
    onUnavailable: (cause: 'library' | 'path') => void;
  }) => (
    <div data-testid="line-map" data-path={props.encodedPolyline}>
      <button type="button" onClick={props.onReady}>
        tiles drawn
      </button>
      <button type="button" onClick={() => props.onUnavailable('library')}>
        library failed
      </button>
      <button type="button" onClick={() => props.onUnavailable('path')}>
        nothing to draw
      </button>
    </div>
  ),
}));

import {
  changeRouteSeed,
  lineMapStateForTests,
  MAX_LINE_MAPS,
  RouteLine,
  type RouteLineProps,
  resetLineMapsForTests,
} from './RouteLine';
import { MAP_WATCHDOG_MS } from './RoutePickerModal';

// ── IntersectionObserver, stood in for ────────────────────────────────────────────────

const observed = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();

class FakeObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(el: Element) {
    observed.set(el, this.callback);
  }
  disconnect() {
    for (const [el, cb] of observed) if (cb === this.callback) observed.delete(el);
  }
}

/** Scroll every watched line into view, or out of it. */
function setVisible(visible: boolean) {
  act(() => {
    for (const cb of [...observed.values()]) cb([{ isIntersecting: visible }]);
  });
}

beforeEach(() => {
  h.paths = [];
  h.pathOptions = [];
  h.mapConfigReads = 0;
  h.config = { data: { browserApiKey: 'browser-key', region: null }, isError: false };
  observed.clear();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Every unmount gave its slot back. The page-level library stop is module state, like
  // the slots: reset it, so one test's failure never silences the next test's lines.
  expect(lineMapStateForTests().slots).toBe(0);
  resetLineMapsForTests();
  expect(lineMapStateForTests()).toEqual({ slots: 0, mapLibraryFailed: false });
});

// ── Lines ─────────────────────────────────────────────────────────────────────────────

const ROUTE: RouteValue = {
  stops: [
    { placeId: 'p-tor', description: 'Toronto' },
    { placeId: 'p-ott', description: 'Ottawa' },
  ],
  legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 412_000 }],
  routeLabel: 'Hwy 401',
  routeIndex: 1,
  routeCount: 3,
};
const SUMMARY = 'Toronto → Ottawa';
const LABEL = 'route.lineMapLabel:Toronto,Ottawa,412.00 km';
const LOADING = 'route.picker.mapLoading';

function props(over: Partial<RouteLineProps> = {}): RouteLineProps {
  return {
    lineItemId: 'line-1',
    route: ROUTE,
    unit: 'KM',
    distanceText: '412.00 km',
    mapAvailable: true,
    onAccept: vi.fn(async () => {}),
    ...over,
  };
}

const pathCalls = () => h.paths.map((p) => p.vars);

/** Answer the oldest unanswered path call of `lineItemId`. */
async function answer(lineItemId: string, value: unknown, ok = true) {
  const next = h.paths.find((p) => p.vars.lineItemId === lineItemId && !p.done);
  if (!next) throw new Error(`no path call is waiting for ${lineItemId}`);
  next.done = true;
  await act(async () => (ok ? next.resolve(value) : next.reject(value)));
}

/** Several lines on one page. */
function Lines({ lineIds }: { lineIds: string[] }) {
  return (
    <div>
      {lineIds.map((id) => (
        <RouteLine key={id} {...props({ lineItemId: id })} />
      ))}
    </div>
  );
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `line-${i}`);

// ── The map ───────────────────────────────────────────────────────────────────────────

describe('the line map', () => {
  it('asks nothing until the line is on screen; holds an empty, hidden box meanwhile', () => {
    const { container } = render(<RouteLine {...props()} />);
    expect(pathCalls()).toEqual([]);
    expect(h.mapConfigReads).toBe(0);
    expect(screen.queryByRole('img')).toBeNull();
    // No summary flashing before the map: the box the map will fill, hidden from AT.
    expect(screen.queryByText(SUMMARY)).toBeNull();
    expect(container.querySelector('div[aria-hidden="true"]')).not.toBeNull();

    setVisible(true);
    expect(pathCalls()).toEqual([{ lineItemId: 'line-1' }]);
    expect(h.mapConfigReads).toBeGreaterThan(0);
  });

  it('spinner, then the path: the box is busy and named "loading", then named for the route', async () => {
    render(<RouteLine {...props()} />);
    setVisible(true);

    const box = screen.getByRole('img', { name: LOADING });
    expect(box).toHaveAttribute('aria-busy', 'true');
    // No live region on a line map: five maps loading at once would announce five times.
    expect(screen.queryByRole('status')).toBeNull();
    const icon = box.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.getAttribute('class')).toContain('motion-safe:animate-spin');

    await answer('line-1', { encodedPolyline: 'path-1' });
    expect(await screen.findByTestId('line-map')).toHaveAttribute('data-path', 'path-1');
    // Still loading until Google says the tiles are drawn.
    expect(screen.getByRole('img', { name: LOADING })).toHaveAttribute('aria-busy', 'true');

    act(() => screen.getByRole('button', { name: 'tiles drawn' }).click());
    const ready = screen.getByRole('img', { name: LABEL });
    expect(ready).not.toHaveAttribute('aria-busy');
    expect(ready.querySelector('svg')).toBeNull();
    // No text summary under the map.
    expect(screen.queryByText(SUMMARY)).toBeNull();
  });

  it('asks ONCE per mount: not again on scroll-away and back, a re-render, or a unit toggle', async () => {
    const view = render(<RouteLine {...props()} />);
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'path-1' });
    await screen.findByTestId('line-map');

    setVisible(false);
    setVisible(true);
    // A deep-equal route (a report refetch) and another distance text (KM/MI).
    view.rerender(
      <RouteLine {...props({ route: structuredClone(ROUTE), distanceText: '256.00 mi' })} />,
    );
    setVisible(true);
    expect(pathCalls()).toHaveLength(1);
    expect(screen.getAllByTestId('line-map')).toHaveLength(1);
  });

  it('asks ONCE under StrictMode', async () => {
    render(
      <StrictMode>
        <RouteLine {...props()} />
      </StrictMode>,
    );
    setVisible(true);
    await waitFor(() => expect(screen.getByRole('img', { name: LOADING })).toBeInTheDocument());
    expect(pathCalls()).toEqual([{ lineItemId: 'line-1' }]);
  });

  it('is created with no retry and no cache, and a failed call is never sent again', async () => {
    const view = render(<RouteLine {...props()} />);
    setVisible(true);
    expect(h.pathOptions.length).toBeGreaterThan(0);
    for (const options of h.pathOptions) expect(options).toEqual({ gcTime: 0, retry: 0 });

    await answer('line-1', { data: { code: 'TOO_MANY_REQUESTS' } }, false);
    view.rerender(<RouteLine {...props()} />);
    setVisible(false);
    setVisible(true);
    expect(pathCalls()).toHaveLength(1);
  });

  it('a changed route is a new mount: ONE new call, and the old path is never drawn', async () => {
    const view = render(<RouteLine {...props()} />);
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'old-path' });
    await screen.findByTestId('line-map');

    const KINGSTON: RouteValue = {
      stops: [ROUTE.stops[0], { placeId: 'p-kin', description: 'Kingston' }],
      legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-kin', meters: 260_000 }],
    };
    view.rerender(<RouteLine {...props({ route: KINGSTON })} />);
    await waitFor(() => expect(pathCalls()).toHaveLength(2));
    expect(screen.queryByTestId('line-map')).toBeNull();
    expect(screen.getByRole('img', { name: LOADING })).toBeInTheDocument();

    await answer('line-1', { encodedPolyline: 'new-path' });
    expect(await screen.findByTestId('line-map')).toHaveAttribute('data-path', 'new-path');
  });

  it('another route between the same stops is a new mount: ONE new call, never the old path', async () => {
    // Change route (or a previous route) picks a shorter alternative between the same two
    // stops: same place IDs, no via — only the route chosen and its metres differ.
    const SHORTER: RouteValue = {
      ...ROUTE,
      legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 398_000 }],
      routeLabel: 'Hwy 7',
      routeIndex: 0,
    };
    const page = (first: RouteValue, second: RouteValue) => (
      <div>
        <RouteLine {...props({ lineItemId: 'line-1', route: first })} />
        <RouteLine {...props({ lineItemId: 'line-2', route: second })} />
      </div>
    );
    const view = render(page(ROUTE, ROUTE));
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'old-path' });
    await answer('line-2', { encodedPolyline: 'other-line' });
    expect(await screen.findAllByTestId('line-map')).toHaveLength(2);
    expect(pathCalls()).toHaveLength(2);

    view.rerender(page(SHORTER, ROUTE));
    await waitFor(() => expect(pathCalls()).toHaveLength(3));
    expect(pathCalls()[2]).toEqual({ lineItemId: 'line-1' });
    // The old path is gone with its mount; line-2's map is untouched.
    expect(screen.getAllByTestId('line-map').map((m) => m.dataset.path)).toEqual(['other-line']);
    await answer('line-1', { encodedPolyline: 'new-path' });
    await waitFor(() =>
      expect(screen.getAllByTestId('line-map').map((m) => m.dataset.path)).toEqual([
        'new-path',
        'other-line',
      ]),
    );

    // Editing ANOTHER line (FR-3): line-2 takes another route, and line-1 arrives again as an
    // equal copy (the report refetch) — only line-2 asks; line-1 keeps its mount and path.
    view.rerender(page(structuredClone(SHORTER), { ...ROUTE, routeIndex: 2 }));
    await waitFor(() => expect(pathCalls()).toHaveLength(4));
    expect(pathCalls()[3]).toEqual({ lineItemId: 'line-2' });
    expect(screen.getAllByTestId('line-map').map((m) => m.dataset.path)).toEqual(['new-path']);
  });

  it('a changed pass-through point is a new mount too: ONE new call, never the old path', async () => {
    const view = render(
      <RouteLine {...props({ route: { ...ROUTE, via: [{ placeId: 'road-1', leg: 0 }] } })} />,
    );
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'old-path' });
    await screen.findByTestId('line-map');

    view.rerender(
      <RouteLine {...props({ route: { ...ROUTE, via: [{ placeId: 'road-2', leg: 0 }] } })} />,
    );
    await waitFor(() => expect(pathCalls()).toHaveLength(2));
    expect(screen.queryByTestId('line-map')).toBeNull();
    await answer('line-1', { encodedPolyline: 'new-path' });
    expect(await screen.findByTestId('line-map')).toHaveAttribute('data-path', 'new-path');

    // The same route again is the same mount: no further call.
    view.rerender(
      <RouteLine {...props({ route: { ...ROUTE, via: [{ placeId: 'road-2', leg: 0 }] } })} />,
    );
    expect(pathCalls()).toHaveLength(2);
  });

  it.each([
    ['the call is refused', { data: { code: 'TOO_MANY_REQUESTS' } }, false],
    ['the call fails on the network', new TypeError('fetch failed'), false],
    ['there is no path to draw', { encodedPolyline: null }, true],
  ])('when %s: the summary, with no error text and no spinner', async (_label, value, ok) => {
    render(<RouteLine {...props()} />);
    setVisible(true);
    await answer('line-1', value, ok);
    await waitFor(() => expect(screen.getByText(SUMMARY)).toBeInTheDocument());
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('route.lineMapCapped')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // A failure of this line's path is not a failure of the map library.
    expect(lineMapStateForTests().mapLibraryFailed).toBe(false);
  });

  it('a map with nothing to draw falls back to the summary, and the page keeps asking', async () => {
    render(<RouteLine {...props()} />);
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'path-1' });
    act(() => screen.getByRole('button', { name: 'nothing to draw' }).click());
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(lineMapStateForTests().mapLibraryFailed).toBe(false);
  });

  it('is the summary, with no call and no key read, without a browser key or a placed stop', () => {
    render(
      <div>
        <RouteLine {...props({ mapAvailable: false })} />
        <RouteLine
          {...props({
            lineItemId: 'line-2',
            route: { ...ROUTE, stops: [{ description: 'Toronto' }, ROUTE.stops[1]] },
          })}
        />
      </div>,
    );
    setVisible(true);
    expect(screen.getAllByText(SUMMARY)).toHaveLength(2);
    expect(pathCalls()).toEqual([]);
    expect(h.mapConfigReads).toBe(0);
  });

  it('has no axe violations, loading or drawn', async () => {
    const { container } = render(<RouteLine {...props()} />);
    setVisible(true);
    expect(await axe(container)).toHaveNoViolations();
    await answer('line-1', { encodedPolyline: 'path-1' });
    act(() => screen.getByRole('button', { name: 'tiles drawn' }).click());
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── The cap ───────────────────────────────────────────────────────────────────────────

describe('the layout with a route', () => {
  it('the dropdown and the map run full width, with 16 px between them (gap-2 + mb-2)', () => {
    const { container } = render(<RouteLine {...props()} />);
    const column = container.firstElementChild as HTMLElement;
    expect(column).toHaveClass('flex', 'w-full', 'flex-col', 'gap-2');
    const dropdown = column.firstElementChild as HTMLElement;
    expect(dropdown).toHaveClass('mb-2', 'w-full');
    expect(dropdown.className).not.toContain('max-w');
    const mapBox = container.querySelector('div[aria-hidden="true"]') as HTMLElement;
    expect(mapBox).toHaveClass('w-full');
    expect(mapBox.className).not.toContain('max-w');
  });
});

describe(`the cap of ${MAX_LINE_MAPS} line maps`, () => {
  it('is five — the cap sentence says "five" in words, in both catalogs', () => {
    expect(MAX_LINE_MAPS).toBe(5);
  });

  it('5 + 2 lines: five calls, and the other two show the summary and the sentence', async () => {
    const { container } = render(<Lines lineIds={ids(7)} />);
    setVisible(true);
    await waitFor(() => expect(pathCalls()).toHaveLength(5));
    expect(pathCalls()).toEqual(ids(5).map((lineItemId) => ({ lineItemId })));
    expect(screen.getAllByText(SUMMARY)).toHaveLength(2);
    const sentences = screen.getAllByText('route.lineMapCapped');
    expect(sentences).toHaveLength(2);
    // Plain text tied to its line, not a live region.
    for (const s of sentences) expect(s.closest('[role="status"],[aria-live]')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('deleting one of the five lets the sixth ask once and draw', async () => {
    const view = render(<Lines lineIds={ids(6)} />);
    setVisible(true);
    await waitFor(() => expect(pathCalls()).toHaveLength(5));
    expect(screen.getByText('route.lineMapCapped')).toBeInTheDocument();

    view.rerender(<Lines lineIds={ids(6).filter((id) => id !== 'line-2')} />);
    await waitFor(() => expect(pathCalls()).toHaveLength(6));
    expect(pathCalls()[5]).toEqual({ lineItemId: 'line-5' });
    expect(screen.queryByText('route.lineMapCapped')).toBeNull();

    await answer('line-5', { encodedPolyline: 'path-5' });
    expect(await screen.findByTestId('line-map')).toHaveAttribute('data-path', 'path-5');
  });

  it('a line whose path failed frees its slot: the sixth then asks and draws', async () => {
    render(<Lines lineIds={ids(6)} />);
    setVisible(true);
    await waitFor(() => expect(pathCalls()).toHaveLength(5));

    await answer('line-0', { data: { code: 'TOO_MANY_REQUESTS' } }, false);
    await waitFor(() => expect(pathCalls()).toHaveLength(6));
    expect(pathCalls()[5]).toEqual({ lineItemId: 'line-5' });
    await answer('line-5', { encodedPolyline: 'path-5' });
    expect(await screen.findByTestId('line-map')).toHaveAttribute('data-path', 'path-5');
    expect(screen.queryByText('route.lineMapCapped')).toBeNull();
    // The failed line stays failed for its mount: it never asks again.
    expect(pathCalls().filter((c) => c.lineItemId === 'line-0')).toHaveLength(1);
  });
});

// ── The page-level stop ───────────────────────────────────────────────────────────────

describe('a failure of the map library', () => {
  it('stops every later path call, and shows no cap sentence', async () => {
    render(<Lines lineIds={ids(7)} />);
    setVisible(true);
    await waitFor(() => expect(pathCalls()).toHaveLength(5));
    await answer('line-0', { encodedPolyline: 'path-0' });

    act(() => screen.getByRole('button', { name: 'library failed' }).click());
    expect(lineMapStateForTests().mapLibraryFailed).toBe(true);
    // The freed slot goes to nobody: no sixth call, and the waiting lines show the summary
    // alone — never "five route maps are already open".
    await act(async () => {});
    expect(pathCalls()).toHaveLength(5);
    expect(screen.queryByText('route.lineMapCapped')).toBeNull();
    expect(screen.getAllByText(SUMMARY)).toHaveLength(3);
  });

  it('no browser key is a library failure', async () => {
    h.config = { data: { browserApiKey: null, region: null }, isError: false };
    render(<Lines lineIds={ids(6)} />);
    setVisible(true);
    await waitFor(() => expect(lineMapStateForTests().mapLibraryFailed).toBe(true));
    await waitFor(() => expect(screen.getAllByText(SUMMARY)).toHaveLength(6));
    expect(screen.queryByText('route.lineMapCapped')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('the watchdog, once the path is in and the map has not drawn, is a library failure', async () => {
    vi.useFakeTimers();
    render(<RouteLine {...props()} />);
    setVisible(true);
    await answer('line-1', { encodedPolyline: 'path-1' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAP_WATCHDOG_MS);
    });
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(lineMapStateForTests().mapLibraryFailed).toBe(true);
  });

  it('the watchdog while the path call is still out fails this line alone', async () => {
    vi.useFakeTimers();
    render(<RouteLine {...props()} />);
    setVisible(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAP_WATCHDOG_MS);
    });
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(lineMapStateForTests().mapLibraryFailed).toBe(false);
  });
});

// ── Change route ──────────────────────────────────────────────────────────────────────

describe('changeRouteSeed', () => {
  const ENTRY = {
    stops: ROUTE.stops,
    legs: ROUTE.legs,
    routeLabel: 'Hwy 401',
    routeIndex: 1,
    routeCount: 3,
    distance: { KM: '412.00', MI: '256.00' },
  };

  it('reopens a route as stored: its stops, legs, label, position, count and distance', () => {
    expect(changeRouteSeed(ROUTE)).toEqual({ kind: 'previous', entry: ENTRY });
  });

  it('reopens a route with pass-through points with its via (spec FR-4)', () => {
    const via = [
      { placeId: 'road-1', leg: 0 },
      { placeId: 'address-2', leg: 0 },
    ];
    expect(changeRouteSeed({ ...ROUTE, via })).toEqual({
      kind: 'previous',
      entry: { ...ENTRY, via },
    });
  });

  it('keeps an unpicked stop as typed, and opens on the stops alone', () => {
    const typed: RouteValue = {
      ...ROUTE,
      stops: [{ description: 'Toronto' }, { placeId: 'p-ott', description: 'Ottawa' }],
    };
    expect(changeRouteSeed(typed)).toEqual({
      kind: 'stops',
      stops: [{ description: 'Toronto' }, { placeId: 'p-ott', description: 'Ottawa' }],
    });
  });

  it('opens on the stops alone when the legs do not chain through them', () => {
    const stale: RouteValue = {
      ...ROUTE,
      legs: [{ fromPlaceId: 'p-kin', toPlaceId: 'p-ott', meters: 190_000 }],
      via: [{ placeId: 'road-1', leg: 0 }],
    };
    expect(changeRouteSeed(stale)).toEqual({ kind: 'stops', stops: ROUTE.stops });
  });
});

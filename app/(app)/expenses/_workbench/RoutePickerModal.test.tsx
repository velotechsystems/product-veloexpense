import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePointer, stubDevice } from '@/test-utils/pointer';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The route workspace (FR-2, FR-3, FR-5, FR-9, NFR-12).
 *
 * What is pinned: routes are asked for ONCE per complete set of places with no button
 * press, and an answer for places that have since changed is dropped; the shortest route
 * is selected even when Google lists it second; Use this route makes ONE write carrying
 * the path and the server's stamp, however fast it is pressed; a pricing refusal and a
 * failed write keep the workspace open and say why; Cancel and Escape write nothing; focus
 * opens in From for a new route and on Use this route for a loaded one; the cards are a
 * radio group; and the panel works with no map at all.
 *
 * The translator echoes `key:values`, so a rendered string shows which message was
 * asked for and with what.
 */

interface Pending {
  vars: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** Every set of props the stand-in map was rendered with, latest last. */
  mapProps: [] as Array<Record<string, unknown>>,
  /** `computeRoutes` calls still waiting for an answer, oldest first. */
  pending: [] as Pending[],
  /** Every `computeRoutes` input, in order. */
  computed: [] as Record<string, unknown>[],
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'fr-CA',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

/**
 * The map, stood in for. The real one needs Google's script; what the workspace owes it
 * is the right props and the right reaction to its callbacks.
 */
vi.mock('./RouteMap', () => ({
  default: (props: {
    routes: { index: number }[];
    selected: number | null;
    onSelect: (i: number) => void;
    onReady: () => void;
    onUnavailable: () => void;
  }) => {
    h.mapProps.push(props as unknown as Record<string, unknown>);
    return (
      <div data-testid="route-map" data-selected={String(props.selected)}>
        {props.routes.map((r) => (
          <button key={r.index} type="button" onClick={() => props.onSelect(r.index)}>
            {`map line ${r.index}`}
          </button>
        ))}
        <button type="button" onClick={props.onReady}>
          map drawn
        </button>
        <button type="button" onClick={props.onUnavailable}>
          map failed
        </button>
      </div>
    );
  },
}));

import { MAP_WATCHDOG_MS, type PickerRoute, RoutePickerModal } from './RoutePickerModal';
import { driveTimeParts } from './RouteWorkspacePanel';
import type { PreviousRoute, WorkspaceSeed } from './routeWorkspace';

const MAP_CONFIG = { browserApiKey: 'browser-key-for-tests', region: 'CA' };
const PLACES = [
  { placeId: 'p-tor', description: 'Toronto' },
  { placeId: 'p-ott', description: 'Ottawa' },
  { placeId: 'p-kin', description: 'Kingston' },
];

/** `computeRoutes` held until the test answers it, so order and staleness are the test's. */
function withCompute(base: Record<string, unknown>): Record<string, unknown> {
  const computeRoutes = {
    useMutation: () => ({
      isPending: false,
      mutateAsync: (vars: Record<string, unknown>) => {
        h.computed.push(vars);
        return new Promise((resolve, reject) => h.pending.push({ vars, resolve, reject }));
      },
    }),
  };
  const mileageRoute = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'computeRoutes'
          ? computeRoutes
          : (base.mileageRoute as Record<string | symbol, unknown>)[k],
    },
  );
  return new Proxy(
    {},
    { get: (_t, k) => (k === 'mileageRoute' ? mileageRoute : base[k as string]) },
  );
}

let preview: unknown = { ok: true, amountMinor: '1735' };
let recent: PreviousRoute[] = [];
function setTrpc(over: TrpcMockConfig['queries'] = {}) {
  h.trpc = withCompute(
    createTrpcMock({
      queries: {
        'mileageRoute.mapConfig': { data: MAP_CONFIG },
        'mileageRoute.recentRoutes': { dataFor: () => ({ routes: recent }) },
        'mileageRoute.searchPlaces': {
          dataFor: (input: unknown) => {
            const q = String((input as { query: string }).query).toLowerCase();
            return {
              available: true,
              items: PLACES.filter((p) => p.description.toLowerCase().includes(q)),
              error: null,
            };
          },
        },
        'expenses.mileagePreview': { dataFor: () => preview },
        ...over,
      },
    }),
  );
}

beforeEach(() => {
  h.mapProps = [];
  h.pending = [];
  h.computed = [];
  preview = { ok: true, amountMinor: '1735' };
  recent = [];
  setTrpc();
});
afterEach(() => {
  vi.useRealTimers();
});

const route = (index: number, km: number, over: Partial<PickerRoute> = {}): PickerRoute => ({
  index,
  label: `Hwy ${index + 401}`,
  totalMeters: km * 1000,
  distance: `${km}.00`,
  durationSeconds: 3600 + index * 600,
  legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: km * 1000 }],
  encodedPolyline: `enc${index}`,
  ...over,
});

const STOPS = [
  { placeId: 'p-tor', description: 'Toronto' },
  { placeId: 'p-ott', description: 'Ottawa' },
];

const PRICING = {
  expenseId: 'exp-1',
  categoryId: 'cat-mileage',
  currency: { code: 'CAD', symbol: '$' },
};

function show(
  seed: WorkspaceSeed = { kind: 'stops', stops: STOPS },
  {
    mapAvailable = false,
    onAccept = vi.fn(async (_p: unknown) => {}),
    pricing = PRICING as typeof PRICING | undefined,
  }: {
    mapAvailable?: boolean;
    onAccept?: ReturnType<typeof vi.fn<(p: unknown) => Promise<void>>>;
    pricing?: typeof PRICING;
  } = {},
) {
  const onClose = vi.fn();
  const view = render(
    <RoutePickerModal
      seed={seed}
      unit="KM"
      mapAvailable={mapAvailable}
      pricing={pricing}
      onAccept={onAccept}
      onClose={onClose}
    />,
  );
  return { onAccept, onClose, view };
}

/** Answer the oldest pending request. */
async function answer(routes: PickerRoute[]) {
  const next = h.pending.shift();
  if (!next) throw new Error('no computeRoutes is waiting');
  await act(async () => next.resolve({ routes }));
}

async function refuse(error: { message: string; data?: unknown }) {
  const next = h.pending.shift();
  if (!next) throw new Error('no computeRoutes is waiting');
  await act(async () => next.reject(error));
}

/** Type into a stop and pick the suggestion, the only way a stop gets a place id. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  typed: string,
  name: string,
) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, typed);
  await user.click(await screen.findByRole('button', { name }));
}

const theUseButton = () => screen.getByRole('button', { name: 'route.picker.useRoute' });
const radios = () => screen.queryAllByRole('radio');
const isBlocked = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';

describe('<RoutePickerModal> — the workspace', () => {
  it('is a dialog labelled by its title, opening a new route in From and asking nothing', async () => {
    show({ kind: 'new' });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('route.picker.title');
    await waitFor(() => expect(screen.getByLabelText('from')).toHaveFocus());
    expect(h.computed).toEqual([]);
    expect(screen.getByText('picker.fillStops')).toBeInTheDocument();
    expect(isBlocked(theUseButton())).toBe(true);
    // No Calculate anywhere (FR-3 post-condition).
    expect(screen.queryByRole('button', { name: /calculate/i })).toBeNull();
  });

  it('routes once the last place is picked — ONE request, no button press', async () => {
    const user = userEvent.setup();
    show({ kind: 'new' });
    await pick(user, 'from', 'Toro', 'Toronto');
    expect(h.computed).toEqual([]);
    await pick(user, 'to', 'Otta', 'Ottawa');
    expect(h.computed).toEqual([{ placeIds: ['p-tor', 'p-ott'], unit: 'KM' }]);
    expect(screen.getByText('calculating')).toHaveAttribute('role', 'status');
    await answer([route(0, 400), route(1, 450)]);
    expect(radios()).toHaveLength(2);
    expect(h.computed).toHaveLength(1);
  });

  it('selects the shortest route, even when Google lists a longer one first', async () => {
    show();
    await answer([route(0, 450), route(1, 398), route(2, 415)]);
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios()[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('drops an answer for places that changed while it was in flight, and asks again once', async () => {
    const user = userEvent.setup();
    show();
    expect(h.computed).toHaveLength(1);
    await pick(user, 'to', 'King', 'Kingston');
    expect(h.computed).toHaveLength(2);
    expect(h.computed[1]).toEqual({ placeIds: ['p-tor', 'p-kin'], unit: 'KM' });

    // The first answer lands late: it describes Toronto → Ottawa, which nobody claims now.
    await answer([route(0, 400)]);
    expect(radios()).toHaveLength(0);
    await answer([route(0, 260), route(1, 270)]);
    expect(radios()).toHaveLength(2);
    expect(h.computed).toHaveLength(2);
  });

  it('clears the routes and sends nothing while a row loses its place', async () => {
    const user = userEvent.setup();
    show();
    await answer([route(0, 400)]);
    expect(radios()).toHaveLength(1);
    await user.type(screen.getByLabelText('to'), 'x');
    expect(radios()).toHaveLength(0);
    expect(isBlocked(theUseButton())).toBe(true);
    expect(h.computed).toHaveLength(1);
  });

  it('is a radio group named by the title, each card named by label, distance and time', async () => {
    show();
    await answer([route(0, 400), route(1, 450, { label: null, durationSeconds: null })]);
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName('route.picker.title');
    expect(radios()[0]).toHaveAccessibleName(
      'route.picker.via:Hwy 401 line.distanceValue:400.00,line.km route.picker.driveTime:1,0',
    );
    expect(radios()[1]).toHaveAccessibleName(
      'route.picker.routeN:2 line.distanceValue:450.00,line.km',
    );
    // The card is the radio's label too: its text reads as the name does, word for word,
    // not run together ("…401line.distanceValue…"), so the two can be checked to agree.
    expect(radios()[0]?.closest('label')?.textContent).toBe(
      'route.picker.via:Hwy 401 line.distanceValue:400.00,line.km route.picker.driveTime:1,0',
    );
  });

  it('moves the selection from the keyboard', async () => {
    const user = userEvent.setup();
    show();
    await answer([route(0, 400), route(1, 450)]);
    // The dialog's own initial focus first (Use this route, for stops that arrive picked):
    // run alone, it would otherwise land after the radio is focused and take the key.
    await waitFor(() => expect(theUseButton()).toHaveFocus());
    act(() => radios()[0]?.focus());
    await user.keyboard('{ArrowDown}');
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('says so, and offers nothing to accept, when Google found no route', async () => {
    show();
    await answer([]);
    expect(screen.getByRole('alert')).toHaveTextContent('noRoute');
    expect(isBlocked(theUseButton())).toBe(true);
  });

  it('turns the hourly limit into its own polite message, and Try again asks once more', async () => {
    const user = userEvent.setup();
    show();
    await refuse({ message: 'TOO_MANY_REQUESTS', data: { code: 'TOO_MANY_REQUESTS' } });
    expect(screen.getByText('throttled')).toHaveAttribute('role', 'status');
    expect(radios()).toHaveLength(0);
    expect(h.computed).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(h.computed).toHaveLength(2);
  });

  it("shows a lookup failure in the server's own words", async () => {
    show();
    await refuse({ message: 'Route lookup failed: nope', data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Route lookup failed: nope');
  });
});

describe('<RoutePickerModal> — the footer and Use this route', () => {
  it('states the distance with its unit spelled out, and its price', async () => {
    show();
    await answer([route(0, 400)]);
    expect(
      screen.getByText(/^route\.picker\.footerPrice:route\.picker\.footerDistance:400\.00,KM,/),
    ).toBeInTheDocument();
    expect(isBlocked(theUseButton())).toBe(false);
  });

  it("fills Use this route with the brand's dark orange: white text on it clears 4.5:1", async () => {
    // jsdom computes no colour, so the class is what can be pinned here; the contrast
    // itself is the axe scan of the open dialog in `e2e/mileage-route-picker.spec.ts` (h).
    show();
    await answer([route(0, 400)]);
    expect(theUseButton()).toHaveClass('bg-brand-orange-dark', 'hover:bg-brand-orange-dark/95');
    expect(theUseButton()).not.toHaveClass('bg-primary');
  });

  it('makes ONE write, with the route and no path or stamp, for a double click', async () => {
    let finish: () => void = () => {};
    const onAccept = vi.fn((_p: unknown) => new Promise<void>((r) => (finish = r)));
    show(undefined, { onAccept });
    await answer([route(0, 450), route(1, 398)]);
    // The same element, twice, before React re-renders: the button's label changes once
    // the first press lands, so it is held rather than found again.
    const use = theUseButton();
    fireEvent.click(use);
    fireEvent.click(use);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith({
      mileageDistance: '398.00',
      mileageUnit: 'KM',
      mileageRoute: {
        stops: STOPS,
        legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 398_000 }],
        routeLabel: 'Hwy 402',
        routeIndex: 1,
        routeCount: 2,
      },
    });
    await act(async () => finish());
  });

  it('writes nothing Google drew: no path, no stamp, no points, whether or not a path came', async () => {
    const { onAccept } = show();
    await answer([route(0, 400, { encodedPolyline: null })]);
    fireEvent.click(theUseButton());
    const sent = onAccept.mock.calls[0]?.[0] as { mileageRoute: Record<string, unknown> };
    expect(sent.mileageRoute).not.toHaveProperty('encodedPolyline');
    // Only the claim's own keys: no time stamp, nor anything else the answer did not name.
    expect(Object.keys(sent.mileageRoute).sort()).toEqual([
      'legs',
      'routeCount',
      'routeIndex',
      'routeLabel',
      'stops',
    ]);
    expect(sent.mileageRoute).not.toHaveProperty('passThrough');
    expect(sent.mileageRoute).not.toHaveProperty('via');
  });

  it('shows a pricing refusal in the footer and will not accept', async () => {
    preview = { ok: false, reason: 'No mileage rate in force for CA on this date.' };
    setTrpc();
    const { onAccept } = show();
    await answer([route(0, 400)]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No mileage rate in force for CA on this date.',
    );
    expect(isBlocked(theUseButton())).toBe(true);
    fireEvent.click(theUseButton());
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('waits for the price before it accepts, and stays focusable meanwhile', async () => {
    preview = undefined;
    setTrpc();
    const { onAccept } = show();
    await answer([route(0, 400)]);
    expect(isBlocked(theUseButton())).toBe(true);
    expect(theUseButton()).not.toBeDisabled();
    fireEvent.click(theUseButton());
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('keeps the workspace open with the reason when the write fails, and can be retried', async () => {
    const onAccept = vi.fn(async (_p: unknown) => {
      throw { message: 'No country on the traveller.' };
    });
    show(undefined, { onAccept });
    await answer([route(0, 400)]);
    await act(async () => fireEvent.click(theUseButton()));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No country on the traveller. route.picker.useFailed',
    );
    expect(isBlocked(theUseButton())).toBe(false);
    await act(async () => fireEvent.click(theUseButton()));
    expect(onAccept).toHaveBeenCalledTimes(2);
  });

  it('accepts without a price when there is nothing to price against', async () => {
    const { onAccept } = show(undefined, { pricing: undefined });
    await answer([route(0, 400)]);
    fireEvent.click(theUseButton());
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'Cancel',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
      },
    ],
    [
      'Escape',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.keyboard('{Escape}');
      },
    ],
  ])('%s closes it and writes nothing', async (_, dismiss) => {
    const user = userEvent.setup();
    const { onAccept, onClose } = show();
    await answer([route(0, 400)]);
    await dismiss(user);
    expect(onClose).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('ignores Cancel, the close button and Escape while the write is in flight', async () => {
    const user = userEvent.setup();
    let land: () => void = () => {};
    const onAccept = vi.fn(
      (_p: unknown) =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const { onClose } = show(undefined, { onAccept });
    await answer([route(0, 400)]);
    await waitFor(() => expect(theUseButton()).toHaveFocus());
    await act(async () => fireEvent.click(theUseButton()));
    expect(onAccept).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Once it has landed, Cancel works again.
    await act(async () => land());
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('<RoutePickerModal> — a previous route', () => {
  const ENTRY: PreviousRoute = {
    stops: STOPS,
    legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 412_340 }],
    routeLabel: 'Hwy 7',
    routeIndex: 1,
    routeCount: 3,
    distance: { KM: '412.34', MI: '256.22' },
  };

  it('is routed by its stops, with one request, and opens on Use this route', async () => {
    show({ kind: 'previous', entry: ENTRY });
    await waitFor(() => expect(theUseButton()).toHaveFocus());
    expect(h.computed).toEqual([{ placeIds: ['p-tor', 'p-ott'], unit: 'KM' }]);
    expect(screen.queryByText('picker.storedOnly')).toBeNull();
  });

  it('picked in the panel, replaces the workspace, from a named "Previous routes" group', async () => {
    recent = [ENTRY];
    setTrpc();
    const user = userEvent.setup();
    show({ kind: 'new' });
    await user.click(screen.getByRole('combobox', { name: 'route.previousRoutes' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('group', { name: 'previousRoutes' })).toBeInTheDocument();
    await user.click(
      within(listbox).getByRole('option', { name: /previousRouteEnds:Toronto,Ottawa/ }),
    );
    expect(h.computed).toEqual([{ placeIds: ['p-tor', 'p-ott'], unit: 'KM' }]);
    await answer([route(0, 412)]);
    expect(radios()).toHaveLength(1);
    expect(screen.getByLabelText('from')).toHaveValue('Toronto');
    expect(h.computed).toHaveLength(1);
  });

  it('offers previous routes only: no New route in the workspace dropdown (FR-6 step 2)', async () => {
    recent = [ENTRY];
    setTrpc();
    const user = userEvent.setup();
    show({ kind: 'new' });
    await user.click(screen.getByRole('combobox', { name: 'route.previousRoutes' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: 'newRoute' })).toBeNull();
    expect(within(listbox).queryByRole('option', { name: 'changeRoute' })).toBeNull();
    const group = within(listbox).getByRole('group', { name: 'previousRoutes' });
    // Every option is a previous route.
    expect(within(listbox).getAllByRole('option')).toEqual(within(group).getAllByRole('option'));
  });

  it('with no previous routes renders neither the dropdown nor its label (FR-6 step 3)', async () => {
    show({ kind: 'new' });
    expect(screen.queryByRole('combobox', { name: 'route.previousRoutes' })).toBeNull();
    expect(screen.queryByText('route.previousRoutes')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    // The stops move up; From is still the first field.
    await waitFor(() => expect(screen.getByLabelText('from')).toHaveFocus());
  });

  it('keeps 20 px above From: the block takes mb-2 on the 12 px gap, and goes with it', () => {
    recent = [ENTRY];
    setTrpc();
    show({ kind: 'new' });
    const block = screen.getByText('route.previousRoutes').parentElement;
    expect(block).toHaveClass('mb-2');
    // On the panel's scroller, whose `gap-3` it adds to: 12 + 8 = 20 px.
    expect(block?.closest('.overflow-y-auto')).toHaveClass('gap-3');
  });

  it('has no axe violations with the previous-routes dropdown', async () => {
    recent = [ENTRY];
    setTrpc();
    show({ kind: 'new' });
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('<RoutePickerModal> without a map (FR-9)', () => {
  it('loads nothing about the map, says so, and the panel does the whole job', async () => {
    const { onAccept } = show();
    expect(screen.getByText('route.picker.mapUnavailable')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'route.picker.mapLabel' })).toBeNull();
    expect(h.mapProps).toEqual([]);
    await answer([route(0, 400), route(1, 450)]);
    fireEvent.click(screen.getByText('route.picker.via:Hwy 402'));
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(theUseButton());
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    show();
    await answer([route(0, 400), route(1, 450)]);
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('<RoutePickerModal> with a map', () => {
  async function showWithMap(seed?: WorkspaceSeed) {
    const out = show(seed, { mapAvailable: true });
    await screen.findByTestId('route-map');
    return out;
  }
  const lastMapProps = () => h.mapProps[h.mapProps.length - 1] ?? {};

  it('is the 70vw × 80vh workspace, capped at 1200 px, with the 380 px panel', async () => {
    await showWithMap();
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('md:w-[70vw]');
    expect(cls).toContain('md:max-w-[1200px]');
    expect(cls).toContain('md:h-[80vh]');
    expect(cls).toContain('md:grid-cols-[380px_minmax(0,1fr)]');
  });

  it('puts the panel first, in the DOM as on screen, with its border on the right (FR-6)', async () => {
    await showWithMap();
    const map = screen.getByRole('region', { name: 'route.picker.mapLabel' });
    const panel = screen.getByRole('region', { name: 'route.picker.panelLabel' });
    expect(panel.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const panelColumn = panel.parentElement;
    expect(panelColumn).toHaveClass('md:border-r');
    expect(panelColumn).not.toHaveClass('md:border-l');
    // The map column clears the dialog's close button: it sits above the map, not on it.
    expect(map.parentElement).toHaveClass('md:p-4', 'md:pt-12');
  });

  it('Tab reaches the stops, the routes and the footer before anything in the map', async () => {
    const user = userEvent.setup();
    await showWithMap();
    await answer([route(0, 400), route(1, 450)]);
    const map = screen.getByRole('region', { name: 'route.picker.mapLabel' });
    const dialog = screen.getByRole('dialog');
    // Start at the dialog's first stop and walk the tab order once round.
    screen.getByLabelText('from').focus();
    const order: Element[] = [];
    for (let i = 0; i < 40; i++) {
      const at = document.activeElement;
      if (!at || !dialog.contains(at) || order.includes(at)) break;
      order.push(at);
      await user.tab();
    }
    const firstInMap = order.findIndex((el) => map.contains(el));
    expect(firstInMap).toBeGreaterThan(0);
    const before = order.slice(0, firstInMap);
    expect(before).toContain(screen.getByLabelText('to'));
    expect(before).toContain(radios().find((r) => r.getAttribute('aria-checked') === 'true'));
    expect(before).toContain(theUseButton());
    expect(before.some((el) => map.contains(el))).toBe(false);
  });

  it('spins in the map until its tiles are drawn: the one loading status (FR-6 step 5)', async () => {
    const user = userEvent.setup();
    await showWithMap({ kind: 'new' });
    const map = screen.getByRole('region', { name: 'route.picker.mapLabel' });
    const status = within(map).getByRole('status');
    expect(within(map).getAllByRole('status')).toHaveLength(1);
    expect(status).toHaveTextContent('route.picker.mapLoading');
    expect(status.querySelector('svg')).toHaveClass('motion-safe:animate-spin');
    // The dialog's one live region with anything to say: the loading text is not said
    // twice. The panel's map-pick announcer is empty until a pick on the map, and the
    // footer's figure is an `output` (implicitly a status), which reads "—" here.
    const speaking = within(screen.getByRole('dialog'))
      .getAllByRole('status')
      .filter((el) => el.tagName !== 'OUTPUT' && el.textContent);
    expect(speaking).toEqual([status]);
    expect(screen.getAllByText('route.picker.mapLoading')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'map drawn' }));
    expect(screen.queryByText('route.picker.mapLoading')).toBeNull();
    expect(within(map).queryByRole('status')).toBeNull();
  });

  it('never leaves the spinner turning when the map fails', async () => {
    const user = userEvent.setup();
    await showWithMap({ kind: 'new' });
    expect(screen.getByText('route.picker.mapLoading')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'map failed' }));
    expect(screen.queryByText('route.picker.mapLoading')).toBeNull();
    expect(screen.getByText('route.picker.mapUnavailable')).toBeInTheDocument();
  });

  it('on desktop keeps the map as its own column and the list in the panel, with no handle', async () => {
    await showWithMap();
    await answer([route(0, 400), route(1, 450)]);
    const map = screen.getByRole('region', { name: 'route.picker.mapLabel' });
    const panel = screen.getByRole('region', { name: 'route.picker.panelLabel' });
    expect(panel.contains(map)).toBe(false);
    expect(screen.queryByTestId('route-sheet-toggle')).toBeNull();
    expect(screen.queryByTestId('route-sheet')).toBeNull();
    expect(radios()).toHaveLength(2);
  });

  it('opens a new route on an empty map without calling it a failure', async () => {
    await showWithMap({ kind: 'new' });
    expect(lastMapProps().routes).toEqual([]);
    expect(screen.queryByText('route.picker.mapUnavailable')).toBeNull();
  });

  it('a tap on a line selects its card, and announces it', async () => {
    const user = userEvent.setup();
    await showWithMap();
    await answer([route(0, 400), route(1, 450)]);
    await user.click(screen.getByRole('button', { name: 'map line 1' }));
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    expect(lastMapProps().selected).toBe(1);
    expect(screen.getByText('route.picker.mapSelected:route.picker.via:Hwy 402')).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('falls back to "Map unavailable" when the map cannot draw, and the panel keeps working', async () => {
    const user = userEvent.setup();
    const { onAccept } = await showWithMap();
    await answer([route(0, 400)]);
    await user.click(screen.getByRole('button', { name: 'map failed' }));
    expect(screen.queryByTestId('route-map')).toBeNull();
    expect(screen.getByText('route.picker.mapUnavailable')).toBeInTheDocument();
    fireEvent.click(theUseButton());
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('gives up on a map that has not drawn within the watchdog, and not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await showWithMap();
    act(() => vi.advanceTimersByTime(MAP_WATCHDOG_MS - 100));
    expect(screen.getByTestId('route-map')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId('route-map')).toBeNull();
    // Today's fallback, never a spinner left turning.
    expect(screen.queryByText('route.picker.mapLoading')).toBeNull();
    expect(screen.getByText('route.picker.mapUnavailable')).toBeInTheDocument();
  });

  it.each([
    ['no browser key comes back', { data: { browserApiKey: null, region: null } }],
    ['the key read is refused', { data: undefined, isError: true, error: { message: 'no' } }],
  ])('falls back when %s, without loading the map', (_, stub) => {
    setTrpc({ 'mileageRoute.mapConfig': stub });
    show(undefined, { mapAvailable: true });
    expect(screen.getByText('route.picker.mapUnavailable')).toBeInTheDocument();
    expect(h.mapProps).toEqual([]);
  });

  it('has no axe violations', async () => {
    await showWithMap();
    await answer([route(0, 400), route(1, 450)]);
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('<RoutePickerModal> on a phone (FR-2 1.A, NFR-12)', () => {
  beforeEach(() => stubDevice('phone'));
  afterEach(restorePointer);

  async function showOnPhone(seed?: WorkspaceSeed) {
    const out = show(seed, { mapAvailable: true });
    await screen.findByTestId('route-map');
    return out;
  }
  const map = () => screen.getByRole('region', { name: 'route.picker.mapLabel' });
  const handle = () => screen.getByTestId('route-sheet-toggle');
  const listOf = (button: HTMLElement) => {
    const id = button.getAttribute('aria-controls');
    const list = id ? document.getElementById(id) : null;
    if (!list) throw new Error(`the handle controls #${id}, which is not in the document`);
    return list;
  };
  const OVERLAY = /(^|\s)(max-md:|md:)?(absolute|fixed|sticky)(\s|$)/;

  it('puts the inputs above the map and docks the route list after it, in flow', async () => {
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    const theMap = map();
    const sheet = screen.getByTestId('route-sheet');
    const list = listOf(handle());
    const following = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    // Inputs on top, then the map.
    expect(following(screen.getByLabelText('from'), theMap)).toBe(true);
    expect(following(screen.getByLabelText('to'), theMap)).toBe(true);
    // The docked list: a sibling AFTER the map, holding the cards — never inside the map.
    expect(sheet.parentElement).toBe(theMap.parentElement);
    expect(following(theMap, sheet)).toBe(true);
    expect(theMap.contains(sheet)).toBe(false);
    expect(sheet).toContainElement(handle());
    expect(list).toContainElement(screen.getByRole('radiogroup'));
    // In normal flow: nothing in the sheet's chain is positioned over the map.
    for (const el of [sheet, handle(), list]) {
      expect(el.className, `${el.tagName} is positioned out of flow`).not.toMatch(OVERLAY);
      expect(el.style.position).toBe('');
    }
    // And the footer comes after the list, so Use this route is never under it.
    expect(following(sheet, theUseButton())).toBe(true);
  });

  it('the handle shows the selected route, and opens and closes the list it controls', async () => {
    const user = userEvent.setup();
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    const button = handle();
    // Named by its visible text (WCAG 2.5.3): the selected route, its distance, the count.
    expect(button).toHaveAccessibleName(
      'route.picker.via:Hwy 401 route.picker.sheetDetail:line.distanceValue:400.00,line.km,2',
    );
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    // Several routes: the list opened by itself, once.
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(listOf(button)).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(listOf(button)).not.toBeVisible();
    expect(listOf(button)).toHaveAttribute('hidden');
    // The map and Use this route stay; only the list folds away.
    expect(map()).toBeVisible();
    expect(theUseButton()).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(listOf(button)).toBeVisible();
  });

  it('is operated from the keyboard: Enter and Space toggle it, and it keeps focus', async () => {
    const user = userEvent.setup();
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    const button = handle();
    // After the dialog's own initial focus (Use this route, for stops that arrive picked).
    await waitFor(() => expect(theUseButton()).toHaveFocus());
    act(() => button.focus());
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveFocus();
    // From the handle, Tab goes into the list it opened: the selected card's radio.
    await user.tab();
    expect(radios()[0]).toHaveFocus();
  });

  it('opens by itself only once: never again after the filer closed it', async () => {
    const user = userEvent.setup();
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    await user.click(handle());
    expect(handle()).toHaveAttribute('aria-expanded', 'false');

    await pick(user, 'to', 'King', 'Kingston');
    await answer([route(0, 260), route(1, 270), route(2, 280)]);
    expect(handle()).toHaveAttribute('aria-expanded', 'false');
    expect(handle()).toHaveAccessibleName(/sheetDetail:line\.distanceValue:260\.00,line\.km,3$/);
  });

  it('a new route opens in From, with no handle until a route arrives', async () => {
    await showOnPhone({ kind: 'new' });
    await waitFor(() => expect(screen.getByLabelText('from')).toHaveFocus());
    expect(screen.queryByTestId('route-sheet-toggle')).toBeNull();
    expect(screen.getByText('picker.fillStops')).toBeVisible();
  });

  it('a loaded route opens on Use this route, its one card behind a closed handle', async () => {
    await showOnPhone({
      kind: 'previous',
      entry: {
        stops: STOPS,
        legs: [{ fromPlaceId: 'p-tor', toPlaceId: 'p-ott', meters: 412_340 }],
        routeLabel: 'Hwy 7',
        routeIndex: 1,
        routeCount: 3,
        distance: { KM: '412.34', MI: '256.22' },
      },
    });
    await answer([route(0, 412)]);
    await waitFor(() => expect(theUseButton()).toHaveFocus());
    expect(handle()).toHaveAttribute('aria-expanded', 'false');
    // The stored route's own distance (spec FR-4), not the fresh answer's.
    expect(handle()).toHaveAccessibleName(/sheetDetail:line\.distanceValue:412\.34,line\.km,1$/);
  });

  it('gives focus back to the control the caller names when it closes', async () => {
    const user = userEvent.setup();
    function Opener() {
      const [open, setOpen] = useState(true);
      const dropdown = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={dropdown} type="button">
            {"the line's dropdown"}
          </button>
          {open && (
            <RoutePickerModal
              seed={{ kind: 'stops', stops: STOPS }}
              unit="KM"
              mapAvailable
              onAccept={async () => {}}
              onClose={() => setOpen(false)}
              finalFocus={dropdown}
            />
          )}
        </>
      );
    }
    render(<Opener />);
    await screen.findByTestId('route-map');
    await answer([route(0, 400)]);
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: "the line's dropdown" })).toHaveFocus(),
    );
  });

  it('without a map keeps the cards in flow, with no handle', async () => {
    show();
    await answer([route(0, 400), route(1, 450)]);
    expect(screen.queryByTestId('route-sheet-toggle')).toBeNull();
    expect(screen.queryByTestId('route-sheet')).toBeNull();
    expect(radios()[0]).toBeVisible();
  });

  it('falls back to the cards in flow when the map fails, keeping the stops', async () => {
    const user = userEvent.setup();
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    await user.click(handle());
    await user.click(screen.getByRole('button', { name: 'map failed' }));
    expect(screen.queryByTestId('route-sheet-toggle')).toBeNull();
    expect(radios()[0]).toBeVisible();
    expect(screen.getByLabelText('to')).toHaveValue('Ottawa');
  });

  it('gives the map no browser touch gesture, selection or callout on the sheet', async () => {
    await showOnPhone();
    expect(map().className).toContain('max-md:touch-none');
    expect(map().className).toContain('max-md:select-none');
    expect(map().className).toContain('max-md:[-webkit-touch-callout:none]');
  });

  it('has no axe violations, with the list open and closed', async () => {
    const user = userEvent.setup();
    await showOnPhone();
    await answer([route(0, 400), route(1, 450)]);
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
    await user.click(handle());
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations();
  });
});

describe('driveTimeParts', () => {
  it('splits whole minutes into hours and minutes', () => {
    expect(driveTimeParts(222 * 60)).toEqual({ hours: 3, minutes: 42 });
    expect(driveTimeParts(60 * 60)).toEqual({ hours: 1, minutes: 0 });
  });

  it('rounds to the nearest minute and never says "0 min"', () => {
    expect(driveTimeParts(89)).toEqual({ hours: 0, minutes: 1 });
    expect(driveTimeParts(0)).toEqual({ hours: 0, minutes: 1 });
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mileage inputs, and the drift that made them look absent.
 *
 * The add-a-line form and the edit-a-line row each had their own copy of these
 * fields, and only the edit row ever got the unit toggle and the route picker. So
 * adding a mileage line offered a bare distance box, no way to say miles, and no
 * `mileageUnit` on the wire — which the server reads as "use the rule's unit", so
 * a distance meant as miles was priced as kilometres.
 *
 * These tests hold the shared component to what both callers need.
 */

const h = vi.hoisted(() => ({
  available: true,
  loading: false,
  /** What the pricing query answers, and what it was asked. */
  preview: undefined as
    | undefined
    | { ok: true; amountMinor: string }
    | { ok: false; reason: string | null },
  previewCalls: [] as { input: Record<string, unknown>; enabled: boolean }[],
  /** What the workspace's route lookup brings back. */
  routes: [] as unknown[],
  /** Every route lookup the workspace sent. */
  computed: [] as unknown[],
  /** The person's previous routes. */
  recent: [] as unknown[],
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/trpc/client', () => ({
  trpc: {
    expenses: {
      mileagePreview: {
        useQuery: (input: Record<string, unknown>, opts: { enabled?: boolean }) => {
          h.previewCalls.push({ input, enabled: opts?.enabled !== false });
          // react-query hands back nothing while disabled; mirroring that is what
          // makes "did it even ask?" a meaningful assertion.
          return { data: opts?.enabled === false ? undefined : h.preview, isFetching: false };
        },
      },
    },
    mileageRoute: {
      status: { useQuery: () => ({ data: { available: h.available }, isLoading: h.loading }) },
      // The route editor renders inline once lookup works, so its own queries have
      // to answer too. No previous routes here: the dropdown offers "New route" alone.
      recentRoutes: {
        useQuery: () => ({ data: { routes: h.recent }, isLoading: false }),
      },
      searchPlaces: {
        useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
      },
      mapConfig: { useQuery: () => ({ data: undefined, isError: false }) },
      computeRoutes: {
        useMutation: () => ({
          mutateAsync: async (vars: unknown) => {
            h.computed.push(vars);
            return { routes: h.routes };
          },
          isPending: false,
        }),
      },
      pointToPlace: { useMutation: () => ({ mutateAsync: () => new Promise(() => {}) }) },
      viaLocations: { useMutation: () => ({ mutateAsync: () => new Promise(() => {}) }) },
    },
  },
}));

import { convertDistance, EMPTY_ROUTE, isValidDistance, MileageFields } from './MileageFields';

function setup(over: Partial<Parameters<typeof MileageFields>[0]> = {}) {
  const onUnitChange = vi.fn();
  const onDistanceChange = vi.fn();
  render(
    <MileageFields
      distance="100"
      onDistanceChange={onDistanceChange}
      unit="KM"
      onUnitChange={onUnitChange}
      route={EMPTY_ROUTE}
      onRouteChange={vi.fn()}
      {...over}
    />,
  );
  return { onUnitChange, onDistanceChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.available = true;
  h.loading = false;
  h.preview = undefined;
  h.previewCalls = [];
  h.routes = [];
  h.computed = [];
  h.recent = [];
});

describe('isValidDistance', () => {
  it('accepts a positive decimal with up to two places', () => {
    for (const v of ['1', '100', '100.5', '0.25', ' 42 ']) {
      expect(isValidDistance(v)).toBe(true);
    }
  });

  it('rejects anything that is not one', () => {
    for (const v of ['', '-5', 'abc', '1.234', '1,000']) {
      expect(isValidDistance(v)).toBe(false);
    }
  });
});

describe('MileageFields', () => {
  it('offers BOTH units — the add form had no way to say miles', () => {
    h.available = false;
    setup();
    expect(screen.getByRole('button', { name: 'KM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MI' })).toBeInTheDocument();
  });

  it('marks the selected unit, so the number and its unit cannot disagree', () => {
    h.available = false;
    setup({ unit: 'MI' });
    expect(screen.getByRole('button', { name: 'MI' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'KM' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not repeat the unit in the placeholder — the toggle beside it says so', () => {
    h.available = false;
    setup({ unit: 'MI' });
    expect(screen.getByLabelText('line.distance')).toHaveAttribute('placeholder', 'line.distance');
  });

  it('reports a unit change', async () => {
    const user = userEvent.setup();
    h.available = false;
    const { onUnitChange } = setup();
    await user.click(screen.getByRole('button', { name: 'MI' }));
    expect(onUnitChange).toHaveBeenCalledWith('MI');
  });

  it('does not fire for the unit already selected', async () => {
    const user = userEvent.setup();
    h.available = false;
    const { onUnitChange } = setup({ unit: 'KM' });
    await user.click(screen.getByRole('button', { name: 'KM' }));
    expect(onUnitChange).not.toHaveBeenCalled();
  });

  it('flags a malformed distance on the field itself', () => {
    h.available = false;
    setup({ distance: 'abc' });
    expect(screen.getByLabelText('line.distance').className).toContain('border-destructive');
  });

  it('route mode: the caller’s route control under the row, and no stops of its own', () => {
    setup({ mode: 'route', routeControl: <div data-testid="route-control" /> });
    expect(screen.getByTestId('route-control')).toBeInTheDocument();
    expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
    // The old "Add route" button is gone too.
    expect(screen.queryByText('line.addRoute')).not.toBeInTheDocument();
  });

  it('route mode: the route control sits 12 px under the row (6 px row gap + mt-1.5), as on a new line (FR-7)', () => {
    setup({ mode: 'route', routeControl: <div data-testid="route-control" /> });
    const block = screen.getByTestId('route-control').parentElement;
    expect(block).toHaveClass('mt-1.5', 'w-full');
    expect(block).not.toHaveClass('mt-3');
    expect(block).not.toHaveClass('mt-2');
  });

  it('route mode with a route: the dropdown and map sit 18 px under the row (6 px row gap + mt-3)', () => {
    setup({
      mode: 'route',
      routeControl: <div data-testid="route-control" />,
      route: { stops: [{ description: 'Toronto' }, { description: 'Ottawa' }] },
    });
    const block = screen.getByTestId('route-control').parentElement;
    expect(block).toHaveClass('mt-3', 'w-full');
    expect(block).not.toHaveClass('mt-1.5');
  });

  it('route mode: shows the measured distance as text, not an editable box', () => {
    setup({ mode: 'route', distance: '141.20' });
    expect(screen.getByText('141.20')).toBeInTheDocument();
    // An editable figure beside the route that produced it invites a claim that
    // contradicts its own route.
    expect(screen.queryByLabelText('line.distance')).not.toBeInTheDocument();
  });

  it('route mode: says the distance is pending until a route is chosen', () => {
    setup({ mode: 'route', distance: '' });
    expect(screen.getByText('line.distancePending')).toBeInTheDocument();
    // Nothing to restate yet.
    expect(screen.getByRole('button', { name: 'MI' })).toBeDisabled();
  });

  it('route mode: the unit buttons are live, with no Edit and no lock', async () => {
    const { onUnitChange } = setup({ mode: 'route', onEdit: vi.fn() });
    expect(screen.queryByRole('button', { name: 'route.editRoute' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'MI' }));
    expect(onUnitChange).toHaveBeenCalledWith('MI');
  });

  it('says NOTHING about lookup being off — it just leaves the box editable', () => {
    // No notice. Telling a traveller about an integration they cannot install, next
    // to a distance field that already works, is noise on the form where the work
    // happens. Typing the number IS the job here.
    h.available = false;
    setup();
    expect(screen.getByLabelText('line.distance')).toBeInTheDocument();
    // Nothing but the field, the unit toggle, and no route panel.
    expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KM' })).toBeInTheDocument();
  });

  it('still shows a stored route when lookup was switched off later', () => {
    // It is part of a filed claim; hiding it because a setting changed would lose
    // evidence an approver may be relying on.
    h.available = false;
    setup({
      route: { stops: [{ description: 'Toronto' }, { description: 'Ottawa' }] },
    });
    expect(screen.getByText(/Toronto/)).toBeInTheDocument();
  });

  it('disables every control when the caller disables it', () => {
    h.available = false;
    setup({ disabled: true });
    expect(screen.getByLabelText('line.distance')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'MI' })).toBeDisabled();
  });
});

/**
 * The three modes (FR-6). A saved line is `locked` until Edit route; `editing` and `new`
 * are both open forms, and NOTHING in this component writes in any mode — there is no
 * blur callback left to write from.
 */
describe('MileageFields modes', () => {
  const ROUTE = {
    stops: [
      { placeId: 'a', description: 'Toronto' },
      { placeId: 'b', description: 'Ottawa' },
    ],
  };

  describe('locked', () => {
    it('keeps the fields as real disabled inputs, in a legible muted colour', () => {
      // Disabled, not read-only text (UX ruling U1) — but not faded to half opacity
      // either, which fails contrast on a claim the traveller still has to read.
      h.available = false;
      setup({ mode: 'locked', onEdit: vi.fn() });
      const field = screen.getByLabelText('line.distance');
      expect(field).toBeDisabled();
      expect(field.className).toContain('disabled:text-muted-foreground');
      expect(field.className).toContain('disabled:opacity-100');
      for (const u of ['KM', 'MI']) {
        const button = screen.getByRole('button', { name: u });
        expect(button).toBeDisabled();
        expect(button.className).not.toContain('opacity-50');
      }
      // The chosen unit is still marked.
      expect(screen.getByRole('button', { name: 'KM' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('with lookup off, offers Edit route, described by the route and the distance', async () => {
      h.available = false;
      const onEdit = vi.fn();
      setup({ mode: 'locked', onEdit, route: ROUTE, distance: '450.00' });
      const edit = screen.getByRole('button', { name: 'route.editRoute' });
      expect(edit).toHaveAccessibleDescription(
        'route.lockedSummary:Toronto → Ottawa,line.distanceValue:450.00,line.km',
      );
      await userEvent.setup().click(edit);
      expect(onEdit).toHaveBeenCalledOnce();
    });

    it('with lookup on (the typed path of a route line), offers Edit distance beside the route control', () => {
      // The route control already says the route, so Edit is described by the distance.
      setup({
        mode: 'locked',
        onEdit: vi.fn(),
        route: ROUTE,
        distance: '450.00',
        routeControl: <div data-testid="route-control" />,
      });
      expect(screen.getByTestId('route-control')).toBeInTheDocument();
      expect(screen.getByLabelText('line.distance')).toBeDisabled();
      expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'line.editDistance' })).toHaveAccessibleDescription(
        'line.distanceValue:450.00,line.km',
      );
    });

    it('describes a line with no route by its distance alone', () => {
      h.available = false;
      setup({ mode: 'locked', onEdit: vi.fn(), unit: 'MI' });
      expect(screen.getByRole('button', { name: 'route.editRoute' })).toHaveAccessibleDescription(
        'line.distanceValue:100,line.mi',
      );
    });

    it('with lookup off, says a stored route once, in the summary', () => {
      h.available = false;
      setup({ mode: 'locked', onEdit: vi.fn(), route: ROUTE });
      expect(screen.getAllByText(/Toronto → Ottawa/)).toHaveLength(1);
    });
  });

  it('editing: the fields are open and Edit route is gone', () => {
    h.available = false;
    setup({ mode: 'editing', onEdit: vi.fn() });
    expect(screen.getByLabelText('line.distance')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'MI' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'route.editRoute' })).not.toBeInTheDocument();
  });

  it('new (the default), lookup off: the open typed distance, with no Edit route', () => {
    h.available = false;
    setup();
    expect(screen.getByLabelText('line.distance')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'route.editRoute' })).not.toBeInTheDocument();
  });

  /**
   * A saved line never edits its stops in place any more: with lookup on, its route control
   * (the caller's `routeControl`) is the way to change the route, in every mode.
   */
  it.each(['route', 'locked', 'editing'] as const)('%s mode, lookup on: no stop fields', (mode) => {
    setup({ mode, onEdit: vi.fn(), route: ROUTE });
    expect(screen.queryByLabelText('from')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'previousRoutes' })).not.toBeInTheDocument();
  });
});

/**
 * A NEW line with lookup on (FR-1, FR-5): the route dropdown and nothing else, and the
 * workspace it opens is where the line is created — in one call — or abandoned.
 */
describe('a new line with lookup on', () => {
  const ROUTE = {
    index: 0,
    label: 'Hwy 401',
    totalMeters: 450_000,
    distance: '450.00',
    durationSeconds: 16_200,
    legs: [{ fromPlaceId: 'a', toPlaceId: 'b', meters: 450_000 }],
    encodedPolyline: 'enc',
  };
  const PREVIOUS = (n: number) => ({
    stops: [
      { placeId: `a${n}`, description: `From ${n}` },
      { placeId: `b${n}`, description: `To ${n}` },
    ],
    legs: [{ fromPlaceId: `a${n}`, toPlaceId: `b${n}`, meters: 1000 }],
    distance: { KM: '1.00', MI: '0.62' },
  });
  const dropdown = () => screen.getByRole('combobox', { name: 'route.dropdownLabel' });

  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(dropdown());
    return screen.findByRole('listbox');
  }

  it('is the dropdown alone: no stops, Calculate, unit toggle or price', () => {
    setup({ pricing: { expenseId: 'e', categoryId: 'c', currency: { code: 'CAD', symbol: '$' } } });
    expect(dropdown()).toBeInTheDocument();
    expect(screen.queryByLabelText('from')).toBeNull();
    expect(screen.queryByLabelText('to')).toBeNull();
    expect(screen.queryByRole('button', { name: 'calculate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'KM' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'MI' })).toBeNull();
    expect(screen.queryByRole('status', { name: 'line.amount' })).toBeNull();
  });

  it('offers New route alone, with no empty group title, when there are no previous routes', async () => {
    const user = userEvent.setup();
    setup();
    const list = await open(user);
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['newRoute']);
    expect(within(list).queryByRole('group')).toBeNull();
  });

  it('lists New route above a "Previous routes" group of at most five', async () => {
    h.recent = [1, 2, 3, 4, 5, 6].map(PREVIOUS);
    const user = userEvent.setup();
    setup();
    const list = await open(user);
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveTextContent('newRoute');
    const group = within(list).getByRole('group', { name: 'previousRoutes' });
    expect(within(group).getAllByRole('option')).toHaveLength(5);
  });

  it('New route opens the workspace; Use this route makes ONE create call with the route', async () => {
    h.routes = [ROUTE];
    const onAccept = vi.fn(async () => {});
    const user = userEvent.setup();
    setup({ onAccept });
    await open(user);
    await user.click(screen.getByRole('option', { name: 'newRoute' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Nothing is asked of Google until every stop is a picked place.
    expect(h.computed).toEqual([]);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('a previous route reopens as stored, and an unchanged Use this route writes it back once', async () => {
    h.recent = [PREVIOUS(1)];
    h.routes = [{ ...ROUTE, legs: [{ fromPlaceId: 'a1', toPlaceId: 'b1', meters: 450_000 }] }];
    const onAccept = vi.fn(async () => {});
    const user = userEvent.setup();
    setup({ onAccept });
    await open(user);
    await user.click(screen.getByRole('option', { name: /previousRouteEnds:From 1,To 1/ }));
    expect(h.computed).toEqual([{ placeIds: ['a1', 'b1'], unit: 'KM' }]);
    await user.click(await screen.findByRole('button', { name: 'route.picker.useRoute' }));
    expect(onAccept).toHaveBeenCalledOnce();
    // The stored route and its stored distance, not the fresh answer's (spec FR-4 step 5).
    expect(onAccept).toHaveBeenCalledWith({
      mileageDistance: '1.00',
      mileageUnit: 'KM',
      mileageRoute: { stops: PREVIOUS(1).stops, legs: PREVIOUS(1).legs },
    });
    // Nothing Google drew is written: the route is its stops and legs.
    const written = JSON.stringify(onAccept.mock.calls[0]);
    expect(written).not.toMatch(/encodedPolyline|passThrough/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel writes nothing and gives the draft up', async () => {
    h.recent = [PREVIOUS(1)];
    h.routes = [ROUTE];
    const onAccept = vi.fn(async () => {});
    const onAbandon = vi.fn();
    const user = userEvent.setup();
    setup({ onAccept, onAbandon });
    await open(user);
    await user.click(screen.getByRole('option', { name: /previousRouteEnds:From 1,To 1/ }));
    await user.click(await screen.findByRole('button', { name: 'addLine.cancel' }));
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * FR-7: the dropdown sits full width under the category row, 12 px below it in both
   * states. The new-line row (`parts.tsx` NewLineForm) has a 6 px `gap-1.5`, so the new
   * line adds `mt-1.5`; a saved line's route block sits in the saved row's `gap-1.5` too,
   * so it takes the same `mt-1.5`.
   */
  it('sits full width under the category row, 12 px down (6 px row gap + mt-1.5)', () => {
    const { container } = render(
      <MileageFields
        distance=""
        onDistanceChange={vi.fn()}
        unit="KM"
        onUnitChange={vi.fn()}
        route={EMPTY_ROUTE}
        onRouteChange={vi.fn()}
      />,
    );
    const root = container.firstElementChild;
    expect(root).toContainElement(dropdown());
    expect(root).toHaveClass('w-full', 'lg:basis-full', 'mt-1.5');
    expect(root).not.toHaveClass('lg:flex-1');
    expect(root).not.toHaveClass('lg:min-w-[14rem]');
  });

  it('with lookup off, is the typed distance and no dropdown (FR-1 1.A)', () => {
    h.available = false;
    setup();
    expect(screen.getByLabelText('line.distance')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'route.dropdownLabel' })).toBeNull();
  });
});

describe('convertDistance', () => {
  it('restates kilometres as miles and back', () => {
    expect(convertDistance('100', 'KM', 'MI')).toBe('62.14');
    expect(convertDistance('62.14', 'MI', 'KM')).toBe('100.00');
  });

  it('is a no-op for the same unit', () => {
    expect(convertDistance('100', 'KM', 'KM')).toBe('100');
  });

  it('leaves an unparseable value alone rather than producing NaN', () => {
    expect(convertDistance('', 'KM', 'MI')).toBe('');
    expect(convertDistance('abc', 'KM', 'MI')).toBe('abc');
  });

  it('uses the SAME factor the server prices with', () => {
    // The server's convertScaled uses 1.609344; a client that rounded differently
    // would show one number and reimburse another.
    expect(convertDistance('1', 'MI', 'KM')).toBe('1.61');
    expect(Number(convertDistance('1000', 'MI', 'KM'))).toBeCloseTo(1609.34, 2);
  });
});

/**
 * The derived cost, shown beside the distance.
 *
 * A mileage line's amount is not typed — it is km × rate, banded by the distance
 * already claimed this year. So the traveller had no idea what the claim was worth
 * until after it was saved. These tests cover the two ways that can go wrong: not
 * showing a figure, and showing the WRONG one (a stale amount beside a new
 * distance reads as the answer, which is worse than showing nothing).
 */
describe('the priced amount', () => {
  const PRICING = {
    expenseId: '11111111-1111-1111-1111-111111111111',
    categoryId: '22222222-2222-2222-2222-222222222222',
    currency: { code: 'CAD', symbol: '$' },
  };

  it('is not shown at all when the caller asks for no pricing', () => {
    h.available = false;
    setup({ distance: '100' });
    expect(screen.queryByLabelText('line.amount')).not.toBeInTheDocument();
    expect(h.previewCalls.every((c) => !c.enabled)).toBe(true);
  });

  it('shows what the distance is worth, in the expense currency', () => {
    h.available = false;
    h.preview = { ok: true, amountMinor: '1795' };
    setup({ distance: '25.66', pricing: PRICING });
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('$17.95');
  });

  it('prices the distance the field actually holds, in the unit shown', () => {
    h.available = false;
    h.preview = { ok: true, amountMinor: '1795' };
    setup({ distance: '25.66', unit: 'MI', pricing: PRICING });
    const asked = h.previewCalls.filter((c) => c.enabled).at(-1);
    expect(asked?.input).toMatchObject({
      expenseId: PRICING.expenseId,
      categoryId: PRICING.categoryId,
      mileageDistance: '25.66',
      mileageUnit: 'MI',
    });
  });

  it('says why there is no figure, rather than leaving a blank', () => {
    h.available = false;
    h.preview = { ok: false, reason: 'No mileage rate in force for US on this date.' };
    setup({ distance: '25.66', pricing: PRICING });
    expect(screen.getByText(/No mileage rate in force for US/)).toBeInTheDocument();
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('—');
  });

  it('never asks the server for a figure it was already given', () => {
    // An existing line, distance untouched. Thirty of these on one report must not
    // become thirty requests to recompute what the report already carried.
    h.available = false;
    setup({
      distance: '25.66',
      pricing: { ...PRICING, saved: { amountMinor: '1795', distance: '25.66' } },
    });
    expect(h.previewCalls.every((c) => !c.enabled)).toBe(true);
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('$17.95');
  });

  it('shows no figure at all once the distance is cleared', () => {
    // The query is keyed by the distance, so an emptied field has no answer of its
    // own — what must not happen is the PREVIOUS distance's price staying put beside
    // an empty box, which would read as the price of nothing.
    h.available = false;
    h.preview = { ok: true, amountMinor: '1795' };
    setup({ distance: '', pricing: PRICING });
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('—');
    expect(h.previewCalls.every((c) => !c.enabled)).toBe(true);
  });

  it('drops the saved figure the moment the distance no longer matches it', () => {
    h.available = false;
    h.preview = { ok: true, amountMinor: '2100' };
    setup({
      distance: '30',
      pricing: { ...PRICING, saved: { amountMinor: '1795', distance: '25.66' } },
    });
    // The saved $17.95 belongs to 25.66 km; the field says 30.
    expect(screen.getByLabelText('line.amount')).not.toHaveTextContent('$17.95');
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('$21.00');
  });

  it('on a route line, keeps the saved figure for the same claim shown in the other unit', () => {
    // Display-only KM/MI: 25.66 km shown as 15.94 mi is the same claim, priced in the
    // rule's unit. Pricing the restated number would re-round it into a different claim.
    h.preview = { ok: true, amountMinor: '9999' };
    setup({
      mode: 'route',
      distance: '15.94',
      unit: 'MI',
      pricing: { ...PRICING, saved: { amountMinor: '1795', distance: '25.66' } },
    });
    expect(screen.getByLabelText('line.amount')).toHaveTextContent('$17.95');
    expect(h.previewCalls.every((c) => !c.enabled)).toBe(true);
  });
});

/**
 * Distance carried over from Concur. Without it, a traveller whose first ExpenseOS trip
 * prices in the second band sees a lower rate and no reason for it.
 */
describe('mileage carried over from Concur', () => {
  const PRICING = {
    expenseId: '11111111-1111-1111-1111-111111111111',
    categoryId: '22222222-2222-2222-2222-222222222222',
    currency: { code: 'CAD', symbol: '$' },
  };
  const priced = (over: Record<string, unknown>) => {
    h.available = false;
    h.preview = {
      ok: true,
      amountMinor: '1795',
      unit: 'KM',
      distance: '25.66',
      ytdBefore: '6200',
      carriedOver: '0.00',
      carriedThrough: null,
      ...over,
    } as never;
    setup({ distance: '25.66', pricing: PRICING });
  };

  it('says how much of this year came from Concur, and through when', () => {
    priced({ carriedOver: '6000.5', carriedThrough: new Date('2026-10-15T00:00:00.000Z') });
    expect(
      screen.getByText('line.mileageCarried:6,200,6,000.5,line.mileageUnitShort.KM,Oct 15, 2026'),
    ).toBeInTheDocument();
  });

  it('names miles when the rule is in miles, and survives a missing date', () => {
    priced({ unit: 'MI', carriedOver: '10', carriedThrough: null, ytdBefore: null });
    expect(
      screen.getByText('line.mileageCarried:0,10,line.mileageUnitShort.MI,—'),
    ).toBeInTheDocument();
  });

  it('says nothing when nothing was carried over', () => {
    priced({});
    expect(screen.queryByText(/line\.mileageCarried/)).not.toBeInTheDocument();
  });
});

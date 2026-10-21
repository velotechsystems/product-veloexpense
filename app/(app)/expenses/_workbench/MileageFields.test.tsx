import { render, screen } from '@testing-library/react';
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
      // to answer too.
      searchPlaces: {
        useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
      },
      computeRoute: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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
    setup();
    expect(screen.getByRole('button', { name: 'KM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MI' })).toBeInTheDocument();
  });

  it('marks the selected unit, so the number and its unit cannot disagree', () => {
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
    const { onUnitChange } = setup();
    await user.click(screen.getByRole('button', { name: 'MI' }));
    expect(onUnitChange).toHaveBeenCalledWith('MI');
  });

  it('does not fire for the unit already selected', async () => {
    const user = userEvent.setup();
    const { onUnitChange } = setup({ unit: 'KM' });
    await user.click(screen.getByRole('button', { name: 'KM' }));
    expect(onUnitChange).not.toHaveBeenCalled();
  });

  it('flags a malformed distance on the field itself', () => {
    h.available = false;
    setup({ distance: 'abc' });
    expect(screen.getByLabelText('line.distance').className).toContain('border-destructive');
  });

  it('shows From/To immediately when lookup works — no disclosure to find first', () => {
    setup();
    expect(screen.getByLabelText('from')).toBeInTheDocument();
    expect(screen.getByLabelText('to')).toBeInTheDocument();
    // The old "Add route" button is gone: the stops ARE the mileage line.
    expect(screen.queryByText('line.addRoute')).not.toBeInTheDocument();
  });

  it('shows the measured distance as text, not an editable box', () => {
    setup({ distance: '141.20' });
    expect(screen.getByText('141.20')).toBeInTheDocument();
    // An editable figure beside the stops that produced it invites a claim that
    // contradicts its own route.
    expect(screen.queryByLabelText('line.distance')).not.toBeInTheDocument();
  });

  it('says the distance is pending until a route resolves', () => {
    setup({ distance: '' });
    expect(screen.getByText('line.distancePending')).toBeInTheDocument();
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

  it('disables every control when the row is locked', () => {
    h.available = false;
    setup({ disabled: true });
    expect(screen.getByLabelText('line.distance')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'MI' })).toBeDisabled();
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

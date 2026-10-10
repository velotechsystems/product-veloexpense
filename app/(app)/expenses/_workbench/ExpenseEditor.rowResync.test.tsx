import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's combobox is an <input placeholder>; the kit's is a button.
import { getComboboxByPlaceholder } from '@/test-utils/kitCombobox';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * A report refetch must not discard what a line row is holding.
 *
 * Two reported symptoms, one cause. Adding a line "fully refreshes the screen", and
 * mileage "calculates once and then never updates however many stops you add".
 *
 * `mileageRoute` is a Json column, so Prisma returns a NEW OBJECT on every fetch
 * even when the stored value is byte-identical. The row's re-sync effect depended on
 * that object, and adding a line triggers a full report refetch — so the effect
 * re-ran for EVERY row on every refetch and reset all of them. A route carrying a
 * freshly-added stop was replaced by the server's older copy, and because
 * RouteEditor remembers which stop set it last measured, the restored route counted
 * as "already measured" and no new measurement fired.
 *
 * These assert the row's state SURVIVES a re-render whose data is unchanged apart
 * from object identity, and still updates when a value genuinely changes — because
 * the naive fix (never re-sync) breaks extraction results appearing without a
 * manual refresh, which is what the effect is for.
 *
 * On mutation coverage, stated plainly: removing BOTH fix mechanisms (the
 * value-stable `routeFromServer` dep and the `routePending` hold) fails the first test.
 * Removing either ONE does not, because in this scenario each is independently
 * sufficient. They are both kept because they cover different windows in
 * production — `routePending` spans the gap between the edit and the write landing,
 * `routeKey` covers every refetch after that — but this test cannot distinguish
 * them, and pretending otherwise would overstate what it proves.
 */

const h = vi.hoisted(() => ({ updates: [] as unknown[] }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: () => ({
      isPending: false,
      mutate: (vars: unknown) => {
        if (name === 'lineItemUpdate') h.updates.push(vars);
      },
      mutateAsync: vi.fn(),
    }),
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return {
    trpc: {
      expenses: router,
      mileageRoute: {
        // Available, so RouteEditor renders one input per stop and the stop set
        // is observable rather than collapsed into a summary line.
        status: { useQuery: () => ({ data: { available: true }, isLoading: false }) },
        searchPlaces: {
          useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
        },
        computeRoute: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
  };
});

vi.mock('@/components/attachments/AttachmentViewer', () => ({
  AttachmentDocument: () => null,
  useViewerZoom: () => ({ zoom: 1, setZoom: vi.fn() }),
  ZoomControls: () => null,
}));

import { ExpenseEditor } from './parts';

const CATEGORIES = [
  { value: 'cat-mileage', label: 'Travel - Mileage', isMileage: true },
  { value: 'cat-meals', label: 'Travel - Meals' },
];

/** A mileage line carrying a measured two-stop route. */
const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  categoryId: 'cat-mileage',
  category: { id: 'cat-mileage', label: 'Travel - Mileage', icon: null, isMileage: true },
  amountMinor: '5000',
  mileageDistance: '72',
  mileageUnit: 'KM',
  // A FRESH object each call — exactly what Prisma does with a Json column.
  mileageRoute: {
    stops: [
      { description: 'A', placeId: 'p1' },
      { description: 'B', placeId: 'p2' },
    ],
  },
  receipts: [],
  ...over,
});

const expenseWith = (l: ReturnType<typeof line>) =>
  ({
    id: 'exp-1',
    merchant: 'Personal vehicle',
    date: new Date('2026-08-01').toISOString(),
    amountMinor: '5000',
    currency: { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 },
    placeText: null,
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [l],
    receipts: [],
    attendees: [],
    allocations: [],
    taxGstHstMinor: null,
    taxQstMinor: null,
    taxPstMinor: null,
    taxSource: 'CALCULATED',
    subtotalMinor: null,
    fxRate: null,
  }) as never;

function renderEditor(l: ReturnType<typeof line>) {
  return render(
    <ExpenseEditor
      expense={expenseWith(l)}
      violations={[]}
      currencySymbol="$"
      editable
      categoryItems={CATEGORIES}
      locale={CATALOG_LOCALE}
      onChange={vi.fn()}
      entityRecovers
    />,
  );
}

/** The route's stop inputs, which carry stable aria-labels (from / to / stop). */
const stopInput = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** Re-render with `l`, standing in for a report refetch landing. */
const refetchWith = (rerender: (ui: React.ReactElement) => void, l: ReturnType<typeof line>) =>
  rerender(
    <ExpenseEditor
      expense={expenseWith(l)}
      violations={[]}
      currencySymbol="$"
      editable
      categoryItems={CATEGORIES}
      locale={CATALOG_LOCALE}
      onChange={vi.fn()}
      entityRecovers
    />,
  );

beforeEach(() => {
  h.updates.length = 0;
});

describe('line-row re-sync across a report refetch', () => {
  it('does not discard an ADDED STOP when a refetch brings the old route back', async () => {
    /**
     * The reported scenario, and the only interaction that actually reaches the
     * row's route state.
     *
     * Typing into a stop does NOT: PlaceInput keeps its own `query` while open and
     * discards it on blur unless a suggestion is picked, so a typed-but-unpicked
     * address never leaves that component. An earlier version of this test typed
     * into "to" and passed against the BUG as well as the fix — it was watching
     * PlaceInput's internal state, not the row's.
     *
     * Adding a stop goes through `onChange` to the parent, so the third input is
     * real evidence of the row's state. Before the fix, the refetch that the
     * accompanying commit triggers reset the route to the server's 2-stop copy and
     * the new stop vanished — which is also why no re-measure fired: RouteEditor
     * still had the old stop set recorded as measured.
     */
    const user = userEvent.setup();
    const { rerender } = renderEditor(line());
    expect(screen.queryAllByLabelText(/^(from|to|stop)$/)).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /addStop/i })[0]);
    expect(screen.queryAllByLabelText(/^(from|to|stop)$/)).toHaveLength(3);

    // A refetch lands carrying the server's OLD two-stop route.
    refetchWith(rerender, line());

    expect(screen.queryAllByLabelText(/^(from|to|stop)$/)).toHaveLength(3);
  });

  it('still adopts a stop the server genuinely added', () => {
    // The other half. "Never re-sync" would pass the test above and break the
    // reason the effect exists — extraction rebuilding a line has to appear
    // without a manual page refresh.
    const { rerender } = renderEditor(line());
    expect(stopInput('from').value).toBe('A');
    expect(stopInput('to').value).toBe('B');

    refetchWith(
      rerender,
      line({
        mileageRoute: {
          stops: [
            { description: 'A', placeId: 'p1' },
            { description: 'MID', placeId: 'p9' },
            { description: 'Z', placeId: 'p3' },
          ],
        },
      }),
    );
    // A real value change lands: the destination is now Z, with a middle stop.
    expect(stopInput('to').value).toBe('Z');
    expect(screen.getByDisplayValue('MID')).toBeDefined();
  });

  it('adopts a category the server genuinely changed', () => {
    // The reset covers more than the route; a real change to any of it must land.
    const { rerender } = renderEditor(line());
    refetchWith(
      rerender,
      line({
        categoryId: 'cat-meals',
        category: { id: 'cat-meals', label: 'Travel - Meals', icon: null, isMileage: false },
      }),
    );
    // VeloExpense: the kit Combobox shows its pick as the trigger's text, not an input's
    // value (test-utils/kitCombobox).
    expect(getComboboxByPlaceholder('addLine.categoryPlaceholder')).toHaveTextContent(
      'Travel - Meals',
    );
  });
});

/**
 * A money field cannot be typed full of prose, and an amount that cannot be converted says so
 * instead of dropping the write.
 *
 * The audit typed `abc<b>x</b>` into a `$` field and it was accepted (GA readiness report
 * F06). The only consequence was a save that never happened — `commit` returned silently on an
 * unconvertible value — so the typed characters sat there looking exactly like a saved amount
 * until an unrelated refetch replaced them.
 */
describe('a money field handed something that is not money', () => {
  /** A NON-mileage line, which is the shape that carries a free amount field. */
  const amountLine = () =>
    line({
      categoryId: 'cat-meals',
      category: { id: 'cat-meals', label: 'Travel - Meals', icon: null, isMileage: false },
      mileageDistance: null,
      mileageRoute: null,
    });

  it('refuses the characters outright', async () => {
    const user = userEvent.setup();
    renderEditor(amountLine());
    const amount = screen.getByLabelText('line.amount');

    await user.clear(amount);
    await user.type(amount, 'abc<b>x</b>');
    // Not "accepted and rejected on save" — never in the field at all.
    expect(amount).toHaveValue('');
  });

  it('keeps only the digits out of a mixed paste', async () => {
    const user = userEvent.setup();
    renderEditor(amountLine());
    const amount = screen.getByLabelText('line.amount');

    await user.clear(amount);
    await user.type(amount, '12abc34');
    expect(amount).toHaveValue('1234');
  });

  it('still accepts a half-typed amount', async () => {
    // The reason this is a filter and not a validator: people type one character at a time,
    // and refusing "12." would make the field unusable.
    const user = userEvent.setup();
    renderEditor(amountLine());
    const amount = screen.getByLabelText('line.amount');

    await user.clear(amount);
    await user.type(amount, '12.');
    expect(amount).toHaveValue('12.');
  });
});

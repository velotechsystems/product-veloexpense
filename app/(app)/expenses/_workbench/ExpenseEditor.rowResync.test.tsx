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
 * A saved mileage line on the TYPED path (here: a route with no legs, so its distance is
 * not the route's) is LOCKED until Edit, and its draft is held while it is being edited
 * (FR-6) — that hold replaced the old `routePending` one, which spanned a chain of
 * autosaves that no longer exists. Nothing is written until Save, so the question these
 * answer is narrower: does a refetch leave an edit in progress alone, does Save's result
 * stay on screen until the server's copy arrives, and does a genuine server change still
 * land on a locked row? (A line measured by its route has no draft at all: its route
 * changes only through the workspace.)
 *
 * On mutation coverage, stated plainly: the first test fails only when BOTH the edit
 * hold and the value-stable `routeFromServer` dep are removed, because a refetch whose
 * route is merely a new object is stopped by either. "Holds a genuine server change
 * during an edit" is the one that needs the edit hold on its own.
 */

const h = vi.hoisted(() => ({
  updates: [] as unknown[],
  /**
   * When set, `lineItemUpdate` runs its `onMutate` on each call and keeps the options so a
   * test can settle the writes one at a time, the way a real network does. Off by default:
   * the other tests here describe a row whose writes never settle.
   */
  lifecycle: false,
  /** Settle the last `lineItemUpdate` as a success, the way a real network eventually does. */
  settle: () => {},
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: (opts?: {
      onMutate?: () => void;
      onSuccess?: () => void;
      onSettled?: () => void;
    }) => ({
      isPending: false,
      mutate: (vars: unknown, perCall?: { onSuccess?: () => void }) => {
        if (name !== 'lineItemUpdate') return;
        h.updates.push(vars);
        if (h.lifecycle && opts) {
          opts.onMutate?.();
          h.settle = () => {
            opts.onSuccess?.();
            perCall?.onSuccess?.();
            opts.onSettled?.();
          };
        }
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
        // Available, so the line carries its route control; no browser key, so no map.
        status: { useQuery: () => ({ data: { available: true }, isLoading: false }) },
        recentRoutes: { useQuery: () => ({ data: undefined, isLoading: false }) },
        searchPlaces: {
          useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
        },
        computeRoutes: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        lineRoutePath: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
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

/** The typed distance. */
const distanceInput = () => screen.getByLabelText('line.distance') as HTMLInputElement;

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
  h.lifecycle = false;
  h.settle = () => {};
});

const editRoute = () => screen.getByRole('button', { name: 'line.editDistance' });

describe('line-row re-sync across a report refetch', () => {
  it('does not discard a distance being edited when a refetch brings the same line back', async () => {
    /**
     * The reported scenario: adding a line refetches the whole report, and every line comes
     * back as a NEW route object with the same value. The row being edited must keep what
     * is being typed into it — and the edit wrote nothing for the refetch to be racing.
     */
    const user = userEvent.setup();
    const { rerender } = renderEditor(line());
    await user.click(editRoute());
    await user.clear(distanceInput());
    await user.type(distanceInput(), '150');

    // A refetch lands carrying the server's copy: same value, new objects.
    refetchWith(rerender, line());

    expect(distanceInput().value).toBe('150');
    expect(h.updates).toHaveLength(0);
  });

  it('after Save, shows what was saved until the server copy lands, then adopts it', async () => {
    /**
     * Replaces "holds the route until its LAST write lands". A route edit used to fire a
     * chain of writes and the hold had to outlast all of them; Save is one write now.
     *
     * What is left to pin is the moment after it. Save locks the row again, and the row
     * must keep showing the figures just saved — not flick back to the server's pre-save
     * copy, which is what adding `editing` to the re-sync's dependencies would do — and
     * then take the server's own copy (its price, in particular) when the refetch lands.
     */
    h.lifecycle = true;
    const user = userEvent.setup();
    const { rerender } = renderEditor(line());

    await user.click(editRoute());
    // A measured 72 km restated in miles.
    await user.click(screen.getByRole('button', { name: 'MI' }));
    expect(distanceInput().value).toBe('44.74');
    await user.click(screen.getByRole('button', { name: 'addLine.saveEdit' }));
    expect(h.updates).toEqual([
      expect.objectContaining({ mileageDistance: '44.74', mileageUnit: 'MI' }),
    ]);

    // The write lands. Locked again, on the saved figures, before any refetch.
    h.settle();
    refetchWith(rerender, line());
    expect(editRoute()).toBeDefined();
    expect(distanceInput().value).toBe('44.74');
    expect(screen.getByRole('button', { name: 'MI' }).getAttribute('aria-pressed')).toBe('true');

    // The refetch brings the server's copy, priced by the server.
    refetchWith(
      rerender,
      line({ mileageDistance: '44.74', mileageUnit: 'MI', amountMinor: '3221' }),
    );
    expect(screen.getByLabelText('line.amount').textContent).toMatch(/32\.21/);
    expect(h.updates).toHaveLength(1);
  });

  it('holds a genuine server change during an edit, and shows it after Cancel', async () => {
    // The edit is the person's until they finish it; Cancel then shows the LATEST stored
    // line, not the one the edit started from.
    const user = userEvent.setup();
    const { rerender } = renderEditor(line());
    await user.click(editRoute());

    refetchWith(rerender, line({ mileageDistance: '80' }));
    expect(distanceInput().value).toBe('72');

    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(distanceInput().value).toBe('80');
    expect(h.updates).toHaveLength(0);
  });

  it('still adopts a distance the server genuinely changed', () => {
    // The other half. "Never re-sync" would pass the test above and break the
    // reason the effect exists — extraction rebuilding a line has to appear
    // without a manual page refresh.
    const { rerender } = renderEditor(line());
    expect(distanceInput().value).toBe('72');

    refetchWith(
      rerender,
      line({
        mileageDistance: '90',
        mileageRoute: {
          stops: [
            { description: 'A', placeId: 'p1' },
            { description: 'MID', placeId: 'p9' },
            { description: 'Z', placeId: 'p3' },
          ],
        },
      }),
    );
    expect(distanceInput().value).toBe('90');
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

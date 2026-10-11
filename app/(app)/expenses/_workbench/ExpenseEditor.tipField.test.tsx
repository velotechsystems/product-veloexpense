import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tip field, which the line-kind strategy table exists to have made possible.
 *
 * `STANDARD_WITH_TIP` has been a real kind since the line-kind work: `resolveLineKind`
 * returns it, `lineItemUpdate` accepts `tipMinor`, extraction sets it from a receipt, and
 * `tipMinorOf` is used to keep the tip out of the taxable base. It had **no UI** — no
 * input, no display, not even a catalog key. So a tip the extractor read wrongly changed
 * the tax on the line and the claimant could neither see nor correct it.
 *
 * These assert the field appears only where the server would accept a tip, that editing it
 * actually WRITES, and that switching category strips it — because a rendered field that
 * does not save is worse than no field at all.
 */

const h = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[] }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: () => ({
      isPending: false,
      mutate: (vars: Record<string, unknown>) => {
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
        status: { useQuery: () => ({ data: { available: false }, isLoading: false }) },
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
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/** A meal category accepts a tip; a taxi does not; mileage never does. */
const CATEGORIES = [
  { value: 'cat-meals', label: 'Travel - Meals', acceptsTip: true },
  { value: 'cat-taxi', label: 'Travel - Ground' },
  { value: 'cat-mileage', label: 'Travel - Mileage', isMileage: true },
];

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  categoryId: 'cat-meals',
  category: { id: 'cat-meals', label: 'Travel - Meals', icon: null, isMileage: false },
  amountMinor: '11500',
  mileageDistance: null,
  mileageUnit: null,
  mileageRoute: null,
  receipts: [],
  kind: 'STANDARD',
  payload: null,
  ...over,
});

const expenseWith = (l: ReturnType<typeof line>) =>
  ({
    id: 'exp-1',
    merchant: 'Corner Bistro',
    date: new Date('2026-08-01').toISOString(),
    amountMinor: '11500',
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

const tipInput = () => screen.queryByLabelText('lineKinds.tip') as HTMLInputElement | null;

beforeEach(() => {
  h.updates.length = 0;
});

describe('the tip field appears where a tip is accepted', () => {
  it('renders for a category that accepts one', () => {
    renderEditor(line());
    expect(tipInput()).not.toBeNull();
  });

  it('does NOT render for a category that does not', () => {
    // `resolveLineKind` would return STANDARD and discard any tip, so offering the field
    // would invite an edit the server throws away.
    renderEditor(
      line({
        categoryId: 'cat-taxi',
        category: { id: 'cat-taxi', label: 'Travel - Ground', icon: null, isMileage: false },
      }),
    );
    expect(tipInput()).toBeNull();
  });

  it('does NOT render for a mileage line', () => {
    // Mileage keeps its own kind regardless of the tip flag — the amount is km × rate.
    renderEditor(
      line({
        categoryId: 'cat-mileage',
        category: { id: 'cat-mileage', label: 'Travel - Mileage', icon: null, isMileage: true },
        mileageDistance: '42',
        mileageUnit: 'KM',
      }),
    );
    expect(tipInput()).toBeNull();
  });
});

describe('the tip round-trips', () => {
  it('shows an existing tip from the line payload, in major units', () => {
    // The tip lives in `payload`, read through the same `tipMinorOf` the server uses — so
    // the two cannot disagree about where it is stored.
    renderEditor(line({ kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '1700' } }));
    expect(tipInput()?.value).toBe('17.00');
  });

  it('is blank when the line carries none', () => {
    // Not "0.00" — a zero tip and no tip are different, and the second is the default.
    renderEditor(line());
    expect(tipInput()?.value).toBe('');
  });

  it('writes the tip in MINOR units on blur', async () => {
    /**
     * Committed on blur rather than per keystroke: a tip leaves the taxable base, so
     * writing each digit would re-derive the tax on every one.
     */
    const user = userEvent.setup();
    renderEditor(line());
    await user.type(tipInput() as HTMLInputElement, '17.00');
    await user.tab();
    const write = h.updates.find((u) => 'tipMinor' in u);
    expect(write).toBeTruthy();
    expect(write?.tipMinor).toBe('1700');
    // A string, not a number: it is minor-unit money and a Number round-trip is a
    // precision risk for no benefit.
    expect(typeof write?.tipMinor).toBe('string');
  });

  it('sends null when the field is cleared, which CLEARS the tip', async () => {
    // Distinct from omitting it: `lineItemUpdate` treats an omitted tip as "keep" and an
    // explicit null as "clear", so a blanked field has to send null or the tip survives.
    const user = userEvent.setup();
    renderEditor(line({ kind: 'STANDARD_WITH_TIP', payload: { tipMinor: '1700' } }));
    await user.clear(tipInput() as HTMLInputElement);
    await user.tab();
    const write = h.updates.find((u) => 'tipMinor' in u);
    expect(write?.tipMinor).toBeNull();
  });

  it('carries the category with the write, so the server can re-resolve the kind', async () => {
    // The kind depends on category AND tip together; sending the tip alone would make the
    // server resolve against a stale category on a row mid-edit.
    const user = userEvent.setup();
    renderEditor(line());
    await user.type(tipInput() as HTMLInputElement, '5');
    await user.tab();
    const write = h.updates.find((u) => 'tipMinor' in u);
    expect(write?.categoryId).toBe('cat-meals');
  });
});

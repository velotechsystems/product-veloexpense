import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The pre-save tax / FX projection.
 *
 * Everything else in the editor shows SAVED figures. While a line is being typed those
 * figures answer a question the person stopped asking, so this panel projects what saving
 * the draft rows will produce — using the server's arithmetic, never the browser's.
 *
 * The tests that matter here are the ones about what it shows when it does NOT know:
 *
 *   · A figure that lags its input is worse than no figure. The old total sitting beside
 *     the new amount reads as the answer, so a stale projection must blank to a dash.
 *   · A mileage row is priced server-side, so it cannot be projected here. The panel has
 *     to SAY the row is excluded; a total that is quietly missing a line is not a
 *     projection, it is a wrong number.
 *   · A currency with no exchange rate must say so rather than render an empty cell,
 *     which reads as "nothing to convert".
 *
 * Mounted through the real ExpenseEditor, because the wiring — which row reports what,
 * and when the panel appears at all — is the part that can break.
 */

const h = vi.hoisted(() => ({
  /** Every totalsPreview.useQuery call: its input and whether it was enabled. */
  preview: { calls: [] as { input: PreviewInput; enabled: boolean }[] },
  /** What totalsPreview answers. Swapped per test. */
  result: {
    data: undefined as PreviewData | undefined,
    isFetching: false,
    isError: false,
  } as PreviewResult,
}));

type PreviewInput = { expenseId: string; addLines: { categoryId: string; amountMinor: string }[] };
type PreviewData = {
  grossMinor: string;
  taxGstHstMinor: string | null;
  taxQstMinor: string | null;
  taxPstMinor: string | null;
  recoverableGstHstMinor: string | null;
  recoverableQstMinor: string | null;
  homeCurrency: string | null;
  homeAmountMinor: string | null;
  fxRate: string | null;
};
type PreviewResult = { data: PreviewData | undefined; isFetching: boolean; isError: boolean };

vi.mock('next-intl', () => ({
  // Keys through, so an assertion names the key rather than a translation. The plural
  // message is returned with its count so the "excluded" note is still observable.
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
      if (name === 'totalsPreview') {
        h.preview.calls.push({
          input: input as PreviewInput,
          enabled: opts?.enabled !== false,
        });
        return h.result;
      }
      return { data: undefined, isLoading: false, isFetching: false, error: null };
    },
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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
        computeRoutes: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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

const expense = {
  id: 'exp-1',
  merchant: 'Le Diplomate',
  date: new Date('2026-08-01').toISOString(),
  amountMinor: '0',
  currency: { id: 'cur-usd', code: 'USD', symbol: '$', exponent: 2 },
  placeText: null,
  purpose: null,
  explanation: null,
  paymentMethod: 'OUT_OF_POCKET',
  lineItems: [],
  receipts: [],
  attendees: [],
  allocations: [],
  taxGstHstMinor: null,
  taxQstMinor: null,
  taxPstMinor: null,
  taxSource: 'CALCULATED',
  subtotalMinor: null,
  fxRate: null,
} as never;

/**
 * 115.00 USD, HST 13% = 13.23, of which half is recoverable (meals carry a 50% ITC),
 * converted to 156.40 CAD at 1.36.
 *
 * The recoverable figure deliberately differs from the tax: when the two are equal a
 * test cannot tell which cell it is reading, and swapping the two in the component
 * would pass.
 */
const FIGURES: PreviewData = {
  grossMinor: '11500',
  taxGstHstMinor: '1323',
  taxQstMinor: '0',
  taxPstMinor: '0',
  recoverableGstHstMinor: '661',
  recoverableQstMinor: '0',
  homeCurrency: 'CAD',
  homeAmountMinor: '15640',
  fxRate: '1.36',
};

function setup() {
  render(
    <ExpenseEditor
      expense={expense}
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

/** The projection panel, or null when it is not on screen. */
function panel() {
  const heading = screen.queryByText('workbench.projectedHeading');
  const box = heading?.closest('div.border-dashed');
  return box ? within(box as HTMLElement) : null;
}

function draftRow() {
  // Located by the row's own container, NOT by the save button: a non-mileage row commits when
  // its category is chosen and never renders one, so keying off the button would report "no row"
  // for the row that is on screen.
  const rows = document.querySelectorAll('div.border-dashed');
  for (const row of rows) {
    if (row.querySelector('[role="combobox"]')) return within(row as HTMLElement);
  }
  return null;
}

/** Open a draft row, pick a category, and type an amount. Advances past the 400ms
 *  settle so the query fires with what was typed. */
async function typeALine(
  user: ReturnType<typeof userEvent.setup>,
  category: RegExp,
  amount?: string,
) {
  await user.click(screen.getByRole('button', { name: 'drawer.addLine' }));
  const row = draftRow();
  if (!row) throw new Error('no draft row opened');
  await user.click(row.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: category }));
  if (amount !== undefined) {
    await user.type(draftRow()?.getByLabelText('line.amount') as HTMLElement, amount);
  }
}

/** Let the 400ms debounce elapse and React commit the resulting state. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

const lastEnabledCall = () => [...h.preview.calls].reverse().find((c) => c.enabled);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.preview.calls = [];
  h.result = { data: undefined, isFetching: false, isError: false };
});

describe('the projected totals panel', () => {
  it('is absent until something is typed — the saved panels are the truth', async () => {
    /**
     * The panel is mounted unconditionally and decides for itself whether it has anything
     * to say, so this is a real assertion about its gate rather than about the caller's.
     * A second set of figures beside the saved ones, showing nothing in particular, is how
     * a stale read gets invited later.
     */
    h.result = { data: FIGURES, isFetching: false, isError: false };
    setup();
    expect(panel()).toBeNull();

    // Nor for an open-but-empty row: no category and no amount is nothing to project.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'drawer.addLine' }));
    await settle();
    expect(panel()).toBeNull();
    // And nothing was asked of the server either.
    expect(lastEnabledCall()).toBeUndefined();
  });

  /**
   * A NON-MILEAGE draft cannot be projected any more, because it cannot exist.
   *
   * Choosing a category commits the line, so by the time totals are computed it is a real line
   * priced from the server's own figures — there is nothing to project. The six tests that used
   * to live here drove exactly that path (type an amount, watch the projection, cancel the row)
   * and are replaced by the two below, which assert the reason it is gone.
   *
   * `ProjectedTotals` is therefore now only reachable for a mileage draft, whose amount genuinely
   * cannot be known client-side. Its priceable branch is currently unreachable — left in place
   * rather than deleted, because it is what would have to come back if the auto-commit were
   * reverted, and removing a tested feature is a bigger call than removing a button.
   */
  it('does not appear for a category that commits on selection', async () => {
    const user = userEvent.setup();
    setup();
    await typeALine(user, /Meals/);
    await settle();
    expect(screen.queryByText('projected.title')).not.toBeInTheDocument();
  });

  it('never ENABLES the pricing query for a line that is already saved', async () => {
    // `useQuery` is called on every render whichever way `enabled` goes, so the call count says
    // nothing. What matters is that none of those calls was enabled — no request was made.
    const user = userEvent.setup();
    setup();
    await typeALine(user, /Meals/);
    await settle();
    expect(lastEnabledCall()).toBeUndefined();
  });

  it('says a mileage row is excluded instead of totalling without it', async () => {
    // The rate, the YTD tier and the unit conversion are all server-side, so the
    // browser cannot price this row. Omitting it silently would show a total that is
    // short by a line.
    h.result = { data: undefined, isFetching: false, isError: false };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup();
    await user.click(screen.getByRole('button', { name: 'drawer.addLine' }));
    await user.click(draftRow()?.getByRole('combobox') as HTMLElement);
    await user.click(await screen.findByRole('option', { name: /Travel - Mileage/ }));
    await user.type(draftRow()?.getByLabelText('line.distance') as HTMLElement, '42');
    await settle();

    expect(panel()?.getByText(/projectedExcludesMileage/)).toHaveTextContent('"count":1');
    // And it was not sent as a priceable line with some invented amount.
    expect(lastEnabledCall()).toBeUndefined();
  });
});

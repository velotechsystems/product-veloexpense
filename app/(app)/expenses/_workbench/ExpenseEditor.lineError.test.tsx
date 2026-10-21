import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * A refused line-item save keeps the row and says why.
 *
 * The reported symptom was a whole line "disappearing". `removeDraft` ran
 * synchronously right after `mutate()` — before the write was known — and the
 * mutation had an `onSuccess` but no `onError`, so a rejection discarded the row,
 * the typed values, and the reason all at once. Adding a Travel - Mileage line as a
 * traveller with no country did exactly that: the server answered with a precise
 * PRECONDITION_FAILED ("No country on the traveller — cannot resolve a mileage
 * rate.") and the user saw a silent vanish.
 *
 * Mounted through the real ExpenseEditor rather than the child form, because the
 * defect was in the wiring — which callback removes the draft — and a test of the
 * presentational form alone would have passed both before and after the fix.
 */

const h = vi.hoisted(() => ({
  /** Captures the per-call callbacks ExpenseEditor hands to `mutate()`. */
  create: { calls: [] as { vars: unknown; opts: MutOpts }[] },
}));

type MutOpts = { onSuccess?: () => void; onError?: (e: { message: string }) => void };

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  // Every procedure this component tree touches answers the same shape; only
  // lineItemCreate needs to be observable. A proxy keeps the mock from having to
  // track the router surface as it grows.
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: () =>
      name === 'lineItemCreate'
        ? {
            isPending: false,
            mutate: (vars: unknown, opts: MutOpts) => h.create.calls.push({ vars, opts }),
          }
        : { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return {
    trpc: {
      expenses: router,
      // MileageFields renders the route picker off this one.
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
  merchant: 'Personal vehicle',
  date: new Date('2026-08-01').toISOString(),
  amountMinor: '0',
  currency: { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 },
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

/** The open draft row. The editor has its own comboboxes (currency, dimensions), so
 *  every query is scoped to this container or it matches the wrong control. */
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

/** Open a draft row and drive it to the point of saving a mileage line. */
async function saveAMileageLine(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'drawer.addLine' }));
  const row = draftRow();
  if (!row) throw new Error('no draft row opened');
  await user.click(row.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: /Travel - Mileage/ }));
  await user.type(draftRow()?.getByLabelText('line.distance') as HTMLElement, '42');
  await user.click(screen.getByRole('button', { name: 'addLine.save' }));
}

beforeEach(() => {
  h.create.calls = [];
});

describe('a line-item create that the server refuses', () => {
  it('keeps the row, shows the message, and does not lose the distance', async () => {
    const user = userEvent.setup();
    setup();
    await saveAMileageLine(user);

    expect(h.create.calls).toHaveLength(1);
    const { vars, opts } = h.create.calls[0];
    expect(vars).toMatchObject({ expenseId: 'exp-1', categoryId: 'cat-mileage' });

    // The server's refusal, delivered the way tRPC delivers it.
    await act(async () => {
      opts.onError?.({ message: 'No country on the traveller — cannot resolve a mileage rate.' });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('No country on the traveller');
    // Still one draft row, still holding what was typed — the whole point.
    expect(screen.getByRole('button', { name: 'addLine.save' })).toBeInTheDocument();
    expect(draftRow()?.getByLabelText('line.distance')).toHaveValue('42');
  });

  it('clears the message when the retry succeeds, and only then drops the row', async () => {
    const user = userEvent.setup();
    setup();
    await saveAMileageLine(user);
    await act(async () => {
      h.create.calls[0].opts.onError?.({ message: 'No country on the traveller' });
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // Retry: pressing save again clears the stale message before re-issuing.
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    expect(h.create.calls).toHaveLength(2);
    await act(async () => {
      h.create.calls[1].opts.onSuccess?.();
    });
    expect(screen.queryByRole('button', { name: 'addLine.save' })).not.toBeInTheDocument();
  });

  it('drops the row on success without ever showing an error', async () => {
    const user = userEvent.setup();
    setup();
    await saveAMileageLine(user);
    await act(async () => {
      h.create.calls[0].opts.onSuccess?.();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'addLine.save' })).not.toBeInTheDocument();
  });
});

/**
 * A money field cannot be typed full of prose, and an amount that cannot be converted says
 * so instead of dropping the write.
 *
 * The audit typed `abc<b>x</b>` into a `$` field and it was accepted (GA readiness report
 * F06). The only consequence was a save that never happened — `commit` returned silently on an
 * unconvertible value — so the typed characters sat there looking exactly like a saved amount
 * until an unrelated refetch replaced them.
 */

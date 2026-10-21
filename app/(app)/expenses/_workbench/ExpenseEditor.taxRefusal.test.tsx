import '@testing-library/jest-dom/vitest';
import { type Catalog, loadCatalog } from '@expenseos/i18n';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * A refused tax edit is SAID, in the reader's language, and the field goes back to what
 * the server holds.
 *
 * The server bounds paid tax by the gross (#506): $5,000 of GST on a $113.98 lunch is
 * refused at entry. Before this panel wired `onError`, the refusal was silent — the typed
 * figure stayed in the box, the stored figure stayed what it was, and nothing on screen
 * said the two differed. The reader saw 5000.00, the approver would have seen 13.00.
 *
 * REAL next-intl, REAL catalogs, unlike the sibling suites that stub `t` to echo its key.
 * The point under test is the sentence itself: that the server's `data.refusal` key
 * resolves to English for an `en` reader and to French for an `fr-CA` one, from the
 * catalogs as shipped. An echoing stub would pass with the key misspelled in both.
 */

const h = vi.hoisted(() => ({
  /** Mutation arguments, keyed by procedure name. */
  calls: {} as Record<string, unknown[]>,
  /** What `expenseTaxUpdate` should fail with, if anything. */
  refuse: null as null | { message: string; data: unknown },
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
    useMutation: (opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        if (name === 'expenseTaxUpdate' && h.refuse) {
          opts?.onError?.(Object.assign(new Error(h.refuse.message), { data: h.refuse.data }));
        } else {
          opts?.onSuccess?.();
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

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const expense = (over: Record<string, unknown> = {}) =>
  ({
    id: 'exp-1',
    merchant: 'Corner Bistro',
    date: new Date('2026-08-01T00:00:00Z').toISOString(),
    amountMinor: '11398',
    currencyId: 'cur-cad',
    currency: CAD,
    placeText: null,
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [
      {
        id: 'line-1',
        categoryId: 'cat-meals',
        category: { id: 'cat-meals', label: 'Travel - Meals', icon: null, isMileage: false },
        amountMinor: '11398',
        mileageDistance: null,
        mileageUnit: null,
        mileageRoute: null,
        receipts: [],
        kind: 'STANDARD',
        payload: null,
      },
    ],
    receipts: [],
    attendees: [],
    allocations: [],
    taxGstHstMinor: '1300',
    taxQstMinor: null,
    taxPstMinor: null,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'MANUAL',
    subtotalMinor: null,
    fxRate: null,
    ...over,
  }) as never;

const catalogs: Record<string, Catalog> = {};
beforeAll(async () => {
  catalogs[CATALOG_LOCALE] = await loadCatalog(CATALOG_LOCALE);
  catalogs['fr-CA'] = await loadCatalog('fr-CA');
});

function show(locale: string) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={catalogs[locale] as never}
      timeZone="UTC"
      onError={() => {}}
    >
      <ExpenseEditor
        expense={expense()}
        violations={[]}
        currencySymbol="$"
        editable
        categoryItems={[{ value: 'cat-meals', label: 'Travel - Meals', acceptsTip: true }]}
        locale={locale}
        onChange={vi.fn()}
        entityRecovers
      />
    </NextIntlClientProvider>,
  );
}

/** The GST field, by its real label in the locale under test. A regex, because the
 *  label element also wraps the input and its currency symbol, so its text is not
 *  exactly the caption. */
const gstField = (locale: string) => {
  const caption = (catalogs[locale].expenses as { line: { gst: string } }).line.gst;
  return screen.getByLabelText(new RegExp(caption.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
};

/** What the server sends back for $5,000 of GST on the $113.98 line. */
const OVER_TAXED = {
  message:
    'Tax of 5000.00 CAD exceeds the expense amount of 113.98 CAD. Tax cannot be more than what was paid.',
  data: {
    refusal: {
      key: 'refusals.expenses.taxExceedsAmount',
      params: { tax: '5000.00 CAD', amount: '113.98 CAD' },
    },
  },
};

beforeEach(() => {
  h.calls = {};
  h.refuse = null;
});
afterEach(cleanup);

describe('a refused tax edit', () => {
  it('says why, in English, beside the fields — and puts the saved figure back', async () => {
    const user = userEvent.setup();
    h.refuse = OVER_TAXED;
    show(CATALOG_LOCALE);
    const gst = gstField(CATALOG_LOCALE);
    expect(gst).toHaveValue('13.00');

    await user.clear(gst);
    await user.type(gst, '5000.00');
    await user.tab();

    expect(h.calls.expenseTaxUpdate?.at(-1)).toMatchObject({ taxGstHstMinor: '500000' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tax of 5000.00 CAD exceeds the expense amount of 113.98 CAD. Tax cannot be more than what was paid.',
    );
    // The refused figure is not left in the box looking saved.
    expect(gst).toHaveValue('13.00');
  });

  it('says it in French to an fr-CA reader, from the same server error', async () => {
    const user = userEvent.setup();
    h.refuse = OVER_TAXED;
    show('fr-CA');
    const gst = gstField('fr-CA');
    await user.clear(gst);
    await user.type(gst, '5000,00');
    await user.tab();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'La taxe de 5000.00 CAD dépasse le montant de la dépense, soit 113.98 CAD. La taxe ne peut pas excéder ce qui a été payé.',
    );
    // Not the English sentence the server also sent.
    expect(screen.getByRole('alert')).not.toHaveTextContent(/exceeds/);
  });

  it('clears the reason once a later edit is accepted', async () => {
    const user = userEvent.setup();
    h.refuse = OVER_TAXED;
    show(CATALOG_LOCALE);
    const gst = gstField(CATALOG_LOCALE);
    await user.clear(gst);
    await user.type(gst, '5000.00');
    await user.tab();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    h.refuse = null;
    await user.clear(gst);
    await user.type(gst, '12.00');
    await user.tab();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('puts the refusal beside a field a phone can reach', async () => {
    /**
     * The tax inputs used to sit in a `hidden lg:contents` cloak, so nothing below `lg`
     * could produce a refusal. They now render at every width on a draft, so a phone can,
     * and neither the alert nor the field it refuses may have an ancestor that hides it at
     * some width. jsdom applies no CSS: this pins the classes, not what is painted.
     */
    const user = userEvent.setup();
    h.refuse = OVER_TAXED;
    show('en');
    const gst = gstField('en');
    await user.clear(gst);
    await user.type(gst, '5000.00');
    await user.tab();

    for (const el of [screen.getByRole('alert'), gst]) {
      expect(el.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
      expect(el.closest('.hidden')).toBeNull();
    }
  });

  it('falls back to the English sentence for a refusal the catalog has no key for', async () => {
    // An older guard, or a key not yet written: the message is still better than nothing.
    const user = userEvent.setup();
    h.refuse = {
      message: 'Report is not editable.',
      data: { refusal: { key: 'refusals.expenses.notYetWritten' } },
    };
    show('fr-CA');
    const gst = gstField('fr-CA');
    await user.clear(gst);
    await user.type(gst, '1,00');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('Report is not editable.');
  });
});

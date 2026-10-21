import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's combobox is an <input placeholder>; the kit's is a button.
import { getAllComboboxesByPlaceholder, getComboboxByPlaceholder } from '@/test-utils/kitCombobox';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The expense workbench's editor panels — the header, the cost allocation, and the
 * expense-level tax.
 *
 * This is the screen somebody files a claim on, so the failures are all of the "the
 * number was wrong and nobody could tell" kind. Three rules carry most of the weight:
 *
 *   · **An allocation is persisted only when it is COMPLETE and BALANCED.** Saving a
 *     half-picked split would post spend to a dimension nobody chose, and saving one
 *     that totals 90% would silently drop a tenth of the charge out of the GL. So the
 *     editor holds the rows locally and writes only when every row has BU + Department
 *     + Class and the percentages make 100.
 *   · **There is no synthetic "No Class".** The list is the tenant's classes and nothing
 *     else. A tenant that posts to a "no class" bucket has a REAL NetSuite Class record
 *     for it — DEV's is named exactly "No Class" — so picking it sends an id NetSuite
 *     accepts, rather than sending nothing for NetSuite to refuse.
 *   · **The tax panel re-syncs from the server, but never while somebody is typing.**
 *     Extraction fills the tax from the receipt moments after upload; a re-sync landing
 *     mid-keystroke would overwrite what the person was correcting.
 */

type Calls = Record<string, unknown[]>;

const h = vi.hoisted(() => ({
  /** Mutation arguments, keyed by procedure name. */
  calls: {} as Calls,
  /** Query data, keyed by procedure name. */
  queries: {} as Record<string, unknown>,
  /** Procedures whose mutate should report a failure. */
  errors: {} as Record<string, string>,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    // `ViolationLine` asks whether a policy label exists before falling back to the
    // server's message; `false` is the honest stub, since these keys are not in the
    // catalog under test.
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({
      data: h.queries[name],
      isLoading: false,
      isFetching: false,
      error: null,
    }),
    // Both callback sites get `(result, vars)` / `(error, vars)`, as react-query passes them.
    useMutation: (opts?: {
      onSuccess?: (d: unknown, v: unknown) => void;
      onError?: (e: Error, v: unknown) => void;
    }) => ({
      isPending: false,
      mutate: (
        vars: unknown,
        perCall?: { onSuccess?: () => void; onError?: (e: Error) => void },
      ) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const msg = h.errors[name];
        if (msg) {
          opts?.onError?.(new Error(msg), vars);
          perCall?.onError?.(new Error(msg));
        } else {
          opts?.onSuccess?.(undefined, vars);
          perCall?.onSuccess?.();
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

const CATEGORIES = [
  { value: 'cat-meals', label: 'Travel - Meals', acceptsTip: true },
  { value: 'cat-taxi', label: 'Travel - Ground' },
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

const expense = (over: Record<string, unknown> = {}) =>
  ({
    id: 'exp-1',
    merchant: 'Corner Bistro',
    date: new Date('2026-08-01T00:00:00Z').toISOString(),
    amountMinor: '11500',
    currencyId: 'cur-cad',
    currency: CAD,
    placeText: null,
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [line()],
    receipts: [],
    attendees: [],
    allocations: [],
    taxGstHstMinor: null,
    taxQstMinor: null,
    taxPstMinor: null,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'CALCULATED',
    subtotalMinor: null,
    fxRate: null,
    ...over,
  }) as never;

const DIMENSIONS = {
  businessUnits: [
    { id: 'bu-1', label: { en: 'Atlantic' } },
    { id: 'bu-2', label: { en: 'Pacific' } },
  ],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  classes: [
    { id: 'cls-1', name: 'Internal' },
    // A tenant's REAL "no class" record. Indistinguishable from any other class here,
    // which is the point — it posts.
    { id: 'cls-none', name: 'No Class' },
  ],
};

function renderEditor(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return render(
    <ExpenseEditor
      expense={expense(over)}
      violations={[]}
      currencySymbol="$"
      editable
      categoryItems={CATEGORIES}
      locale={CATALOG_LOCALE}
      onChange={vi.fn()}
      entityRecovers
      {...props}
    />,
  );
}

/** The arguments a procedure was called with, in order. */
const sent = (name: string) => (h.calls[name] ?? []) as Record<string, unknown>[];

/** Pick an option out of a Base UI combobox by its visible label. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  placeholder: string,
  option: string | RegExp,
) {
  // VeloExpense: the kit Combobox's trigger, by its placeholder (test-utils/kitCombobox).
  await user.click(getComboboxByPlaceholder(placeholder));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  h.calls = {};
  h.errors = {};
  h.queries = {
    dimensionOptions: DIMENSIONS,
    currencies: [
      { id: 'cur-cad', code: 'CAD' },
      { id: 'cur-usd', code: 'USD' },
    ],
  };
});

// ── The header ────────────────────────────────────────────────────────────────

describe('the expense header', () => {
  it('names the vendor, and says so plainly when there is none', () => {
    // A blank title bar reads as a loading state on a row that has finished loading.
    renderEditor();
    // Scoped to the header bar, because the read-only field grid below now renders on a
    // DRAFT report as well (CSS-hidden above `lg`) and repeats the vendor as prose — and
    // jsdom applies no CSS, so it sees both faces at every width.
    expect(
      within(screen.getByTestId('expense-header')).getByText('Corner Bistro'),
    ).toBeInTheDocument();

    cleanup();
    renderEditor({ merchant: '   ' });
    expect(
      within(screen.getByTestId('expense-header')).getByText('line.noMerchant'),
    ).toBeInTheDocument();
  });

  it('shows the total with its currency code beside it', () => {
    /**
     * The code is not decoration: a report can hold expenses in several currencies, and
     * "115.00" beside "115.00" with one of them being USD is how a claim gets approved
     * for the wrong amount.
     */
    renderEditor();
    // Header-scoped for the same reason as above: the read-only field grid repeats the
    // currency code and the read-only line row repeats the amount, both CSS-hidden at a
    // desktop width and both visible to jsdom.
    const header = within(screen.getByTestId('expense-header'));
    expect(header.getByText('CAD')).toBeInTheDocument();
    expect(header.getByText('$115.00')).toBeInTheDocument();
  });

  it('shows the extraction confidence only when a receipt was read', () => {
    // Absent is honest for a hand-entered expense; a "0%" badge would not be.
    renderEditor();
    expect(screen.queryByText(/aiConfidence/)).not.toBeInTheDocument();

    cleanup();
    // A real EXTRACTED row. The fixture used to carry `confidence` alone, which is not a
    // state `receiptState` recognises — so it asserted the badge for a shape the server
    // never sends.
    renderEditor({
      receipts: [
        {
          id: 'r1',
          extraction: { scanStatus: 'CLEAN', status: 'EXTRACTED', confidence: 0.876 },
        },
      ],
    });
    expect(screen.getByText('line.aiConfidence:88')).toBeInTheDocument();
  });

  it('does not badge a FAILED extraction with a percentage', () => {
    /**
     * A failed extraction still writes a row, and its confidence is 0 — so the header
     * badged the failure "AI: 0%", which reads as an extraction that ran and was certain
     * of nothing rather than one that produced nothing at all (GA readiness report F10).
     */
    renderEditor({
      receipts: [
        { id: 'r1', extraction: { scanStatus: 'CLEAN', status: 'FAILED', confidence: 0 } },
      ],
    });
    expect(screen.queryByText(/aiConfidence/)).not.toBeInTheDocument();
  });

  it('offers delete only to somebody who may edit', async () => {
    const user = userEvent.setup();
    renderEditor();
    // The first one is the header's; each line row carries its own.
    await user.click(screen.getAllByRole('button', { name: 'actions.delete' })[0]);
    expect(sent('deleteExpense')[0]).toEqual({ expenseId: 'exp-1' });
  });

  it('hides every control on a filed report', () => {
    /**
     * The read-only view is not a disabled copy of the editor — it is a different
     * layout. What matters is that nothing here can write, because the report is in
     * somebody else's hands.
     */
    renderEditor({ placeText: 'Montréal, QC', explanation: 'Client dinner' }, { editable: false });
    expect(screen.queryByRole('button', { name: 'actions.delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // …and the facts are still all readable.
    expect(screen.getByText(/Montréal, QC/)).toBeInTheDocument();
    expect(screen.getByText(/Client dinner/)).toBeInTheDocument();
    expect(screen.getByText(/8\/1\/2026/)).toBeInTheDocument();
  });

  it('omits an empty location and explanation from the read-only view', () => {
    // Rather than rendering a label with nothing after it.
    renderEditor({}, { editable: false });
    expect(screen.queryByText(/line.location/)).not.toBeInTheDocument();
    expect(screen.queryByText(/drawer.explanation/)).not.toBeInTheDocument();
  });

  it('covers the editor while a receipt is still being processed', () => {
    /**
     * The lock exists so the fields do not fight the incoming extraction: somebody
     * typing a total that extraction is about to overwrite loses their edit and has no
     * idea why.
     */
    renderEditor({}, { locked: true });
    expect(screen.getByText('workbench.processingReceipt')).toBeInTheDocument();
  });

  it('saves the date, vendor and location on blur', async () => {
    const user = userEvent.setup();
    renderEditor();

    const vendor = screen.getByPlaceholderText('addLine.merchantPlaceholder');
    await user.clear(vendor);
    await user.type(vendor, 'Chez Ada');
    await user.tab();

    expect(sent('updateExpense')).toContainEqual({ expenseId: 'exp-1', merchant: 'Chez Ada' });
  });

  it('clears a field to null rather than to an empty string', async () => {
    // An empty string in `merchant` renders as a vendor whose name is nothing; null is
    // what "no vendor" means, and what the noMerchant fallback keys on.
    const user = userEvent.setup();
    renderEditor();
    const vendor = screen.getByPlaceholderText('addLine.merchantPlaceholder');
    await user.clear(vendor);
    await user.tab();
    expect(sent('updateExpense')).toContainEqual({ expenseId: 'exp-1', merchant: null });
  });

  it('ignores a cleared date instead of writing an invalid one', async () => {
    /**
     * `date` is not nullable — an expense with no date cannot be placed in a period, so
     * a cleared field is a no-op rather than a write that the server would reject with
     * something unhelpful.
     */
    const user = userEvent.setup();
    renderEditor();
    const date = screen.getByDisplayValue('2026-08-01');
    await user.clear(date);
    await user.tab();
    expect(sent('updateExpense').filter((c) => 'date' in c)).toHaveLength(0);
  });

  it('says why a date was refused, and puts the field back to the saved one', async () => {
    // Moving the date reprices mileage, and a date with no rate in force is refused whole.
    // The refusal used to be silent, with the unsaved date left showing in the field.
    h.errors.updateExpense = 'No mileage rate in force for CA on this date.';
    const user = userEvent.setup();
    renderEditor();
    const date = screen.getByDisplayValue('2026-08-01');
    fireEvent.change(date, { target: { value: '2025-01-15' } });
    await user.click(document.body);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No mileage rate in force for CA on this date.',
    );
    expect(screen.getByDisplayValue('2026-08-01')).toBeInTheDocument();
  });

  it('saves a date chosen from the calendar, which never focuses the input', async () => {
    /**
     * The calendar icon is `Input`'s own suffix button: it calls `showPicker()` and takes
     * the click itself, so the `<input>` is never focused and never blurs. A date picked
     * from the popup fired `change` and nothing else, the save hung off `onBlur`, and the
     * expense stayed on the day it was created — today, for a "+" expense.
     *
     * VeloExpense: the kit's `Input` has no suffix button, so the case drives what it
     * leads to directly — a `change` on the date field while it does not have focus.
     */
    const user = userEvent.setup();
    renderEditor();
    const date = screen.getByDisplayValue('2026-08-01');
    expect(date).not.toHaveFocus();
    fireEvent.change(date, { target: { value: '2026-07-15' } });
    await user.click(document.body);
    expect(sent('updateExpense')).toContainEqual({ expenseId: 'exp-1', date: '2026-07-15' });
  });

  it('saves a typed date once, on blur, not on every segment', async () => {
    // Typing fires `change` per completed segment (`0002-…`, `0020-…`); only the
    // finished value may be written.
    const user = userEvent.setup();
    renderEditor();
    const date = screen.getByDisplayValue('2026-08-01');
    date.focus();
    fireEvent.change(date, { target: { value: '0002-07-15' } });
    fireEvent.change(date, { target: { value: '2026-07-15' } });
    expect(sent('updateExpense').filter((c) => 'date' in c)).toHaveLength(0);
    await user.tab();
    expect(sent('updateExpense').filter((c) => 'date' in c)).toEqual([
      { expenseId: 'exp-1', date: '2026-07-15' },
    ]);
  });

  it('changes the currency from the picker', async () => {
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'line.currency', 'USD');
    expect(sent('updateExpense')).toContainEqual({ expenseId: 'exp-1', currencyId: 'cur-usd' });
  });
});

// ── Violations + the explanation gate ─────────────────────────────────────────

describe('violations', () => {
  const warning = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    ruleCode: 'RECEIPT_REQUIRED',
    severity: 'WARNING',
    message: 'A receipt is required over $25.',
    data: null,
    lineItemId: null,
    ...over,
  });

  it('lists them above the fields, grouped', () => {
    renderEditor({}, { violations: [warning(), warning({ id: 'v2' })] });
    expect(screen.getByText('drawer.expenseWarnings')).toBeInTheDocument();
    // Two identical findings read as one line with a count, not as two lines.
    expect(screen.getAllByText(/A receipt is required/)).toHaveLength(1);
  });

  it('makes the explanation required while a warning stands', async () => {
    /**
     * The submit gate blocks on an unjustified warning, and a non-empty explanation is
     * what justifies it server-side. Marking the field is the only thing telling
     * somebody why they cannot submit.
     */
    renderEditor({}, { violations: [warning()] });
    const box = screen.getByPlaceholderText('drawer.explanationPlaceholder');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('drawer.explanationRequired')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(box, 'Receipt lost in transit');
    expect(box).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText('drawer.explanationRequired')).not.toBeInTheDocument();
  });

  it('does not require one for an INFO finding', () => {
    // Informational findings are not exceptions and need no justification.
    renderEditor({}, { violations: [warning({ severity: 'INFO' })] });
    expect(screen.getByPlaceholderText('drawer.explanationPlaceholder')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
  });

  it('treats whitespace as no explanation at all', () => {
    renderEditor({ explanation: '   ' }, { violations: [warning()] });
    expect(screen.getByText('drawer.explanationRequired')).toBeInTheDocument();
  });

  it('saves the explanation on blur, and nulls it when emptied', async () => {
    const user = userEvent.setup();
    renderEditor({ explanation: 'Client dinner' });
    const box = screen.getByPlaceholderText('drawer.explanationPlaceholder');
    await user.clear(box);
    await user.tab();
    expect(sent('updateExpense')).toContainEqual({ expenseId: 'exp-1', explanation: null });
  });
});

// ── Cost allocation ───────────────────────────────────────────────────────────

describe('the cost allocation', () => {
  const pct = () => screen.getByLabelText('allocation.percent');

  it('starts at one 100% row, because there is no unallocated state', () => {
    /**
     * Every expense is coded somewhere. Starting empty would make "not yet allocated"
     * a state the GL has to have an opinion about.
     */
    renderEditor();
    expect(pct()).toHaveValue('100');
    expect(screen.getByText('100% / 100%')).toBeInTheDocument();
  });

  it('does not nag a row nobody has touched', () => {
    // A fresh expense showing three required-field warnings before the person has
    // engaged with the allocation at all is noise on every single expense.
    renderEditor();
    expect(screen.queryByText('allocation.required')).not.toBeInTheDocument();
  });

  it('flags an incomplete row once any dimension is picked', async () => {
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'allocation.businessUnit', 'Atlantic');
    expect(await screen.findByText('allocation.required')).toBeInTheDocument();
    // …and nothing was written, because the row is not codeable yet.
    expect(sent('allocationSet')).toHaveLength(0);
  });

  it('persists once every dimension is picked and the split balances', async () => {
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'allocation.businessUnit', 'Atlantic');
    await pick(user, 'allocation.department', 'Engineering');
    await pick(user, 'allocation.class', 'Internal');

    expect(sent('allocationSet')).toHaveLength(1);
    expect(sent('allocationSet')[0]).toEqual({
      expenseId: 'exp-1',
      allocations: [
        { percentBp: 10000, businessUnitId: 'bu-1', departmentId: 'dep-1', classId: 'cls-1' },
      ],
    });
  });

  it('offers no synthetic class option that resolves to null', async () => {
    /**
     * The editor used to prepend a "No Class" entry that saved a null `classId`, so
     * "I want no class" and "the payload carries no class" were the same click — and the
     * second is what NetSuite refuses with "Please enter value(s) for: Class".
     */
    const user = userEvent.setup();
    renderEditor();
    await user.click(getComboboxByPlaceholder('allocation.class'));

    // Exactly the tenant's classes — nothing prepended.
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Internal', 'No Class']);
  });

  it('sends a real class id when the tenant has its own "No Class" record', async () => {
    // The behaviour that replaces the sentinel: the row is complete and the id posts.
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'allocation.businessUnit', 'Atlantic');
    await pick(user, 'allocation.department', 'Engineering');
    await pick(user, 'allocation.class', 'No Class');

    expect(sent('allocationSet')[0]).toMatchObject({
      allocations: [expect.objectContaining({ classId: 'cls-none' })],
    });
    // Emphatically NOT null — that is the state NetSuite rejects.
    expect(sent('allocationSet')[0]).not.toMatchObject({
      allocations: [expect.objectContaining({ classId: null })],
    });
    expect(screen.queryByText('allocation.required')).not.toBeInTheDocument();
  });

  it('writes nothing while the percentages do not make 100', async () => {
    /**
     * The one with money in it. A 90% split silently drops a tenth of the charge out
     * of the GL, and nothing downstream would flag a report whose allocations simply
     * do not add up.
     */
    const user = userEvent.setup();
    renderEditor({
      allocations: [
        {
          id: 'a1',
          percentBp: 10000,
          businessUnitId: 'bu-1',
          departmentId: 'dep-1',
          classId: 'cls-1',
          businessUnit: { label: { en: 'Atlantic' } },
          department: { label: { en: 'Engineering' } },
          class: { name: 'Internal' },
        },
      ],
    });

    await user.clear(pct());
    await user.type(pct(), '90');
    await user.tab();

    expect(sent('allocationSet')).toHaveLength(0);
    expect(screen.getByText('90% / 100%')).toBeInTheDocument();
  });

  it('splits across two rows that together make 100', async () => {
    const user = userEvent.setup();
    renderEditor({
      allocations: [
        {
          id: 'a1',
          percentBp: 10000,
          businessUnitId: 'bu-1',
          departmentId: 'dep-1',
          classId: 'cls-1',
          businessUnit: { label: { en: 'Atlantic' } },
          department: { label: { en: 'Engineering' } },
          class: { name: 'Internal' },
        },
      ],
    });

    await user.clear(pct());
    await user.type(pct(), '60');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /allocation.add/ }));

    const percents = screen.getAllByLabelText('allocation.percent');
    await user.type(percents[1], '40');
    await user.tab();
    // The new row still has no dimensions, so nothing is written yet.
    expect(sent('allocationSet')).toHaveLength(0);

    const rows = getAllComboboxesByPlaceholder('allocation.businessUnit');
    await user.click(rows[1]);
    await user.click(await screen.findByRole('option', { name: 'Pacific' }));
    await user.click(getAllComboboxesByPlaceholder('allocation.department')[1]);
    await user.click(await screen.findByRole('option', { name: 'Engineering' }));
    await user.click(getAllComboboxesByPlaceholder('allocation.class')[1]);
    await user.click(await screen.findByRole('option', { name: 'Internal' }));

    expect(sent('allocationSet')[0]).toMatchObject({
      allocations: [
        expect.objectContaining({ percentBp: 6000, businessUnitId: 'bu-1' }),
        expect.objectContaining({ percentBp: 4000, businessUnitId: 'bu-2' }),
      ],
    });
  });

  it('keeps the base row unremovable', () => {
    // Removing the last row would leave an expense allocated to nothing.
    renderEditor();
    expect(screen.queryByRole('button', { name: 'allocation.remove' })).not.toBeInTheDocument();
  });

  it('removes an added row, and re-persists what is left', async () => {
    const user = userEvent.setup();
    renderEditor({
      allocations: [
        {
          id: 'a1',
          percentBp: 10000,
          businessUnitId: 'bu-1',
          departmentId: 'dep-1',
          classId: 'cls-1',
          businessUnit: { label: { en: 'Atlantic' } },
          department: { label: { en: 'Engineering' } },
          class: { name: 'Internal' },
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: /allocation.add/ }));
    expect(screen.getAllByLabelText('allocation.percent')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: 'allocation.remove' })[1]);
    expect(screen.getAllByLabelText('allocation.percent')).toHaveLength(1);
    // Back to a complete, balanced single row → written.
    expect(sent('allocationSet')[0]).toMatchObject({
      allocations: [expect.objectContaining({ percentBp: 10000 })],
    });
  });

  it('treats an unparseable percentage as zero rather than NaN', async () => {
    // The field is free text; `NaN` basis points would be written to the column.
    const user = userEvent.setup();
    renderEditor();
    await user.clear(pct());
    await user.type(pct(), 'half');
    await user.tab();
    expect(screen.getByText('0% / 100%')).toBeInTheDocument();
    expect(sent('allocationSet')).toHaveLength(0);
  });

  it('reads a legacy null class back as unpicked, and flags it', () => {
    /**
     * Rows saved while the sentinel existed carry a null `classId`. There is no longer an
     * option that means "null", so such a row reads back with the class UNPICKED and is
     * flagged as required — which is honest, because blank is the state NetSuite rejects,
     * and it is the only prompt that gets the row coded before it posts.
     */
    renderEditor({
      allocations: [
        {
          id: 'a1',
          percentBp: 7500,
          businessUnitId: 'bu-1',
          departmentId: 'dep-1',
          classId: null,
          businessUnit: { label: { en: 'Atlantic' } },
          department: { label: { en: 'Engineering' } },
          class: null,
        },
      ],
    });
    expect(screen.getByLabelText('allocation.percent')).toHaveValue('75');
    expect(getComboboxByPlaceholder('allocation.class')).toHaveValue('');
    expect(screen.getByText('allocation.required')).toBeInTheDocument();
  });

  it('renders the saved split as plain text on a filed report', () => {
    renderEditor(
      {
        allocations: [
          {
            id: 'a1',
            percentBp: 6000,
            businessUnitId: 'bu-1',
            departmentId: 'dep-1',
            classId: 'cls-1',
            businessUnit: { label: { en: 'Atlantic' } },
            department: { label: { en: 'Engineering' } },
            class: { name: 'Internal' },
          },
        ],
      },
      { editable: false },
    );
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('Atlantic · Engineering · Internal')).toBeInTheDocument();
  });

  it('names a NetSuite-only business unit on a filed report, rather than a dash', () => {
    /**
     * Under the NETSUITE source a line coded to a NetSuite business unit with no reverse
     * admin alias is saved with `businessUnitId = null`. The server hands the label it
     * picked as `nsBusinessUnitLabel`; the approver reads the unit, not "— · dept · class".
     */
    renderEditor(
      {
        allocations: [
          {
            id: 'a1',
            percentBp: 10000,
            businessUnitId: null,
            departmentId: 'dep-1',
            classId: 'cls-1',
            businessUnit: null,
            nsBusinessUnitLabel: 'Pacific Operations',
            department: { label: { en: 'Engineering' } },
            class: { name: 'Internal' },
          },
        ],
      },
      { editable: false },
    );
    expect(screen.getByText('Pacific Operations · Engineering · Internal')).toBeInTheDocument();
  });

  it('names the admin business unit, unchanged, when the server sends no NetSuite label', () => {
    // EXPENSEOS: `nsBusinessUnitLabel` is always null and the text is today's, byte for byte.
    renderEditor(
      {
        allocations: [
          {
            id: 'a1',
            percentBp: 10000,
            businessUnitId: 'bu-1',
            departmentId: 'dep-1',
            classId: 'cls-1',
            businessUnit: { label: { en: 'Atlantic' } },
            nsBusinessUnitLabel: null,
            department: { label: { en: 'Engineering' } },
            class: { name: 'Internal' },
          },
        ],
      },
      { editable: false },
    );
    expect(screen.getByText('Atlantic · Engineering · Internal')).toBeInTheDocument();
  });

  it('says an uncoded expense is uncoded, on a filed report', () => {
    /**
     * This asserted the opposite — "shows nothing at all", on the reasoning that an
     * empty allocation card is a card that says nothing. But nothing is not what a
     * reader concludes from it: hiding the block reads as "this expense has no
     * allocation section", not as "this expense is not coded", and the person looking
     * at a filed report is the APPROVER — the last one able to catch it before blank
     * coding reaches NetSuite and is rejected there (GA readiness report F17).
     */
    renderEditor({}, { editable: false });
    expect(screen.getByText('allocation.heading')).toBeInTheDocument();
    expect(screen.getByText('allocation.none')).toBeInTheDocument();
  });

  it('shows an em dash for a saved row whose dimensions were all deleted', () => {
    renderEditor(
      {
        allocations: [
          {
            id: 'a1',
            percentBp: 10000,
            businessUnitId: null,
            departmentId: null,
            classId: null,
            businessUnit: null,
            department: null,
            class: null,
          },
        ],
      },
      { editable: false },
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

// ── Expense-level tax ─────────────────────────────────────────────────────────

describe('the expense tax panel', () => {
  it('shows the recoverable ITC only where the entity can recover it', () => {
    /**
     * A US entity — or any non-registrant — recovers nothing by definition. Showing
     * "$0.00" there is a figure somebody has to interpret; showing nothing says the
     * question does not apply.
     */
    renderEditor({ recoverableGstHstMinor: '650', recoverableQstMinor: '325' });
    expect(screen.getByText('$9.75 CAD')).toBeInTheDocument();

    cleanup();
    renderEditor({ recoverableGstHstMinor: '650' }, { entityRecovers: false });
    expect(screen.queryByText(/workbench.recoverable/)).not.toBeInTheDocument();
  });

  it('writes all three taxes as a manual override on blur', async () => {
    /**
     * There is no source dropdown on purpose: the receipt's extracted tax is the
     * default, and touching the field IS the override. A separate switch is a second
     * thing to get out of step with the numbers.
     */
    const user = userEvent.setup();
    renderEditor();
    const gst = screen.getByLabelText(/line\.gst/);
    await user.type(gst, '13.00');
    await user.tab();

    const call = sent('expenseTaxUpdate').at(-1);
    expect(call).toMatchObject({ expenseId: 'exp-1', taxSource: 'MANUAL', taxGstHstMinor: '1300' });
  });

  it('sends null for a tax that was left blank, not zero', async () => {
    /**
     * Zero means "we looked and there was none"; null means "not applicable". QST on
     * an Ontario receipt is the second, and the difference shows up in the tax report.
     */
    const user = userEvent.setup();
    renderEditor({ taxGstHstMinor: '1300' });
    const gst = screen.getByLabelText(/line\.gst/);
    await user.clear(gst);
    await user.tab();
    expect(sent('expenseTaxUpdate').at(-1)).toMatchObject({
      taxGstHstMinor: null,
      taxQstMinor: null,
      taxPstMinor: null,
    });
  });

  it('re-syncs from the server when extraction fills the tax in', () => {
    // The report is polled; a receipt read moments after upload changes these figures
    // and the panel has to show the new ones.
    const { rerender } = renderEditor();
    rerender(
      <ExpenseEditor
        expense={expense({ taxGstHstMinor: '1300' })}
        violations={[]}
        currencySymbol="$"
        editable
        categoryItems={CATEGORIES}
        locale={CATALOG_LOCALE}
        onChange={vi.fn()}
        entityRecovers
      />,
    );
    expect(screen.getByDisplayValue('13.00')).toBeInTheDocument();
  });

  it('never re-syncs over what somebody is typing', async () => {
    /**
     * The trap: extraction lands mid-keystroke and the correction being typed is
     * replaced by the extractor's answer — the exact figure the person was disagreeing
     * with.
     */
    const user = userEvent.setup();
    const { rerender } = renderEditor();
    const gst = screen.getByLabelText(/line\.gst/);
    await user.click(gst); // focus marks the panel as being edited
    await user.type(gst, '7.25');

    rerender(
      <ExpenseEditor
        expense={expense({ taxGstHstMinor: '1300' })}
        violations={[]}
        currencySymbol="$"
        editable
        categoryItems={CATEGORIES}
        locale={CATALOG_LOCALE}
        onChange={vi.fn()}
        entityRecovers
      />,
    );
    expect(gst).toHaveValue('7.25');
  });

  it('reads the three taxes as text on a filed report, zero-filled', () => {
    // Read-only, and a missing tax reads as $0.00 here because the row is settled —
    // there is nothing left to distinguish "not applicable" from "none".
    renderEditor({ taxGstHstMinor: '1300', taxQstMinor: null }, { editable: false });
    expect(screen.getByText(/line.gst/)).toBeInTheDocument();
    expect(screen.getByText('$13.00 CAD')).toBeInTheDocument();
    expect(screen.getAllByText('$0.00 CAD').length).toBeGreaterThan(0);
  });
});

// ── Line-item rows and drafts ─────────────────────────────────────────────────

describe('line items', () => {
  it('says so plainly when an expense has none', () => {
    renderEditor({ lineItems: [] });
    expect(screen.getByText('drawer.noLines')).toBeInTheDocument();
  });

  it('opens a draft row per press, each independent', async () => {
    /**
     * Several drafts can be open at once and each commits on its own — adding a second
     * line never waits on the first one saving, which is what makes entering a
     * three-line receipt feel like one task.
     */
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
    await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
    // The saved line's own category picker shares the placeholder, so it is 1 + 2.
    expect(getAllComboboxesByPlaceholder('addLine.categoryPlaceholder')).toHaveLength(3);
  });

  it('hides the add button and the drafts from a read-only viewer', () => {
    renderEditor({}, { editable: false });
    expect(screen.queryByRole('button', { name: /drawer.addLine/ })).not.toBeInTheDocument();
  });

  it('shows attendees only when a line’s category requires them', () => {
    /**
     * Meals and entertainment need who was there; a software renewal does not, and an
     * attendee list on every expense is a field everybody learns to skip.
     */
    renderEditor();
    expect(screen.queryByText('drawer.attendees')).not.toBeInTheDocument();

    cleanup();
    renderEditor({
      lineItems: [
        line({
          category: {
            id: 'cat-meals',
            label: 'Travel - Meals',
            icon: null,
            isMileage: false,
            requiresAttendees: true,
          },
        }),
      ],
    });
    expect(screen.getByText('drawer.attendees')).toBeInTheDocument();
  });

  it('mounts the attendees with the prefilled claimant when the requirement first arrives', () => {
    /**
     * The server names the expense owner as the first attendee in the same write that gives
     * the expense its first line in a category requiring attendees, so the claimant arrives in
     * the SAME `expenses.report` refetch as that line. The attendees editor seeds its rows once,
     * on mount, and it mounts only when the requirement flips on — so the refetch that brings
     * the line must mount it with the claimant already in it, not leave an empty list that
     * waits for a second refetch nobody sends. (ExpenseOS 67db2e33, #588.)
     */
    const props = {
      violations: [],
      currencySymbol: '$',
      editable: true,
      categoryItems: CATEGORIES,
      locale: CATALOG_LOCALE,
      onChange: vi.fn(),
      entityRecovers: true,
    };
    const { rerender } = render(<ExpenseEditor expense={expense() as never} {...props} />);
    expect(screen.queryByText('drawer.attendees')).not.toBeInTheDocument();

    rerender(
      <ExpenseEditor
        expense={
          expense({
            lineItems: [
              line({
                category: {
                  id: 'cat-meals',
                  label: 'Travel - Meals',
                  icon: null,
                  isMileage: false,
                  requiresAttendees: true,
                },
              }),
            ],
            attendees: [{ id: 'att-1', name: 'Ada Lovelace', company: null, isExternal: false }],
          }) as never
        }
        {...props}
      />,
    );

    expect(screen.getByText('drawer.attendees')).toBeInTheDocument();
    const row = screen.getByText('Ada Lovelace').parentElement as HTMLElement;
    expect(within(row).getByText('attendee.internal')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'attendee.remove' })).toBeInTheDocument();
    // An internal attendee is display-only: no free-text name field to retype the claimant.
    expect(screen.queryByPlaceholderText('attendee.name')).not.toBeInTheDocument();
  });
});

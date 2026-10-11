import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's combobox is an <input placeholder>; the kit's is a button.
import { getAllComboboxesByPlaceholder, queryComboboxByPlaceholder } from '@/test-utils/kitCombobox';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The workbench's row-level pieces: the left-pane expense row, a saved line item, a
 * draft line, and the attendee editor.
 *
 * The theme across all four is that a figure on screen must never contradict what the
 * server holds:
 *
 *   · **A foreign expense with no FX rate says so.** It is EXCLUDED from the report
 *     total, which is a different fact from converting to zero — and the version this
 *     replaces let an unconverted amount go quietly missing.
 *   · **A category change commits on its own.** It used to be folded into the amount
 *     commit, which silently returned when switching into mileage with no distance yet —
 *     so nothing was written and the row kept showing the old figure.
 *   · **Switching distance unit converts a MEASURED distance and reinterprets a typed
 *     one.** 100 km measured by the route IS 62.14 mi; somebody who typed 100 and
 *     pressed MI meant a hundred miles.
 *   · **A tip field starts BLANK, never "0.00".** The server treats `tip <= 0` as no tip,
 *     and a seeded zero also breaks typing — the first keystroke appends to it.
 */

const h = vi.hoisted(() => ({
  calls: {} as Record<string, unknown[]>,
  errors: {} as Record<string, string>,
  directory: [] as { id: string; name: string; email: string }[],
}));

/** One stable `t`, so memo/effect deps do not churn. */
const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${Object.values(values).join(',')}` : key;
t.has = () => false;

vi.mock('next-intl', () => ({ useTranslations: () => t, useLocale: () => 'en' }));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => {
      if (name === 'attendeeDirectory') return { data: h.directory, isLoading: false };
      return { data: undefined, isLoading: false, isFetching: false, error: null };
    },
    useMutation: (opts?: {
      onSuccess?: () => void;
      onError?: (e: Error) => void;
      onSettled?: () => void;
    }) => ({
      isPending: false,
      // Per-call callbacks matter here: the editor passes `onError` at the CALL site so
      // a failed line create keeps its own row rather than clearing every draft.
      mutate: (
        vars: unknown,
        perCall?: { onSuccess?: () => void; onError?: (e: Error) => void },
      ) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        const msg = h.errors[name];
        if (msg) {
          opts?.onError?.(new Error(msg));
          perCall?.onError?.(new Error(msg));
        } else {
          opts?.onSuccess?.();
          perCall?.onSuccess?.();
        }
        opts?.onSettled?.();
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
  useViewerZoom: () => [1, vi.fn()],
  ZoomControls: () => null,
}));

import { ExpenseEditor, ExpenseListRow } from './parts';

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const CATEGORIES = [
  { value: 'cat-meals', label: 'Meals', acceptsTip: true },
  { value: 'cat-taxi', label: 'Ground' },
  { value: 'cat-mileage', label: 'Mileage', isMileage: true },
];

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  categoryId: 'cat-taxi',
  category: {
    id: 'cat-taxi',
    label: { en: 'Ground' },
    icon: '🚕',
    color: '#2563eb',
    isMileage: false,
  },
  amountMinor: '4500',
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
    merchant: 'City Cab',
    date: new Date('2026-08-01T00:00:00Z').toISOString(),
    amountMinor: '4500',
    currencyId: 'cur-cad',
    currency: CAD,
    homeCurrency: null,
    homeAmountMinor: null,
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

const sent = (name: string) => (h.calls[name] ?? []) as Record<string, unknown>[];

/** Pick a combobox option by its visible label. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  placeholder: string,
  option: string | RegExp,
  index = 0,
) {
  // VeloExpense: the kit Combobox's trigger, by its placeholder (test-utils/kitCombobox).
  const boxes = getAllComboboxesByPlaceholder(placeholder);
  await user.click(boxes[index]);
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  h.calls = {};
  h.errors = {};
  h.directory = [];
});

// ── The left-pane row ─────────────────────────────────────────────────────────

describe('<ExpenseListRow>', () => {
  const row = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) =>
    render(
      <ul>
        <ExpenseListRow
          expense={expense(over)}
          locale={CATALOG_LOCALE}
          active={false}
          violationCount={0}
          onSelect={vi.fn()}
          {...props}
        />
      </ul>,
    );

  it('leads with the date and the vendor', () => {
    row();
    expect(screen.getByText('Aug 1')).toBeInTheDocument();
    expect(screen.getByText('City Cab')).toBeInTheDocument();
  });

  it('wraps a long vendor name instead of cutting it off', () => {
    /**
     * The vendor cell used to be `truncate`. In a pane this narrow that put the ellipsis
     * straight through the identifying part of the name — card feeds and receipt
     * extraction produce things like "SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA",
     * where everything distinguishing sits past the cut.
     *
     * Asserted on the classes rather than on geometry, because jsdom has no layout: there
     * are no real widths here, so nothing can be measured overflowing. What can be pinned
     * is the intent — no `truncate`, and `break-words` so one unbroken token breaks rather
     * than pushing the amount out of the row.
     */
    row({ merchant: 'SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA' });
    const cell = screen.getByText('SQ *THE COFFEE SHOP 4155551234 SAN FRANCISCO CA');
    expect(cell.className).not.toContain('truncate');
    expect(cell.className).toContain('break-words');
  });

  it('formats the date in UTC, so it does not shift a day', () => {
    /**
     * The expense date is a calendar date stored at UTC midnight, and the editor's input
     * reads it back with `toISOString`. Formatting the label in local time moves it a day
     * for anybody behind UTC — the list and the field would disagree.
     */
    row({ date: new Date('2026-08-01T00:00:00Z').toISOString() });
    expect(screen.getByText('Aug 1')).toBeInTheDocument();
  });

  it('says so plainly when there is no vendor yet', () => {
    row({ merchant: null });
    expect(screen.getByText('line.noMerchant')).toBeInTheDocument();
  });

  it('counts unresolved violations, and shows nothing at zero', () => {
    row({}, { violationCount: 3 });
    expect(screen.getByLabelText('line.violation')).toHaveTextContent('3');

    cleanup();
    row();
    expect(screen.queryByLabelText('line.violation')).not.toBeInTheDocument();
  });

  it('shows the home-currency equivalent for a foreign expense', () => {
    row({
      currency: { id: 'cur-usd', code: 'USD', symbol: '$', exponent: 2 },
      amountMinor: '10000',
      homeCurrency: 'CAD',
      homeAmountMinor: '13700',
      fxRate: '1.37',
    });
    expect(screen.getByText('≈ 137.00 CAD')).toBeInTheDocument();
  });

  it('says a rate is MISSING rather than converting to nothing', () => {
    /**
     * The expense is excluded from the report total when there is no rate. Rendering it
     * as zero — or omitting the line — is how a foreign charge goes quietly missing,
     * which is the failure this replaces.
     */
    row({
      currency: { id: 'cur-eur', code: 'EUR', symbol: '€', exponent: 2 },
      amountMinor: '5000',
      homeCurrency: 'CAD',
      homeAmountMinor: null,
      fxRate: null,
    });
    expect(screen.getByText('workbench.fxNoRate:EUR')).toBeInTheDocument();
  });

  it('shows no conversion at all when the expense is already in the home currency', () => {
    // Nothing to convert, so no second line — the figure above is the figure.
    row({ homeCurrency: 'CAD', homeAmountMinor: '4500', fxRate: '1' });
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fxNoRate/)).not.toBeInTheDocument();
  });

  it('pills each distinct category once, however many lines share it', () => {
    // Three dinners on one expense is one "Meals" pill, not three.
    row({
      lineItems: [
        line({ id: 'a' }),
        line({ id: 'b' }),
        line({
          id: 'c',
          categoryId: 'cat-meals',
          category: {
            id: 'cat-meals',
            label: { en: 'Meals' },
            icon: '🍽️',
            color: '#111111',
            isMileage: false,
          },
        }),
      ],
    });
    expect(screen.getAllByText('Ground')).toHaveLength(1);
    expect(screen.getByText('Meals')).toBeInTheDocument();
  });

  it('counts attendees and receipts only when there are some', () => {
    row({
      attendees: [{ id: 'a1', name: 'Ada', company: null, isExternal: false }],
      receipts: [{ id: 'r1' }, { id: 'r2' }],
    });
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    cleanup();
    row();
    // Neither count renders for an expense with no attendees and no receipts.
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('shows the tax total only when there is tax', () => {
    row({ taxGstHstMinor: '585', taxQstMinor: '100' });
    expect(screen.getByText(/workbench.taxLabel/)).toHaveTextContent('$6.85 CAD');
  });

  /**
   * Every figure on this row — the amount, the converted equivalent, the tax —
   * went through a local `money()` helper that called a formatter which pasted
   * the stored symbol in front of `toLocaleString(undefined, …)`. `undefined` is
   * the RUNTIME's locale, not the reader's, so a French-Canadian reviewing this
   * list saw American money; and the leading-symbol template could not produce
   * the trailing-symbol form at all.
   *
   * Asserted per figure and in both locales. A single-locale test would pass on
   * a build that hardcodes `en` — which is exactly the build being replaced.
   */
  describe('every figure follows the READER, not the runtime', () => {
    /** Intl groups fr-CA with a NO-BREAK space; escaped so a review can see it. */
    const NBSP = '\u00A0';
    /** Testing Library's default normalizer collapses U+00A0 to an ASCII space,
     *  which would hide the separator this is asserting on. Trim only. */
    const EXACT = { normalizer: (str: string) => str.trim() };

    it('renders the row amount with the symbol on the locale’s side', () => {
      row({ amountMinor: '1079900' }, { locale: 'fr-CA' });
      expect(screen.getByText(`10${NBSP}799,00${NBSP}$ CAD`, EXACT)).toBeInTheDocument();
      // The ASCII-space form must NOT match; if it starts to, the normalizer has
      // been reintroduced and the assertion above proves nothing.
      expect(screen.queryByText('10 799,00 $ CAD', EXACT)).not.toBeInTheDocument();
      cleanup();

      row({ amountMinor: '1079900' }, { locale: CATALOG_LOCALE });
      expect(screen.getByText('$10,799.00 CAD', EXACT)).toBeInTheDocument();
      expect(screen.queryByText(`10${NBSP}799,00${NBSP}$ CAD`, EXACT)).not.toBeInTheDocument();
    });

    it('gives the SAME amount two DIFFERENT strings in en and fr-CA', () => {
      // The assertion no single-locale build can satisfy, whichever it picks.
      // Read off raw `textContent` so nothing normalizes the separator away.
      const fr = row({ amountMinor: '1079900' }, { locale: 'fr-CA' }).container.textContent;
      cleanup();
      const en = row({ amountMinor: '1079900' }, { locale: CATALOG_LOCALE }).container.textContent;
      expect(fr).not.toBe(en);
      expect(fr).toContain(`10${NBSP}799,00${NBSP}$`);
      expect(en).toContain('$10,799.00');
    });

    it('follows the reader for the tax figure too', () => {
      row({ taxGstHstMinor: '585', taxQstMinor: '100' }, { locale: 'fr-CA' });
      // Raw `textContent`, not `toHaveTextContent`: that matcher normalizes
      // whitespace and would collapse U+00A0 to an ASCII space — the separator
      // under test.
      expect(screen.getByText(/workbench.taxLabel/).textContent).toContain(`6,85${NBSP}$ CAD`);
      expect(screen.getByText(/workbench.taxLabel/).textContent).not.toContain('6,85 $ CAD');
    });

    it('follows the reader for the converted foreign equivalent too', () => {
      // The second line under a foreign charge — the figure the employee is
      // actually paid. It reads through the same helper as the amount above it.
      row(
        {
          currency: { id: 'cur-usd', code: 'USD', symbol: '$', exponent: 2 },
          amountMinor: '10000',
          homeCurrency: 'CAD',
          homeAmountMinor: '13700',
          fxRate: '1.37',
        },
        { locale: 'fr-CA' },
      );
      expect(screen.getByText(`≈ 137,00 CAD`, EXACT)).toBeInTheDocument();
      expect(screen.queryByText('≈ 137.00 CAD', EXACT)).not.toBeInTheDocument();
    });
  });

  it('offers a checkbox only where the list is selectable', () => {
    row({}, { selectable: true, selected: false, onToggleSelected: vi.fn() });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();

    cleanup();
    row();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

// ── A saved line item ─────────────────────────────────────────────────────────

describe('a saved line item', () => {
  it('commits a category change on its own, with no amount', async () => {
    /**
     * The change used to be folded into the amount commit, which returned silently when
     * switching into mileage with no distance yet — nothing was written and the row kept
     * showing the old figure. The server owns what a line of the new kind should hold.
     */
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'addLine.categoryPlaceholder', 'Meals');
    expect(sent('lineItemUpdate')).toContainEqual({ id: 'line-1', categoryId: 'cat-meals' });
  });

  it('writes nothing when the category is cleared', async () => {
    // A line IS a category plus an amount; a cleared selection is not a state worth
    // persisting.
    const user = userEvent.setup();
    renderEditor();
    const box = getAllComboboxesByPlaceholder('addLine.categoryPlaceholder')[0];
    await user.click(box);
    await user.keyboard('{Escape}');
    expect(sent('lineItemUpdate')).toHaveLength(0);
  });

  it('carries no amount across the mileage boundary', async () => {
    /**
     * A typed amount is not a distance. The commit is the category ALONE — the server
     * clears the columns that no longer apply and re-derives the rest, which is why the
     * row does not try to guess what a mileage line of this amount would mean.
     */
    const user = userEvent.setup();
    renderEditor();
    expect(screen.getByLabelText('line.amount')).toHaveValue('45.00');
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(sent('lineItemUpdate').at(-1)).toEqual({ id: 'line-1', categoryId: 'cat-mileage' });
  });

  it('surfaces a refused reprice on the row rather than keeping the old figure', async () => {
    /**
     * Switching an existing line into mileage can be refused — a traveller with no
     * country, or a country with no rate in force. Invisibly keeping the old amount is
     * worse than an error, because it looks like it worked.
     */
    h.errors.lineItemUpdate = 'No country on the traveller — cannot resolve a mileage rate.';
    const user = userEvent.setup();
    renderEditor();
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(await screen.findByRole('alert')).toHaveTextContent('No country on the traveller');
  });

  it('saves the amount on blur', async () => {
    const user = userEvent.setup();
    renderEditor();
    const amount = screen.getByLabelText('line.amount');
    await user.clear(amount);
    await user.type(amount, '62.50');
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ id: 'line-1', amountMinor: '6250' });
  });

  it('marks an empty amount, because a line needs one', async () => {
    const user = userEvent.setup();
    renderEditor();
    const amount = screen.getByLabelText('line.amount');
    await user.clear(amount);
    expect(amount.className).toContain('border-destructive');
  });

  it('deletes the line', async () => {
    const user = userEvent.setup();
    renderEditor();
    // The header's delete is first; the row's own is next.
    await user.click(screen.getAllByRole('button', { name: 'actions.delete' })[1]);
    expect(sent('lineItemRemove')[0]).toEqual({ id: 'line-1' });
  });

  it('offers a tip field only where the category takes one', async () => {
    /**
     * `acceptsTip` on the category is what makes the field exist. Without the gate a tip
     * appears on a software renewal, and an approver has to ask about it.
     */
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    expect(screen.getByLabelText(/lineKinds.tip/)).toBeInTheDocument();

    cleanup();
    renderEditor();
    expect(screen.queryByLabelText(/lineKinds.tip/)).not.toBeInTheDocument();
  });

  it('starts the tip field blank rather than at zero', async () => {
    /**
     * `tipMinorOf` returns 0n for a line with no tip. Seeding "0.00" misrepresents it —
     * the server treats `tip <= 0` as no tip — and breaks typing, because the first
     * keystroke appends to the zero and yields NaN.
     */
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    expect(screen.getByLabelText(/lineKinds.tip/)).toHaveValue('');
  });

  it('commits the tip on blur, nulling it when emptied', async () => {
    const user = userEvent.setup();
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    const tip = screen.getByLabelText(/lineKinds.tip/);
    await user.type(tip, '5.00');
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ tipMinor: '500' });

    await user.clear(tip);
    await user.tab();
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ tipMinor: null });
  });

  it('drops the tip when the category stops accepting one', async () => {
    // Otherwise the field disappears with a value still in it, and the next commit
    // would carry a tip the new category has no place for.
    const user = userEvent.setup();
    renderEditor({ lineItems: [line({ categoryId: 'cat-meals' })] });
    await user.type(screen.getByLabelText(/lineKinds.tip/), '5.00');
    await pick(user, 'addLine.categoryPlaceholder', 'Ground');
    expect(screen.queryByLabelText(/lineKinds.tip/)).not.toBeInTheDocument();
  });
});

// ── Mileage on a saved line ───────────────────────────────────────────────────

describe('a mileage line', () => {
  const mileage = (over: Record<string, unknown> = {}) =>
    line({
      categoryId: 'cat-mileage',
      category: {
        id: 'cat-mileage',
        label: { en: 'Mileage' },
        icon: '🚗',
        color: '#111',
        isMileage: true,
      },
      mileageDistance: '100',
      mileageUnit: 'KM',
      ...over,
    });

  it('shows a distance rather than an amount', () => {
    // The amount is derived server-side from the rate in force, so it is not typed.
    renderEditor({ lineItems: [mileage()] });
    expect(screen.getByLabelText('line.distance')).toHaveValue('100');
  });

  it('reinterprets a TYPED distance when the unit changes', async () => {
    /**
     * Somebody who typed 100 and pressed MI meant a hundred miles — converting it would
     * be the app deciding they meant something else.
     */
    const user = userEvent.setup();
    renderEditor({ lineItems: [mileage({ mileageRoute: null })] });
    await user.click(screen.getByRole('button', { name: /MI/ }));
    expect(screen.getByLabelText('line.distance')).toHaveValue('100');
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({
      mileageDistance: '100',
      mileageUnit: 'MI',
    });
  });

  it('converts a MEASURED distance when the unit changes', async () => {
    /**
     * 100 km measured by the route IS 62.14 mi — the same journey. Reinterpreting it
     * would silently claim a longer trip.
     */
    const user = userEvent.setup();
    renderEditor({
      lineItems: [
        mileage({
          mileageRoute: {
            stops: [
              { id: 's1', description: 'Halifax', placeId: 'p1' },
              { id: 's2', description: 'Truro', placeId: 'p2' },
            ],
          },
        }),
      ],
    });
    await user.click(screen.getByRole('button', { name: /MI/ }));
    expect(sent('lineItemUpdate').at(-1)).toMatchObject({ mileageUnit: 'MI' });
    expect(sent('lineItemUpdate').at(-1)?.mileageDistance as string).not.toBe('100');
  });

  it('sends the route only when a stop was actually named', async () => {
    // An empty pair of blank stops is not evidence of anything.
    const user = userEvent.setup();
    renderEditor({ lineItems: [mileage({ mileageRoute: null })] });
    await user.click(screen.getByRole('button', { name: /MI/ }));
    expect(sent('lineItemUpdate').at(-1)?.mileageRoute).toBeNull();
  });
});

// ── Draft rows ────────────────────────────────────────────────────────────────

describe('a draft line', () => {
  const addDraft = async (user: ReturnType<typeof userEvent.setup>) => {
    renderEditor({ lineItems: [] });
    await user.click(screen.getByRole('button', { name: /drawer.addLine/ }));
  };

  it('commits the moment a non-mileage category is chosen — there is no Add button', async () => {
    /**
     * The amount is optional server-side, so the row commits on the category alone and
     * the amount is typed into the real line. One gesture fewer, and it is the point at
     * which the line's own fields (a tip) can appear at all.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Ground');
    expect(sent('lineItemCreate')[0]).toMatchObject({ expenseId: 'exp-1', categoryId: 'cat-taxi' });
  });

  it('offers no save button for a category that already committed', async () => {
    // A button that does nothing.
    const user = userEvent.setup();
    await addDraft(user);
    expect(screen.queryByRole('button', { name: 'addLine.save' })).not.toBeInTheDocument();
  });

  it('makes a mileage row collect its distance first', async () => {
    /**
     * The SERVER draws this line, not the component: `computeLineFinancials` refuses a
     * mileage line with no distance, and the flag that allows one exists only for
     * switching an EXISTING line.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    expect(sent('lineItemCreate')).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'addLine.save' })).toBeDisabled();
  });

  it('saves a mileage row with its distance AND its unit', async () => {
    /**
     * The unit travels with the distance. It used not to be captured at all, so the
     * server fell back to the RULE's unit and a distance meant as miles was priced as
     * kilometres.
     */
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(sent('lineItemCreate')[0]).toMatchObject({
      categoryId: 'cat-mileage',
      mileageDistance: '120',
      mileageUnit: 'KM',
    });
  });

  it('omits the route when no stop was named', async () => {
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(sent('lineItemCreate')[0]).not.toHaveProperty('mileageRoute');
  });

  it('keeps the row and shows the reason when the create is refused', async () => {
    /**
     * The draft used to be discarded synchronously right after `mutate()` — before the
     * write was known — so a rejected create took the typed values with it and showed
     * nothing at all.
     */
    h.errors.lineItemCreate = 'No country on the traveller — cannot resolve a mileage rate.';
    const user = userEvent.setup();
    await addDraft(user);
    await pick(user, 'addLine.categoryPlaceholder', 'Mileage');
    await user.type(screen.getByLabelText('line.distance'), '120');
    await user.click(screen.getByRole('button', { name: 'addLine.save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No country on the traveller');
    // …and the row is still there, with its distance.
    expect(screen.getByDisplayValue('120')).toBeInTheDocument();
  });

  it('drops the row on cancel', async () => {
    const user = userEvent.setup();
    await addDraft(user);
    await user.click(screen.getByRole('button', { name: 'addLine.cancel' }));
    expect(queryComboboxByPlaceholder('addLine.categoryPlaceholder')).not.toBeInTheDocument();
  });
});

// ── Attendees ─────────────────────────────────────────────────────────────────

describe('the attendee editor', () => {
  /** The editor only renders when a line's category requires attendees. */
  const withAttendees = (attendees: Record<string, unknown>[] = []) =>
    renderEditor({
      attendees,
      lineItems: [
        line({
          category: {
            id: 'cat-meals',
            label: { en: 'Meals' },
            icon: '🍽️',
            color: '#111',
            isMileage: false,
            requiresAttendees: true,
          },
        }),
      ],
    });

  it('lists the people already on the expense, labelled by side', () => {
    /**
     * Internal versus external is the distinction the tax and the policy care about, so
     * it is on the row rather than inferred from whether a company is filled in.
     */
    withAttendees([
      { id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false },
      { id: 'a2', name: 'Bob Vendor', company: 'Acme', isExternal: true },
    ]);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('attendee.internal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bob Vendor')).toBeInTheDocument();
    expect(screen.getByText('attendee.external')).toBeInTheDocument();
  });

  it('shows an employee as text, not as editable fields', () => {
    // Their name comes from the directory; letting it be retyped invites a second
    // spelling of the same person.
    withAttendees([{ id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false }]);
    expect(screen.queryByDisplayValue('Ada Lovelace')).not.toBeInTheDocument();
  });

  it('adds an external attendee as a blank pair of fields', async () => {
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    expect(screen.getByPlaceholderText('attendee.name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('attendee.company')).toBeInTheDocument();
  });

  it('writes nothing for a row with no name yet', async () => {
    // A blank row is a row somebody is still typing into.
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    await user.click(screen.getByPlaceholderText('attendee.name'));
    await user.tab();
    const attendees = (sent('updateExpense').at(-1)?.attendees ?? []) as unknown[];
    expect(attendees).toEqual([]);
  });

  it('keeps a company only for an external attendee', async () => {
    /**
     * An employee never carries one, so an internal row with a stray company would put
     * a vendor name against a colleague.
     */
    const user = userEvent.setup();
    withAttendees();
    await user.click(screen.getByRole('button', { name: /attendee.addExternal/ }));
    await user.type(screen.getByPlaceholderText('attendee.name'), 'Bob Vendor');
    await user.type(screen.getByPlaceholderText('attendee.company'), 'Acme');
    await user.tab();
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([
      { name: 'Bob Vendor', company: 'Acme', isExternal: true },
    ]);
  });

  it('searches the directory only once the query is worth a round trip', async () => {
    // Two characters: a one-letter search returns most of the company.
    const user = userEvent.setup();
    h.directory = [{ id: 'u-1', name: 'Grace Hopper', email: 'grace@e.inc' }];
    withAttendees();
    await user.type(screen.getByPlaceholderText('attendee.searchPlaceholder'), 'g');
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
  });

  it('adds a picked employee as internal, and clears the search', async () => {
    const user = userEvent.setup();
    h.directory = [{ id: 'u-1', name: 'Grace Hopper', email: 'grace@e.inc' }];
    withAttendees();
    const search = screen.getByPlaceholderText('attendee.searchPlaceholder');
    await user.type(search, 'grace');
    const hit = await screen.findByText('Grace Hopper');
    await user.click(hit);
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([
      { name: 'Grace Hopper', company: null, isExternal: false },
    ]);
    expect(search).toHaveValue('');
  });

  it('removes a row', async () => {
    const user = userEvent.setup();
    withAttendees([{ id: 'a1', name: 'Ada Lovelace', company: null, isExternal: false }]);
    await user.click(screen.getByRole('button', { name: 'attendee.remove' }));
    expect(sent('updateExpense').at(-1)?.attendees).toEqual([]);
  });
});

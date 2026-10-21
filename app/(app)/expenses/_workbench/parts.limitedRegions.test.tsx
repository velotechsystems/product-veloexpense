import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The one-face rule inside `ExpenseEditor`, which replaced the `limited` suppression. No
 * region renders two faces any more, and no `SectionNotice` is left on the pane: the core
 * fields and the line block have one face since P18, and the expense-level tax, the
 * attendees and the cost allocation since P13; see the last five `describe` blocks.
 *
 * ─── READ THIS BEFORE ADDING A CASE HERE ─────────────────────────────────────────────────
 *
 * The mechanism under test is CSS, and **jsdom applies no CSS**. So every assertion below
 * is about what is in the DOM and what CLASSES it carries — never about what is visible.
 * `toBeVisible()` would pass for both faces at every width and prove nothing, and
 * `stubDevice('phone')` from `@/test-utils/pointer` changes nothing here at all: no
 * component in this file reads `matchMedia`. That is the point of the ruling — the editors
 * are heavy and stateful, and a `useIsBelowLg` branch would unmount them on a desktop
 * window drag across 1024px, taking a half-typed allocation percentage with it.
 *
 * The three claims worth pinning, and the failure each one catches:
 *
 *   1. **One face per condition.** A draft renders the editable controls at every width
 *      and no read-only twin; a submitted report renders the read-only face and no
 *      control. `editable` still means "the server will accept a mutation", never a width.
 *   1b. **No notice.** The pane carried one `SectionNotice` (five, before that) naming
 *      the regions suppressed below `lg`. P13 gave the last of them an editor at every
 *      width, so there is nothing left for it to name, and its catalog keys are gone. Its
 *      count is pinned at zero: a notice coming back would say "read-only here" about
 *      regions a phone reader can edit.
 *   2. **No width cloak.** Nothing in `ExpenseEditor` carries `lg:contents` or `lg:block`
 *      any more. If one ever comes back, ADR-0005 D3 still binds: `block` moved 4 of 154
 *      rectangles, because these regions are flex children of `ExpenseEditor`'s
 *      `flex flex-col gap-3 p-3`; `contents` generates no box.
 *   3. **One labelled control per name, still.** Playwright's label engine has NO
 *      visibility filter, so a CSS-hidden twin of a labelled field IS a strict match —
 *      `getByRole` would have skipped it, `getByLabel` does not. A second labelled
 *      "Vendor" anywhere on this page breaks every spec that calls
 *      `e2e/support/workbench.ts`'s `addExpense`, at 1280 in `chromium`, a width at which
 *      none of the phone work is even supposed to be visible. This file is the unit-level
 *      guard for that, because the browser suite does not run per phase.
 */

type Calls = Record<string, unknown[]>;

const h = vi.hoisted(() => ({
  calls: {} as Calls,
  queries: {} as Record<string, unknown>,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
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
    useMutation: (opts?: { onSuccess?: () => void }) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
        opts?.onSuccess?.();
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

const CATEGORIES = [{ value: 'cat-meals', label: 'Travel - Meals' }];

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  categoryId: 'cat-meals',
  category: {
    id: 'cat-meals',
    label: 'Travel - Meals',
    icon: null,
    isMileage: false,
    requiresAttendees: false,
  },
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
    placeText: 'Montréal',
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [line()],
    receipts: [],
    attendees: [],
    allocations: [],
    taxGstHstMinor: '575',
    taxQstMinor: '1147',
    taxPstMinor: null,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'CALCULATED',
    subtotalMinor: null,
    fxRate: null,
    ...over,
  }) as never;

const DIMENSIONS = {
  businessUnits: [{ id: 'bu-1', label: { en: 'Atlantic' } }],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  classes: [{ id: 'cls-1', name: 'Internal' }],
};

/** Two saved allocation rows, 60/40, fully coded against `DIMENSIONS`. */
const ALLOCATIONS = [
  {
    id: 'alloc-1',
    percentBp: 6000,
    businessUnitId: 'bu-1',
    departmentId: 'dep-1',
    classId: 'cls-1',
    businessUnit: { id: 'bu-1', label: { en: 'Atlantic' } },
    department: { id: 'dep-1', label: { en: 'Engineering' } },
    class: { id: 'cls-1', name: 'Internal' },
  },
  {
    id: 'alloc-2',
    percentBp: 4000,
    businessUnitId: 'bu-1',
    departmentId: 'dep-1',
    classId: 'cls-1',
    businessUnit: { id: 'bu-1', label: { en: 'Atlantic' } },
    department: { id: 'dep-1', label: { en: 'Engineering' } },
    class: { id: 'cls-1', name: 'Internal' },
  },
];

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

const notices = () => screen.queryAllByTestId('section-limited-notice');

beforeEach(() => {
  h.calls = {};
  h.queries = { dimensionOptions: DIMENSIONS };
});

describe('no `limited` notice', () => {
  it('renders no section notice on a draft, with or without attendees', () => {
    /**
     * Zero, whatever the expense contains. The notice named cost allocation, tax and
     * attendees; each now has an editor at every width (P13), so a notice would say
     * "read-only here" about regions a phone reader can edit.
     */
    renderEditor();
    expect(notices()).toHaveLength(0);

    cleanup();
    renderEditor({
      allocations: ALLOCATIONS,
      lineItems: [line({ category: { ...line().category, requiresAttendees: true } })],
    });
    expect(screen.getByText('drawer.attendees')).toBeInTheDocument();
    expect(notices()).toHaveLength(0);
  });

  it('a submitted report has no notice and no editing control in any panel', () => {
    /**
     * `editable === false` still means exactly what it meant: the server will not accept a
     * mutation on this report. Not one editing control exists, at any width — which is the
     * claim SEC-1 rests on: nothing here is a client-side permission, and the server
     * re-derives the same predicate from `EDITABLE_REPORT_STATUSES` on every write.
     */
    renderEditor(
      {
        allocations: ALLOCATIONS,
        lineItems: [line({ category: { ...line().category, requiresAttendees: true } })],
      },
      { editable: false },
    );
    expect(notices()).toHaveLength(0);
    expect(screen.queryByLabelText('workbench.vendor')).toBeNull();
    expect(screen.queryAllByLabelText('allocation.percent')).toHaveLength(0);
    expect(screen.queryAllByLabelText(/^line\.gst/)).toHaveLength(0);
    expect(screen.queryByPlaceholderText('attendee.searchPlaceholder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'drawer.addLine' })).toBeNull();
  });
});

describe('the width cloak', () => {
  it('is gone from a draft, with every panel rendered', () => {
    /**
     * The cost allocation was the last region cloaked with `hidden lg:contents`. Run on the
     * fixture that renders all three detail panels at once (two allocation rows, a line
     * that requires attendees), because a clean result on a fixture that never renders
     * one of them would prove nothing. Tokens from `classList`, not substrings, so a
     * legitimate `lg:flex` or `lg:flex-row` is not a hit.
     */
    const { container } = renderEditor({
      allocations: ALLOCATIONS,
      lineItems: [line({ category: { ...line().category, requiresAttendees: true } })],
    });
    expect(screen.getAllByLabelText('allocation.percent')).toHaveLength(2);
    expect(screen.getByText('drawer.attendees')).toBeInTheDocument();
    const tokens = [...container.querySelectorAll('*')].flatMap((el) => [...el.classList]);
    expect(tokens.filter((c) => c === 'lg:contents' || c === 'lg:block')).toEqual([]);
    expect(notices()).toHaveLength(0);
  });
});

describe('the labelled-field audit', () => {
  /**
   * The names `e2e/support/workbench.ts` addresses unscoped and strict, plus the ones the
   * ruling adds. Under the stubbed translator a catalog key is its own label, so these are
   * the keys behind Vendor, Date, Location, Currency, Amount, GST/HST, QST and PST.
   *
   * `getAllByLabelText` rather than `getByLabelText`, so a failure says "expected 1, got 2"
   * rather than throwing a wall of DOM — the count IS the claim.
   */
  it.each([
    ['workbench.vendor'],
    ['line.date'],
    ['line.location'],
    ['line.currency'],
    ['line.amount'],
    [/^line\.gst/],
    [/^line\.qst/],
    [/^workbench\.pst/],
    ['allocation.percent'],
  ])('renders exactly one control labelled %s on a draft report', (label: string | RegExp) => {
    renderEditor();
    expect(screen.getAllByLabelText(label)).toHaveLength(1);
  });
});

/**
 * The cost allocation's read-only list — `AllocationLinesReadOnly` — which renders on a
 * submitted report only (P13).
 *
 * It was the operator round's first request, as the phone's face of a draft: before it, a
 * phone was shown the card's HEAD alone — a heading, a "% / 100 %" total and, when a row
 * was half-coded, a warning — so the reader was told there was a problem with the coding
 * and never shown the coding. P13 made the rows editable at every width, so a draft has
 * the rows themselves and this list went back to being the `!editable` arm's alone. Its
 * money column and its contract (no labelled control) are unchanged.
 */
describe('the cost-allocation read-only list', () => {
  /** The list's row carrying a given dimension string. */
  const rowFor = (dims: string) => screen.getAllByText(dims)[0].closest('li') as HTMLElement;

  it('renders a line per allocation, with its share, its money and its dimensions', () => {
    /**
     * "60 %" alone is not what a reader is checking — "60 % of what" is — and every other
     * figure on this pane is already money. It is derived from the expense's own total by
     * the same basis-point arithmetic the server allocates with, never stored.
     */
    renderEditor({ allocations: ALLOCATIONS }, { editable: false });

    const first = rowFor('Atlantic · Engineering · Internal');
    expect(first.textContent).toContain('60%');
    expect(first.textContent).toContain('69.00');
    // 11500 minor split 60/40 — the second row is the other 46.00, not a repeat.
    const bothRows = screen.getAllByText('Atlantic · Engineering · Internal');
    expect(bothRows).toHaveLength(2);
    expect((bothRows[1].closest('li') as HTMLElement).textContent).toContain('46.00');
    expect((bothRows[1].closest('li') as HTMLElement).textContent).toContain('40%');
  });

  it('splits the money so the rows add up to the expense to the cent', () => {
    /**
     * Rounding each row on its own read 33.33 + 33.33 + 33.34 = 100.00 against a 100.01
     * expense. The leftover cent goes where the NetSuite poster puts it — `splitExact`,
     * largest share first — so what the reader sees is what posts. (VeloExpense: ExpenseOS's
     * poster; VeloExpense's ledger post does not split by allocation.)
     */
    const third = (id: string, percentBp: number) => ({ ...ALLOCATIONS[0], id, percentBp });
    renderEditor(
      {
        amountMinor: '10001',
        allocations: [third('a', 3333), third('b', 3333), third('c', 3334)],
      },
      { editable: false },
    );

    const rows = screen
      .getAllByText('Atlantic · Engineering · Internal')
      .map((el) => (el.closest('li') as HTMLElement).textContent);
    expect(rows[0]).toContain('33.33');
    expect(rows[1]).toContain('33.33');
    expect(rows[2]).toContain('33.35');
  });

  it('says an uncoded expense is uncoded on a submitted report, and a draft offers the blank row', () => {
    /**
     * Submitted: the sentence is the only face, and the same one the approver gets.
     * Draft: the sentence is gone and the editor's blank 100 % row is there instead, at
     * every width. That row is the control that fixes the condition, which a sentence
     * cannot; the head's total and the `showRequired` warning still say what is wrong.
     */
    renderEditor({}, { editable: false });
    const none = screen.getByText('allocation.none');
    expect(none.className).not.toContain('lg:hidden');

    cleanup();
    renderEditor();
    expect(screen.queryByText('allocation.none')).toBeNull();
    const [percent] = screen.getAllByLabelText('allocation.percent');
    expect(percent).toHaveValue('100');
  });

  it('is the one face on a submitted report, with no cloak on it', () => {
    renderEditor({ allocations: ALLOCATIONS }, { editable: false });

    const list = rowFor('Atlantic · Engineering · Internal').closest('ul') as HTMLElement;
    expect(list.className).not.toContain('lg:hidden');
    expect(screen.queryAllByLabelText('allocation.percent')).toHaveLength(0);
  });

  it('carries no `Field`, no input and no restricted `aria-label`', () => {
    /**
     * `Percent` is the name at risk: Playwright's label engine has no visibility filter,
     * so a labelled control in this list would be a second strict match for the editor's
     * `allocation.percent` input wherever the two ever shared a page.
     */
    renderEditor({ allocations: ALLOCATIONS }, { editable: false });

    const list = rowFor('Atlantic · Engineering · Internal').closest('ul') as HTMLElement;
    expect(
      list.querySelector('input,select,textarea,label,[aria-label],[role="combobox"]'),
    ).toBeNull();
  });
});

/**
 * The core fields — date, vendor, currency, location — on a phone (P18).
 *
 * These left suppression: on a draft report the editable grid renders at every width and
 * the read-only prose twin does not render at all. It is ONE face, so there is nothing for
 * CSS to select between and no width at which the inputs could unmount. On a submitted
 * report the prose is the only face, exactly as before.
 *
 * Same limits as every other case here: jsdom applies no CSS, so what is asserted is the
 * DOM and the classes on it, never what is visible.
 */
describe('the core fields', () => {
  const CORE = ['line.date', 'workbench.vendor', 'line.currency', 'line.location'];
  const PROSE = ['line.date:', 'workbench.vendor:', 'line.currency:', 'line.location:'];

  it('a draft has one set of core fields and no read-only twin', () => {
    renderEditor();

    for (const label of CORE) {
      const field = screen.getByLabelText(label);
      // Not cloaked: no ancestor hides it at any width. `hidden` alone is how the
      // `hidden lg:contents` pair hid it below `lg`, so a bare class check is enough.
      expect(field.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
      expect(field.closest('.hidden')).toBeNull();
    }
    // The prose twin is gone from a draft, not merely hidden.
    for (const text of PROSE) expect(screen.queryByText(text)).toBeNull();
  });

  it('a submitted report has the read-only prose and no core field', () => {
    renderEditor({}, { editable: false });

    for (const text of PROSE) expect(screen.getByText(text)).toBeInTheDocument();
    for (const label of CORE) expect(screen.queryByLabelText(label)).toBeNull();
    // One face, so nothing beside it to select between.
    const prose = screen.getByText('workbench.vendor:').closest('.grid') as HTMLElement;
    expect(prose.className).not.toContain('lg:hidden');
  });

  it('gives each core field a 44px floor on a coarse pointer, on the `<input>` itself', () => {
    /**
     * The class has to land on the control a finger hits, and `className` on these
     * primitives does not always reach it: `Input type="date"` and `Combobox` put it on a
     * wrapper. So the claim is per input: either the `<input>` carries
     * `pointer-coarse:h-11` itself, or an ancestor carries the descendant half
     * `pointer-coarse:[&_input]:h-11` that compiles to `.x input`.
     */
    renderEditor();

    // A classList walk rather than `closest('[class~="…[&_input]…"]')`: jsdom's selector
    // engine does not match that bracketed attribute value, so the selector form would
    // fail on a DOM that is right.
    const ancestorHas = (el: HTMLElement, cls: string) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.classList.contains(cls)) return true;
      }
      return false;
    };
    for (const label of CORE) {
      const field = screen.getByLabelText(label);
      // VeloExpense: the kit's Combobox (Currency) is a `<button role="combobox">` with
      // `className` on the button itself, not an `<input>` in a wrapper, so the bare half
      // lands on the control a finger hits. ExpenseOS: `expect(field.tagName).toBe('INPUT')`.
      expect(
        field.tagName === 'INPUT' ||
          (field.tagName === 'BUTTON' && field.getAttribute('role') === 'combobox'),
      ).toBe(true);
      const own = field.classList.contains('pointer-coarse:h-11');
      const viaWrapper = ancestorHas(field, 'pointer-coarse:[&_input]:h-11');
      expect({ label, floored: own || viaWrapper }).toEqual({ label, floored: true });
    }
  });
});

/**
 * The line block on a phone (P18, which absorbed P12): "Add line", the new-line form, the
 * saved line's editable row and the projected totals.
 *
 * Like the core fields, these left suppression with ONE face: the editable row renders at
 * every width on a draft, and `LineItemReadOnlyRow` renders only on a submitted report.
 * Same limits as every other case here — jsdom applies no CSS, so what is asserted is the
 * DOM and the classes on it.
 */
describe('the line block', () => {
  /** No ancestor that hides it at any width: neither half of a cloak pair, nor bare `hidden`. */
  const uncloaked = (el: HTMLElement) => {
    expect(el.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
    expect(el.closest('.hidden')).toBeNull();
  };

  it('a draft has the editable row alone: one amount per saved line, no read-only row', () => {
    renderEditor();

    const [amount] = screen.getAllByLabelText('line.amount');
    uncloaked(amount);
    uncloaked(screen.getByRole('button', { name: 'drawer.addLine' }));
    // The read-only row is absent, not hidden. It is the only thing that writes the
    // category label as TEXT; the editable row's combobox holds it as the input's value.
    // VeloExpense: the kit's Combobox shows the label as its text (an input's value in
    // ExpenseOS), so the read-only row is any copy OUTSIDE a combobox — there is none.
    const category = screen.getByText('Travel - Meals');
    expect(category.closest('[role="combobox"]')).not.toBeNull();
  });

  it('a second saved line is a second amount, never a twin of the first', () => {
    renderEditor({ lineItems: [line(), line({ id: 'line-2', amountMinor: '2500' })] });
    expect(screen.getAllByLabelText('line.amount')).toHaveLength(2);
  });

  it('a submitted report has the read-only row and no line control', () => {
    renderEditor({}, { editable: false });

    const row = screen.getByText('Travel - Meals').closest('.rounded-md') as HTMLElement;
    expect(row).not.toBeNull();
    // One face, so nothing beside it to select between.
    expect(row.className).not.toContain('lg:hidden');
    expect(screen.queryAllByLabelText('line.amount')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'drawer.addLine' })).toBeNull();
  });

  it('gives "Add line" and the line delete a 44px box on a coarse pointer', () => {
    renderEditor();
    // Scoped to the line row: the expense header carries its own `actions.delete`.
    const row = screen.getByLabelText('line.amount').closest('.lg\\:flex-wrap') as HTMLElement;
    for (const button of [
      screen.getByRole('button', { name: 'drawer.addLine' }),
      within(row).getByRole('button', { name: 'actions.delete' }),
    ]) {
      expect(button).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:min-w-11');
    }
  });

  it("floors the saved row's category and amount at 44px on a coarse pointer", () => {
    renderEditor();
    // The amount is a plain `Input`, so the bare half lands on the `<input>` itself.
    expect(screen.getByLabelText('line.amount')).toHaveClass('pointer-coarse:h-11');
    // The category is a `Combobox`, whose `className` lands on its wrapper; the descendant
    // half reaches the `<input>`. Its value is the selected category's label.
    // VeloExpense: the kit's Combobox is the `<button role="combobox">` showing the label,
    // and `className` lands on it, so the bare half floors it directly.
    const category = screen.getByText('Travel - Meals').closest('[role="combobox"]');
    expect(category).toHaveClass('pointer-coarse:h-11');
  });
});

/**
 * The expense-level tax panel on a phone (P13).
 *
 * It left suppression the way the core fields did in P18: on a draft report the three
 * `MoneyInput`s render at every width and `TaxFiguresReadOnly` does not render at all. On a
 * submitted report the prose is the only face. Same limits as every other case here —
 * jsdom applies no CSS, so what is asserted is the DOM and the classes on it.
 */
describe('the tax panel', () => {
  const TAX = [/^line\.gst/, /^line\.qst/, /^workbench\.pst/];
  const PROSE = ['line.gst:', 'line.qst:', 'workbench.pst:'];
  /** A size floor that would also apply to a mouse: `h-11`, `min-h-11` or `min-w-11` bare. */
  const BARE_FLOOR = /^(h|min-h|min-w)-11$/;

  /** No ancestor that hides it at any width: neither half of a cloak pair, nor bare `hidden`. */
  const uncloaked = (el: HTMLElement) => {
    expect(el.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
    expect(el.closest('.hidden')).toBeNull();
  };
  const taxCard = () =>
    screen.getByText('workbench.taxHeading').closest('.rounded-md') as HTMLElement;

  it('a draft has the three tax inputs and no tax prose', () => {
    renderEditor();

    for (const label of TAX) {
      const fields = screen.getAllByLabelText(label);
      expect(fields).toHaveLength(1);
      uncloaked(fields[0]);
    }
    // The prose twin is gone from a draft, not merely hidden.
    for (const text of PROSE) expect(screen.queryByText(text)).toBeNull();
  });

  it('floors each tax input at 44px on a coarse pointer, and only on a coarse pointer', () => {
    /**
     * `MoneyInput` forwards `className` to its `Input`, whose plain branch puts it on the
     * `<input>` itself, so the bare half of `TAP_FIELD` lands where the finger does.
     *
     * The prefix is half the claim. An unprefixed `h-11` would grow the fields on a
     * desktop too, so no element in the card may carry a bare size floor.
     */
    renderEditor();

    for (const label of TAX) {
      const field = screen.getByLabelText(label);
      expect(field.tagName).toBe('INPUT');
      expect(field).toHaveClass('pointer-coarse:h-11');
    }
    for (const el of [taxCard(), ...taxCard().querySelectorAll('*')]) {
      const bare = [...el.classList].filter((c) => BARE_FLOOR.test(c));
      expect(bare).toEqual([]);
    }
  });

  it('keeps the two-then-three column grid', () => {
    // Two columns below `sm`, three from `sm` up — the frontend's arithmetic for 360.
    renderEditor();
    const grid = screen.getByLabelText(/^line\.gst/).closest('.grid') as HTMLElement;
    expect(grid).toHaveClass('grid-cols-2', 'sm:grid-cols-3');
  });

  it('a submitted report has the prose alone, uncloaked, and no tax input', () => {
    renderEditor({}, { editable: false });

    for (const text of PROSE) uncloaked(screen.getByText(text));
    for (const label of TAX) expect(screen.queryAllByLabelText(label)).toHaveLength(0);
  });
});

/**
 * The attendees on a phone (P13).
 *
 * They left suppression with ONE face, like the tax panel: the `hidden lg:contents` cloak
 * is gone, so `AttendeesEditor` renders at every width on a draft whose line category
 * requires attendees, and not at all on a submitted report (the `editable &&
 * requiresAttendees` guard). The row stacks below `lg` and comes back to one line from
 * `lg` up. Same limits as every other case here — jsdom applies no CSS, so what is asserted
 * is the DOM and the classes on it, never the layout they produce.
 */
describe('the attendees', () => {
  /** A size floor that would also apply to a mouse: `h-11`, `min-h-11` or `min-w-11` bare. */
  const BARE_FLOOR = /^(h|min-h|min-w)-11$/;
  const PLACEHOLDERS = ['attendee.name', 'attendee.company', 'attendee.searchPlaceholder'];

  /** One external attendee (name + company inputs) and one internal one (text only). */
  const withAttendees = (props: Record<string, unknown> = {}) =>
    renderEditor(
      {
        attendees: [
          { id: 'a1', name: 'Bob Vendor', company: 'Acme', isExternal: true },
          { id: 'a2', name: 'Ada Lovelace', company: null, isExternal: false },
        ],
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
      },
      props,
    );

  /** No ancestor that hides it at any width: neither half of a cloak pair, nor bare `hidden`. */
  const uncloaked = (el: HTMLElement) => {
    expect(el.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
    expect(el.closest('.hidden')).toBeNull();
  };
  /** The block under the `drawer.attendees` heading. */
  const block = () => screen.getByText('drawer.attendees').parentElement as HTMLElement;
  /** The saved external attendee's row: the name `<input>`'s parent (the input is itself `.rounded-md`). */
  const externalRow = () => screen.getByDisplayValue('Bob Vendor').parentElement as HTMLElement;

  it('a draft has the editor uncloaked: the fields, the search and both buttons', () => {
    withAttendees();

    for (const el of [
      screen.getByDisplayValue('Bob Vendor'),
      screen.getByDisplayValue('Acme'),
      screen.getByPlaceholderText('attendee.searchPlaceholder'),
      screen.getByRole('button', { name: 'attendee.addExternal' }),
      ...screen.getAllByRole('button', { name: 'attendee.remove' }),
    ]) {
      uncloaked(el);
    }
    expect(block().querySelector('[class*="lg:contents"]')).toBeNull();
  });

  it('a submitted report has no attendee editor at all', () => {
    // The guard, not CSS: `editable === false` is the server refusing the write.
    withAttendees({ editable: false });

    expect(screen.queryByText('drawer.attendees')).toBeNull();
    for (const text of PLACEHOLDERS) expect(screen.queryByPlaceholderText(text)).toBeNull();
    expect(screen.queryByRole('button', { name: 'attendee.addExternal' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'attendee.remove' })).toHaveLength(0);
  });

  it('keeps the Name, Company and search placeholders and the "Add external" name', () => {
    // Accessible-name work is out of this phase: these are the names E2E and a screen
    // reader already use, unchanged.
    withAttendees();

    for (const text of PLACEHOLDERS) expect(screen.getAllByPlaceholderText(text)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'attendee.addExternal' })).toBeInTheDocument();
  });

  it('stacks the row below `lg` and restores the one-line row from `lg` up', () => {
    /**
     * Each stacking class has its `lg:` reset beside it, so 1280 is the pre-P13 row:
     * `lg:flex-nowrap` undoes the wrap, `lg:flex-1` (`flex: 1 1 0%`) undoes
     * `basis-full`'s 100% basis, and `lg:ml-0` undoes the button's `ml-auto`. A bare
     * `flex-1` beside `basis-full` would leave the outcome to stylesheet order, so it is
     * banned too.
     */
    withAttendees();

    expect(externalRow()).toHaveClass('flex', 'flex-wrap', 'items-center', 'lg:flex-nowrap');
    for (const input of [
      screen.getByDisplayValue('Bob Vendor'),
      screen.getByDisplayValue('Acme'),
    ]) {
      expect(input).toHaveClass('min-w-0', 'basis-full', 'lg:flex-1');
      expect(input).not.toHaveClass('flex-1');
    }
    const remove = within(externalRow()).getByRole('button', { name: 'attendee.remove' });
    expect(remove).toHaveClass('ml-auto', 'lg:ml-0', 'flex', 'items-center', 'justify-center');
  });

  it('floors every control at 44px on a coarse pointer, and only on a coarse pointer', async () => {
    /**
     * The fields are plain `Input`s, so the bare half of `TAP_FIELD` lands on the
     * `<input>` itself. The directory results only render once a search returns, so the
     * case types one in.
     *
     * The prefix is half the claim: an unprefixed floor would grow the controls on a
     * desktop too, so no element in the block may carry one.
     */
    const user = userEvent.setup();
    h.queries.attendeeDirectory = [{ id: 'u-1', name: 'Grace Hopper', email: 'grace@e.inc' }];
    withAttendees();

    const search = screen.getByPlaceholderText('attendee.searchPlaceholder');
    for (const field of [
      screen.getByDisplayValue('Bob Vendor'),
      screen.getByDisplayValue('Acme'),
      search,
    ]) {
      expect(field.tagName).toBe('INPUT');
      expect(field).toHaveClass('pointer-coarse:h-11');
    }
    for (const button of [
      ...screen.getAllByRole('button', { name: 'attendee.remove' }),
      screen.getByRole('button', { name: 'attendee.addExternal' }),
    ]) {
      expect(button).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:min-w-11');
    }

    await user.type(search, 'grace');
    const hit = (await screen.findByText('Grace Hopper')).closest('button') as HTMLElement;
    expect(hit).toHaveClass('pointer-coarse:min-h-11');

    for (const el of [block(), ...block().querySelectorAll('*')]) {
      const bare = [...el.classList].filter((c) => BARE_FLOOR.test(c));
      expect(bare).toEqual([]);
    }
  });
});

/**
 * The cost allocation on a phone (P13).
 *
 * It left suppression with ONE face, like the tax panel and the attendees: on a draft the
 * rows and "Add allocation" render at every width and `AllocationLinesReadOnly` does not
 * render at all. Below `lg` each row is a two-track grid card; from `lg` up the `lg:` half
 * gives back the pre-P13 one-line row. Same limits as every other case here — jsdom applies
 * no CSS, so what is asserted is the DOM and the classes on it, never the layout.
 */
describe('the cost allocation on a draft', () => {
  /** A size floor that would also apply to a mouse: `h-11`, `min-h-11` or `min-w-11` bare. */
  const BARE_FLOOR = /^(h|min-h|min-w)-11$/;
  const PICKERS = ['allocation.businessUnit', 'allocation.department', 'allocation.class'];

  /** No ancestor that hides it at any width: neither half of a cloak pair, nor bare `hidden`. */
  const uncloaked = (el: HTMLElement) => {
    expect(el.closest('[class*="lg:contents"],[class*="lg:hidden"]')).toBeNull();
    expect(el.closest('.hidden')).toBeNull();
  };
  const card = () => screen.getByText('allocation.heading').closest('.rounded-md') as HTMLElement;
  const percents = () => screen.getAllByLabelText('allocation.percent');
  /** Row `i`: the element that holds its percent wrapper, its three pickers and its remove. */
  const row = (i: number) => percents()[i].parentElement?.parentElement as HTMLElement;
  /**
   * VeloExpense: the kit's Combobox is a `<button role="combobox">` that keeps its
   * placeholder in `data-placeholder` whatever it shows (an ExpenseOS Base UI input is found
   * by its placeholder), so the pickers are found by that attribute.
   */
  const pickersIn = (root: ParentNode, placeholder: string) => [
    ...root.querySelectorAll<HTMLElement>(`[role="combobox"][data-placeholder="${placeholder}"]`),
  ];
  /** Row `i`'s wrapper around the picker with this placeholder (the ring wrapper). */
  const picker = (i: number, placeholder: string) => {
    const [trigger] = pickersIn(row(i), placeholder);
    return [...row(i).children].find((c) => c.contains(trigger)) as HTMLElement;
  };
  const classes = (el: HTMLElement) => [...el.classList].sort();
  const isAt = (token: string) => token.startsWith('lg:');

  it('a draft has one percent field per row and no read-only list', () => {
    renderEditor({ allocations: ALLOCATIONS });

    expect(percents()).toHaveLength(2);
    for (const placeholder of PICKERS) {
      expect(pickersIn(document, placeholder)).toHaveLength(2);
    }
    for (const el of [
      ...percents(),
      ...screen.getAllByRole('button', { name: 'allocation.remove' }),
      screen.getByRole('button', { name: 'allocation.add' }),
    ]) {
      uncloaked(el);
    }
    // The list is gone from a draft, not merely hidden: it is the only thing that writes
    // the dimensions as one joined string, and the only `<ul>` in the card.
    expect(screen.queryByText('Atlantic · Engineering · Internal')).toBeNull();
    expect(card().querySelector('ul')).toBeNull();

    cleanup();
    renderEditor({ allocations: [ALLOCATIONS[0]] });
    expect(percents()).toHaveLength(1);
  });

  it('stacks two rows as cards, class sharing its line with the remove button', () => {
    renderEditor({ allocations: ALLOCATIONS });

    for (const i of [0, 1]) {
      expect(classes(row(i))).toEqual(
        [
          'grid',
          'grid-cols-[minmax(0,1fr)_auto]',
          'gap-1.5',
          'rounded-md',
          'border',
          'border-border',
          'p-2',
          'lg:flex',
          'lg:items-center',
          'lg:rounded-none',
          'lg:border-0',
          'lg:p-0',
        ].sort(),
      );
      expect(percents()[i].parentElement).toHaveClass('relative', 'col-span-2', 'w-20', 'shrink-0');
      for (const placeholder of ['allocation.businessUnit', 'allocation.department']) {
        expect(classes(picker(i, placeholder))).toEqual(
          ['col-span-2', 'min-w-0', 'rounded', 'lg:col-span-1', 'lg:flex-1'].sort(),
        );
      }
      // With a remove button, class takes column 1 and the button the `auto` track.
      expect(classes(picker(i, 'allocation.class'))).toEqual(
        ['min-w-0', 'rounded', 'lg:flex-1'].sort(),
      );
      // DOM order is visual order: remove is the row's last child.
      const remove = within(row(i)).getByRole('button', { name: 'allocation.remove' });
      expect(row(i).lastElementChild).toBe(remove);
    }
  });

  it('gives a single row no remove button, so class spans both tracks', () => {
    renderEditor();

    expect(percents()).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: 'allocation.remove' })).toHaveLength(0);
    expect(classes(picker(0, 'allocation.class'))).toEqual(
      ['col-span-2', 'min-w-0', 'rounded', 'lg:flex-1'].sort(),
    );
    expect(row(0)).toHaveClass('grid', 'lg:flex', 'lg:items-center');
  });

  it('restores the pre-P13 class set behind `lg:`', () => {
    /**
     * The pre-P13 classes, read from `origin/main` before this change. From `lg` up each
     * must still apply, bare or `lg:`-prefixed, and every bare class that is NEW must be
     * either reset by an `lg:` sibling or inert there (grid-only, or a colour on a zero
     * border). The remove button's `flex items-center justify-center` is the one accepted
     * difference at `lg`: it centres the glyph in the button's own box and moves no other
     * control. `pointer-coarse:` floors are outside the fine-pointer contract.
     */
    const PRE_P13 = {
      row: ['flex', 'items-center', 'gap-1.5'],
      percent: ['relative', 'w-20', 'shrink-0'],
      picker: ['min-w-0', 'flex-1', 'rounded'],
      remove: [
        'shrink-0',
        'text-muted-foreground',
        'hover:text-destructive',
        'disabled:opacity-50',
      ],
    };
    /** A new bare class → the `lg:` class that resets it, or `null` when inert at `lg`. */
    const AT_LG: Record<string, string | null> = {
      grid: 'lg:flex',
      'grid-cols-[minmax(0,1fr)_auto]': null,
      'rounded-md': 'lg:rounded-none',
      border: 'lg:border-0',
      'border-border': null,
      'p-2': 'lg:p-0',
      'col-span-2': null,
    };
    const REMOVE_BOX = ['flex', 'items-center', 'justify-center'];

    renderEditor({ allocations: ALLOCATIONS });
    const remove = within(row(0)).getByRole('button', { name: 'allocation.remove' });
    const subjects: [HTMLElement, string[], string[]][] = [
      [row(0), PRE_P13.row, []],
      [percents()[0].parentElement as HTMLElement, PRE_P13.percent, []],
      ...PICKERS.map(
        (p) => [picker(0, p), PRE_P13.picker, []] as [HTMLElement, string[], string[]],
      ),
      [remove, PRE_P13.remove, REMOVE_BOX],
    ];
    for (const [el, before, accepted] of subjects) {
      const now = [...el.classList].filter((c) => !c.startsWith('pointer-coarse:'));
      for (const c of before) {
        expect({ c, kept: now.includes(c) || now.includes(`lg:${c}`) }).toEqual({ c, kept: true });
      }
      for (const c of now.filter((x) => !isAt(x) && !before.includes(x) && !accepted.includes(x))) {
        expect({ c, known: c in AT_LG }).toEqual({ c, known: true });
        const reset = AT_LG[c];
        if (reset) expect({ c, reset: now.includes(reset) }).toEqual({ c, reset: true });
      }
    }
    // And nothing that would wrap the restored row.
    expect(row(0)).not.toHaveClass('flex-wrap', 'lg:flex-wrap');
  });

  it('floors every control at 44px on a coarse pointer, and only on a coarse pointer', () => {
    /**
     * The percent is a plain `Input`, so `pointer-coarse:h-11` lands on the `<input>`.
     * VeloExpense: the pickers are the kit's `Combobox`, a `<button role="combobox">` that
     * takes `className` itself, so `TAP_FIELD`'s bare half floors it directly (ExpenseOS's
     * Base UI input is reached by the descendant half instead).
     */
    renderEditor({ allocations: ALLOCATIONS });

    for (const percent of percents()) expect(percent).toHaveClass('pointer-coarse:h-11');
    for (const placeholder of PICKERS) {
      const triggers = pickersIn(document, placeholder);
      expect(triggers).toHaveLength(2);
      for (const trigger of triggers) {
        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger).toHaveClass('pointer-coarse:h-11');
      }
    }
    for (const button of [
      ...screen.getAllByRole('button', { name: 'allocation.remove' }),
      screen.getByRole('button', { name: 'allocation.add' }),
    ]) {
      expect(button).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:min-w-11');
    }
    for (const el of [card(), ...card().querySelectorAll('*')]) {
      const bare = [...el.classList].filter((c) => BARE_FLOOR.test(c));
      expect(bare).toEqual([]);
    }
  });

  it('keeps the coding warning visible at every width', () => {
    // A started, incomplete row: the sentence that explains the submit blocker.
    renderEditor({ allocations: [{ ...ALLOCATIONS[0], percentBp: 10000, classId: null }] });
    uncloaked(screen.getByText('allocation.required'));
  });
});

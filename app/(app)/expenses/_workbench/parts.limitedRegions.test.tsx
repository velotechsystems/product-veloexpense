import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The `limited` suppression inside `ExpenseEditor` — the ONE `SectionNotice` at the top of
 * the pane, and the three regions that render BOTH faces.
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
 *   1. **Always both, on a draft; the editable face alone never appears without its
 *      read-only twin.** Catches a future edit that "tidies up" the duplication by
 *      restoring the `editable ?` ternary, which would leave a phone reader with three
 *      60px comboboxes instead of the figures.
 *   1b. **Exactly one notice, and it is the FIRST thing in the pane.** This file used to
 *      pin three (four with attendees), one beside each suppressed region. On a 664px
 *      screen that read as four copies of one sentence, so the operator asked for it once
 *      at the top and nowhere else. The count and the POSITION are both pinned: a notice
 *      that drifts below the read-only values explains them after the reader has already
 *      passed them, and a second one anywhere is the regression this replaced.
 *   2. **`hidden lg:contents`, never `lg:block`.** ADR-0005 D3 measured `block` moving 4 of
 *      154 rectangles. These regions are flex children of `ExpenseEditor`'s
 *      `flex flex-col gap-3 p-3`, so a `block` wrapper becomes the flex item and every
 *      `flex-1`, `min-h-0` and `gap` inside it resolves against the wrapper. `contents`
 *      generates no box, so the desktop layout is untouched.
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
/** Every element carrying a `lg:contents` cloak, as class strings. */
const cloaks = (root: HTMLElement) =>
  [...root.querySelectorAll('[class*="lg:contents"]')].map((el) => el.className);

beforeEach(() => {
  h.calls = {};
  h.queries = { dimensionOptions: DIMENSIONS };
});

describe('the one `limited` notice', () => {
  it('says it once on a draft report, whatever the expense contains', () => {
    /**
     * ONE, not one per region. Cost allocation, expense tax, line items and (with a
     * category that needs them) attendees are all suppressed below `lg` and all named by
     * this single notice; the count must not move when the expense grows a region.
     */
    renderEditor();
    expect(notices()).toHaveLength(1);

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
    expect(notices()).toHaveLength(1);
  });

  it('puts it at the top of the pane, above the read-only fields', () => {
    /**
     * Position, not just presence. The notice is the frame for everything under it, so it
     * has to be met BEFORE the read-only values it explains — a reader who finds it after
     * scrolling past a vendor they cannot edit has already formed the other conclusion.
     *
     * `compareDocumentPosition` rather than an index into `children`, because the sibling
     * ahead of the read-only grid changes with the fixture (the violations block appears
     * only when there are violations) and the claim is about ORDER, not about slot.
     */
    renderEditor();
    const [notice] = notices();
    const readOnlyVendor = screen.getByText('workbench.vendor:');
    expect(notice.compareDocumentPosition(readOnlyVendor)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('leaves none of them behind in the regions that used to carry one', () => {
    /**
     * The four that were removed sat INSIDE the cost-allocation card, the tax panel, the
     * line-items block and the attendees block. Asserting the count alone would pass if
     * one were removed and another added, so this asserts the shape as well: the only
     * notice in the tree is a child of the pane's own column, not of any cloaked region's
     * container.
     */
    const { container } = renderEditor({
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
    const [notice] = notices();
    // Nothing between the notice and the pane column: no card, no panel, no heading block.
    expect(notice.parentElement).toBe(container.querySelector('.flex.flex-col.gap-3.p-3'));
    for (const card of container.querySelectorAll('.rounded-md.border.border-border.p-3')) {
      expect(card.querySelector('[data-testid="section-limited-notice"]')).toBeNull();
    }
  });

  it('says nothing on a submitted report, because this viewport suppressed nothing there', () => {
    /**
     * `editable === false` still means exactly what it meant: the server will not accept a
     * mutation on this report. The editing controls are absent at EVERY width, so a notice
     * reading "changing them is a desktop task" would be blaming the screen for a refusal
     * the status made. Nothing is cloaked either — there is nothing to cloak.
     */
    renderEditor({}, { editable: false });
    expect(notices()).toHaveLength(0);
    // Not one editing control exists, at any width — which is the claim that matters, and
    // the one SEC-1 rests on: nothing here is a client-side permission, and the server
    // re-derives the same predicate from `EDITABLE_REPORT_STATUSES` on every write.
    expect(screen.queryByLabelText('workbench.vendor')).toBeNull();
    expect(screen.queryAllByLabelText(/^line\.gst/)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'drawer.addLine' })).toBeNull();
  });

  it('re-offers nothing in a smaller form — no input, no combobox, no `Field` in a notice', () => {
    // "What is suppressed is suppressed." A notice that grew a control would be the
    // three-60px-comboboxes outcome the ruling exists to prevent.
    renderEditor();
    for (const notice of notices()) {
      expect(notice.querySelector('input,select,textarea,label,[role="combobox"]')).toBeNull();
    }
  });
});

describe('the always-both regions', () => {
  it('keeps both faces in the DOM on a draft report', () => {
    /**
     * The whole point of CSS selection: at no width is either face unmounted, so dragging
     * a desktop window across 1024px cannot discard a half-typed value. jsdom sees both,
     * which is exactly what this asserts.
     */
    renderEditor();

    // Editable faces.
    expect(screen.getByLabelText('workbench.vendor')).toBeInTheDocument();
    // A regex, because `Field` labels by WRAPPING and `MoneyInput` puts the currency
    // symbol inside that wrapper — so the tax fields' accessible name is "line.gst $",
    // not "line.gst". Worth knowing: it means no `getByLabel('GST/HST')` in the browser
    // suite could have matched them exactly either.
    expect(screen.getAllByLabelText(/^line\.gst/)).toHaveLength(1);
    // Read-only faces, as prose rather than as fields.
    expect(screen.getByText('workbench.vendor:')).toBeInTheDocument();
    expect(screen.getByText('line.gst:')).toBeInTheDocument();
    // The read-only line row, which was an early return and is now also a twin.
    // VeloExpense: the editable face's kit Combobox shows the same label as its text (an
    // input's value in ExpenseOS), so the read-only one is the copy outside a combobox.
    expect(
      screen.getAllByText('Travel - Meals').filter((el) => !el.closest('[role="combobox"]')),
    ).toHaveLength(1);
  });

  it('cloaks with `hidden lg:contents` and never with `lg:block`', () => {
    /**
     * ADR-0005 D3, and `DesktopOnlyNotice`'s header carries the argument in full. `block`
     * inserts a box between these regions and `ExpenseEditor`'s `flex flex-col gap-3`
     * parent; `contents` generates no box at all, so the desktop layout is byte-identical.
     */
    const { container } = renderEditor();
    const found = cloaks(container);
    expect(found.length).toBeGreaterThan(0);
    for (const className of found) expect(className).toContain('hidden lg:contents');
    expect(container.querySelector('[class*="lg:block"]')).toBeNull();

    // And the notices are the other half of the pair.
    for (const notice of notices()) expect(notice.className).toContain('lg:hidden');
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
 * The cost-allocation read-only twin — the operator round's first request.
 *
 * What a phone was shown before this was the allocation card's HEAD and nothing else: a
 * heading, a "% / 100 %" total, and — when a row was half-coded — a warning saying the
 * coding was required. So the reader was told there was a problem with the allocation
 * and never shown the allocation. That is the one shape of suppression the ruling
 * rejects: the notice's promise is "these values are current and can be read here", not
 * "something is unavailable".
 *
 * Same limits as every other case in this file: the mechanism is CSS, jsdom applies no
 * CSS, so what is asserted is the DOM and the class on it. `lg:hidden` on the twin and
 * `hidden lg:contents` on the editor is the pair that means "this face below `lg`, that
 * one above".
 */
describe('the cost-allocation twin', () => {
  const allocations = [
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

  /** The twin's row carrying a given dimension string. */
  const rowFor = (dims: string) => screen.getAllByText(dims)[0].closest('li') as HTMLElement;

  it('renders a line per allocation, with its share, its money and its dimensions', () => {
    /**
     * The money column is the half the `!editable` arm never had. "60 %" alone is not
     * what a reader is checking — "60 % of what" is — and every other figure on this
     * pane is already money. It is derived from the expense's own total by the same
     * basis-point arithmetic the server allocates with, never stored.
     */
    renderEditor({ allocations });

    const first = rowFor('Atlantic · Engineering · Internal');
    expect(first.textContent).toContain('60%');
    expect(first.textContent).toContain('69.00');
    // 11500 minor split 60/40 — the second row is the other 46.00, not a repeat.
    const bothRows = screen.getAllByText('Atlantic · Engineering · Internal');
    expect(bothRows).toHaveLength(2);
    expect((bothRows[1].closest('li') as HTMLElement).textContent).toContain('46.00');
    expect((bothRows[1].closest('li') as HTMLElement).textContent).toContain('40%');
  });

  it('shows it below `lg` and hands the width above it to the editor', () => {
    /**
     * `lg:hidden` on the twin, `hidden lg:contents` on the row set — the same pair as
     * the field grid and the tax panel, and BOTH stay in the DOM so a desktop window
     * dragged across 1024px never unmounts a half-typed percentage.
     */
    renderEditor({ allocations });

    const twin = rowFor('Atlantic · Engineering · Internal').closest('ul') as HTMLElement;
    expect(twin.className).toContain('lg:hidden');
    // And the editable face is still there, cloaked rather than replaced.
    expect(screen.getAllByLabelText('allocation.percent')).toHaveLength(2);
    expect(
      (
        screen
          .getAllByLabelText('allocation.percent')[0]
          .closest('[class*="lg:contents"]') as HTMLElement | null
      )?.className,
    ).toContain('hidden lg:contents');
  });

  it('says an uncoded expense is uncoded, rather than showing an empty box', () => {
    /**
     * The default fixture has no allocations at all, which is exactly the state that
     * blocks a submit downstream. The head's "100 % / 100 %" is the EDITOR's own row
     * total and says nothing about coding; this line is what tells the reader what is
     * actually wrong, and it is the same sentence the approver gets on a submitted
     * report.
     */
    renderEditor();
    const none = screen.getByText('allocation.none');
    expect(none.className).toContain('lg:hidden');
  });

  it('is the same markup on a submitted report, with no cloak on it', () => {
    /**
     * One piece of markup serving two conditions, as `ExpenseFieldsReadOnly` and
     * `TaxFiguresReadOnly` already do. On a submitted report it is the only face there
     * is, so it carries no `lg:hidden` and nothing is cloaked beside it.
     */
    renderEditor({ allocations }, { editable: false });

    const twin = rowFor('Atlantic · Engineering · Internal').closest('ul') as HTMLElement;
    expect(twin.className).not.toContain('lg:hidden');
    expect(screen.queryAllByLabelText('allocation.percent')).toHaveLength(0);
  });

  it('carries no `Field`, no input and no restricted `aria-label`', () => {
    /**
     * `Percent` is the name at risk here: on a draft report the twin renders at the same
     * time as the `allocation.percent`-labelled input the cloak merely hides, and
     * Playwright's label engine has no visibility filter. One labelled control, still.
     */
    renderEditor({ allocations });

    const twin = rowFor('Atlantic · Engineering · Internal').closest('ul') as HTMLElement;
    expect(
      twin.querySelector('input,select,textarea,label,[aria-label],[role="combobox"]'),
    ).toBeNull();
  });
});

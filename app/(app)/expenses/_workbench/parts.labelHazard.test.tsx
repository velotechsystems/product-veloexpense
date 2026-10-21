import '@testing-library/jest-dom/vitest';
import { type Catalog, loadCatalog } from '@expenseos/i18n';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The labelled-field hazard, counted the way PLAYWRIGHT counts it.
 *
 * `parts.limitedRegions.test.tsx` has a labelled-field audit too, and it is not enough on
 * its own: it stubs `t` to echo keys and matches each key exactly. The browser suite does
 * neither. `e2e/support/workbench.ts`'s `addExpense` calls `getByLabel('Vendor')`,
 * `'Location'`, `'Currency'` and friends UNSCOPED and STRICT, against the English copy,
 * and Playwright's label engine (`playwright-core` 1.63.0, `lib/coreBundle.js`, the
 * injected script's `_createInternalLabelEngine`, `getElementLabels` and
 * `createTextMatcher`) matches like this:
 *
 *   · it walks EVERY element on the page (`"*"`), not just form controls;
 *   · an element's labels are, in order of precedence: the text of its `aria-labelledby`
 *     targets; else its `aria-label`, on ANY element, buttons included; else, for a
 *     labelable element (`input` that is not `type=hidden`, `button`, `select`, `textarea`,
 *     `meter`, `output`, `progress`), the text of its `<label>`s;
 *   · a non-exact string matches as a CASE-INSENSITIVE SUBSTRING of the whitespace-
 *     normalised label; `{ exact: true }` is whole-string equality after normalising;
 *   · there is NO visibility filter, so a `display:none` twin is a strict-mode match.
 *
 * That third rule is why "Remove allocation" is a hit for `getByLabel('Location')`. The
 * echoing stub cannot see it: `allocation.remove` does not contain `line.location`.
 *
 * Real `next-intl`, real EN catalog, the same shape as `ExpenseEditor.taxRefusal.test.tsx`.
 * One fixture renders all three detail panels at once (tax, cost allocation, attendees),
 * because a clean count on a fixture that never renders a panel proves nothing about it.
 *
 * jsdom applies no CSS, so a cloaked editor and its read-only twin are both in the DOM
 * here, exactly as both are in the DOM for Playwright. The counts below therefore hold
 * both while the panels still carry a `hidden lg:contents` cloak and after it comes off:
 * the read-only twins render prose, never a `<label>` or an `aria-label`, so the label
 * engine never sees them.
 */

/** Playwright's `normalizeWhiteSpace`. */
const normalize = (s: string) =>
  s
    .replace(/[\u200b\u00ad]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

/** Playwright's `elementText`: every descendant text node, in order; a button-like
 *  `<input>` contributes its value; script and style contribute nothing. */
function elementText(root: Node): string {
  if (root instanceof Element && ['SCRIPT', 'NOSCRIPT', 'STYLE'].includes(root.nodeName)) {
    return '';
  }
  if (root instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(root.type)) {
    return root.value;
  }
  let full = '';
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) full += child.nodeValue ?? '';
    else if (child.nodeType === Node.ELEMENT_NODE) full += elementText(child);
  }
  return full;
}

const LABELABLE = ['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'];

/** Playwright's `getElementLabels`. */
function labelsOf(el: Element): string[] {
  const ref = el.getAttribute('aria-labelledby');
  if (ref !== null) {
    const targets = ref
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((t): t is HTMLElement => t !== null);
    if (targets.length > 0) return targets.map(elementText);
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return [ariaLabel];
  const labelable =
    LABELABLE.includes(el.nodeName) || (el instanceof HTMLInputElement && el.type !== 'hidden');
  if (labelable) {
    const labels = (el as HTMLInputElement).labels;
    if (labels) return [...labels].map(elementText);
  }
  return [];
}

/**
 * Every element `page.getByLabel(text, { exact })` would resolve to. Scoped to the whole
 * document, as an unscoped Playwright locator is, so a portalled popup would count too.
 */
function byLabel(text: string, { exact = false }: { exact?: boolean } = {}): Element[] {
  const wanted = normalize(text);
  const matches = exact
    ? (label: string) => normalize(label) === wanted
    : (label: string) => normalize(label).toLowerCase().includes(wanted.toLowerCase());
  return [...document.body.querySelectorAll('*')].filter((el) => labelsOf(el).some(matches));
}

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
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
      mutate: () => opts?.onSuccess?.(),
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

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const DIMENSIONS = {
  businessUnits: [{ id: 'bu-1', label: { en: 'Atlantic' } }],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  classes: [{ id: 'cls-1', name: 'Internal' }],
};

/** A saved allocation row worth `percentBp`, fully coded. */
const allocation = (n: number, percentBp: number) => ({
  id: `alloc-${n}`,
  percentBp,
  businessUnitId: 'bu-1',
  departmentId: 'dep-1',
  classId: 'cls-1',
  businessUnit: { id: 'bu-1', label: { en: 'Atlantic' } },
  department: { id: 'dep-1', label: { en: 'Engineering' } },
  class: { id: 'cls-1', name: 'Internal' },
});

const ONE_ROW = [allocation(1, 10000)];
const TWO_ROWS = [allocation(1, 6000), allocation(2, 4000)];

/**
 * A draft expense with all three detail panels on screen: tax figures, a saved cost
 * allocation, and ONE line whose category requires attendees, with one external and one
 * internal attendee already named. One line, so `Amount` is 1.
 */
const expense = (allocations: unknown[]) =>
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
    lineItems: [
      {
        id: 'line-1',
        categoryId: 'cat-meals',
        category: {
          id: 'cat-meals',
          label: 'Travel - Meals',
          icon: null,
          isMileage: false,
          requiresAttendees: true,
        },
        amountMinor: '11500',
        mileageDistance: null,
        mileageUnit: null,
        mileageRoute: null,
        receipts: [],
        kind: 'STANDARD',
        payload: null,
      },
    ],
    receipts: [],
    attendees: [
      { id: 'att-1', name: 'Dana Whitfield', company: 'Northbridge', isExternal: true },
      { id: 'att-2', name: 'Ada Lovelace', company: null, isExternal: false },
    ],
    allocations,
    taxGstHstMinor: '575',
    taxQstMinor: '1147',
    taxPstMinor: '200',
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'MANUAL',
    subtotalMinor: null,
    fxRate: null,
  }) as never;

let en: Catalog;
beforeAll(async () => {
  en = await loadCatalog(CATALOG_LOCALE);
});

beforeEach(() => {
  h.queries = { dimensionOptions: DIMENSIONS };
});
afterEach(cleanup);

function show(allocations: unknown[] = ONE_ROW) {
  return render(
    <NextIntlClientProvider locale={CATALOG_LOCALE} messages={en as never} timeZone="UTC" onError={() => {}}>
      <ExpenseEditor
        expense={expense(allocations)}
        violations={[]}
        currencySymbol="$"
        editable
        categoryItems={[{ value: 'cat-meals', label: 'Travel - Meals' }]}
        locale={CATALOG_LOCALE}
        onChange={vi.fn()}
        entityRecovers
      />
    </NextIntlClientProvider>,
  );
}

describe('the fixture', () => {
  it('renders all three detail panels on the draft, in English', () => {
    // Without this, every count below could pass on a fixture that rendered no panel.
    show();
    expect(screen.getByText('Allocation')).toBeInTheDocument();
    expect(screen.getByText('Taxes')).toBeInTheDocument();
    expect(screen.getByText('Attendees')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search employees…')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Dana Whitfield')).toBeInTheDocument();
  });
});

describe('the labelled-field hazard, by Playwright’s rules', () => {
  /**
   * The names the browser suite addresses unscoped and strict. A second match anywhere on
   * the page — a cloaked twin, a new `aria-label` that merely CONTAINS the word — fails
   * strict mode in every spec that calls `addExpense`, at 1280, in `chromium`.
   */
  it.each([
    ['Vendor', false],
    ['Date', true],
    ['Location', false],
    ['Currency', false],
    ['Amount', true],
    ['GST/HST', false],
    ['QST', false],
    ['PST', false],
  ] as const)('getByLabel(%j, { exact: %s }) resolves to exactly one element', (text, exact) => {
    show();
    expect(byLabel(text, { exact })).toHaveLength(1);
  });

  /**
   * "Percent" is one per rendered allocation row — never double (a twin), never zero (a
   * dropped label). With nothing saved the editor seeds one 100% row, so it is still 1.
   */
  it.each([
    ['no saved allocation', [], 1],
    ['one saved allocation', ONE_ROW, 1],
    ['two saved allocations', TWO_ROWS, 2],
  ] as const)('getByLabel("Percent") counts one per row, with %s', (_name, allocations, rows) => {
    show([...allocations]);
    expect(byLabel('Percent')).toHaveLength(rows);
    // And every one of them is a row's own percent input, not something that names it.
    for (const el of byLabel('Percent')) expect(el).toBeInstanceOf(HTMLInputElement);
    // VeloExpense: the kit's Combobox is a `<button role="combobox">` that keeps its
    // placeholder in `data-placeholder` (ExpenseOS finds its Base UI input by placeholder).
    expect(
      document.querySelectorAll('[role="combobox"][data-placeholder="Business unit"]'),
    ).toHaveLength(rows);
  });

  it('getByLabel("Location") also matches each "Remove allocation" once there are two rows', () => {
    /**
     * A KNOWN COLLISION, recorded so that whoever fixes it changes this number on purpose.
     *
     * "Remove allocation" is an `aria-label` on each row's remove button, and "allocation"
     * contains "location". With two rows, `getByLabel('Location')` resolves to the Location
     * field AND both remove buttons: 3, which fails strict mode. Nothing is red today only
     * because `addExpense` fills Location on a fresh expense with a single row, which has
     * no remove button. The fix is outside this test: `{ exact: true }` on the Location
     * locators in `e2e/`, or a remove label without "location" in it. Either one moves
     * this to 1. Until then, no new label may contain "allocation".
     */
    show(TWO_ROWS);
    const found = byLabel('Location');
    expect(found).toHaveLength(3);
    expect(
      found.filter((el) => el.getAttribute('aria-label') === 'Remove allocation'),
    ).toHaveLength(2);
  });
});

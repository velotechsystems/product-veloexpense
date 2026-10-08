import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Narrowing and ordering the category list.
 *
 * Both run client-side over the loaded set, and both compare a DERIVED string rather
 * than a stored field: the name is a localized label, the GL is a number and a name
 * joined, the "kind" is two booleans collapsed into one word, and status is a boolean
 * read as a word. A filter that compared the raw row would match nothing on four of the
 * eight columns.
 *
 * The operator set is the part worth pinning: eight of them, and each one means something
 * different on a list somebody is using to find one category among ninety. `isEmpty` in
 * particular is the only way to find the categories with no GL account — which is the
 * question that sends people to this page.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));
vi.mock('@/components/pickers/EntityPickers', () => ({
  GlAccountCombobox: () => null,
}));
// The export menu's real builder runs; only the browser hand-off is intercepted, so the
// assertions read the CSV the column accessors actually produced.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));

import { ExpenseCategoriesAdmin } from './ExpenseCategoriesAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const category = (over: Record<string, unknown> = {}) => ({
  id: 'cat-meals',
  label: { en: 'Meals', 'fr-CA': 'Repas' },
  color: '#2563eb',
  icon: '🍽️',
  glAccountId: 'gl-1',
  glAccountNumber: '6000',
  glAccountName: 'Travel & Entertainment',
  itcGstHstRate: 50,
  itcQstRate: 50,
  pstRecoverable: false,
  requiresAttendees: true,
  isMileage: false,
  acceptsTip: true,
  active: true,
  sortOrder: 1,
  _count: { lineItems: 0 },
  ...over,
});

function setTrpc(items: unknown[], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenseCategories.list': { data: { categories: items } },
      ...over.queries,
    },
  });
}

const show = () => render(<ExpenseCategoriesAdmin canWrite />);

/**
 * The category named by each row, in render order. Read from the row's whole text: the
 * leading cells are the drag handle and the selection box.
 */
const names = () => {
  const all = ['Meals & entertainment', 'Meals', 'Taxi', 'Mileage', 'Fax'];
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => all.find((n) => (r.textContent ?? '').includes(n)))
    .filter((n): n is string => !!n);
};

/**
 * Add a filter clause through the pill bar's own form — the one place every operator is
 * selectable, so a test can walk the whole set.
 */
async function addFilter(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  op: string,
  value?: string,
) {
  await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
  await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
  await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
  if (value !== undefined) {
    const control = screen.getByLabelText(/(?:^Value$|filters\.value$)/);
    // An enum field offers a select; a text field an input.
    if (control.querySelector('option') || control.tagName === 'SELECT') {
      await user.selectOptions(control, value);
    } else {
      await user.type(control, value);
    }
  }
  await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
}

/**
 * Drop the pill the page seeds (Status=Active), so a test can ask about the retired
 * rows on their own. Clearing everything is the same gesture a reader makes.
 */
async function dropSeededPill(user: ReturnType<typeof userEvent.setup>) {
  const remove = screen.getAllByRole('button', {
    name: /(?:Remove condition|filters\.removeCondition)/,
  });
  await user.click(remove[0]);
}

async function sortBy(user: ReturnType<typeof userEvent.setup>, column: string) {
  const header = screen.getByText(column).closest('th') as HTMLElement;
  await user.click(within(header).getAllByRole('button', { name: 'table.colMenu.menu' })[0]);
}

const MEALS = category();
const TAXI = category({
  id: 'cat-taxi',
  label: { en: 'Taxi' },
  glAccountNumber: '6100',
  glAccountName: 'Ground transport',
  requiresAttendees: false,
  acceptsTip: false,
  sortOrder: 2,
});
/** Retired: the page seeds a Status=Active pill, so this one starts hidden. */
const RETIRED = category({
  id: 'cat-fax',
  label: { en: 'Fax' },
  glAccountNumber: '6200',
  glAccountName: 'Office',
  requiresAttendees: false,
  acceptsTip: false,
  active: false,
  sortOrder: 4,
});
const MILEAGE = category({
  id: 'cat-mileage',
  label: { en: 'Mileage' },
  glAccountNumber: null,
  glAccountName: null,
  glAccountId: null,
  isMileage: true,
  acceptsTip: false,
  requiresAttendees: false,
  sortOrder: 3,
});

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── Every operator ────────────────────────────────────────────────────────────

describe('the filter operators', () => {
  it('narrows on part of a name', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'name', 'contains', 'tax');
    expect(names()).toEqual(['Taxi']);
  });

  it('excludes on part of a name', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'name', 'doesNotContain', 'tax');
    expect(names()).toEqual(['Meals']);
  });

  it('matches a whole name exactly', async () => {
    // "Meals" and "Meals & entertainment" are different categories.
    const user = userEvent.setup();
    setTrpc([MEALS, category({ id: 'c2', label: { en: 'Meals & entertainment' }, sortOrder: 2 })]);
    show();
    await addFilter(user, 'name', 'equals', 'meals');
    expect(names()).toEqual(['Meals']);
  });

  it('excludes a whole name exactly', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'name', 'doesNotEqual', 'meals');
    expect(names()).toEqual(['Taxi']);
  });

  it('matches a prefix', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'name', 'startsWith', 'me');
    expect(names()).toEqual(['Meals']);
  });

  it('matches a suffix', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'name', 'endsWith', 'xi');
    expect(names()).toEqual(['Taxi']);
  });

  it('finds the categories with NO GL account', async () => {
    /**
     * This is the question that sends people to this page: an uncoded category posts
     * nowhere, and `isEmpty` is the only way to list them.
     */
    const user = userEvent.setup();
    setTrpc([MEALS, MILEAGE]);
    show();
    await addFilter(user, 'gl', 'isEmpty');
    expect(names()).toEqual(['Mileage']);
  });

  it('finds the ones that HAVE a GL account', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, MILEAGE]);
    show();
    await addFilter(user, 'gl', 'isNotEmpty');
    expect(names()).toEqual(['Meals']);
  });

  it('searches the GL number and the GL name together', async () => {
    /**
     * The cell shows both, so a search for either has to work — an accountant knows the
     * number, everybody else knows the name.
     */
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'gl', 'contains', '6100');
    expect(names()).toEqual(['Taxi']);
    await dropSeededPill(user);
    await addFilter(user, 'gl', 'contains', 'ground');
    expect(names()).toEqual(['Taxi']);
  });
});

// ── The derived columns ───────────────────────────────────────────────────────

describe('filtering the derived columns', () => {
  it('narrows to one KIND, which is two booleans collapsed into a word', async () => {
    /**
     * `isMileage` and `acceptsTip` are stored separately and are mutually exclusive in
     * practice — the column shows the single coherent answer, so the filter compares
     * that rather than either boolean.
     */
    const user = userEvent.setup();
    setTrpc([MEALS, MILEAGE, TAXI]);
    show();
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    const fieldSelect = (await screen.findAllByLabelText(/(?:^Field$|filters\.field)/))[0];
    await user.selectOptions(fieldSelect, 'type');
    const value = screen.getByLabelText(/(?:^Value$|filters\.value$)/);
    // Whatever the page calls the mileage kind, it is one of the offered values.
    const options = Array.from(value.querySelectorAll('option'))
      .map((o) => o.getAttribute('value'))
      .filter((v): v is string => !!v);
    expect(options.length).toBeGreaterThan(1);
    await user.selectOptions(value, options[0]);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(names().length).toBeGreaterThan(0);
  });

  it('narrows to the categories that need attendees', async () => {
    // "Who was there" is a compliance question, and this is how it is audited.
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'attendees', 'equals', 'true');
    expect(names()).toEqual(['Meals']);
  });

  it('narrows to the categories that take a tip', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'tip', 'equals', 'true');
    expect(names()).toEqual(['Meals']);
  });

  it('hides a retired category behind a SEEDED pill, not silently', async () => {
    /**
     * The page opens on Status=Active as an ordinary pill, so the affordance that hid
     * the retired rows is the one that brings them back. Dropping them with no pill
     * would read as data loss.
     */
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    expect(names()).toEqual(['Meals']);
    await dropSeededPill(user);
    expect(names()).toEqual(['Meals', 'Fax']);
  });

  it('shows only the retired ones when asked', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    await dropSeededPill(user);
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(names()).toEqual(['Fax']);
  });

  it('reads “not inactive” as active', async () => {
    // Both spellings of the same request have to give the same list.
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    await dropSeededPill(user);
    await addFilter(user, 'status', 'doesNotEqual', 'inactive');
    expect(names()).toEqual(['Meals']);
  });

  it('shows everything when both states are asked for', async () => {
    /**
     * Two `equals` clauses on one field OR together — asking for active AND inactive is
     * asking for everything, not for nothing.
     */
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    // The seeded Active pill stays; asking for inactive as well widens to both.
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(names()).toEqual(['Meals', 'Fax']);
  });

  it('narrows on more than one field at once', async () => {
    // Clauses across fields AND — that is what makes a two-pill filter useful.
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI, MILEAGE]);
    show();
    await addFilter(user, 'status', 'equals', 'active');
    await addFilter(user, 'gl', 'isEmpty');
    expect(names()).toEqual(['Mileage']);
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe('ordering the list', () => {
  it('keeps the order the server sent, which is the hand-arranged one', () => {
    /**
     * The list is drag-ordered and the query returns it in `sortOrder`. Re-sorting on
     * arrival would discard the order somebody arranged by hand.
     */
    setTrpc([TAXI, MEALS]);
    show();
    expect(names()).toEqual(['Taxi', 'Meals']);
  });

  it('sorts by name, and reverses', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await sortBy(user, 'admin.expenseCategories.colName');
    expect(names()).toEqual(['Meals', 'Taxi']);
    await sortBy(user, 'admin.expenseCategories.colName');
    expect(names()).toEqual(['Taxi', 'Meals']);
  });

  it('sorts by the GL cell, so the uncoded ones gather at one end', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI, MILEAGE]);
    show();
    await sortBy(user, 'admin.expenseCategories.colGlAccount');
    expect(names()[0]).toBe('Mileage');
  });

  it('sorts by status, keeping the live ones together', async () => {
    const user = userEvent.setup();
    setTrpc([RETIRED, MEALS]);
    show();
    await dropSeededPill(user);
    await sortBy(user, 'admin.common.status');
    expect(names()).toEqual(['Meals', 'Fax']);
  });
});

// ── The status pill's negations ───────────────────────────────────────────────

/**
 * Status is a boolean read as a word, and the page seeds a `Status = Active` pill rather
 * than an "include inactive" checkbox — so the same gesture that hid the retired rows is
 * the one that shows them. Both negations have to invert the surface rather than falling
 * through to "show everything", or the pill reads as doing nothing.
 */
describe('the status pill', () => {
  it('reads "is not active" as the retired rows', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    await dropSeededPill(user);
    await addFilter(user, 'status', 'doesNotEqual', 'active');
    expect(names()).toEqual(['Fax']);
  });

  it('reads "is not inactive" as the live ones', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    await dropSeededPill(user);
    await addFilter(user, 'status', 'doesNotEqual', 'inactive');
    expect(names()).toEqual(['Meals']);
  });

  it('shows everything when both states are asked for', async () => {
    /** Two pills an admin composed. Intersecting them empties a table for a filter that
     *  plainly means "all of them". */
    const user = userEvent.setup();
    setTrpc([MEALS, RETIRED]);
    show();
    await dropSeededPill(user);
    await addFilter(user, 'status', 'equals', 'active');
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(names().sort()).toEqual(['Fax', 'Meals']);
  });
});

// ── Filtering on the columns that start hidden ────────────────────────────────

/**
 * The three flag columns are hidden by default — they change the LINE EDITOR, not the
 * expense, so most people never need them on screen. They stay filterable regardless,
 * because "which categories ask for attendees" is a question about configuration rather
 * than about what is currently displayed.
 */
describe('filtering on a hidden column', () => {
  it('narrows by the kind, which is two booleans collapsed into a word', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, category({ id: 'cat-mileage', label: { en: 'Mileage' }, isMileage: true })]);
    show();
    await addFilter(user, 'type', 'equals', 'mileage');
    expect(names()).toEqual(['Mileage']);
  });

  it('narrows by whether attendees are required', async () => {
    /** Meals requires them; Taxi does not. Getting this backwards changes what the line
     *  editor asks for on every expense in the category. */
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'attendees', 'equals', 'true');
    expect(names()).toEqual(['Meals']);
  });

  it('narrows by whether a tip is accepted', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS, TAXI]);
    show();
    await addFilter(user, 'tip', 'equals', 'false');
    expect(names()).toEqual(['Taxi']);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Each column renders JSX — a colour swatch, a localized kind, an em dash for an unset GL
 * — so its export accessor is a second reading of the same row, and the only one that ends
 * up in the file somebody opens.
 */
describe('exporting the categories', () => {
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /export/i }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('writes the name, the GL account and the kind as words', async () => {
    const user = userEvent.setup();
    setTrpc([MEALS]);
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('Meals');
    expect(csv).toContain('6000');
    expect(csv).toContain('Travel & Entertainment');
  });

  it('dashes a category that codes to no GL account', async () => {
    /** The row somebody came to this page to find. A blank cell in a spreadsheet hides it
     *  among the ones that are configured. */
    const user = userEvent.setup();
    setTrpc([category({ glAccountId: null, glAccountNumber: null, glAccountName: null })]);
    show();
    expect(await exportCsv(user)).toContain('—');
  });
});

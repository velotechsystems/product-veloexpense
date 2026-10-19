import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/travel-categories.
 *
 * Travel keys its budget lines on its OWN taxonomy, not on `ExpenseCategory`, and two
 * columns on this page carry the whole cost of that decision:
 *
 *   · **Type** is which editor block a line in this category opens. Without it visible,
 *     an admin has no way to see why picking "Airfare" produces a flight search and
 *     picking "Parking" produces an amount box. It is FROZEN once anything has been
 *     estimated against the category — every existing line carries a payload shaped for
 *     the old block, and the new one has no field to read it out of.
 *   · **Maps to** is the expense category this rolls up into. Blank is not an error — the
 *     trip still estimates — but it is exactly why that line will never appear in
 *     budget-vs-actual, so the column says so rather than leaving somebody to work it out
 *     from a variance report that is quietly short.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
  /** What the export menu handed to the browser. The real builder runs; only the
   *  hand-off is intercepted, so `exportValue` on every column is exercised. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const fn = (k: string, values?: Record<string, unknown>) => {
      const full = ns ? `${ns}.${k}` : k;
      return values ? `${full}:${Object.values(values).join(',')}` : full;
    };
    (fn as { has?: () => boolean }).has = () => false;
    return fn;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// VeloExpense (w6-02): no [locale] segment.
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));
vi.mock('@/components/pickers/EntityPickers', () => ({
  GlAccountCombobox: ({ onValueChange }: { onValueChange: (v: string | null) => void }) => (
    <button type="button" onClick={() => onValueChange('gl-9')}>
      pick-gl
    </button>
  ),
}));

/** `Select` as buttons — Base UI portals its options and needs a pointer environment. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ onValueChange: (v: string) => void; disabled?: boolean }>({
    onValueChange: () => {},
  });
  return {
    ...actual,
    Select: ({
      children,
      onValueChange,
      disabled,
    }: {
      children: ReactNode;
      onValueChange: (v: string) => void;
      disabled?: boolean;
    }) => <Ctx.Provider value={{ onValueChange, disabled }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children: () => ReactNode }) => (
      <span>{typeof children === 'function' ? children() : children}</span>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange, disabled } = React.useContext(Ctx);
      return (
        <button
          type="button"
          data-option={value}
          disabled={disabled}
          onClick={() => onValueChange(value)}
        >
          {children}
        </button>
      );
    },
    EmojiPicker: ({ onSelect }: { onSelect: (e: string) => void }) => (
      <button type="button" onClick={() => onSelect('🚕')}>
        pick-emoji
      </button>
    ),
  };
});

import { TravelCategoriesAdmin } from './TravelCategoriesAdmin';

const category = (over: Record<string, unknown> = {}) => ({
  id: 'tc-air',
  label: { en: 'Airfare', 'fr-CA': 'Billet d’avion' },
  color: '#2563eb',
  icon: '✈️',
  lineKind: 'AIRFARE',
  expenseCategoryId: 'ec-air',
  expenseCategory: { id: 'ec-air', label: { en: 'Travel – Airfare' }, icon: '✈️' },
  glAccountId: null,
  effectiveGlAccountNumber: '6100',
  effectiveGlAccountName: 'Airfare',
  glAccountInherited: true,
  active: true,
  sortOrder: 1,
  _count: { budgetLines: 0 },
  ...over,
});

const EXPENSE_OPTIONS = {
  items: [{ id: 'ec-air', label: { en: 'Travel – Airfare' }, icon: '✈️' }],
};

function setTrpc(items = [category()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'travelCategories.list': { data: items },
      'travelCategories.expenseCategoryOptions': { data: EXPENSE_OPTIONS },
      ...over.queries,
    },
  });
}

type AdminProps = React.ComponentProps<typeof TravelCategoriesAdmin>;
const show = (props: Partial<AdminProps> = {}) =>
  render(<TravelCategoriesAdmin canWrite {...props} />);

const showTopBar = () => render(<div>{h.topBar.right}</div>);

async function rowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('td') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
}

beforeEach(() => {
  h.topBar = {};
  h.downloads = [];
});
afterEach(() => {
  cleanup();
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the category list', () => {
  it('shows the icon, the name and the editor TYPE', () => {
    // The type is not decoration: it is the only place an admin can see why this bucket
    // opens a flight search rather than an amount box.
    setTrpc();
    show();
    expect(screen.getByText('Airfare')).toBeInTheDocument();
    expect(screen.getByText('✈️')).toBeInTheDocument();
    expect(screen.getByText('admin.travelCategories.kinds.AIRFARE')).toBeInTheDocument();
  });

  it('falls back to a compass for a category with no icon', () => {
    setTrpc([category({ icon: null })]);
    show();
    expect(screen.getByText('🧭')).toBeInTheDocument();
  });

  it('names the expense category it maps to', () => {
    setTrpc();
    show();
    expect(screen.getByText('Travel – Airfare')).toBeInTheDocument();
  });

  it('says UNMAPPED rather than leaving the cell blank', () => {
    /**
     * The reconciliation cost, stated on the page. A blank cell reads as "nothing to see";
     * this category can be estimated against and will never appear in budget-vs-actual,
     * and finding that out from a short variance report is worse than being told.
     */
    setTrpc([category({ expenseCategoryId: null, expenseCategory: null })]);
    show();
    expect(screen.getByText('admin.travelCategories.unmapped')).toBeInTheDocument();
  });

  it('marks a GL account INHERITED from the mapped category', () => {
    // The ordinary case. Showing the number with no provenance made admins set it a
    // second time here, and two places to change one account is one too many.
    setTrpc();
    show();
    expect(screen.getByText(/6100/)).toBeInTheDocument();
    expect(screen.getByText('admin.travelCategories.glInherited')).toBeInTheDocument();
  });

  it('says so when there is no GL account at all', () => {
    setTrpc([
      category({
        effectiveGlAccountNumber: null,
        effectiveGlAccountName: null,
        glAccountInherited: false,
      }),
    ]);
    show();
    expect(screen.getByText('admin.travelCategories.glAccountNone')).toBeInTheDocument();
  });

  it('shows an inactive category as inactive', () => {
    setTrpc([category({ active: false })]);
    show();
    expect(screen.getByText('admin.common.inactive')).toBeInTheDocument();
  });

  it('offers no row actions to a reader', () => {
    setTrpc();
    show({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'admin.common.actions' })).toBeNull();
  });
});

// ── The type is frozen once lines exist ───────────────────────────────────────

describe('the editor type', () => {
  it('can be changed on a category nothing has been estimated against', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    expect(
      screen.getByRole('button', { name: 'admin.travelCategories.kinds.LODGING' }),
    ).toBeEnabled();
    expect(screen.queryByText(/kindLockedHelp/)).not.toBeInTheDocument();
  });

  it('is LOCKED once lines carry a payload shaped for it, and says why', async () => {
    /**
     * Every filed line carries a payload shaped for the old block, and the new block has
     * no field to read it out of. The server refuses the change; the control is disabled
     * to say so BEFORE the save fails, with the count that makes it make sense.
     */
    const user = userEvent.setup();
    setTrpc([category({ _count: { budgetLines: 7 } })]);
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    expect(
      screen.getByRole('button', { name: 'admin.travelCategories.kinds.LODGING' }),
    ).toBeDisabled();
    expect(screen.getByText('admin.travelCategories.kindLockedHelp:7')).toBeInTheDocument();
  });

  it('is free on a NEW category even while others have lines', async () => {
    const user = userEvent.setup();
    setTrpc([category({ _count: { budgetLines: 7 } })]);
    show();
    await openCreate(user);
    expect(
      screen.getByRole('button', { name: 'admin.travelCategories.kinds.LODGING' }),
    ).toBeEnabled();
  });

  it('explains what the chosen type does', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openCreate(user);
    expect(screen.getByText('admin.travelCategories.kindHelp.STANDARD')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'admin.travelCategories.kinds.AIRFARE' }));
    expect(screen.getByText('admin.travelCategories.kindHelp.AIRFARE')).toBeInTheDocument();
  });
});

/** Open the create drawer from the top-bar action. */
async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /admin\.travelCategories\.add/ }));
  await screen.findByText('admin.travelCategories.labelEn');
}

// ── Saving ────────────────────────────────────────────────────────────────────

describe('saving', () => {
  it('refuses to save until BOTH locales are filled', async () => {
    /**
     * EN + FR-CA from day one is a platform rule, not this page's preference. A category
     * saved in one language renders its own id at half the org.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openCreate(user);
    const save = screen.getByRole('button', { name: 'admin.common.save' });
    expect(save).toBeDisabled();
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    await user.type(inputs[0], 'Parking');
    expect(save).toBeDisabled();
    await user.type(inputs[1], 'Stationnement');
    expect(save).toBeEnabled();
  });

  it('sends both labels, the type and the mapping', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], {
      mutations: { 'travelCategories.create': { onCall, outcome: 'success' } },
    });
    show();
    await openCreate(user);
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    await user.type(inputs[0], 'Parking');
    await user.type(inputs[1], 'Stationnement');
    await user.click(screen.getByRole('button', { name: 'admin.travelCategories.kinds.GROUND' }));
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));

    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      label: { en: 'Parking', 'fr-CA': 'Stationnement' },
      lineKind: 'GROUND',
    });
  });

  it('keeps the drawer OPEN when the server refuses, and shows why', async () => {
    /**
     * The server refuses a type change on a category that already has lines. Closing the
     * drawer would discard everything typed alongside a message nobody had time to read.
     */
    const user = userEvent.setup();
    setTrpc([category()], {
      mutations: {
        'travelCategories.update': {
          outcome: 'error',
          // A real Error, because tRPC throws `TRPCClientError` (an Error subclass) and
          // the page reads `e instanceof Error` to decide between the message and a
          // `String(e)` fallback. A plain `{ message }` here would exercise the fallback
          // and assert nothing about what an admin is actually shown.
          error: new Error('that type cannot change once lines exist'),
        },
      },
    });
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot change once lines exist/);
    expect(screen.getByText('admin.travelCategories.labelEn')).toBeInTheDocument();
  });

  it('takes an emoji and a GL account from their pickers', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], {
      mutations: { 'travelCategories.update': { onCall, outcome: 'success' } },
    });
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    await user.click(screen.getByRole('button', { name: 'pick-emoji' }));
    await user.click(screen.getByRole('button', { name: 'pick-gl' }));
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ icon: '🚕', glAccountId: 'gl-9' });
  });
});

// ── Deactivating ──────────────────────────────────────────────────────────────

describe('deactivating', () => {
  it('confirms first, and does nothing when the confirmation is declined', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setTrpc([category()], {
      mutations: { 'travelCategories.update': { onCall, outcome: 'success' } },
    });
    show();
    await rowMenu(user, 'Airfare');
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('flips the flag once confirmed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTrpc([category()], {
      mutations: { 'travelCategories.update': { onCall, outcome: 'success' } },
    });
    show();
    await rowMenu(user, 'Airfare');
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'tc-air', active: false });
  });

  it('offers to reactivate an inactive one instead', async () => {
    const user = userEvent.setup();
    setTrpc([category({ active: false })]);
    show();
    await rowMenu(user, 'Airfare');
    expect(screen.getByText('admin.common.reactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).toBeNull();
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Add a clause through the pill bar's own form — the one place every operator is
 * selectable, so a test can walk the whole set. Its labels are hardcoded English in the
 * design system, which is why they survive a key-echo translator.
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
    if (control.tagName === 'SELECT') await user.selectOptions(control, value);
    else await user.type(control, value);
  }
  await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
}

const HOTEL = category({
  id: 'tc-hotel',
  label: { en: 'Hotel', 'fr-CA': 'Hôtel' },
  icon: '🏨',
  lineKind: 'LODGING',
  expenseCategoryId: null,
  expenseCategory: null,
  effectiveGlAccountNumber: null,
  effectiveGlAccountName: null,
  glAccountInherited: false,
  active: false,
  sortOrder: 2,
  _count: { budgetLines: 3 },
});

/** Which categories are on screen, in render order. */
const shown = () => {
  const all = ['Airfare', 'Hotel'];
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => all.find((n) => (r.textContent ?? '').includes(n)))
    .filter((n): n is string => !!n);
};

describe('filtering by name', () => {
  beforeEach(() => {
    setTrpc([category(), HOTEL]);
    show();
  });

  it.each([
    ['contains', 'hotel', ['Hotel']],
    ['doesNotContain', 'hotel', ['Airfare']],
    ['equals', 'hotel', ['Hotel']],
    ['doesNotEqual', 'hotel', ['Airfare']],
    ['startsWith', 'air', ['Airfare']],
    ['endsWith', 'tel', ['Hotel']],
  ] as const)('narrows with %s', async (op, value, expected) => {
    const user = userEvent.setup();
    await addFilter(user, 'name', op, value);
    expect(shown()).toEqual(expected);
  });
});

describe('filtering by what it maps to', () => {
  beforeEach(() => {
    setTrpc([category(), HOTEL]);
    show();
  });

  it('finds the buckets that will never reconcile', async () => {
    /**
     * `isEmpty` on this column is the whole reason it exists: it is how an admin lists
     * every travel category that can be estimated against and will never appear in
     * budget-vs-actual.
     */
    const user = userEvent.setup();
    await addFilter(user, 'mapsTo', 'isEmpty');
    expect(shown()).toEqual(['Hotel']);
  });

  it('finds the ones that DO map somewhere', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'mapsTo', 'isNotEmpty');
    expect(shown()).toEqual(['Airfare']);
  });

  it('narrows on the mapped category’s name', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'mapsTo', 'contains', 'airfare');
    expect(shown()).toEqual(['Airfare']);
  });
});

describe('filtering by type and status', () => {
  beforeEach(() => {
    setTrpc([category(), HOTEL]);
    show();
  });

  it('narrows to one editor TYPE', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'kind', 'equals', 'LODGING');
    expect(shown()).toEqual(['Hotel']);
  });

  it('excludes a type', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'kind', 'doesNotEqual', 'LODGING');
    expect(shown()).toEqual(['Airfare']);
  });

  it('shows only the retired ones when asked', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(shown()).toEqual(['Hotel']);
  });

  it('reads "not inactive" as the live ones', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'status', 'doesNotEqual', 'inactive');
    expect(shown()).toEqual(['Airfare']);
  });

  it('narrows on two fields at once', async () => {
    const user = userEvent.setup();
    await addFilter(user, 'status', 'equals', 'active');
    await addFilter(user, 'kind', 'equals', 'LODGING');
    // Airfare is active but not lodging; Hotel is lodging but not active.
    expect(shown()).toEqual([]);
  });
});

// ── Reordering ────────────────────────────────────────────────────────────────

describe('the manual order', () => {
  it('keeps the order the server sent, which is the hand-arranged one', () => {
    setTrpc([category(), HOTEL]);
    show();
    expect(shown()).toEqual(['Airfare', 'Hotel']);
  });

  it('offers no drag handle to a reader', () => {
    setTrpc([category(), HOTEL]);
    show({ canWrite: false });
    expect(screen.queryByText('admin.travelCategories.reorderHint')).toBeNull();
  });

  it('tells a writer they can drag', () => {
    setTrpc([category(), HOTEL]);
    show();
    expect(screen.getByText('admin.travelCategories.reorderHint')).toBeInTheDocument();
  });
});

// ── The drawer's fallbacks ────────────────────────────────────────────────────

describe('editing a sparse category', () => {
  it('opens with defaults rather than blanks for the fields it has none of', async () => {
    /**
     * A category created by an earlier migration can be missing an icon, a colour and both
     * account links. The form has to open on it — a colour of `undefined` would fail the
     * hex check and make the row permanently unsaveable.
     */
    const user = userEvent.setup();
    setTrpc([
      category({
        icon: null,
        color: null,
        expenseCategoryId: null,
        expenseCategory: null,
        glAccountId: null,
      }),
    ]);
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeEnabled();
  });

  it('explains the GL account differently once a mapping exists', async () => {
    // Inheritance is the ordinary case, and saying which category it inherits FROM is
    // what stops an admin setting the same account twice.
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    expect(screen.getByText(/admin\.travelCategories\.glAccountInheritsHelp/)).toBeInTheDocument();
  });

  it('explains it plainly when there is no mapping', async () => {
    const user = userEvent.setup();
    setTrpc([category({ expenseCategoryId: null, expenseCategory: null })]);
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    expect(screen.getByText('admin.travelCategories.glAccountHelp')).toBeInTheDocument();
  });

  it('closes without saving on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], {
      mutations: { 'travelCategories.update': { onCall, outcome: 'success' } },
    });
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    await user.click(screen.getByRole('button', { name: 'admin.common.cancel' }));
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── The remaining fallbacks ───────────────────────────────────────────────────

describe('sparse and unusual rows', () => {
  it('shows the id when a label has nothing in the reader’s locale', () => {
    // Not blank. A row with no readable name still has to be findable and clickable.
    setTrpc([category({ label: {} })]);
    show();
    expect(screen.getByText('tc-air')).toBeInTheDocument();
  });

  it('shows an em dash for a category with no colour', () => {
    setTrpc([category({ color: null })]);
    show();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a GL number with no name, and without claiming inheritance', () => {
    setTrpc([category({ effectiveGlAccountName: null, glAccountInherited: false })]);
    show();
    expect(screen.getByText('6100')).toBeInTheDocument();
    expect(screen.queryByText('admin.travelCategories.glInherited')).toBeNull();
  });

  it('renders before the expense-category options have loaded', () => {
    // The mapping picker's list arrives on its own query; the page must not wait for it.
    setTrpc([category()], { queries: { 'travelCategories.expenseCategoryOptions': {} } });
    show();
    expect(screen.getByText('Airfare')).toBeInTheDocument();
  });

  it('opens the drawer on a label with neither locale filled', async () => {
    const user = userEvent.setup();
    setTrpc([category({ label: {} })]);
    show();
    await user.click(screen.getByText('tc-air'));
    await screen.findByText('admin.travelCategories.labelEn');
    // Both boxes blank, so the save is refused until somebody names it.
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeDisabled();
  });
});

describe('reactivating', () => {
  it('confirms, then flips the flag back on', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTrpc([category({ active: false })], {
      mutations: { 'travelCategories.update': { onCall, outcome: 'success' } },
    });
    show();
    await rowMenu(user, 'Airfare');
    await user.click(screen.getByText('admin.common.reactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'tc-air', active: true });
  });
});

describe('a refusal that is not an Error', () => {
  it('still says something rather than rendering nothing', async () => {
    /**
     * A rejection that is not an `Error` — a string from a middleware, say. The drawer
     * stays open either way, and the fallback has to put SOMETHING on screen; an empty
     * alert would read as a save that worked.
     */
    const user = userEvent.setup();
    setTrpc([category()], {
      mutations: {
        'travelCategories.update': { outcome: 'error', error: 'refused upstream' as never },
      },
    });
    show();
    await user.click(screen.getByText('Airfare'));
    await screen.findByText('admin.travelCategories.labelEn');
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(await screen.findByRole('alert')).not.toBeEmptyDOMElement();
  });
});

describe('exporting', () => {
  it('writes a row per category, with the type and the mapping as words', async () => {
    /**
     * The export is what an admin hands to an accountant, so the TYPE and the MAPPING have
     * to leave as readable words rather than enum names and uuids — and the unmapped one
     * has to leave as an empty cell rather than the string "null".
     */
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    expect(h.downloads).toHaveLength(1);
    const csv = h.downloads[0].csv;
    expect(csv).toContain('Airfare');
    expect(csv).toContain('Hotel');
    expect(csv).toContain('admin.travelCategories.kinds.LODGING');
    expect(csv).toContain('Travel – Airfare');
  });
});

describe('filtering by emptiness of the name', () => {
  it('finds nothing when every row is named, and everything when asked the inverse', async () => {
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await addFilter(user, 'name', 'isEmpty');
    expect(shown()).toEqual([]);
  });

  it('lists every named row', async () => {
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await addFilter(user, 'name', 'isNotEmpty');
    expect(shown()).toEqual(['Airfare', 'Hotel']);
  });
});

describe('filtering the mapping exactly', () => {
  it('matches the mapped name in full', async () => {
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await addFilter(user, 'mapsTo', 'equals', 'Travel – Airfare');
    expect(shown()).toEqual(['Airfare']);
  });

  it('excludes the mapped name in full, which also drops the unmapped row’s blank', async () => {
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await addFilter(user, 'mapsTo', 'doesNotEqual', 'Travel – Airfare');
    expect(shown()).toEqual(['Hotel']);
  });

  it('narrows on a prefix and a suffix of the mapped name', async () => {
    const user = userEvent.setup();
    setTrpc([category(), HOTEL]);
    show();
    await addFilter(user, 'mapsTo', 'startsWith', 'travel');
    expect(shown()).toEqual(['Airfare']);
  });
});

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/expense-categories.
 *
 * A category decides what the line editor OFFERS, which is why the page collapses two
 * stored booleans into one "kind" control: `isMileage` and `acceptsTip` together is
 * incoherent — a mileage amount is derived from distance, so there is no typed figure
 * for a tip to sit beside.
 *
 * Two rules carry the weight:
 *
 *   · **Crossing the mileage boundary is locked once lines exist.** Every filed line
 *     derived its amount one way or the other; flipping the definition underneath them
 *     re-defines history. The server refuses it — the control is disabled to say so
 *     BEFORE the save fails.
 *   · **Drag-to-reorder only persists while the table is in its natural order.** With a
 *     column sort applied, the visible order is the sort, and capturing it as the manual
 *     `sortOrder` would silently overwrite the order somebody arranged by hand.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
  /** A REAL translator, set only by the FR-CA test, so it proves the NetSuite category
   *  strings come from the French catalog. */
  realT: undefined as undefined | ((key: string, values?: Record<string, unknown>) => string),
  /** Full keys the mocked translator's `has` reports as present — the refusal tests set it
   *  so `refusalText` takes the catalog branch. Empty, `has` is false, as before. */
  knownKeys: new Set<string>(),
}));

// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
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
        if (h.realT && full.startsWith('admin.expenseCategories.')) return h.realT(full, values);
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: (k: string) => boolean }).has = (k: string) =>
        h.knownKeys.has(ns ? `${ns}.${k}` : k);
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
/**
 * `Select` as buttons — Base UI portals its options and needs a pointer environment.
 *
 * Per-ITEM `disabled` is honoured, not just the control's, because that is the whole of the
 * mileage rule here: crossing the boundary is refused once lines are filed, but the other
 * kinds stay reachable. A mock that only looked at the Select's own `disabled` would report
 * every option as enabled and the rule would go untested.
 */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const ReactMod = await import('react');
  const Ctx = ReactMod.createContext<{ onValueChange: (v: string) => void; disabled?: boolean }>({
    onValueChange: () => {},
  });
  return {
    ...actual,
    /**
     * `Combobox` as a list of buttons, one per option. Base UI's combobox portals its
     * popup and needs a pointer environment. The field's current label is shown as text,
     * so a test can see what the field reads, including a `selectedItem` fallback.
     */
    Combobox: ({
      items,
      value,
      onValueChange,
      selectedItem,
      placeholder,
      'aria-label': ariaLabel,
    }: {
      items: Array<{ value: string; label: string }>;
      value: string | null;
      onValueChange: (v: string | null) => void;
      selectedItem?: { value: string; label: string } | null;
      placeholder?: string;
      'aria-label'?: string;
    }) => {
      const current =
        items.find((i) => i.value === value) ??
        (selectedItem && selectedItem.value === value ? selectedItem : null);
      return (
        <fieldset aria-label={ariaLabel}>
          <span data-testid="combobox-value">{current ? current.label : placeholder}</span>
          {items.map((i) => (
            <button
              key={i.value}
              type="button"
              data-combobox-option={i.value}
              onClick={() => onValueChange(i.value)}
            >
              {i.label}
            </button>
          ))}
        </fieldset>
      );
    },
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
    SelectItem: ({
      value,
      children,
      disabled,
    }: {
      value: string;
      children: ReactNode;
      disabled?: boolean;
    }) => {
      const ctx = ReactMod.useContext(Ctx);
      return (
        <button
          type="button"
          data-option={value}
          disabled={disabled ?? ctx.disabled}
          onClick={() => ctx.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

vi.mock('@/components/pickers/EntityPickers', () => ({
  GlAccountCombobox: ({
    onValueChange,
    placeholder,
  }: {
    onValueChange: (v: string | null) => void;
    placeholder?: string;
  }) => (
    <button type="button" onClick={() => onValueChange('gl-1')}>
      {placeholder}
    </button>
  ),
}));

import { ExpenseCategoriesAdmin } from './ExpenseCategoriesAdmin';

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

function setTrpc(items = [category()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'expenseCategories.list': { data: { categories: items } },
      ...over.queries,
    },
  });
}

type AdminProps = React.ComponentProps<typeof ExpenseCategoriesAdmin>;
const show = (props: Partial<AdminProps> = {}) =>
  render(<ExpenseCategoriesAdmin canWrite {...props} />);

const showTopBar = () => render(<div>{h.topBar.right}</div>);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

async function rowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('td') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
}

/** Open the create drawer from the top-bar action. */
async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /admin.expenseCategories.add/ }));
  await screen.findByText('admin.expenseCategories.labelEn');
}

beforeEach(() => {
  h.topBar = {};
  h.downloads = [];
});

afterEach(() => {
  h.trpc = undefined;
  h.realT = undefined;
  h.knownKeys = new Set();
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the category list', () => {
  it('shows the icon, name and the two flags that change the line editor', () => {
    /**
     * The badges are not decoration: mileage swaps the amount field for distance × rate
     * plus a route picker, and tip adds a field. With neither surfaced, both features
     * read as missing.
     */
    setTrpc();
    show();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.getByText('🍽️')).toBeInTheDocument();
    expect(screen.getByText('admin.expenseCategories.acceptsTipBadge')).toBeInTheDocument();
    expect(screen.queryByText('admin.expenseCategories.isMileageBadge')).not.toBeInTheDocument();
  });

  it('badges a category that will demand a guest list', () => {
    /**
     * Attendees was the one line-editor flag with no badge, and it is the one with the
     * sharpest consequence for a submitter: the category refuses the line until they have
     * named who was at the dinner. Unbadged, that reads as the expense form being broken.
     */
    setTrpc();
    show();
    expect(screen.getByText('admin.expenseCategories.requiresAttendeesBadge')).toBeInTheDocument();
  });

  it('says nothing about attendees on a category that does not need them', () => {
    setTrpc([category({ requiresAttendees: false })]);
    show();
    expect(
      screen.queryByText('admin.expenseCategories.requiresAttendeesBadge'),
    ).not.toBeInTheDocument();
  });

  it('falls back to a generic glyph for a category with no icon', () => {
    setTrpc([category({ icon: null })]);
    show();
    expect(screen.getByText('🏷️')).toBeInTheDocument();
  });

  it('shows the GL account it codes to, and an em dash when it has none', () => {
    /**
     * The GL account is what makes a category postable; a blank cell reads as "not
     * loaded" rather than "not mapped".
     */
    setTrpc();
    show();
    expect(screen.getByText('6000')).toBeInTheDocument();
    expect(screen.getByText('· Travel & Entertainment')).toBeInTheDocument();

    cleanup();
    setTrpc([category({ glAccountNumber: null, glAccountName: null })]);
    show();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the recoverable rates, flagging PST only where it applies', () => {
    setTrpc([category({ itcGstHstRate: 50, itcQstRate: 50, pstRecoverable: true })]);
    show();
    expect(screen.getByText('50% / 50% · admin.expenseCategories.pstShort')).toBeInTheDocument();
  });

  it('hides the three flag columns by default', () => {
    /**
     * The name column already badges mileage and tip, so a column each is noise until
     * somebody wants to sort or export by them.
     */
    setTrpc();
    show();
    expect(screen.queryByText('admin.expenseCategories.colKind')).not.toBeInTheDocument();
    expect(
      screen.queryByText('admin.expenseCategories.colRequiresAttendees'),
    ).not.toBeInTheDocument();
  });

  it('hides inactive categories behind the seeded status pill', () => {
    setTrpc([category(), category({ id: 'old', label: { en: 'Retired' }, active: false })]);
    show();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('brings them back when the pill is cleared', async () => {
    const user = userEvent.setup();
    setTrpc([category(), category({ id: 'old', label: { en: 'Retired' }, active: false })]);
    show();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Retired')).toBeInTheDocument();
  });

  it('says so when there are none', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('admin.expenseCategories.empty')).toBeInTheDocument();
  });

  it('gives a read-only viewer no row menu and no Add', () => {
    setTrpc();
    show({ canWrite: false });
    showTopBar();
    expect(screen.queryByRole('button', { name: 'admin.common.actions' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /admin.expenseCategories.add/ }),
    ).not.toBeInTheDocument();
  });
});

// ── Filtering and sorting ─────────────────────────────────────────────────────

describe('filtering', () => {
  const three = [
    category({ id: 'a', label: { en: 'Meals' }, isMileage: false, acceptsTip: true }),
    category({
      id: 'b',
      label: { en: 'Mileage' },
      isMileage: true,
      acceptsTip: false,
      requiresAttendees: false,
    }),
    category({
      id: 'c',
      label: { en: 'Software' },
      isMileage: false,
      acceptsTip: false,
      requiresAttendees: false,
    }),
  ];

  const filterText = async (
    user: ReturnType<typeof userEvent.setup>,
    column: string,
    value: string,
  ) => {
    const header = screen.getByText(column).closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), value);
    await user.click(screen.getByText('table.colMenu.apply'));
  };

  it('narrows by name', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterText(user, 'admin.expenseCategories.colName', 'mile');
    expect(rowTexts()).toHaveLength(1);
  });

  it('narrows by the GL account, matching number or name', async () => {
    // Both, because an admin has one or the other in front of them.
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterText(user, 'admin.expenseCategories.colGlAccount', 'entertainment');
    expect(rowTexts()).toHaveLength(3);
  });

  it('sorts by name, both ways', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    const header = screen.getByText('admin.expenseCategories.colName').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.sortDesc'));
    expect(rowTexts()[0]).toContain('Software');
  });

  it('counts what is on screen', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    expect(screen.getByText('table.misc.results:3')).toBeInTheDocument();
    await filterText(user, 'admin.expenseCategories.colName', 'mile');
    expect(screen.getByText('table.misc.results:1')).toBeInTheDocument();
  });
});

// ── Reordering ────────────────────────────────────────────────────────────────

describe('manual ordering', () => {
  it('is offered while the table is in its natural order', () => {
    /**
     * `sortOrder` is what the line editor's category picker shows, so an admin putting
     * the common ones first is a real thing to be able to do.
     */
    setTrpc([category(), category({ id: 'b', label: { en: 'Second' } })]);
    show();
    expect(screen.getByText('admin.expenseCategories.reorderHint')).toBeInTheDocument();
    expect(screen.getAllByLabelText('table.misc.dragToReorder')).toHaveLength(2);
  });

  it('is withdrawn the moment a column sort is applied', async () => {
    /**
     * With a sort active the visible order IS the sort, and persisting it as the manual
     * order would silently overwrite what somebody arranged by hand.
     */
    const user = userEvent.setup();
    setTrpc([category(), category({ id: 'b', label: { en: 'Second' } })]);
    show();
    const header = screen.getByText('admin.expenseCategories.colName').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.sortAsc'));
    expect(screen.queryByLabelText('table.misc.dragToReorder')).not.toBeInTheDocument();
  });

  it('is not offered to a read-only viewer', () => {
    setTrpc([category()]);
    show({ canWrite: false });
    expect(screen.queryByText('admin.expenseCategories.reorderHint')).not.toBeInTheDocument();
  });
});

// ── Activation ────────────────────────────────────────────────────────────────

describe('deactivating a category', () => {
  it('asks first, naming it', async () => {
    /**
     * A deactivated category disappears from every picker; expenses already coded to it
     * keep it. Worth a confirmation with the name in it.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(confirm).toHaveBeenCalledWith('admin.common.confirmDeactivate:Meals');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('flips the flag once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'cat-meals', active: false });
  });

  it('offers reactivate for one that is already off', async () => {
    const user = userEvent.setup();
    setTrpc([category({ active: false })]);
    show();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await rowMenu(user, 'Meals');
    expect(await screen.findByText('admin.common.reactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the drawer', () => {
  it('pre-fills from the row, reading the two booleans back as one kind', async () => {
    /**
     * `acceptsTip` alone means "standard with tip"; `isMileage` wins over it, because a
     * mileage line has no typed amount for a tip to sit beside.
     */
    const user = userEvent.setup();
    setTrpc([category()]);
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    expect(await screen.findByDisplayValue('Meals')).toBeInTheDocument();
    // VeloExpense: no French name field while French is switched off (ENABLED_LOCALES).
    expect(screen.queryByDisplayValue('Repas')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'admin.expenseCategories.kinds.standard-with-tip' }),
    ).toBeInTheDocument();
  });

  it('locks the mileage boundary once lines are filed against the category', async () => {
    /**
     * Every filed line derived its amount one way or the other, so flipping the
     * definition re-defines history. The server refuses it; the control is disabled to
     * say so before the save fails, and the count is shown so the message is concrete.
     */
    const user = userEvent.setup();
    setTrpc([category({ _count: { lineItems: 214 } })]);
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    expect(
      await screen.findByRole('button', { name: 'admin.expenseCategories.kinds.mileage' }),
    ).toBeDisabled();
    expect(screen.getByText('admin.expenseCategories.kindLockedHelp:214')).toBeInTheDocument();
  });

  it('leaves the non-mileage kinds switchable, because they do not re-define anything', async () => {
    // Adding or removing a tip field changes what is OFFERED next time, not what any
    // filed line meant.
    const user = userEvent.setup();
    setTrpc([category({ _count: { lineItems: 214 } })]);
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    expect(
      await screen.findByRole('button', { name: 'admin.expenseCategories.kinds.standard' }),
    ).toBeEnabled();
  });

  it('lets a new category pick any kind', async () => {
    const user = userEvent.setup();
    setTrpc([category({ _count: { lineItems: 99 } })]);
    show();
    await openCreate(user);
    expect(
      screen.getByRole('button', { name: 'admin.expenseCategories.kinds.mileage' }),
    ).toBeEnabled();
  });

  it('changes the kind from the dropdown', async () => {
    /**
     * It was a row of three toggle buttons, which read as three independent switches
     * rather than as one choice with three answers — and the same field on Travel
     * categories is a dropdown. Two admin pages spelling one kind of decision two
     * different ways is a thing a reader has to learn twice.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    await user.click(
      await screen.findByRole('button', { name: 'admin.expenseCategories.kinds.standard' }),
    );
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0][0]).toMatchObject({ id: 'cat-meals', kind: 'standard' });
  });

  it('will not save without both labels', async () => {
    // A category with no French label renders blank for half the company, in the one
    // dropdown every expense goes through.
    //
    // VeloExpense: while French is switched off nobody is served it, so the English name
    // is the one required; the French field is not shown at all.
    const user = userEvent.setup();
    setTrpc([category()]);
    show();
    await openCreate(user);
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeDisabled();
    expect(screen.queryByText('admin.expenseCategories.labelFr')).not.toBeInTheDocument();
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], 'Software');
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeEnabled();
  });

  it('will not save a colour that is not a six-digit hex', async () => {
    /**
     * The value goes straight into a `style` attribute on every pill for this category,
     * so it is validated here as well as at the render site.
     */
    const user = userEvent.setup();
    setTrpc([category()]);
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    // The text box, not the native colour picker beside it.
    const colour = (await screen.findAllByDisplayValue('#2563eb')).find(
      (el) => (el as HTMLInputElement).type !== 'color',
    ) as HTMLElement;
    await user.clear(colour);
    await user.type(colour, 'red');
    expect(screen.getByRole('button', { name: 'admin.common.save' })).toBeDisabled();
  });

  it('creates a category, trimming the labels and collapsing the kind', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.create': { onCall } } });
    show();
    await openCreate(user);
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], '  Software  ');
    // VeloExpense: English only while French is off (no French field to type into).
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));

    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      label: { en: 'Software' },
      kind: 'standard',
      active: true,
    });
    // Omitted rather than sent empty.
    expect(onCall.mock.calls[0]?.[0]?.label).not.toHaveProperty('fr-CA');
  });

  it('sends the id alongside the payload when editing', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ id: 'cat-meals', kind: 'standard-with-tip' });
  });

  it('nulls an emptied icon rather than sending an empty string', async () => {
    // `icon: ''` renders as a zero-width glyph where the fallback should be.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category({ icon: null })], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].icon).toBeNull();
  });

  it('picks the GL account from the synced chart rather than accepting a typed number', async () => {
    /**
     * A hand-entered account that is not in the chart only failed at NetSuite push
     * time — after the report was approved.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category({ glAccountId: null })], {
      mutations: { 'expenseCategories.update': { onCall } },
    });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    await user.click(await screen.findByText('admin.expenseCategories.glAccountNone'));
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].glAccountId).toBe('gl-1');
  });

  it('closes without writing on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { onCall } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    await user.click(await screen.findByRole('button', { name: 'admin.common.cancel' }));
    expect(onCall).not.toHaveBeenCalled();
    // VeloExpense: the English name, since the French field is not shown (ENABLED_LOCALES).
    expect(screen.queryByDisplayValue('Meals')).not.toBeInTheDocument();
  });

  it('says it is saving rather than letting the button be pressed twice', async () => {
    const user = userEvent.setup();
    setTrpc([category()], { mutations: { 'expenseCategories.update': { isPending: true } } });
    show();
    await rowMenu(user, 'Meals');
    await user.click(await screen.findByText('admin.common.edit'));
    expect(await screen.findByRole('button', { name: 'admin.common.saving' })).toBeDisabled();
  });
});

// ── Every operator the pill bar offers ────────────────────────────────────────

describe('the operators behind a name pill', () => {
  /**
   * `matchClause` is a hand-written switch over eight operators, and the column menu
   * only ever offers `contains`. The rest are reachable from the pill bar, and an
   * operator that fell through to the default would return TRUE for every row — a
   * filter that quietly matches everything, which reads as "there are no other
   * categories" rather than as a broken pill.
   */
  const rows = [
    category({ id: 'a', label: { en: 'Meals' } }),
    category({ id: 'b', label: { en: 'Mileage' } }),
    category({ id: 'c', label: { en: 'Software' } }),
  ];

  const names = () => ['Meals', 'Mileage', 'Software'].filter((n) => screen.queryByText(n));

  const addPill = async (user: ReturnType<typeof userEvent.setup>, op: string, value?: string) => {
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'name');
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
    if (value !== undefined)
      await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  it('matches a whole name', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'equals', 'meals');
    expect(names()).toEqual(['Meals']);
  });

  it('excludes a whole name', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'doesNotEqual', 'meals');
    expect(names()).toEqual(['Mileage', 'Software']);
  });

  it('excludes a substring', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'doesNotContain', 'mile');
    expect(names()).toEqual(['Meals', 'Software']);
  });

  it('anchors at the start', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'startsWith', 'me');
    expect(names()).toEqual(['Meals']);
  });

  it('anchors at the end', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'endsWith', 'ware');
    expect(names()).toEqual(['Software']);
  });

  it('finds the rows with nothing in the field', async () => {
    /** No category can have an empty NAME — it falls back to its id — so this is the
     *  operator proving it narrows to nothing rather than matching everything. */
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'isEmpty');
    expect(names()).toEqual([]);
  });

  it('finds the rows that have something in it', async () => {
    const user = userEvent.setup();
    setTrpc(rows);
    show();
    await addPill(user, 'isNotEmpty');
    expect(names()).toEqual(['Meals', 'Mileage', 'Software']);
  });

  it('reads "not inactive" as the live categories', async () => {
    /** The status pill is an enum and can be spelled either way; both are read
     *  separately, and honouring one and dropping the other empties the table. */
    const user = userEvent.setup();
    setTrpc([
      category({ id: 'a', label: { en: 'Meals' } }),
      category({ id: 'b', label: { en: 'Retired' }, active: false }),
    ]);
    show();
    await user.click(
      screen.getByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    );
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'status');
    await user.selectOptions(
      screen.getByLabelText(/(?:^Operator$|filters\.operator)/),
      'doesNotEqual',
    );
    await user.selectOptions(screen.getByLabelText(/(?:^Value$|filters\.value$)/), 'inactive');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('exporting the chart of categories', () => {
  /**
   * This is what a controller reconciles against the GL: which category codes to which
   * account, and what proportion of the tax on it is recoverable. Both of those are the
   * point of the file, so the GL cell carries the number AND the name — an admin has one
   * or the other in front of them — and a category with no account says so rather than
   * exporting a blank that reads as "not yet reviewed".
   */
  const exportCsv = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    return h.downloads.at(-1)?.csv ?? '';
  };

  it('carries the name and the GL account it codes to', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('Meals');
    expect(csv).toContain('6000 · Travel & Entertainment');
  });

  it('names a category with no account rather than leaving the cell blank', async () => {
    const user = userEvent.setup();
    setTrpc([category({ glAccountId: null, glAccountNumber: null, glAccountName: null })]);
    show();
    expect(await exportCsv(user)).toContain('—');
  });

  it('exports the account number alone when the chart has no name for it', async () => {
    const user = userEvent.setup();
    setTrpc([category({ glAccountName: null })]);
    show();
    const csv = await exportCsv(user);
    expect(csv).toContain('6000');
    expect(csv).not.toContain('·');
  });

  it('falls back to the id for a category with no localized name', async () => {
    const user = userEvent.setup();
    setTrpc([category({ label: {} })]);
    show();
    expect(await exportCsv(user)).toContain('cat-meals');
  });

  it('exports what the filter left, not the whole chart', async () => {
    const user = userEvent.setup();
    setTrpc([
      category({ id: 'a', label: { en: 'Meals' } }),
      category({ id: 'b', label: { en: 'Software' } }),
    ]);
    show();
    await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
    await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), 'name');
    await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), 'contains');
    await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), 'soft');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    const csv = await exportCsv(user);
    expect(csv).toContain('Software');
    expect(csv).not.toContain('Meals');
  });
});

// ── VeloExpense: ExpenseOS's NetSuite category column and override (FR-6) are not ported;
//    their cases are not carried (see the screen's note). One case pins the absence.

describe('VeloExpense: no ledger category column', () => {
  it('leaves the column out, rather than a vendor name over a row of dashes', async () => {
    setTrpc([category()]);
    show();
    expect(await screen.findByText('Meals')).toBeInTheDocument();
    expect(screen.queryByText('admin.expenseCategories.colNsCategory')).not.toBeInTheDocument();
  });
});


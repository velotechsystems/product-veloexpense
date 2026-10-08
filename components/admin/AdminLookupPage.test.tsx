import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock } from '@/test-utils/trpc';
import {
  AdminLookupPage,
  type AdminLookupPageConfig,
  type BaseLookupRow,
  pickLabel,
  slugify,
} from './AdminLookupPage';

/**
 * The shell behind every admin lookup table (Business Units, Legal Entities,
 * Departments, Accounts). One component, four entities — so a regression here is a
 * regression on all four at once, which is the reason it is worth this much test.
 *
 * Three behaviours carry real weight:
 *
 *   · **The default view hides inactive rows.** It does that by SEEDING a
 *     `status=active` filter pill rather than with a separate "include inactive"
 *     checkbox, so the same affordance that hid them is the one that shows them again.
 *     If the seed were lost, every deactivated department would reappear in every
 *     picker-facing list; if the pill stopped being editable, there would be no way to
 *     find a deactivated row at all.
 *   · **Deactivating asks first.** A lookup row is referenced by expenses and cards; a
 *     misclick that deactivates a cost centre is visible to everybody who codes to it.
 *   · **Tree mode sorts depth-first and reparents orphans to the root.** A department
 *     whose parent is filtered out (deactivated, say) would otherwise vanish from the
 *     list entirely — present in the data, absent from the page.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  /** The node the page pushed into the global top bar (the "+ Add" button). */
  topBarRight: null as ReactNode,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`). The French-off behaviour is tested in
// AdminLookupPage.veloexpense.test.tsx.
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  // Namespace-qualified, because two different namespaces both have a `trigger` key
  // (the export menu and the settings gear) and an unqualified stub makes the two
  // buttons indistinguishable to a role query.
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    return values ? `${full}:${Object.values(values).join(',')}` : full;
  },
}));
// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
  },
}));
vi.mock('@/app/(app)/TopBar', () => ({
  // Captured rather than portalled: the button is the page's primary action and the
  // tests need to press it, but the real top bar is a layout concern.
  useTopBarSlots: (builder: () => { right?: ReactNode }) => {
    h.topBarRight = builder().right ?? null;
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface Dept extends BaseLookupRow {
  parentId: string | null;
  code: string;
}

const AT = new Date('2026-08-01T12:00:00Z');

const dept = (id: string, en: string, over: Partial<Dept> = {}): Dept => ({
  id,
  label: { en, 'fr-CA': `${en} (fr)` },
  description: null,
  externalIds: {},
  active: true,
  createdAt: AT,
  updatedAt: AT,
  parentId: null,
  code: id,
  ...over,
});

const ROWS: Dept[] = [
  dept('eng', 'Engineering'),
  dept('platform', 'Platform', { parentId: 'eng' }),
  dept('infra', 'Infrastructure', { parentId: 'platform' }),
  dept('sales', 'Sales'),
  dept('retired', 'Retired Unit', { active: false }),
];

function makeConfig(
  over: Partial<AdminLookupPageConfig<Dept, 'label' | 'externalIds' | 'status' | 'code'>> = {},
) {
  const refetch = vi.fn();
  const createMutateAsync = vi.fn().mockResolvedValue({});
  const updateMutateAsync = vi.fn().mockResolvedValue({});
  const setActiveMutateAsync = vi.fn().mockResolvedValue({});
  const config: AdminLookupPageConfig<Dept, 'label' | 'externalIds' | 'status' | 'code'> = {
    entityKey: 'departments',
    savedViewsResource: 'departments',
    canWrite: true,
    query: { data: { items: ROWS }, isLoading: false, refetch },
    buildCreatePayload: (form) => ({ label: { en: form.labelEn, 'fr-CA': form.labelFr } }),
    buildUpdatePayload: (form) => ({ label: { en: form.labelEn, 'fr-CA': form.labelFr } }),
    createMutation: { mutateAsync: createMutateAsync, isPending: false },
    updateMutation: { mutateAsync: updateMutateAsync, isPending: false },
    setActiveMutation: { mutateAsync: setActiveMutateAsync, isPending: false },
    ...over,
  };
  return { config, refetch, createMutateAsync, updateMutateAsync, setActiveMutateAsync };
}

function renderPage(over: Parameters<typeof makeConfig>[0] = {}) {
  const bag = makeConfig(over);
  const utils = render(<AdminLookupPage config={bag.config} />);
  return { ...bag, ...utils };
}

/** Render whatever the page pushed into the top bar, so its action is pressable. */
function renderTopBar() {
  render(<div>{h.topBarRight}</div>);
}

/** Open the kebab menu on the row whose label cell contains `label`. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('div.flex') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
}

beforeEach(() => {
  h.trpc = createTrpcMock({ queries: { 'savedViews.list': { data: [] } } });
  h.topBarRight = null;
  h.downloads = [];
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('pickLabel', () => {
  it('prefers the active locale', () => {
    expect(pickLabel({ en: 'Engineering', 'fr-CA': 'Ingénierie' }, 'fr-CA')).toBe('Ingénierie');
  });

  it('falls back to English, then to French, before giving up', () => {
    /**
     * A row seeded with only one language must still render. Falling all the way
     * through to `''` lets the caller substitute the id, which is ugly but findable —
     * a blank cell is neither.
     */
    expect(pickLabel({ en: 'Engineering' }, 'fr-CA')).toBe('Engineering');
    expect(pickLabel({ 'fr-CA': 'Ingénierie' }, 'en')).toBe('Ingénierie');
    expect(pickLabel({}, 'en')).toBe('');
  });

  it('degrades on anything that is not a locale map', () => {
    // The column is Json; a half-migrated row can hold a bare string or null.
    for (const v of [null, undefined, 'Engineering', 42, []]) {
      expect(pickLabel(v, 'en')).toBe('');
    }
  });

  it('ignores a non-string value at the locale key', () => {
    expect(pickLabel({ en: { nested: true } }, 'en')).toBe('');
  });
});

describe('slugify', () => {
  it('produces the same shape as the committed seed generator', () => {
    /**
     * The runtime UI and the seed-data generator have to agree, or a department
     * created in the app gets a different `code` than the same department in the seed
     * JSON — and the two then never reconcile.
     */
    expect(slugify('EBlock Atlantic')).toBe('eblock-atlantic');
    expect(slugify('General & Admin')).toBe('general-admin');
    expect(slugify('Accounts Payable!!')).toBe('accounts-payable');
    expect(slugify('  trailing  spaces ')).toBe('trailing-spaces');
  });

  it('strips diacritics rather than dropping the letters', () => {
    // `Ingénierie` must not become `ing-nierie`.
    expect(slugify('Ingénierie Québec')).toBe('ingenierie-quebec');
  });

  it('collapses runs and trims the edges', () => {
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('---a---')).toBe('a');
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });
});

// ── The default view ──────────────────────────────────────────────────────────

describe('the seeded status filter', () => {
  it('hides inactive rows on first load', () => {
    /**
     * The behaviour that used to be an "Include inactive" checkbox. Expressing it as a
     * filter pill means removing it is the same gesture as removing any other filter.
     */
    renderPage();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.queryByText('Retired Unit')).not.toBeInTheDocument();
  });

  it('shows them once the pill is cleared', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(await screen.findByText('Retired Unit')).toBeInTheDocument();
  });

  it('labels the row’s state so an inactive one is not mistaken for a live one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(await screen.findByText('admin.common.inactive')).toBeInTheDocument();
    expect(screen.getAllByText('admin.common.active').length).toBeGreaterThan(0);
  });
});

// ── Tree mode ─────────────────────────────────────────────────────────────────

describe('tree mode', () => {
  const treeConfig = { treeOptions: { parentIdField: 'parentId' as const } };

  it('orders rows depth-first, each parent followed by its own descendants', () => {
    // Flat alphabetical would interleave two org branches into something unreadable.
    renderPage(treeConfig);
    const rendered = ['Engineering', 'Platform', 'Infrastructure', 'Sales'].map((t) =>
      screen.getByText(t),
    );
    for (let i = 1; i < rendered.length; i++) {
      expect(
        rendered[i - 1].compareDocumentPosition(rendered[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('indents by depth', () => {
    renderPage(treeConfig);
    const cellOf = (label: string) => screen.getByText(label).closest('div.flex') as HTMLElement;
    expect(cellOf('Engineering').style.paddingLeft).toBe('');
    expect(cellOf('Platform').style.paddingLeft).toBe('20px');
    expect(cellOf('Infrastructure').style.paddingLeft).toBe('40px');
  });

  it('collapses a subtree, hiding the whole branch below it', async () => {
    const user = userEvent.setup();
    renderPage(treeConfig);
    const cell = screen.getByText('Engineering').closest('div.flex') as HTMLElement;
    await user.click(within(cell).getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText('Platform')).not.toBeInTheDocument();
    expect(screen.queryByText('Infrastructure')).not.toBeInTheDocument();
    // The parent itself stays, now offering to expand again.
    expect(within(cell).getByRole('button', { name: 'Expand' })).toBeInTheDocument();
  });

  it('re-expands on a second press', async () => {
    const user = userEvent.setup();
    renderPage(treeConfig);
    const cell = screen.getByText('Engineering').closest('div.flex') as HTMLElement;
    await user.click(within(cell).getByRole('button', { name: 'Collapse' }));
    await user.click(within(cell).getByRole('button', { name: 'Expand' }));
    expect(await screen.findByText('Platform')).toBeInTheDocument();
  });

  it('gives a leaf no chevron to press', () => {
    // An affordance that does nothing is worse than none.
    renderPage(treeConfig);
    const cell = screen.getByText('Sales').closest('div.flex') as HTMLElement;
    expect(within(cell).getByRole('button', { name: 'Collapse' }).className).toContain('invisible');
  });

  it('lifts an orphan to the root instead of losing it', () => {
    /**
     * The row's parent is deactivated, so the seeded status filter removes it — and a
     * child looked up under a parent that is not in the list would never be visited by
     * the DFS. It would be present in the data and absent from the page.
     */
    renderPage({
      ...treeConfig,
      query: {
        data: {
          items: [
            dept('ghost', 'Ghost Parent', { active: false }),
            dept('orphan', 'Orphan', { parentId: 'ghost' }),
          ],
        },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    const cell = screen.getByText('Orphan').closest('div.flex') as HTMLElement;
    expect(cell.style.paddingLeft).toBe(''); // depth 0
  });

  it('renders a flat list with no chevrons when tree mode is off', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: 'Collapse' })).not.toBeInTheDocument();
  });
});

// ── Permissions ───────────────────────────────────────────────────────────────

describe('write permissions', () => {
  it('offers Add, Edit and Deactivate to somebody who can write', async () => {
    const user = userEvent.setup();
    renderPage();
    renderTopBar();
    expect(screen.getByRole('button', { name: /admin.departments.addNew/ })).toBeInTheDocument();
    await openRowMenu(user, 'Engineering');
    expect(await screen.findByText('admin.common.edit')).toBeInTheDocument();
    expect(screen.getByText('admin.common.deactivate')).toBeInTheDocument();
  });

  it('leaves a read-only viewer with View and nothing else', async () => {
    /**
     * Cosmetic only — the tRPC procedures re-check the permission, and that is where
     * the real guard lives. Hiding the controls is so nobody is offered an action that
     * will be refused.
     */
    const user = userEvent.setup();
    renderPage({ canWrite: false });
    renderTopBar();
    expect(
      screen.queryByRole('button', { name: /admin.departments.addNew/ }),
    ).not.toBeInTheDocument();
    await openRowMenu(user, 'Engineering');
    expect(await screen.findByText('admin.common.view')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.edit')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });

  it('offers Reactivate for a row that is already off', async () => {
    // Same menu slot, opposite verb — never both, so nobody has to guess.
    const user = userEvent.setup();
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await openRowMenu(user, 'Retired Unit');
    expect(await screen.findByText('admin.common.reactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });
});

// ── Deactivation ──────────────────────────────────────────────────────────────

describe('deactivating a row', () => {
  it('asks first, naming the row', async () => {
    /**
     * The row is referenced by expenses and cards. Naming it in the prompt is what
     * makes "are you sure" mean something.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    const { setActiveMutateAsync } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(confirm).toHaveBeenCalledWith('admin.common.confirmDeactivate:Engineering');
    expect(setActiveMutateAsync).not.toHaveBeenCalled();
  });

  it('says so when the flip is refused', async () => {
    /**
     * There is no drawer open for a row action, and `saveError` renders inside the
     * drawer body — so a refused deactivation had nowhere at all to appear. The confirm
     * was accepted, the request failed, and the only visible consequence was the row not
     * changing, which is indistinguishable from a click that missed.
     */
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const setActive = vi.fn().mockRejectedValue(new Error('Still referenced by 3 expenses.'));
    renderPage({ setActiveMutation: { mutateAsync: setActive, isPending: false } });
    await openRowMenu(user, 'Engineering');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(await screen.findByText('Still referenced by 3 expenses.')).toBeInTheDocument();
  });

  it('flips the flag and refetches once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const { setActiveMutateAsync, refetch } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(setActiveMutateAsync).toHaveBeenCalledWith({ id: 'eng', active: false });
    expect(refetch).toHaveBeenCalled();
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the drawer', () => {
  it('opens in view mode on a row click', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Engineering'));
    // Both labels are shown, so somebody can see the French one is missing.
    expect(await screen.findByText('Engineering (fr)')).toBeInTheDocument();
    expect(screen.getByText('admin.common.identity')).toBeInTheDocument();
    expect(screen.getByText('admin.common.audit')).toBeInTheDocument();
  });

  it('shows an em dash for a label a locale does not have', async () => {
    const user = userEvent.setup();
    renderPage({
      query: {
        data: { items: [dept('x', 'Only English', { label: { en: 'Only English' } as never })] },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    await user.click(screen.getByText('Only English'));
    expect((await screen.findAllByText('—')).length).toBeGreaterThan(0);
  });

  it('renders a description only when there is one', async () => {
    const user = userEvent.setup();
    renderPage({
      query: {
        data: {
          items: [dept('d', 'Described', { description: { en: 'The English one' } })],
        },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    await user.click(screen.getByText('Described'));
    expect(await screen.findByText('The English one')).toBeInTheDocument();
    // The French description is absent, so its Field is not rendered at all rather
    // than rendered empty.
    expect(screen.queryByText('admin.common.descriptionFr')).not.toBeInTheDocument();
  });

  it('renders the entity’s own extra sections', async () => {
    const user = userEvent.setup();
    renderPage({
      renderViewExtras: (row) => <div>extras-for-{row.id}</div>,
    });
    await user.click(screen.getByText('Engineering'));
    expect(await screen.findByText('extras-for-eng')).toBeInTheDocument();
    expect(screen.getByText('admin.common.details')).toBeInTheDocument();
  });

  it('switches to the edit form, pre-filled from the row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText('Engineering'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('Engineering')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Engineering (fr)')).toBeInTheDocument();
  });

  it('opens an empty create form from the top bar', async () => {
    const user = userEvent.setup();
    renderPage();
    renderTopBar();
    await user.click(screen.getByRole('button', { name: /admin.departments.addNew/ }));
    expect(await screen.findByText('admin.departments.createTitle')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Engineering')).not.toBeInTheDocument();
  });

  it('closes without saving on cancel', async () => {
    const user = userEvent.setup();
    const { createMutateAsync } = renderPage();
    renderTopBar();
    await user.click(screen.getByRole('button', { name: /admin.departments.addNew/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.cancel' }));
    expect(screen.queryByText('admin.departments.createTitle')).not.toBeInTheDocument();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('surfaces a save failure in the drawer instead of closing over it', async () => {
    /**
     * The drawer stays open with the typed values intact. Closing on failure would
     * discard what somebody just wrote and leave them guessing whether it saved.
     */
    const user = userEvent.setup();
    const { config } = makeConfig({});
    config.updateMutation.mutateAsync = vi.fn().mockRejectedValue(new Error('code must be unique'));
    render(<AdminLookupPage config={config} />);
    await user.click(screen.getByText('Engineering'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(await screen.findByText('code must be unique')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Engineering')).toBeInTheDocument();
  });

  it('saves an edit as a patch against the row it opened', async () => {
    const user = userEvent.setup();
    const { updateMutateAsync, refetch } = renderPage();
    await user.click(screen.getByText('Engineering'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: 'eng',
      patch: { label: { en: 'Engineering', 'fr-CA': 'Engineering (fr)' } },
    });
    expect(refetch).toHaveBeenCalled();
  });

  it('carries a row’s extra column into the form as a string', async () => {
    /**
     * `AdminFormState.extras` is a string map, so `rowToForm` has to stringify — and a
     * null has to become `''`, not the text "null", which is what would be written back
     * to the column.
     */
    const user = userEvent.setup();
    renderPage({
      extraFields: [{ name: 'code', label: 'Code', kind: { kind: 'text' } }],
      query: {
        data: {
          items: [
            dept('a', 'Alpha', { code: 'ALPHA' }),
            dept('b', 'Beta', { code: null as never }),
          ],
        },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    await user.click(screen.getByText('Alpha'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('ALPHA')).toBeInTheDocument();
  });
});

// ── Toolbar ───────────────────────────────────────────────────────────────────

describe('the toolbar', () => {
  it('shows the group-by knob only for an entity that declared groupable columns', async () => {
    /**
     * A "(none)"-only dropdown is a control with nothing in it. Departments group by
     * nothing; Legal Entities group by country and currency.
     */
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
    expect(screen.queryByText('table.settings.groupBy')).not.toBeInTheDocument();
  });

  it('offers the declared columns as group-by options', async () => {
    const user = userEvent.setup();
    renderPage({
      groupableColumns: ['status'],
    });
    await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
    expect(await screen.findByText('table.settings.groupBy')).toBeInTheDocument();
    expect(screen.getByText('admin.common.noParent')).toBeInTheDocument(); // the "(none)" sentinel
  });

  it('ignores a groupable column id that does not exist', async () => {
    // A config typo must not put an unlabelled option in the menu.
    const user = userEvent.setup();
    renderPage({ groupableColumns: ['nope' as never] });
    await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
    expect(await screen.findByText('admin.common.noParent')).toBeInTheDocument();
  });

  it('counts what is on screen, not what came back from the server', () => {
    // Four of the five rows are active, and the fifth is filtered out.
    renderPage();
    expect(screen.getByText('table.misc.results:4')).toBeInTheDocument();
  });

  it('reports the loading state to both the toolbar and the table', () => {
    // Both surfaces say so: the toolbar in place of the count, and the table body in
    // place of the empty state — an empty table that says "no results" while a query
    // is still in flight is a lie.
    renderPage({ query: { data: undefined, isLoading: true, refetch: vi.fn() } });
    expect(screen.getAllByText('table.misc.loading')).toHaveLength(2);
    expect(screen.queryByText('admin.departments.empty')).not.toBeInTheDocument();
  });

  it('shows the entity’s own empty copy when there is nothing to list', () => {
    renderPage({ query: { data: { items: [] }, isLoading: false, refetch: vi.fn() } });
    expect(screen.getByText('admin.departments.empty')).toBeInTheDocument();
  });
});

// ── The row kebab ─────────────────────────────────────────────────────────────

/**
 * Three actions behind one menu, and the interesting half is what each one guards.
 *
 * A lookup row is referenced by expenses and cards, so deactivating a cost centre is
 * visible to everybody who codes to it — that is why it asks first, and why the confirm
 * names the row rather than saying "are you sure".
 */
describe('the row actions', () => {
  it('opens a read-only drawer for View', async () => {
    const user = userEvent.setup();
    renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.view'));
    // The view drawer offers an Edit affordance rather than form fields.
    expect(await screen.findByText('admin.common.edit')).toBeInTheDocument();
  });

  it('opens the form pre-filled for Edit', async () => {
    /** Pre-filling is the whole difference between Edit and Create; an empty form here
     *  would silently blank a label on save. */
    const user = userEvent.setup();
    renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.edit'));
    expect(await screen.findByDisplayValue('Engineering')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Engineering (fr)')).toBeInTheDocument();
  });

  it('asks before deactivating, and names the row it is about to deactivate', async () => {
    /** "Are you sure?" on a misclick is a coin toss. The name is what makes it a decision. */
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { setActiveMutateAsync } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(String(confirm.mock.calls[0][0])).toContain('Engineering');
    expect(setActiveMutateAsync).toHaveBeenCalledWith({ id: 'eng', active: false });
  });

  it('does nothing when the confirm is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { setActiveMutateAsync } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(setActiveMutateAsync).not.toHaveBeenCalled();
  });

  it('refetches after the flip, so the row’s badge is not stale', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { refetch } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(refetch).toHaveBeenCalled();
  });

  it('offers Reactivate on an inactive row instead of Deactivate', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { setActiveMutateAsync } = renderPage();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await openRowMenu(user, 'Retired Unit');
    await user.click(screen.getByText('admin.common.reactivate'));
    expect(setActiveMutateAsync).toHaveBeenCalledWith({ id: 'retired', active: true });
  });

  it('offers only View to a reader who cannot write', async () => {
    /** The server refuses anyway, but a menu full of actions that 403 is a menu nobody
     *  trusts. */
    const user = userEvent.setup();
    renderPage({ canWrite: false });
    await openRowMenu(user, 'Engineering');
    expect(screen.getByText('admin.common.view')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.edit')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });
});

// ── Bulk actions ──────────────────────────────────────────────────────────────

/**
 * Multi-select drives one action surface: flip the selection active or inactive.
 *
 * The rule worth pinning is that the menu offers only the transition that applies to the
 * WHOLE selection. A mixed selection offering "Deactivate" would silently no-op on the
 * rows that are already inactive, and the operator would have no way to tell which half
 * the click actually touched.
 */
describe('bulk actions', () => {
  const selectRow = async (user: ReturnType<typeof userEvent.setup>, index: number) => {
    const boxes = screen.getAllByLabelText('table.misc.selectRow');
    await user.click(boxes[index]);
  };

  it('offers Deactivate when every selected row is active', async () => {
    const user = userEvent.setup();
    renderPage();
    await selectRow(user, 0);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    expect(screen.getByText('admin.common.deactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.reactivate')).not.toBeInTheDocument();
  });

  it('flips every selected row, one call each', async () => {
    /** Fanned out per id rather than through a bulk endpoint: at admin-table scale the
     *  serial round-trip is fine, and it avoids a router change. */
    const user = userEvent.setup();
    const { setActiveMutateAsync } = renderPage();
    await selectRow(user, 0);
    await selectRow(user, 1);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(setActiveMutateAsync).toHaveBeenCalledTimes(2);
    expect(setActiveMutateAsync.mock.calls.every((c) => c[0].active === false)).toBe(true);
  });

  it('keeps going when one row fails', async () => {
    /** Soft-fail per row: the surviving rows still flip, which is what somebody who
     *  selected forty departments wants. */
    const user = userEvent.setup();
    const setActive = vi.fn().mockRejectedValueOnce(new Error('row locked')).mockResolvedValue({});
    renderPage({ setActiveMutation: { mutateAsync: setActive, isPending: false } });
    await selectRow(user, 0);
    await selectRow(user, 1);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(setActive).toHaveBeenCalledTimes(2);
  });

  it('clears the selection and refetches afterwards', async () => {
    /** A stale selection over refetched rows is how a second click hits ids nobody
     *  intended. */
    const user = userEvent.setup();
    const { refetch } = renderPage();
    await selectRow(user, 0);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    await user.click(screen.getByText('admin.common.deactivate'));
    expect(refetch).toHaveBeenCalled();
    const boxes = screen.getAllByLabelText('table.misc.selectRow');
    for (const box of boxes) expect(box).not.toBeChecked();
  });

  it('offers Reactivate when every selected row is inactive', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    // Retired Unit sorts last, so its checkbox is the last one.
    const boxes = await screen.findAllByLabelText('table.misc.selectRow');
    await user.click(boxes[boxes.length - 1]);
    await user.click(screen.getByRole('button', { name: /table\.misc\.selected/ }));
    expect(screen.getByText('admin.common.reactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });
});

// ── The status pill's predicate ───────────────────────────────────────────────

/**
 * The pill drives a three-way outcome — active / inactive / both — and the mapping is
 * where the surprises live. A boolean surface has no sensible reading of `contains`, and
 * the wrong answer there is an empty table with a filter pill nobody thinks is the cause.
 */
describe('reading the status filter', () => {
  /** Replace the seeded pill with one the test controls, through the pill bar's own UI. */
  const setStatus = async (user: ReturnType<typeof userEvent.setup>, op: string, value: string) => {
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    const [field, opSel] = screen.getAllByRole('combobox');
    await user.selectOptions(field, 'status');
    await user.selectOptions(opSel, op);
    const valueSel = screen.getAllByRole('combobox')[2];
    await user.selectOptions(valueSel, value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  it('shows only active rows for status = active', async () => {
    const user = userEvent.setup();
    renderPage();
    await setStatus(user, 'equals', 'active');
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.queryByText('Retired Unit')).not.toBeInTheDocument();
  });

  it('shows only inactive rows for status = inactive', async () => {
    const user = userEvent.setup();
    renderPage();
    await setStatus(user, 'equals', 'inactive');
    expect(screen.getByText('Retired Unit')).toBeInTheDocument();
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
  });

  it('reads "is not active" as "show the inactive ones"', async () => {
    /** The negation has to invert the surface, not fall through to "show all" — otherwise
     *  the pill reads as doing nothing. */
    const user = userEvent.setup();
    renderPage();
    await setStatus(user, 'doesNotEqual', 'active');
    expect(screen.getByText('Retired Unit')).toBeInTheDocument();
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
  });

  it('reads "is not inactive" as "show the active ones"', async () => {
    const user = userEvent.setup();
    renderPage();
    await setStatus(user, 'doesNotEqual', 'inactive');
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.queryByText('Retired Unit')).not.toBeInTheDocument();
  });

  it('shows everything when both states are asked for', async () => {
    /** Two pills composed by an admin. Intersecting them would produce an empty table for
     *  a filter that plainly means "all of them". */
    const user = userEvent.setup();
    renderPage();
    await setStatus(user, 'equals', 'active');
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    const [field, opSel] = screen.getAllByRole('combobox');
    await user.selectOptions(field, 'status');
    await user.selectOptions(opSel, 'equals');
    await user.selectOptions(screen.getAllByRole('combobox')[2], 'inactive');
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Retired Unit')).toBeInTheDocument();
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the detail drawer', () => {
  it('titles itself with the row, and states whether the row is live', async () => {
    const user = userEvent.setup();
    renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.view'));
    // The badge appears in the row too, so the drawer's own copy is the second one.
    expect((await screen.findAllByText('admin.common.active')).length).toBeGreaterThan(1);
    expect(screen.getAllByText('Engineering').length).toBeGreaterThan(1);
  });

  it('shows both languages, dashing the one that is missing', async () => {
    /** A lookup seeded in one language still has to render, and a dash says "not set"
     *  where a blank says "something went wrong". */
    const user = userEvent.setup();
    renderPage({
      query: {
        data: { items: [dept('one', 'Only English', { label: { en: 'Only English' } as never })] },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    await openRowMenu(user, 'Only English');
    await user.click(screen.getByText('admin.common.view'));
    // The FR label field dashes; the row's own empty cells dash too, hence "at least one".
    const frField = (await screen.findByText('admin.common.labelFr')).closest('div')?.parentElement;
    expect(frField?.textContent).toContain('—');
  });

  it('switches from viewing to editing in place', async () => {
    /** Reading a row and then wanting to change it is one motion; closing and reopening
     *  through the kebab is two. */
    const user = userEvent.setup();
    renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.view'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('Engineering')).toBeInTheDocument();
  });

  it('offers no edit affordance to a reader who cannot write', async () => {
    const user = userEvent.setup();
    renderPage({ canWrite: false });
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.view'));
    expect(await screen.findByText('admin.common.labelEn')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /admin.common.edit/ })).not.toBeInTheDocument();
  });
});

// ── Saving ────────────────────────────────────────────────────────────────────

/**
 * The write path, which is the same drawer for two different mutations.
 *
 * The distinction is `drawerMode`, and getting it wrong is not a visible bug — an edit
 * that ran `create` produces a SECOND department with the same name, and the original is
 * still there being coded to. So each mode is asserted on which mutation it called and
 * with what.
 */
describe('saving', () => {
  const fillAndSave = async (user: ReturnType<typeof userEvent.setup>, en: string) => {
    const enField = await screen.findByLabelText(/admin\.common\.labelEn/);
    await user.clear(enField);
    await user.type(enField, en);
    const fr = screen.getByLabelText(/admin\.common\.labelFr/);
    await user.clear(fr);
    await user.type(fr, `${en} (fr)`);
    await user.click(screen.getByRole('button', { name: /admin\.common\.save/ }));
  };

  it('creates from the Add button, and never touches update', async () => {
    const user = userEvent.setup();
    const { createMutateAsync, updateMutateAsync } = renderPage();
    renderTopBar();
    await user.click(screen.getByText(/addNew/));
    await fillAndSave(user, 'Finance');
    expect(createMutateAsync).toHaveBeenCalledWith({
      label: { en: 'Finance', 'fr-CA': 'Finance (fr)' },
    });
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it('updates from the row menu, carrying the row id', async () => {
    /** An edit that ran `create` leaves a second department with the same name and the
     *  original still being coded to. */
    const user = userEvent.setup();
    const { createMutateAsync, updateMutateAsync } = renderPage();
    await openRowMenu(user, 'Engineering');
    await user.click(screen.getByText('admin.common.edit'));
    await fillAndSave(user, 'Engineering & Platform');
    expect(updateMutateAsync).toHaveBeenCalledWith({
      id: 'eng',
      patch: { label: { en: 'Engineering & Platform', 'fr-CA': 'Engineering & Platform (fr)' } },
    });
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('refetches and closes once the write lands', async () => {
    const user = userEvent.setup();
    const { refetch } = renderPage();
    renderTopBar();
    await user.click(screen.getByText(/addNew/));
    await fillAndSave(user, 'Finance');
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByLabelText(/admin\.common\.labelEn/)).not.toBeInTheDocument();
  });

  it('keeps the drawer open and shows the server’s reason when the write fails', async () => {
    /**
     * Closing on failure discards what somebody typed AND leaves them believing it saved.
     * The message is the server's own — "a business unit with that code already exists"
     * is actionable; a generic notice is not.
     */
    const user = userEvent.setup();
    renderPage({
      createMutation: {
        mutateAsync: vi.fn().mockRejectedValue(new Error('That code is already in use.')),
        isPending: false,
      },
    });
    renderTopBar();
    await user.click(screen.getByText(/addNew/));
    await fillAndSave(user, 'Finance');
    expect(await screen.findByText('That code is already in use.')).toBeInTheDocument();
    expect(screen.getByLabelText(/admin\.common\.labelEn/)).toBeInTheDocument();
  });

  it('falls back to a generic message when what was thrown is not an Error', async () => {
    const user = userEvent.setup();
    renderPage({
      createMutation: { mutateAsync: vi.fn().mockRejectedValue('a bare string'), isPending: false },
    });
    renderTopBar();
    await user.click(screen.getByText(/addNew/));
    await fillAndSave(user, 'Finance');
    expect(await screen.findByText(/admin\.common\.errorSave/)).toBeInTheDocument();
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('exporting the lookup', () => {
  it('writes the rows on screen, named after the entity', async () => {
    /** Four entities share this component, so the filename has to come from the config —
     *  four downloads all called "export.csv" is a folder nobody can read. */
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    const out = h.downloads.at(-1);
    expect(out?.filename).toBe('departments');
    expect(out?.csv).toContain('Engineering');
  });

  it('exports what the filter left, not the whole table', async () => {
    /** Otherwise the file disagrees with the screen it was exported from, which is the
     *  one thing somebody checks it against. */
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    // The seeded status pill hides the retired row.
    expect(h.downloads.at(-1)?.csv).not.toContain('Retired Unit');
  });

  it('writes an external-id map as readable pairs', async () => {
    const user = userEvent.setup();
    renderPage({
      query: {
        data: { items: [dept('eng', 'Engineering', { externalIds: { netsuite: '42' } })] },
        isLoading: false,
        refetch: vi.fn(),
      },
    });
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    expect(h.downloads.at(-1)?.csv).toContain('netsuite=42');
  });

  it('leaves the external-id cell empty when there are none', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    expect(h.downloads.at(-1)?.csv).not.toContain('undefined');
  });
});

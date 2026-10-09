import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/job-levels.
 *
 * A job level is a TIER, and two things elsewhere in the product read it that way: the
 * per-diem rate table matches on it, and an approval node's "at or above this level"
 * filter orders by its `sortOrder`. So the page's job is to keep the tier legible — the
 * code, the track it belongs to, and whether it is still in use — and to be honest about
 * what deleting one means, which is why a refused delete is reported rather than
 * swallowed.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
  /** What the export menu handed to the browser. */
  downloads: [] as Array<{ filename: string; csv: string }>,
}));

const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`).
vi.mock('@expenseos/i18n/locales', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLED_LOCALES: ['en', 'fr-CA'],
}));

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
// The export menu's real builder runs; only the browser hand-off is intercepted.
vi.mock('@/lib/exportCsv', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadCsv: (filename: string, csv: string) => {
    h.downloads.push({ filename, csv });
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

import { JobLevelsAdmin } from './JobLevelsAdmin';

const AT = new Date('2026-08-01T12:00:00Z');

const level = (over: Record<string, unknown> = {}) => ({
  id: 'jl-1',
  code: 'IC3',
  track: 'INDIVIDUAL_CONTRIBUTOR',
  label: { en: 'Senior Engineer', 'fr-CA': 'Ingénieur senior' },
  sortOrder: 30,
  active: true,
  externalIds: {},
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function setTrpc(items = [level()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'appSettings.jobLevels.list': { data: items }, ...over.queries },
  });
}

type AdminProps = React.ComponentProps<typeof JobLevelsAdmin>;
const show = (props: Partial<AdminProps> = {}) => render(<JobLevelsAdmin canEdit {...props} />);
const showTopBar = () => render(<div>{h.topBar.right}</div>);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

async function rowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('td') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.rowActions' }));
}

beforeEach(() => {
  h.topBar = {};
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the level list', () => {
  it('shows the code, the name and the track', () => {
    /**
     * The code is what the per-diem table and the approval filter key on, so it is
     * shown as a code — monospaced and first — rather than buried in the label.
     */
    setTrpc();
    show();
    expect(screen.getByText('IC3')).toBeInTheDocument();
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    expect(screen.getByText('admin.jobLevels.tracks.individualContributor')).toBeInTheDocument();
  });

  it('names an unlabelled level rather than leaving the cell blank', () => {
    setTrpc([level({ label: {} })]);
    show();
    expect(screen.getByText('admin.common.unnamed')).toBeInTheDocument();
  });

  it('shows every level, active or not', () => {
    /**
     * Deliberately unfiltered: a deactivated tier still has people historically at it
     * and rates keyed to it, so an admin needs to see it to understand a per-diem row.
     */
    setTrpc([level(), level({ id: 'jl-2', code: 'IC1', label: { en: 'Junior' }, active: false })]);
    show();
    expect(rowTexts()).toHaveLength(2);
    expect(screen.getByText('admin.common.inactive')).toBeInTheDocument();
  });

  it('says so when there are none', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('admin.jobLevels.empty')).toBeInTheDocument();
  });

  it('offers Add only to somebody who may edit', () => {
    setTrpc();
    show();
    showTopBar();
    expect(screen.getByRole('button', { name: /admin.jobLevels.addLevel/ })).toBeInTheDocument();

    cleanup();
    h.topBar = {};
    setTrpc();
    show({ canEdit: false });
    showTopBar();
    expect(
      screen.queryByRole('button', { name: /admin.jobLevels.addLevel/ }),
    ).not.toBeInTheDocument();
  });
});

// ── Row actions ───────────────────────────────────────────────────────────────

describe('row actions', () => {
  it('gives a read-only viewer nothing but View', async () => {
    const user = userEvent.setup();
    setTrpc();
    show({ canEdit: false });
    await rowMenu(user, 'Senior Engineer');
    expect(await screen.findByText('admin.common.view')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.edit')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.common.delete')).not.toBeInTheDocument();
  });

  it('deactivates and reactivates from the same slot', async () => {
    /**
     * One verb at a time, matching the level in front of you — never both, so nobody has
     * to work out which applies.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.update': { onCall } } });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'jl-1', patch: { active: false } });

    cleanup();
    onCall.mockClear();
    setTrpc([level({ active: false })], {
      mutations: { 'appSettings.jobLevels.update': { onCall } },
    });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.reactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'jl-1', patch: { active: true } });
  });

  it('asks before deleting, naming the level', async () => {
    /**
     * A per-diem rate keyed to this tier, and any approval node filtering at or above
     * it, both stop resolving. Worth a confirmation with the name in it.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.delete': { onCall } } });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(confirm).toHaveBeenCalledWith('admin.jobLevels.confirmDelete:Senior Engineer');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('deletes once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.delete': { onCall } } });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(onCall).toHaveBeenCalledWith({ id: 'jl-1' });
  });

  it('reports a refused delete rather than looking like it worked', async () => {
    // The server refuses one that is still referenced; its reason is the actionable half.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = userEvent.setup();
    setTrpc([level()], {
      mutations: {
        'appSettings.jobLevels.delete': {
          outcome: 'error',
          error: new Error('3 per-diem rates reference this level') as never,
        },
      },
    });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.delete'));
    // `onError` on the mutation is what surfaces it; the row handler awaits and the
    // rejection is reported rather than swallowed.
    await vi.waitFor(() =>
      expect(alert).toHaveBeenCalledWith('3 per-diem rates reference this level'),
    );
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('filtering', () => {
  const three = [
    level({ id: 'a', code: 'IC1', label: { en: 'Junior' } }),
    level({ id: 'b', code: 'M1', label: { en: 'Manager' }, track: 'MANAGER' }),
    level({ id: 'c', code: 'IC5', label: { en: 'Staff' }, active: false }),
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

  const filterEnum = async (
    user: ReturnType<typeof userEvent.setup>,
    column: string,
    option: string,
  ) => {
    const header = screen.getByText(column).closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    const apply = await screen.findByText('table.colMenu.apply');
    const editor = apply.closest('div[class*="p-2"]')?.parentElement as HTMLElement;
    await user.click(within(editor).getByText(option));
    await user.click(apply);
  };

  it('narrows by code and by name', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterText(user, 'admin.common.code', 'm1');
    expect(rowTexts()).toHaveLength(1);

    cleanup();
    setTrpc(three);
    show();
    await filterText(user, 'admin.common.label', 'staff');
    expect(rowTexts()).toHaveLength(1);
  });

  it('narrows by track', async () => {
    // The track is what separates an IC ladder from a management one, and rates and
    // approval filters are usually written against one of them.
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterEnum(user, 'admin.jobLevels.trackColumn', 'admin.jobLevels.tracks.manager');
    expect(rowTexts()).toHaveLength(1);
  });

  it('narrows by state', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterEnum(user, 'admin.common.status', 'admin.common.inactive');
    expect(rowTexts()).toHaveLength(1);
  });

  it('clears back to every level', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await filterText(user, 'admin.common.code', 'm1');
    expect(rowTexts()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(rowTexts()).toHaveLength(3);
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the drawer', () => {
  const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.edit'));
    await screen.findByLabelText(/admin\.common\.code/);
  };

  const openCreate = async (user: ReturnType<typeof userEvent.setup>) => {
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.jobLevels.addLevel/ }));
    await screen.findByLabelText(/admin\.common\.code/);
  };

  it('opens the read-only view on a row click', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Senior Engineer'));
    expect(await screen.findByText('Ingénieur senior')).toBeInTheDocument();
  });

  it('pre-fills the form from the row', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openEdit(user);
    expect(screen.getByLabelText(/admin\.common\.code/)).toHaveValue('IC3');
    expect(screen.getByDisplayValue('Senior Engineer')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ingénieur senior')).toBeInTheDocument();
  });

  it('requires a code', async () => {
    /**
     * The code is the join key for per-diem rates and for the approval filter's
     * ordering; a level without one is a tier nothing can reference.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.create': { onCall } } });
    show();
    await openCreate(user);
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.jobLevels.codeRequired')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('requires both labels', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.create': { onCall } } });
    show();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.code/), 'IC9');
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'Principal');
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(await screen.findByText('admin.common.bothLabelsRequired')).toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('creates the level, trimming what was typed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.create': { onCall } } });
    show();
    await openCreate(user);
    await user.type(screen.getByLabelText(/admin\.common\.code/), '  IC9  ');
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'Principal');
    await user.type(screen.getByLabelText(/admin\.common\.labelFr/), 'Principal (fr)');
    await user.click(screen.getByRole('button', { name: 'admin.common.create' }));
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({
      code: 'IC9',
      track: 'INDIVIDUAL_CONTRIBUTOR',
      label: { en: 'Principal', 'fr-CA': 'Principal (fr)' },
      active: true,
    });
  });

  it('saves an edit as a patch against the row it opened', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.update': { onCall } } });
    show();
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'admin.common.saveChanges' }));
    expect(onCall.mock.calls[0]?.[0]).toMatchObject({ id: 'jl-1' });
  });

  it('shows the server’s reason and keeps the form open', async () => {
    const user = userEvent.setup();
    setTrpc([level()], {
      mutations: {
        'appSettings.jobLevels.update': {
          outcome: 'error',
          error: new Error('Code already in use') as never,
        },
      },
    });
    show();
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'admin.common.saveChanges' }));
    expect(await screen.findByText('Code already in use')).toBeInTheDocument();
    expect(screen.getByLabelText(/admin\.common\.code/)).toHaveValue('IC3');
  });

  it('closes without writing on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([level()], { mutations: { 'appSettings.jobLevels.update': { onCall } } });
    show();
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'admin.common.cancel' }));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Ingénieur senior')).not.toBeInTheDocument();
  });
});

// ── Excluding rather than selecting ───────────────────────────────────────────

/**
 * The column header's editor only offers `equals` for an enum, so the exclusions are only
 * reachable through the pill bar — and they are the ones somebody reaches for on a ladder
 * page: "every level except the management track" is how an IC rate table gets checked.
 */
describe('excluding', () => {
  const three = [
    level({ id: 'a', code: 'IC1', label: { en: 'Junior' } }),
    level({ id: 'b', code: 'M1', label: { en: 'Manager' }, track: 'MANAGER' }),
    level({ id: 'c', code: 'IC5', label: { en: 'Staff' }, active: false }),
  ];

  const addFilter = async (
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    op: string,
    value: string,
  ) => {
    await user.click(screen.getByText(/(?:Add filter|filters\.addFilter)/));
    const combos = screen.getAllByRole('combobox');
    await user.selectOptions(combos[0], field);
    await user.selectOptions(combos[1], op);
    await user.selectOptions(screen.getAllByRole('combobox')[2], value);
    await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
  };

  it('excludes one track and keeps the rest', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await addFilter(user, 'track', 'doesNotEqual', 'MANAGER');
    expect(rowTexts()).toHaveLength(2);
  });

  it('reads "is not inactive" as the live levels', async () => {
    /** The negation has to invert the surface rather than falling through to "show
     *  everything", or the pill reads as doing nothing. */
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await addFilter(user, 'status', 'doesNotEqual', 'inactive');
    expect(rowTexts()).toHaveLength(2);
  });

  it('reads "is not active" as the retired ones', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await addFilter(user, 'status', 'doesNotEqual', 'active');
    expect(rowTexts()).toHaveLength(1);
  });

  it('shows everything when both states are asked for', async () => {
    const user = userEvent.setup();
    setTrpc(three);
    show();
    await addFilter(user, 'status', 'equals', 'active');
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(rowTexts()).toHaveLength(3);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('exporting the ladder', () => {
  it('writes the track and the state as words, not enum values', async () => {
    /** A ladder export is read by somebody deciding which levels a per-diem tier covers.
     *  "MANAGER" and "true" are the database's vocabulary, not theirs. */
    const user = userEvent.setup();
    setTrpc([level({ code: 'M1', label: { en: 'Manager' }, track: 'MANAGER' })]);
    show();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    const csv = h.downloads.at(-1)?.csv ?? '';
    expect(csv).toContain('M1');
    expect(csv).toContain('admin.jobLevels.tracks.manager');
    expect(csv).toContain('admin.common.active');
  });

  it('names an unlabelled level rather than exporting a blank cell', async () => {
    const user = userEvent.setup();
    setTrpc([level({ code: 'IC9', label: {} })]);
    show();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    expect(h.downloads.at(-1)?.csv).toContain('admin.common.unnamed');
  });
});

describe('a level whose label the seed never filled in', () => {
  /**
   * `label` is a `Json` column and `externalIds` is another, so both are `null` on any
   * row written before they existed or by a migration that did not set them. Every read
   * of either has to survive that — and the ladder is a lookup table half the product
   * points at, so a level nobody can open is a level nobody can retire.
   */
  const bare = () => level({ id: 'jl-2', code: 'IC1', label: null, externalIds: null });

  it('lists it by its code', () => {
    setTrpc([bare()]);
    show();
    expect(screen.getByText('IC1')).toBeInTheDocument();
  });

  it('opens the view drawer without either half of the name', async () => {
    const user = userEvent.setup();
    setTrpc([bare()]);
    show();
    await user.click(screen.getByText('IC1'));
    expect(await screen.findByText('admin.common.identity')).toBeInTheDocument();
    // Both label fields dash rather than rendering "undefined".
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the edit form with empty label boxes rather than the string "null"', async () => {
    const user = userEvent.setup();
    setTrpc([bare()]);
    show();
    // An unlabelled level renders its code in BOTH the code and the name column, and only
    // the name cell hosts the row menu — so the cell is chosen by what it contains.
    // An unlabelled level renders its code in BOTH the code and the name column, so the
    // menu is found by row rather than by the cell holding the text.
    const row = screen.getAllByText('IC1')[0].closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'admin.common.rowActions' }));
    await user.click(await screen.findByText('admin.common.edit'));
    const en = (await screen.findByLabelText(/admin\.common\.labelEn/)) as HTMLInputElement;
    const fr = screen.getByLabelText(/admin\.common\.labelFr/) as HTMLInputElement;
    expect(en.value).toBe('');
    expect(fr.value).toBe('');
  });

  it('exports it without inventing an external id', async () => {
    const user = userEvent.setup();
    setTrpc([bare()]);
    show();
    await user.click(screen.getByRole('button', { name: 'table.export.trigger' }));
    await user.click(await screen.findByText('CSV'));
    const csv = h.downloads.at(-1)?.csv ?? '';
    expect(csv).toContain('IC1');
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('null');
  });
});

describe('the list before it has loaded', () => {
  it('renders the table rather than throwing on an absent payload', () => {
    /** `query.data` is undefined for the first paint of every visit. */
    h.trpc = createTrpcMock({
      queries: { 'appSettings.jobLevels.list': { isLoading: true, data: undefined } },
    });
    show();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('changing your mind about a delete', () => {
  it('sends nothing when the confirmation is dismissed', async () => {
    /**
     * The confirm is the only thing between a row menu and a level that per-diem rates
     * and approval filters point at. Cancelling has to mean cancelled.
     */
    const user = userEvent.setup();
    const onCall = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setTrpc([level()], {
      mutations: { 'appSettings.jobLevels.delete': { onCall, outcome: 'success' } },
    });
    show();
    await rowMenu(user, 'Senior Engineer');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(onCall).not.toHaveBeenCalled();
  });
});

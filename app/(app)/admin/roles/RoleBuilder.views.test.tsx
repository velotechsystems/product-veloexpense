import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/roles — narrowing, grouping, and acting on many roles at once.
 *
 * The companion file covers one role at a time (the drawer, the delete rules). This one
 * covers the chrome around the list, which is where the page's sharpest edges are:
 *
 *   · **Every pill has to actually filter.** The page once declared four filterable
 *     columns and honoured one, so filtering by kind or by name changed the pill bar
 *     and nothing else — and an empty-looking list reads as "no such roles", not as
 *     "that filter is broken".
 *   · **`equals` clauses on one field widen; the text ops narrow.** That is how a facet
 *     multi-select is expected to behave, and it differs per op, not per field.
 *   · **A bulk deactivate must never touch a system role.** They are what the seed
 *     assigns and what every fallback resolves to, so they are filtered out of the id
 *     list before dispatch rather than left for the server to refuse.
 *   · **A saved view carries the pills, not the rows.** Loading one has to re-key the
 *     clauses, or two views' clauses collide by id.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
}));

/** One stable `t` per namespace — the column memo lists them as deps. */
const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

// VeloExpense: ExpenseOS's tests are bilingual, so they run with French switched ON here
// (VeloExpense ships with it off, `ENABLED_LOCALES`; RoleBuilder.veloexpense.test.tsx covers that).
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
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// VeloExpense: no [locale] segment in VeloExpense's routes.
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));

import { RoleBuilder } from './RoleBuilder';

const AT = new Date('2026-08-01T12:00:00Z');

const role = (over: Record<string, unknown> = {}) => ({
  id: 'role-employee',
  label: { en: 'Employee', 'fr-CA': 'Employé' },
  description: null,
  permissions: ['expense.read'],
  externalIds: {},
  active: true,
  isSystem: true,
  userCount: 42,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

/** Four roles that differ on every axis the page can filter or group by. */
const EMPLOYEE = role();
const AP_CLERK = role({
  id: 'role-ap',
  label: { en: 'AP Clerk', 'fr-CA': 'Commis CF' },
  isSystem: false,
  userCount: 0,
  externalIds: { netsuite: 'NS-77' },
});
const AUDITOR = role({
  id: 'role-auditor',
  label: { en: 'Auditor', 'fr-CA': 'Vérificateur' },
  isSystem: false,
  active: false,
  userCount: 0,
});
const CONTROLLER = role({
  id: 'role-controller',
  label: { en: 'Controller', 'fr-CA': 'Contrôleur' },
  isSystem: false,
  userCount: 0,
});

const ALL = [EMPLOYEE, AP_CLERK, AUDITOR, CONTROLLER];

const CATALOG = { permissions: ['expense.read', 'expense.create', 'vcc.card.issue'] };

function setTrpc(items: unknown[] = ALL, over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'roles.list': { data: { items } },
      'roles.permissionCatalog': { data: CATALOG },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

type BuilderProps = React.ComponentProps<typeof RoleBuilder>;
const show = (props: Partial<BuilderProps> = {}) =>
  render(<RoleBuilder canWrite canDelete {...props} />);

/** Each data row's whole text — the leading cell is the selection checkbox. */
const rowText = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

const names = () =>
  ['Employee', 'AP Clerk', 'Auditor', 'Controller'].filter((n) =>
    rowText().some((t) => t.includes(n)),
  );

/** Drop the seeded `status = active` pill so every fixture is in play. */
async function dropStatusPill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', {
      name: /(?:Remove condition|filters\.removeCondition)/,
    }),
  );
  await user.keyboard('{Escape}');
}

/** Add one clause through the pill bar's own form. */
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

/** Open the gear popover. */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
}

/**
 * Pick a group-by option and close the popover again.
 *
 * The option's label is the column's label, which also appears in the table header —
 * so the popover copy is the LAST match, and the popover has to be dismissed before
 * anything in the table is reachable again (it renders the page inert while open).
 */
async function groupBy(user: ReturnType<typeof userEvent.setup>, label: string) {
  await openSettings(user);
  const options = await screen.findAllByText(label);
  await user.click(options[options.length - 1]);
  await user.keyboard('{Escape}');
}

/** Open the saved-view dropdown (its trigger is named for the active view). */
async function openViews(user: ReturnType<typeof userEvent.setup>, name = 'admin.roles.pageTitle') {
  await user.click(screen.getByRole('button', { name }));
}

/** Tick the selection checkbox on the row carrying `label`. */
async function selectRow(user: ReturnType<typeof userEvent.setup>, label: string) {
  const row = screen.getByText(label).closest('tr') as HTMLElement;
  await user.click(within(row).getByLabelText('table.misc.selectRow'));
}

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('narrowing the list', () => {
  it('filters by name, which the pill bar used to only pretend to do', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'label', 'contains', 'clerk');
    expect(names()).toEqual(['AP Clerk']);
  });

  it('excludes by name', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'label', 'doesNotContain', 'clerk');
    expect(names()).toEqual(['Employee', 'Controller']);
  });

  it('matches the start and the end of a name', async () => {
    const user = userEvent.setup();
    setTrpc();
    const view = show();
    await addFilter(user, 'label', 'startsWith', 'contro');
    expect(names()).toEqual(['Controller']);
    view.unmount();

    setTrpc();
    show();
    await addFilter(user, 'label', 'endsWith', 'clerk');
    expect(names()).toEqual(['AP Clerk']);
  });

  it('ORs two `equals` clauses on the same field, the way a facet does', async () => {
    /**
     * Two equals clauses that ANDed would match nothing — and a multi-select facet is
     * expected to widen as boxes are ticked, not empty the list.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'label', 'equals', 'Employee');
    await addFilter(user, 'label', 'equals', 'Controller');
    expect(names()).toEqual(['Employee', 'Controller']);
  });

  it('ANDs the text ops, so two of them narrow', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'label', 'contains', 'o');
    await addFilter(user, 'label', 'doesNotContain', 'employee');
    expect(names()).toEqual(['Controller']);
  });

  it('excludes one exact name', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'label', 'doesNotEqual', 'Employee');
    expect(names()).toEqual(['AP Clerk', 'Controller']);
  });

  it('filters by kind, so "which of these did we author" is answerable', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'kind', 'equals', 'custom');
    expect(names()).toEqual(['AP Clerk', 'Controller']);
  });

  it('filters by kind the other way, to find the seeded roles', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'kind', 'equals', 'system');
    expect(names()).toEqual(['Employee']);
  });

  it('filters by an external id, which is how a NetSuite mapping is found', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'externalIds', 'contains', 'ns-77');
    expect(names()).toEqual(['AP Clerk']);
  });

  it('shows the inactive ones when the status pill is inverted', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await addFilter(user, 'status', 'doesNotEqual', 'active');
    expect(names()).toEqual(['Auditor']);
  });

  it('shows everything when the status pill asks for both', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'status', 'equals', 'inactive');
    expect(names()).toEqual(['Employee', 'AP Clerk', 'Auditor', 'Controller']);
  });

  it('ignores a status clause that cannot apply to a yes/no, rather than emptying the list', async () => {
    /**
     * `isEmpty` on a boolean column has no sensible reading. Applying it literally
     * would show nothing, which reads as "there are no roles".
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await addFilter(user, 'status', 'isEmpty');
    expect(names()).toEqual(['Employee', 'AP Clerk', 'Auditor', 'Controller']);
  });

  it('says how many matched', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await addFilter(user, 'kind', 'equals', 'custom');
    expect(screen.getByText('table.misc.results:2')).toBeInTheDocument();
  });
});

// ── Grouping ──────────────────────────────────────────────────────────────────

describe('grouping the list', () => {
  it('groups by kind, separating what we authored from what the seed assigns', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await groupBy(user, 'admin.roles.roleKind');
    expect(screen.getByLabelText('Select all in admin.roles.systemRole')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all in admin.roles.customRole')).toBeInTheDocument();
  });

  it('groups by status', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await groupBy(user, 'admin.common.status');
    expect(screen.getByLabelText('Select all in admin.common.active')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all in admin.common.inactive')).toBeInTheDocument();
  });

  it('goes back to a flat list', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await groupBy(user, 'admin.roles.roleKind');
    await groupBy(user, 'admin.common.noParent');
    expect(screen.queryByLabelText(/Select all in/)).not.toBeInTheDocument();
  });

  it('collapses a group down to its heading', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await groupBy(user, 'admin.roles.roleKind');
    await user.click(screen.getByRole('button', { name: /admin.roles.customRole/ }));
    expect(names()).toEqual(['Employee']);
  });

  it('selects a whole group at once', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await groupBy(user, 'admin.roles.roleKind');
    await user.click(screen.getByLabelText('Select all in admin.roles.customRole'));
    expect(screen.getByText('table.misc.selected:2')).toBeInTheDocument();
  });
});

// ── Bulk activate / deactivate ────────────────────────────────────────────────

describe('acting on several roles', () => {
  it('deactivates the selected roles one patch at a time', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(ALL, { mutations: { 'roles.update': { onCall } } });
    show();
    await selectRow(user, 'AP Clerk');
    await selectRow(user, 'Controller');
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall.mock.calls.map(([a]) => a)).toEqual([
      { id: 'role-ap', patch: { active: false } },
      { id: 'role-controller', patch: { active: false } },
    ]);
  });

  it('never sends a system role, whatever was ticked', async () => {
    /**
     * A system role is what the seed assigns and what every fallback resolves to.
     * The server refuses it; the client filters it out first so the menu does not
     * promise something that will be rejected halfway through a batch.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(ALL, { mutations: { 'roles.update': { onCall } } });
    show();
    await selectRow(user, 'Employee');
    await selectRow(user, 'AP Clerk');
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall.mock.calls.map(([a]) => (a as { id: string }).id)).toEqual(['role-ap']);
  });

  it('offers reactivate — and only that — for a selection that is already off', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(ALL, { mutations: { 'roles.update': { onCall } } });
    show();
    await dropStatusPill(user);
    await selectRow(user, 'Auditor');
    await user.click(screen.getByRole('button', { name: /table.misc.selected:1/ }));
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
    await user.click(await screen.findByText('admin.common.reactivate'));
    expect(onCall).toHaveBeenCalledWith({ id: 'role-auditor', patch: { active: true } });
  });

  it('offers neither when the selection is half on and half off', async () => {
    /**
     * "Deactivate" over a mixed selection has to mean something for the ones already
     * off, and there is no answer that isn't a guess.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await selectRow(user, 'Auditor');
    await selectRow(user, 'Controller');
    expect(screen.queryByRole('button', { name: /table.misc.selected/ })).not.toBeInTheDocument();
  });

  it('offers nothing bulk to somebody who may not write', async () => {
    const user = userEvent.setup();
    setTrpc();
    show({ canWrite: false });
    // Selection itself is gated on write, so there is no checkbox to tick.
    expect(
      screen.queryByRole('checkbox', { name: 'table.misc.selectRow' }),
    ).not.toBeInTheDocument();
    expect(user).toBeDefined();
  });

  it('carries on through a row the server refuses', async () => {
    // One role failing must not strand the rest of the batch un-flipped.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(ALL, {
      mutations: { 'roles.update': { onCall, outcome: 'error', error: { message: 'nope' } } },
    });
    show();
    await selectRow(user, 'AP Clerk');
    await selectRow(user, 'Controller');
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall).toHaveBeenCalledTimes(2);
  });

  it('drops the selection once the batch is through', async () => {
    const user = userEvent.setup();
    setTrpc(ALL, { mutations: { 'roles.update': {} } });
    show();
    await selectRow(user, 'AP Clerk');
    await user.click(screen.getByRole('button', { name: /table.misc.selected:1/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(screen.queryByText('table.misc.selected:1')).not.toBeInTheDocument();
  });
});

// ── Saved views ───────────────────────────────────────────────────────────────

const savedView = (over: Record<string, unknown> = {}) => ({
  id: 'v-custom',
  name: 'Custom roles',
  pinned: false,
  state: {
    filters: [{ id: 'c1', field: 'kind', op: 'equals', value: 'custom' }],
    visibleColumns: ['label', 'kind'],
    density: 'compact',
    groupBy: null,
  },
  ...over,
});

describe('saved views', () => {
  it('keeps the current pills under a name', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Custom only');
    setTrpc(ALL, { mutations: { 'savedViews.create': { onCall } } });
    show();
    await addFilter(user, 'kind', 'equals', 'custom');
    await openViews(user);
    await user.click(await screen.findByText('Save current as new view'));
    const payload = onCall.mock.calls[0]?.[0] as {
      resource: string;
      name: string;
      state: { filters: Array<{ field: string; value: string }> };
    };
    expect(payload.resource).toBe('roles');
    expect(payload.name).toBe('Custom only');
    expect(payload.state.filters.map((f) => `${f.field}=${f.value}`)).toEqual([
      'status=active',
      'kind=custom',
    ]);
  });

  it('records which columns were showing, not the rows', async () => {
    /**
     * A view is a lens, not a snapshot: it stores the pills, the sort and the visible
     * columns, so it still means something after the roles change.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Lens');
    setTrpc(ALL, { mutations: { 'savedViews.create': { onCall } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Save current as new view'));
    const state = (onCall.mock.calls[0]?.[0] as { state: { visibleColumns: string[] } }).state;
    expect(state.visibleColumns).toContain('label');
    expect(state.visibleColumns).toContain('kind');
  });

  it('saves nothing when the name is dismissed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    setTrpc(ALL, { mutations: { 'savedViews.create': { onCall } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Save current as new view'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('saves nothing for a name that is only spaces', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('   ');
    setTrpc(ALL, { mutations: { 'savedViews.create': { onCall } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Save current as new view'));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('applies a saved view’s pills, replacing what was there', async () => {
    const user = userEvent.setup();
    setTrpc(ALL, { queries: { 'savedViews.list': { data: [savedView()] } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Custom roles'));
    // The view's clauses REPLACE the seeded status pill, so the inactive custom role
    // comes with them — a saved view is the whole filter set, not an addition to it.
    expect(names()).toEqual(['AP Clerk', 'Auditor', 'Controller']);
  });

  it('applies the columns the view was saved with', async () => {
    const user = userEvent.setup();
    setTrpc(ALL, { queries: { 'savedViews.list': { data: [savedView()] } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Custom roles'));
    expect(screen.queryByRole('columnheader', { name: /admin.common.externalIds/ })).toBeNull();
  });

  it('goes back to the default view', async () => {
    const user = userEvent.setup();
    setTrpc(ALL, { queries: { 'savedViews.list': { data: [savedView()] } } });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Custom roles'));
    await openViews(user, 'Custom roles');
    await user.click(screen.getAllByText('admin.roles.pageTitle')[0]);
    // The system view carries no clauses, so the hidden inactive role comes back.
    expect(names()).toEqual(['Employee', 'AP Clerk', 'Auditor', 'Controller']);
  });

  it('renames a view', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Authored roles');
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.update': { onCall } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'v-custom', name: 'Authored roles' });
  });

  it('does not rename it to the name it already has', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Custom roles');
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.update': { onCall } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('asks before deleting a view', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.delete': { onCall } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith('Delete "Custom roles"? This cannot be undone.');
    expect(onCall).toHaveBeenCalledWith({ id: 'v-custom' });
  });

  it('keeps the view when the question is declined', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.delete': { onCall } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('makes a view the one this list opens on', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.togglePinned': { onCall } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByRole('button', { name: 'Set as default' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'v-custom' });
  });

  it('switches to a view the moment it is created, so the name in the bar is the new one', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('Custom roles');
    setTrpc(ALL, {
      queries: { 'savedViews.list': { data: [savedView()] } },
      mutations: { 'savedViews.create': { outcome: 'success', data: { id: 'v-custom' } } },
    });
    show();
    await openViews(user);
    await user.click(await screen.findByText('Save current as new view'));
    expect(screen.getByRole('button', { name: /Custom roles/ })).toBeInTheDocument();
  });
});

// ── Columns ───────────────────────────────────────────────────────────────────

describe('choosing the columns', () => {
  it('hides a column, and puts it back on reset', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openSettings(user);
    await user.click(await screen.findByLabelText('admin.roles.permissionsShort'));
    expect(screen.queryByRole('columnheader', { name: /admin.roles.permissionsShort/ })).toBeNull();

    await user.click(screen.getByText('table.settings.resetDefaults'));
    expect(
      screen.getByRole('columnheader', { name: /admin.roles.permissionsShort/ }),
    ).toBeInTheDocument();
  });

  it('tightens the rows', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openSettings(user);
    await user.click(await screen.findByText('table.settings.densityCompact'));
    // Density is a table-wide class; that it survived the click is the contract.
    expect(names()).toEqual(['Employee', 'AP Clerk', 'Controller']);
  });
});

// ── Editing a pill that is already on the bar ─────────────────────────────────

/**
 * A pill is not write-once: its operator and its value are both editable in place, and
 * each edit has to touch THAT clause and no other. A reader who narrows one field must not
 * lose the two they set before it.
 *
 * The operator change carries a second rule. Switching to an operator that takes no value
 * — "is empty" — has to CLEAR the value it was holding, or the clause travels with a
 * stale operand that the evaluator either ignores (confusing) or applies (wrong).
 */
describe('editing a pill', () => {
  it('changes one clause’s value and leaves the others alone', async () => {
    /**
     * The value on a text pill is a button that turns into an input — "click to edit".
     * Each edit has to touch THAT clause: a reader narrowing one field must not lose the
     * others they set before it.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await addFilter(user, 'label', 'contains', 'clerk');
    await addFilter(user, 'kind', 'equals', 'custom');
    expect(names()).toEqual(['AP Clerk']);

    await user.click(screen.getByTitle('Click to edit'));
    const input = screen.getByDisplayValue('clerk');
    await user.clear(input);
    await user.type(input, 'controller');
    await user.keyboard('{Enter}');
    // The name clause moved; the kind clause is still in force.
    expect(names()).toEqual(['Controller']);
  });

  it('drops the value when the operator stops taking one', async () => {
    /**
     * "contains 'clerk'" → "is empty" has to forget the needle. A clause carrying an
     * operand its operator ignores is one refactor away from applying it again — and the
     * pill would still be showing a value the filter no longer uses, which is the kind of
     * disagreement between the bar and the table that nobody can debug from the screen.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await addFilter(user, 'label', 'contains', 'clerk');
    expect(names()).toEqual(['AP Clerk']);
    expect(screen.getByTitle('Click to edit')).toHaveTextContent('clerk');

    await user.click(screen.getByTitle(/(?:Change operator|filters\.changeOperator)/));
    // The operator word now comes from the app's catalog, so match either form — the
    // English default or the mocked key (GA readiness report F43).
    await user.click(await screen.findByText(/(?:is empty|filterOps\.isEmpty)/));
    await user.keyboard('{Escape}');

    // The operand is gone from the pill, and the list is no longer narrowed by it.
    expect(screen.queryByTitle('Click to edit')).not.toBeInTheDocument();
    expect(names()).toEqual(['Employee', 'AP Clerk', 'Auditor', 'Controller']);
  });

  it('removes one value from a pill and keeps the pill’s other values', async () => {
    /** A multi-value pill is an OR; unticking one of its values narrows the OR rather
     *  than dropping the whole clause. */
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await addFilter(user, 'label', 'equals', 'Employee');
    await addFilter(user, 'label', 'equals', 'Controller');
    expect(names()).toEqual(['Employee', 'Controller']);
    await user.click(
      screen.getAllByRole('button', {
        name: /(?:Remove value|filters\.removeValue)/,
      })[0],
    );
    expect(names()).toEqual(['Controller']);
  });
});

// ── The drawer header ─────────────────────────────────────────────────────────

describe('what the drawer says about a role', () => {
  it('marks a seeded role as one, so nobody wonders why it cannot be deleted', async () => {
    /** A system role is the reason half the actions are disabled; saying so in the header
     *  is what turns "this is broken" into "this one is built in". */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Employee'));
    expect((await screen.findAllByText('admin.roles.systemRole')).length).toBeGreaterThan(0);
  });

  it('states whether the role is live', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await dropStatusPill(user);
    await user.click(screen.getByText('Auditor'));
    // Auditor is the inactive fixture.
    expect((await screen.findAllByText('admin.common.inactive')).length).toBeGreaterThan(0);
  });

  it('titles itself with the role’s own name', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Controller'));
    expect((await screen.findAllByText('Controller')).length).toBeGreaterThan(1);
  });
});

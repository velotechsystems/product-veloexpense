import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/roles — the Role Builder.
 *
 * A role is the whole of somebody's access, and this page is the only place it is
 * authored, so the tests centre on the things that keep it from becoming a foot-gun:
 *
 *   · **A system role cannot be deleted, and cannot be deactivated.** They are what the
 *     seed assigns and what every fallback resolves to; losing one is not a mistake
 *     anybody recovers from through the UI.
 *   · **A role with people in it cannot be deleted either.** Deleting it would leave
 *     those users pointing at a role id that no longer exists.
 *   · **Inactive roles are hidden by a SEEDED status pill**, not by a checkbox — so the
 *     same affordance that hid them is the one that brings them back.
 *   · **Permissions go over the wire sorted.** The list is a Json column compared
 *     between versions; an unsorted array makes every save look like a change.
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
  permissions: ['expense.read', 'expense.create'],
  externalIds: {},
  active: true,
  isSystem: true,
  userCount: 42,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const custom = (over: Record<string, unknown> = {}) =>
  role({
    id: 'role-ap',
    label: { en: 'AP Clerk', 'fr-CA': 'Commis CF' },
    isSystem: false,
    userCount: 0,
    permissions: ['vcc.card.issue'],
    ...over,
  });

const CATALOG = {
  permissions: [
    'expense.read',
    'expense.create',
    'expense.delete',
    'vcc.card.issue',
    'vcc.transaction.match',
  ],
};

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'roles.list': { data: { items: [role()] } },
      'roles.permissionCatalog': { data: CATALOG },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

type BuilderProps = React.ComponentProps<typeof RoleBuilder>;
const show = (props: Partial<BuilderProps> = {}) =>
  render(<RoleBuilder canWrite canDelete {...props} />);

/** Render whatever the page pushed into the top bar. */
const showTopBar = () => render(<div>{h.topBar.right}</div>);

async function rowMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const cell = screen.getByText(label).closest('td') as HTMLElement;
  await user.click(within(cell).getByRole('button', { name: 'admin.common.actions' }));
}

/** Each data row's text. Not the first `td` — with selection on, that is the
 *  checkbox cell and reads as empty. */
const rowLabels = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter(Boolean);

beforeEach(() => {
  h.topBar = {};
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the role list', () => {
  it('shows each role with its kind, headcount and permission count', () => {
    /**
     * The two numbers are the whole reason an admin opens this page: how many people
     * this affects, and how much it grants.
     */
    setTrpc();
    show();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.getByText('admin.roles.systemRole')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('distinguishes a custom role from a system one', () => {
    // Only one of the two can be deleted, so the difference has to be visible.
    setTrpc({ queries: { 'roles.list': { data: { items: [custom()] } } } });
    show();
    expect(screen.getByText('admin.roles.customRole')).toBeInTheDocument();
  });

  it('asks for inactive roles too, then hides them behind the status pill', () => {
    /**
     * The query is deliberately unfiltered — hiding them is a VIEW choice, expressed as
     * a seeded pill so removing it brings them back. Filtering server-side would make
     * "show inactive" a round trip and a different code path.
     */
    setTrpc({
      queries: {
        'roles.list': {
          data: {
            items: [role(), custom({ id: 'role-off', label: { en: 'Retired' }, active: false })],
          },
        },
      },
    });
    show();
    expect(screen.getByText('Employee')).toBeInTheDocument();
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();
  });

  it('brings them back when the pill is cleared', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'roles.list': {
          data: {
            items: [role(), custom({ id: 'role-off', label: { en: 'Retired' }, active: false })],
          },
        },
      },
    });
    show();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    expect(await screen.findByText('Retired')).toBeInTheDocument();
  });

  it('says so when there are no roles at all', () => {
    setTrpc({ queries: { 'roles.list': { data: { items: [] } } } });
    show();
    expect(screen.getByText('admin.roles.empty')).toBeInTheDocument();
  });

  it('offers Add only to somebody who may write', () => {
    setTrpc();
    show();
    showTopBar();
    expect(screen.getByRole('button', { name: /admin.roles.addNew/ })).toBeInTheDocument();

    cleanup();
    h.topBar = {};
    setTrpc();
    show({ canWrite: false });
    showTopBar();
    expect(screen.queryByRole('button', { name: /admin.roles.addNew/ })).not.toBeInTheDocument();
  });
});

// ── Row actions ───────────────────────────────────────────────────────────────

describe('row actions', () => {
  it('never offers to delete a system role', async () => {
    /**
     * The seed assigns them and every fallback resolves to one. Deleting `employee` is
     * not a mistake anybody recovers from through this page.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await rowMenu(user, 'Employee');
    expect(await screen.findByText('admin.common.edit')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.delete')).not.toBeInTheDocument();
  });

  it('offers delete for a custom role nobody holds', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'roles.list': { data: { items: [custom()] } } } });
    show();
    await rowMenu(user, 'AP Clerk');
    expect(await screen.findByText('admin.common.delete')).toBeInTheDocument();
  });

  it('refuses to delete a role that people hold', async () => {
    /**
     * Those users would be left pointing at a role id that no longer exists — and the
     * RBAC loader resolves permissions through it on every request.
     */
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom({ userCount: 3 })] } } },
      mutations: { 'roles.delete': { onCall } },
    });
    show();
    await rowMenu(user, 'AP Clerk');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });

  it('asks before deleting, naming the role', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom()] } } },
      mutations: { 'roles.delete': { onCall } },
    });
    show();
    await rowMenu(user, 'AP Clerk');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(confirm).toHaveBeenCalledWith('admin.roles.confirmDeleteRole:AP Clerk');
    expect(onCall).not.toHaveBeenCalled();
  });

  it('deletes once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom()] } } },
      mutations: { 'roles.delete': { onCall } },
    });
    show();
    await rowMenu(user, 'AP Clerk');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(onCall).toHaveBeenCalledWith({ id: 'role-ap' });
  });

  it('reports a refused delete rather than looking like it worked', async () => {
    // The server re-checks; its reason is the actionable half.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom()] } } },
      mutations: {
        'roles.delete': { outcome: 'error', error: new Error('Role is still referenced') as never },
      },
    });
    show();
    await rowMenu(user, 'AP Clerk');
    await user.click(await screen.findByText('admin.common.delete'));
    expect(alert).toHaveBeenCalledWith('Role is still referenced');
  });

  it('gives a read-only viewer nothing but View', async () => {
    const user = userEvent.setup();
    setTrpc();
    show({ canWrite: false, canDelete: false });
    await rowMenu(user, 'Employee');
    expect(await screen.findByText('admin.common.view')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.edit')).not.toBeInTheDocument();
  });
});

// ── The drawer ────────────────────────────────────────────────────────────────

describe('the drawer', () => {
  it('opens in view mode with the granted permissions, grouped by module', async () => {
    /**
     * Grouped and counted per module ("expense (2 / 3)"), because the question an admin
     * has is "how much of this area does this role reach", not "which of 140 codes".
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Employee'));
    expect(await screen.findByText('admin.roles.permissionsTitle')).toBeInTheDocument();
    expect(screen.getByText('expense (2 / 3)')).toBeInTheDocument();
    expect(screen.getByText('expense.read')).toBeInTheDocument();
  });

  it('omits a module the role reaches none of', async () => {
    // A list of empty headings is a list nobody scans.
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Employee'));
    await screen.findByText('admin.roles.permissionsTitle');
    expect(screen.queryByText(/^vcc \(/)).not.toBeInTheDocument();
  });

  it('shows both labels, and an em dash for a language that is missing', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom({ label: { en: 'AP Clerk' } })] } } },
    });
    show();
    await user.click(screen.getByText('AP Clerk'));
    expect((await screen.findAllByText('—')).length).toBeGreaterThan(0);
  });

  it('warns that a system role is locked before anybody tries to change it', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Employee'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByText('admin.roles.systemRoleLocked')).toBeInTheDocument();
  });

  it('pre-fills the form from the row', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('Employee'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('Employee')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Employé')).toBeInTheDocument();
  });

  it('will not save without both labels', async () => {
    /**
     * A role with no French label is a role that renders blank for half the company —
     * and it is the label an approver sees on an audit row.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /admin.roles.addNew/ }));
    expect(await screen.findByRole('button', { name: 'admin.common.save' })).toBeDisabled();
  });

  it('closes without writing on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'roles.update': { onCall } } });
    show();
    await user.click(screen.getByText('Employee'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.cancel' }));
    expect(onCall).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Employé')).not.toBeInTheDocument();
  });

  it('saves an edit as a patch, with the permissions sorted', async () => {
    /**
     * Sorted on the wire because the column is Json and versions are compared: an
     * unsorted array makes every save look like a change, and a diff nobody can read.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'roles.list': {
          data: { items: [custom({ permissions: ['vcc.transaction.match', 'expense.read'] })] },
        },
      },
      mutations: { 'roles.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('AP Clerk'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));

    const arg = onCall.mock.calls[0]?.[0] as { id: string; patch: Record<string, unknown> };
    expect(arg.id).toBe('role-ap');
    expect(arg.patch.permissions).toEqual(['expense.read', 'vcc.transaction.match']);
  });

  it('never sends `active` for a system role', async () => {
    /**
     * Deactivating `employee` would strand every user assigned to it, so the field is
     * omitted from the patch entirely rather than merely disabled in the form.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'roles.update': { onCall } } });
    show();
    await user.click(screen.getByText('Employee'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].patch).not.toHaveProperty('active');
  });

  it('sends `active` for a custom role', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom()] } } },
      mutations: { 'roles.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('AP Clerk'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].patch).toMatchObject({ active: true });
  });

  it('bundles the description into a locale map, or null when both are empty', async () => {
    // `{ en: '', 'fr-CA': '' }` is a description that renders as an empty paragraph.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom({ description: null })] } } },
      mutations: { 'roles.update': { onCall } },
    });
    show();
    await user.click(screen.getByText('AP Clerk'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].patch.description).toBeNull();
  });

  it('shows the server’s reason and keeps the form open', async () => {
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: [custom()] } } },
      mutations: {
        'roles.update': { outcome: 'error', error: new Error('Label already in use') as never },
      },
    });
    show();
    await user.click(screen.getByText('AP Clerk'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(await screen.findByText('Label already in use')).toBeInTheDocument();
    expect(screen.getByDisplayValue('AP Clerk')).toBeInTheDocument();
  });
});

// ── Bulk activation ───────────────────────────────────────────────────────────

describe('bulk activation', () => {
  const two = [
    custom({ id: 'r1', label: { en: 'One' } }),
    custom({ id: 'r2', label: { en: 'Two' } }),
  ];

  const selectAll = async (user: ReturnType<typeof userEvent.setup>) => {
    // The header row's checkbox — this page's label bag carries no name for it.
    const header = screen.getAllByRole('row')[0];
    await user.click(within(header).getByRole('checkbox'));
  };

  it('deactivates every eligible role in the selection', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: { 'roles.list': { data: { items: two } } },
      mutations: { 'roles.update': { onCall } },
    });
    show();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2|selected/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['r1', 'r2']);
  });

  it('offers reactivate when every eligible role is already off', async () => {
    // One verb at a time — never both, so nobody has to guess which applies.
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'roles.list': { data: { items: two.map((r) => ({ ...r, active: false })) } },
      },
    });
    show();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2|selected/ }));
    expect(await screen.findByText('admin.common.reactivate')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.deactivate')).not.toBeInTheDocument();
  });

  it('offers neither when the selection is a mix', async () => {
    /**
     * "Deactivate" over a mixed selection would be a no-op for half of it, and the
     * result would look like a partial failure.
     */
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'roles.list': {
          data: {
            items: [
              custom({ id: 'r1', label: { en: 'On' } }),
              custom({ id: 'r2', label: { en: 'Off' }, active: false }),
            ],
          },
        },
      },
    });
    show();
    await user.click(screen.getByRole('button', { name: 'table.misc.clearFilters' }));
    await selectAll(user);
    // With no applicable action the trigger is absent entirely — a greyed-out
    // "Deactivate" over a mixed selection would read as a partial failure.
    expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('leaves a system role out of a bulk change', async () => {
    /**
     * The menu must not promise something the server will reject — and a bulk action
     * that silently skips half the selection is worse than one that is not offered.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({
      queries: {
        'roles.list': {
          data: { items: [role({ id: 'sys' }), custom({ id: 'r1', label: { en: 'One' } })] },
        },
      },
      mutations: { 'roles.update': { onCall } },
    });
    show();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: /table.misc.selected:2|selected/ }));
    await user.click(await screen.findByText('admin.common.deactivate'));
    expect(onCall.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['r1']);
  });

  it('offers no bulk action to somebody who cannot write', async () => {
    setTrpc({ queries: { 'roles.list': { data: { items: two } } } });
    show({ canWrite: false });
    const header = screen.getAllByRole('row')[0];
    expect(within(header).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

// ── Grouping ──────────────────────────────────────────────────────────────────

describe('grouping', () => {
  it('groups by kind and by status, deriving both from flags', async () => {
    /**
     * Neither is a column on the row — `kind` is `isSystem` and `status` is `active` —
     * so the group key has to be derived or every row lands in "unassigned".
     */
    const user = userEvent.setup();
    setTrpc({ queries: { 'roles.list': { data: { items: [role(), custom()] } } } });
    show();
    await user.click(screen.getByRole('button', { name: 'table.settings.trigger' }));
    await screen.findByText('table.settings.groupBy');
    const kind = screen.getAllByText('admin.roles.roleKind');
    await user.click(kind[kind.length - 1]);
    await user.keyboard('{Escape}');
    // Both groups render, labelled by the derived value.
    expect(screen.getAllByText('admin.roles.systemRole').length).toBeGreaterThan(1);
    expect(screen.getAllByText('admin.roles.customRole').length).toBeGreaterThan(1);
  });

  it('counts what is on screen', () => {
    setTrpc({ queries: { 'roles.list': { data: { items: [role(), custom()] } } } });
    show();
    expect(screen.getByText('table.misc.results:2')).toBeInTheDocument();
  });

  it('narrows to custom roles from the kind column', async () => {
    const user = userEvent.setup();
    setTrpc({ queries: { 'roles.list': { data: { items: [role(), custom()] } } } });
    show();
    const header = screen.getByText('admin.roles.roleKind').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    // Scope to the editor: the option label also reads as a badge in the table.
    const apply = await screen.findByText('table.colMenu.apply');
    const editor = apply.closest('div[class*="p-2"]')?.parentElement as HTMLElement;
    await user.click(within(editor).getByText('admin.roles.customRole'));
    await user.click(apply);
    expect(rowLabels()).toHaveLength(1);
    expect(screen.getByText('AP Clerk')).toBeInTheDocument();
  });
});

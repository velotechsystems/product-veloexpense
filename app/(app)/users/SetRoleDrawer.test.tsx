import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import type { PeopleRow } from './EmployeeDirectory.cells';

/**
 * Changing somebody's role — the single widest-blast-radius edit in the directory.
 *
 * A role IS the person's access, so the drawer is deliberately dull: it opens on the
 * role they already have, Save stays dead until that changes, and every refusal the
 * server makes (last admin, demoting yourself) is shown where the choice was made
 * rather than swallowed.
 *
 * The one thing it must not do is imply more than it did: the person's live session
 * keeps its old role until their token refreshes, so "saved" here means the stored
 * role changed, and the directory row is what has to re-read.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
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

/** The design system's Select is a Base UI popover; a native <select> is enough here. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const React = await import('react');
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void } | null>(
    null,
  );
  return {
    ...actual,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ id, children }: { id?: string; children: React.ReactNode }) => (
      <div data-testid="select-trigger" id={id}>
        {children}
      </div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <select
          aria-label="roleLabel"
          value={ctx?.value ?? ''}
          onChange={(e) => ctx?.onValueChange(e.target.value)}
        >
          {children}
        </select>
      );
    },
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { SetRoleDrawer } from './SetRoleDrawer';

const USER = {
  id: 'u-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@e.inc',
  role: { id: 'role-employee', label: { en: 'Employee', 'fr-CA': 'Employé' } },
} as unknown as PeopleRow;

const NAMELESS = {
  id: 'u-2',
  firstName: null,
  lastName: null,
  email: 'ghost@e.inc',
  role: { id: 'role-employee', label: { en: 'Employee' } },
} as unknown as PeopleRow;

const ROLES = {
  items: [
    { id: 'role-employee', label: { en: 'Employee', 'fr-CA': 'Employé' } },
    { id: 'role-admin', label: { en: 'Administrator', 'fr-CA': 'Administrateur' } },
    { id: 'role-ap', label: { en: 'AP Clerk', 'fr-CA': 'Commis CF' } },
  ],
};

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'roles.list': { data: ROLES }, ...over.queries },
  });
}

const show = (user: PeopleRow | null = USER, onClose = vi.fn()) => {
  const view = render(<SetRoleDrawer user={user} onClose={onClose} />);
  return { ...view, onClose };
};

const roleSelect = () => screen.getByLabelText('roleLabel') as HTMLSelectElement;

beforeEach(() => {
  setTrpc();
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('opening the drawer', () => {
  it('mounts nothing with nobody selected', () => {
    show(null);
    expect(screen.queryByText('title')).not.toBeInTheDocument();
  });

  it('names whose role is being changed', () => {
    show();
    expect(screen.getByText('for:Ada Lovelace')).toBeInTheDocument();
  });

  it('falls back to the email when the row carries no name', () => {
    show(NAMELESS);
    expect(screen.getByText('for:ghost@e.inc')).toBeInTheDocument();
  });

  it('opens on the role the person already has', () => {
    /**
     * Opening on a blank — or on the first role in the list — turns a glance into an
     * accidental change the moment somebody hits Save.
     */
    show();
    expect(roleSelect().value).toBe('role-employee');
  });

  it('offers every role the catalog knows', () => {
    show();
    expect([...roleSelect().options].map((o) => o.textContent)).toEqual([
      'Employee',
      'Administrator',
      'AP Clerk',
    ]);
  });

  it('shows an empty picker rather than breaking when the catalog has not arrived', () => {
    setTrpc({ queries: { 'roles.list': { data: undefined } } });
    show();
    expect(roleSelect().options).toHaveLength(0);
  });
});

describe('saving', () => {
  it('will not save the role that is already set', () => {
    // The dull guard that keeps a glance from becoming an audited change.
    show();
    expect(screen.getByText('submit').closest('button')).toBeDisabled();
  });

  it('saves once a different role is picked', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.setRole': { onCall } } });
    show();
    await user.selectOptions(roleSelect(), 'role-admin');
    await user.click(screen.getByText('submit'));
    expect(onCall).toHaveBeenCalledWith({ id: 'u-1', roleId: 'role-admin' });
  });

  it('goes dead again if the original role is picked back', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.selectOptions(roleSelect(), 'role-admin');
    await user.selectOptions(roleSelect(), 'role-employee');
    expect(screen.getByText('submit').closest('button')).toBeDisabled();
  });

  it('closes on success, so the directory re-reads the row', async () => {
    /**
     * The row's role label is now wrong until it refetches, and the drawer is the only
     * thing that knows the change landed.
     */
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.setRole': { outcome: 'success' } } });
    const { onClose } = show();
    await user.selectOptions(roleSelect(), 'role-ap');
    await user.click(screen.getByText('submit'));
    expect(onClose).toHaveBeenCalled();
  });

  it('will not fire twice while the change is in flight', () => {
    setTrpc({ mutations: { 'users.setRole': { isPending: true } } });
    show();
    expect(screen.getByText('submitting').closest('button')).toBeDisabled();
  });

  it('cancels without changing anything', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'users.setRole': { onCall } } });
    const { onClose } = show();
    await user.selectOptions(roleSelect(), 'role-admin');
    await user.click(screen.getByText('cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});

describe('when the server refuses', () => {
  it('says why, beside the choice that was made', async () => {
    /**
     * The refusals here are the interesting ones — "you cannot demote the last admin",
     * "you cannot demote yourself" — and they are only useful next to the picker.
     */
    const user = userEvent.setup();
    setTrpc({
      mutations: {
        'users.setRole': {
          outcome: 'error',
          error: { message: 'You cannot remove your own admin role' },
        },
      },
    });
    const { onClose } = show();
    await user.selectOptions(roleSelect(), 'role-employee');
    await user.selectOptions(roleSelect(), 'role-admin');
    await user.click(screen.getByText('submit'));
    expect(await screen.findByText('You cannot remove your own admin role')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the picked role so the attempt can be repeated', async () => {
    const user = userEvent.setup();
    setTrpc({
      mutations: { 'users.setRole': { outcome: 'error', error: { message: 'Nope' } } },
    });
    show();
    await user.selectOptions(roleSelect(), 'role-admin');
    await user.click(screen.getByText('submit'));
    await screen.findByText('Nope');
    expect(roleSelect().value).toBe('role-admin');
  });
});

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * VeloExpense: /admin/roles as VeloExpense ships it, with French switched OFF
 * (`ENABLED_LOCALES`, 7 Oct). Not in ExpenseOS. `RoleBuilder.test.tsx` is ExpenseOS's own
 * test, run with French on; this covers the difference, as the lookup screens' do
 * (JobLevelsAdmin.veloexpense.test.tsx):
 *
 *   · no French label is asked for or shown;
 *   · the English label alone saves, and no empty French one is sent;
 *   · a French label already on a role survives an edit untouched;
 *   · each permission checkbox has an accessible name (Base UI's checkbox is a span its
 *     <label> does not name), so it can be found and ticked by its code.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown, topBar: {} as Record<string, ReactNode> }));

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
vi.mock('@/app/(app)/TopBar', () => ({
  useTopBarSlots: (builder: () => Record<string, ReactNode>) => {
    h.topBar = builder();
  },
}));

import { RoleBuilder } from './RoleBuilder';

const AT = new Date('2026-08-01T12:00:00Z');
const custom = (over: Record<string, unknown> = {}) => ({
  id: 'role-ap',
  label: { en: 'AP Clerk', 'fr-CA': 'Commis CF' },
  description: null,
  permissions: ['expense.read'],
  externalIds: {},
  active: true,
  isSystem: false,
  userCount: 0,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function setTrpc(over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'roles.list': { data: { items: [custom()] } },
      'roles.permissionCatalog': { data: { permissions: ['expense.read', 'expense.create'] } },
      'savedViews.list': { data: [] },
      ...over.queries,
    },
  });
}

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
});

describe('French switched off', () => {
  it('neither asks for nor shows a French label', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<RoleBuilder canWrite canDelete />);
    await user.click(screen.getByText('AP Clerk'));
    expect(await screen.findByText('admin.common.labelEn')).toBeInTheDocument();
    expect(screen.queryByText('admin.common.labelFr')).not.toBeInTheDocument();
    expect(screen.queryByText('Commis CF')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    expect(await screen.findByDisplayValue('AP Clerk')).toBeInTheDocument();
    expect(screen.queryByLabelText(/admin\.common\.labelFr/)).not.toBeInTheDocument();
  });

  it('saves on the English label alone, sending no empty French one', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'roles.create': { onCall } } });
    render(<RoleBuilder canWrite canDelete />);
    render(<div>{h.topBar.right}</div>);
    await user.click(screen.getByRole('button', { name: /admin.roles.addNew/ }));
    const save = await screen.findByRole('button', { name: 'admin.common.save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/admin\.common\.labelEn/), 'Reviewer');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall.mock.calls[0]?.[0].label).toEqual({ en: 'Reviewer' });
  });

  it('keeps a French label already on the role through an edit', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'roles.update': { onCall } } });
    render(<RoleBuilder canWrite canDelete />);
    await user.click(screen.getByText('AP Clerk'));
    await user.click(await screen.findByRole('button', { name: /admin.common.edit/ }));
    await user.click(await screen.findByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].patch.label).toEqual({ en: 'AP Clerk', 'fr-CA': 'Commis CF' });
  });

  it('names each permission checkbox, so it can be found and ticked by its code', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc({ mutations: { 'roles.create': { onCall } } });
    render(<RoleBuilder canWrite canDelete />);
    render(<div>{h.topBar.right}</div>);
    await user.click(screen.getByRole('button', { name: /admin.roles.addNew/ }));
    await user.type(await screen.findByLabelText(/admin\.common\.labelEn/), 'Reviewer');
    await user.click(screen.getByRole('checkbox', { name: 'expense.create' }));
    await user.click(screen.getByRole('button', { name: 'admin.common.save' }));
    expect(onCall.mock.calls[0]?.[0].permissions).toEqual(['expense.create']);
  });
});

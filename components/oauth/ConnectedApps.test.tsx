import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * Connected applications — ported from VeloCRM's `connected-mcp-clients` and `admin/mcp-clients`
 * pages (59fce1c), which have no tests; these are new. What they defend: every live grant gets
 * a row with what it may do, disconnecting asks first and names the application, the person's
 * own list and the admin's list call their own procedures, and a failure shows the catalogue's
 * sentence rather than the server's.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));

vi.mock('next-intl', () => ({
  useFormatter: () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
  useTranslations: (ns: string) => {
    const t = (k: string, v?: Record<string, unknown>) => (v ? `${ns}.${k}:${Object.values(v).join(',')}` : `${ns}.${k}`);
    t.has = () => false;
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

import { AdminConnectedApps, ConnectedApps } from './ConnectedApps';

const grant = (over: Record<string, unknown> = {}) => ({
  id: 'g-1',
  clientName: 'Claude',
  scopes: ['expense_management.expense_report', 'travel.travel_request.readonly'],
  connectedAt: '2026-10-20T12:00:00.000Z',
  lastUsedAt: null,
  ...over,
});

const set = (cfg: TrpcMockConfig) => {
  h.trpc = createTrpcMock(cfg);
};

afterEach(cleanup);

describe('ConnectedApps (the person\'s own)', () => {
  it('says so when nothing is connected', () => {
    set({ queries: { 'oauthGrants.mine': { data: [] } } });
    render(<ConnectedApps />);
    expect(screen.getByText('oauth.connected.empty')).toBeInTheDocument();
  });

  it('lists each connection with what it may do and when it was last used', () => {
    set({ queries: { 'oauthGrants.mine': { data: [grant(), grant({ id: 'g-2', clientName: 'Other', lastUsedAt: '2026-10-21T00:00:00Z' })] } } });
    render(<ConnectedApps />);
    const rows = screen.getAllByTestId('connected-app');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Claude')).toBeInTheDocument();
    expect(within(rows[0]).getByText('oauth.scope.expense_management_expense_report')).toBeInTheDocument();
    expect(within(rows[0]).getByText('oauth.scope.travel_travel_request_readonly')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/oauth.connected.neverUsed/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/oauth.connected.lastUsed:2026-10-21/)).toBeInTheDocument();
  });

  it('asks before disconnecting, names the application, then revokes that grant', async () => {
    const onCall = vi.fn();
    set({ queries: { 'oauthGrants.mine': { data: [grant()] } }, mutations: { 'oauthGrants.revokeMine': { onCall } } });
    render(<ConnectedApps />);
    await userEvent.click(screen.getByRole('button', { name: 'oauth.connected.disconnect' }));
    expect(onCall).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('oauth.connected.confirmTitle:Claude')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'oauth.connected.disconnect' }));
    expect(onCall).toHaveBeenCalledWith({ grantId: 'g-1' });
  });

  it('shows the catalogue\'s sentence when disconnecting fails, never the server\'s', () => {
    set({
      queries: { 'oauthGrants.mine': { data: [grant()] } },
      mutations: { 'oauthGrants.revokeMine': { error: { message: 'Server-side English.' } } },
    });
    render(<ConnectedApps />);
    expect(screen.getByRole('alert')).toHaveTextContent('oauth.connected.failed');
    expect(screen.queryByText('Server-side English.')).toBeNull();
  });
});

describe('AdminConnectedApps (the tenant\'s)', () => {
  it('names the person behind each connection, and revokes through the admin procedure', async () => {
    const onCall = vi.fn();
    set({ queries: { 'oauthGrants.all': { data: [grant({ person: 'Dana Patel' })] } }, mutations: { 'oauthGrants.revoke': { onCall } } });
    render(<AdminConnectedApps />);
    const row = screen.getByTestId('admin-connected-app');
    expect(within(row).getByText('Dana Patel')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'oauth.connected.disconnect' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'oauth.connected.disconnect' }));
    expect(onCall).toHaveBeenCalledWith({ grantId: 'g-1' });
  });
});

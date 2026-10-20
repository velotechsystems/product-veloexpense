// Ported from ExpenseOS `app/[locale]/(app)/admin/api-keys/page.test.tsx` (1e682dd6), w6-04 (d88).
// VeloExpense: the page reads the shell context (server/shell.ts) and refuses with
// `forbidden()`, where ExpenseOS resolves RBAC from its session and answers 404.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /admin/api-keys — who gets which half of the page.
 *
 * The route used to be the request log alone, gated on `admin.apiKey.list`. It now also
 * hosts the platform-key mint form that used to sit on `/profile`, and the two halves
 * answer to different permissions — so the route gate had to become a disjunction, or a
 * holder of `create` alone would 404 out of the only screen that creates a key.
 *
 * A disjunctive gate has a failure mode a single check does not: it can widen too far. The
 * cases below therefore assert both directions for each half — present for the permission
 * that owns it, ABSENT for the one that does not. `[create]` seeing the request log would
 * be a quiet read-access grant, and it is the reason each case checks what is missing as
 * well as what is there.
 *
 * The two children are stubbed. They are client components that reach tRPC, and their own
 * suites cover what they render; the subject here is the gate.
 */

const h = vi.hoisted(() => ({
  session: { user: { id: 'u-1', roleId: 'role-1', roleLabel: { en: 'Admin' } } } as unknown,
  permissions: [] as string[],
}));

vi.mock('@/server/shell', () => ({
  shellContext: async () => (h.session ? { rbac: { permissions: h.permissions } } : null),
}));
vi.mock('@/lib/i18n/page-title', () => ({ pageTitle: () => ({}) }));
vi.mock('next/navigation', () => ({
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));
vi.mock('./PlatformApiKeys', () => ({
  PlatformApiKeys: () => <div>mint-form</div>,
}));
vi.mock('./ApiKeyRequestsAdmin', () => ({
  ApiKeyRequestsAdmin: () => <div>request-log</div>,
}));
// mcp-oauth: the connected-applications list rides with the request log (same permission).
vi.mock('@/components/oauth/ConnectedApps', () => ({
  AdminConnectedApps: () => <div>connected-apps</div>,
}));

import ApiKeysAdminPage from './page';

const show = async () => render(await ApiKeysAdminPage());
const mintForm = () => screen.queryByText('mint-form');
const requestLog = () => screen.queryByText('request-log');
const connectedApps = () => screen.queryByText('connected-apps');

beforeEach(() => {
  h.session = { user: { id: 'u-1', roleId: 'role-1', roleLabel: { en: 'Admin' } } };
  h.permissions = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('/admin/api-keys', () => {
  it('is refused for a caller with no session', async () => {
    /**
     * Before RBAC is consulted at all. A signed-out request must not resolve to an admin
     * shell with two empty panels in it.
     */
    h.session = null;
    await expect(show()).rejects.toThrow('NEXT_FORBIDDEN');
  });

  it('is refused for a signed-in caller holding neither permission', async () => {
    // An ordinary employee has no business knowing this route exists.
    h.permissions = [];
    await expect(show()).rejects.toThrow('NEXT_FORBIDDEN');
  });

  it('gives a create-only holder the mint form, and no request log', async () => {
    /**
     * The case the old single `list` gate got wrong: it 404'd somebody who may create a
     * service account out of the only screen that creates one. The log stays away — being
     * allowed to mint a key is not being allowed to read what every key did.
     */
    h.permissions = ['admin.apiKey.create'];
    await show();
    expect(mintForm()).toBeInTheDocument();
    expect(requestLog()).not.toBeInTheDocument();
    expect(connectedApps()).not.toBeInTheDocument();
  });

  it('gives a list-only holder the request log, and no mint form', async () => {
    // The original audience for the page, unchanged: read what the keys did, mint nothing.
    h.permissions = ['admin.apiKey.list'];
    await show();
    expect(requestLog()).toBeInTheDocument();
    // mcp-oauth: and the connected applications, which answer to the same permission.
    expect(connectedApps()).toBeInTheDocument();
    expect(mintForm()).not.toBeInTheDocument();
  });

  it('gives a holder of both the whole page', async () => {
    h.permissions = ['admin.apiKey.create', 'admin.apiKey.list'];
    await show();
    expect(mintForm()).toBeInTheDocument();
    expect(requestLog()).toBeInTheDocument();
  });

  it('is not widened by a neighbouring api-key permission', async () => {
    /**
     * `admin.apiKey.revoke` is the third permission in the same block, and it is NOT one of
     * the two the gate names. A disjunction written from the wrong list would let it in.
     */
    h.permissions = ['admin.apiKey.revoke'];
    await expect(show()).rejects.toThrow('NEXT_FORBIDDEN');
  });
});

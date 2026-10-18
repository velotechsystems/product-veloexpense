// @vitest-environment node
/**
 * w5-03 — the Xero adapter's connection half (`lib/integrations/xero.ts`), with Xero's
 * endpoints stubbed at `fetch`.
 *
 * VeloExpense-built (ExpenseOS has no Xero). What is pinned is what the adapter promises
 * core: the authorise URL asks for exactly the granular scopes posting will need; the
 * exchange settles on ONE organisation and refuses to guess between several; `invalid_grant`
 * — and nothing else — means a human must connect again; a rotated refresh token is handed
 * back so it replaces the old one; the Test button reads the organisation with the tenant
 * header; and the adapter claims no capability. The connect flow through core is
 * `test/integration-oauth.db.test.ts`, driven by the stub adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthConsentRequired } from '@/lib/integrations/contract';
import { authEventIdOf, chooseTenant, SCOPES, xeroAdapter } from '@/lib/integrations/xero';

const jwt = (claims: Record<string, unknown>) =>
  ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');

type Reply = { status?: number; body: unknown };
let calls: Array<{ url: string; init: RequestInit }> = [];
function stub(...replies: Reply[]) {
  calls = [];
  const queue = [...replies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift() ?? { status: 500, body: 'no stub left' };
      const status = next.status ?? 200;
      return {
        ok: status < 400,
        status,
        text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
      };
    }),
  );
}

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-id';
  process.env.XERO_CLIENT_SECRET = 'client-secret';
});
afterEach(() => {
  delete process.env.XERO_CLIENT_ID;
  delete process.env.XERO_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe('the adapter as core sees it', () => {
  it('declares no capability, so nothing is ever posted to it', () => {
    expect(xeroAdapter.capabilities).toEqual([]);
    expect(xeroAdapter.postExpenseReport).toBeUndefined();
    expect(xeroAdapter.auth).toBe('OAUTH2');
  });

  it('is unavailable until the platform has a Xero app', () => {
    expect(xeroAdapter.available?.()).toBe(true);
    delete process.env.XERO_CLIENT_SECRET;
    expect(xeroAdapter.available?.()).toBe(false);
  });
});

describe('the authorise URL', () => {
  it("is Xero's, carries the state and redirect, and asks for the granular scopes", () => {
    const url = new URL(
      xeroAdapter.authorizeUrl!({ config: {}, state: 'st-1', redirectUri: 'https://acme.example.test/cb' }),
    );
    expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://acme.example.test/cb');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([...SCOPES]);
    // Without it there is no refresh token and the connection dies in minutes.
    expect(scopes).toContain('offline_access');
    // An app created after 2 March 2026 cannot request the broad scope at all.
    expect(scopes).not.toContain('accounting.transactions');
    // Read only: nothing here pays anything.
    expect(scopes).not.toContain('accounting.payments');
  });
});

describe('connecting: the exchange and the organisation', () => {
  const token = (event: string | null) => ({
    access_token: jwt(event ? { authentication_event_id: event } : {}),
    refresh_token: 'refresh-1',
    expires_in: 1800,
    scope: SCOPES.join(' '),
  });

  it('trades the code at the token endpoint with HTTP Basic client authentication', async () => {
    stub({ body: token(null) }, { body: [{ tenantId: 't-1', tenantType: 'ORGANISATION' }] });
    await xeroAdapter.exchangeCode!({ config: {}, code: 'c-1', redirectUri: 'https://r', callbackParams: {} });
    expect(calls[0].url).toBe('https://identity.xero.com/connect/token');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect(String(calls[0].init.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0].init.body)).toContain('code=c-1');
    expect(calls[1].url).toBe('https://api.xero.com/connections');
  });

  it('stores the one organisation as the external account', async () => {
    stub({ body: token(null) }, { body: [{ tenantId: 't-1', tenantType: 'ORGANISATION', tenantName: 'Acme' }] });
    const out = await xeroAdapter.exchangeCode!({ config: {}, code: 'c', redirectUri: 'r', callbackParams: {} });
    expect(out).toMatchObject({ externalAccountId: 't-1', refreshToken: 'refresh-1', expiresInSeconds: 1800 });
  });

  it('takes the organisation connected in THIS authorisation, not one connected earlier', async () => {
    stub(
      { body: token('ev-now') },
      {
        body: [
          { tenantId: 't-old', tenantType: 'ORGANISATION', authEventId: 'ev-before' },
          { tenantId: 't-new', tenantType: 'ORGANISATION', authEventId: 'ev-now' },
        ],
      },
    );
    const out = await xeroAdapter.exchangeCode!({ config: {}, code: 'c', redirectUri: 'r', callbackParams: {} });
    expect(out.externalAccountId).toBe('t-new');
  });

  it('refuses to guess between several organisations', async () => {
    stub(
      { body: token('ev-now') },
      {
        body: [
          { tenantId: 't-a', tenantType: 'ORGANISATION', authEventId: 'ev-now' },
          { tenantId: 't-b', tenantType: 'ORGANISATION', authEventId: 'ev-now' },
        ],
      },
    );
    await expect(
      xeroAdapter.exchangeCode!({ config: {}, code: 'c', redirectUri: 'r', callbackParams: {} }),
    ).rejects.toThrow(/2 organisations.*choose only/);
  });

  it('ignores a practice, which is not a ledger', () => {
    expect(
      chooseTenant(
        [
          { tenantId: 'p', tenantType: 'PRACTICE' },
          { tenantId: 'o', tenantType: 'ORGANISATION' },
        ],
        null,
      ).tenantId,
    ).toBe('o');
  });

  it('says what to do when Xero reports no organisation', () => {
    expect(() => chooseTenant([], null)).toThrow(/choose your organisation/);
  });

  it('reads the authorisation event from the access token, and nothing from a non-JWT', () => {
    expect(authEventIdOf(jwt({ authentication_event_id: 'ev-1' }))).toBe('ev-1');
    expect(authEventIdOf('opaque-token')).toBeNull();
    expect(authEventIdOf('a.%%%.b')).toBeNull();
  });
});

describe('refreshing', () => {
  it('hands back the ROTATED refresh token, which replaces the old one', async () => {
    stub({ body: { access_token: 'a-2', refresh_token: 'refresh-2', expires_in: 1800 } });
    const out = await xeroAdapter.refreshTokens!({ config: {}, refreshToken: 'refresh-1' });
    expect(out).toMatchObject({ accessToken: 'a-2', refreshToken: 'refresh-2' });
    expect(String(calls[0].init.body)).toContain('grant_type=refresh_token');
    expect(String(calls[0].init.body)).toContain('refresh_token=refresh-1');
  });

  it('asks a human to connect again on invalid_grant — the refresh token is dead', async () => {
    stub({ status: 400, body: { error: 'invalid_grant' } });
    await expect(xeroAdapter.refreshTokens!({ config: {}, refreshToken: 'r' })).rejects.toBeInstanceOf(
      OAuthConsentRequired,
    );
  });

  it('does NOT ask for consent on anything else, so core retries a blip', async () => {
    stub({ status: 503, body: 'unavailable' });
    const err = await xeroAdapter.refreshTokens!({ config: {}, refreshToken: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OAuthConsentRequired);
    expect((err as Error).message).toContain('503');
  });

  it('turns a network failure into a sentence, not a consent request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND identity.xero.com');
      }),
    );
    const err = await xeroAdapter.refreshTokens!({ config: {}, refreshToken: 'r' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(OAuthConsentRequired);
    expect((err as Error).message).toMatch(/could not reach Xero/);
  });
});

describe('the Test button', () => {
  it('reads the organisation with the tenant header, and says posting is not there', async () => {
    stub({ body: { Organisations: [{ Name: 'Acme Ltd' }] } });
    const out = await xeroAdapter.testConnection({ oauthAccessToken: 'a-1', externalAccountId: 't-1' });
    expect(calls[0].url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['xero-tenant-id']).toBe('t-1');
    expect(headers.authorization).toBe('Bearer a-1');
    expect(out.ok).toBe(true);
    expect(out.detail).toContain('Acme Ltd');
    expect(out.detail).toContain('POSTING IS NOT IMPLEMENTED');
  });

  it("reports Xero's own refusal verbatim", async () => {
    stub({ status: 403, body: 'AuthorizationUnsuccessful' });
    const out = await xeroAdapter.testConnection({ oauthAccessToken: 'a', externalAccountId: 't' });
    expect(out).toEqual({ ok: false, detail: 'Xero returned 403: AuthorizationUnsuccessful' });
  });

  it('says it is not authorised yet when there is no token', async () => {
    await expect(xeroAdapter.testConnection({})).resolves.toMatchObject({ ok: false });
  });
});

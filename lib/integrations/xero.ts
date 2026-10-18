/**
 * w5-03 — Xero. DORMANT ON PURPOSE, exactly as QuickBooks is (`quickbooks.ts`, VX3-8).
 *
 * VeloExpense-built, not a port: ExpenseOS has no Xero adapter (decided 17 Oct 2026, d80:
 * VeloExpense's ledgers are QuickBooks Online, VeloLedger and Xero; no NetSuite for now).
 *
 * ── What this file is, and what it deliberately is not ──────────────────────
 *
 * The AUTHENTICATION half of a Xero adapter: the redirect, the token exchange, choosing
 * the organisation, the refresh, and the difference between a refresh that needs a
 * human and one that needs another try. Like QuickBooks's, it declares NO capabilities,
 * so core's `resolveCapability(tx, 'POST_EXPENSE_REPORT')` never selects it. Posting a
 * bill is written against a Xero demo company, not from documentation — QuickBooks's
 * header has the reason: "An adapter that looks finished and has never run is worse than
 * an adapter that says what it cannot do."
 *
 * ── The app credentials are PLATFORM-level, not per tenant ───────────────────
 *
 * One Xero app serves every tenant; each tenant connects that app to their own Xero
 * organisation. `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` come from the environment, and
 * `available()` is false while they are unset — so no tenant can see Xero until the
 * platform has an app, and it appears the day they are set.
 *
 * ── Checked against Xero's documentation, 17 Oct 2026, and what was not ─────
 *
 *   · Endpoints: authorize `login.xero.com/identity/connect/authorize`, token
 *     `identity.xero.com/connect/token` (client authentication by HTTP Basic), tenants from
 *     `api.xero.com/connections`, and every Accounting API call carries `xero-tenant-id`.
 *   · Refresh tokens ROTATE: each refresh returns a new one and the old one stops working.
 *     The contract's `refreshToken` replaces the stored one, so that is handled.
 *   · Scopes: an app created on or after 2 March 2026 cannot request the broad
 *     `accounting.transactions` and must ask for granular scopes; `accounting.settings`,
 *     `accounting.contacts` and `accounting.attachments` are unchanged. See `SCOPES`.
 *   · NOT verified: that `accounting.settings` still covers the Organisation endpoint the
 *     Test button reads (the scopes page did not render when fetched), and the name of the
 *     access-token claim that carries the authorisation event (`authentication_event_id`,
 *     see `chooseTenant`). Both want a glance on the first real connection; neither can
 *     do harm if wrong — the first makes Test report Xero's 403, the second falls back to
 *     refusing an ambiguous choice.
 *   · Token LIFETIMES are not relied on: expiries come from Xero's own `expires_in`.
 */
import {
  OAuthConsentRequired,
  type AccountingAdapter,
  type AdapterConfig,
  type OAuthTokens,
  type TestResult,
} from '@/lib/integrations/contract';

/** Seconds. Same budget as the other adapters. */
const TIMEOUT_SECONDS = 20;

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * What the connection asks for — what POSTING will need, so a tenant does not have to
 * authorise again when it ships, and nothing more:
 *
 *   · `offline_access`: a refresh token at all. Without it the connection dies in minutes.
 *   · `accounting.settings`: the organisation (the Test button) and the chart of accounts.
 *   · `accounting.invoices`: a bill is an ACCPAY invoice. The granular replacement for
 *     `accounting.transactions`, which an app created after 2 March 2026 cannot request.
 *   · `accounting.contacts`: the employee being reimbursed is the bill's contact.
 *   · `accounting.attachments`: the receipts, on the bill.
 *   · `accounting.payments.read`: whether the bill has been paid (READ_PAYMENT_STATUS).
 *     Read only — nothing here makes a payment.
 */
export const SCOPES = [
  'offline_access',
  'accounting.settings',
  'accounting.invoices',
  'accounting.contacts',
  'accounting.attachments',
  'accounting.payments.read',
] as const;

function platformCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.XERO_CLIENT_ID?.trim();
  const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** `fetch` with this adapter's timeout, and a sentence for a far end that never answered. */
async function call(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (err) {
    throw new Error(
      err instanceof Error && err.name === 'AbortError'
        ? `Xero did not answer within ${TIMEOUT_SECONDS} seconds`
        : `could not reach Xero: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call to the token endpoint, for both the initial exchange and refreshes.
 *
 * The classification is QuickBooks's, for QuickBooks's reason: `invalid_grant` is the far
 * end saying the refresh token is expired or revoked — only a human can fix that, so it is
 * `OAuthConsentRequired` and core asks for consent. Everything else (a timeout, a 5xx, a
 * DNS failure) is a plain error that core retries, so a network blip never marks a working
 * connection as dead.
 */
async function tokenRequest(body: URLSearchParams): Promise<OAuthTokens> {
  const creds = platformCredentials();
  if (!creds) {
    throw new Error(
      'Xero is not configured on this deployment: XERO_CLIENT_ID and XERO_CLIENT_SECRET are unset.',
    );
  }
  const response = await call(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuthHeader(creds.clientId, creds.clientSecret),
    },
    body: body.toString(),
  });
  const text = await response.text();
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    // Not JSON. Keep the body — it is more useful than a parse complaint.
  }
  if (!response.ok) {
    const detail = parsed.error_description ?? parsed.error ?? text.slice(0, 300);
    if (parsed.error === 'invalid_grant') {
      throw new OAuthConsentRequired(
        `Xero will not renew this connection: ${detail}. Somebody with access to the Xero ` +
          `organisation has to connect it again.`,
      );
    }
    throw new Error(`Xero token endpoint returned ${response.status}: ${detail}`);
  }
  if (!parsed.access_token) throw new Error('Xero returned no access token');
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInSeconds: parsed.expires_in,
    scope: parsed.scope,
  };
}

interface XeroConnection {
  tenantId?: string;
  tenantType?: string;
  tenantName?: string;
  authEventId?: string;
}

/** The access token's `authentication_event_id` claim, or null. Read, not verified: the
 *  token came straight from Xero's token endpoint, and the claim only narrows OUR choice. */
export function authEventIdOf(accessToken: string): string | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const id = claims.authentication_event_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Which Xero organisation this connection is for.
 *
 * Xero has no QuickBooks-style `realmId` on the callback. The consent screen lets the
 * person pick organisations, and `/connections` then lists every organisation connected to
 * the app by that Xero user — including ones connected earlier, for something else. So:
 *
 *   1. organisations only (`tenantType` ORGANISATION — a PRACTICE is not a ledger);
 *   2. narrowed to the ones connected in THIS authorisation, by the access token's
 *      authorisation event, when the token carries one;
 *   3. exactly one, or a refusal that says what to do. Picking one of several would post
 *      a tenant's reports into a ledger nobody chose.
 */
export function chooseTenant(connections: XeroConnection[], authEventId: string | null): XeroConnection {
  const orgs = connections.filter((c) => c.tenantId && (c.tenantType ?? 'ORGANISATION') === 'ORGANISATION');
  const thisTime = authEventId ? orgs.filter((c) => c.authEventId === authEventId) : [];
  const candidates = thisTime.length > 0 ? thisTime : orgs;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(
      'Xero did not report an organisation for this connection, so there is nothing to post ' +
        'to. Connect again and choose your organisation when Xero asks.',
    );
  }
  throw new Error(
    `Xero connected ${candidates.length} organisations at once, and a VeloExpense ` +
      'connection is to exactly one. Connect again and choose only the organisation this ' +
      'company posts to.',
  );
}

export const xeroAdapter: AccountingAdapter = {
  slug: 'xero',
  name: 'Xero',
  description:
    'Connects a Xero organisation. Connecting works today; posting expense reports does ' +
    'not ship yet and this adapter declares no posting capability, so nothing will try.',
  auth: 'OAUTH2',

  /**
   * NO CAPABILITIES, as QuickBooks: an adapter that declared `POST_EXPENSE_REPORT` without a
   * verified implementation would be selected by `resolveCapability` and fail on somebody's
   * real report. The registry's pairing check makes a declared-but-missing method a
   * startup failure.
   */
  capabilities: [],

  /** Nothing to type: the app credentials are the platform's, and the organisation is
   *  chosen inside Xero during the redirect. */
  configFields: [],

  setupSteps: [
    'Sign in to Xero as somebody who can connect apps to the organisation.',
    'Choose ONE organisation when Xero asks — the one this company posts to.',
    'Come back here; the connection is stored against this organisation only.',
  ],

  available: () => platformCredentials() !== null,

  authorizeUrl({ state, redirectUri }): string {
    const creds = platformCredentials();
    if (!creds) throw new Error('Xero is not configured on this deployment');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri }): Promise<OAuthTokens> {
    const tokens = await tokenRequest(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    );
    const response = await call(CONNECTIONS_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${tokens.accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Xero would not list the connected organisations (${response.status}): ${text.slice(0, 300)}`);
    }
    let connections: XeroConnection[] = [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) connections = parsed as XeroConnection[];
    } catch {
      // Falls through to "no organisation", which says what to do.
    }
    const tenant = chooseTenant(connections, authEventIdOf(tokens.accessToken));
    // Stored under the neutral name `external_account_id`, as QuickBooks's realm is.
    return { ...tokens, externalAccountId: tenant.tenantId };
  },

  async refreshTokens({ refreshToken }): Promise<OAuthTokens> {
    return tokenRequest(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    );
  },

  /**
   * A real read against the connected organisation, and an honest report of what it
   * proves: the Organisation endpoint needs a valid token AND the right tenant, so it
   * establishes that the connection works — and nothing about posting.
   */
  async testConnection(config: AdapterConfig): Promise<TestResult> {
    const accessToken = config.oauthAccessToken;
    const tenantId = config.externalAccountId;
    if (!accessToken || !tenantId) {
      return { ok: false, detail: 'Not authorised yet. Use "Connect" to sign in to Xero.' };
    }
    try {
      const response = await call(`${API_BASE}/Organisation`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
        },
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, detail: `Xero returned ${response.status}: ${text.slice(0, 300)}` };
      }
      let name = tenantId;
      try {
        const parsed = JSON.parse(text) as { Organisations?: Array<{ Name?: string }> };
        name = parsed.Organisations?.[0]?.Name ?? tenantId;
      } catch {
        // Reachable is what mattered; the name is a courtesy.
      }
      return {
        ok: true,
        detail:
          `Reached Xero organisation "${name}". POSTING IS NOT IMPLEMENTED for Xero yet — ` +
          'this adapter declares no posting capability, so approved reports will not be sent ' +
          'here and will keep waiting for a ledger that can take them.',
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

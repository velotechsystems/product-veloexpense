/**
 * VX3-8 — QuickBooks Online. DORMANT ON PURPOSE.
 *
 * ── What this file is, and what it deliberately is not ──────────────────────
 *
 * It is the AUTHENTICATION half of a QuickBooks adapter, complete and testable:
 * the redirect, the token exchange, the refresh, and the distinction between a
 * refresh that needs a human and one that needs another try. That half is generic
 * OAuth2 against documented, stable endpoints, and getting it right does not
 * require an account.
 *
 * It is NOT the posting half. `postExpenseReport` and `pullChartOfAccounts` are
 * absent, and the adapter declares NO capabilities, so the registry's pairing
 * check is satisfied and core's `resolveCapability(tx, 'POST_EXPENSE_REPORT')`
 * will never select it.
 *
 * That is a decision, not an omission. Writing a Bill payload from documentation
 * and shipping it unexecuted would produce exactly what GAP-AUDIT already
 * criticises on the other side: ExpenseOS's NetSuite posting transport carries its
 * own "⚠️ UNVERIFIED against a live account" warning, and VX3-3 flag-gated the
 * stub specifically so nobody could connect something that reports success without
 * doing anything. An adapter that looks finished and has never run is worse than
 * an adapter that says what it cannot do.
 *
 * ── So what does connecting it achieve today? ────────────────────────────────
 *
 * Everything except the posting: an admin can authorise a real QuickBooks company,
 * the tokens are stored encrypted, they refresh, and `testConnection` calls a real
 * endpoint and reports what came back. On the day the first QBO client is
 * onboarded, the remaining work is the Bill mapping against a sandbox — not the
 * auth flow, the state handling, the token storage or the refresh, which are the
 * parts that are tedious to get right under time pressure.
 *
 * ── The app credentials are PLATFORM-level, not per tenant ───────────────────
 *
 * One Intuit app serves every tenant; each tenant authorises that app against
 * their own company. So the client id and secret come from the environment, not
 * from `configFields` — the same shape NT-18 established for email transport,
 * which is *"PLATFORM-level and env-configured"*, and for the same reason: asking
 * every tenant to register their own developer app would be absurd.
 *
 * This is also the whole gating mechanism. `available()` returns false while those
 * variables are absent, so QuickBooks is invisible to every tenant until John has
 * credentials — and appears the moment he sets them, with no migration, no code
 * change and no release.
 *
 * ── One thing NOT verified, and it is flagged rather than guessed ─────────────
 *
 * Intuit's developer documentation is JavaScript-rendered and could not be fetched
 * while this was written, so the token LIFETIMES are not quoted anywhere in this
 * file. Nothing here depends on them: expiries come from the far end's own
 * response (`expires_in`, `x_refresh_token_expires_in`) and are stored as absolute
 * timestamps. The endpoint hosts below are the long-stable ones and want a glance
 * against current documentation before the first real connection — that check is
 * on the ticket, not assumed done.
 */
import {
  OAuthConsentRequired,
  type AccountingAdapter,
  type AdapterConfig,
  type OAuthTokens,
  type TestResult,
} from '@/lib/integrations/contract';

/** Seconds. Same budget as the VeloLedger adapter uses. */
const TIMEOUT_SECONDS = 20;

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/**
 * Accounting scope. `com.intuit.quickbooks.accounting` is what reading a chart of
 * accounts and writing a bill both need. Deliberately NOT requesting the payments
 * scope: nothing here touches payments, and an integration that asks for more than
 * it uses is one an accountant is right to refuse.
 */
const SCOPE = 'com.intuit.quickbooks.accounting';

/**
 * Sandbox and production differ ONLY in the API host — the OAuth endpoints above
 * are shared. Read at call time.
 */
function apiBase(): string {
  return process.env.QUICKBOOKS_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function platformCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** HTTP Basic, as Intuit's token endpoint expects for client authentication. */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * One call to the token endpoint, for both the initial exchange and refreshes.
 *
 * ── The error classification is the load-bearing part ───────────────────────
 *
 * `invalid_grant` is the far end saying the refresh token is expired or revoked:
 * no amount of retrying fixes it and a human must consent again, so it becomes
 * `OAuthConsentRequired` and core sets the re-consent flag. EVERYTHING ELSE —
 * a timeout, a 5xx, a DNS failure — is a plain error, so core retries and does not
 * nag an admin to re-authorise a connection that is fine.
 *
 * Getting that backwards in either direction is the failure mode AC-17 is about,
 * one layer down.
 */
async function tokenRequest(body: URLSearchParams): Promise<OAuthTokens> {
  const creds = platformCredentials();
  if (!creds) {
    throw new Error(
      'QuickBooks is not configured on this deployment: QUICKBOOKS_CLIENT_ID and ' +
        'QUICKBOOKS_CLIENT_SECRET are unset.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuthHeader(creds.clientId, creds.clientSecret),
      },
      body: body.toString(),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // Ambiguous by nature, and NOT a consent problem. A refresh that failed
    // because the network dropped must not mark a working connection as dead.
    throw new Error(
      err instanceof Error && err.name === 'AbortError'
        ? `QuickBooks did not answer within ${TIMEOUT_SECONDS} seconds`
        : `could not reach QuickBooks: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

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
        `QuickBooks will not renew this connection: ${detail}. Somebody with access ` +
          `to the QuickBooks company has to authorise it again.`,
      );
    }
    throw new Error(`QuickBooks token endpoint returned ${response.status}: ${detail}`);
  }

  if (!parsed.access_token) {
    throw new Error('QuickBooks returned no access token');
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInSeconds: parsed.expires_in,
    refreshExpiresInSeconds: parsed.x_refresh_token_expires_in,
    scope: parsed.scope,
  };
}

export const quickBooksAdapter: AccountingAdapter = {
  slug: 'quickbooks',
  name: 'QuickBooks Online',
  description:
    'Connects a QuickBooks Online company. Authorisation works today; posting ' +
    'expense reports does not ship yet and this adapter declares no posting ' +
    'capability, so nothing will try.',
  auth: 'OAUTH2',

  /**
   * NO CAPABILITIES. See the header: the posting half is not written, and an
   * adapter that declared `POST_EXPENSE_REPORT` without a verified implementation
   * would be selected by `resolveCapability` and fail on somebody's real report.
   *
   * The registry's pairing check makes this consistent rather than merely tidy: a
   * capability declared here without its method is a startup failure.
   */
  capabilities: [],

  /**
   * Nothing for the tenant to type — the app credentials are the platform's, and
   * the company is chosen inside QuickBooks during the redirect.
   */
  configFields: [],

  setupSteps: [
    'Sign in to QuickBooks as somebody who can authorise apps for the company.',
    'Choose the company when QuickBooks asks — VeloExpense records which one you picked.',
    'Come back here; the connection is stored against this organisation only.',
  ],

  /**
   * Invisible until the platform has Intuit credentials. This is the whole
   * "ready to connect later" mechanism: no tenant can see or connect QuickBooks
   * while these are unset, and the day they are set it appears.
   */
  available: () => platformCredentials() !== null,

  authorizeUrl({ state, redirectUri }): string {
    const creds = platformCredentials();
    if (!creds) throw new Error('QuickBooks is not configured on this deployment');
    const params = new URLSearchParams({
      client_id: creds.clientId,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, redirectUri, callbackParams }): Promise<OAuthTokens> {
    const tokens = await tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    );
    // The company identifier arrives on the CALLBACK, not in the token response —
    // QuickBooks calls it `realmId`. This is the one place that word appears in
    // the product, which is why `integration_installation` stores it under the
    // neutral name `external_account_id`.
    const realmId = callbackParams.realmId?.trim();
    if (!realmId) {
      throw new Error(
        'QuickBooks did not say which company was authorised, so there is nothing ' +
          'to post to. Start the connection again from the integrations screen.',
      );
    }
    return { ...tokens, externalAccountId: realmId };
  },

  async refreshTokens({ refreshToken }): Promise<OAuthTokens> {
    return tokenRequest(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    );
  },

  /**
   * A real call against the authorised company, and an honest report of what it
   * proves. `CompanyInfo` is the cheapest read that requires both a valid token
   * and the right company, so it establishes that the connection works — and
   * nothing at all about posting, because the posting half does not exist.
   */
  async testConnection(config: AdapterConfig): Promise<TestResult> {
    const accessToken = config.oauthAccessToken;
    const realmId = config.externalAccountId;
    if (!accessToken || !realmId) {
      return {
        ok: false,
        detail: 'Not authorised yet. Use "Connect" to sign in to QuickBooks.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
    try {
      const response = await fetch(
        `${apiBase()}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}`,
        {
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
          cache: 'no-store',
        },
      );
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, detail: `QuickBooks returned ${response.status}: ${text.slice(0, 300)}` };
      }
      let name = realmId;
      try {
        const parsed = JSON.parse(text) as { CompanyInfo?: { CompanyName?: string } };
        name = parsed.CompanyInfo?.CompanyName ?? realmId;
      } catch {
        // Reachable is what mattered; the name is a courtesy.
      }
      return {
        ok: true,
        detail:
          `Reached QuickBooks company "${name}". POSTING IS NOT IMPLEMENTED for ` +
          `QuickBooks yet — this adapter declares no posting capability, so approved ` +
          `reports will not be sent here and will keep waiting for a ledger that can ` +
          `take them.`,
      };
    } catch (err) {
      return {
        ok: false,
        detail:
          err instanceof Error && err.name === 'AbortError'
            ? `QuickBooks did not answer within ${TIMEOUT_SECONDS} seconds`
            : `could not reach QuickBooks: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

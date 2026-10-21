import { createSign } from 'node:crypto';
import type { GoogleUser } from './types';

/**
 * Admin SDK Directory client. Authenticates as a
 * service account with domain-wide delegation, impersonating an
 * admin user with directory.user.readonly scope.
 *
 * w5-04 — ExpenseOS `packages/integrations-google/src/client.ts` (1e682dd6): its scope, its
 * three refusals and their sentences, and its `GOOGLE_DIRECTORY_DISABLED` switch.
 *
 * VeloExpense, REBUILT rather than ported, and said plainly:
 *   · PER TENANT (d84). ExpenseOS reads one key and one admin address from the environment
 *     and caches one client on `globalThis`. Here each tenant's administrator pastes their own
 *     service-account key and admin address at /admin/directory-sync, stored encrypted in
 *     `google_directory_connection` (0076); the caller decrypts them and passes them in. Nothing is
 *     cached across tenants — a client lives for one sync or one test.
 *   · NO `googleapis` / `google-auth-library`. ExpenseOS uses them for two calls: sign a JWT
 *     and list users. They are large, VeloExpense has neither, and the two calls are small, so
 *     this does Google's documented service-account flow by hand — an RS256 JWT signed with
 *     node:crypto, exchanged at oauth2.googleapis.com/token (the jwt-bearer grant), then
 *     `GET admin/directory/v1/users` with the access token. `users.list` keeps the Admin SDK's
 *     parameter names and `{ data }` result, so `syncAll.ts` reads as ExpenseOS's.
 *   · The kill switch stays, as the PLATFORM's: `GOOGLE_DIRECTORY_DISABLED=true` turns every
 *     tenant's sync off (offline dev, CI).
 *
 * A service-account key must never reach a log, an error message, an audit row or the
 * browser. Every error here names the field, never its value, and a Google error carries
 * Google's own message, which never echoes the assertion.
 */

const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.readonly'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERS_URL = 'https://admin.googleapis.com/admin/directory/v1/users';
/** VeloExpense: a hung Google must not hold a worker slot for ever. */
const TIMEOUT_MS = 30_000;

export class GoogleDirectoryDisabledError extends Error {
  constructor() {
    super('Google Directory integration is disabled (GOOGLE_DIRECTORY_DISABLED=true)');
    this.name = 'GoogleDirectoryDisabledError';
  }
}

export class GoogleDirectoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDirectoryConfigError';
  }
}

export function isDirectoryDisabled(): boolean {
  return process.env.GOOGLE_DIRECTORY_DISABLED === 'true';
}

/** VeloExpense: what a tenant stored, decrypted — ExpenseOS's two environment variables. */
export interface DirectoryCredentials {
  /** The service-account key file's JSON, as pasted (ExpenseOS's GOOGLE_SERVICE_ACCOUNT_JSON). */
  serviceAccountJson: string;
  /** The Workspace admin to impersonate (ExpenseOS's GOOGLE_DIRECTORY_IMPERSONATE_EMAIL). */
  impersonateEmail: string;
}

export interface UsersListParams {
  customer: string;
  maxResults: number;
  pageToken?: string;
  projection: 'basic' | 'full';
  orderBy: 'email' | 'givenName' | 'familyName';
  /** #582: list accounts deleted in Google (kept about 20 days) instead of live ones. */
  showDeleted?: 'true';
}

export interface DirectoryClient {
  users: {
    list(params: UsersListParams): Promise<{ data: { users?: GoogleUser[]; nextPageToken?: string } }>;
  };
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Parse a pasted key file. VeloExpense: also run when the key is SAVED, so a bad paste is
 * refused on the form rather than discovered by the night's sync. Never quotes the input.
 */
export function parseServiceAccountJson(rawJson: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new GoogleDirectoryConfigError(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  const key = parsed as Partial<ServiceAccountKey> & { type?: unknown };
  if (typeof key?.client_email !== 'string' || !key.client_email.includes('@')) {
    throw new GoogleDirectoryConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON has no client_email — paste the whole key file Google downloaded',
    );
  }
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
    throw new GoogleDirectoryConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON has no private_key — paste the whole key file Google downloaded',
    );
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

export function getDirectoryClient(
  credentials: DirectoryCredentials | null,
  // VeloExpense: injectable, so the flow is tested without reaching Google.
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): DirectoryClient {
  if (isDirectoryDisabled()) {
    throw new GoogleDirectoryDisabledError();
  }

  const rawJson = credentials?.serviceAccountJson;
  if (!rawJson) {
    throw new GoogleDirectoryConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON not set — provide the service account key',
    );
  }

  const subject = credentials?.impersonateEmail;
  if (!subject) {
    throw new GoogleDirectoryConfigError(
      'GOOGLE_DIRECTORY_IMPERSONATE_EMAIL not set — provide the admin user to impersonate',
    );
  }

  const key = parseServiceAccountJson(rawJson);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  let token: { value: string; expiresAt: number } | null = null;
  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const assertion = signJwt(key, subject as string, now());
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      // Google's own words — `unauthorized_client` is the one an operator sees when domain-wide
      // delegation has not been granted for this client id and scope.
      throw new Error(
        `Google refused the service account (${res.status}): ${body.error ?? 'no error code'}` +
          (body.error_description ? ` — ${body.error_description}` : ''),
      );
    }
    token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  return {
    users: {
      async list(params) {
        const url = new URL(USERS_URL);
        url.searchParams.set('customer', params.customer);
        url.searchParams.set('maxResults', String(params.maxResults));
        url.searchParams.set('projection', params.projection);
        url.searchParams.set('orderBy', params.orderBy);
        if (params.pageToken) url.searchParams.set('pageToken', params.pageToken);
        if (params.showDeleted) url.searchParams.set('showDeleted', params.showDeleted);
        const res = await doFetch(url, {
          headers: { authorization: `Bearer ${await accessToken()}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => ({}))) as {
          users?: GoogleUser[];
          nextPageToken?: string;
          error?: { message?: string };
        };
        if (!res.ok) {
          throw new Error(`${res.status} ${body.error?.message ?? res.statusText}`);
        }
        return { data: { users: body.users, nextPageToken: body.nextPageToken } };
      },
    },
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Google's service-account assertion: RS256, one hour, for the token endpoint. */
function signJwt(key: ServiceAccountKey, subject: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope: SCOPES.join(' '),
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key, 'base64url');
  } catch {
    // Never the key, nor node's message about it.
    throw new GoogleDirectoryConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON has a private_key that cannot sign — paste the key file again',
    );
  }
  return `${header}.${claims}.${signature}`;
}

/** For the client test: the scopes requested, which must stay read-only. */
export const DIRECTORY_SCOPES: readonly string[] = SCOPES;

/**
 * VeloExpense: the admin screen's "Test connection" — ExpenseOS has no screen, and finds out
 * at the next sync. One `users.list` of a single user, read-only, with the same client the
 * sync uses, so a pass here means the sync can sign in and read. Never throws: every failure
 * is an answer for the screen, in Google's words where Google gave them.
 */
export async function verifyDirectoryAccess(
  credentials: DirectoryCredentials,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<{ ok: boolean; message: string }> {
  try {
    const client = getDirectoryClient(credentials, deps);
    const res = await client.users.list({
      customer: 'my_customer',
      maxResults: 1,
      projection: 'basic',
      orderBy: 'email',
    });
    return {
      ok: true,
      message:
        (res.data.users?.length ?? 0) > 0
          ? `Signed in as ${credentials.impersonateEmail} and read the directory.`
          : `Signed in as ${credentials.impersonateEmail}, but the directory returned nobody.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

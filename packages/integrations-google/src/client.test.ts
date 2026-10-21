// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_SCOPES,
  GoogleDirectoryConfigError,
  GoogleDirectoryDisabledError,
  getDirectoryClient,
  isDirectoryDisabled,
  parseServiceAccountJson,
  verifyDirectoryAccess,
} from './client';

/**
 * The Directory client's construction, which was at 0%.
 *
 * Nothing here talks to Google — what it decides is which of three refusals an operator
 * gets, and those are the difference between "the integration is off on purpose",
 * "somebody forgot an env var", and "the key is corrupt". Directory sync currently
 * returns `disabled` on dev for exactly this reason, so the messages are the whole
 * diagnostic surface.
 *
 * w5-04 — ported from ExpenseOS `client.test.ts` (1e682dd6), for VeloExpense's rebuilt
 * client (see ./client.ts): the credentials are passed in rather than read from the
 * environment, and the JWT and the token exchange are this file's own, so where ExpenseOS
 * asserts the arguments to `google-auth-library`'s JWT, these assert the request Google
 * receives — with a real RSA key, so the signature is real. `fetch` is a stub throughout.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key: PEM,
});
const CREDS = { serviceAccountJson: KEY, impersonateEmail: 'admin@example.test' };

function stubFetch(
  answers: Array<{ status: number; body: unknown }>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const queue = [...answers];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const TOKEN = { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } };

function claimsOf(body: string): Record<string, unknown> {
  const assertion = new URLSearchParams(body).get('assertion') ?? '';
  return JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
}

beforeEach(() => {
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
});
afterEach(() => {
  delete process.env.GOOGLE_DIRECTORY_DISABLED;
});

describe('isDirectoryDisabled', () => {
  it('is true only for the exact string true', () => {
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    expect(isDirectoryDisabled()).toBe(true);
    // Not '1', not 'yes' — an env var that half-works is worse than one that does not.
    for (const v of ['1', 'yes', 'TRUE', '']) {
      process.env.GOOGLE_DIRECTORY_DISABLED = v;
      expect(isDirectoryDisabled()).toBe(false);
    }
  });
});

describe('getDirectoryClient', () => {
  it('signs a JWT with domain-wide delegation and the readonly scope', async () => {
    const { fetch: f, calls } = stubFetch([TOKEN, { status: 200, body: { users: [] } }]);
    await getDirectoryClient(CREDS, { fetch: f }).users.list({
      customer: 'my_customer',
      maxResults: 1,
      projection: 'full',
      orderBy: 'email',
    });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const body = String(calls[0].init?.body);
    expect(new URLSearchParams(body).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    // Read-only, and impersonating the named admin — the two properties that keep a
    // directory sync from being able to change anything in Workspace.
    expect(claimsOf(body)).toMatchObject({
      iss: 'svc@p.iam.gserviceaccount.com',
      sub: 'admin@example.test',
      scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect(DIRECTORY_SCOPES).toEqual(['https://www.googleapis.com/auth/admin.directory.user.readonly']);
    // VeloExpense: the signature is real — Google would check it against this public key.
    const [h, c, sig] = (new URLSearchParams(body).get('assertion') ?? '').split('.');
    const { createVerify } = await import('node:crypto');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url')).toBe(true);
  });

  it('lists users with the Admin SDK parameters and the access token', async () => {
    const { fetch: f, calls } = stubFetch([
      TOKEN,
      { status: 200, body: { users: [{ primaryEmail: 'a@example.test' }], nextPageToken: 'p2' } },
    ]);
    const res = await getDirectoryClient(CREDS, { fetch: f }).users.list({
      customer: 'my_customer',
      maxResults: 500,
      pageToken: 'p1',
      projection: 'full',
      orderBy: 'email',
    });
    const url = new URL(calls[1].url);
    expect(url.origin + url.pathname).toBe('https://admin.googleapis.com/admin/directory/v1/users');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      customer: 'my_customer',
      maxResults: '500',
      pageToken: 'p1',
      projection: 'full',
      orderBy: 'email',
    });
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    expect(res).toEqual({ data: { users: [{ primaryEmail: 'a@example.test' }], nextPageToken: 'p2' } });
  });

  it('lists the accounts deleted in Google when asked (#582)', async () => {
    // VeloExpense: ExpenseOS 67db2e33's sync reads `showDeleted` through googleapis; this
    // client builds the URL itself, so the parameter is pinned here.
    const { fetch: f, calls } = stubFetch([TOKEN, { status: 200, body: { users: [] } }]);
    await getDirectoryClient(CREDS, { fetch: f }).users.list({
      customer: 'my_customer',
      maxResults: 500,
      projection: 'full',
      orderBy: 'email',
      showDeleted: 'true',
    });
    expect(new URL(calls[1].url).searchParams.get('showDeleted')).toBe('true');
  });

  it('asks for one token per run, not one per page', async () => {
    const { fetch: f, calls } = stubFetch([
      TOKEN,
      { status: 200, body: { users: [] } },
      { status: 200, body: { users: [] } },
    ]);
    const client = getDirectoryClient(CREDS, { fetch: f });
    const params = { customer: 'my_customer', maxResults: 1, projection: 'full', orderBy: 'email' } as const;
    await client.users.list(params);
    await client.users.list(params);
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it("carries Google's refusal in Google's words, and never the key", async () => {
    // `unauthorized_client` is what an operator sees when domain-wide delegation was not
    // granted for this client id and scope.
    const { fetch: f } = stubFetch([
      { status: 401, body: { error: 'unauthorized_client', error_description: 'Client is unauthorized' } },
    ]);
    const err = await getDirectoryClient(CREDS, { fetch: f })
      .users.list({ customer: 'my_customer', maxResults: 1, projection: 'full', orderBy: 'email' })
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/unauthorized_client/);
    expect(String(err)).not.toContain('PRIVATE KEY');
  });

  it('refuses when deliberately disabled, distinctly from misconfiguration', () => {
    // A distinct error type, because "off on purpose" needs no operator action while a
    // config error does.
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    expect(() => getDirectoryClient(CREDS)).toThrow(GoogleDirectoryDisabledError);
  });

  it('names the missing service-account key', () => {
    expect(() => getDirectoryClient({ ...CREDS, serviceAccountJson: '' })).toThrow(
      /GOOGLE_SERVICE_ACCOUNT_JSON not set/,
    );
    expect(() => getDirectoryClient(null)).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON not set/);
  });

  it('names the missing impersonation address', () => {
    // Domain-wide delegation cannot work without a subject, and the Google error for
    // this is unactionable ("unauthorized_client").
    expect(() => getDirectoryClient({ ...CREDS, impersonateEmail: '' })).toThrow(
      /IMPERSONATE_EMAIL not set/,
    );
  });

  it('reports unparseable JSON as a config error, quoting the parse failure', () => {
    // The realistic corruption: a key pasted with a line break, or a secret truncated.
    const bad = { ...CREDS, serviceAccountJson: '{not json' };
    expect(() => getDirectoryClient(bad)).toThrow(GoogleDirectoryConfigError);
    expect(() => getDirectoryClient(bad)).toThrow(/not valid JSON/);
  });
});

describe('parseServiceAccountJson (VeloExpense: run on save)', () => {
  it('accepts a key file and returns its two fields', () => {
    expect(parseServiceAccountJson(KEY)).toEqual({
      client_email: 'svc@p.iam.gserviceaccount.com',
      private_key: PEM,
    });
  });

  it('refuses JSON that is not a service-account key, naming the field and never the value', () => {
    expect(() => parseServiceAccountJson('{"private_key":"x"}')).toThrow(/no client_email/);
    const noKey = JSON.stringify({ client_email: 'svc@p.iam.gserviceaccount.com', private_key: 'secret-ish' });
    const err = (() => {
      try {
        parseServiceAccountJson(noKey);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/no private_key/);
    expect(err?.message).not.toContain('secret-ish');
  });
});

describe('verifyDirectoryAccess (VeloExpense: the screen\'s Test)', () => {
  it('passes when Google signs in and reads one person', async () => {
    const { fetch: f, calls } = stubFetch([TOKEN, { status: 200, body: { users: [{}] } }]);
    const r = await verifyDirectoryAccess(CREDS, { fetch: f });
    expect(r).toEqual({ ok: true, message: 'Signed in as admin@example.test and read the directory.' });
    expect(new URL(calls[1].url).searchParams.get('maxResults')).toBe('1');
  });

  it('answers a failure rather than throwing', async () => {
    const { fetch: f } = stubFetch([TOKEN, { status: 403, body: { error: { message: 'Not Authorized to access this resource/api' } } }]);
    expect(await verifyDirectoryAccess(CREDS, { fetch: f })).toEqual({
      ok: false,
      message: '403 Not Authorized to access this resource/api',
    });
    const bad = await verifyDirectoryAccess({ ...CREDS, serviceAccountJson: '{' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/not valid JSON/);
  });

  it('is refused by the platform switch too', async () => {
    process.env.GOOGLE_DIRECTORY_DISABLED = 'true';
    const f = vi.fn();
    const r = await verifyDirectoryAccess(CREDS, { fetch: f as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

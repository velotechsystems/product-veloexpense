import { createHash, randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, request as playwrightRequest, test } from '@playwright/test';
import { signIn } from './support/actors';

/**
 * mcp-oauth — a Claude connector, end to end, against the real server: discovery, Dynamic
 * Client Registration, the consent screen (signed out, then signed in), the code exchange with
 * PKCE, tools over /api/mcp with the access token, a refresh, and disconnecting it on
 * /preferences — after which the token stops on the very next call.
 *
 * Built new: VeloCRM (the source of this port, 59fce1c) has no e2e for its OAuth server; its
 * own verification was connecting Claude by hand. The connector is played here by the test:
 * every request below is one Claude's servers make, with no cookie, except the two the person
 * makes in the browser (consent, and disconnect).
 *
 * The e2e server gets its own RSA signing key from playwright.config.ts. No Redis is needed:
 * the limiter fails open without it, so this runs in CI.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const REDIRECT = 'http://127.0.0.1:9/oauth/callback';

/**
 * mcp-authorize-host: the connector's host. In prod that is `mcp.veloexpense.ai`, DNS-only and
 * reachable by Anthropic's servers but not by a person's browser; the consent screen is on the
 * app origin instead. Here `127.0.0.1:<port>` plays the connector host (playwright.config.ts puts
 * it on MCP_OAUTH_ALLOWED_HOSTS) and `localhost:<port>` — the baseURL, where the session lives —
 * plays the app origin. Every server-to-server call below goes to the connector host; only the
 * browser uses the app origin.
 */
const mcpHost = (baseURL: string) => baseURL.replace('//localhost:', '//127.0.0.1:');

async function anon(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const MY_REPORTS = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'list_my_expense_reports', arguments: {} },
};

test('a Claude connector registers, is allowed by the person, calls tools, refreshes, and stops when disconnected', async ({
  page,
  baseURL,
}) => {
  const MCP = mcpHost(baseURL!);
  const api = await anon(MCP);

  // 1. The connector's first call has no token: 401, and where to find the authorization server.
  const first = await api.post('/api/mcp', { data: LIST });
  expect(first.status()).toBe(401);
  const challenge = first.headers()['www-authenticate'] ?? '';
  expect(challenge).toContain(`resource_metadata="${MCP}/.well-known/oauth-protected-resource/api/mcp"`);

  // 2. Discovery (RFC 9728, then RFC 8414), on the host it was asked at — except the
  // authorization endpoint, which a browser opens, on the app origin.
  const resource = await (await api.get('/.well-known/oauth-protected-resource/api/mcp')).json();
  expect(resource.resource).toBe(`${MCP}/api/mcp`);
  expect(resource.authorization_servers).toEqual([MCP]);
  const meta = await (await api.get('/.well-known/oauth-authorization-server')).json();
  expect(meta.issuer).toBe(MCP);
  expect(meta.token_endpoint).toBe(`${MCP}/oauth/token`);
  expect(meta.registration_endpoint).toBe(`${MCP}/oauth/register`);
  expect(meta.authorization_endpoint).toBe(`${baseURL}/oauth/authorize`);
  expect(meta.code_challenge_methods_supported).toEqual(['S256']);

  // 3. Dynamic Client Registration — anonymous, as Claude does it.
  const reg = await api.post('/oauth/register', { data: { client_name: 'Claude (e2e)', redirect_uris: [REDIRECT] } });
  expect(reg.status()).toBe(201);
  const { client_id: clientId } = await reg.json();
  expect(clientId).toMatch(/^[0-9a-f-]{36}$/);

  // 4. The consent screen. Signed out, it sends the person to sign in with the request intact.
  // The browser opens the authorization endpoint the metadata named (the app origin), with the
  // resource the connector was given — as Claude does.
  const p = pkce();
  const authorize = `${meta.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    scope: 'expense_management.expense_report travel.travel_request admin.security.api_key',
    resource: `${MCP}/api/mcp`,
  })}`;
  await page.goto(authorize);
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Foauth%2Fauthorize/);

  await signIn(page, 'employee');
  await page.goto(authorize);
  await expect(page.getByRole('heading', { name: 'Allow Claude (e2e) to use VeloExpense as you?' })).toBeVisible({
    timeout: 30_000,
  });
  // The admin scope it asked for is not offered: a connector never gets more than a personal key.
  const scopes = page.getByTestId('oauth-scopes');
  await expect(scopes).toContainText('Read and work on your expense reports');
  await expect(scopes).toContainText('Read and work on your travel requests');
  await expect(scopes.locator('li')).toHaveCount(2);

  // Allow → the browser is sent to the client's redirect URI with a code and the state.
  const landed = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
  await page.route(`${REDIRECT}**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
  await page.getByRole('button', { name: 'Allow' }).click();
  const back = new URL((await landed).url());
  expect(back.searchParams.get('state')).toBe('st-1');
  // `iss` is the issuer the connector discovered, not the host the consent screen ran on.
  expect(back.searchParams.get('iss')).toBe(MCP);
  const code = back.searchParams.get('code')!;
  expect(code).toBeTruthy();

  // 5. The code for tokens, with the PKCE verifier. A JSON body is refused.
  const json = await api.post('/oauth/token', { data: { grant_type: 'authorization_code', code } });
  expect(json.status()).toBe(400);
  const tok = await api.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(tok.status()).toBe(200);
  const tokens = await tok.json();
  expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'expense_management.expense_report travel.travel_request' });
  expect(tok.headers()['cache-control']).toBe('no-store');
  // The same code again is refused.
  const again = await api.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: clientId, redirect_uri: REDIRECT },
  });
  expect(again.status()).toBe(400);
  // ...and that ended the grant (RFC 6749 §4.1.2), so connect again for the rest.
  const p2 = pkce();
  const authorize2 = authorize.replace(p.challenge, p2.challenge);
  const landed2 = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
  await page.goto(authorize2);
  await page.getByRole('button', { name: 'Allow' }).click();
  const code2 = new URL((await landed2).url()).searchParams.get('code')!;
  const live = await (
    await api.post('/oauth/token', {
      form: { grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier, client_id: clientId, redirect_uri: REDIRECT },
    })
  ).json();

  // 6. Tools, with the access token: the employee's own reports, in the employee's tenant.
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const list = await api.post('/api/mcp', { data: LIST, headers: bearer(live.access_token) });
  expect(list.status()).toBe(200);
  const names = ((await list.json()).result.tools as { name: string }[]).map((t) => t.name);
  expect(names).toContain('list_my_expense_reports');
  expect(names).not.toContain('decide_expense_report');
  const mine = await api.post('/api/mcp', { data: MY_REPORTS, headers: bearer(live.access_token) });
  expect(mine.status()).toBe(200);
  expect((await mine.json()).result.isError).toBe(false);

  // 7. A refresh rotates the refresh token; the new access token works.
  const refreshed = await (
    await api.post('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: live.refresh_token, client_id: clientId } })
  ).json();
  expect(refreshed.refresh_token).not.toBe(live.refresh_token);
  expect((await api.post('/api/mcp', { data: LIST, headers: bearer(refreshed.access_token) })).status()).toBe(200);

  // 8. Disconnected on /preferences — and the access token stops on the very next call.
  await page.goto('/preferences');
  const card = page.getByTestId('connected-apps');
  await expect(card.getByText('Claude (e2e)')).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Disconnect' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByText('Claude (e2e)')).toHaveCount(0, { timeout: 30_000 });
  const after = await api.post('/api/mcp', { data: LIST, headers: bearer(refreshed.access_token) });
  expect(after.status()).toBe(401);
  expect(after.headers()['www-authenticate']).toContain('resource_metadata=');
  // ...and so does its refresh token.
  const dead = await api.post('/oauth/token', {
    form: { grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: clientId },
  });
  expect(dead.status()).toBe(400);

  await api.dispose();
});

test('Deny sends the person back to the client with access_denied, and nothing is granted', async ({ page, baseURL }) => {
  const api = await anon(baseURL!);
  const { client_id: clientId } = await (
    await api.post('/oauth/register', { data: { client_name: 'Denied app', redirect_uris: [REDIRECT] } })
  ).json();
  const p = pkce();
  await signIn(page, 'employee');
  await page.route(`${REDIRECT}**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
  const landed = page.waitForRequest((r) => r.url().startsWith(REDIRECT));
  await page.goto(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'st-d',
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
    })}`,
  );
  await page.getByRole('button', { name: 'Deny' }).click();
  const back = new URL((await landed).url());
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe('st-d');
  expect(back.searchParams.get('code')).toBeNull();
  await api.dispose();
});

test('a resource that is not this server\'s MCP endpoint goes back to the client as invalid_target', async ({ baseURL }) => {
  const api = await anon(mcpHost(baseURL!));
  const { client_id: clientId } = await (
    await api.post('/oauth/register', { data: { client_name: 'Wrong target', redirect_uris: [REDIRECT] } })
  ).json();
  // Refused before anyone signs in, so no browser is needed: read the redirect itself. (A browser
  // would follow it to the client's loopback callback, whose port Chromium refuses to open.)
  const app = await anon(baseURL!);
  const res = await app.get(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'st-t',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: 'https://evil.example/api/mcp',
    })}`,
    { maxRedirects: 0 },
  );
  expect([303, 307, 308]).toContain(res.status());
  const back = new URL(res.headers()['location']!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('error')).toBe('invalid_target');
  expect(back.searchParams.get('state')).toBe('st-t');
  expect(back.searchParams.get('code')).toBeNull();
  await app.dispose();
  await api.dispose();
});

test('the consent screen is refused on a host the metadata does not name (a tenant subdomain)', async ({ baseURL }) => {
  const api = await anon(mcpHost(baseURL!));
  const { client_id: clientId } = await (
    await api.post('/oauth/register', { data: { client_name: 'Wrong host', redirect_uris: [REDIRECT] } })
  ).json();
  const app = await anon(baseURL!);
  const res = await app.get(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'st-h',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    })}`,
    { maxRedirects: 0, headers: { 'x-forwarded-host': 'acme.velo.test' } },
  );
  // Not sent anywhere: the page says the service is unavailable, and no code exists.
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('data-reason="unavailable"');
  expect(html).not.toContain('name="ticket"');
  await app.dispose();
  await api.dispose();
});

test('a redirect URI the client did not register is shown on the page, never followed', async ({ page, baseURL }) => {
  const api = await anon(baseURL!);
  const { client_id: clientId } = await (
    await api.post('/oauth/register', { data: { client_name: 'Honest app', redirect_uris: [REDIRECT] } })
  ).json();
  await signIn(page, 'employee');
  await page.goto(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example/steal',
      state: 's',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    })}`,
  );
  await expect(page.getByTestId('oauth-problem')).toHaveAttribute('data-reason', 'bad_redirect');
  expect(page.url()).not.toContain('evil.example/steal?');
  // Registration refuses a non-HTTPS, non-loopback redirect outright.
  const bad = await api.post('/oauth/register', { data: { client_name: 'x', redirect_uris: ['http://evil.example/cb'] } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toBe('invalid_redirect_uri');
  await api.dispose();
});

test('an admin sees the connections people made, on /admin/api-keys', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/api-keys');
  await expect(page.getByTestId('admin-connected-apps')).toBeVisible({ timeout: 30_000 });
});

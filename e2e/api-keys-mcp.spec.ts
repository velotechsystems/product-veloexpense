import { expect, type Page, request as playwrightRequest, test } from '@playwright/test';
import { signIn } from './support/actors';
import { closeTestDb, testDb } from './support/test-db';

/**
 * VeloExpense (w6-04) — API keys, end to end: a personal key minted and revoked on
 * `/preferences`, a platform key minted on `/admin/api-keys`, both used against `/api/mcp`
 * with no session at all, and the calls read back in the admin's request log.
 *
 * Not ported: ExpenseOS has no such spec. Its e2e reaches `/admin/api-keys` only through the
 * crawl and the role matrix, and never calls its MCP endpoint. VeloExpense's endpoint has a step
 * ExpenseOS's does not — the key names its tenant before anything else can be read (0079's
 * `api_key_lookup`) — and this is the only place that step runs against the real server, the
 * real proxy and a real key.
 *
 * REDIS. A personal key carries a 60-a-minute limit, and the guard counts it in Redis
 * (`server/lib/rateLimit.ts`, as ExpenseOS's does). The e2e server has `REDIS_URL` only when
 * the shell does (playwright.config.ts), and CI's job has no Redis service, so the personal
 * key's CALLS run only where Redis is there; minting, revealing and revoking it run everywhere.
 * The platform key is minted with no limit, so its calls never touch Redis and always run.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/** Call the MCP endpoint as an MCP client would: no cookie, a bearer token, JSON-RPC. */
async function rpc(
  baseURL: string,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const ctx = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const res = await ctx.post('/api/mcp', {
    data: body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    maxRedirects: 0,
  });
  const out = { status: res.status(), json: await res.json().catch(() => null) };
  await ctx.dispose();
  return out;
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const MY_REPORTS = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'list_my_expense_reports', arguments: {} },
};

/** The token a reveal panel is showing. */
async function revealedToken(page: Page, prefix: 'vxe_u_' | 'vxe_p_'): Promise<string> {
  const code = page.locator('code').filter({ hasText: new RegExp(`^${prefix}`) }).first();
  await expect(code).toBeVisible();
  const token = ((await code.textContent()) ?? '').trim();
  expect(token).toMatch(/^vxe_[up]_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}$/);
  return token;
}

/** Mint (or regenerate, if a run that failed half-way left one) and return the token. */
async function mintPersonalKey(page: Page): Promise<string> {
  await page.goto('/preferences');
  const request = page.getByRole('button', { name: 'Request API key' });
  const regenerate = page.getByRole('button', { name: 'Regenerate', exact: true });
  await expect(request.or(regenerate)).toBeVisible({ timeout: 30_000 });
  if (await request.isVisible()) {
    await request.click();
  } else {
    await regenerate.click();
    await page.getByRole('button', { name: 'Regenerate key' }).click();
  }
  await expect(page.getByText('Copy this key now — it is never shown again.')).toBeVisible();
  return revealedToken(page, 'vxe_u_');
}

test.afterAll(async () => {
  await closeTestDb();
});

test('a personal key is minted on /preferences, works against /api/mcp, and stops when revoked', async ({
  page,
  baseURL,
}) => {
  await signIn(page, 'employee');
  const token = await mintPersonalKey(page);

  // The prompt to paste names this deployment's endpoint.
  await expect(page.getByText(/Connect to the VeloExpense MCP server at .*\/api\/mcp/)).toBeVisible();

  if (process.env.REDIS_URL) {
    // No session, just the key: the tools a personal key reaches.
    const list = await rpc(baseURL!, token, LIST);
    expect(list.status).toBe(200);
    const names = (list.json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('list_my_expense_reports');
    expect(names).not.toContain('decide_expense_report');

    // A tool call runs the real procedure, as the employee, in the employee's tenant.
    const call = await rpc(baseURL!, token, MY_REPORTS);
    expect(call.status).toBe(200);
    expect(call.json.result.isError).toBe(false);

    // Outside its scopes it is refused by the guard, before any procedure runs.
    const decide = await rpc(baseURL!, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'decide_expense_report', arguments: {} },
    });
    expect(decide.status).toBe(403);
  }

  // Revoked on /preferences, and the very next call says so — whether or not Redis is here:
  // a revoked key is refused before the limiter is asked.
  await page.getByRole('button', { name: 'Revoke', exact: true }).first().click();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByRole('button', { name: 'Request API key' })).toBeVisible({ timeout: 30_000 });
  const after = await rpc(baseURL!, token, LIST);
  expect(after.status).toBe(401);
  expect(after.json.error.message).toBe('This API key has been revoked.');
});

test('a platform key minted on /admin/api-keys acts as the person it names, and its calls are logged', async ({
  page,
  baseURL,
}) => {
  const db = await testDb('api-keys-mcp');
  const employeeId = (
    await db.query(`SELECT id FROM app_user WHERE lower(email) = 'employee@demo.test' LIMIT 1`)
  ).rows[0]?.id as string;
  expect(employeeId).toBeTruthy();

  await signIn(page, 'admin');
  await page.goto('/admin/api-keys');
  await expect(page.getByText('Platform keys').first()).toBeVisible({ timeout: 30_000 });
  const name = `e2e platform key ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('expense_management.expense_report').selectOption('read');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('Copy this key now — it is never shown again.')).toBeVisible();
  const token = await revealedToken(page, 'vxe_p_');

  // A platform key must name its subject...
  const nobody = await rpc(baseURL!, token, MY_REPORTS);
  expect(nobody.status).toBe(400);
  // ...a malformed one is nobody at all...
  const malformed = await rpc(baseURL!, token, MY_REPORTS, {
    'x-veloexpense-on-behalf-of': 'employee@demo.test',
  });
  expect(malformed.status).toBe(404);
  // ...and with a member named, the call runs as that member.
  const asEmployee = await rpc(baseURL!, token, MY_REPORTS, {
    'x-veloexpense-on-behalf-of': employeeId,
  });
  expect(asEmployee.status).toBe(200);
  expect(asEmployee.json.result.isError).toBe(false);

  // Read-only on reports: submitting is outside the key's scope.
  const submit = await rpc(
    baseURL!,
    token,
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'submit_expense_report', arguments: { reportId: employeeId } },
    },
    { 'x-veloexpense-on-behalf-of': employeeId },
  );
  expect(submit.status).toBe(403);

  // The request log, on the same screen, shows what the key did: its outcome filter counts
  // each refusal the calls above produced, and the table names the refused tool.
  await page.reload();
  await expect(page.locator('option', { hasText: /^DENIED_SCOPE \(\d+\)$/ })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator('option', { hasText: /^SUBJECT_REQUIRED \(\d+\)$/ })).toHaveCount(1);
  await expect(page.getByText('submit_expense_report').first()).toBeVisible();

  // Revoked here, and refused from then on.
  const row = page.locator('li').filter({ hasText: name });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  const after = await rpc(baseURL!, token, MY_REPORTS, { 'x-veloexpense-on-behalf-of': employeeId });
  expect(after.status).toBe(401);
});

test('/api/mcp refuses an unknown, malformed or missing key in JSON-RPC, never with the sign-in page', async ({
  baseURL,
}) => {
  const unknown = `vxe_u_${'0'.repeat(16)}_${'x'.repeat(43)}`;
  for (const token of [unknown, 'not-a-key', null]) {
    const res = await rpc(baseURL!, token, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(res.status, `token ${token ?? '(none)'}`).toBe(401);
    expect(res.json).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32001, message: 'Invalid API key.' },
    });
  }
});

test('the API keys screen is an admin screen', async ({ page }) => {
  await signIn(page, 'admin');
  const ok = await page.goto('/admin/api-keys');
  expect(ok?.status()).toBe(200);
  await expect(page.getByText('Platform keys').first()).toBeVisible();

  await signIn(page, 'employee');
  const refused = await page.goto('/admin/api-keys');
  expect(refused?.status()).toBe(403);
});

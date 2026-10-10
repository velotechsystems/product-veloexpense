import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The absolute report link handed to an MCP client.
 *
 * VeloExpense: ExpenseOS's `reportLinks.test.ts`, on VeloExpense's link (see `reportLinks.ts`):
 * no locale prefix, so ExpenseOS's two locale cases become one that pins its absence; the
 * origin is read per call, so the module is imported once; and the tenant's subdomain gains
 * a case.
 */

const load = async () => {
  vi.resetModules();
  return import('./reportLinks');
};

const ENV_KEYS = ['APP_URL', 'AUTH_URL', 'NEXTAUTH_URL', 'AUTH_COOKIE_DOMAIN'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('reportUrl', () => {
  it('builds an absolute link, with no locale prefix (VeloExpense routes carry none)', async () => {
    process.env.APP_URL = 'https://veloexpense.example';
    const { reportUrl } = await load();
    expect(reportUrl('r-1')).toBe('https://veloexpense.example/expenses/r-1');
  });

  it('asks the page to prompt for receipts when told to', async () => {
    process.env.APP_URL = 'https://veloexpense.example';
    const { reportUrl } = await load();
    expect(reportUrl('r-1', { promptUpload: true })).toBe(
      'https://veloexpense.example/expenses/r-1?upload=1',
    );
  });

  it('does not double the slash when the configured URL ends in one', async () => {
    process.env.APP_URL = 'https://veloexpense.example/';
    const { reportUrl } = await load();
    expect(reportUrl('r-1')).toBe('https://veloexpense.example/expenses/r-1');
  });

  it('falls back through AUTH_URL and NEXTAUTH_URL', async () => {
    process.env.NEXTAUTH_URL = 'https://legacy.example';
    const { reportUrl } = await load();
    expect(reportUrl('r-1')).toBe('https://legacy.example/expenses/r-1');

    process.env.AUTH_URL = 'https://auth.example';
    expect(reportUrl('r-1')).toBe('https://auth.example/expenses/r-1');
  });

  it("VeloExpense: lands on the tenant's own subdomain where the deployment serves them", async () => {
    process.env.APP_URL = 'https://veloexpense.example';
    process.env.AUTH_COOKIE_DOMAIN = '.veloexpense.example';
    const { reportUrl } = await load();
    expect(reportUrl('r-1', { tenantSlug: 'acme' })).toBe('https://acme.veloexpense.example/expenses/r-1');
  });

  it('returns null when nothing is configured', async () => {
    // Null rather than a relative path: a relative link is unusable in an MCP client's answer,
    // and a hostless absolute one reads as a bug rather than a missing env var.
    const { reportUrl } = await load();
    expect(reportUrl('r-1')).toBeNull();
  });
});

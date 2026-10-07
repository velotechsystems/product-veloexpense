// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: vi.fn(async () => new Response('ok')) }));
vi.mock('@/server/routers/_app', () => ({ appRouter: {} }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: () => ({}) }));

import { POST, GET } from './route';

/**
 * VeloExpense: tRPC mutations must come from the site's own pages (not in ExpenseOS).
 *
 * Server actions get this from Next; a tRPC POST does not. The session cookie's SameSite=Lax
 * does not cover it either, because every tenant subdomain is the same SITE.
 */
const post = (headers: Record<string, string>) =>
  POST(new Request('https://acme.veloexpense.app/api/trpc/x.y', { method: 'POST', headers }));

describe('where a write may come from', () => {
  it('its own host', async () => {
    expect((await post({ origin: 'https://acme.veloexpense.app', host: 'acme.veloexpense.app' })).status).toBe(200);
  });

  it('the host the load balancer forwarded', async () => {
    const res = await post({
      origin: 'https://acme.veloexpense.app',
      host: 'internal:3000',
      'x-forwarded-host': 'acme.veloexpense.app',
    });
    expect(res.status).toBe(200);
  });

  it('not another tenant on the same site', async () => {
    expect((await post({ origin: 'https://beta.veloexpense.app', host: 'acme.veloexpense.app' })).status).toBe(403);
  });

  it('not a POST with no Origin', async () => {
    expect((await post({ host: 'acme.veloexpense.app' })).status).toBe(403);
  });

  it('not a malformed Origin', async () => {
    expect((await post({ origin: 'null', host: 'acme.veloexpense.app' })).status).toBe(403);
  });

  it('a query is not checked: GETs never write', async () => {
    const res = await GET(new Request('https://acme.veloexpense.app/api/trpc/x.y', { headers: { origin: 'https://evil.example' } }));
    expect(res.status).toBe(200);
  });
});

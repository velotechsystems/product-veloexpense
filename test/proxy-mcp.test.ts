/**
 * VeloExpense (w6-04): the MCP endpoint is reached by an MCP client holding an API key, which
 * carries no session cookie. `proxy.ts` must let exactly that path through — in BOTH places,
 * as its header asks — and nothing that merely shares its prefix. The key itself is checked
 * in the route (app/api/mcp/route.ts).
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

const req = (path: string) =>
  new NextRequest(new URL(path, 'https://dev.veloexpense.ai'), { method: 'POST' });
const redirectsToLogin = (path: string) =>
  proxy(req(path)).headers.get('location')?.includes('/login') ?? false;

/** Next compiles the matcher as a regex over the pathname; this mirrors it. */
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe('/api/mcp', () => {
  it('is reached with no session, and never even runs the middleware', () => {
    expect(redirectsToLogin('/api/mcp')).toBe(false);
    expect(matcher.test('/api/mcp')).toBe(false);
  });

  it('is exact: a longer path under it still needs a session', () => {
    expect(redirectsToLogin('/api/mcp/other')).toBe(true);
    expect(matcher.test('/api/mcp/other')).toBe(true);
    expect(redirectsToLogin('/api/mcpx')).toBe(true);
  });
});

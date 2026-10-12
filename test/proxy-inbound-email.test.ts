/**
 * VeloExpense (w3-06): the inbound-email endpoint is reached by SNS, which carries no
 * session cookie. `proxy.ts` must let exactly that path through — in BOTH places, as its
 * header asks — and nothing that merely shares its prefix.
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

describe('/api/email/inbound', () => {
  it('is reached with no session, and never even runs the middleware', () => {
    expect(redirectsToLogin('/api/email/inbound')).toBe(false);
    expect(matcher.test('/api/email/inbound')).toBe(false);
  });

  it('is exact: a longer path under it still needs a session', () => {
    expect(redirectsToLogin('/api/email/inbound/other')).toBe(true);
    expect(matcher.test('/api/email/inbound/other')).toBe(true);
  });

  it('opens nothing else under /api/email', () => {
    expect(redirectsToLogin('/api/email/outbound')).toBe(true);
  });
});

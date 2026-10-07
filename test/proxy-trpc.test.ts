/**
 * Wave 0 — the tRPC transport (`/api/trpc`) behind the session check.
 *
 * Without a session cookie a page redirects to `/login`, but the tRPC endpoint must answer
 * 401 instead: the client (lib/trpc/client.tsx, ported from ExpenseOS) reads a 401 as an
 * expired session and sends the reader to sign in, and cannot parse the sign-in page's HTML.
 * With a cookie the request goes on to the route, where the procedure decides.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, 'https://dev.veloexpense.ai'), cookie ? { headers: { cookie } } : undefined);
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe('/api/trpc without a session', () => {
  it('reaches the middleware', () => {
    expect(matcher.test('/api/trpc/expenseCategories.list')).toBe(true);
  });

  it('answers 401 in JSON rather than redirecting', async () => {
    const res = proxy(req('/api/trpc/expenseCategories.list'));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error: { data: { code: string; httpStatus: number } } };
    expect(body.error.data).toEqual({ code: 'UNAUTHORIZED', httpStatus: 401 });
  });

  it('only for the tRPC path: a page still redirects to sign in', () => {
    expect(proxy(req('/api/trpcx')).headers.get('location')).toContain('/login');
    expect(proxy(req('/expenses')).headers.get('location')).toContain('/login');
  });
});

describe('/api/trpc with a session', () => {
  it('passes through to the route', () => {
    const res = proxy(req('/api/trpc/expenseCategories.list', 'authjs.session-token=x'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

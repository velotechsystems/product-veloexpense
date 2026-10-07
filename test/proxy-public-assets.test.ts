/**
 * 2026 brand: the wordmark and the favicon render before anyone has a session —
 * on the sign-in page and in the tab — so `proxy.ts` must let them through.
 * The design system's rollout notes record an auth redirect blocking VeloLedger's
 * logo on its own sign-in page; this pins the same mistake out of VeloExpense.
 *
 * Both halves are asserted, as `proxy.ts`'s own header asks: the PUBLIC list
 * (what runs when middleware runs) and the matcher (whether it runs at all).
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

const req = (path: string) => new NextRequest(new URL(path, 'https://dev.veloexpense.ai'));
const redirectsToLogin = (path: string) => proxy(req(path)).headers.get('location')?.includes('/login') ?? false;

/** Next compiles the matcher as a regex over the pathname; this mirrors it. */
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe('public brand assets (2026 kit)', () => {
  for (const path of [
    '/brand/veloexpense-favicon.svg',
    '/brand/veloexpense-nohalo.svg',
    '/favicon.ico',
    '/apple-touch-icon.png',
  ]) {
    it(`${path} is served with no session`, () => {
      expect(redirectsToLogin(path)).toBe(false);
      expect(matcher.test(path), `${path} should not even reach the middleware`).toBe(false);
    });
  }

  it('an app page still redirects without a session (the check is not a no-op)', () => {
    expect(redirectsToLogin('/expenses')).toBe(true);
    expect(matcher.test('/expenses')).toBe(true);
  });

  it('a path that merely starts with "brand" is not public', () => {
    expect(redirectsToLogin('/branding-admin')).toBe(true);
  });
});

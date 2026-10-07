// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBaseUrl } from './client';

/**
 * Where the client posts its batches.
 *
 * In the browser the answer must be the EMPTY string, so `/api/trpc` is same-origin: an
 * absolute URL there would be a cross-origin request, the session cookie would not be
 * attached, and every query would come back UNAUTHORIZED — which the provider reads as an
 * expired session and answers with a redirect to sign in. A misconfigured base URL would
 * present as a sign-in loop, not as a networking error.
 *
 * Off the browser there is no origin to be relative to, so one is constructed — and this
 * file runs in the node environment for exactly that reason: under jsdom `window` exists
 * and the server branches are unreachable.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getBaseUrl', () => {
  it('is relative in the browser, so the cookie rides along', () => {
    vi.stubGlobal('window', {});
    expect(getBaseUrl()).toBe('');
  });

  it('uses the deployment host when one is published', () => {
    vi.stubEnv('VERCEL_URL', 'expenseos-abc123.vercel.app');
    expect(getBaseUrl()).toBe('https://expenseos-abc123.vercel.app');
  });

  it('speaks https to that host, never plain http', () => {
    /** The value is a bare hostname, so the scheme is ours to supply — and a server-side
     *  call carrying a session over http is the one that must not be typo'd. */
    vi.stubEnv('VERCEL_URL', 'example.test');
    expect(getBaseUrl().startsWith('https://')).toBe(true);
  });

  it('falls back to localhost on the port the server was told to use', () => {
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('PORT', '4001');
    expect(getBaseUrl()).toBe('http://localhost:4001');
  });

  it('defaults to 3000 when nothing set a port', () => {
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('PORT', undefined);
    expect(getBaseUrl()).toBe('http://localhost:3000');
  });

  it('prefers the deployment host over the local port', () => {
    /** Both are set in a preview deployment; talking to localhost there reaches whatever
     *  else is listening on the box. */
    vi.stubEnv('VERCEL_URL', 'preview.test');
    vi.stubEnv('PORT', '4001');
    expect(getBaseUrl()).toBe('https://preview.test');
  });
});

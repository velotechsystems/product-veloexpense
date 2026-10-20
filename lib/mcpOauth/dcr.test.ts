// @vitest-environment node
/**
 * Dynamic Client Registration — ported from VeloCRM `api/src/__tests__/oauth/dcr.test.ts`
 * (59fce1c). VeloCRM's cases ran against a COPY of the validator inside the test file; these run
 * against the real one (lib/mcpOauth/dcr.ts), plus the rules VeloExpense added.
 */
import { describe, expect, it } from 'vitest';
import { isDcrError, redirectUriProblem, stripHtml, validateRegistration } from './dcr';

const ok = { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };

describe('DCR validation — client_name sanitization', () => {
  it('strips HTML tags from client_name', () => {
    expect(stripHtml('<script>alert(1)</script>Claude')).toBe('alert(1)Claude');
    const v = validateRegistration({ ...ok, client_name: '<b>Claude</b>' });
    expect(isDcrError(v) ? null : v.clientName).toBe('Claude');
  });
  it('caps client_name at 255 characters', () => {
    const v = validateRegistration({ ...ok, client_name: 'x'.repeat(400) });
    expect(isDcrError(v) ? null : v.clientName.length).toBe(255);
  });
  it('rejects empty client_name after sanitization', () => {
    expect(validateRegistration({ ...ok, client_name: '<i></i>  ' })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(validateRegistration({ ...ok, client_name: 42 })).toMatchObject({ error: 'invalid_client_metadata' });
  });
});

describe('DCR validation — redirect_uri', () => {
  it('accepts HTTPS redirect URIs', () => expect(redirectUriProblem('https://claude.ai/cb')).toBeNull());
  it('accepts localhost and 127.0.0.1 over HTTP (development)', () => {
    expect(redirectUriProblem('http://localhost:6274/oauth/callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:33418/cb')).toBeNull();
  });
  it('rejects non-localhost HTTP redirect URIs', () => {
    expect(redirectUriProblem('http://evil.example/cb')).toMatch(/HTTPS/);
  });
  it('rejects URIs with a fragment', () => expect(redirectUriProblem('https://claude.ai/cb#x')).toMatch(/fragment/));
  it('rejects completely invalid URIs', () => expect(redirectUriProblem('not a url')).toMatch(/Invalid/));
  it('rejects a wildcard and embedded credentials (VeloExpense)', () => {
    expect(redirectUriProblem('https://*.claude.ai/cb')).toMatch(/wildcard/);
    expect(redirectUriProblem('https://a:b@claude.ai/cb')).toMatch(/credentials/);
  });
  it('rejects a custom scheme', () => expect(redirectUriProblem('javascript:alert(1)')).not.toBeNull());
  it('rejects an empty or missing redirect_uris array, and more than ten', () => {
    expect(validateRegistration({ client_name: 'x', redirect_uris: [] })).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(validateRegistration({ client_name: 'x' })).toMatchObject({ error: 'invalid_redirect_uri' });
    const many = Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`);
    expect(validateRegistration({ client_name: 'x', redirect_uris: many })).toMatchObject({ error: 'invalid_redirect_uri' });
  });
});

describe('DCR validation — public clients only (VeloExpense)', () => {
  it('refuses a client asking for a secret, rather than storing a method it will never get', () => {
    expect(validateRegistration({ ...ok, token_endpoint_auth_method: 'client_secret_basic' })).toMatchObject({
      error: 'invalid_client_metadata',
    });
  });
  it('accepts the code and refresh grants only, and response_types ["code"]', () => {
    expect(validateRegistration({ ...ok, grant_types: ['client_credentials'] })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(validateRegistration({ ...ok, response_types: ['token'] })).toMatchObject({ error: 'invalid_client_metadata' });
    const v = validateRegistration({ ...ok, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
    expect(isDcrError(v)).toBe(false);
  });
  it('de-duplicates redirect URIs', () => {
    const v = validateRegistration({ client_name: 'x', redirect_uris: ['https://a.example/cb', 'https://a.example/cb'] });
    expect(isDcrError(v) ? null : v.redirectUris).toEqual(['https://a.example/cb']);
  });
});

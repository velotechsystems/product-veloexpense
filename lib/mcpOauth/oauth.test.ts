// @vitest-environment node
/**
 * Discovery, the authorization request, the consent ticket, scopes and the JWKS — ported from
 * VeloCRM `__tests__/oauth/discovery.test.ts` and `authorize.test.ts` (59fce1c), against the real
 * modules rather than literal objects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';
import { oauthBaseUrl, resourceMetadataUrl } from './host';
import { DEFAULT_OAUTH_SCOPES, OAUTH_SCOPES, grantableScopes } from './scopes';
import { redirectWith, signTicket, validateAuthorize, verifyTicket } from './authorizeRequest';
import { jwks, signingKey } from './keys';
import type { ClientRow } from './service';

const BASE = 'https://mcp.veloexpense.test';

describe('well-known discovery', () => {
  it('authorization server metadata has the RFC 8414 fields, all on the base', () => {
    const m = authorizationServerMetadata(BASE);
    expect(m).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      jwks_uri: `${BASE}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
  it('code_challenge_methods_supported is S256 only', () => {
    expect(authorizationServerMetadata(BASE).code_challenge_methods_supported).toEqual(['S256']);
  });
  it('protected resource metadata has the RFC 9728 fields; the resource is /api/mcp at the base', () => {
    expect(protectedResourceMetadata(BASE)).toMatchObject({
      resource: `${BASE}/api/mcp`,
      authorization_servers: [BASE],
      bearer_methods_supported: ['header'],
    });
    expect(resourceMetadataUrl(BASE)).toBe(`${BASE}/.well-known/oauth-protected-resource/api/mcp`);
  });
  it('scopes_supported is exactly what a grant may carry', () => {
    expect(authorizationServerMetadata(BASE).scopes_supported).toEqual([...OAUTH_SCOPES]);
  });
  it('the JWKS publishes the signing key, public half only', () => {
    const doc = jwks();
    expect(doc.keys).toHaveLength(1);
    expect(doc.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: signingKey()!.kid });
    expect(JSON.stringify(doc)).not.toMatch(/"d"|"p"|"q"/);
  });
});

describe('the base URL follows the host — only an allowlisted one', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AUTH_URL = 'https://app.veloexpense.test';
    process.env.AUTH_COOKIE_DOMAIN = 'veloexpense.test';
    delete process.env.MCP_OAUTH_ALLOWED_HOSTS;
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const h = (o: Record<string, string>) => new Headers(o);
  it('the app host and mcp.<apex> answer as themselves', () => {
    expect(oauthBaseUrl(h({ host: 'app.veloexpense.test' }))).toBe('https://app.veloexpense.test');
    expect(oauthBaseUrl(h({ 'x-forwarded-host': 'mcp.veloexpense.test', 'x-forwarded-proto': 'https' }))).toBe(BASE);
  });
  it('a forged or tenant host falls back to the app origin, so no token is minted for it', () => {
    expect(oauthBaseUrl(h({ host: 'evil.example' }))).toBe('https://app.veloexpense.test');
    expect(oauthBaseUrl(h({ host: 'acme.veloexpense.test' }))).toBe('https://app.veloexpense.test');
  });
  it('MCP_OAUTH_ALLOWED_HOSTS adds hosts (VeloCRM ALLOWED_API_HOSTS)', () => {
    process.env.MCP_OAUTH_ALLOWED_HOSTS = 'connect.example.test';
    expect(oauthBaseUrl(h({ host: 'connect.example.test' }))).toBe('https://connect.example.test');
  });
  it('no origin at all means no OAuth', () => {
    delete process.env.AUTH_URL;
    delete process.env.AUTH_COOKIE_DOMAIN;
    expect(oauthBaseUrl(h({ host: 'whatever' }))).toBeNull();
  });
});

describe('scopes never exceed a personal key', () => {
  it('drops what may not be granted, and defaults when nothing is left', () => {
    expect(grantableScopes('admin.security.api_key mcp:ai_drafter')).toEqual([...DEFAULT_OAUTH_SCOPES]);
    expect(grantableScopes(null)).toEqual([...DEFAULT_OAUTH_SCOPES]);
    expect(grantableScopes('travel.travel_request.readonly expense_management.expense_approval')).toEqual([
      'travel.travel_request.readonly',
    ]);
  });
  it('a base scope already covers its read-only half', () => {
    expect(grantableScopes('travel.travel_request travel.travel_request.readonly')).toEqual(['travel.travel_request']);
  });
});

describe('the authorization request', () => {
  const client: ClientRow = {
    id: 'row',
    clientId: '019e3000-0000-7000-8000-0000000000c1',
    clientName: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    createdAt: new Date(),
  };
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const q = (o: Record<string, string> = {}) => ({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state: 's-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...o,
  });
  it('accepts a complete request', () => {
    expect(validateAuthorize(q(), client)).toMatchObject({ clientId: client.clientId, state: 's-1', codeChallenge: challenge });
  });
  it('an unknown client or an unregistered redirect is shown on the page, never redirected to', () => {
    expect(validateAuthorize(q(), null)).toEqual({ kind: 'page', reason: 'unknown_client' });
    expect(validateAuthorize(q({ redirect_uri: 'https://evil.example/cb' }), client)).toEqual({ kind: 'page', reason: 'bad_redirect' });
    expect(validateAuthorize({}, client)).toEqual({ kind: 'page', reason: 'missing_params' });
  });
  it('requires state, response_type=code and PKCE S256 — plain is refused', () => {
    expect(validateAuthorize(q({ state: '' }), client)).toMatchObject({ kind: 'redirect', error: 'invalid_request' });
    expect(validateAuthorize(q({ response_type: 'token' }), client)).toMatchObject({ error: 'unsupported_response_type' });
    expect(validateAuthorize(q({ code_challenge_method: 'plain' }), client)).toMatchObject({ error: 'invalid_request' });
    expect(validateAuthorize(q({ code_challenge: '' }), client)).toMatchObject({ error: 'invalid_request' });
  });
  it('appends to a redirect URI that already has a query', () => {
    expect(redirectWith('https://c.example/cb?x=1', { code: 'a b', state: 's' })).toBe('https://c.example/cb?x=1&code=a+b&state=s');
  });
});

describe('the consent ticket', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'ticket-test-secret';
  });
  const t = {
    clientId: 'c',
    redirectUri: 'https://claude.ai/cb',
    state: 's',
    codeChallenge: 'x',
    scopes: ['travel.travel_request'],
    userId: 'u',
    organizationId: 'o',
  };
  it('round-trips', () => {
    expect(verifyTicket(signTicket(t))).toMatchObject(t);
  });
  it('a tampered ticket (another tenant, another redirect) does not verify — VeloCRM trusted posted fields', () => {
    const signed = signTicket(t);
    const [body, sig] = signed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), organizationId: 'other' })).toString('base64url');
    expect(verifyTicket(`${forged}.${sig}`)).toBeNull();
  });
  it('expires after ten minutes', () => {
    const signed = signTicket(t, Date.now() - 11 * 60 * 1000);
    expect(verifyTicket(signed)).toBeNull();
  });
});

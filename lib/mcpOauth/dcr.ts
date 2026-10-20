/**
 * Dynamic Client Registration (RFC 7591) — validating what a client says about itself.
 *
 * Ported from VeloCRM `registerOauthClient` (`api/src/services/oauthServer.service.ts`,
 * 59fce1c): `client_name` HTML-stripped and capped at 255 (it is shown on the consent screen),
 * redirect URIs absolute, HTTPS except loopback, no fragments, no wildcards; public clients only.
 *
 * VeloExpense (mcp-oauth) tightenings, each a rule VeloCRM's validator states and does not
 * check:
 *   · `token_endpoint_auth_method` other than `none` is REFUSED rather than stored: VeloCRM
 *     stores whatever is sent, then issues no secret, so a client that asked for
 *     `client_secret_basic` believes it has one;
 *   · grant and response types outside `authorization_code`/`refresh_token` and `code` are
 *     refused for the same reason;
 *   · at most 10 redirect URIs (a cap the table enforces too);
 *   · errors are RFC 7591's `invalid_redirect_uri` / `invalid_client_metadata`, which is what a
 *     client knows how to read. VeloCRM answers `{ error: '<sentence>' }`.
 */

export interface DcrRequest {
  readonly client_name?: unknown;
  readonly redirect_uris?: unknown;
  readonly grant_types?: unknown;
  readonly response_types?: unknown;
  readonly token_endpoint_auth_method?: unknown;
}

export interface ValidClient {
  readonly clientName: string;
  readonly redirectUris: string[];
  readonly grantTypes: string[];
  readonly responseTypes: string[];
}

export type DcrError = { readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata'; readonly error_description: string };

const GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const MAX_REDIRECTS = 10;

/** Strip HTML tags (VeloCRM's XSS rule for the consent screen). */
export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** VeloCRM's `validateRedirectUris`, plus the wildcard rule its header states. */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return 'redirect_uri must be a non-empty string';
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `Invalid redirect_uri: "${uri}"`;
  }
  if (parsed.hash || uri.includes('#')) return `redirect_uri must not contain a fragment: "${uri}"`;
  if (uri.includes('*')) return `redirect_uri must not contain a wildcard: "${uri}"`;
  if (parsed.username || parsed.password) return `redirect_uri must not carry credentials: "${uri}"`;
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return null;
  return `redirect_uri must use HTTPS for non-localhost URIs: "${uri}"`;
}

export function validateRegistration(body: DcrRequest): ValidClient | DcrError {
  const rawName = typeof body.client_name === 'string' ? body.client_name : '';
  const clientName = stripHtml(rawName).trim().substring(0, 255);
  if (!clientName) return { error: 'invalid_client_metadata', error_description: 'client_name is required' };

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array' };
  }
  if (uris.length > MAX_REDIRECTS) {
    return { error: 'invalid_redirect_uri', error_description: `at most ${MAX_REDIRECTS} redirect_uris` };
  }
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem) return { error: 'invalid_redirect_uri', error_description: problem };
  }

  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') {
    return {
      error: 'invalid_client_metadata',
      error_description: 'Only public clients are supported: token_endpoint_auth_method must be "none" (PKCE is the proof).',
    };
  }

  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.length === 0 || !grantTypes.every((g) => typeof g === 'string' && GRANT_TYPES.has(g))) {
    return { error: 'invalid_client_metadata', error_description: 'grant_types may contain only authorization_code and refresh_token' };
  }
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    return { error: 'invalid_client_metadata', error_description: 'response_types must be ["code"]' };
  }

  return {
    clientName,
    redirectUris: [...new Set(uris as string[])],
    grantTypes: [...new Set(grantTypes as string[])],
    responseTypes: ['code'],
  };
}

export function isDcrError(v: ValidClient | DcrError): v is DcrError {
  return 'error' in v;
}

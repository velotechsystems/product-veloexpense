/**
 * The two discovery documents. Ported from VeloCRM `api/src/routes/wellKnown.ts` (59fce1c):
 * both derived from the request's (allowlisted) host, both cacheable for an hour.
 *
 * VeloExpense (mcp-oauth): `scopes_supported` is the personal key's scopes (lib/mcpOauth/scopes.ts)
 * rather than VeloCRM's two roles; `id_token_signing_alg_values_supported` is dropped — that is an
 * OpenID Connect field and this is not an OpenID provider (it issues no ID tokens); the revocation
 * endpoint's auth method is stated.
 */
import { resourceUrl } from './host';
import { OAUTH_SCOPES } from './scopes';

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/oauth/jwks`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
  };
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: resourceUrl(base),
    authorization_servers: [base],
    jwks_uri: `${base}/oauth/jwks`,
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256'],
    resource_name: 'VeloExpense',
  };
}

export const DISCOVERY_CACHE = { 'cache-control': 'public, max-age=3600' } as const;

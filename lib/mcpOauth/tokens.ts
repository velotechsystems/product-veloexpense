/**
 * PKCE, opaque secrets, and the RS256 access token.
 *
 * Ported from VeloCRM `oauthServer.service.ts` and `middleware/mcpAuth.ts` (59fce1c):
 *   · PKCE is S256 only (no `plain`), base64url(SHA-256(verifier)) === challenge. VeloCRM's test
 *     claims the comparison is timing-safe and its code uses `===`; here it is `timingSafeEqual`.
 *   · Access tokens: RS256 JWT, `typ: at+jwt`, 15 minutes, `iss` = the base the client used,
 *     `aud` = that base's MCP resource (RFC 8707/9728 — Claude rejects a token whose audience is
 *     not the resource it asked for), a `jti`, 30 seconds of clock leeway on verify.
 *   · Codes: 32 random bytes, 10 minutes. Refresh tokens: 40 random bytes, 30 days. Both are
 *     returned to the client once and stored only as SHA-256.
 *
 * VeloExpense (mcp-oauth): the token names its GRANT (`gid`). VeloCRM revokes an access token by
 * putting its `jti` in a Redis blocklist, which fails open when Redis is down and cannot reach a
 * token whose `jti` nobody recorded (revoking a grant from the settings screen revokes refresh
 * tokens only, so an issued access token keeps working until it expires). Here /api/mcp reads
 * the grant row on every call — it does already, to log the call against it — so revoking a
 * grant, from any of its four routes, stops every token under it on the next request, with no
 * Redis and no blocklist.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, createLocalJWKSet, decodeProtectedHeader } from 'jose';
import { jwks, signingKey } from './keys';
import { resourceUrl } from './host';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CLOCK_LEEWAY_SECONDS = 30;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** S256: base64url(SHA-256(verifier)) === challenge, compared in constant time. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  // RFC 7636 §4.1: 43–128 characters from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const digest = Buffer.from(createHash('sha256').update(codeVerifier).digest('base64url'));
  const expected = Buffer.from(codeChallenge);
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}

/** A challenge as RFC 7636 shapes one: base64url, 43 characters for SHA-256. */
export function isS256Challenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function newCode(): string {
  return randomBytes(32).toString('base64url');
}

export function newRefreshToken(): string {
  return randomBytes(40).toString('base64url');
}

export interface AccessClaims {
  /** The person the token acts as. */
  readonly sub: string;
  /** Their tenant. VeloCRM's claim name. */
  readonly tenant_id: string;
  /** Space-separated api-scopes strings. */
  readonly scope: string;
  /** The OAuth client's public id. */
  readonly client_id: string;
  /** VeloExpense: the grant (see the header). */
  readonly gid: string;
}

export class OAuthNotConfiguredError extends Error {
  constructor() {
    super('OAuth is not configured on this deployment (no signing key).');
    this.name = 'OAuthNotConfiguredError';
  }
}

export async function signAccessToken(base: string, claims: AccessClaims): Promise<string> {
  const key = signingKey();
  if (!key) throw new OAuthNotConfiguredError();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .setAudience(resourceUrl(base))
    .setIssuer(base)
    .sign(key.privateKey);
}

/** Does this bearer token look like a JWT rather than an API key? (VeloCRM: the `eyJ` test.) */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify an access token presented at `base`. Null for anything that does not verify — a bad
 * signature, the wrong issuer or audience, expired beyond the leeway, the wrong `typ`, or claims
 * that are missing or malformed. The caller answers every null the same way (401).
 */
export async function verifyAccessToken(base: string, token: string): Promise<AccessClaims | null> {
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || header.typ !== 'at+jwt') return null;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks()), {
      algorithms: ['RS256'],
      issuer: base,
      audience: resourceUrl(base),
      clockTolerance: CLOCK_LEEWAY_SECONDS,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
    });
    const { sub, tenant_id, scope, client_id, gid } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || !UUID.test(sub)) return null;
    if (typeof tenant_id !== 'string' || !UUID.test(tenant_id)) return null;
    if (typeof gid !== 'string' || !UUID.test(gid)) return null;
    if (typeof client_id !== 'string' || typeof scope !== 'string') return null;
    return { sub, tenant_id, scope, client_id, gid };
  } catch {
    return null;
  }
}

// @vitest-environment node
/**
 * PKCE and the access token — ported from VeloCRM `__tests__/oauth/token.test.ts`,
 * `authorize.test.ts` (PKCE) and `mcpAuth.test.ts` (59fce1c). VeloCRM's versions assert a mirror
 * of the logic or a literal object ("payload.exp - payload.iat is 900" on a payload the test
 * built); these sign and verify real tokens with lib/mcpOauth/tokens.ts.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  isS256Challenge,
  looksLikeJwt,
  signAccessToken,
  verifyAccessToken,
  verifyPkceS256,
} from './tokens';
import { signingKey } from './keys';

const BASE = 'https://mcp.veloexpense.test';
const UUID = '019e3000-0000-7000-8000-00000000c0de';
const CLAIMS = { sub: UUID, tenant_id: UUID, scope: 'travel.travel_request', client_id: UUID, gid: UUID };
const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

beforeEach(() => {
  delete process.env.MCP_OAUTH_SIGNING_KEY;
  delete process.env.MCP_OAUTH_SIGNING_KEY_PREVIOUS;
});

describe('PKCE S256', () => {
  it('accepts a valid pair', () => {
    const v = verifier();
    expect(verifyPkceS256(v, challengeOf(v))).toBe(true);
  });
  it('rejects the wrong verifier, and a tampered challenge', () => {
    const v = verifier();
    expect(verifyPkceS256(verifier(), challengeOf(v))).toBe(false);
    // Flip the last character to one it is NOT. Always appending 'A' left the challenge
    // unchanged whenever it already ended in 'A' (1 run in 64), and the test failed then.
    const c = challengeOf(v);
    const tampered = `${c.slice(0, -1)}${c.endsWith('A') ? 'B' : 'A'}`;
    expect(tampered).not.toBe(c);
    expect(verifyPkceS256(v, tampered)).toBe(false);
  });
  it('the challenge is base64url(SHA-256(verifier)), 43 characters', () => {
    expect(isS256Challenge(challengeOf(verifier()))).toBe(true);
    expect(isS256Challenge('plain-verifier-is-not-a-challenge')).toBe(false);
  });
  it('rejects a verifier outside RFC 7636 (too short, wrong characters) without throwing', () => {
    expect(verifyPkceS256('short', challengeOf('short'))).toBe(false);
    expect(verifyPkceS256('x'.repeat(43) + '!', 'y')).toBe(false);
  });
});

describe('the access token', () => {
  it('is an RS256 at+jwt, 15 minutes, audience-bound to the MCP resource at the base used', async () => {
    const t = await signAccessToken(BASE, CLAIMS);
    const header = decodeProtectedHeader(t);
    const body = decodeJwt(t);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'at+jwt', kid: signingKey()!.kid });
    expect(body.iss).toBe(BASE);
    expect(body.aud).toBe(`${BASE}/api/mcp`);
    expect((body.exp as number) - (body.iat as number)).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(body.jti).toBeTruthy();
    expect(body).toMatchObject(CLAIMS);
  });

  it('verifies at the base it was issued for, and nowhere else', async () => {
    const t = await signAccessToken(BASE, CLAIMS);
    await expect(verifyAccessToken(BASE, t)).resolves.toEqual(CLAIMS);
    // Claude binds the token to the resource it discovered: app. ≠ mcp.
    await expect(verifyAccessToken('https://app.veloexpense.test', t)).resolves.toBeNull();
  });

  it('refuses a token signed by any other key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: 'RS256', kid: signingKey()!.kid, typ: 'at+jwt' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('j')
      .setAudience(`${BASE}/api/mcp`)
      .setIssuer(BASE)
      .sign(other);
    await expect(verifyAccessToken(BASE, forged)).resolves.toBeNull();
  });

  it('refuses an unsigned token (alg none) and a token without at+jwt', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${enc({ alg: 'none', typ: 'at+jwt' })}.${enc({ ...CLAIMS, iss: BASE, aud: `${BASE}/api/mcp`, exp: 9e9, iat: 1, jti: 'j' })}.`;
    await expect(verifyAccessToken(BASE, none)).resolves.toBeNull();
    const plainJwt = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: 'RS256', kid: signingKey()!.kid })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('j')
      .setAudience(`${BASE}/api/mcp`)
      .setIssuer(BASE)
      .sign(signingKey()!.privateKey);
    await expect(verifyAccessToken(BASE, plainJwt)).resolves.toBeNull();
  });

  it('allows 30 seconds of clock leeway and no more', async () => {
    const sign = (expAgo: number) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ ...CLAIMS })
        .setProtectedHeader({ alg: 'RS256', kid: signingKey()!.kid, typ: 'at+jwt' })
        .setIssuedAt(now - 1000)
        .setExpirationTime(now - expAgo)
        .setJti('j')
        .setAudience(`${BASE}/api/mcp`)
        .setIssuer(BASE)
        .sign(signingKey()!.privateKey);
    };
    await expect(verifyAccessToken(BASE, await sign(10))).resolves.not.toBeNull();
    await expect(verifyAccessToken(BASE, await sign(60))).resolves.toBeNull();
  });

  it('refuses claims that are missing or not ids', async () => {
    const t = await signAccessToken(BASE, { ...CLAIMS, tenant_id: 'not-a-uuid' });
    await expect(verifyAccessToken(BASE, t)).resolves.toBeNull();
  });

  it('keeps verifying the previous key during a rotation, and signs with the new one', async () => {
    const pem = (k: ReturnType<typeof generateKeyPairSync>['privateKey']) => k.export({ type: 'pkcs8', format: 'pem' }) as string;
    const oldKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const newKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    process.env.MCP_OAUTH_SIGNING_KEY = pem(oldKey);
    const before = await signAccessToken(BASE, CLAIMS);
    process.env.MCP_OAUTH_SIGNING_KEY = pem(newKey);
    process.env.MCP_OAUTH_SIGNING_KEY_PREVIOUS = pem(oldKey);
    await expect(verifyAccessToken(BASE, before)).resolves.toEqual(CLAIMS);
    delete process.env.MCP_OAUTH_SIGNING_KEY_PREVIOUS;
    await expect(verifyAccessToken(BASE, before)).resolves.toBeNull();
  });
});

describe('telling a JWT from an API key (VeloCRM: the eyJ test)', () => {
  it('a three-part token starting eyJ is a JWT; an API key is not', () => {
    expect(looksLikeJwt('eyJa.eyJb.c')).toBe(true);
    expect(looksLikeJwt(`vxe_u_${'a'.repeat(16)}_${'b'.repeat(43)}`)).toBe(false);
    expect(looksLikeJwt('eyJonlyonepart')).toBe(false);
  });
});

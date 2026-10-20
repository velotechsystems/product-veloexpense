/**
 * The RS256 key that signs MCP access tokens, and the JWKS that publishes it.
 *
 * Ported from VeloCRM `api/src/services/jwks.service.ts` (59fce1c). VeloExpense adaptations
 * are marked "VeloExpense (mcp-oauth):".
 *
 *   · Production reads a PKCS#8 PEM from `MCP_OAUTH_SIGNING_KEY`, which the web task gets from
 *     Secrets Manager (`veloexpense/<stage>/mcp-oauth-signing-key`, a hand-made secret, as
 *     VeloCRM's `velocrm/mcp/oauth-signing-key` is). A SEPARATE key from anything the app
 *     already holds (VeloCRM decision 2): the session secret signs sessions, this signs
 *     credentials an outside client carries.
 *   · Outside production with no key set, an ephemeral RSA-2048 pair is generated once per
 *     process, as VeloCRM does — so vitest and `next dev` need nothing configured.
 *   · kid = the first 16 hex characters of SHA-256(SPKI PEM), VeloCRM's derivation.
 *
 *   VeloExpense (mcp-oauth): IN PRODUCTION A MISSING KEY TURNS OAUTH OFF, IT DOES NOT CRASH THE
 *   APP. VeloCRM's `initJwks` throws at startup; VeloCRM's API process exists for MCP and the
 *   app, VeloExpense's web task is the whole product, and a missing connector secret is not a
 *   reason for nobody to be able to file an expense. `signingKey()` answers null, the OAuth
 *   endpoints answer 503, and an access token is refused — API keys keep working.
 *
 *   VeloExpense (mcp-oauth): ROTATION BY ENVIRONMENT, NOT BY A CALL. VeloCRM's `rotateKey()`
 *   swaps keys inside one process, which is one replica of several. Here the overlap is
 *   `MCP_OAUTH_SIGNING_KEY_PREVIOUS`: set it to the old PEM when the new one goes in, and every
 *   replica publishes both kids and verifies either until it is removed (after the 15-minute
 *   access-token lifetime has passed). Its Redis JWKS cache is dropped for the same reason —
 *   every replica derives the same JWKS from the same environment.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface Jwk {
  readonly kty: string;
  readonly use: 'sig';
  readonly alg: 'RS256';
  readonly kid: string;
  readonly n: string;
  readonly e: string;
}

function kidOf(publicKey: KeyObject): string {
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  return createHash('sha256').update(pem).digest('hex').substring(0, 16);
}

/** Secrets Manager hands back the PEM with real newlines; an `.env` file often has `\n`. */
function normalisePem(raw: string): string {
  const v = raw.trim();
  return v.includes('\\n') && !v.includes('\n') ? v.replace(/\\n/g, '\n') : v;
}

function fromPem(raw: string): SigningKey {
  const privateKey = createPrivateKey(normalisePem(raw));
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('MCP_OAUTH_SIGNING_KEY must be an RSA private key (RS256).');
  }
  const publicKey = createPublicKey(privateKey);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

function ephemeral(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

interface KeyState {
  readonly source: string;
  readonly primary: SigningKey | null;
  readonly previous: SigningKey | null;
}

const g = globalThis as unknown as { __veMcpOauthKeys?: KeyState; __veMcpOauthEphemeral?: SigningKey };

/**
 * Read at CALL time, cached per environment value: `appOrigin()`'s rule — a module-load
 * constant is one import re-sort away from being read before the environment exists.
 */
function state(): KeyState {
  const primaryPem = process.env.MCP_OAUTH_SIGNING_KEY?.trim() ?? '';
  const previousPem = process.env.MCP_OAUTH_SIGNING_KEY_PREVIOUS?.trim() ?? '';
  const production = process.env.NODE_ENV === 'production';
  const source = `${production}|${primaryPem}|${previousPem}`;
  const cached = g.__veMcpOauthKeys;
  if (cached && cached.source === source) return cached;
  let primary: SigningKey | null = null;
  if (primaryPem) primary = fromPem(primaryPem);
  else if (!production) {
    // VeloCRM's dev fallback, kept: tokens die with the process, which is fine in a test.
    if (!g.__veMcpOauthEphemeral) {
      g.__veMcpOauthEphemeral = ephemeral();
      console.warn(
        `[mcp-oauth] MCP_OAUTH_SIGNING_KEY is not set: using an ephemeral key ` +
          `(kid=${g.__veMcpOauthEphemeral.kid}). Tokens stop verifying when this process restarts.`,
      );
    }
    primary = g.__veMcpOauthEphemeral;
  }
  const previous = previousPem ? fromPem(previousPem) : null;
  const next = { source, primary, previous };
  g.__veMcpOauthKeys = next;
  return next;
}

/** The key new tokens are signed with, or null when OAuth is not configured here. */
export function signingKey(): SigningKey | null {
  return state().primary;
}

/** Every key a presented token may be signed with: the primary, then a rotation's old one. */
export function verificationKeys(): readonly SigningKey[] {
  const s = state();
  return [s.primary, s.previous].filter((k): k is SigningKey => k !== null && k !== undefined);
}

/** The JWKS document (RFC 7517). */
export function jwks(): { keys: Jwk[] } {
  const seen = new Set<string>();
  const keys: Jwk[] = [];
  for (const k of verificationKeys()) {
    if (seen.has(k.kid)) continue;
    seen.add(k.kid);
    const jwk = k.publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
    keys.push({ kty: jwk.kty, use: 'sig', alg: 'RS256', kid: k.kid, n: jwk.n, e: jwk.e });
  }
  return { keys };
}

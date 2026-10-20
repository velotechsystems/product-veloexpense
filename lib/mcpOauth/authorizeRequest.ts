/**
 * The authorization request (`GET /oauth/authorize`), validated, and the signed ticket the
 * consent form carries back.
 *
 * Ported from VeloCRM `routes/oauth.ts` `GET /oauth/authorize` and `POST /oauth/authorize/consent`
 * (59fce1c): `response_type=code`, `state` required, PKCE S256 required (no `plain`), the
 * redirect URI must be one the client registered.
 *
 * VeloExpense (mcp-oauth) — two VeloCRM defects not repeated, both flagged for the VeloCRM thread:
 *
 *   · VeloCRM's consent form posts back `tenant_id`, `client_id`, `redirect_uri` and `scope` as
 *     hidden fields, and the consent handler trusts them as posted: it mints a code for whatever
 *     tenant the form names, without re-checking the client or the redirect URI. Here the form
 *     carries ONE field, a ticket HMAC-signed (with the app's AUTH_SECRET) over the validated
 *     request, the consenting person and their tenant, with a 10-minute expiry. The consent
 *     route verifies it, checks the signed-in person is the one it names, and re-validates the
 *     client and redirect URI before anything is written. The tenant is the session's, always.
 *   · VeloCRM's "Deny" redirects to the posted `redirect_uri` without checking it, which makes
 *     the endpoint an open redirect. Here a denial goes only to a redirect URI the ticket proves
 *     was validated against the client's registration.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isS256Challenge } from './tokens';
import { grantableScopes } from './scopes';
import type { ClientRow } from './service';

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: string[];
}

/** Errors that may go back to the client's redirect URI (it has been validated). */
export type RedirectableError = { readonly kind: 'redirect'; readonly error: string; readonly description: string };
/** Errors shown on the page: the redirect URI is not trustworthy, so nothing is sent to it. */
export type PageError = { readonly kind: 'page'; readonly reason: 'unknown_client' | 'bad_redirect' | 'missing_params' };

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, k: string): string | undefined => {
  const v = q[k];
  return typeof v === 'string' ? v : undefined;
};

export function validateAuthorize(q: Query, client: ClientRow | null): AuthorizeParams | RedirectableError | PageError {
  const clientId = one(q, 'client_id');
  const redirectUri = one(q, 'redirect_uri');
  if (!clientId || !redirectUri) return { kind: 'page', reason: 'missing_params' };
  if (!client) return { kind: 'page', reason: 'unknown_client' };
  if (!client.redirectUris.includes(redirectUri)) return { kind: 'page', reason: 'bad_redirect' };

  if (one(q, 'response_type') !== 'code') {
    return { kind: 'redirect', error: 'unsupported_response_type', description: 'response_type must be code' };
  }
  const state = one(q, 'state');
  if (!state || state.length > 512) return { kind: 'redirect', error: 'invalid_request', description: 'state is required' };
  const codeChallenge = one(q, 'code_challenge');
  if (!codeChallenge || !isS256Challenge(codeChallenge)) {
    return { kind: 'redirect', error: 'invalid_request', description: 'code_challenge is required (PKCE S256 mandatory)' };
  }
  if (one(q, 'code_challenge_method') !== 'S256') {
    return { kind: 'redirect', error: 'invalid_request', description: 'code_challenge_method must be S256' };
  }
  return { clientId, redirectUri, state, codeChallenge, scopes: grantableScopes(one(q, 'scope')) };
}

/** The client's redirect URI with parameters appended (RFC 6749 §4.1.2; RFC 9207's `iss`). */
export function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/* ── the consent ticket ────────────────────────────────────────────────────── */

export interface ConsentTicket extends AuthorizeParams {
  readonly userId: string;
  readonly organizationId: string;
  /** Unix seconds. */
  readonly exp: number;
}

const TICKET_TTL_SECONDS = 10 * 60;

function secret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? '';
  if (!s) throw new Error('AUTH_SECRET is not set');
  return s;
}

function mac(body: string): string {
  // A label in the key, so this MAC can never be confused with anything else signed by AUTH_SECRET.
  return createHmac('sha256', `mcp-oauth-consent:${secret()}`).update(body).digest('base64url');
}

export function signTicket(t: Omit<ConsentTicket, 'exp'>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...t, exp: Math.floor(now / 1000) + TICKET_TTL_SECONDS })).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function verifyTicket(ticket: string | null | undefined, now = Date.now()): ConsentTicket | null {
  if (!ticket || ticket.length > 8192) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = ticket.substring(0, dot);
  const sig = Buffer.from(ticket.substring(dot + 1));
  const expected = Buffer.from(mac(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConsentTicket;
    if (typeof t.exp !== 'number' || t.exp < Math.floor(now / 1000)) return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * Which origin is this OAuth exchange happening at?
 *
 * Ported from VeloCRM `api/src/utils/requestUrl.ts` (59fce1c), and VeloCRM's lesson with it
 * (`MCP-Subdomain-Spec-Issue.md`): **the issuer, the audience and the discovery documents must
 * all name the host the connector actually used.** Claude binds an access token to the resource
 * it discovered; discovery that says `mcp.` and a token that says `app.` is a mismatch, and
 * Claude rejects the token. So everything here follows the request's host — but only a host on
 * an allowlist, so a forged `Host` header cannot get the server to mint tokens for somebody
 * else's origin. Anything else falls back to the app's own origin.
 *
 * VeloExpense (mcp-oauth): the allowlist is DERIVED, not a hard-coded pair:
 *
 *   · the app's own origin (`appOrigin()`: `app.veloexpense.ai` in prod, `dev.veloexpense.ai`
 *     on dev, the e2e server's origin in a test);
 *   · `mcp.<apex>` when tenant subdomains are on (`AUTH_COOKIE_DOMAIN`, prod) — the canonical
 *     connector host, VeloCRM's `mcp.velocrm.ai`, covered by the existing `*.veloexpense.ai`
 *     certificate and listener rule (infrastructure/cdk/lib/config.ts). `mcp` is a reserved
 *     slug, so it can never also be a tenant;
 *   · anything in `MCP_OAUTH_ALLOWED_HOSTS` (comma-separated), VeloCRM's override.
 *
 * Tenant hosts (`acme.veloexpense.ai`) are deliberately NOT on it. The connector URL is one URL
 * for every customer; which tenant a grant belongs to is decided by who signs in on the consent
 * screen, never by the address.
 */
import { appOrigin } from '@/lib/notifications/email';
import { tenantApex } from '@/lib/tenant/host';

/** The path of the protected resource (the MCP endpoint). */
export const MCP_RESOURCE_PATH = '/api/mcp';

function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  const origin = appOrigin();
  if (origin) {
    try {
      hosts.add(new URL(origin).host.toLowerCase());
    } catch {
      /* an unparseable AUTH_URL adds nothing */
    }
  }
  const apex = tenantApex();
  if (apex) hosts.add(`mcp.${apex}`);
  for (const h of (process.env.MCP_OAUTH_ALLOWED_HOSTS ?? '').split(',')) {
    const v = h.trim().toLowerCase();
    if (v) hosts.add(v);
  }
  return hosts;
}

/**
 * The base URL (scheme + host, no trailing slash) this request should be answered as, or null
 * when the deployment has no origin at all (no `AUTH_URL`): then OAuth is not offered.
 */
export function oauthBaseUrl(headers: Pick<Headers, 'get'>): string | null {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host');
  const host = raw?.split(',')[0]?.trim().toLowerCase();
  const origin = appOrigin();
  if (host && allowedHosts().has(host)) {
    const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    const fallbackProto = origin?.startsWith('http://') ? 'http' : 'https';
    const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : fallbackProto;
    return `${proto}://${host}`;
  }
  return origin;
}

/**
 * Where a PERSON'S BROWSER opens the authorization endpoint (the sign-in and consent screen).
 *
 * VeloExpense (mcp-authorize-host): not the issuer's host. In prod the connector host
 * `mcp.<apex>` is DNS-only (grey cloud) straight to the shared ALB, and that ALB's security
 * group admits only Cloudflare and Anthropic — so Claude's SERVERS reach it, and a person's
 * browser cannot (ERR_ADDRESS_UNREACHABLE, seen 23 Oct 2026 on the first real connect). The
 * browser half of the flow therefore runs on the app's own, Cloudflare-fronted origin
 * (`app.veloexpense.ai`), which is also where the person's session already lives (AUTH_URL;
 * the session cookie is scoped to the apex, auth.ts). RFC 8414 lets `authorization_endpoint`
 * sit on another host than the issuer; the token, registration, revocation and JWKS endpoints
 * and the MCP resource stay on the issuer, so `iss`/`aud` are unchanged.
 *
 * `MCP_OAUTH_AUTHORIZE_URL` overrides it (an origin; anything with a path, query or another
 * scheme is ignored). With neither, the issuer's own base — the single-host deployments (dev,
 * the e2e's default origin) are unchanged.
 */
export function authorizeBaseUrl(issuerBase: string): string {
  const fromEnv = originOf(process.env.MCP_OAUTH_AUTHORIZE_URL);
  if (fromEnv) return fromEnv;
  return originOf(appOrigin()) ?? issuerBase;
}

function originOf(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * May the browser half of the flow (`/oauth/authorize`, its consent POST) run on this request's
 * host? Yes on the configured browser host (`authorizeBaseUrl`) and on the issuer hosts
 * (`allowedHosts`, so a single-host deployment is unchanged); no anywhere else — a tenant host
 * (`acme.<apex>`) or a forged `Host`. The discovery document only ever names the browser host,
 * so refusing the rest costs no client anything and keeps the consent screen at one address a
 * person can learn to recognise.
 */
export function isAuthorizeHost(headers: Pick<Headers, 'get'>): boolean {
  const raw = headers.get('x-forwarded-host') ?? headers.get('host');
  const host = raw?.split(',')[0]?.trim().toLowerCase();
  if (!host) return false;
  if (allowedHosts().has(host)) return true;
  const browser = originOf(process.env.MCP_OAUTH_AUTHORIZE_URL);
  if (!browser) return false;
  return new URL(browser).host.toLowerCase() === host;
}

/**
 * The issuer an authorization request is FOR, from its RFC 8707 `resource` parameter.
 *
 * The consent screen now runs on the app host, but the code it issues is exchanged at the
 * issuer the client discovered — and the redirect back carries that issuer as `iss` (RFC 9207),
 * which a client may check against the metadata it read. The request's own host no longer says
 * which issuer that was; the `resource` it asks for does (Claude sends it: the MCP URL it was
 * given). So: a `resource` naming our MCP path on an allowlisted host → that host's origin;
 * no `resource` → `null` (the caller falls back to the request's own base, the single-host
 * case); a `resource` that is not ours → `'invalid'` (RFC 8707 `invalid_target`).
 */
export function issuerForResource(resource: string | undefined): string | null | 'invalid' {
  if (resource === undefined) return null;
  try {
    const u = new URL(resource);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'invalid';
    if (u.search || u.hash || u.username || u.password) return 'invalid';
    if (u.pathname !== MCP_RESOURCE_PATH) return 'invalid';
    if (!allowedHosts().has(u.host.toLowerCase())) return 'invalid';
    return u.origin;
  } catch {
    return 'invalid';
  }
}

/** The canonical resource URI (RFC 8707) at a base: what an access token's `aud` names. */
export function resourceUrl(base: string): string {
  return `${base}${MCP_RESOURCE_PATH}`;
}

/** RFC 9728's path-specific metadata URL for the resource. */
export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

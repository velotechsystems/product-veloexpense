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

/** The canonical resource URI (RFC 8707) at a base: what an access token's `aud` names. */
export function resourceUrl(base: string): string {
  return `${base}${MCP_RESOURCE_PATH}`;
}

/** RFC 9728's path-specific metadata URL for the resource. */
export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

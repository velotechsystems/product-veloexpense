/**
 * Small shared pieces of the OAuth endpoints' HTTP: the JSON answers, the "is OAuth on here"
 * gate, and the per-address limiter.
 */
import { throttle } from '@/server/lib/rateLimit';
import { signingKey } from './keys';
import { oauthBaseUrl } from './host';

/** RFC 6749 §5.1: token responses (and errors) are never cached. */
export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...extra },
  });
}

export function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return oauthJson({ error, error_description: description }, status, extra);
}

/**
 * The base URL to answer as, or a 503 when this deployment cannot do OAuth: no signing key in
 * production (lib/mcpOauth/keys.ts) or no origin at all. VeloCRM's `MCP_ENABLED` gate, derived
 * from the configuration that actually makes it work rather than a flag that can disagree.
 */
export function oauthBaseOr503(request: Request): { base: string } | { response: Response } {
  const base = oauthBaseUrl(request.headers);
  if (!base || !signingKey()) {
    return {
      response: oauthError(
        'temporarily_unavailable',
        'OAuth for MCP connectors is not configured on this deployment.',
        503,
      ),
    };
  }
  return { base };
}

/** Best-effort client address: the first `x-forwarded-for` hop (server/lib/rateLimit.ts). */
export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Per-address limits, VeloCRM's numbers where it has one: registration 10 an hour (its
 * `dcrLimiter`), the token endpoint 60 a minute (VeloCRM has none there). Counted in Redis by
 * the app's one limiter, which FAILS OPEN without Redis — as every limiter in this app does —
 * so CI, which has no Redis, exercises the endpoints and not the limit.
 */
export async function limited(bucket: 'register' | 'token', request: Request): Promise<Response | null> {
  const cfg = bucket === 'register' ? { max: 10, windowSec: 3600 } : { max: 60, windowSec: 60 };
  const verdict = await throttle(`mcp-oauth:${bucket}:${clientIp(request)}`, cfg);
  if (verdict.allowed) return null;
  return oauthError('slow_down', 'Too many requests; try again later.', 429, {
    'retry-after': String(verdict.retryAfterSec),
  });
}

/** The token and revoke endpoints take a form body only (VeloCRM's rule; RFC 6749 §4.1.3). */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded')) return null;
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

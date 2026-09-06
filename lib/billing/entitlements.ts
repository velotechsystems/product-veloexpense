/**
 * VX5-19 — the platform entitlements client.
 *
 * PORTED, nearly line for line, from `product-veloledger/lib/entitlements/index.ts`
 * — the discriminated result, the two lookup keys, the short-TTL cache, the rule
 * that only stable outcomes are cached, and the header name. Where this differs
 * from VeloLedger's it is noted at the point of difference and not before.
 *
 * VeloExpense does not own billing. The VeloTech platform (the VeloCRM-hosted
 * billing service) is the source of truth for what an account is entitled to,
 * across every VeloTech product, and holds the one `subscription_plans` catalogue
 * with a `product` dimension. This module asks it "what is this account entitled
 * to for product=veloexpense?" and hands back the answer.
 *
 * ── ACCOUNT IDENTITY, AND WHY THERE ARE TWO KEYS ───────────────────────────
 *
 * The canonical key is the platform's Account UUID, stamped on `organization.
 * account_id` by the inbound provisioning call (0039, ported from VeloLedger's
 * 0051). Until that has happened there is no UUID to use, so the account is
 * resolved by EMAIL DOMAIN, which the platform maps to an Account via its
 * primary domain.
 *
 * The fallback matters more here than it does in VeloLedger, and this is the one
 * substantive difference: VeloExpense tenants can also arrive through OUR OWN
 * signup (VX5-1/VX5-2), which the platform never saw. Those organizations have no
 * `account_id` and may have no platform Account at all — and the answer for them
 * is `not_found`, which is a legitimate state meaning "nobody is billing this
 * tenant", not an error.
 *
 * ── OFF IS A STATE, NOT A FAILURE ──────────────────────────────────────────
 *
 * With `PLATFORM_API_URL` or `PLATFORM_SERVICE_TOKEN` unset the result is
 * `disabled` and VeloExpense runs exactly as it did before billing existed —
 * ungated. Same shape as `INTEGRATIONS_ENABLE_STUB` and the QuickBooks
 * credentials (NT-18): an unconfigured integration is invisible rather than
 * broken, and no migration or code change turns it on.
 *
 * Errors are SURFACED, never swallowed into a fake success. A caller that cannot
 * tell "the platform says this account is cancelled" from "the platform did not
 * answer" will eventually treat one as the other, and only one of those should
 * ever stop somebody working.
 */

const PRODUCT = 'veloexpense';

/** The entitlement projection the platform returns for (account, product). */
export interface PlatformEntitlement {
  accountId: string | null;
  product: string;
  hasSubscription: boolean;
  /** active | trialing | past_due | canceled | suspended */
  status: string | null;
  planName: string | null;
  planSlug: string | null;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  billingCycle: string | null;
  inTrial: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  /**
   * THE PLATFORM'S OWN VERDICT on whether this account may write.
   *
   * Consumed directly rather than derived from `status`. VX5-11 derived it here,
   * which meant this product held an opinion about what "past_due" permits that
   * the platform's other consumers might not share — and a customer who is
   * read-only in one product and not in another is a support call nobody can
   * explain.
   */
  readOnly: boolean;
}

/**
 * A discriminated union so callers handle each case explicitly rather than
 * guessing from a nullable object.
 *
 *   disabled  — platform integration not configured (env unset); run ungated.
 *   ok        — the platform answered; `entitlement` holds the projection.
 *   not_found — no platform Account matches. Legitimate: a tenant that signed up
 *               through VeloExpense's own front door and was never provisioned by
 *               the platform is exactly this, and is not an error.
 *   error     — the platform was unreachable or returned an error (surfaced).
 */
export type EntitlementResult =
  | { state: 'disabled' }
  | { state: 'ok'; entitlement: PlatformEntitlement }
  | { state: 'not_found' }
  | { state: 'error'; message: string };

/** Lowercased email domain, or null if the email is missing/malformed. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}

/** True when both platform env vars are present (integration is configured). */
export function platformConfigured(): boolean {
  return Boolean(process.env.PLATFORM_API_URL && process.env.PLATFORM_SERVICE_TOKEN);
}

/**
 * Short-TTL cache. A mid-cycle plan change will not reflect for up to TTL_MS.
 *
 * Only STABLE outcomes are cached — `ok` and `not_found`. A transient `error` and
 * the env-driven `disabled` are never cached, so a platform that comes back up is
 * seen immediately rather than a minute later. Ported verbatim, including that
 * rule, which is the part most likely to be "simplified" away.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: EntitlementResult }>();

export function clearEntitlementCache(): void {
  cache.clear();
}

async function cached(
  key: string,
  fn: () => Promise<EntitlementResult>,
): Promise<EntitlementResult> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const result = await fn();
  if (result.state === 'ok' || result.state === 'not_found') {
    cache.set(key, { at: Date.now(), result });
  }
  return result;
}

/** Build the entitlements URL for whichever account key we have. */
function entitlementUrl(baseUrl: string, key: { accountId: string } | { domain: string }): string {
  const sel =
    'accountId' in key
      ? `accountId=${encodeURIComponent(key.accountId)}`
      : `domain=${encodeURIComponent(key.domain)}`;
  return (
    `${baseUrl.replace(/\/+$/, '')}/api/v1/platform/entitlements` +
    `?product=${encodeURIComponent(PRODUCT)}&${sel}`
  );
}

/**
 * Core (uncached) lookup. Never throws — returns a typed result the caller
 * branches on.
 */
async function fetchEntitlementRaw(
  key: { accountId: string } | { domain: string },
): Promise<EntitlementResult> {
  const baseUrl = process.env.PLATFORM_API_URL;
  const token = process.env.PLATFORM_SERVICE_TOKEN;
  if (!baseUrl || !token) return { state: 'disabled' };

  let res: Response;
  try {
    res = await fetch(entitlementUrl(baseUrl, key), {
      method: 'GET',
      // Service-to-service, NOT user auth. The header name is the platform's.
      headers: { 'x-platform-key': token, accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (err) {
    return {
      state: 'error',
      message: err instanceof Error ? err.message : 'platform request failed',
    };
  }

  if (res.status === 404) return { state: 'not_found' };
  if (res.status === 401 || res.status === 503) {
    return { state: 'error', message: `platform auth/availability error (${res.status})` };
  }
  if (!res.ok) return { state: 'error', message: `platform responded ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: 'error', message: 'platform returned invalid JSON' };
  }

  // The platform wraps the payload as { data: { accountId, product, ...entitlement } }.
  const data = (body as { data?: unknown })?.data ?? body;
  return { state: 'ok', entitlement: data as PlatformEntitlement };
}

/** Entitlement for the account that owns `domain`. Cached for TTL_MS. */
export async function fetchEntitlementByDomain(domain: string): Promise<EntitlementResult> {
  return cached(`dom:${domain}`, () => fetchEntitlementRaw({ domain }));
}

/** Entitlement by the platform Account UUID — the canonical key. Cached. */
export async function fetchEntitlementByAccountId(accountId: string): Promise<EntitlementResult> {
  return cached(`acct:${accountId}`, () => fetchEntitlementRaw({ accountId }));
}

/**
 * Preferred resolver: the org's platform `accountId` when present, else the email
 * domain. Returns 'error' only when neither key is available.
 */
export async function fetchEntitlement(args: {
  accountId?: string | null;
  email?: string | null;
}): Promise<EntitlementResult> {
  if (args.accountId) return fetchEntitlementByAccountId(args.accountId);
  const domain = emailDomain(args.email);
  if (domain) return fetchEntitlementByDomain(domain);
  return { state: 'error', message: 'no accountId or email domain to resolve' };
}

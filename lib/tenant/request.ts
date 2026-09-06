/**
 * Bridge: auth session -> tenant context. Every server action / route handler
 * that touches tenant data calls withCurrentOrg(), which reads organizationId
 * off the authenticated session and runs the work inside withOrg() so Postgres
 * RLS is scoped correctly.
 *
 * ── VX5-5: THE SESSION IS AUTHORITATIVE, THE HOST IS NOT ────────────────────
 *
 * A tenant subdomain does NOT decide which organization a request reads. It
 * cannot be allowed to: a host that could switch the session's tenant would be
 * one URL away from being a cross-tenant read, and — this is the part that
 * matters — it would be indistinguishable from working correctly. `app.current_org`
 * still comes from the session and only from the session.
 *
 * What the host does is have to AGREE. Land on `acme.veloexpense.app` with a
 * session belonging to Globex and the request is REFUSED, here, before any
 * tenant row is read. Not redirected and not quietly served from Globex:
 *
 *   · Serving Globex's data at Acme's address is a lie about what the URL means,
 *     and it is the shape a shared link would take when it silently showed
 *     somebody the wrong company.
 *   · Redirecting is worse than refusing for anybody who belongs to two tenants:
 *     they click a colleague's link and end up somewhere else without noticing.
 *
 * ── WHY THE CHECK IS HERE, AND NOWHERE EARLIER ──────────────────────────────
 *
 * Not in middleware: the edge cannot ask whether `acme` names a real
 * organization, and MT-3's rule is that a gate at the edge is a gate the next
 * caller forgets. Not only in a layout, either — route handlers never see one.
 * `withCurrentOrg` is the single place every tenant read already goes through,
 * so a mismatch stops the DATA rather than stopping a page.
 *
 * `app/layout.tsx` runs the same comparison to RENDER something a person can
 * act on. That one is for the reader; this one is the guard.
 *
 * `HostMismatchError` itself lives in `lib/tenant/host.ts`, not here, for VX4-9's
 * reason: this module imports `@/auth`, which vitest cannot load, so anything a
 * unit test needs to reach has to sit on the other side of that import.
 */
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { withOrg } from '@/lib/tenant/context';
import { candidateSlugFromHost, HostMismatchError } from '@/lib/tenant/host';
import type { QueryRunner } from '@/lib/db/client';

export async function currentOrgId(): Promise<string> {
  const session = await auth();
  const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (!orgId) throw new Error('unauthenticated: no organization in session');
  return orgId;
}

/**
 * The candidate slug in the request's own `Host`, or null.
 *
 * Read straight from the request. There is nothing to forge: the `Host` header
 * IS the host somebody asked for, and asking for another tenant's host is
 * precisely the case the comparison below refuses. `x-forwarded-host` wins when
 * present, because behind a proxy that is the host the browser used and `host`
 * is the proxy's own.
 *
 * Null means "not a tenant address" — the apex, `www`, an IP, or a deployment
 * with no tenant subdomains at all. It does NOT mean the tenant exists; only the
 * comparison below turns a candidate into a decision.
 */
export async function hostTenantSlug(): Promise<string | null> {
  const h = await headers();
  return candidateSlugFromHost(h.get('x-forwarded-host') ?? h.get('host'));
}

export async function withCurrentOrg<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
  const orgId = await currentOrgId();
  const hostSlug = await hostTenantSlug();
  return withOrg(orgId, async (tx) => {
    if (hostSlug !== null) {
      // Filtered by id explicitly. `organization` carries no tenant column and
      // therefore no `tenant_isolation` policy — it is where tenancy comes FROM
      // — so an unfiltered read here would return every tenant's slug.
      const r = await tx.query('SELECT slug FROM organization WHERE id = $1', [orgId]);
      const sessionSlug = (r.rows[0]?.slug as string | undefined) ?? '';
      if (sessionSlug !== hostSlug) throw new HostMismatchError(hostSlug, sessionSlug);
    }
    return fn(tx);
  });
}

/**
 * The same comparison, as a fact rather than a throw, for `app/layout.tsx`.
 *
 * Returns null when there is nothing to say — no session, no tenant host, or the
 * two agree. Never throws: it runs in a layout, where an exception is a blank
 * error page for a situation that has a perfectly good sentence.
 */
export async function hostTenantMismatch(): Promise<{
  hostSlug: string;
  sessionSlug: string;
} | null> {
  try {
    const hostSlug = await hostTenantSlug();
    if (hostSlug === null) return null;
    const session = await auth();
    const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
    if (!orgId) return null; // not signed in: `/login` is the right page, not this one
    return await withOrg(orgId, async (tx) => {
      const r = await tx.query('SELECT slug FROM organization WHERE id = $1', [orgId]);
      const sessionSlug = (r.rows[0]?.slug as string | undefined) ?? '';
      return sessionSlug === hostSlug ? null : { hostSlug, sessionSlug };
    });
  } catch {
    // A layout that cannot answer this question must still render the page. The
    // guard in `withCurrentOrg` is the one that must not fail open, and it does
    // not — it is on the path to the data.
    return null;
  }
}

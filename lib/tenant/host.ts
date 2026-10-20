/**
 * VX5-5 — which tenant does this web address name? (BR-8 / ON-4)
 *
 * ── THE APEX IS CONFIGURED, AND MY FIRST DESIGN WAS WRONG ───────────────────
 *
 * The first version of this module took no apex. The rule was "the first label
 * of a multi-label host is a candidate slug, and the database decides whether it
 * names a real organization" — no env var to get wrong, and `RESERVED_SLUGS`
 * (which already refuses `www`, `app`, `api`, `veloexpense`) was supposed to
 * keep our own hostnames from being read as tenants.
 *
 * The e2e refuted it on the first run. `velo.test` — the apex the browser test
 * resolves — has two labels, so `velo` was read as a tenant, and every signed-in
 * request to the apex was refused as a mismatch. The heuristic only works when
 * the apex's own first label happens to be reserved: `veloexpense.app` survives,
 * and a perfectly ordinary `expenses.velotech.ai` does not. That is a production
 * footgun disguised as one less setting.
 *
 * So the apex is read from `AUTH_COOKIE_DOMAIN`, and NOT from a flag of its own.
 * That variable is what makes a session usable across subdomains at all
 * (`auth.ts` has the measurement: a cookie with no `Domain` is host-only, and a
 * subdomain without it bounces to `/login`). A deployment that has not set it
 * has no working tenant subdomains, so the honest answer there is that no host
 * names a tenant — which is exactly what an empty apex produces here. One
 * variable, and the two behaviours cannot be configured against each other.
 *
 * ── STILL ONLY A CANDIDATE ──────────────────────────────────────────────────
 *
 * A well-formed label under the apex is a GUESS. `lib/tenant/request.ts` asks
 * the database whether it names the organization the session belongs to, which
 * is both the authoritative question and the only one that matters.
 *
 * ── NO MIDDLEWARE, EITHER — ALSO A CORRECTION ───────────────────────────────
 *
 * The first version had `proxy.ts` stamp a custom `x-velo-host-tenant` header,
 * with a careful note about overwriting it so a client could not forge one.
 * That mechanism existed to work around a problem that does not exist: the
 * `Host` header IS the host the request was made to, and a client "forging" it
 * is just a client asking for that host — where the mismatch check applies
 * unchanged. The header, and the spoofing surface it created, are gone.
 */
import { DomainError } from '@/lib/errors/domain';

/** `0034`'s constraint, restated — this module cannot import from `lib/onboarding`
 *  (that pulls `pg` in transitively). The shapes are asserted equal in
 *  `test/tenant-host.test.ts`, so a change to one fails on the other. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Labels that are never a tenant even directly under the apex, DUPLICATED from
 * `lib/onboarding/slug.ts` for the import reason above.
 *
 * Belt and braces now that the apex is explicit: `www.veloexpense.app` is the
 * marketing site, not a customer called `www`, and a request for
 * `api.veloexpense.app` should not be read as one either. The test asserts this
 * is a SUBSET of the real reserved list, so it can never claim something is
 * reserved when a customer could actually hold it.
 */
const NEVER_A_TENANT = new Set(['www', 'app', 'api', 'mcp', 'localhost', 'veloexpense', 'velotech']);

/**
 * The apex this deployment serves tenants under, or '' when it serves none.
 *
 * Read at CALL time, never at module load — `appOrigin()`'s rule (NT-14), and
 * the reason is the same: a module-level constant is one import re-sort away
 * from being read before the environment exists, and the failure is silent.
 */
export function tenantApex(): string {
  return (process.env.AUTH_COOKIE_DOMAIN ?? '').trim().replace(/^\./, '').toLowerCase();
}

/**
 * The candidate tenant slug in a `Host` header, or null.
 *
 * Null for: no apex configured (this deployment has no tenant subdomains), a
 * host that is not under the apex, the apex itself, an IP address, a reserved
 * label, and anything that is not a DNS label. Not null does NOT mean the
 * tenant exists.
 */
export function candidateSlugFromHost(
  host: string | null | undefined,
  apex: string = tenantApex(),
): string | null {
  if (!host || apex === '') return null;
  // Strip the port, and an IPv6 literal's brackets with it.
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (name === '' || name === apex) return null;
  if (name.includes(':')) return null; // IPv6
  if (/^\d+(\.\d+)*$/.test(name)) return null; // IPv4

  const suffix = `.${apex}`;
  if (!name.endsWith(suffix)) return null;
  const head = name.slice(0, -suffix.length);
  if (head === '' || head.includes('.')) return null; // exactly ONE label under the apex
  if (!DNS_LABEL.test(head)) return null;
  if (NEVER_A_TENANT.has(head)) return null;
  return head;
}


/**
 * The request was aimed at one tenant's address and carries another's session.
 *
 * Declared HERE rather than in `lib/tenant/request.ts`, which is where it is
 * thrown, for VX4-9's reason: that module imports `@/auth` and vitest cannot
 * load it, so an error class a unit test needs to assert on has to live on this
 * side of that import. `lib/auth/actor.ts` holds `isActiveAdmin` for the same
 * reason, and it was worth the move there too.
 *
 * A `DomainError` with a catalogued message, so a server action shows a sentence
 * rather than the generic (IL-11). The message names neither organization — see
 * `WRONG_TENANT_HOST` in the catalogue.
 */
export class HostMismatchError extends DomainError {
  constructor(
    readonly hostSlug: string,
    readonly sessionSlug: string,
  ) {
    super(
      `request for tenant host ${JSON.stringify(hostSlug)} carries a session for ${JSON.stringify(sessionSlug)}`,
      'WRONG_TENANT_HOST',
    );
    this.name = 'HostMismatchError';
  }
}

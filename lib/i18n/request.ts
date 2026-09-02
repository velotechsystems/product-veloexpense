/**
 * VX4-7 part 1 — the reader's locale and clock for ONE RENDER.
 *
 * Modelled on `lib/branding/request.ts`, which solved this exact problem for the
 * palette, and its header is worth re-reading rather than paraphrasing: the root
 * layout wraps `/login` as well as the app, so this runs on requests with no
 * session at all, and "a LAYOUT has the opposite obligation — an unauthenticated
 * visitor must get the page … not a stack trace".
 *
 * So this module turns "no session" into "the negotiated or default locale",
 * and it is the only place allowed to. It does not swallow anything else: a
 * database that is down propagates, because a page that renders plausible dates
 * while the database is unreachable is a page hiding an outage.
 *
 * ── WRAPPED IN `cache()`, FOR THE REASON BRANDING RECORDS ───────────────────
 *
 * `generateMetadata` and the layout body both run for one request and Next calls
 * them separately, so the uncached version is two sessions read and two queries
 * on every page in the product. React's `cache` is per-request and per-render,
 * which is the scope that makes them one. Every page that formats money or a
 * date calls this too, so without the cache a screen with a table on it would
 * ask once per render pass rather than once per request.
 *
 * ── AND WHY THIS IS NOT A CONTEXT PROVIDER ──────────────────────────────────
 *
 * The obvious React answer is a provider at the root and a hook at each leaf.
 * That needs a client component, and the product ships no client JS beyond the
 * receipt drawer — a rule VX1-5 paid for deliberately. `cache()` gives the same
 * "resolve once, read anywhere" property with no client bundle and no provider,
 * because a server component can simply call this function.
 */
import { cache } from 'react';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { withOrg } from '@/lib/tenant/context';
import { DEFAULT_LOCALE } from './locales';
import { DEFAULT_TIMEZONE, negotiateLocale, type ReaderPrefs } from './resolve';
import { loadReaderPrefsByEmail } from './service';

/**
 * The reader's locale and zone: their stored preferences, else their company's,
 * else the request's `Accept-Language`, else the constants.
 *
 * On a signed-out request this reaches the header rung — which on `/login` is
 * the only signal that exists, since there is no tenant pre-auth either until
 * Phase 5's host-based tenancy (0023, BR-1/BR-8).
 */
export const readerPrefs = cache(async function readerPrefs(): Promise<ReaderPrefs> {
  const acceptLanguage = (await headers()).get('accept-language');

  const session = await auth();
  const user = session?.user as { email?: string | null; organizationId?: string } | undefined;
  const orgId = user?.organizationId;
  const email = user?.email;

  if (!orgId || !email) {
    return {
      locale: negotiateLocale(acceptLanguage) ?? DEFAULT_LOCALE,
      // No stored zone can exist without a tenant, and there is no header to
      // negotiate one from — see `resolveTimeZone`, which explains why a browser
      // rung is impossible here rather than merely absent.
      timeZone: DEFAULT_TIMEZONE,
    };
  }

  return withOrg(orgId, (tx) => loadReaderPrefsByEmail(tx, email, acceptLanguage));
});

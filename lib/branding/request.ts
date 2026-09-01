/**
 * VX4-3 part 2 — branding for a RENDER, which is a different problem from
 * branding for an admin action.
 *
 * The root layout wraps `/login` as well as the app, so this runs on requests
 * that have no session at all. `withCurrentOrg` throws in that case, and it is
 * right to: an action that touches tenant data must never silently proceed
 * without a tenant. A LAYOUT has the opposite obligation — an unauthenticated
 * visitor must get the page, unbranded, not a stack trace. So this module is the
 * one place allowed to turn "no tenant" into "no branding", and it is deliberately
 * the only export that does.
 *
 * WHAT IT DOES NOT DO is swallow anything else. A malformed colour that somehow
 * reached the column, a database that is down — those propagate, because a layout
 * that renders a plausible unbranded page when the database is unreachable is a
 * layout that hides an outage.
 */
import { cache } from 'react';
import { auth } from '@/auth';
import { withOrg } from '@/lib/tenant/context';
import { brandCss } from '@/lib/branding/css';
import { getBranding, type Branding } from '@/lib/branding/service';

export interface RenderBranding {
  /** Null when there is no tenant on this request, e.g. `/login`. */
  branding: Branding | null;
  /** Null when there is no tenant, or the tenant chose no colour. */
  css: string | null;
  /** `?v=` cache key, or null when there is no logo. */
  logoSrc: string | null;
}

const NONE: RenderBranding = { branding: null, css: null, logoSrc: null };

/**
 * WRAPPED IN `cache()`, and it is not an optimisation for later.
 *
 * `generateMetadata` and the layout body BOTH need this, and Next calls them
 * separately for the same request — so the naive version is two sessions read and
 * two queries on every page in the product, forever, to render one `<style>` and
 * one `<title>`. React's `cache` is per-request and per-render, which is exactly
 * the scope that makes them one.
 *
 * AN-10 is the same lesson arriving from the other direction: their home page runs
 * a full-history aggregate for every signed-in user. The cost that never shows up
 * in a test is the one on the path every request takes.
 */
export const brandingForRender = cache(async function brandingForRender(): Promise<RenderBranding> {
  const session = await auth();
  const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (!orgId) return NONE;

  const branding = await withOrg(orgId, getBranding);
  return {
    branding,
    css: brandCss(branding.brandColor)?.css ?? null,
    // The stamp is the whole reason `logo_updated_at` is a column: with it the
    // response can be cached immutably, and a new logo is a new URL. ExpenseOS's
    // icon route has no such stamp and settles for `max-age=300` with a comment
    // explaining the compromise ("an icon change reuses the same URL, so cap
    // staleness").
    logoSrc:
      branding.logo === null
        ? null
        : `/api/branding/logo?v=${branding.logo.updatedAt.getTime()}`,
  };
});

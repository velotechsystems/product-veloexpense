/**
 * VX4-3 part 2 — the tenant's wordmark, as bytes.
 *
 * PORTED FROM `api/public-icons/[code]/route.ts`, which is the shape ExpenseOS
 * got right (and which its own branding form contradicts — see BR-4). Every
 * header below is there for a reason that route learned:
 *
 *   `nosniff`            — the bytes are uploaded, so the browser must not go
 *                          looking for a type we did not declare. This is only a
 *                          safety property because `setLogo` sniffs the magic
 *                          number, which makes the declared type TRUE.
 *   `Content-Disposition:
 *    attachment`         — ignored for `<img>` embedding, so the page still
 *                          renders, but forces a download on top-level
 *                          navigation instead of rendering uploaded bytes as a
 *                          document on our own origin.
 *   sandbox CSP          — defence in depth. `0023` refuses SVG at the column, so
 *                          nothing scriptable should be here; this is what makes
 *                          "should" survive a future migration that relaxes the
 *                          CHECK.
 *
 * THE ONE DIVERGENCE IS THE CACHE. Theirs is `max-age=300` because its URL has no
 * version and an icon change reuses it. Ours carries `?v=<logo_updated_at>`, so
 * the response is immutable for a year and a rebrand is a different URL — one
 * fewer round trip on every page, and no staleness window at all.
 *
 * NOT public, unlike theirs: their icons are for a pre-auth login screen, ours is
 * for the app shell behind a session. Pre-auth branding waits for Phase 5 with
 * host-based tenancy, and when it lands it needs a route addressed by SLUG rather
 * than by session — which is a different route, not a relaxation of this one.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withCurrentOrg } from '@/lib/tenant/request';
import { HostMismatchError } from '@/lib/tenant/host';
import { readLogoBytes } from '@/lib/branding/service';

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  // 404 rather than 401: whether a tenant has uploaded a logo is not something an
  // unauthenticated caller gets told apart from anything else.
  if (!orgId) return new NextResponse('Not found', { status: 404 });

  /* VX5-5 — `withCurrentOrg`, not `withOrg(orgId)`, and this route is why the
   * guard lives in there at all.
   *
   * A ROUTE HANDLER NEVER SEES A LAYOUT. `app/layout.tsx` renders the "this is
   * not your organization" page for every PAGE on a mismatched host, and it does
   * so before any page's own tenant read runs — which is why a sabotage removing
   * the guard from `withCurrentOrg` failed no browser test until this line
   * existed. It was measured, not assumed: the layout was doing all the work and
   * the guard I had called load-bearing was covered by nothing.
   *
   * This route bypassed both. On `second.veloexpense.app` a Demo session fetched
   * Demo's logo bytes quite happily — your own logo, so not a leak, but exactly
   * the shape of one, and the shape is what the next route copies.
   *
   * A mismatch is a 404 here for the reason the `orgId` check above is: what a
   * tenant has uploaded is not something this route confirms or denies. */
  let logo: Awaited<ReturnType<typeof readLogoBytes>>;
  try {
    logo = await withCurrentOrg(readLogoBytes);
  } catch (err) {
    if (err instanceof HostMismatchError) return new NextResponse('Not found', { status: 404 });
    throw err;
  }
  if (logo === null) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      'Content-Type': logo.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Immutable, because the URL carries the stamp. `private` because the bytes
      // belong to one tenant and a shared cache must not serve them to another.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${logo.updatedAt.getTime()}"`,
    },
  });
}

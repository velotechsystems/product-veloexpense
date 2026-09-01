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
import { withOrg } from '@/lib/tenant/context';
import { readLogoBytes } from '@/lib/branding/service';

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const orgId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  // 404 rather than 401: whether a tenant has uploaded a logo is not something an
  // unauthenticated caller gets told apart from anything else.
  if (!orgId) return new NextResponse('Not found', { status: 404 });

  const logo = await withOrg(orgId, readLogoBytes);
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

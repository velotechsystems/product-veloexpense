/**
 * VX5-6 — a tenant's logo, for somebody holding an invitation and no session.
 *
 * ── THE ONE THING THAT MAKES THIS DIFFERENT FROM `api/branding/logo` ────────
 *
 * That route is session-gated and stays that way. This one is gated on a LIVE
 * INVITATION TOKEN, which is not a relaxation — it is a different credential
 * with a narrower audience: 32 random bytes an admin caused to be mailed to one
 * address, which expire, which can be withdrawn, and which stop resolving the
 * moment the invitation is used.
 *
 * GAP-AUDIT BR-4 warns that pre-auth branding is "an unauthenticated oracle for:
 * does this company use VeloExpense, and what is its logo". A route addressed by
 * SLUG would be exactly that. Addressed by token it answers only for somebody who
 * was already told. That distinction is also why the sign-in page is NOT branded
 * — see `app/login/page.tsx`.
 *
 * ── EVERY HEADER HERE IS THE SESSION ROUTE'S, FOR ITS REASONS ───────────────
 *
 * `nosniff`, `Content-Disposition: attachment` and the sandbox CSP are copied
 * deliberately rather than reasoned about again: they are what makes serving
 * uploaded bytes from our own origin safe, and `0023` refuses anything but a
 * raster type at the column so the declared mime is true.
 *
 * ONE DIFFERENCE, and it matters: `Cache-Control` is `no-store` rather than
 * immutable-and-private. The session route's URL is scoped to a reader who is
 * already inside the tenant; this one carries a CREDENTIAL in the query string,
 * and a credential-bearing URL is exactly what should not sit in a shared cache
 * or a proxy log any longer than it has to. The `?v=` stamp stays because it
 * keeps the URL honest about which logo it is, not because anything caches it.
 */
import { NextResponse } from 'next/server';
import { readInviteLogo } from '@/lib/invites/service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('token');
  // 404 for a missing, dead or logo-less invitation alike. Telling those apart
  // would say whether a token somebody holds ever existed, which is the same
  // reasoning `SIGNUP_LINK_DEAD` and `INVITE_LINK_DEAD` are one sentence for.
  if (!token) return new NextResponse('Not found', { status: 404 });

  const logo = await readInviteLogo(token);
  if (logo === null) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      'Content-Type': logo.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'no-store',
    },
  });
}

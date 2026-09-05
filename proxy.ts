/**
 * Edge middleware — auth gating only (must stay edge-safe: no pg, no Node imports).
 * Tenant context is set in the Node data layer via withCurrentOrg(), not here.
 * Redirects unauthenticated users to /login based on the Auth.js session cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';

// `/approve` and the drain route are PUBLIC, and each carries its own credential
// instead of a session (VX2-8):
//   /approve                            a single-use, expiring action token in the
//                                       query string. Nothing happens on the GET.
//   /api/internal/notifications/drain   a shared secret in an Authorization
//                                       header, fail-closed when unset.
//
// VX5-2b adds a third, and it is public for a different reason again:
//   /signup                             there is no session BECAUSE there is no
//                                       tenant yet — creating one is the point.
//                                       The credential is the mailed token, and
//                                       `0035`'s policies are what police it.
//
// TWO PLACES, AND EITHER ONE ALONE IS ENOUGH — MEASURED, NOT ASSUMED. The
// `matcher` decides whether middleware runs at all; `PUBLIC` is what runs when
// it does. `/signup` is in both, as `/login` and `/approve` already were, and a
// sabotage sweep says what that redundancy is worth: removing it from `PUBLIC`
// alone fails nothing, removing it from the `matcher` alone fails nothing, and
// removing it from both fails five e2e assertions.
//
// So no test can tell the two apart and none can be written to. This comment is
// the only thing standing between a later reader and the reasonable-sounding
// conclusion that one of them is dead code — which it is, right up until
// somebody deletes the other one.
// A session cookie is meaningless for both — an approver clicking a link from
// their phone's mail app has none, and a scheduler never will.
const PUBLIC = [
  /^\/login/,
  /^\/api\/auth/,
  /^\/approve/,
  /^\/signup/,
  /^\/api\/internal\//,
  /^\/_next\//,
  /^\/favicon\.ico$/,
];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  const hasSession =
    req.cookies.has('authjs.session-token') ||
    req.cookies.has('__Secure-authjs.session-token');
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/auth|api/internal|_next/static|_next/image|favicon.ico|login|approve|signup).*)'],
};

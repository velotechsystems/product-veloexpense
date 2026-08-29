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
// A session cookie is meaningless for both — an approver clicking a link from
// their phone's mail app has none, and a scheduler never will.
const PUBLIC = [
  /^\/login/,
  /^\/api\/auth/,
  /^\/approve/,
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
  matcher: ['/((?!api/auth|api/internal|_next/static|_next/image|favicon.ico|login|approve).*)'],
};

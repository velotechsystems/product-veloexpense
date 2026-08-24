/**
 * Edge middleware — auth gating only (must stay edge-safe: no pg, no Node imports).
 * Tenant context is set in the Node data layer via withCurrentOrg(), not here.
 * Redirects unauthenticated users to /login based on the Auth.js session cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = [/^\/login/, /^\/api\/auth/, /^\/_next\//, /^\/favicon\.ico$/];

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

export const config = { matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|login).*)'] };

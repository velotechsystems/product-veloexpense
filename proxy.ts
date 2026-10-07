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
// VX5-3 adds a fourth, and it carries NO credential at all:
//   /invite/accept                      it names the tenant and hands somebody to
//                                       SSO. The invitation is accepted by the
//                                       identity provider verifying the address,
//                                       in `lib/auth/resolve-sso-user.ts` — not
//                                       here. Public because an invited person
//                                       has no session yet, by definition.
//
// VX5-20 part 2 adds a fifth, and it is the only one that is a SERVICE:
//   /api/platform/provision             the VeloTech platform's provisioning
//                                       orchestrator, authenticated by
//                                       `x-platform-key` against
//                                       PLATFORM_INBOUND_TOKEN in constant time,
//                                       503 when unset. Public here for the same
//                                       reason the drain route is: there is no
//                                       human and never will be, so a session
//                                       cookie is not a credential it could
//                                       present. Listed in BOTH places below,
//                                       and the redundancy was measured the same
//                                       way /signup's was: removing it from
//                                       PUBLIC alone fails nothing, removing it
//                                       from the matcher alone fails nothing,
//                                       and removing it from BOTH turns every
//                                       assertion in
//                                       e2e/platform-provision.spec.ts into a
//                                       307 to /login.
//
//                                       That failure mode is worse than failing
//                                       closed. A client that follows redirects
//                                       — which is every client — gets the login
//                                       PAGE with a 200 where it expected a 201,
//                                       so the orchestrator's operator sees a
//                                       plausible success and no tenant. It
//                                       looks like the platform's bug.
//
//                                       NOTE FOR WHOEVER TESTS THIS NEXT:
//                                       Playwright's APIRequestContext does NOT
//                                       go through this middleware — an
//                                       anonymous one renders /expenses, which
//                                       this file guards. The spec uses plain
//                                       fetch with redirect:'manual' for exactly
//                                       that reason, and the first version of it
//                                       passed with this entry deleted.
//
// Phase 5's first deployment adds a sixth, and it carries no credential because it
// discloses nothing:
//   /api/health                         liveness for the load balancer's target
//                                       group and the container health check,
//                                       which send no cookie. It answers
//                                       {"ok":true} and nothing else (no
//                                       version, no commit). EXACT path in
//                                       PUBLIC; the matcher, like its
//                                       neighbours, is a prefix. Without it the
//                                       target group sees a 307 to /login, marks
//                                       every task unhealthy, and the deploy
//                                       rolls itself back.
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
  /^\/invite/,
  /^\/api\/internal\//,
  /^\/api\/platform\//,
  /^\/api\/health$/,
  /^\/_next\//,
  /^\/favicon\.ico$/,
  // 2026 brand: the wordmark and the favicon render BEFORE anyone signs in — on
  // the sign-in page and in the tab — so they must never be redirected to it.
  // (The design system's rollout note: an auth redirect blocked VeloLedger's
  // logo on its own sign-in page.) Static files only; nothing here reads data.
  /^\/brand\//,
  /^\/apple-touch-icon\.png$/,
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
  matcher: ['/((?!api/auth|api/internal|api/platform|api/health$|_next/static|_next/image|favicon.ico|brand/|apple-touch-icon.png|login|approve|signup|invite).*)'],
};

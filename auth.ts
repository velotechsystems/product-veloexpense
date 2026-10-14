/**
 * VX0-7 — NextAuth v5 via the vendored @velotech/auth-kit factory (src/auth-kit,
 * pinned commit — see src/auth-kit/VENDORED.md).
 *
 * Providers: Google + Microsoft Entra ID. Invite-only: the kit signs in ONLY
 * users resolveSsoUser() returns; it never provisions accounts from SSO.
 * The session callback stamps session.user.organizationId, which the tenant
 * layer (lib/tenant/request.ts) feeds into withOrg() to set app.current_org.
 *
 * Node runtime (resolveSsoUser uses pg). Edge middleware lives in proxy.ts.
 */
import NextAuth from 'next-auth';
import { createAuthKitConfig } from '@/src/auth-kit';
import { resolveSsoUser, onSsoDenied } from '@/lib/auth/resolve-sso-user';

// Gate providers on their env pairs so an environment without OAuth creds
// simply doesn't offer that provider (per the kit's consumer notes).
const googleReady = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
const microsoftReady = !!(
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET
);

/**
 * VX5-5 — the session cookie has to reach the tenant subdomains.
 *
 * MEASURED, not assumed. A cookie with no `Domain` is HOST-ONLY: signing in at
 * `veloexpense.app` and then opening `acme.veloexpense.app` sends no cookie at
 * all, and `proxy.ts` bounces you to `/login` in a loop. A Playwright probe
 * against `demo.localhost:3000` reproduced exactly that — the subdomain
 * redirected to `/login` while the apex rendered.
 *
 * So the cookie is scoped to the apex when `AUTH_COOKIE_DOMAIN` says so, and
 * left host-only when it does not. Two consequences worth stating rather than
 * discovering:
 *
 *   1. A cookie scoped to `.veloexpense.app` IS SENT TO EVERY TENANT SUBDOMAIN.
 *      That is the point, and it is only safe because the session — not the host
 *      — decides which tenant is read, and a host that disagrees is refused
 *      before any row (`lib/tenant/request.ts`). Without that refusal this
 *      setting would be the hole.
 *   2. It is UNSET in development and in the e2e's default origin, because
 *      browsers will not scope a cookie to `localhost`. That is why the
 *      host-tenancy spec runs against its own resolvable domain.
 *
 * Applied by spreading the vendored kit's config rather than editing it:
 * `src/auth-kit/` is pinned (VENDORED.md) and a local edit there is a change
 * that silently disappears at the next sync.
 */
const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;

/**
 * Secure cookies follow the ORIGIN'S SCHEME, not `NODE_ENV`.
 *
 * The first version used `NODE_ENV === 'production'` and the e2e caught it
 * immediately: the standalone build runs with `NODE_ENV=production` and serves
 * plain http, so it named the cookie `__Secure-authjs.session-token` and marked
 * it secure — and a `__Secure-` cookie over http is dropped by the browser and
 * cannot be read back by a `Set-Cookie` either way. Every request arrived with no
 * session and the app said `unauthenticated`, which is a long way from the cause.
 *
 * That is not a test-only problem. A self-hosted deployment behind plain http on
 * an internal network would have had exactly the same silent sign-out. NextAuth's
 * own inference reads the scheme of `AUTH_URL`, which is the fact that actually
 * decides whether a secure cookie can work, and this mirrors it. The cookie name
 * matters twice over: Auth.js derives the JWE salt from it, so getting it wrong
 * produces a session nobody can decode rather than an error anybody can read.
 */
const secureCookies = /^https:/i.test(
  (process.env.AUTH_URL || process.env.APP_URL || process.env.NEXTAUTH_URL || '').trim(),
);

const base = createAuthKitConfig({
  productKey: 'veloexpense', // namespaces the org-slug SSO cookie
  providers: { google: googleReady, microsoft: microsoftReady },
  // AUTHKITSYNC-VE-1: NO `microsoftDirectoryBinding`. auth-kit v0.3 therefore
  // registers no Microsoft provider here even when the suite-wide Entra env
  // vars are present (microsoftReady), and refuses any Microsoft callback.
  // resolveSsoUser accepts invitations on the email, which Microsoft does not
  // verify; offering Microsoft first needs the directory + object-id binding
  // described in lib-auth-kit's README (VeloPulse SSOTENANT-1 is the reference).
  resolveSsoUser,
  onSsoDenied,
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...base,
  ...(cookieDomain === undefined
    ? {}
    : {
        cookies: {
          sessionToken: {
            // The unprefixed name on http and the `__Secure-` one on https, which
            // is what `proxy.ts` already checks for and what `e2e/auth.setup.ts`
            // uses as the JWE salt. Getting this wrong does not fail loudly — it
            // produces a session nobody can decode.
            name: secureCookies ? '__Secure-authjs.session-token' : 'authjs.session-token',
            options: {
              domain: cookieDomain,
              httpOnly: true,
              sameSite: 'lax',
              path: '/',
              secure: secureCookies,
            },
          },
        },
      }),
});

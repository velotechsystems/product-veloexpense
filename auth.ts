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

export const { handlers, auth, signIn, signOut } = NextAuth(
  createAuthKitConfig({
    productKey: 'veloexpense', // namespaces the org-slug SSO cookie
    providers: { google: googleReady, microsoft: microsoftReady },
    resolveSsoUser,
    onSsoDenied,
  }),
);

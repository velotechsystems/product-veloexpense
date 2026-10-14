/**
 * The NextAuth v5 config factory — the heart of the kit.
 *
 * EDGE-SAFE BY DESIGN: this module imports no Node-only code (no bcrypt, no
 * Prisma), so the returned config belongs in each app's `auth.config.ts` and
 * can run in middleware. Credentials/password auth stays app-side in
 * `auth.ts` (Node runtime) and is spread alongside — that split is exactly
 * the fix for VeloPulse issue #37.
 *
 * Flow per SSO sign-in:
 *  1. Login page stores the org slug cookie (org-cookie.ts) and calls
 *     signIn('google' | 'microsoft-entra-id').
 *  2. Provider round-trips; `signIn` callback fires with the verified profile.
 *  3. The kit builds an SsoIdentity from the validated ID-token claims
 *     (sso-identity.ts) and refuses what cannot be one; then the app's
 *     resolveSsoUser(orgSlug, identity) is consulted — INVITE-ONLY: a denial →
 *     refused, and onSsoDenied fires with the reason for the audit trail.
 *
 * v0.3 (upstreamed from VeloPulse SSOTENANT-1 / SSOAUDIT-1): Microsoft is off
 * unless the app declares `microsoftDirectoryBinding` (types.ts says why).
 *  4. jwt/session callbacks stamp the standardized VeloTech claims
 *     { orgId, role, subjectId } so SSO and credentials sessions look identical.
 */

import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import type { NextAuthConfig } from 'next-auth';
import type { AuthKitOptions, ResolvedUser } from './types';
import { readOrgSlug } from './org-cookie';
import { GOOGLE_ID, MICROSOFT_ID, ssoIdentityFrom } from './sso-identity';

export const MICROSOFT_PROVIDER_ID = MICROSOFT_ID;
export const GOOGLE_PROVIDER_ID = GOOGLE_ID;

/** Whether Microsoft is actually offered: asked for AND the app binds the directory. */
export function microsoftEnabled(options: Pick<AuthKitOptions, 'providers' | 'microsoftDirectoryBinding'>): boolean {
  return options.providers.microsoft && options.microsoftDirectoryBinding === true;
}

export function createAuthKitConfig(options: AuthKitOptions): NextAuthConfig {
  const providers: NextAuthConfig['providers'] = [];
  if (options.providers.google) {
    providers.push(Google({ allowDangerousEmailAccountLinking: false }));
  }
  if (microsoftEnabled(options)) {
    providers.push(MicrosoftEntraID({ allowDangerousEmailAccountLinking: false }));
  } else if (options.providers.microsoft) {
    console.warn(
      `[auth-kit] ${options.productKey}: Microsoft sign-in is configured but not offered — ` +
        'set microsoftDirectoryBinding once resolveSsoUser binds the Entra directory and object id.',
    );
  }

  return {
    providers,
    session: { strategy: 'jwt' },
    callbacks: {
      async signIn({ user, account, profile }) {
        // Credentials flow is validated app-side in authorize(); pass through.
        if (!account || account.provider === 'credentials') return true;
        const provider = account.provider;

        // Org slug from the pre-redirect cookie (10-min TTL).
        const { cookies } = await import('next/headers');
        const jar = await cookies();
        const cookieHeader = jar
          .getAll()
          .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
          .join('; ');
        const orgSlug = readOrgSlug(options.productKey, cookieHeader);
        if (!orgSlug) {
          // The cookie expired (the round trip took longer than its TTL) or
          // never existed. Audited on no org so it can be correlated with the
          // login page's timeout message. Expired and missing look the same.
          await options.onSsoDenied?.({ orgSlug: null, provider, reason: 'org_cookie_missing' });
          return false;
        }

        // Belt and braces: the provider is not registered without the binding,
        // so this only fires if an app registers Entra itself.
        if (provider === MICROSOFT_ID && options.microsoftDirectoryBinding !== true) {
          await options.onSsoDenied?.({ orgSlug, provider, reason: 'entra_not_configured' });
          return false;
        }

        // An identity, not just an email (see sso-identity.ts).
        const built = ssoIdentityFrom(provider, profile as Record<string, unknown> | undefined, user.email);
        if (!built.ok) {
          await options.onSsoDenied?.({ orgSlug, provider, reason: built.reason });
          return false;
        }

        const resolved = await options.resolveSsoUser(orgSlug, built.identity);
        if ('denied' in resolved) {
          const id = built.identity;
          await options.onSsoDenied?.({
            orgSlug,
            provider,
            reason: resolved.denied,
            ...(resolved.userId ? { userId: resolved.userId } : {}),
            // Only an address the provider verified; never Microsoft's claim.
            ...(id.emailVerified === true ? { verifiedEmail: id.email } : {}),
          });
          return false;
        }

        // Stash resolved claims on the user object for the jwt callback.
        Object.assign(user, {
          id: resolved.userId,
          organizationId: resolved.orgId,
          role: resolved.role,
          subjectId: resolved.subjectId,
        });
        return true;
      },

      async jwt({ token, user }) {
        if (user) {
          const u = user as typeof user & {
            organizationId?: string;
            role?: string;
            subjectId?: string | null;
            employeeId?: string | null;
          };
          token.orgId = u.organizationId ?? token.orgId;
          token.role = u.role ?? token.role;
          token.subjectId = u.subjectId ?? u.employeeId ?? token.subjectId ?? null;
        }
        return token;
      },

      async session({ session, token }) {
        const s = session as typeof session & {
          user: typeof session.user & {
            organizationId?: string;
            role?: string;
            employeeId?: string | null;
          };
        };
        if (s.user) {
          s.user.organizationId = token.orgId as string;
          s.user.role = token.role as string;
          // Kept as employeeId for VeloPulse back-compat; VeloCRM maps contactId.
          s.user.employeeId = (token.subjectId as string | null) ?? null;
        }
        return session;
      },
    },
  };
}

/** Convenience: the resolved-user shape apps return from resolveSsoUser. */
export type { ResolvedUser };

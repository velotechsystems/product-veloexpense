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
 *  3. The app's resolveSsoUser(orgSlug, email) is consulted — INVITE-ONLY:
 *     null → denied (and onSsoDenied fires for the audit trail).
 *  4. jwt/session callbacks stamp the standardized VeloTech claims
 *     { orgId, role, subjectId } so SSO and credentials sessions look identical.
 */

import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import type { NextAuthConfig } from 'next-auth';
import type { AuthKitOptions, ResolvedUser } from './types';
import { readOrgSlug } from './org-cookie';

export const MICROSOFT_PROVIDER_ID = 'microsoft-entra-id';
export const GOOGLE_PROVIDER_ID = 'google';

export function createAuthKitConfig(options: AuthKitOptions): NextAuthConfig {
  const providers: NextAuthConfig['providers'] = [];
  if (options.providers.google) {
    providers.push(Google({ allowDangerousEmailAccountLinking: false }));
  }
  if (options.providers.microsoft) {
    providers.push(MicrosoftEntraID({ allowDangerousEmailAccountLinking: false }));
  }

  return {
    providers,
    session: { strategy: 'jwt' },
    callbacks: {
      async signIn({ user, account }) {
        // Credentials flow is validated app-side in authorize(); pass through.
        if (!account || account.provider === 'credentials') return true;

        const email = user.email?.trim().toLowerCase();
        if (!email) return false;

        // Org slug from the pre-redirect cookie (10-min TTL).
        const { cookies } = await import('next/headers');
        const jar = await cookies();
        const cookieHeader = jar
          .getAll()
          .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
          .join('; ');
        const orgSlug = readOrgSlug(options.productKey, cookieHeader);
        if (!orgSlug) return false;

        const resolved = await options.resolveSsoUser(orgSlug, email);
        if (!resolved) {
          await options.onSsoDenied?.(orgSlug, email, account.provider);
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

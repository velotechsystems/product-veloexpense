/**
 * Invite-only SSO resolver. Given the org slug (from the pre-redirect cookie)
 * and the verified email, return the existing user or null (null = denied).
 *
 * Runs BEFORE tenant context exists and matches across the org boundary by
 * slug, so it uses the service-role path (withoutOrg) — a sanctioned
 * cross-tenant read. Phase 0 returns role='member'/subjectId=null; real roles
 * land when RBAC is ported.
 */
import { withoutOrg } from '@/lib/tenant/context';
import type { ResolvedUser } from '@/src/auth-kit';

export async function resolveSsoUser(orgSlug: string, email: string): Promise<ResolvedUser | null> {
  return withoutOrg(async (tx) => {
    const r = await tx.query(
      `SELECT u.id AS "userId", u.organization_id AS "orgId", u.email
         FROM app_user u
         JOIN organization o ON o.id = u.organization_id
        WHERE o.slug = $1
          AND lower(u.email) = lower($2)
          AND o.status = 'active'
        LIMIT 1`,
      [orgSlug, email],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as { userId: string; orgId: string; email: string };
    return { userId: row.userId, orgId: row.orgId, email: row.email, role: 'member', subjectId: null };
  });
}

export async function onSsoDenied(orgSlug: string, email: string, provider: string): Promise<void> {
  // TODO: route to the tenant-scoped audit log (Phase 2).
  console.warn('[auth] SSO denied', { orgSlug, email, provider });
}

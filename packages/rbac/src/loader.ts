import type { Prisma, PrismaClient } from '@expenseos/db';
import { getRolePermissions } from './cache';
import { isPermission, type Permission } from './permissions';
import type { RbacUser } from './types';

/**
 * Resolve the RbacUser for a given session. Reads the Role row through
 * the Redis cache layer in @expenseos/rbac/cache so the hot path is
 * one Redis GET per request.
 *
 * `roleLabel` is the locale-resolved Role.label snapshot — populated
 * once at sign-in, reused on every request. We don't re-resolve per
 * request because the label rarely changes; admins who edit a role
 * label can trigger a session refresh by signing out + back in.
 *
 * VeloExpense (w4-10a, d73): ExpenseOS's loader. The role is the TENANT's row (0068), so the
 * session names its organization, the row is read by (organization, id), and the cache is
 * keyed by both (see cache.ts). `db` is the caller's tenant transaction, whose RLS confines
 * the read to that organization anyway. VeloExpense reads the role id from the database on
 * every request rather than the token (server/trpc.ts), and so its label too.
 */
export async function resolveRbacUser(
  db: PrismaClient | Prisma.TransactionClient,
  session: { userId: string; roleId: string; roleLabel: string; organizationId: string },
): Promise<RbacUser> {
  const raw = await getRolePermissions(session.organizationId, session.roleId, async () => {
    const role = await db.role.findUnique({
      where: { organizationId_id: { organizationId: session.organizationId, id: session.roleId } },
      select: { permissions: true, active: true },
    });
    if (!role?.active) {
      // Role was deleted or deactivated between sign-in and request.
      // Return an empty list — the caller's permission checks will
      // fail and the session will be effectively read-only until the
      // user signs back in.
      return [];
    }
    return role.permissions;
  });

  // Filter out any non-registered permission strings (in case Role
  // rows hold stale codes after a registry rename).
  const permissions = raw.filter(isPermission) as Permission[];

  return {
    id: session.userId,
    roleId: session.roleId,
    roleLabel: session.roleLabel,
    permissions,
  };
}

import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleKind } from './systemRoles';
import { isPermission, type Permission } from './permissions';
import type { RbacUser } from './types';

/**
 * VeloExpense's `resolveRbacUser` — same signature as ExpenseOS's, different source.
 *
 * ExpenseOS reads `Role.permissions` from its `Role` table through a Redis cache. VeloExpense
 * has neither yet: its people carry one of three fixed roles on `app_user.role`, and the role
 * builder that brings editable roles arrives with Wave 4. Until then a `roleId` here is always
 * one of ExpenseOS's SYSTEM role ids, and its permissions are that system role's
 * `SYSTEM_ROLE_PERMISSIONS` — the seed values an ExpenseOS tenant starts with.
 *
 * Which system role a VeloExpense role maps to is `systemRoleFor` below, and the tRPC context
 * (server/trpc.ts) is the one caller that applies it, after reading the role from the
 * DATABASE (VeloExpense's rule: never from the session token).
 *
 * The `db` argument is kept so ported call sites — `resolveRbacUser(db, {...})` — compile
 * unchanged. It is unused until roles are rows.
 */
export async function resolveRbacUser(
  _db: unknown,
  session: { userId: string; roleId: string; roleLabel: string },
): Promise<RbacUser> {
  const kind = (Object.keys(SYSTEM_ROLE_IDS) as SystemRoleKind[]).find(
    (k) => SYSTEM_ROLE_IDS[k] === session.roleId,
  );
  // An id that is not a system role grants nothing, as ExpenseOS's loader does for a role
  // that was deleted or deactivated between sign-in and request.
  const raw: readonly string[] = kind ? SYSTEM_ROLE_PERMISSIONS[kind] : [];
  const permissions = raw.filter(isPermission) as Permission[];
  return {
    id: session.userId,
    roleId: session.roleId,
    roleLabel: session.roleLabel,
    permissions,
  };
}

/** VeloExpense's three roles (`app_user.role`). */
export type VeloExpenseRole = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';

/**
 * The ExpenseOS system role a VeloExpense role stands in for, until Wave 4's role builder.
 *
 *   ADMIN    -> admin     (System Administrator)
 *   MANAGER  -> employee  ExpenseOS folded Manager into Employee: Employee grants a strict
 *                         superset of what Manager did (RETIRED_ROLE_IDS.manager), and
 *                         approving is decided by the workflow, not by the role.
 *   EMPLOYEE -> employee
 */
export function systemRoleFor(role: VeloExpenseRole): SystemRoleKind {
  return role === 'ADMIN' ? 'admin' : 'employee';
}

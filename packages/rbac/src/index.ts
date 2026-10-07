/**
 * @expenseos/rbac — client-safe entry point. Exports the typed
 * permission registry, the `can` / `require` pure helpers, the role
 * types, and the system-role constants. NO ioredis, no DB, no Node
 * built-ins — safe to import from client components, edge runtime,
 * and worker code alike.
 *
 * Server-only helpers (Redis-cached lookup, the resolveRbacUser
 * loader, cache-invalidation primitives) live in `@expenseos/rbac/server`.
 *
 * Usage from a client component (Sidebar nav-gating):
 *
 *   import { can, permissions as P } from '@expenseos/rbac';
 *   const visible = items.filter((i) => !i.requires || can(rbac, i.requires));
 *
 * Usage from a server component / tRPC procedure:
 *
 *   import { resolveRbacUser } from '@expenseos/rbac/server';
 *   const rbac = await resolveRbacUser(db, { ... });
 *
 *   import { require, permissions as P } from '@expenseos/rbac';
 *   require(rbac, P.expense.report.approve);
 */

export { can, require } from './can';
export {
  ALL_PERMISSIONS,
  isPermission,
  type Permission,
  permissions,
} from './permissions';
export {
  RETIRED_ROLE_IDS,
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_KINDS,
  SYSTEM_ROLE_LABELS,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRoleKind,
} from './systemRoles';
export { ForbiddenError, type RbacUser } from './types';

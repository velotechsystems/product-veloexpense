import type { Permission } from './permissions';
import { ForbiddenError, type RbacUser } from './types';

/**
 * Pure permission check. Use this when you can branch UI / behavior on
 * the absence of a permission (e.g., hiding a sidebar item, rendering
 * a button as disabled).
 */
export function can(user: RbacUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

/**
 * Throwing check. Use this at tRPC procedure entry points and other
 * places where missing the permission is a programming-or-policy error
 * rather than a UI affordance. Throws `ForbiddenError`; tRPC middleware
 * translates that to `TRPCError({ code: 'FORBIDDEN' })`.
 */
export function require(user: RbacUser, permission: Permission): void {
  if (!can(user, permission)) {
    throw new ForbiddenError(permission);
  }
}

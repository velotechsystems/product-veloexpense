import type { Permission } from './permissions';

/**
 * Minimal user shape required for permission checks. Built from the
 * NextAuth session + the cached Role.permissions array. Deliberately
 * narrow — adding more fields here would let app code reach for
 * non-RBAC attributes (department, employeeId) inside permission
 * checks, which is what got us hardcoded role-tuples in the first
 * place.
 */
export interface RbacUser {
  id: string;
  roleId: string;
  /** Locale-resolved role label snapshot — what we record on Audit
   *  rows + show in the profile chrome. NOT a stable identifier;
   *  use `roleId` for permission lookups + RBAC checks. */
  roleLabel: string;
  permissions: readonly Permission[];
}

export class ForbiddenError extends Error {
  readonly missing: Permission;
  constructor(missing: Permission) {
    super(`Missing permission: ${missing}`);
    this.name = 'ForbiddenError';
    this.missing = missing;
  }
}

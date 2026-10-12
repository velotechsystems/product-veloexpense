/**
 * VeloExpense (w4-00c): which of VeloExpense's text roles stand for an ExpenseOS system role.
 *
 * ExpenseOS names a role by its `Role` row id, and the ported approval code asks "who holds
 * role X" with `where: { roleId }`. VeloExpense's people carry a text role (0004) that the
 * tRPC context maps to a system role (`systemRoleFor`: ADMIN → admin, EMPLOYEE and MANAGER →
 * employee). This is the inverse of that map, for those `where` clauses, until the role
 * builder (w4-10) makes roles rows. An id that is no system role VeloExpense maps to names
 * nobody, as an unknown `roleId` would in ExpenseOS.
 */
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';

export function rolesStandingFor(systemRoleId: string): string[] {
  if (systemRoleId === SYSTEM_ROLE_IDS.admin) return ['ADMIN'];
  if (systemRoleId === SYSTEM_ROLE_IDS.employee) return ['EMPLOYEE', 'MANAGER'];
  return [];
}

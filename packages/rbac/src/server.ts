/**
 * @expenseos/rbac/server — server-only surface.
 *
 * VeloExpense: ExpenseOS re-exports its Redis cache and Role-table loader here. VeloExpense
 * has no Role table yet (Wave 4), so this exports the loader that maps its three fixed roles
 * onto ExpenseOS's system roles instead (see loader.ts). The import path and the
 * `resolveRbacUser` signature are ExpenseOS's, so ported pages and procedures are unchanged.
 */
export { resolveRbacUser, systemRoleFor, type VeloExpenseRole } from './loader';

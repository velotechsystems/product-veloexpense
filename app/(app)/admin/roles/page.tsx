import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { RoleBuilder } from './RoleBuilder';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.roles');
}

/**
 * /admin/roles — Role Builder. Lists every role with user-count and
 * permissions-count badges; opens an editor with a module-grouped
 * permission picker.
 *
 * Ported from ExpenseOS (1e682dd6) with the `roles` router (w4-10c, d74). VeloExpense: the
 * session and `RbacUser` come from the request's shell context (server/shell.ts) rather than
 * `auth()` plus `resolveRbacUser(db, …)`, and a reader without `admin.role.list` is REFUSED
 * (`forbidden()`, a 403 that says why) where ExpenseOS answers 404, as every VeloExpense admin
 * screen does. Roles are per tenant (d73): everything here is the reader's tenant's roles.
 */
export default async function RolesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.admin.role.list)) forbidden();
  const canWrite =
    rbac.permissions.includes(P.admin.role.create) ||
    rbac.permissions.includes(P.admin.role.update);
  const canDelete = rbac.permissions.includes(P.admin.role.delete);
  return <RoleBuilder canWrite={canWrite} canDelete={canDelete} />;
}

import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { PolicyViolationsAdmin } from './PolicyViolationsAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.policy.violations');
}

/**
 * /admin/policy-violations — the org-wide policy-violation register (exceptions
 * view). Under the expense-management module; read requires `config.policy.read`,
 * acknowledging (resolve) requires `config.policy.update`.
 *
 * Ported from ExpenseOS (550b2945) with `policyRule.violations` and `resolveViolation`
 * (w4-02e, d63). VeloExpense: the session and `RbacUser` come from the request's shell
 * context (server/shell.ts) rather than `auth()` plus `resolveRbacUser(db, …)`, and a
 * reader without the permission is REFUSED (`forbidden()`, a 403 that says why) where
 * ExpenseOS answers 404, as every VeloExpense admin screen does. An inactive module is
 * still a 404.
 */
export default async function PolicyViolationsPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  return <PolicyViolationsAdmin canManage={rbac.permissions.includes(P.config.policyUpdate)} />;
}

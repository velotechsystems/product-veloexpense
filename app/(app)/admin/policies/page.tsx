import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { ExpensePoliciesAdmin } from './ExpensePoliciesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.policies');
}

/**
 * /admin/policies — per-category expense policy editor.
 * Read requires `config.policy.read`; edit requires `.update`.
 *
 * Ported from ExpenseOS (550b2945) with the `expensePolicy` router (w4-02c, d65). VeloExpense:
 * the session and `RbacUser` come from the request's shell context (server/shell.ts) rather
 * than `auth()` plus `resolveRbacUser(db, …)`; a reader without the permission is REFUSED
 * (`forbidden()`, a 403 that says why) where ExpenseOS answers 404, as every VeloExpense
 * admin screen does. As in ExpenseOS, the page checks no module; its menu entry sits under
 * Compliance & Audit. Since the cutover (w4-02d) these limits are enforced by ExpenseOS's
 * engine (server/policy), through its per-category kinds.
 */
export default async function ExpensePoliciesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  const canWrite = rbac.permissions.includes(P.config.policyUpdate);
  return <ExpensePoliciesAdmin canWrite={canWrite} />;
}

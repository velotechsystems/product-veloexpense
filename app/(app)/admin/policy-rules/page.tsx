import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { PolicyRulesAdmin } from './PolicyRulesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.policy.rules');
}

/**
 * /admin/policy-rules — author policy-engine v2 rule instances (Rule Builder).
 * Under the expense-management module; read requires `config.policy.read`,
 * write requires `config.policy.update`. Rules are data — no deploy needed to
 * add / scope / tune enforcement at submit time.
 *
 * Ported from ExpenseOS (550b2945) with the `policyRule` router (w4-02b, d63). VeloExpense:
 * the session and `RbacUser` come from the request's shell context (server/shell.ts) rather
 * than `auth()` plus `resolveRbacUser(db, …)`, and a reader without the permission is
 * REFUSED (`forbidden()`, a 403 that says why) where ExpenseOS answers 404, as every
 * VeloExpense admin screen does. An inactive module is still a 404. Until the cutover
 * (w4-02c) the rules written here are stored, not enforced: lib/policy still checks.
 */
export default async function PolicyRulesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  return <PolicyRulesAdmin canManage={rbac.permissions.includes(P.config.policyUpdate)} />;
}

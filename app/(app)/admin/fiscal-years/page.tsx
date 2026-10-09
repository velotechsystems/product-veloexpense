import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { FiscalYearsAdmin } from './FiscalYearsAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.fiscal.years');
}

/**
 * /admin/fiscal-years — manage reporting periods.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) — the same resolution the tRPC `tenant`
 * middleware makes — rather than `auth()` plus `resolveRbacUser(db, …)`. And a reader
 * without the permission is REFUSED (`forbidden()`: app/forbidden.tsx, a 403 that says
 * why), as every VeloExpense admin screen refuses (lib/auth/admin-guard.ts, decided
 * 4 Sep), where ExpenseOS answers 404.
 */
export default async function FiscalYearsPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  const canEdit = rbac.permissions.includes(P.config.fiscalYearUpdate);
  return <FiscalYearsAdmin canEdit={canEdit} />;
}

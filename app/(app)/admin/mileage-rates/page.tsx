import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { MileageRatesAdmin } from './MileageRatesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.mileage.rates');
}

/**
 * /admin/mileage-rates — per-country mileage reimbursement rates (A7).
 *
 * Reading rides on the same `config.policyRead` as the other reference-data
 * pages; editing needs `config.mileageUpdate`. Module-gated on
 * expense-management, like per-diem and FX rates — a mileage rate is
 * meaningless without expense reports.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) — the same resolution the tRPC `tenant`
 * middleware makes — rather than `auth()` plus `resolveRbacUser(db, …)`. And a reader
 * without the permission is REFUSED (`forbidden()`: app/forbidden.tsx, a 403 that says
 * why), as every VeloExpense admin screen refuses (lib/auth/admin-guard.ts, decided
 * 4 Sep), where ExpenseOS answers 404. An inactive module is still a 404, as in ExpenseOS.
 */
export default async function MileageRatesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  return <MileageRatesAdmin canEdit={rbac.permissions.includes(P.config.mileageUpdate)} />;
}

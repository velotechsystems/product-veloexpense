import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { PerDiemRatesAdmin } from './PerDiemRatesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.per.diem.rates');
}

/**
 * /admin/per-diem-rates — manage per-diem lodging + meals allowances. Under the
 * expense-management module; read requires `config.policy.read`, write requires
 * `config.perDiem.update`. Feeds the approval engine's per-diem condition.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) — the same resolution the tRPC `tenant`
 * middleware makes — rather than `auth()` plus `resolveRbacUser(db, …)`. And a reader
 * without the permission is REFUSED (`forbidden()`: app/forbidden.tsx, a 403 that says
 * why), as every VeloExpense admin screen refuses (lib/auth/admin-guard.ts, decided
 * 4 Sep), where ExpenseOS answers 404. An inactive module is still a 404, as in ExpenseOS.
 */
export default async function PerDiemRatesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  return <PerDiemRatesAdmin canManage={rbac.permissions.includes(P.config.perDiemUpdate)} />;
}

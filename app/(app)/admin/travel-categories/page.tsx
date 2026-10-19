import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { TravelCategoriesAdmin } from './TravelCategoriesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.travel.categories');
}

/**
 * /admin/travel-categories — the taxonomy a trip is planned against: label, icon,
 * pill color, the editor block each one opens (`lineKind`), the expense category it
 * maps to for reporting, and an optional GL account override.
 *
 * Gated on the TRAVEL module, not expense management. The two taxonomies have
 * different audiences — an accountant curates the chart of accounts, whoever owns the
 * travel policy curates what a trip can be planned against — and an org running
 * travel without expenses still needs this page.
 *
 * Ported from ExpenseOS (1e682dd6). VeloExpense (w6-02): the session and `RbacUser` come
 * from the request's shell context (server/shell.ts), and a reader without the permission
 * is refused (`forbidden()`), as every VeloExpense admin screen refuses, where ExpenseOS
 * answers 404. An inactive module is still a 404, as in ExpenseOS.
 */
export default async function TravelCategoriesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('travel');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.admin.travelCategory.list)) forbidden();
  const canWrite =
    rbac.permissions.includes(P.admin.travelCategory.create) ||
    rbac.permissions.includes(P.admin.travelCategory.update);
  return <TravelCategoriesAdmin canWrite={canWrite} />;
}

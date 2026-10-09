import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { FxRatesAdmin } from './FxRatesAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.fx.rates');
}

/**
 * /admin/fx-rates — currency-pair exchange rates that feed the policy engine's
 * currency conversion (per-transaction limits across currencies). Under the
 * expense-management module; read requires `config.policy.read`, add requires
 * `config.fxRate.update`. Append-only: the latest row per pair wins.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) — the same resolution the tRPC `tenant`
 * middleware makes — rather than `auth()` plus `resolveRbacUser(db, …)`. And a reader
 * without the permission is REFUSED (`forbidden()`: app/forbidden.tsx, a 403 that says
 * why), as every VeloExpense admin screen refuses (lib/auth/admin-guard.ts, decided
 * 4 Sep), where ExpenseOS answers 404. An inactive module is still a 404, as in ExpenseOS.
 * The rates are the tenant's own (0051, d18).
 */
export default async function FxRatesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.config.policyRead)) forbidden();
  return <FxRatesAdmin canManage={rbac.permissions.includes(P.config.fxRateUpdate)} />;
}

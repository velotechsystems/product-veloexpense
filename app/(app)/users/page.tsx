import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { withTenantDb } from '@/lib/db/prisma';
import { pageTitle } from '@/lib/i18n/page-title';
import type { DirectoryScope } from '@/server/lib/userScope';
import { shellContext } from '@/server/shell';
import { EmployeeDirectory } from './EmployeeDirectory';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.people');
}

/**
 * /users — directory of people the caller is allowed to see.
 *
 * Open to every signed-in user; what they see is scoped server-side
 * by their permissions and reporting chain. Admins (P.user.readAll)
 * default to "All employees"; managers default to "My direct reports";
 * users with no reports default to "Just me".
 *
 * The available scope chips are computed here so the client can render
 * the toolbar without a second permission round-trip.
 *
 * Ported from ExpenseOS (1e682dd6), People 3. VeloExpense: the session and `RbacUser` come
 * from the request's shell context (server/shell.ts) rather than `auth()` plus
 * `resolveRbacUser`, and the report count is read in the reader's tenant; a reader with no
 * shell (signed out, or not a member here) is refused (`forbidden()`) where ExpenseOS answers
 * 404, as every VeloExpense screen does. NetSuite (Wave 5) and virtual cards (out of scope)
 * are off, so their column, their review link and the drawer's card section stay hidden.
 */
export default async function PeoplePage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { rbac, user } = shell;

  const isAdmin = rbac.permissions.includes(P.user.readAll);
  const canSetRole = rbac.permissions.includes(P.user.setRole);
  const canEdit = rbac.permissions.includes(P.user.update);
  const reportCount = await withTenantDb(user.organizationId, (tx) =>
    tx.user.count({ where: { managerId: rbac.id, deletedAt: null } }),
  );
  const hasReports = reportCount > 0;

  // Available scopes shown as chips:
  //   - admins: All / Direct / My team
  //   - managers: Direct / My team
  //   - employees with no reports: nothing (sidebar already hides
  //     /users from them; if they hit the URL manually they get an
  //     empty table — which is fine).
  const availableScopes: DirectoryScope[] = isAdmin
    ? ['all', 'direct', 'chain']
    : hasReports
      ? ['direct', 'chain']
      : ['direct'];

  const defaultScope: DirectoryScope = isAdmin ? 'all' : 'direct';

  return (
    <EmployeeDirectory
      availableScopes={availableScopes}
      defaultScope={defaultScope}
      isAdmin={isAdmin}
      canSetRole={canSetRole}
      canEdit={canEdit}
      // VeloExpense: no NetSuite until Wave 5 (w5-03), no virtual cards (out of scope).
      netsuiteActive={false}
      vccActive={false}
      canReviewSync={false}
    />
  );
}

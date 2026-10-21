import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { VELOEXPENSE_ADMIN_PERMISSION } from '@/lib/auth/actor';
import { type TenantDb, withTenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { countLiveInvites } from '@/lib/invites/service';
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
  // VeloExpense: inviting needs VeloExpense's admin permission (the invite actions'
  // `asAdmin`), so Add user and the pending count are offered on that, not on `readAll`.
  const canInvite = (rbac.permissions as readonly string[]).includes(VELOEXPENSE_ADMIN_PERMISSION);
  const [reportCount, pendingInviteCount] = await withTenantDb(user.organizationId, async (tx) => [
    await tx.user.count({ where: { managerId: rbac.id, deletedAt: null } }),
    // Live only, counted as the list it links to lists them (lib/invites/service.ts).
    canInvite ? await countLiveInvites(queryRunnerOf(tx as TenantDb)) : 0,
  ]);
  // eos batch 3 (#589): carried-over mileage is shown to readers of the policy config.
  const canReadPolicies = (rbac.permissions as readonly string[]).includes(P.config.policyRead);
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
      // VeloExpense: no NetSuite until Wave 5 (w5-03), so no Class column and no sync-review
      // link (`syncReviewPath` unset); no virtual cards (out of scope).
      accountingClassActive={false}
      vccActive={false}
      canInvite={canInvite}
      pendingInviteCount={pendingInviteCount}
      canReadPolicies={canReadPolicies}
    />
  );
}

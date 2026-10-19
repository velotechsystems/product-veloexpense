import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { TravelRequests } from './TravelRequests';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.travel');
}

/**
 * /travel — travel requests: mine, the ones awaiting my decision, and my team's.
 *
 * Gated on the travel module AND on being able to create a request. Approvers hold
 * that permission too, so there is no separate approver gate; a user who can neither
 * request nor approve has nothing to see here.
 *
 * Ported from ExpenseOS (1e682dd6). VeloExpense (w6-02): the session and `RbacUser` come
 * from the request's shell context (server/shell.ts) rather than `auth()` plus
 * `resolveRbacUser(db, …)`, and a reader with no shell or no travel permission is refused
 * (`forbidden()`), as every VeloExpense screen refuses, where ExpenseOS answers 404. An
 * inactive module is still a 404, as in ExpenseOS.
 */
export default async function TravelPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('travel');
  const { rbac } = shell;
  if (
    !rbac.permissions.includes(P.travel.request.createOwn) &&
    !rbac.permissions.includes(P.travel.request.approve)
  ) {
    forbidden();
  }
  return <TravelRequests />;
}

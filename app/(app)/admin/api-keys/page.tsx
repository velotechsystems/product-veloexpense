import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { ApiKeyRequestsAdmin } from './ApiKeyRequestsAdmin';
import { PlatformApiKeys } from './PlatformApiKeys';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.api.keys');
}

/**
 * /admin/api-keys — platform API keys: minted here, and read back here.
 *
 * The mint form used to live on `/profile` behind a `kind` dropdown. It is here because a
 * platform key is a service account — it names a different subject on each request, so
 * within its scopes it can act as any active user — and that is not a control to offer one
 * dropdown away from a personal token on everybody's profile page.
 *
 * The gate is a DISJUNCTION, and each half mounts its own half of the page:
 *
 *   · `admin.apiKey.create` mints. Whoever may create a service account has to be able to
 *     reach the only screen that creates one; gating the whole route on `list` alone 404'd
 *     a `create`-only holder out of their own control.
 *   · `admin.apiKey.list` reads the request log. Somebody who can see which service
 *     accounts exist is the same person who needs to see what they did.
 *
 * Neither branch grants anything: `apiKeys.create` sits behind `withPermission` and the log
 * query re-checks `list`. This only decides what is worth rendering.
 *
 * `Sidebar.tsx` names the same disjunction on its `apiManagement` item, deliberately — a
 * page somebody can open by URL with no menu entry pointing at it is the `/expenses/all`
 * defect the sidebar's own `requires` doc describes.
 *
 * Ported from ExpenseOS (1e682dd6), w6-04 (d88). VeloExpense: the session and `RbacUser` come
 * from the request's shell context (server/shell.ts), and a reader with neither permission is
 * refused (`forbidden()`), as every VeloExpense admin screen refuses, where ExpenseOS answers
 * 404. A platform key here is this company's: `api_key` is per tenant (0079).
 */
export default async function ApiKeysAdminPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const canCreate = shell.rbac.permissions.includes(P.admin.apiKey.create);
  const canList = shell.rbac.permissions.includes(P.admin.apiKey.list);
  if (!canCreate && !canList) forbidden();
  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      {canCreate && <PlatformApiKeys />}
      {canList && <ApiKeyRequestsAdmin />}
    </div>
  );
}

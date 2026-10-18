import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { shellContext } from '@/server/shell';
import { AuditTrail } from './AuditTrail';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.audit.trail');
}

/**
 * /admin/audit-trail — the hash-chained audit log (Module 12).
 *
 * Read requires `audit.read`; running an integrity verification requires
 * `audit.chain.verify`; changing retention requires `admin.appSettings.update`.
 * The three are separate because they're separate acts: reading the log,
 * attesting to it, and deciding how long it lives.
 *
 * w5-06 — ported from ExpenseOS (1e682dd6). VeloExpense: the session and `RbacUser` come from
 * the request's shell context (server/shell.ts), and a reader without the permission is
 * REFUSED (`forbidden()`, a 403 that says why) where ExpenseOS answers 404 — as every ported
 * admin screen. Retention is the tenant's own (w5-07, d82).
 */
export default async function AuditTrailPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.audit.read)) forbidden();
  return (
    <AuditTrail
      canVerify={rbac.permissions.includes(P.audit.chainVerify)}
      canConfigure={rbac.permissions.includes(P.admin.appSettings.update)}
    />
  );
}

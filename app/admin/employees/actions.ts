'use server';
/**
 * VX1-2 — employee/org server actions (Module 2).
 *
 * Same pattern as app/expenses/actions.ts: thin 'use server' wrappers that
 * resolve the session, open withCurrentOrg() so app.current_org / RLS are set,
 * and delegate to lib/employees/service.
 *
 * Authorization: the directory is ADMIN-only. The acting user's role is read
 * from app_user INSIDE the tenant transaction — never from the session token —
 * so a stale or forged claim cannot grant access.
 *
 * VX5-3 removed `getMyDirectReports` and `getMyManagerChain`. They were exported
 * from a `'use server'` module with no call site anywhere in the tree, which
 * makes them live HTTP endpoints reachable by anyone who can guess an action id
 * rather than dead code. No leak — both returned only the caller's own reporting
 * tree — but an endpoint nothing calls is an endpoint nobody is maintaining, and
 * they were boarded as a loose end from #97. Whatever screen wanted them can
 * declare them again when it exists.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as svc from '@/lib/employees/service';
import * as invites from '@/lib/invites/service';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { auditActorOf } from '@/lib/audit/service';

/* ── reads ─────────────────────────────────────────────────────────────────── */

export async function listEmployees(filter: svc.EmployeeListFilter = {}) {
  return asAdminPage((tx) => svc.listEmployees(tx, filter));
}

export async function getEmployee(employeeId: string) {
  return asAdminPage((tx) => svc.getEmployee(tx, employeeId));
}

/** Employee detail for the admin page: the record, its chain and its reports. */
export async function getEmployeeDetail(employeeId: string) {
  return asAdminPage(async (tx) => {
    const employee = await svc.getEmployee(tx, employeeId);
    if (!employee) return null;
    const managerChain = await svc.getManagerChain(tx, employeeId);
    const directReports = await svc.getDirectReports(tx, employeeId, { includeDeactivated: true });
    return { employee, managerChain, directReports };
  });
}

export async function getDirectoryOptions() {
  return asAdminPage((tx) => svc.getDirectoryOptions(tx));
}

/* ── writes (typed) ────────────────────────────────────────────────────────── */

/**
 * VX5-3 — `createEmployee` IS GONE, and its absence is the ticket.
 *
 * It wrote an `app_user` row from an admin form, and an `app_user` row is what
 * `resolveSsoUser` matches on — so that action WAS the grant of access, with no
 * email to the person and no record that they had never arrived. The product
 * said "invite-only" and meant it about the login page only.
 *
 * Inviting is now the only way in. The `app_user` row appears when somebody
 * accepts, which is what keeps the directory a list of people who are actually
 * here — and `app_user` is read by the manager picker, the reporting line and
 * every approval ladder.
 *
 * `svc.createEmployee` still exists and is still the one place that knows how to
 * make a member; `lib/invites/service.ts` calls it at acceptance. What is gone is
 * the path from an admin form to it.
 */
export async function inviteEmployee(input: invites.NewInvite) {
  return asAdmin((tx, actor) => invites.sendInvite(tx, auditActorOf(actor), input));
}

export async function revokeInvite(inviteId: string) {
  return asAdmin((tx, actor) => invites.revokeInvite(tx, auditActorOf(actor), inviteId));
}

export async function listLiveInvites() {
  return asAdminPage((tx) => invites.listLiveInvites(tx));
}

export async function updateEmployee(employeeId: string, patch: svc.EmployeePatch) {
  return asAdmin((tx) => svc.updateEmployee(tx, employeeId, patch));
}

export async function deactivateEmployee(
  employeeId: string,
  opts: { reassignReportsTo?: string | null } = {},
) {
  return asAdmin((tx, actor) =>
    svc.deactivateEmployee(tx, employeeId, { ...opts, actingEmployeeId: actor.id }),
  );
}

/* ── writes (progressive-enhancement form entry points) ────────────────────── */
// The admin pages are server components posting plain <form action={...}>, so
// these take FormData. Empty strings mean "cleared", which is why they map to
// null rather than being dropped.

function text(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function employeeFromForm(form: FormData): svc.EmployeePatch {
  return {
    email: text(form, 'email') ?? undefined,
    displayName: text(form, 'displayName'),
    title: text(form, 'title'),
    role: (text(form, 'role') as svc.EmployeeRole | null) ?? undefined,
    employeeStatus: (text(form, 'employeeStatus') as svc.EmployeeStatus | null) ?? undefined,
    managerId: text(form, 'managerId'),
    departmentId: text(form, 'departmentId'),
    businessUnitId: text(form, 'businessUnitId'),
    legalEntityId: text(form, 'legalEntityId'),
  };
}

/**
 * As `app/preferences/actions.ts`: a `redirect()` is a THROW, and a bare catch
 * around one swallows the navigation.
 */
function rethrowRedirect(err: unknown): void {
  if (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  ) {
    throw err;
  }
}

export async function inviteEmployeeFromForm(form: FormData): Promise<never> {
  const fields = employeeFromForm(form);
  let resent = false;
  try {
    const issued = await inviteEmployee({
      email: text(form, 'email') ?? '',
      role: fields.role ?? 'EMPLOYEE',
      displayName: fields.displayName,
      title: fields.title,
      managerId: fields.managerId,
      departmentId: fields.departmentId,
      businessUnitId: fields.businessUnitId,
      legalEntityId: fields.legalEntityId,
    });
    resent = issued.resent;
  } catch (err) {
    rethrowRedirect(err);
    redirect(`/admin/employees/invite?error=${encodeURIComponent(errorParam(err, 'invite'))}`);
  }
  revalidatePath('/admin/employees');
  redirect(`/admin/employees?invited=${resent ? 'again' : 'first'}`);
}

export async function revokeInviteFromForm(form: FormData): Promise<never> {
  const inviteId = text(form, 'inviteId');
  if (!inviteId) throw new Error('inviteId is required');
  try {
    await revokeInvite(inviteId);
  } catch (err) {
    rethrowRedirect(err);
    redirect(`/admin/employees?error=${encodeURIComponent(errorParam(err, 'invite-revoke'))}`);
  }
  revalidatePath('/admin/employees');
  redirect('/admin/employees?withdrawn=1');
}

export async function updateEmployeeFromForm(form: FormData) {
  const employeeId = text(form, 'employeeId');
  if (!employeeId) throw new Error('employeeId is required');
  await updateEmployee(employeeId, employeeFromForm(form));
  revalidatePath('/admin/employees');
  revalidatePath(`/admin/employees/${employeeId}`);
}

export async function deactivateEmployeeFromForm(form: FormData) {
  const employeeId = text(form, 'employeeId');
  if (!employeeId) throw new Error('employeeId is required');
  // Present-but-empty means "clear their manager"; absent means "refuse if the
  // employee still has direct reports" (the service decides).
  const opts = form.has('reassignReportsTo')
    ? { reassignReportsTo: text(form, 'reassignReportsTo') }
    : {};
  await deactivateEmployee(employeeId, opts);
  revalidatePath('/admin/employees');
  revalidatePath(`/admin/employees/${employeeId}`);
}

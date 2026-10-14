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
import { pushSeatCountInBackground } from '@/lib/billing/seats';
import { currentOrgId } from '@/lib/tenant/request';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { auditActorOf } from '@/lib/audit/service';
import { DEFAULT_ROLE_ID } from '@/lib/roles/service';

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

/*
 * ── VX5-20: WHERE THE SEAT PUSH GOES, AND WHY NOT IN THE SERVICE ───────────
 *
 * The seat count is non-deleted `app_user` rows, and exactly three things change
 * it: acceptance of an invitation (in `lib/auth/resolve-sso-user.ts`),
 * deactivation, and reactivation. The last two are here.
 *
 * The push is AFTER `asAdmin` returns, never inside it, and that is a
 * correctness point rather than a style one:
 *
 *   · `svc.updateEmployee` and `svc.deactivateEmployee` run inside the caller's
 *     transaction. A push from in there would report a count that has not
 *     committed — and if the transaction then rolled back, the platform would
 *     hold a number that never existed, with nothing to correct it because a level
 *     is last-write-wins.
 *   · it would also hold a database transaction open across a network call to
 *     another company's service, which is how a slow dependency becomes a
 *     connection-pool outage.
 *
 * So: commit, then report. The window between them is a dropped push if the
 * process dies in it, which is what `reconcileAllTenants()` is for.
 *
 * The organization comes from `currentOrgId()` — the session's, and the one
 * `asAdmin` just ran inside. NOT a second query of my own: there is one way to
 * ask which tenant this request is for, and adding another is how the two end up
 * disagreeing in the one case that matters.
 */
export async function updateEmployee(employeeId: string, patch: svc.EmployeePatch) {
  const result = await asAdmin((tx) => svc.updateEmployee(tx, employeeId, patch));
  // Only when the patch could have moved the count. Reactivating clears
  // `deleted_at` (see `svc.updateEmployee`); a title or a manager change does not
  // touch it, and pushing an unchanged number on every edit is noise the platform
  // would have to absorb.
  if ('employeeStatus' in patch) pushSeatCountInBackground(await currentOrgId());
  return result;
}

export async function deactivateEmployee(
  employeeId: string,
  opts: { reassignReportsTo?: string | null } = {},
) {
  const result = await asAdmin((tx, actor) =>
    svc.deactivateEmployee(tx, employeeId, { ...opts, actingEmployeeId: actor.id }),
  );
  pushSeatCountInBackground(await currentOrgId());
  return result;
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
    // w4-10b: the role row picked (0068); absent leaves it as it is.
    roleId: text(form, 'roleId') ?? undefined,
    employeeStatus: (text(form, 'employeeStatus') as svc.EmployeeStatus | null) ?? undefined,
    managerId: text(form, 'managerId'),
    departmentId: text(form, 'departmentId'),
    businessUnitId: text(form, 'businessUnitId'),
    legalEntityId: text(form, 'legalEntityId'),
    // w2-10: only the edit form carries the field; the invite form leaves it to the
    // person's legal entity (see `NewEmployee.country`).
    ...(form.has('country') ? { country: text(form, 'country') } : {}),
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
      roleId: fields.roleId ?? DEFAULT_ROLE_ID,
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

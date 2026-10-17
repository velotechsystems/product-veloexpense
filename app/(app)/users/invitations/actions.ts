'use server';
/**
 * People 4 — the invitation actions, moved from `/admin/employees` when that screen retired
 * (decided 17 Oct 2026). People's directory and drawers edit, deactivate and reactivate a
 * person through the `users` router, which audits each change; what stays here is the one
 * thing the router does not do — inviting somebody, and withdrawing an invitation — for the
 * invite form (`/users/invite`) and the pending list (`/users/invitations`).
 *
 * Same pattern as before: thin 'use server' wrappers that open the tenant transaction
 * through the admin guard, so RLS scopes every row, and delegate to lib/invites/service.
 *
 * VX5-3 removed `getMyDirectReports` and `getMyManagerChain`, exported from a `'use server'`
 * module with no call site — live endpoints rather than dead code. People 4 removes the
 * employee reads and writes this file held (`listEmployees`, `getEmployee`,
 * `getEmployeeDetail`, `updateEmployee`, `deactivateEmployee` and their form entry points)
 * for the same reason: their screens are gone, and the old `updateEmployee` path wrote no
 * audit row.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as svc from '@/lib/employees/service';
import * as invites from '@/lib/invites/service';
import { errorParam } from '@/lib/errors/domain';
import { asAdmin, asAdminPage } from '@/lib/auth/admin-guard';
import { auditActorOf } from '@/lib/audit/service';
import { DEFAULT_ROLE_ID } from '@/lib/roles/service';

/* ── reads ─────────────────────────────────────────────────────────────────── */

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
  // w4-10d: the role offered may not grant more than the inviter holds.
  return asAdmin((tx, actor) =>
    invites.sendInvite(tx, auditActorOf(actor), input, { permissions: actor.role_permissions }),
  );
}

export async function revokeInvite(inviteId: string) {
  return asAdmin((tx, actor) => invites.revokeInvite(tx, auditActorOf(actor), inviteId));
}

export async function listLiveInvites() {
  return asAdminPage((tx) => invites.listLiveInvites(tx));
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
  let resent = false;
  try {
    // What the admin knows now. Country is left to the person's legal entity, and status
    // is not asked: somebody invited has not arrived (VX5-3).
    const issued = await inviteEmployee({
      email: text(form, 'email') ?? '',
      roleId: text(form, 'roleId') ?? DEFAULT_ROLE_ID,
      displayName: text(form, 'displayName'),
      title: text(form, 'title'),
      managerId: text(form, 'managerId'),
      departmentId: text(form, 'departmentId'),
      businessUnitId: text(form, 'businessUnitId'),
      legalEntityId: text(form, 'legalEntityId'),
    });
    resent = issued.resent;
  } catch (err) {
    rethrowRedirect(err);
    redirect(`/users/invite?error=${encodeURIComponent(errorParam(err, 'invite'))}`);
  }
  // The People header counts the invitations waiting, so both pages are stale.
  revalidatePath('/users');
  revalidatePath('/users/invitations');
  redirect(`/users/invitations?invited=${resent ? 'again' : 'first'}`);
}

export async function revokeInviteFromForm(form: FormData): Promise<never> {
  const inviteId = text(form, 'inviteId');
  if (!inviteId) throw new Error('inviteId is required');
  try {
    await revokeInvite(inviteId);
  } catch (err) {
    rethrowRedirect(err);
    redirect(`/users/invitations?error=${encodeURIComponent(errorParam(err, 'invite-revoke'))}`);
  }
  // The People header counts the invitations waiting, so both pages are stale.
  revalidatePath('/users');
  revalidatePath('/users/invitations');
  redirect('/users/invitations?withdrawn=1');
}

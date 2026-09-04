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
 * so a stale or forged claim cannot grant access. Managers can still read their
 * own reporting tree through the two `...ForSelf` actions.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as svc from '@/lib/employees/service';
import { asAdmin, asAdminPage, asMember } from '@/lib/auth/admin-guard';

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

/** Any signed-in user may read their own reporting tree (managers included). */
export async function getMyDirectReports() {
  return asMember((tx, actor) => svc.getDirectReports(tx, actor.id));
}

export async function getMyManagerChain() {
  return asMember((tx, actor) => svc.getManagerChain(tx, actor.id));
}

/* ── writes (typed) ────────────────────────────────────────────────────────── */

export async function createEmployee(input: svc.NewEmployee) {
  return asAdmin((tx) => svc.createEmployee(tx, input));
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

export async function createEmployeeFromForm(form: FormData) {
  const email = text(form, 'email');
  if (!email) throw new Error('email is required');
  const created = await createEmployee({ ...employeeFromForm(form), email });
  revalidatePath('/admin/employees');
  redirect(`/admin/employees/${created.id}`);
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

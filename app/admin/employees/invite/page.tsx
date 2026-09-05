/**
 * VX5-3 — invite somebody (/admin/employees/invite).
 *
 * This replaces `/admin/employees/new`, and the rename is the point rather than
 * cosmetics. That page created an `app_user` row, and an `app_user` row is what
 * `resolveSsoUser` matches on — so filling it in WAS granting access, silently,
 * with no email to the person. The form is the same form; what it writes is an
 * invitation, and the person appears in the directory when they accept.
 *
 * Status is hidden (`showStatus={false}`): an invited person is not ON_LEAVE or
 * DEACTIVATED, they have not arrived. Everything else is asked for now because
 * the admin knows it now — an accepted invite that leaves somebody with no
 * manager puts them in an approval ladder this product treats as broken rather
 * than blank.
 */
import Link from 'next/link';
import { ErrorBanner } from '@/app/expenses/ui';
import { inviteEmployeeFromForm, getDirectoryOptions } from '../actions';
import { readerPrefs } from '@/lib/i18n/request';
import { EmployeeForm } from '../employee-form';
import { INVITE_TTL_DAYS } from '@/lib/invites/service';

export const dynamic = 'force-dynamic';

export default async function InviteEmployeePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const prefs = await readerPrefs();
  const options = await getDirectoryOptions();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          href="/admin/employees"
        >
          ← Employees
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Invite someone</h1>
        <p className="text-sm text-muted-foreground">
          They get an email inviting them to sign in with their work account. The invitation
          lasts {INVITE_TTL_DAYS} days, only works for the address you give here, and they
          appear in your directory once they accept.
        </p>
      </header>

      <ErrorBanner message={error} />

      <EmployeeForm
        action={inviteEmployeeFromForm}
        locale={prefs.locale}
        options={options}
        showStatus={false}
        submitLabel="Send the invitation"
      />
    </div>
  );
}

/**
 * VX5-3 — invite somebody (/users/invite; /admin/employees/invite until People 4 moved it
 * under People, where Add user opens it — decided 17 Oct 2026).
 *
 * This replaces `/admin/employees/new`, and the rename is the point rather than
 * cosmetics. That page created an `app_user` row, and an `app_user` row is what
 * `resolveSsoUser` matches on — so filling it in WAS granting access, silently,
 * with no email to the person. The form is the same form; what it writes is an
 * invitation, and the person appears in the directory when they accept.
 *
 * There is no status: an invited person is not ON_LEAVE or DEACTIVATED, they have not
 * arrived. Everything else is asked for now because
 * the admin knows it now — an accepted invite that leaves somebody with no
 * manager puts them in an approval ladder this product treats as broken rather
 * than blank.
 */
import { ErrorBanner } from '@/app/expenses/ui';
import { inviteEmployeeFromForm, getDirectoryOptions } from '../invitations/actions';
import { InviteForm } from './InviteForm';
import { INVITE_TTL_DAYS } from '@/lib/invites/service';

import { pageTitle } from '@/lib/i18n/page-title';
import { BackLink, PageHeader, Screen } from '@/components/screen';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.people.invite');
}

export const dynamic = 'force-dynamic';

export default async function InviteEmployeePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const options = await getDirectoryOptions();

  return (
    <Screen width="narrow">
      <div className="flex flex-col gap-2">
        <BackLink href="/users">People</BackLink>
        <PageHeader
          title="Invite someone"
          description={`They get an email inviting them to sign in with their work account. The invitation lasts ${INVITE_TTL_DAYS} days, only works for the address you give here, and they appear in People once they accept.`}
        />
      </div>

      <ErrorBanner message={error} />

      <InviteForm
        action={inviteEmployeeFromForm}
        options={options}
        submitLabel="Send the invitation"
      />
    </Screen>
  );
}

/**
 * VX1-2 — admin employee directory (/admin/employees).
 *
 * Server component: reads through the admin-gated server action, which runs
 * inside withCurrentOrg() so RLS scopes every row to the signed-in tenant.
 * Search/filter state lives in the query string, so the page is shareable and
 * needs no client JS.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/app/expenses/ui';
import { listEmployees, listLiveInvites, revokeInviteFromForm } from './actions';
import { enumLabel, EMPLOYEE_ROLE_COPY, EMPLOYEE_STATUS_COPY } from '@/lib/i18n/catalog/enums';
import { readerPrefs } from '@/lib/i18n/request';
import { EMPLOYEE_STATUSES, type EmployeeStatus } from '@/lib/employees/service';

import { pageTitle } from '@/lib/i18n/page-title';

// UD-16. See `lib/i18n/page-title.ts` for why the title lives here rather than
// in a map of routes, and `scripts/check-page-titles.mjs` for what enforces it.
export function generateMetadata() {
  return pageTitle('title.admin.employees');
}

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

function isStatus(value: string | undefined): value is EmployeeStatus {
  return !!value && (EMPLOYEE_STATUSES as string[]).includes(value);
}

const badgeClass =
  'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium';

export default async function EmployeeDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    deactivated?: string;
    page?: string;
    invited?: string;
    withdrawn?: string;
    error?: string;
  }>;
}) {
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? '1') || 1, 1);
  const includeDeactivated = sp.deactivated === '1';

  const pendingInvites = await listLiveInvites();
  const { locale, timeZone } = await readerPrefs();
  // The reader's locale and zone, as every other date on an admin screen — a
  // date rendered in the server's zone is a date that is wrong for somebody.
  const expiryFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone,
  });

  const { employees, total } = await listEmployees({
    search: sp.q ?? null,
    status: isStatus(sp.status) ? sp.status : null,
    includeDeactivated,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set('q', sp.q);
    if (sp.status) params.set('status', sp.status);
    if (includeDeactivated) params.set('deactivated', '1');
    params.set('page', String(n));
    return `/admin/employees?${params.toString()}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? 'employee' : 'employees'} in your organization
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/employees/invite">Invite someone</Link>
        </Button>
      </header>

      <ErrorBanner message={sp.error} />
      {sp.invited === 'first' || sp.invited === 'again' ? (
        <p className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary">
          {sp.invited === 'again'
            ? 'That address already had an invitation open, so we sent a fresh one — the earlier link has stopped working.'
            : 'Invitation sent. They appear here once they sign in and accept it.'}
        </p>
      ) : null}
      {sp.withdrawn === '1' ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Invitation withdrawn. That link no longer works.
        </p>
      ) : null}

      {/* VX5-3 — the pending list.
        *
        * It exists because the directory below no longer contains people who
        * have not arrived, which is the whole point of the ticket and would
        * otherwise read as an admin's invitation vanishing. Live invitations
        * only: an accepted one is a person in the table below, and a revoked or
        * expired one is a decision already taken. */}
      {pendingInvites.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-foreground">
            Invited, not yet signed in ({pendingInvites.length})
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Invited by</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {pendingInvites.map((invite) => (
                  <tr className="border-t border-border" key={invite.id}>
                    <td className="px-3 py-2">{invite.email}</td>
                    <td className="px-3 py-2">
                      {enumLabel(EMPLOYEE_ROLE_COPY, invite.role, locale)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {invite.invitedByName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {expiryFormat.format(invite.expiresAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <form action={revokeInviteFromForm}>
                        <input name="inviteId" type="hidden" value={invite.id} />
                        <Button size="sm" type="submit" variant="outline">
                          Withdraw
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <form className="flex flex-wrap items-end gap-3" action="/admin/employees">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="q">
            Search
          </label>
          <Input id="q" name="q" placeholder="Name, email or title" defaultValue={sp.q ?? ''} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={sp.status ?? ''}
            className="h-8 rounded-lg border border-input bg-transparent px-3 text-sm shadow-xs outline-none"
          >
            <option value="">Any</option>
            {/* Catalogued, like the badge in the table beside it. See
                `scripts/check-enum-options.mjs`. */}
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {enumLabel(EMPLOYEE_STATUS_COPY, s, locale)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="deactivated" value="1" defaultChecked={includeDeactivated} />
          Include deactivated
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Manager</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No employees match these filters.
                </td>
              </tr>
            ) : (
              employees.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <Link className="font-medium underline-offset-4 hover:underline" href={`/admin/employees/${e.id}`}>
                      {e.display_name ?? e.email}
                    </Link>
                    <div className="text-xs text-muted-foreground">{e.email}</div>
                  </td>
                  <td className="px-4 py-3">{e.title ?? '—'}</td>
                  <td className="px-4 py-3">{e.department_name ?? '—'}</td>
                  <td className="px-4 py-3">{e.manager_name ?? e.manager_email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={badgeClass}>{e.role}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={badgeClass}>{e.employee_status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <nav className="flex items-center gap-3 text-sm">
          {page > 1 ? (
            <Link className="underline underline-offset-4" href={pageHref(page - 1)}>
              Previous
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link className="underline underline-offset-4" href={pageHref(page + 1)}>
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

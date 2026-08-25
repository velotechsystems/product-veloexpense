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
import { listEmployees } from './actions';
import { EMPLOYEE_STATUSES, type EmployeeStatus } from '@/lib/employees/service';

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
  searchParams: Promise<{ q?: string; status?: string; deactivated?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? '1') || 1, 1);
  const includeDeactivated = sp.deactivated === '1';

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
          <Link href="/admin/employees/new">New employee</Link>
        </Button>
      </header>

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
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
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

/**
 * VX1-2 — employee detail (/admin/employees/[employeeId]).
 *
 * Shows the record, its resolved manager chain and its direct reports, with the
 * edit form and the deactivate control. Everything reads and writes through the
 * admin-gated server actions, so RLS scopes it to the signed-in tenant.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  deactivateEmployeeFromForm,
  getDirectoryOptions,
  getEmployeeDetail,
  updateEmployeeFromForm,
} from '../actions';
import { EmployeeForm } from '../employee-form';

export const dynamic = 'force-dynamic';

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border p-5';

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;
  const detail = await getEmployeeDetail(employeeId);
  if (!detail) notFound();

  const { employee, managerChain, directReports } = detail;
  const options = await getDirectoryOptions();
  const activeReports = directReports.filter((r) => r.deleted_at === null);
  const isDeactivated = employee.employee_status === 'DEACTIVATED';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/admin/employees">
          ← Employees
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {employee.display_name ?? employee.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {employee.title ? `${employee.title} · ` : ''}
          {employee.email} · {employee.role} · {employee.employee_status}
        </p>
      </header>

      <section className={sectionClass}>
        <h2 className="text-lg font-medium">Details</h2>
        <EmployeeForm
          action={updateEmployeeFromForm}
          options={options}
          employee={employee}
          submitLabel="Save changes"
        />
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-medium">Reporting line</h2>
        {managerChain.length === 0 ? (
          <p className="text-sm text-muted-foreground">No manager set.</p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {managerChain.map((link) => (
              <li key={link.id} style={{ paddingLeft: `${(link.depth - 1) * 16}px` }}>
                <Link className="underline-offset-4 hover:underline" href={`/admin/employees/${link.id}`}>
                  {link.display_name ?? link.email}
                </Link>
                {link.title ? <span className="text-muted-foreground"> · {link.title}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-medium">
          Direct reports {directReports.length > 0 ? `(${directReports.length})` : ''}
        </h2>
        {directReports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No direct reports.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {directReports.map((report) => (
              <li key={report.id}>
                <Link className="underline-offset-4 hover:underline" href={`/admin/employees/${report.id}`}>
                  {report.display_name ?? report.email}
                </Link>
                <span className="text-muted-foreground">
                  {report.title ? ` · ${report.title}` : ''}
                  {report.deleted_at ? ' · deactivated' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isDeactivated ? null : (
        <section className={sectionClass}>
          <h2 className="text-lg font-medium">Deactivate</h2>
          <p className="text-sm text-muted-foreground">
            Deactivating keeps the employee&apos;s history and removes them from the active directory.
            {activeReports.length > 0
              ? ' Choose where their direct reports should go first.'
              : ''}
          </p>
          <form action={deactivateEmployeeFromForm} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="employeeId" value={employee.id} />
            {activeReports.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="reassignReportsTo">
                  Reassign {activeReports.length} report(s) to
                </label>
                <select
                  id="reassignReportsTo"
                  name="reassignReportsTo"
                  defaultValue={employee.manager_id ?? ''}
                  className="h-8 rounded-lg border border-input bg-transparent px-3 text-sm outline-none"
                >
                  <option value="">— no manager —</option>
                  {options.managers
                    .filter((m) => m.id !== employee.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name ?? m.email}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <Button type="submit" variant="destructive">
              Deactivate employee
            </Button>
          </form>
        </section>
      )}
    </div>
  );
}

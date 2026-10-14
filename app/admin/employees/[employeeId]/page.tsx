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
import { readerPrefs } from '@/lib/i18n/request';
import {
  deactivateEmployeeFromForm,
  getDirectoryOptions,
  getEmployeeDetail,
  updateEmployeeFromForm,
} from '../actions';
import { EmployeeForm } from '../employee-form';

import { dataTitle } from '@/lib/i18n/page-title';
import { NativeSelect } from '@/components/ui/native-select';
import { BackLink, PageHeader, Screen } from '@/components/screen';
export const dynamic = 'force-dynamic';


// UD-16. Titled by the PERSON, for the same reason the report workbench is titled
// by the report: an admin working through a directory has several of these open at
// once. The name is the tenant's data and is not catalogued.
export async function generateMetadata({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = await params;
  const detail = await getEmployeeDetail(employeeId).catch(() => null);
  return dataTitle(
    'title.admin.employees.one',
    detail?.employee?.display_name ?? detail?.employee?.email ?? null,
  );
}

const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border p-5';

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const prefs = await readerPrefs();
  const { employeeId } = await params;
  const detail = await getEmployeeDetail(employeeId);
  if (!detail) notFound();

  const { employee, managerChain, directReports } = detail;
  const options = await getDirectoryOptions();
  const activeReports = directReports.filter((r) => r.deleted_at === null);
  const isDeactivated = employee.employee_status === 'DEACTIVATED';

  return (
    <Screen>
      <div className="flex flex-col gap-2">
        <BackLink href="/admin/employees">Employees</BackLink>
        <PageHeader
          title={employee.display_name ?? employee.email}
          description={`${employee.title ? `${employee.title} · ` : ''}${employee.email} · ${employee.role_label} · ${employee.employee_status}`}
        />
      </div>

      <section className={sectionClass}>
        <h2 className="text-lg leading-7 font-semibold">Details</h2>
        <EmployeeForm
      locale={prefs.locale}
          action={updateEmployeeFromForm}
          options={options}
          employee={employee}
          submitLabel="Save changes"
        />
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg leading-7 font-semibold">Reporting line</h2>
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
        <h2 className="text-lg leading-7 font-semibold">
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
          <h2 className="text-lg leading-7 font-semibold">Deactivate</h2>
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
                <NativeSelect
                  id="reassignReportsTo"
                  name="reassignReportsTo"
                  defaultValue={employee.manager_id ?? ''}

                >
                  <option value="">— no manager —</option>
                  {options.managers
                    .filter((m) => m.id !== employee.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name ?? m.email}
                      </option>
                    ))}
                </NativeSelect>
              </div>
            ) : null}
            <Button type="submit" variant="destructive">
              Deactivate employee
            </Button>
          </form>
        </section>
      )}
    </Screen>
  );
}

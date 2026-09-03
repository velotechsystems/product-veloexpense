/**
 * VX1-2 — create an employee (/admin/employees/new).
 * Admin-gated through the server actions; redirects to the new record on save.
 */
import Link from 'next/link';
import { createEmployeeFromForm, getDirectoryOptions } from '../actions';
import { readerPrefs } from '@/lib/i18n/request';
import { EmployeeForm } from '../employee-form';

export const dynamic = 'force-dynamic';

export default async function NewEmployeePage() {
  const prefs = await readerPrefs();
  const options = await getDirectoryOptions();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/admin/employees">
          ← Employees
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New employee</h1>
        <p className="text-sm text-muted-foreground">
          The employee is created in your organization only — sign-in is still invite-only SSO.
        </p>
      </header>

      <EmployeeForm
      locale={prefs.locale} action={createEmployeeFromForm} options={options} submitLabel="Create employee" />
    </div>
  );
}

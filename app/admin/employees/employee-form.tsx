/**
 * VX1-2 — the shared create/edit employee form.
 *
 * A server component on purpose: it posts a plain <form action={serverAction}>,
 * so the directory works without client JS and there is no client-side state to
 * keep in sync. Button/Input come from the vendored lib-ui-kit registry.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  EMPLOYEE_ROLES,
  EMPLOYEE_STATUSES,
  type EmployeeRow,
} from '@/lib/employees/service';

type Options = {
  departments: Array<{ id: string; name: string }>;
  businessUnits: Array<{ id: string; name: string }>;
  legalEntities: Array<{ id: string; name: string }>;
  managers: Array<{ id: string; email: string; display_name: string | null }>;
};

const fieldClass = 'flex flex-col gap-1.5';
const labelClass = 'text-sm font-medium text-foreground';
const selectClass =
  'h-8 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function EmployeeForm({
  action,
  options,
  employee,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  options: Options;
  employee?: EmployeeRow;
  submitLabel: string;
}) {
  const managerChoices = options.managers.filter((m) => m.id !== employee?.id);

  return (
    <form action={action} className="flex flex-col gap-6">
      {employee ? <input type="hidden" name="employeeId" value={employee.id} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="email">
            Email
          </label>
          <Input id="email" name="email" type="email" required defaultValue={employee?.email ?? ''} />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="displayName">
            Name
          </label>
          <Input id="displayName" name="displayName" defaultValue={employee?.display_name ?? ''} />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="title">
            Job title
          </label>
          <Input id="title" name="title" defaultValue={employee?.title ?? ''} />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="role">
            Role
          </label>
          <select
            id="role"
            name="role"
            className={selectClass}
            defaultValue={employee?.role ?? 'EMPLOYEE'}
          >
            {EMPLOYEE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="employeeStatus">
            Status
          </label>
          <select
            id="employeeStatus"
            name="employeeStatus"
            className={selectClass}
            defaultValue={employee?.employee_status ?? 'ACTIVE'}
          >
            {EMPLOYEE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="managerId">
            Manager
          </label>
          <select
            id="managerId"
            name="managerId"
            className={selectClass}
            defaultValue={employee?.manager_id ?? ''}
          >
            <option value="">— none —</option>
            {managerChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name ?? m.email}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="departmentId">
            Department
          </label>
          <select
            id="departmentId"
            name="departmentId"
            className={selectClass}
            defaultValue={employee?.department_id ?? ''}
          >
            <option value="">— none —</option>
            {options.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="businessUnitId">
            Business unit
          </label>
          <select
            id="businessUnitId"
            name="businessUnitId"
            className={selectClass}
            defaultValue={employee?.business_unit_id ?? ''}
          >
            <option value="">— none —</option>
            {options.businessUnits.map((bu) => (
              <option key={bu.id} value={bu.id}>
                {bu.name}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="legalEntityId">
            Legal entity
          </label>
          <select
            id="legalEntityId"
            name="legalEntityId"
            className={selectClass}
            defaultValue={employee?.legal_entity_id ?? ''}
          >
            <option value="">— none —</option>
            {options.legalEntities.map((le) => (
              <option key={le.id} value={le.id}>
                {le.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

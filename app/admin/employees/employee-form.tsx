/**
 * VX1-2 — the shared create/edit employee form.
 *
 * A server component on purpose: it posts a plain <form action={serverAction}>,
 * so the directory works without client JS and there is no client-side state to
 * keep in sync. Button/Input come from the vendored lib-ui-kit registry.
 */
import { Button } from '@/components/ui/button';
import {
  enumLabel,
  EMPLOYEE_ROLE_COPY,
  EMPLOYEE_STATUS_COPY,
} from '@/lib/i18n/catalog/enums';
import { Input } from '@/components/ui/input';
import {
  EMPLOYEE_ROLES,
  EMPLOYEE_STATUSES,
  type EmployeeRow,
} from '@/lib/employees/service';
import { NativeSelect } from '@/components/ui/native-select';

type Options = {
  departments: Array<{ id: string; name: string }>;
  businessUnits: Array<{ id: string; name: string }>;
  legalEntities: Array<{ id: string; name: string }>;
  managers: Array<{ id: string; email: string; display_name: string | null }>;
};

const fieldClass = 'flex flex-col gap-1.5';
const labelClass = 'text-sm font-medium text-foreground';

export function EmployeeForm({
  action,
  options,
  employee,
  submitLabel,
  locale,
  showStatus = true,
}: {
  action: (formData: FormData) => Promise<void>;
  options: Options;
  employee?: EmployeeRow;
  submitLabel: string;
  /** Sync component — the page resolves the reader once and threads it down. */
  locale: string;
  /**
   * VX5-3. The invite form reuses this one and hides Status, because an invited
   * person is not ON_LEAVE or DEACTIVATED — they have not arrived. A select that
   * cannot affect anything is worse than a missing one: somebody sets it, and it
   * is silently discarded.
   */
  showStatus?: boolean;
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
          <NativeSelect
            id="role"
            name="role"
            defaultValue={employee?.role ?? 'EMPLOYEE'}
          >
            {EMPLOYEE_ROLES.map((role) => (
              <option key={role} value={role}>
                {enumLabel(EMPLOYEE_ROLE_COPY, role, locale)}
              </option>
            ))}
          </NativeSelect>
        </div>

        {showStatus ? (
          <div className={fieldClass}>
            <label className={labelClass} htmlFor="employeeStatus">
              Status
            </label>
            <NativeSelect
              id="employeeStatus"
              name="employeeStatus"
              defaultValue={employee?.employee_status ?? 'ACTIVE'}
            >
              {EMPLOYEE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {enumLabel(EMPLOYEE_STATUS_COPY, status, locale)}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="managerId">
            Manager
          </label>
          <NativeSelect
            id="managerId"
            name="managerId"
            defaultValue={employee?.manager_id ?? ''}
          >
            <option value="">— none —</option>
            {managerChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name ?? m.email}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="departmentId">
            Department
          </label>
          <NativeSelect
            id="departmentId"
            name="departmentId"
            defaultValue={employee?.department_id ?? ''}
          >
            <option value="">— none —</option>
            {options.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="businessUnitId">
            Business unit
          </label>
          <NativeSelect
            id="businessUnitId"
            name="businessUnitId"
            defaultValue={employee?.business_unit_id ?? ''}
          >
            <option value="">— none —</option>
            {options.businessUnits.map((bu) => (
              <option key={bu.id} value={bu.id}>
                {bu.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="legalEntityId">
            Legal entity
          </label>
          <NativeSelect
            id="legalEntityId"
            name="legalEntityId"
            defaultValue={employee?.legal_entity_id ?? ''}
          >
            <option value="">— none —</option>
            {options.legalEntities.map((le) => (
              <option key={le.id} value={le.id}>
                {le.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

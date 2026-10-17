/**
 * VX1-2 — the invite form, moved from `/admin/employees` in People 4.
 *
 * It was the shared create/edit employee form; editing now happens in People's edit drawer
 * (audited, through the `users` router), so only the invite half remains: no status (an
 * invited person has not arrived) and no country (they take their legal entity's).
 *
 * A server component on purpose: it posts a plain <form action={serverAction}>, so it works
 * without client JS and there is no client-side state to keep in sync. Button/Input come
 * from the vendored lib-ui-kit registry.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_ROLE_ID } from '@/lib/roles/service';
import { NativeSelect } from '@/components/ui/native-select';
import { activeChoices } from '@/lib/employees/active-choices';

type Options = {
  departments: Array<{ id: string; name: string; active: boolean }>;
  businessUnits: Array<{ id: string; name: string; active: boolean }>;
  legalEntities: Array<{ id: string; name: string; active: boolean }>;
  managers: Array<{ id: string; email: string; display_name: string | null }>;
  /** w4-10b: the tenant's roles (0068), by their own names. */
  roles: Array<{ id: string; name: string; active: boolean }>;
};

const fieldClass = 'flex flex-col gap-1.5';
const labelClass = 'text-sm font-medium text-foreground';

export function InviteForm({
  action,
  options,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  options: Options;
  submitLabel: string;
}) {
  return (
    <form action={action} className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="email">
            Email
          </label>
          <Input id="email" name="email" type="email" required />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="displayName">
            Name
          </label>
          <Input id="displayName" name="displayName" />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="title">
            Job title
          </label>
          <Input id="title" name="title" />
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="roleId">
            Role
          </label>
          {/* w4-10b: the tenant's roles, active ones only (`activeChoices`). The server refuses
              a role carrying permissions the inviter does not hold (w4-10d). */}
          <NativeSelect id="roleId" name="roleId" defaultValue={DEFAULT_ROLE_ID}>
            {activeChoices(options.roles).map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className={fieldClass}>
          <label className={labelClass} htmlFor="managerId">
            Manager
          </label>
          <NativeSelect id="managerId" name="managerId">
            <option value="">— none —</option>
            {options.managers.map((m) => (
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
          <NativeSelect id="departmentId" name="departmentId">
            <option value="">— none —</option>
            {/* Active departments only: nobody holds one yet. */}
            {activeChoices(options.departments).map((d) => (
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
          <NativeSelect id="businessUnitId" name="businessUnitId">
            <option value="">— none —</option>
            {/* Active units only. */}
            {activeChoices(options.businessUnits).map((bu) => (
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
          <NativeSelect id="legalEntityId" name="legalEntityId">
            <option value="">— none —</option>
            {/* Active entities only. */}
            {activeChoices(options.legalEntities).map((le) => (
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

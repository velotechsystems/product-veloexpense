'use client';

/*
 * Ported from ExpenseOS (1e682dd6), People 3, with #574's manager field. VeloExpense: the
 * kit's Select renders the chosen label itself (no render-fn).
 */

import {
  Alert,
  AlertDescription,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  type ExternalIdEntry,
  entriesFromMap,
  Field as FormField,
  Input,
  mapFromEntries,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import type { Locale } from '@expenseos/i18n/locales';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ExternalIdsField } from '@/components/external-ids/ExternalIdsField';
import { UserCombobox } from '@/components/pickers/EntityPickers';
import { Link as LocaleLink } from '@/i18n/navigation';
import { EMPLOYEE_STATUSES, type EmployeeStatus } from '@/lib/employeeStatus';
import { trpc } from '@/lib/trpc/client';
import type { PeopleRow } from './EmployeeDirectory.cells';

/**
 * Admin edit of an employee's core profile — name, status, org assignments
 * (legal entity / business unit / department), manager, and country. Drives the
 * audited `users.update` mutation (server enforces self-as-manager, manager-cycle
 * and grant-ceiling guards). Job level and home currency are intentionally out of
 * scope here (they carry their own picker/sync semantics) — follow-up.
 *
 * A manager set here is overwritten by a later Google Directory sync whenever
 * Directory names a manager it can resolve — by design (`integrations-google`
 * `apply.ts`, "Resolve manager email → managerId").
 */
export function EditEmployeeDrawer({
  user,
  onClose,
  syncReviewPath,
}: {
  user: PeopleRow | null;
  onClose: () => void;
  /**
   * Where the integration's People review lives (ExpenseOS: `/netsuite/people`), for a viewer
   * who may rule on a People ↔ integration disagreement; absent, there is no review link.
   * VeloExpense: a path handed in rather than a vendor route written here
   * (scripts/check-vendor-neutral.mjs) — Wave 5's integration supplies it.
   */
  syncReviewPath?: string;
}) {
  return (
    <Drawer open={user !== null} onOpenChange={(o) => !o && onClose()}>
      {user && <EditBody user={user} onClose={onClose} syncReviewPath={syncReviewPath} />}
    </Drawer>
  );
}

type OrgOption = { id: string; label: unknown };

function EditBody({
  user,
  onClose,
  syncReviewPath,
}: {
  user: PeopleRow;
  onClose: () => void;
  syncReviewPath: string | undefined;
}) {
  const t = useTranslations('people.edit');
  const tSync = useTranslations('people.sync');
  const tStatus = useTranslations('people.status');
  const tCols = useTranslations('people.columns');
  const tc = useTranslations('admin.common');
  const locale = useLocale() as Locale;
  const utils = trpc.useUtils();
  const facets = trpc.users.listFilterFacets.useQuery(undefined, { staleTime: 60_000 });
  // eos batch 4 (ExpenseOS 67db2e33, #582): Google owns this person's name, country and
  // manager while directory sync is on and they are linked to a Google account.
  // VeloExpense: not status — Directory only moves a person out here (d85).
  const directory = trpc.users.directorySync.useQuery(undefined, { staleTime: 60_000 });
  const googleManaged =
    directory.data?.enabled === true &&
    Boolean((user.externalIds as Record<string, string> | null | undefined)?.google);

  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const [status, setStatus] = useState<EmployeeStatus>(user.employeeStatus as EmployeeStatus);
  const [legalEntityId, setLegalEntityId] = useState<string | null>(user.entity?.id ?? null);
  const [businessUnitId, setBusinessUnitId] = useState<string | null>(
    user.businessUnit?.id ?? null,
  );
  const [departmentId, setDepartmentId] = useState<string | null>(user.department?.id ?? null);
  const [country, setCountry] = useState(user.country ?? '');
  /**
   * The manager as loaded, so `save` can tell an untouched picker from a change. The
   * key is left out of the patch unless it changed: the audit row's `changedFields` is
   * the patch's keys, so sending it every time would record a manager change on every
   * save. Cleared goes over as `null` (never `''`).
   */
  const initialManagerId = user.manager?.id ?? null;
  const [managerId, setManagerId] = useState<string | null>(initialManagerId);
  // The row carries the manager's name but not their email. A nameless manager seeds
  // nothing, so the picker resolves the label itself through `pickers.users.byId`.
  const managerName = user.manager
    ? [user.manager.firstName, user.manager.lastName].filter(Boolean).join(' ')
    : '';
  const managerSeed =
    user.manager && managerName ? { value: user.manager.id, label: managerName } : null;
  /**
   * What other systems call this person, keyed by source code.
   *
   * Seeded from the row and edited in place. Until this existed the mapping could only
   * be written by the seed or a directory sync, so a person NetSuite knew about but
   * ExpenseOS did not could not be connected by hand — and an expense report from them
   * is refused at the posting pre-flight with "has no NetSuite employee id mapped".
   *
   * A SUB-FORM now, the same one every other entity uses. It was a field per system,
   * rendered whether or not the person had an id in it, so a directory with four sources
   * put four permanently-empty boxes between "Department" and "Country" on every profile
   * anybody opened — and adding a fifth source silently changed this form.
   */
  const [externalIds, setExternalIds] = useState<ExternalIdEntry[]>(() =>
    entriesFromMap((user.externalIds ?? {}) as Record<string, string>),
  );
  const [err, setErr] = useState<string | null>(null);

  const update = trpc.users.update.useMutation({
    onSuccess: () => {
      utils.users.invalidate();
      onClose();
    },
    onError: (e) => setErr(e.message),
  });

  const labelOf = (label: unknown) => (getLocalized(label, locale) as string) ?? '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  const save = () => {
    setErr(null);
    update.mutate({
      id: user.id,
      patch: {
        // Google-owned fields are left out entirely when Google manages this person.
        ...(googleManaged
          ? {}
          : {
              firstName: firstName.trim() || null,
              lastName: lastName.trim() || null,
              country: country.trim() ? country.trim().toUpperCase() : null,
              ...(managerId !== initialManagerId ? { managerId } : {}),
            }),
        employeeStatus: status,
        legalEntityId,
        businessUnitId,
        departmentId,
        // A full replace: a row that was removed is simply absent from the map, which
        // is how the mapping is deleted rather than stored as a blank id.
        externalIds: mapFromEntries(externalIds),
      },
    });
  };

  return (
    <DrawerContent width={460}>
      <DrawerHeader>
        <DrawerTitle>{t('title')}</DrawerTitle>
        <p className="mt-0.5 text-muted-foreground text-sm">{t('for', { name })}</p>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {/* NetSuite disagrees about one of the fields below. Said here, once, because this
            is the form that would otherwise change that field without knowing it was
            contested — the ruling itself lives on the integration's review (`syncReviewPath`). */}
        {(user.syncDiscrepancies?.length ?? 0) > 0 && (
          <Alert data-testid="people-sync-notice">
            <AlertDescription>
              {tSync('editNotice', {
                fields: user.syncDiscrepancies.map((d) => tSync(`field.${d.field}`)).join(', '),
              })}
              {syncReviewPath && (
                <>
                  {' '}
                  <LocaleLink
                    href={`${syncReviewPath}?q=${encodeURIComponent(user.email)}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {tSync('review')}
                  </LocaleLink>
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
        {googleManaged && (
          <Alert data-testid="people-directory-managed">
            <AlertDescription>{t('directoryManaged')}</AlertDescription>
          </Alert>
        )}
        {err && <p className="text-destructive text-sm">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField htmlFor="ee-fn" label={t('firstName')}>
            <Input
              id="ee-fn"
              value={firstName}
              disabled={googleManaged}
              onChange={(e) => setFirstName(e.currentTarget.value)}
            />
          </FormField>
          <FormField htmlFor="ee-ln" label={t('lastName')}>
            <Input
              id="ee-ln"
              value={lastName}
              disabled={googleManaged}
              onChange={(e) => setLastName(e.currentTarget.value)}
            />
          </FormField>
        </div>
        <FormField htmlFor="ee-status" label={t('status')}>
          <Select value={status} onValueChange={(v) => v && setStatus(v as EmployeeStatus)}>
            <SelectTrigger id="ee-status">
              {/* VeloExpense kit: Radix's SelectValue renders the chosen item's own label (see
                  components/forms/ColorInput.tsx); ExpenseOS's Base UI render-fn is not needed. */}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMPLOYEE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {tStatus(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <OrgSelect
          id="ee-entity"
          label={tCols('entity')}
          value={legalEntityId}
          onChange={setLegalEntityId}
          options={facets.data?.legalEntities ?? []}
          labelOf={labelOf}
          noneLabel={t('none')}
        />
        <OrgSelect
          id="ee-bu"
          label={tCols('businessUnit')}
          value={businessUnitId}
          onChange={setBusinessUnitId}
          options={facets.data?.businessUnits ?? []}
          labelOf={labelOf}
          noneLabel={t('none')}
        />
        <OrgSelect
          id="ee-dept"
          label={tCols('department')}
          value={departmentId}
          onChange={setDepartmentId}
          options={facets.data?.departments ?? []}
          labelOf={labelOf}
          noneLabel={t('none')}
        />
        <FormField htmlFor="ee-manager" label={t('manager')}>
          <UserCombobox
            id="ee-manager"
            value={managerId}
            onValueChange={(v) => setManagerId(v)}
            initialItem={managerSeed}
            excludeValues={[user.id]}
            placeholder={t('managerNone')}
            disabled={googleManaged}
          />
        </FormField>
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground text-xs">{tc('externalIds')}</span>
          <ExternalIdsField entries={externalIds} onChange={setExternalIds} />
        </div>
        <FormField htmlFor="ee-country" label={t('country')}>
          <Input
            id="ee-country"
            maxLength={2}
            value={country}
            disabled={googleManaged}
            placeholder={t('countryPlaceholder')}
            onChange={(e) => setCountry(e.currentTarget.value)}
          />
        </FormField>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? t('saving') : t('save')}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  );
}

/** A nullable FK <Select> with a "None" option. */
function OrgSelect({
  id,
  label,
  value,
  onChange,
  options,
  labelOf,
  noneLabel,
}: {
  id: string;
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: OrgOption[];
  labelOf: (label: unknown) => string;
  noneLabel: string;
}) {
  const NONE = '__none__';
  return (
    <FormField htmlFor={id} label={label}>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(!v || v === NONE ? null : (v as string))}
      >
        <SelectTrigger id={id}>
          {/* VeloExpense kit: Radix's SelectValue renders the chosen item's own label (see
              components/forms/ColorInput.tsx); ExpenseOS's Base UI render-fn is not needed. */}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {labelOf(o.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

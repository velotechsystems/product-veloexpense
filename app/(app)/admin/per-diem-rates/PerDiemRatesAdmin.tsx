// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; t()/helper closures are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/per-diem-rates — manage per-diem lodging + meals allowances by
 * location, effective range, and optional scoping (job level / legal entity /
 * business unit / currency; blank = applies to everyone). Feeds the approval
 * engine's `overPerDiem` workflow condition. Toolbar + FilterPillBar + DataTable
 * + create/edit drawer, per the listing UX standard.
 */
import {
  Button,
  Checkbox,
  Combobox,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  Field as FormField,
  Input,
  RowActionsMenu,
  TableSettingsButton,
} from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { pickLabel } from '@/components/admin/AdminLookupPage';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { formatMinor, majorToMinor, minorToMajorInput } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
import { setTopBarSlot } from '@/app/(app)/TopBar';

type ColumnId = 'location' | 'scope' | 'category' | 'amount' | 'validity';

interface FormData {
  country: string;
  city: string;
  categoryId: string | null;
  amount: string; // major units
  firstLastDay: boolean;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string;
  jobLevelId: string | null;
  legalEntityId: string | null;
  businessUnitId: string | null;
  currencyId: string | null;
}

const EMPTY_FORM: FormData = {
  country: '',
  city: '',
  categoryId: null,
  amount: '',
  firstLastDay: false,
  effectiveFrom: '',
  effectiveTo: '',
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  currencyId: null,
};

export function PerDiemRatesAdmin({ canManage }: { canManage: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('perDiem');
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const list = trpc.policies.perDiemRate.list.useQuery();
  const options = trpc.policies.perDiemRate.options.useQuery();
  const rows = useMemo(() => list.data ?? [], [list.data]);

  const [editing, setEditing] = useState<{ id: string | null; form: FormData } | null>(null);

  const invalidate = () => utils.policies.perDiemRate.list.invalidate();
  const create = trpc.policies.perDiemRate.create.useMutation({ onSuccess: invalidate });
  const update = trpc.policies.perDiemRate.update.useMutation({ onSuccess: invalidate });
  const remove = trpc.policies.perDiemRate.delete.useMutation({ onSuccess: invalidate });

  // Label maps for resolving the scoping ids in the table.
  const jobLevelLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of options.data?.jobLevels ?? []) m.set(j.id, j.code);
    return m;
  }, [options.data]);
  const categoryLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of options.data?.categories ?? []) m.set(c.id, pickLabel(c.label, locale));
    return m;
  }, [options.data, locale]);
  const currencyById = useMemo(() => {
    const m = new Map<string, { code: string; symbol: string }>();
    for (const c of options.data?.currencies ?? []) m.set(c.id, c);
    return m;
  }, [options.data]);

  const categoryItems = (options.data?.categories ?? []).map((c) => ({
    value: c.id,
    label: pickLabel(c.label, locale),
  }));
  const jobLevelItems = (options.data?.jobLevels ?? []).map((j) => ({
    value: j.id,
    label: `${j.code} — ${pickLabel(j.label, locale)}`,
  }));
  const legalEntityItems = (options.data?.legalEntities ?? []).map((l) => ({
    value: l.id,
    label: pickLabel(l.label, locale),
  }));
  const businessUnitItems = (options.data?.businessUnits ?? []).map((b) => ({
    value: b.id,
    label: pickLabel(b.label, locale),
  }));
  const currencyItems = (options.data?.currencies ?? []).map((c) => ({
    value: c.id,
    label: `${c.code} (${c.symbol})`,
  }));

  useEffect(() => {
    setTopBarSlot(
      'right',
      canManage ? (
        <Button size="sm" onClick={() => setEditing({ id: null, form: EMPTY_FORM })}>
          <IconPlus size={15} className="mr-1.5" />
          {t('add')}
        </Button>
      ) : null,
    );
    return () => setTopBarSlot('right', null);
  }, [t, canManage]);

  // Resolve a rate's scoping currency to a { code, symbol } for exponent-aware
  // money formatting. Rows with no currency scope carry no ISO code.
  const currencyFor = (currencyId: string | null): { code: string; symbol?: string | null } =>
    // TODO(currency): unscoped rate → no ISO code; fall back to CAD.
    (currencyId ? currencyById.get(currencyId) : undefined) ?? { code: 'CAD', symbol: '$' };

  const fmtDate = (d: string | Date | null): string =>
    d
      ? new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

  const columns = useMemo<ColumnDef<(typeof rows)[number], ColumnId>[]>(
    () => [
      {
        id: 'location',
        label: t('col.location'),
        defaultWidth: 200,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (r) => (
          <span className="font-medium text-foreground text-sm">
            {r.country} · {r.city}
          </span>
        ),
      },
      {
        id: 'scope',
        label: t('col.scope'),
        defaultWidth: 220,
        cell: (r) => {
          const parts: string[] = [];
          if (r.jobLevelId) parts.push(jobLevelLabel.get(r.jobLevelId) ?? '—');
          if (r.legalEntityId) parts.push(t('scope.le'));
          if (r.businessUnitId) parts.push(t('scope.bu'));
          return (
            <span className="text-muted-foreground text-sm">
              {parts.length ? parts.join(' · ') : t('scope.all')}
            </span>
          );
        },
      },
      {
        id: 'category',
        label: t('col.category'),
        defaultWidth: 180,
        cell: (r) => (
          <span className="text-foreground text-sm">{categoryLabel.get(r.categoryId) ?? '—'}</span>
        ),
      },
      {
        id: 'amount',
        label: t('col.amount'),
        defaultWidth: 130,
        cell: (r) => (
          <span className="block text-right text-foreground text-sm tabular-nums">
            {formatMinor(Number(r.amountMinor), currencyFor(r.currencyId), locale)}
          </span>
        ),
      },
      {
        id: 'validity',
        label: t('col.validity'),
        defaultWidth: 200,
        cell: (r) => (
          <span className="text-muted-foreground text-xs">
            {fmtDate(r.effectiveFrom)}
            {r.effectiveTo ? ` – ${fmtDate(r.effectiveTo)}` : ` – ${t('ongoing')}`}
          </span>
        ),
      },
    ],
    [t, jobLevelLabel, categoryLabel, currencyById, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    // The actions column has to be in the seeded column order or the table never
    // renders it — and the row kebab is the ONLY way to delete a rate.
    createDataTableState([...columns, { id: 'actions' }] as never, {}),
  );

  const filteredRows = useMemo(() => {
    let out = rows;
    for (const c of tableState.filters) {
      if (c.field === 'location' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter(
          (r) => r.country.toLowerCase().includes(n) || r.city.toLowerCase().includes(n),
        );
      }
    }
    return out;
  }, [rows, tableState.filters]);

  const pillBar = useFilterPillBarWiring<(typeof rows)[number], ColumnId>(
    columns,
    tableState,
    setTableState,
  );

  const openEdit = (r: (typeof rows)[number]) =>
    setEditing({
      id: r.id,
      form: {
        country: r.country,
        city: r.city,
        categoryId: r.categoryId,
        amount: minorToMajorInput(BigInt(r.amountMinor), currencyFor(r.currencyId).code),
        firstLastDay: r.firstLastDay,
        effectiveFrom: new Date(r.effectiveFrom).toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString().slice(0, 10) : '',
        jobLevelId: r.jobLevelId,
        legalEntityId: r.legalEntityId,
        businessUnitId: r.businessUnitId,
        currencyId: r.currencyId,
      },
    });

  const rowActions = (r: (typeof rows)[number]) =>
    canManage
      ? [
          {
            id: 'edit',
            icon: <IconPencil size={14} />,
            label: t('edit'),
            onClick: () => openEdit(r),
          },
          { divider: true as const },
          {
            id: 'delete',
            icon: <IconTrash size={14} />,
            label: t('delete'),
            destructive: true,
            onClick: () => remove.mutate({ id: r.id }),
          },
        ]
      : [];

  const columnsWithActions = useMemo<ColumnDef<(typeof rows)[number], ColumnId | 'actions'>[]>(
    () => [
      ...(columns as ColumnDef<(typeof rows)[number], ColumnId | 'actions'>[]),
      {
        id: 'actions',
        label: '',
        defaultWidth: 60,
        hideable: false,
        draggable: false,
        resizable: false,
        pinnable: false,
        cell: (r) =>
          canManage ? (
            <div className="flex justify-end">
              <RowActionsMenu ariaLabel={t('actions')} actions={rowActions(r)} />
            </div>
          ) : null,
      },
    ],
    [columns, canManage, t],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
          labels={pillBar.chromeLabels}
          filters={pillBar.filters}
          fields={pillBar.filterFields}
          fieldLabels={pillBar.filterLabels}
          fieldKinds={pillBar.filterKinds}
          options={pillBar.filterOptions}
          onUpdateOp={pillBar.updateClauseOp}
          onUpdateValue={pillBar.updateClauseValue}
          onRemoveClause={pillBar.removeClause}
          onAddClause={pillBar.addClause}
          onClearAll={pillBar.clearClauses}
          clearLabel={pillBar.clearLabel}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          resultCount={filteredRows.length}
          loading={list.isLoading}
          rightSlot={
            <TableSettingsButton<ColumnId | 'actions', string>
              columnOrder={columnsWithActions.map((c) => c.id)}
              columnVisibility={
                tableState.columnVisibility as Record<ColumnId | 'actions', boolean>
              }
              onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
              columnLabelFor={(c) => columnsWithActions.find((col) => col.id === c)?.label ?? c}
              density={tableState.density}
              onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
              onReset={() =>
                setTableState((s) => ({
                  ...s,
                  columnVisibility: {},
                  columnWidths: {},
                  density: 'normal',
                }))
              }
              labels={tableLabels.settings}
            />
          }
        />
        <DataTable<(typeof rows)[number], ColumnId | 'actions'>
          columns={columnsWithActions}
          rows={filteredRows}
          rowKey={(r) => r.id}
          totalCount={filteredRows.length}
          state={tableState as DataTableState<ColumnId | 'actions'>}
          onStateChange={setTableState as never}
          onRowClick={(r) => canManage && openEdit(r)}
          loading={list.isLoading}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('emptyBody')}</div>
            </div>
          )}
        />
      </div>

      {editing && (
        <RateDrawer
          initial={editing.form}
          isNew={editing.id === null}
          pending={create.isPending || update.isPending}
          categoryItems={categoryItems}
          jobLevelItems={jobLevelItems}
          legalEntityItems={legalEntityItems}
          businessUnitItems={businessUnitItems}
          currencyItems={currencyItems}
          onClose={() => setEditing(null)}
          onSave={(form) => {
            const patch = {
              country: form.country.trim().toUpperCase(),
              city: form.city.trim(),
              categoryId: form.categoryId ?? '',
              amountMinor:
                majorToMinor(form.amount, currencyFor(form.currencyId).code, locale) ?? 0n,
              firstLastDay: form.firstLastDay,
              effectiveFrom: new Date(form.effectiveFrom),
              effectiveTo: form.effectiveTo ? new Date(form.effectiveTo) : null,
              jobLevelId: form.jobLevelId,
              legalEntityId: form.legalEntityId,
              businessUnitId: form.businessUnitId,
              currencyId: form.currencyId,
            };
            const done = () => setEditing(null);
            if (editing.id) update.mutate({ id: editing.id, patch }, { onSuccess: done });
            else create.mutate(patch, { onSuccess: done });
          }}
        />
      )}
    </div>
  );
}

type Item = { value: string; label: string };

function RateDrawer({
  initial,
  isNew,
  pending,
  categoryItems,
  jobLevelItems,
  legalEntityItems,
  businessUnitItems,
  currencyItems,
  onClose,
  onSave,
}: {
  initial: FormData;
  isNew: boolean;
  pending: boolean;
  categoryItems: Item[];
  jobLevelItems: Item[];
  legalEntityItems: Item[];
  businessUnitItems: Item[];
  currencyItems: Item[];
  onClose: () => void;
  onSave: (form: FormData) => void;
}) {
  const t = useTranslations('perDiem');
  const [form, setForm] = useState<FormData>(initial);
  const set = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid =
    form.country.trim().length === 2 &&
    form.city.trim().length > 0 &&
    form.categoryId !== null &&
    form.amount.trim() !== '' &&
    form.effectiveFrom !== '';

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent width={520}>
        <DrawerHeader>
          <DrawerTitle>{isNew ? t('add') : t('edit')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="pd-country" label={t('field.country')} required>
              <Input
                id="pd-country"
                value={form.country}
                maxLength={2}
                placeholder="US"
                onChange={(e) => set('country', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField htmlFor="pd-city" label={t('field.city')} required>
              <Input
                id="pd-city"
                value={form.city}
                placeholder="New York"
                onChange={(e) => set('city', e.target.value)}
              />
            </FormField>
            <FormField htmlFor="pd-currency" label={t('field.currency')} optional>
              <Combobox
                id="pd-currency"
                items={currencyItems}
                value={form.currencyId}
                onValueChange={(v) => set('currencyId', v)}
                placeholder={t('field.policyCurrency')}
              />
            </FormField>
            <div />
            <FormField htmlFor="pd-category" label={t('field.category')} required>
              <Combobox
                id="pd-category"
                items={categoryItems}
                value={form.categoryId}
                onValueChange={(v) => set('categoryId', v)}
                placeholder={t('field.categoryPlaceholder')}
              />
            </FormField>
            <FormField htmlFor="pd-amount" label={t('field.amount')} required>
              <Input
                id="pd-amount"
                value={form.amount}
                inputMode="decimal"
                placeholder="75.00"
                onChange={(e) => set('amount', e.target.value)}
              />
            </FormField>
            <FormField htmlFor="pd-from" label={t('field.effectiveFrom')} required>
              <Input
                id="pd-from"
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => set('effectiveFrom', e.target.value)}
              />
            </FormField>
            <FormField htmlFor="pd-to" label={t('field.effectiveTo')} optional>
              <Input
                id="pd-to"
                type="date"
                value={form.effectiveTo}
                onChange={(e) => set('effectiveTo', e.target.value)}
              />
            </FormField>
          </div>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: the control (Checkbox) is nested as children */}
          <label className="flex items-center gap-2 text-foreground text-sm">
            {/* VeloExpense: named by aria-label — Base UI's checkbox is a span its <label> does not name (f10). */}
            <Checkbox
              aria-label={t('field.firstLastDay')}
              checked={form.firstLastDay}
              onCheckedChange={(c) => set('firstLastDay', c === true)}
            />
            {t('field.firstLastDay')}
          </label>

          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="font-medium text-foreground text-xs">{t('scopeTitle')}</p>
            <p className="text-[11px] text-muted-foreground">{t('scopeHint')}</p>
            <FormField htmlFor="pd-jl" label={t('field.jobLevel')} optional>
              <Combobox
                id="pd-jl"
                items={jobLevelItems}
                value={form.jobLevelId}
                onValueChange={(v) => set('jobLevelId', v)}
                placeholder={t('scope.anyLevel')}
              />
            </FormField>
            <FormField htmlFor="pd-le" label={t('field.legalEntity')} optional>
              <Combobox
                id="pd-le"
                items={legalEntityItems}
                value={form.legalEntityId}
                onValueChange={(v) => set('legalEntityId', v)}
                placeholder={t('scope.any')}
              />
            </FormField>
            <FormField htmlFor="pd-bu" label={t('field.businessUnit')} optional>
              <Combobox
                id="pd-bu"
                items={businessUnitItems}
                value={form.businessUnitId}
                onValueChange={(v) => set('businessUnitId', v)}
                placeholder={t('scope.any')}
              />
            </FormField>
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="sm" disabled={!valid || pending} onClick={() => onSave(form)}>
            {pending ? t('saving') : t('save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

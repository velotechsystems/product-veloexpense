// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; the t() functions are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/fiscal-years — standalone DataTable page.
 *
 * Beyond the usual Toolbar + DataTable + Drawer shell, this page does
 * four FY-specific things:
 *
 *   1. Row-actions kebab pinned to the right edge of the label cell
 *      (flex-1 trick — same as JobLevels / Departments).
 *   2. External IDs editable in the drawer + displayed as pills in the
 *      table column and the view drawer.
 *   3. Auto-prefills the date range when an admin opens "Add fiscal
 *      year": startDate = (last FY's endDate) + 1 day, endDate =
 *      startDate + 1 year - 1 day. Admin can override.
 *   4. Calls `advanceCurrent` on mount so the admin-set `isCurrent`
 *      flag tracks the calendar without requiring a manual click. A
 *      "Current by date" badge in the status column highlights any FY
 *      whose range actually contains today; when that diverges from
 *      `isCurrent`, a banner offers a one-click fix.
 */
import {
  Badge,
  Button,
  Checkbox,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ExternalIdsBlock,
  ExternalIdsCell,
  FilterPillBar,
  Field as FormField,
  IconEdit,
  IconPlus,
  Input,
  RowActionsMenu,
  TableSettingsButton,
} from '@expenseos/design-system';
import { ENABLED_LOCALES, type Locale } from '@expenseos/i18n/locales';
import { IconCheck, IconEye, IconTrash } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTopBarSlots } from '@/app/(app)/TopBar';
import { Field, pickLabel, Section } from '@/components/admin/AdminLookupPage';
import {
  type ExternalIdEntry,
  entriesFromMap,
  mapFromEntries,
} from '@/components/admin/ExternalIdsEditor';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { TableExportMenu, useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { ExternalIdsField } from '@/components/external-ids/ExternalIdsField';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';

/** VeloExpense: whether admins are asked for (and shown) French text (`ENABLED_LOCALES`, 7 Oct). */
const FRENCH_ON = ENABLED_LOCALES.includes('fr-CA');

interface FiscalYearRow {
  id: string;
  label: unknown;
  startDate: Date | string;
  endDate: Date | string;
  isCurrent: boolean;
  closed: boolean;
  externalIds: Record<string, string>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

type ColumnId = 'label' | 'startDate' | 'endDate' | 'externalIds' | 'status';
type DrawerMode = 'closed' | 'view' | 'edit' | 'create';

interface FormData {
  labelEn: string;
  labelFr: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  isCurrent: boolean;
  closed: boolean;
  externalIds: ExternalIdEntry[];
}

const EMPTY_FORM: FormData = {
  labelEn: '',
  labelFr: '',
  startDate: '',
  endDate: '',
  isCurrent: false,
  closed: false,
  externalIds: [],
};

function toISODate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Add (delta) days to an ISO date, return the new ISO date. Empty for an
 *  unparseable input — see `defaultEndDate`. */
function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Add one year minus one day so [startDate, endDate] covers exactly 12 months.
 *
 * Returns '' when the input is not a date. That guard is load-bearing: the start-date
 * field re-derives the end date on every change, so CLEARING it called this with an
 * empty string — and `new Date('T00:00:00Z').toISOString()` throws `RangeError:
 * Invalid time value`, which took the whole drawer down mid-edit.
 */
function defaultEndDate(startISO: string): string {
  const d = new Date(`${startISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** ISO date for today (UTC). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when `today` falls inside [startDate, endDate] inclusive. */
function isCurrentByDate(row: FiscalYearRow, todayIso = todayISO()): boolean {
  return toISODate(row.startDate) <= todayIso && todayIso <= toISODate(row.endDate);
}

function rowToForm(row: FiscalYearRow): FormData {
  const lbl = (row.label ?? {}) as Record<string, string>;
  return {
    labelEn: lbl.en ?? '',
    labelFr: lbl['fr-CA'] ?? '',
    startDate: toISODate(row.startDate),
    endDate: toISODate(row.endDate),
    isCurrent: row.isCurrent,
    closed: row.closed,
    externalIds: entriesFromMap(row.externalIds ?? {}),
  };
}

export function FiscalYearsAdmin({ canEdit }: { canEdit: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const tableLabels = useTableLabels();
  const tc = useTranslations('admin.common');
  const refusalText = useRefusalText(); // VeloExpense: see onSave's catch.
  const tf = useTranslations('admin.fiscalYears');
  const locale = useLocale() as Locale;
  const utils = trpc.useUtils();
  const query = trpc.appSettings.fiscalYears.list.useQuery();
  const allRows = (query.data ?? []) as unknown as FiscalYearRow[];

  const createMutation = trpc.appSettings.fiscalYears.create.useMutation({
    onSuccess: () => utils.appSettings.fiscalYears.list.invalidate(),
  });
  const updateMutation = trpc.appSettings.fiscalYears.update.useMutation({
    onSuccess: () => utils.appSettings.fiscalYears.list.invalidate(),
  });
  const setCurrentMutation = trpc.appSettings.fiscalYears.setCurrent.useMutation({
    onSuccess: () => utils.appSettings.fiscalYears.list.invalidate(),
  });
  const advanceMutation = trpc.appSettings.fiscalYears.advanceCurrent.useMutation({
    onSuccess: (res) => {
      if (res.changed) utils.appSettings.fiscalYears.list.invalidate();
    },
  });
  const deleteMutation = trpc.appSettings.fiscalYears.delete.useMutation({
    onSuccess: () => utils.appSettings.fiscalYears.list.invalidate(),
    onError: (e) => window.alert(e.message),
  });

  // Auto-flip `isCurrent` to whichever FY's range contains today. Fired
  // once per mount; the mutation is idempotent (no-op when already
  // correct, or when no FY covers today). A daily cron in apps/worker
  // would do the same thing — this UI-level call keeps the dashboard in
  // sync between cron ticks.
  const advanceFiredRef = useRef(false);
  useEffect(() => {
    if (!canEdit || advanceFiredRef.current) return;
    if (query.isLoading || allRows.length === 0) return;
    advanceFiredRef.current = true;
    advanceMutation.mutate();
  }, [canEdit, query.isLoading, allRows.length, advanceMutation.mutate]);

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed');
  const [selectedRow, setSelectedRow] = useState<FiscalYearRow | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openView = (row: FiscalYearRow) => {
    setSelectedRow(row);
    setSaveError(null);
    setDrawerMode('view');
  };
  const openEdit = (row: FiscalYearRow) => {
    setSelectedRow(row);
    setForm(rowToForm(row));
    setSaveError(null);
    setDrawerMode('edit');
  };
  const openCreate = () => {
    setSelectedRow(null);
    // Auto-prefill: pick up from the last fiscal year's endDate + 1 day.
    // Falls back to today / +1 year when there are no FYs yet.
    const latestEnd = allRows.reduce<string | null>((acc, r) => {
      const iso = toISODate(r.endDate);
      return acc === null || iso > acc ? iso : acc;
    }, null);
    const startDate = latestEnd ? addDaysISO(latestEnd, 1) : todayISO();
    const endDate = defaultEndDate(startDate);
    setForm({ ...EMPTY_FORM, startDate, endDate });
    setSaveError(null);
    setDrawerMode('create');
  };
  const closeDrawer = () => {
    setDrawerMode('closed');
    setSelectedRow(null);
    setSaveError(null);
  };

  const setCurrent = async (row: FiscalYearRow) => {
    await setCurrentMutation.mutateAsync({ id: row.id });
  };
  const deleteRow = async (row: FiscalYearRow) => {
    if (!window.confirm(tf('confirmDelete', { name: pickLabel(row.label, locale) || row.id })))
      return;
    await deleteMutation.mutateAsync({ id: row.id });
  };

  const columns: ColumnDef<FiscalYearRow, ColumnId>[] = useMemo(
    () => [
      {
        id: 'label',
        label: tf('fiscalYear'),
        defaultWidth: 280,
        sortable: true,
        filterable: { kind: 'text' },
        hideable: false,
        exportValue: (row) => pickLabel(row.label, locale) || tc('unnamed'),
        cell: (row) => (
          // flex-1 wrapper pushes the kebab to the right edge of the cell.
          <div className="flex w-full items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="whitespace-normal break-words font-medium text-foreground text-sm">
                {pickLabel(row.label, locale) || tc('unnamed')}
              </div>
            </div>
            <RowActionsMenu
              ariaLabel={tc('rowActions')}
              actions={[
                {
                  id: 'view',
                  icon: <IconEye size={14} />,
                  label: tc('view'),
                  onClick: () => openView(row),
                },
                ...(canEdit
                  ? [
                      {
                        id: 'edit',
                        icon: <IconEdit size={14} />,
                        label: tc('edit'),
                        onClick: () => openEdit(row),
                      },
                      ...(row.isCurrent
                        ? []
                        : [
                            {
                              id: 'setCurrent',
                              icon: <IconCheck size={14} />,
                              label: tf('setCurrent'),
                              onClick: () => setCurrent(row),
                            },
                          ]),
                      { divider: true as const },
                      {
                        id: 'delete',
                        icon: <IconTrash size={14} />,
                        label: tc('delete'),
                        destructive: true,
                        disabled: row.isCurrent,
                        onClick: () => deleteRow(row),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ),
      },
      {
        id: 'startDate',
        label: tf('start'),
        defaultWidth: 130,
        sortable: true,
        exportValue: (row) => toISODate(row.startDate),
        cell: (row) => (
          <span className="font-mono text-foreground text-sm">{toISODate(row.startDate)}</span>
        ),
      },
      {
        id: 'endDate',
        label: tf('end'),
        defaultWidth: 130,
        sortable: true,
        exportValue: (row) => toISODate(row.endDate),
        cell: (row) => (
          <span className="font-mono text-foreground text-sm">{toISODate(row.endDate)}</span>
        ),
      },
      {
        id: 'externalIds',
        label: tc('externalIds'),
        defaultWidth: 220,
        exportValue: (row) =>
          Object.entries(row.externalIds ?? {})
            .map(([system, id]) => `${system}: ${id}`)
            .join('; '),
        cell: (row) => <ExternalIdsCell value={row.externalIds} />,
      },
      {
        id: 'status',
        label: tc('status'),
        defaultWidth: 160,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: 'current', label: tf('statusCurrent') },
            { value: 'closed', label: tf('statusClosed') },
            { value: 'open', label: tf('statusOpen') },
            { value: 'byDate', label: tf('statusByDate') },
          ],
        },
        exportValue: (row) =>
          row.isCurrent ? tf('statusCurrent') : row.closed ? tf('statusClosed') : tf('statusOpen'),
        cell: (row) => {
          const byDate = isCurrentByDate(row);
          return (
            <div className="flex flex-wrap items-center gap-1">
              {row.isCurrent ? (
                <Badge variant="success">{tf('statusCurrent')}</Badge>
              ) : row.closed ? (
                <Badge variant="secondary">{tf('statusClosed')}</Badge>
              ) : (
                <Badge variant="outline">{tf('statusOpen')}</Badge>
              )}
              {byDate && !row.isCurrent && (
                <Badge variant="outline" className="border-warning text-warning">
                  {tf('byDateBadge')}
                </Badge>
              )}
            </div>
          );
        },
      },
    ],
    [locale, canEdit, openEdit, openView, setCurrent, deleteRow],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {
      sort: { field: 'startDate', dir: 'desc' },
    }),
  );

  const rows = useMemo(() => {
    const labelClauses = tableState.filters.filter((c) => c.field === 'label');
    const statusClauses = tableState.filters.filter((c) => c.field === 'status');
    let filtered = allRows;
    if (statusClauses.length > 0) {
      const wantCurrent = statusClauses.some((c) => c.op === 'equals' && c.value === 'current');
      const wantClosed = statusClauses.some((c) => c.op === 'equals' && c.value === 'closed');
      const wantOpen = statusClauses.some((c) => c.op === 'equals' && c.value === 'open');
      const wantByDate = statusClauses.some((c) => c.op === 'equals' && c.value === 'byDate');
      filtered = filtered.filter((r) => {
        if (wantByDate && isCurrentByDate(r)) return true;
        if (r.isCurrent) return wantCurrent;
        if (r.closed) return wantClosed;
        return wantOpen;
      });
    }
    for (const c of labelClauses) {
      if (c.op === 'contains') {
        const needle = c.value.toLowerCase();
        filtered = filtered.filter((r) =>
          (pickLabel(r.label, locale) || '').toLowerCase().includes(needle),
        );
      }
    }
    return filtered;
  }, [allRows, tableState.filters, locale]);

  // Detect a calendar / admin-flag divergence: the FY containing today
  // exists but is NOT marked isCurrent (typical end-of-year handoff
  // window). Surface a one-click banner so the admin can fix it
  // immediately without scrolling the table.
  const diverged = useMemo(() => {
    const byDate = allRows.find((r) => isCurrentByDate(r));
    if (!byDate || byDate.isCurrent) return null;
    return byDate;
  }, [allRows]);

  useTopBarSlots(
    () => ({
      right: canEdit ? (
        <Button onClick={openCreate} size="sm">
          <IconPlus size={14} className="mr-1" />
          {tf('addFiscalYear')}
        </Button>
      ) : null,
    }),
    [canEdit, tf],
  );

  const onSave = async () => {
    setSaveError(null);
    // VeloExpense: the French label is asked for only while French is switched on
    // (`ENABLED_LOCALES`, 7 Oct), as on the categories and lookup screens.
    if (form.labelEn.trim().length === 0 || (FRENCH_ON && form.labelFr.trim().length === 0)) {
      setSaveError(tc(FRENCH_ON ? 'bothLabelsRequired' : 'labelEnRequired'));
      return;
    }
    if (!form.startDate || !form.endDate) {
      setSaveError(tf('datesRequired'));
      return;
    }
    if (form.endDate <= form.startDate) {
      setSaveError(tf('endAfterStart'));
      return;
    }
    try {
      // VeloExpense: an unnamed French label is omitted rather than sent empty.
      const label = {
        en: form.labelEn.trim(),
        ...(form.labelFr.trim() ? { 'fr-CA': form.labelFr.trim() } : {}),
      };
      const payload = {
        label,
        startDate: new Date(`${form.startDate}T00:00:00Z`),
        endDate: new Date(`${form.endDate}T00:00:00Z`),
        isCurrent: form.isCurrent,
        closed: form.closed,
        externalIds: mapFromEntries(form.externalIds),
      };
      if (drawerMode === 'edit' && selectedRow) {
        await updateMutation.mutateAsync({ id: selectedRow.id, patch: payload });
      } else if (drawerMode === 'create') {
        await createMutation.mutateAsync(payload);
      }
      closeDrawer();
    } catch (err) {
      // VeloExpense: through `useRefusalText` (lib/trpc/refusal.ts) — a catalogued refusal
      // in the reader's language, else the error's own sentence — rather than reading
      // `err.message` here (check:i18n).
      setSaveError(refusalText(err, tc('unknownError')));
    }
  };

  const drawerOpen = drawerMode !== 'closed';
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const pillBar = useFilterPillBarWiring<FiscalYearRow, ColumnId>(
    columns,
    tableState,
    setTableState,
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Divergence banner — shown only when a non-current FY actually
          contains today. Background advanceCurrent is async; this banner
          covers the in-between moment + the case where no FY is marked
          current at all. */}
      {diverged && canEdit && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-warning bg-warning/10 px-4 py-2 text-sm">
          <div>
            <span className="font-medium text-foreground">
              {pickLabel(diverged.label, locale) || diverged.id}
            </span>{' '}
            <span className="text-muted-foreground">{tf('divergesText')}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCurrent(diverged)}
            disabled={setCurrentMutation.isPending}
          >
            <IconCheck size={14} className="mr-1" />
            {tf('advance')}
          </Button>
        </div>
      )}

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
          selectedCount={tableState.selectedIds.size}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<FiscalYearRow, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="fiscal-years"
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
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
            </>
          }
        />

        <DataTable<FiscalYearRow, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={openView}
          activeRowId={selectedRow?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{tf('empty')}</div>}
          selectable={false}
        />
      </div>

      <Drawer
        open={drawerOpen}
        onOpenChange={(next) => {
          if (!next) closeDrawer();
        }}
      >
        <DrawerContent width={560} resizable storageKey="admin.fiscalYears">
          <DrawerHeader>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate">
                {drawerMode === 'create'
                  ? tf('addTitle')
                  : drawerMode === 'edit'
                    ? tf('editTitle')
                    : selectedRow
                      ? pickLabel(selectedRow.label, locale) || selectedRow.id
                      : ''}
              </DrawerTitle>
              {selectedRow && (
                <div className="mt-0.5 flex items-center gap-2">
                  {selectedRow.isCurrent ? (
                    <Badge variant="success">{tf('statusCurrent')}</Badge>
                  ) : selectedRow.closed ? (
                    <Badge variant="secondary">{tf('statusClosed')}</Badge>
                  ) : (
                    <Badge variant="outline">{tf('statusOpen')}</Badge>
                  )}
                  {isCurrentByDate(selectedRow) && !selectedRow.isCurrent && (
                    <Badge variant="outline" className="border-warning text-warning">
                      {tf('byDateBadge')}
                    </Badge>
                  )}
                </div>
              )}
            </div>
            {drawerMode === 'view' && canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectedRow && openEdit(selectedRow)}
              >
                <IconEdit size={14} className="mr-1" />
                {tc('edit')}
              </Button>
            )}
          </DrawerHeader>

          {drawerMode === 'view' && selectedRow ? (
            <DrawerBody className="space-y-6">
              <Section title={tc('identity')}>
                <Field label={tc('labelEn')}>
                  {(selectedRow.label as Record<string, string> | undefined)?.en ?? '—'}
                </Field>
                {/* VeloExpense: the French row is shown only while French is on. */}
                {FRENCH_ON && (
                  <Field label={tc('labelFr')}>
                    {(selectedRow.label as Record<string, string> | undefined)?.['fr-CA'] ?? '—'}
                  </Field>
                )}
                <Field label={tf('startDate')}>{toISODate(selectedRow.startDate)}</Field>
                <Field label={tf('endDate')}>{toISODate(selectedRow.endDate)}</Field>
                <Field label={tc('status')}>
                  {selectedRow.isCurrent
                    ? tf('statusCurrent')
                    : selectedRow.closed
                      ? tf('statusClosed')
                      : tf('statusOpen')}
                </Field>
              </Section>
              <Section title={tc('externalIds')}>
                <ExternalIdsBlock value={selectedRow.externalIds} />
              </Section>
            </DrawerBody>
          ) : (
            <>
              <DrawerBody className="space-y-4">
                {saveError && <p className="text-destructive text-sm">{saveError}</p>}
                <div className="grid grid-cols-2 gap-4">
                  <FormField htmlFor="fy-labelEn" label={tc('labelEn')} required>
                    <Input
                      id="fy-labelEn"
                      value={form.labelEn}
                      onChange={(e) => setForm({ ...form, labelEn: e.target.value })}
                      placeholder={tf('labelEnPlaceholder')}
                      autoFocus
                    />
                  </FormField>
                  {/* VeloExpense: asked for only while French is on. */}
                  {FRENCH_ON && (
                    <FormField htmlFor="fy-labelFr" label={tc('labelFr')} required>
                      <Input
                        id="fy-labelFr"
                        value={form.labelFr}
                        onChange={(e) => setForm({ ...form, labelFr: e.target.value })}
                        placeholder={tf('labelFrPlaceholder')}
                      />
                    </FormField>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField htmlFor="fy-startDate" label={tf('startDate')} required>
                    <Input
                      id="fy-startDate"
                      type="date"
                      value={form.startDate}
                      onChange={(e) => {
                        const startDate = e.target.value;
                        // Auto-bump endDate to keep the 12-month default whenever
                        // the user re-picks startDate before touching endDate.
                        const shouldBumpEnd =
                          !form.endDate ||
                          (drawerMode === 'create' &&
                            form.endDate === defaultEndDate(form.startDate || startDate));
                        setForm({
                          ...form,
                          startDate,
                          endDate: shouldBumpEnd ? defaultEndDate(startDate) : form.endDate,
                        });
                      }}
                    />
                  </FormField>
                  <FormField htmlFor="fy-endDate" label={tf('endDate')} required>
                    <Input
                      id="fy-endDate"
                      type="date"
                      value={form.endDate}
                      onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    />
                  </FormField>
                </div>
                <FormField
                  htmlFor="fy-isCurrent"
                  label={tf('currentFY')}
                  controlPosition="inline-leading"
                  description={tf('currentFYHelp')}
                >
                  <Checkbox
                    id="fy-isCurrent"
                    checked={form.isCurrent}
                    onCheckedChange={(v) => setForm({ ...form, isCurrent: v === true })}
                  />
                </FormField>
                <FormField
                  htmlFor="fy-closed"
                  label={tf('closed')}
                  controlPosition="inline-leading"
                  description={tf('closedHelp')}
                >
                  <Checkbox
                    id="fy-closed"
                    checked={form.closed}
                    onCheckedChange={(v) => setForm({ ...form, closed: v === true })}
                  />
                </FormField>
                <FormField label={tc('externalIds')}>
                  <ExternalIdsField
                    entries={form.externalIds}
                    onChange={(entries) => setForm({ ...form, externalIds: entries })}
                  />
                </FormField>
              </DrawerBody>
              <DrawerFooter>
                <Button variant="ghost" onClick={closeDrawer} disabled={isSaving}>
                  {tc('cancel')}
                </Button>
                <Button onClick={onSave} disabled={isSaving}>
                  {isSaving
                    ? tc('saving')
                    : drawerMode === 'create'
                      ? tc('create')
                      : tc('saveChanges')}
                </Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; the t() functions and memoized track options are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/job-levels — standalone DataTable page (replaces the embedded
 * card under Platform Settings). Same shell as the other admin pages:
 * Toolbar (Add / SelectionCounter / Export / TableSettings) + DataTable
 * + right-Drawer for view / edit / create.
 *
 * `sortOrder` is server-managed: admins don't see it as a column, and
 * the create drawer omits it (the router auto-assigns `max + 1`). The
 * column survives in the schema so the list stays in stable insertion
 * order — but it's not a knob users have to think about.
 *
 * Identity surface: `code` (short canonical) + `track` (career path) + the
 * locale-keyed `label`. External IDs are edited via the shared
 * ExternalIdsEditor and displayed as pills in the table + view drawer.
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
  Radio,
  RadioGroup,
  RowActionsMenu,
  TableSettingsButton,
} from '@expenseos/design-system';
import { ENABLED_LOCALES, type Locale } from '@expenseos/i18n/locales';
import { IconEye, IconRestore, IconTrash, IconUserOff } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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

type JobLevelTrack = 'INDIVIDUAL_CONTRIBUTOR' | 'MANAGER' | 'EXECUTIVE' | 'BOARD';

const TRACK_KEYS: Record<JobLevelTrack, string> = {
  INDIVIDUAL_CONTRIBUTOR: 'tracks.individualContributor',
  MANAGER: 'tracks.manager',
  EXECUTIVE: 'tracks.executive',
  BOARD: 'tracks.board',
};

interface JobLevelRow {
  id: string;
  code: string;
  track: JobLevelTrack;
  label: unknown;
  sortOrder: number;
  active: boolean;
  externalIds: Record<string, string>;
  createdAt: Date | string;
  updatedAt: Date | string;
}

type ColumnId = 'code' | 'label' | 'track' | 'externalIds' | 'status';
type DrawerMode = 'closed' | 'view' | 'edit' | 'create';

interface FormData {
  code: string;
  track: JobLevelTrack;
  labelEn: string;
  labelFr: string;
  active: boolean;
  externalIds: ExternalIdEntry[];
}

const EMPTY_FORM: FormData = {
  code: '',
  track: 'INDIVIDUAL_CONTRIBUTOR',
  labelEn: '',
  labelFr: '',
  active: true,
  externalIds: [],
};

function rowToForm(row: JobLevelRow): FormData {
  const lbl = (row.label ?? {}) as Record<string, string>;
  return {
    code: row.code,
    track: row.track,
    labelEn: lbl.en ?? '',
    labelFr: lbl['fr-CA'] ?? '',
    active: row.active,
    externalIds: entriesFromMap(row.externalIds ?? {}),
  };
}

export function JobLevelsAdmin({ canEdit }: { canEdit: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const tableLabels = useTableLabels();
  const tc = useTranslations('admin.common');
  const refusalText = useRefusalText(); // VeloExpense: see onSave's catch.
  const tj = useTranslations('admin.jobLevels');
  const locale = useLocale() as Locale;
  const trackLabel = (track: JobLevelTrack) => tj(TRACK_KEYS[track]);
  const trackOptions = useMemo(
    () =>
      (Object.keys(TRACK_KEYS) as JobLevelTrack[]).map((value) => ({
        value,
        label: tj(TRACK_KEYS[value]),
      })),
    [tj],
  );
  const utils = trpc.useUtils();
  const query = trpc.appSettings.jobLevels.list.useQuery();
  const allRows = (query.data ?? []) as unknown as JobLevelRow[];

  const createMutation = trpc.appSettings.jobLevels.create.useMutation({
    onSuccess: () => utils.appSettings.jobLevels.list.invalidate(),
  });
  const updateMutation = trpc.appSettings.jobLevels.update.useMutation({
    onSuccess: () => utils.appSettings.jobLevels.list.invalidate(),
  });
  const deleteMutation = trpc.appSettings.jobLevels.delete.useMutation({
    onSuccess: () => utils.appSettings.jobLevels.list.invalidate(),
    onError: (e) => window.alert(e.message),
  });

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed');
  const [selectedRow, setSelectedRow] = useState<JobLevelRow | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openView = (row: JobLevelRow) => {
    setSelectedRow(row);
    setSaveError(null);
    setDrawerMode('view');
  };
  const openEdit = (row: JobLevelRow) => {
    setSelectedRow(row);
    setForm(rowToForm(row));
    setSaveError(null);
    setDrawerMode('edit');
  };
  const openCreate = () => {
    setSelectedRow(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setDrawerMode('create');
  };
  const closeDrawer = () => {
    setDrawerMode('closed');
    setSelectedRow(null);
    setSaveError(null);
  };

  const toggleActive = async (row: JobLevelRow) => {
    await updateMutation.mutateAsync({ id: row.id, patch: { active: !row.active } });
  };
  const deleteRow = async (row: JobLevelRow) => {
    if (!window.confirm(tj('confirmDelete', { name: pickLabel(row.label, locale) || row.code })))
      return;
    // The mutation's `onError` already reports a refusal (the server rejects a level
    // that per-diem rates or approval filters still reference). Swallowing the rejection
    // here is what keeps that from ALSO surfacing as an unhandled promise, since the
    // click handler discards the returned promise.
    await deleteMutation.mutateAsync({ id: row.id }).catch(() => undefined);
  };

  const columns: ColumnDef<JobLevelRow, ColumnId>[] = useMemo(
    () => [
      {
        id: 'code',
        label: tc('code'),
        defaultWidth: 90,
        sortable: true,
        filterable: { kind: 'text' },
        hideable: false,
        exportValue: (row) => row.code,
        cell: (row) => (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
            {row.code}
          </span>
        ),
      },
      {
        id: 'label',
        label: tc('label'),
        defaultWidth: 280,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (row) => pickLabel(row.label, locale) || tc('unnamed'),
        cell: (row) => (
          // flex-1 on the label container so RowActionsMenu lands on the
          // right edge of the cell rather than gluing to the label text.
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
                      { divider: true as const },
                      {
                        id: 'toggle',
                        icon: row.active ? <IconUserOff size={14} /> : <IconRestore size={14} />,
                        label: row.active ? tc('deactivate') : tc('reactivate'),
                        onClick: () => toggleActive(row),
                      },
                      {
                        id: 'delete',
                        icon: <IconTrash size={14} />,
                        label: tc('delete'),
                        destructive: true,
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
        id: 'track',
        label: tj('trackColumn'),
        defaultWidth: 180,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: trackOptions,
        },
        exportValue: (row) => trackLabel(row.track),
        cell: (row) => (
          <Badge variant="secondary" className="text-[11px]">
            {trackLabel(row.track)}
          </Badge>
        ),
      },
      {
        id: 'externalIds',
        label: tc('externalIds'),
        defaultWidth: 220,
        exportValue: (row) =>
          Object.entries(row.externalIds ?? {})
            .map(([system, value]) => `${system}: ${value}`)
            .join('; '),
        cell: (row) => <ExternalIdsCell value={row.externalIds} />,
      },
      {
        id: 'status',
        label: tc('status'),
        defaultWidth: 110,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: 'active', label: tc('active') },
            { value: 'inactive', label: tc('inactive') },
          ],
        },
        exportValue: (row) => (row.active ? tc('active') : tc('inactive')),
        cell: (row) => (
          <Badge variant={row.active ? 'success' : 'secondary'}>
            {row.active ? tc('active') : tc('inactive')}
          </Badge>
        ),
      },
    ],
    [locale, canEdit, toggleActive, openEdit, openView, deleteRow],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  const rows = useMemo(() => {
    // Lightweight client-side filter — small dataset (~14 rows).
    const codeClauses = tableState.filters.filter((c) => c.field === 'code');
    const labelClauses = tableState.filters.filter((c) => c.field === 'label');
    const statusClauses = tableState.filters.filter((c) => c.field === 'status');
    const trackClauses = tableState.filters.filter((c) => c.field === 'track');
    let filtered = allRows;
    if (statusClauses.length > 0) {
      const wantActive = statusClauses.some(
        (c) =>
          (c.op === 'equals' && c.value === 'active') ||
          (c.op === 'doesNotEqual' && c.value === 'inactive'),
      );
      const wantInactive = statusClauses.some(
        (c) =>
          (c.op === 'equals' && c.value === 'inactive') ||
          (c.op === 'doesNotEqual' && c.value === 'active'),
      );
      if (wantActive && !wantInactive) filtered = filtered.filter((r) => r.active);
      else if (wantInactive && !wantActive) filtered = filtered.filter((r) => !r.active);
    }
    for (const c of trackClauses) {
      if (c.op === 'equals') filtered = filtered.filter((r) => r.track === c.value);
      else if (c.op === 'doesNotEqual') filtered = filtered.filter((r) => r.track !== c.value);
    }
    for (const c of codeClauses) {
      if (c.op === 'contains') {
        const needle = c.value.toLowerCase();
        filtered = filtered.filter((r) => r.code.toLowerCase().includes(needle));
      }
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

  useTopBarSlots(
    () => ({
      right: canEdit ? (
        <Button onClick={openCreate} size="sm">
          <IconPlus size={14} className="mr-1" />
          {tj('addLevel')}
        </Button>
      ) : null,
    }),
    [canEdit, tj],
  );

  const onSave = async () => {
    setSaveError(null);
    if (form.code.trim().length === 0) {
      setSaveError(tj('codeRequired'));
      return;
    }
    // VeloExpense: the French label is asked for only while French is switched on
    // (`ENABLED_LOCALES`, 7 Oct), as on the categories and lookup screens.
    if (form.labelEn.trim().length === 0 || (FRENCH_ON && form.labelFr.trim().length === 0)) {
      setSaveError(tc(FRENCH_ON ? 'bothLabelsRequired' : 'labelEnRequired'));
      return;
    }
    try {
      // VeloExpense: an unnamed French label is omitted rather than sent empty.
      const label = {
        en: form.labelEn.trim(),
        ...(form.labelFr.trim() ? { 'fr-CA': form.labelFr.trim() } : {}),
      };
      const externalIds = mapFromEntries(form.externalIds);
      if (drawerMode === 'edit' && selectedRow) {
        await updateMutation.mutateAsync({
          id: selectedRow.id,
          patch: {
            code: form.code.trim(),
            track: form.track,
            label,
            active: form.active,
            externalIds,
          },
        });
      } else if (drawerMode === 'create') {
        await createMutation.mutateAsync({
          code: form.code.trim(),
          track: form.track,
          label,
          active: form.active,
          externalIds,
        });
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

  const pillBar = useFilterPillBarWiring<JobLevelRow, ColumnId>(columns, tableState, setTableState);

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
          selectedCount={tableState.selectedIds.size}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<JobLevelRow, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="job-levels"
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

        <DataTable<JobLevelRow, ColumnId>
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
          renderEmpty={() => <div className="font-medium text-foreground">{tj('empty')}</div>}
          selectable={false}
        />
      </div>

      <Drawer
        open={drawerOpen}
        onOpenChange={(next) => {
          if (!next) closeDrawer();
        }}
      >
        <DrawerContent width={560} resizable storageKey="admin.jobLevels">
          <DrawerHeader>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate">
                {drawerMode === 'create'
                  ? tj('addTitle')
                  : drawerMode === 'edit'
                    ? tj('editTitle')
                    : selectedRow
                      ? pickLabel(selectedRow.label, locale) || selectedRow.code
                      : ''}
              </DrawerTitle>
              {selectedRow && (
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
                    {selectedRow.code}
                  </span>
                  <Badge variant="secondary" className="text-[11px]">
                    {trackLabel(selectedRow.track)}
                  </Badge>
                  <Badge variant={selectedRow.active ? 'success' : 'secondary'}>
                    {selectedRow.active ? tc('active') : tc('inactive')}
                  </Badge>
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
                <Field label={tc('code')}>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
                    {selectedRow.code}
                  </span>
                </Field>
                <Field label={tj('trackColumn')}>{trackLabel(selectedRow.track)}</Field>
                <Field label={tc('labelEn')}>
                  {(selectedRow.label as Record<string, string> | undefined)?.en ?? '—'}
                </Field>
                {/* VeloExpense: the French row is shown only while French is on. */}
                {FRENCH_ON && (
                  <Field label={tc('labelFr')}>
                    {(selectedRow.label as Record<string, string> | undefined)?.['fr-CA'] ?? '—'}
                  </Field>
                )}
                <Field label={tc('status')}>
                  <Badge variant={selectedRow.active ? 'success' : 'secondary'}>
                    {selectedRow.active ? tc('active') : tc('inactive')}
                  </Badge>
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
                {/* Code on the left, Category on the right — code is the
                    short identity, track is the career path. */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField htmlFor="jobLevel-code" label={tc('code')} required>
                    <Input
                      id="jobLevel-code"
                      value={form.code}
                      onChange={(e) => setForm({ ...form, code: e.target.value })}
                      placeholder={tj('codePlaceholder')}
                      autoFocus
                    />
                  </FormField>
                  <FormField label={tj('trackColumn')} required>
                    <RadioGroup
                      value={form.track}
                      onValueChange={(v) => setForm({ ...form, track: v as JobLevelTrack })}
                      className="flex flex-col gap-1.5"
                    >
                      {trackOptions.map((opt) => {
                        const id = `jobLevel-track-${opt.value}`;
                        return (
                          <label
                            key={opt.value}
                            htmlFor={id}
                            className="flex cursor-pointer items-center gap-2 text-foreground text-sm"
                          >
                            {/* VeloExpense: named by aria-label — Base UI's radio is a span
                                that the wrapping <label> does not name (as kit #10's checkbox). */}
                            <Radio id={id} value={opt.value} aria-label={opt.label} />
                            {opt.label}
                          </label>
                        );
                      })}
                    </RadioGroup>
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField htmlFor="jobLevel-labelEn" label={tc('labelEn')} required>
                    <Input
                      id="jobLevel-labelEn"
                      value={form.labelEn}
                      onChange={(e) => setForm({ ...form, labelEn: e.target.value })}
                      placeholder={tj('labelEnPlaceholder')}
                    />
                  </FormField>
                  {/* VeloExpense: asked for only while French is on. */}
                  {FRENCH_ON && (
                    <FormField htmlFor="jobLevel-labelFr" label={tc('labelFr')} required>
                      <Input
                        id="jobLevel-labelFr"
                        value={form.labelFr}
                        onChange={(e) => setForm({ ...form, labelFr: e.target.value })}
                        placeholder={tj('labelFrPlaceholder')}
                      />
                    </FormField>
                  )}
                </div>
                <FormField
                  htmlFor="jobLevel-active"
                  label={tc('active')}
                  controlPosition="inline-leading"
                  description={tj('activeHelp')}
                >
                  <Checkbox
                    id="jobLevel-active"
                    checked={form.active}
                    onCheckedChange={(v) => setForm({ ...form, active: v === true })}
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

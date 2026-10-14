/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: ExpenseOS lints with Biome, which exempts the column memo (its biome-ignore below) and does not flag the filter memo's `tableState.filters`; the same, for ESLint. */
'use client';

/**
 * Role Builder — same DataTable + right-drawer chrome as the four
 * admin lookup pages, with an extra "Permissions" picker inside the
 * drawer (grouped by module).
 *
 * Diverges from `<AdminLookupPage>` because:
 *   - Roles carry `permissions: string[]` instead of just metadata,
 *     and the editor groups permissions by module for sanity.
 *   - System roles are non-deletable; their code is locked.
 *   - Every role row shows two badges: user count and permission count.
 *   - "Delete" is a hard delete; the lookup shell uses soft-delete.
 */
import {
  Badge,
  Button,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  IconEdit,
  IconPlus,
  RowActionsMenu,
  SchemaForm,
  type SchemaFormHandle,
  TableSettingsButton,
} from '@expenseos/design-system';
import { ENABLED_LOCALES, type Locale } from '@expenseos/i18n/locales';
// VeloExpense: VeloExpense's design-system barrel doesn't re-export IconShieldCheck or
// IconTrash, so they come from Tabler directly, as the other admin screens' icons do.
import {
  IconEye,
  IconRestore,
  IconShieldCheck,
  IconTrash,
  IconUserOff,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
// VeloExpense: no [locale] segment in VeloExpense's routes.
import { useTopBarSlots } from '@/app/(app)/TopBar';
import { Field, pickLabel, Section } from '@/components/admin/AdminLookupPage';
import {
  ExternalIdsBlock,
  ExternalIdsCell,
  externalIdEntries,
} from '@/components/admin/ExternalIds';
import {
  type FacetOption,
  type FieldKind,
  type FilterOp,
  newClauseId,
  type PersistedViewState,
  type SystemView,
  TableExportMenu,
  useFilterChromeLabels,
  useSavedViews,
  useTableLabels,
  useToolbarLabels,
  VALUELESS_OPS,
} from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { useExternalIdSources } from '@/components/external-ids/ExternalIdsField';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
import {
  buildRoleSchema,
  EMPTY_ROLE_FORM,
  moduleOf,
  type RoleFormData,
  roleWidgets,
} from './RoleSchemaForm';

interface RoleRow {
  id: string;
  label: { en: string; 'fr-CA': string } | unknown;
  description?: unknown;
  isSystem: boolean;
  active: boolean;
  permissions: string[];
  externalIds: Record<string, string> | unknown;
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type RoleColumnId =
  | 'code'
  | 'label'
  | 'kind'
  | 'externalIds'
  | 'status'
  | 'users'
  | 'permissions'
  | 'actions';

type DrawerMode = 'closed' | 'view' | 'edit' | 'create';

/** Sentinel "no grouping" option for the TableSettingsButton radio
 *  group. DataTable stores the actual state as `groupBy: null`. */
/** VeloExpense: whether admins are asked for (and shown) French text (`ENABLED_LOCALES`, 7 Oct). */
const FRENCH_ON = ENABLED_LOCALES.includes('fr-CA');

const NONE_GROUP = '__none__' as const;
/** Columns that should appear in the group-by dropdown. Kind +
 *  status both have custom groupKeyFor branches below. */
const ROLE_GROUPABLE_COLUMNS: RoleColumnId[] = ['kind', 'status'];

export function RoleBuilder({ canWrite, canDelete }: { canWrite: boolean; canDelete: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('admin.roles');
  // Filter-pill chrome copy: this package's pills take no next-intl dependency.
  const chromeLabels = useFilterChromeLabels();
  const tTable = useTranslations('table');
  const tc = useTranslations('admin.common');
  const refusalText = useRefusalText(); // VeloExpense: see the two catch blocks below.
  const tableLabels = useTableLabels();
  const locale = useLocale() as Locale;

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed');
  const [selectedRow, setSelectedRow] = useState<RoleRow | null>(null);
  const [form, setForm] = useState<RoleFormData>(EMPTY_ROLE_FORM);
  // SchemaForm submission is driven from the drawer footer Save button
  // via this ref — the footer is outside SchemaForm's DOM, so we can't
  // use type="submit". Same pattern as AdminLookupPage.
  const formRef = useRef<SchemaFormHandle>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string>('sys:default');

  const systemViews = useMemo<SystemView<RoleColumnId>[]>(
    () => [{ kind: 'system', id: 'sys:default', name: t('pageTitle') }],
    [t],
  );
  const {
    allViews,
    createView,
    renameView,
    deleteView: deleteSavedView,
    togglePinnedView,
  } = useSavedViews<RoleColumnId>({
    resource: 'roles',
    systemViews,
    onAfterCreate: (id) => setActiveViewId(id),
    onAfterDelete: () => setActiveViewId('sys:default'),
  });

  const rolesQuery = trpc.roles.list.useQuery({ includeInactive: true });
  const catalogQuery = trpc.roles.permissionCatalog.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  // The tenant's own external-ID systems, for the sub-form inside the role drawer.
  const externalIdSources = useExternalIdSources();
  const createMutation = trpc.roles.create.useMutation();
  const updateMutation = trpc.roles.update.useMutation();
  const deleteMutation = trpc.roles.delete.useMutation();

  const allRoles = (rolesQuery.data?.items ?? []) as RoleRow[];

  // Permission catalog grouped by module — drives the permission picker.
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const code of catalogQuery.data?.permissions ?? []) {
      const mod = moduleOf(code);
      if (!map.has(mod)) map.set(mod, []);
      map.get(mod)?.push(code);
    }
    for (const list of map.values()) list.sort();
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalogQuery.data]);

  // ── Drawer transitions ──────────────────────────────────────
  const openView = (row: RoleRow) => {
    setSelectedRow(row);
    setSaveError(null);
    setDrawerMode('view');
  };

  const openEdit = (row: RoleRow) => {
    setSelectedRow(row);
    setSaveError(null);
    setForm(rowToForm(row));
    setDrawerMode('edit');
  };

  const openCreate = () => {
    setSelectedRow(null);
    setSaveError(null);
    setForm(EMPTY_ROLE_FORM);
    setDrawerMode('create');
  };

  const closeDrawer = () => {
    setDrawerMode('closed');
    setSelectedRow(null);
    setSaveError(null);
  };

  const switchToEdit = () => {
    if (!selectedRow) return;
    setForm(rowToForm(selectedRow));
    setSaveError(null);
    setDrawerMode('edit');
  };

  // ── Save / delete ──────────────────────────────────────────
  //
  // `data` is the SchemaForm formData after validation. We pull the
  // four "shape" transforms (description bundling, code derivation,
  // system-role active-lock) here so the wire payload stays explicit.
  const save = async (data: RoleFormData) => {
    setSaveError(null);
    try {
      const description =
        data.descriptionEn || data.descriptionFr
          ? { en: data.descriptionEn, 'fr-CA': data.descriptionFr }
          : null;
      const permissions = [...data.permissions].sort();
      // VeloExpense: with French switched off the form has no French name; one already saved
      // rides along in the form data, and an empty one is not sent (the router takes it as
      // optional then — adminLookup.ts's `labelSchema`).
      const label = {
        en: data.labelEn,
        ...(data.labelFr ? { 'fr-CA': data.labelFr } : {}),
      } as { en: string; 'fr-CA': string };
      if (drawerMode === 'edit' && selectedRow) {
        await updateMutation.mutateAsync({
          id: selectedRow.id,
          patch: {
            label,
            description,
            permissions,
            externalIds: data.externalIds,
            ...(selectedRow.isSystem ? {} : { active: data.active }),
          },
        });
      } else if (drawerMode === 'create') {
        await createMutation.mutateAsync({
          label,
          description,
          permissions,
          externalIds: data.externalIds,
          active: data.active,
        });
      }
      rolesQuery.refetch();
      closeDrawer();
    } catch (err) {
      // VeloExpense: through `useRefusalText` (lib/trpc/refusal.ts) — a catalogued refusal
      // in the reader's language, else the error's own sentence, else the generic one —
      // never whatever was thrown (check:i18n, flag f11), as the lookup screens do.
      setSaveError(refusalText(err, tc('unknownError')));
    }
  };

  const deleteRole = async (row: RoleRow) => {
    const name = pickLabel(row.label, locale) || row.id;
    if (!window.confirm(t('confirmDeleteRole', { name }))) return;
    try {
      await deleteMutation.mutateAsync({ id: row.id });
      rolesQuery.refetch();
    } catch (err) {
      // VeloExpense: through `useRefusalText`, as the save above.
      window.alert(refusalText(err, tc('unknownError')));
    }
  };

  // ── Columns ─────────────────────────────────────────────────
  // Primary `label` column carries the kebab menu INSIDE its cell —
  // same pattern as EmployeeDirectory's NameCell. Code shown as the
  // secondary line; system badge sits beside the name.
  const columns: ColumnDef<RoleRow, RoleColumnId>[] = useMemo(
    () => [
      {
        id: 'label',
        label: tc('label'),
        defaultWidth: 340,
        filterable: { kind: 'text' },
        exportValue: (row: RoleRow) => pickLabel(row.label, locale) || row.id,
        cell: (row: RoleRow) => (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <span className="whitespace-normal break-words font-medium text-foreground text-sm">
                {pickLabel(row.label, locale) || row.id}
              </span>
            </div>
            <RowActionsMenu
              ariaLabel={tc('actions')}
              actions={[
                {
                  id: 'view',
                  icon: <IconEye size={14} />,
                  label: tc('view'),
                  onClick: () => openView(row),
                },
                ...(canWrite
                  ? [
                      {
                        id: 'edit',
                        icon: <IconEdit size={14} />,
                        label: tc('edit'),
                        onClick: () => openEdit(row),
                      },
                    ]
                  : []),
                ...(canDelete && !row.isSystem
                  ? [
                      { divider: true as const },
                      {
                        id: 'delete',
                        icon: <IconTrash size={14} />,
                        label: tc('delete'),
                        onClick: () => deleteRole(row),
                        destructive: true,
                        disabled: deleteMutation.isPending || row.userCount > 0,
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ),
      },
      {
        // System / Custom flag — surfaced as its own filterable column
        // so admins can group / filter on it (drives "Group by kind"
        // on the role list).
        id: 'kind',
        label: t('roleKind'),
        defaultWidth: 120,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: 'system', label: t('systemRole') },
            { value: 'custom', label: t('customRole') },
          ],
        },
        exportValue: (row: RoleRow) => (row.isSystem ? t('systemRole') : t('customRole')),
        cell: (row: RoleRow) => (
          <Badge variant={row.isSystem ? 'secondary' : 'outline'} className="gap-1">
            {row.isSystem && <IconShieldCheck size={10} />}
            {row.isSystem ? t('systemRole') : t('customRole')}
          </Badge>
        ),
      },
      {
        id: 'users',
        label: t('usersAssignedShort'),
        defaultWidth: 100,
        sortable: true,
        exportValue: (row: RoleRow) => row.userCount,
        cell: (row: RoleRow) => (
          <span className="font-mono text-foreground text-sm">{row.userCount}</span>
        ),
      },
      {
        id: 'permissions',
        label: t('permissionsShort'),
        defaultWidth: 130,
        sortable: true,
        exportValue: (row: RoleRow) => row.permissions.length,
        cell: (row: RoleRow) => (
          <span className="font-mono text-foreground text-sm">{row.permissions.length}</span>
        ),
      },
      {
        id: 'externalIds',
        label: tc('externalIds'),
        defaultWidth: 240,
        filterable: { kind: 'text' },
        exportValue: (row: RoleRow) =>
          externalIdEntries(row.externalIds)
            .map(([system, id]) => `${system}: ${id}`)
            .join(', '),
        cell: (row: RoleRow) => <ExternalIdsCell value={row.externalIds} />,
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
        exportValue: (row: RoleRow) => (row.active ? tc('active') : tc('inactive')),
        cell: (row: RoleRow) => (
          <Badge variant={row.active ? 'success' : 'secondary'}>
            {row.active ? tc('active') : tc('inactive')}
          </Badge>
        ),
      },
    ],
    // biome-ignore lint/correctness/useExhaustiveDependencies: openView/openEdit/deleteRole are component-scoped handlers intentionally listed; they only invoke setState and mutations
    [tc, t, locale, canWrite, canDelete, deleteMutation.isPending, openView, openEdit, deleteRole],
  );

  const [tableState, setTableState] = useState<DataTableState<RoleColumnId>>(() =>
    createDataTableState(columns as never, {
      pinnedColumns: { left: ['label' as RoleColumnId], right: [] },
      // Hide inactive roles by default — the pill bar's status clause
      // is the only affordance for showing them now (the Include
      // inactive checkbox is gone).
      filters: [
        {
          id: newClauseId(),
          field: 'status' as RoleColumnId,
          op: 'equals',
          value: 'active',
        },
      ],
    }),
  );

  // Derive active/inactive visibility from the pill bar's Status
  // clauses — same semantics as AdminLookupPage:
  //   no clauses → all, equals:active → active, equals:inactive →
  //   inactive, both → all.
  const statusFilter = useMemo<'active' | 'inactive' | 'both'>(() => {
    const clauses = tableState.filters.filter((c) => c.field === 'status');
    if (clauses.length === 0) return 'both';
    let wantActive = false;
    let wantInactive = false;
    for (const c of clauses) {
      if (c.op === 'equals') {
        if (c.value === 'active') wantActive = true;
        else if (c.value === 'inactive') wantInactive = true;
      } else if (c.op === 'doesNotEqual') {
        if (c.value === 'active') wantInactive = true;
        else if (c.value === 'inactive') wantActive = true;
      } else {
        // contains/startsWith/… don't apply to a boolean surface.
        return 'both';
      }
    }
    if (wantActive && wantInactive) return 'both';
    if (wantActive) return 'active';
    if (wantInactive) return 'inactive';
    return 'both';
  }, [tableState.filters]);
  /**
   * The row set the table shows: the status view (above) plus the OTHER pills.
   *
   * The label / kind / external-id clauses used to be collected and never applied —
   * the page declared four filterable columns and honoured one, so filtering by role
   * kind or by name changed the pill bar and nothing else. A pill that does nothing is
   * worse than no pill: it reads as "no such roles".
   *
   * `equals` clauses on ONE field OR together (a facet multi-select widens); the text
   * ops AND, matching the semantics every other list on the page shares.
   */
  const rows = useMemo(() => {
    let out =
      statusFilter === 'both'
        ? allRoles
        : allRoles.filter((r) => (statusFilter === 'active' ? r.active : !r.active));

    const fieldValue = (r: RoleRow, field: string): string => {
      if (field === 'kind') return r.isSystem ? 'system' : 'custom';
      if (field === 'externalIds')
        return externalIdEntries(r.externalIds)
          .map(([system, id]) => `${system}: ${id}`)
          .join(', ');
      return pickLabel(r.label, locale) || r.id;
    };

    const byField = new Map<string, typeof tableState.filters>();
    for (const c of tableState.filters) {
      if (c.field === 'status') continue; // handled by `statusFilter`
      const list = byField.get(c.field) ?? [];
      list.push(c);
      byField.set(c.field, list);
    }
    for (const [field, clauses] of byField) {
      const equals = clauses.filter((c) => c.op === 'equals');
      const others = clauses.filter((c) => c.op !== 'equals');
      out = out.filter((r) => {
        const v = fieldValue(r, field).toLowerCase();
        if (equals.length > 0 && !equals.some((c) => v === c.value.toLowerCase())) return false;
        for (const c of others) {
          const needle = c.value.toLowerCase();
          if (c.op === 'doesNotEqual' && v === needle) return false;
          if (c.op === 'contains' && !v.includes(needle)) return false;
          if (c.op === 'doesNotContain' && v.includes(needle)) return false;
          if (c.op === 'startsWith' && !v.startsWith(needle)) return false;
          if (c.op === 'endsWith' && !v.endsWith(needle)) return false;
        }
        return true;
      });
    }
    return out;
  }, [allRoles, statusFilter, tableState.filters, locale]);

  const resetTable = () =>
    setTableState((s) => ({
      ...s,
      columnOrder: columns.map((c) => c.id),
      columnVisibility: {},
      columnWidths: {},
      density: 'normal',
    }));

  const drawerOpen = drawerMode !== 'closed';

  // ── TopBar: push the "Add role" button into the global top bar.
  //    Page title is sourced from TopBar's ROUTE_TITLE_KEYS.
  useTopBarSlots(
    () => ({
      right: canWrite ? (
        <Button onClick={openCreate} size="sm">
          <IconPlus size={14} className="mr-1" />
          {t('addNew')}
        </Button>
      ) : null,
    }),
    [canWrite, t],
  );

  // ── Filter-pill bar wiring (same shape as AdminLookupPage) ──
  const filterableColumns = useMemo(
    () => columns.filter((c) => c.filterable !== undefined),
    [columns],
  );
  const filterFields = useMemo(() => filterableColumns.map((c) => c.id), [filterableColumns]);
  const filterLabels = useMemo(
    () =>
      Object.fromEntries(filterableColumns.map((c) => [c.id, c.label])) as Record<
        RoleColumnId,
        string
      >,
    [filterableColumns],
  );
  const filterKinds = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.kind ?? 'text']),
      ) as Record<RoleColumnId, FieldKind>,
    [filterableColumns],
  );
  const filterOptions = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.options ?? []]),
      ) as Record<RoleColumnId, FacetOption[]>,
    [filterableColumns],
  );

  const updateClauseOp = (id: string, op: FilterOp) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) =>
        c.id === id ? { ...c, op, value: VALUELESS_OPS.has(op) ? '' : c.value } : c,
      ),
    }));
  };
  const updateClauseValue = (id: string, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) => (c.id === id ? { ...c, value } : c)),
    }));
  };
  const removeClause = (id: string) => {
    setTableState((s) => ({ ...s, filters: s.filters.filter((c) => c.id !== id) }));
  };
  const addClause = (field: RoleColumnId, op: FilterOp, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: [...s.filters, { id: newClauseId(), field, op, value }],
    }));
  };
  const clearClauses = () => setTableState((s) => ({ ...s, filters: [] }));

  // ── Saved-view load / save handlers ──────────────────────────
  const loadView = (id: string) => {
    const target = allViews.find((v) => v.id === id);
    if (!target) return;
    setActiveViewId(id);
    if (target.kind === 'system') {
      setTableState((s) => ({
        ...s,
        filters: target.filters?.map((f) => ({ ...f, id: newClauseId() })) ?? [],
        sort: null,
      }));
    } else {
      const v = target.state;
      const visible = v.visibleColumns;
      setTableState((s) => ({
        ...s,
        filters: v.filters.map((f) => ({ ...f, id: newClauseId() })),
        sort: v.sort ?? null,
        density: v.density ?? s.density,
        columnVisibility: visible
          ? Object.fromEntries(columns.map((c) => [c.id, visible.includes(c.id)]))
          : s.columnVisibility,
      }));
    }
  };
  const captureViewState = (): PersistedViewState<RoleColumnId> => ({
    filters: tableState.filters,
    visibleColumns: tableState.columnOrder.filter(
      (id) => tableState.columnVisibility[id] !== false,
    ),
    sort: tableState.sort ?? undefined,
    density: tableState.density,
    groupBy: null,
  });
  const saveCurrentAsNew = () => {
    const name = window.prompt('Name this view:', 'My view');
    if (!name?.trim()) return;
    createView(name.trim(), captureViewState(), false);
  };
  const renameUserView = (id: string, currentName: string) => {
    const name = window.prompt('Rename view:', currentName);
    if (!name?.trim() || name.trim() === currentName) return;
    renameView(id, name.trim());
  };
  const deleteUserView = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    deleteSavedView(id);
  };

  // ── Bulk actions ───────────────────────────────────────────
  // Selected rows that are non-system can be deactivated/reactivated
  // in one shot. System roles are excluded server-side (refuses with
  // BAD_REQUEST) and client-side (filtered from the id list before
  // dispatch) so the menu doesn't promise something the server will
  // reject.
  const selectedRows = useMemo(
    () => rows.filter((r) => tableState.selectedIds.has(r.id)),
    [rows, tableState.selectedIds],
  );
  const eligibleForDeactivate = selectedRows.filter((r) => !r.isSystem);
  const allEligibleActive =
    eligibleForDeactivate.length > 0 && eligibleForDeactivate.every((r) => r.active);
  const allEligibleInactive =
    eligibleForDeactivate.length > 0 && eligibleForDeactivate.every((r) => !r.active);
  const clearSelection = () => setTableState((s) => ({ ...s, selectedIds: new Set<string>() }));
  const bulkSetActive = async (active: boolean) => {
    const ids = eligibleForDeactivate.map((r) => r.id);
    for (const id of ids) {
      try {
        await updateMutation.mutateAsync({ id, patch: { active } });
      } catch {
        /* soft-fail per row; the rest still flip */
      }
    }
    clearSelection();
    rolesQuery.refetch();
  };
  const bulkActions: Array<{
    id: string;
    label: string;
    onSelect: () => void;
    destructive?: boolean;
    icon?: React.ReactNode;
  }> = [];
  if (allEligibleActive) {
    bulkActions.push({
      id: 'deactivate',
      label: tc('deactivate'),
      onSelect: () => void bulkSetActive(false),
      icon: <IconUserOff size={14} className="text-destructive/80" />,
      destructive: true,
    });
  }
  if (allEligibleInactive) {
    bulkActions.push({
      id: 'reactivate',
      label: tc('reactivate'),
      onSelect: () => void bulkSetActive(true),
      icon: <IconRestore size={14} className="text-muted-foreground" />,
    });
  }

  // ── Group-by knob ────────────────────────────────────────────
  // Roles can be grouped by kind (system vs custom) and by status.
  // NONE_GROUP + ROLE_GROUPABLE_COLUMNS are hoisted to module scope
  // so the useMemo deps stay clean.
  const groupOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: NONE_GROUP, label: tc('noParent') },
    ];
    for (const id of ROLE_GROUPABLE_COLUMNS) {
      const col = columns.find((c) => c.id === id);
      if (col) opts.push({ value: id, label: col.label });
    }
    return opts;
  }, [columns, tc]);
  const groupByValue = (tableState.groupBy ?? NONE_GROUP) as string;
  const onGroupChange = (g: string) => {
    setTableState((s) => ({
      ...s,
      groupBy: (g === NONE_GROUP ? null : (g as RoleColumnId)) as RoleColumnId | null,
    }));
  };

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<RoleColumnId>
          labels={chromeLabels}
          filters={tableState.filters}
          fields={filterFields}
          fieldLabels={filterLabels}
          fieldKinds={filterKinds}
          options={filterOptions}
          onUpdateOp={updateClauseOp}
          onUpdateValue={updateClauseValue}
          onRemoveClause={removeClause}
          onAddClause={addClause}
          onClearAll={clearClauses}
          clearLabel={tTable('misc.clearFilters')}
          savedViews={{
            views: allViews,
            activeViewId,
            onSelectView: loadView,
            onSaveAsNew: saveCurrentAsNew,
            onRenameView: renameUserView,
            onDeleteView: deleteUserView,
            onTogglePinned: togglePinnedView,
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={tableState.selectedIds.size}
          resultCount={rows.length}
          loading={rolesQuery.isLoading}
          bulkActions={canWrite ? bulkActions : []}
          bulkActionsDisabled={updateMutation.isPending}
          rightSlot={
            <>
              <TableExportMenu<RoleRow, RoleColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="roles"
              />
              <TableSettingsButton<RoleColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<RoleColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                groupBy={groupByValue}
                onGroupChange={onGroupChange}
                groupOptions={groupOptions}
                onReset={resetTable}
                labels={tableLabels.settings}
              />
            </>
          }
        />

        {/* Orders its own rows — the table must not re-sort them. */}
        <DataTable<RoleRow, RoleColumnId>
          sortMode="external"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={rolesQuery.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={(row) => openView(row)}
          activeRowId={selectedRow?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{t('empty')}</div>}
          selectable={canWrite}
          // `kind` is derived from row.isSystem; `status` from row.active.
          // Everything else falls back to the default property reader.
          groupKeyFor={(row, groupBy) => {
            if (groupBy === 'kind') return row.isSystem ? t('systemRole') : t('customRole');
            if (groupBy === 'status') return row.active ? tc('active') : tc('inactive');
            const v = (row as unknown as Record<string, unknown>)[groupBy as string];
            return v == null || v === '' ? '—' : String(v);
          }}
        />
      </div>

      {/* Drawer */}
      <Drawer
        open={drawerOpen}
        onOpenChange={(next) => {
          if (!next) closeDrawer();
        }}
      >
        <DrawerContent width={600} resizable storageKey="admin.roles">
          <DrawerHeader>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="flex items-center gap-2 truncate">
                {drawerMode === 'create'
                  ? t('createTitle')
                  : drawerMode === 'edit'
                    ? t('editTitle')
                    : selectedRow
                      ? pickLabel(selectedRow.label, locale) || selectedRow.id
                      : ''}
                {selectedRow?.isSystem && (
                  <Badge variant="secondary" className="gap-1">
                    <IconShieldCheck size={10} />
                    {t('systemRole')}
                  </Badge>
                )}
              </DrawerTitle>
              {selectedRow && (
                <div className="mt-0.5 flex items-center gap-2">
                  <Badge variant={selectedRow.active ? 'success' : 'secondary'}>
                    {selectedRow.active ? tc('active') : tc('inactive')}
                  </Badge>
                </div>
              )}
            </div>
            {drawerMode === 'view' && canWrite && (
              <Button variant="outline" size="sm" onClick={switchToEdit}>
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
                {/* VeloExpense: French is shown only while it is switched on. */}
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

              <Section title={t('usersAssignedShort')}>
                <Field label={t('usersAssignedShort')}>
                  <span className="font-mono">{selectedRow.userCount}</span>
                </Field>
              </Section>

              <Section title={t('permissionsTitle')}>
                <div className="space-y-2">
                  {grouped.map(([mod, perms]) => {
                    const granted = perms.filter((p) => selectedRow.permissions.includes(p));
                    if (granted.length === 0) return null;
                    return (
                      <div key={mod}>
                        <div className="mb-1 font-semibold text-[10px] text-foreground uppercase tracking-wider">
                          {mod} ({granted.length} / {perms.length})
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {granted.map((p) => (
                            <code
                              key={p}
                              className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                            >
                              {p}
                            </code>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <Section title={tc('externalIds')}>
                <ExternalIdsBlock value={selectedRow.externalIds} />
              </Section>

              <Section title={tc('audit')}>
                <Field label={tc('createdAt')}>
                  {new Date(selectedRow.createdAt).toLocaleString(locale)}
                </Field>
                <Field label={tc('updatedAt')}>
                  {new Date(selectedRow.updatedAt).toLocaleString(locale)}
                </Field>
              </Section>
            </DrawerBody>
          ) : (
            <>
              <DrawerBody className="space-y-4">
                {selectedRow?.isSystem && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-amber-700 text-xs">
                    {t('systemRoleLocked')}
                  </div>
                )}

                <SchemaForm<RoleFormData>
                  ref={formRef}
                  schema={
                    buildRoleSchema({
                      catalog: catalogQuery.data?.permissions ?? [],
                      lockActive: Boolean(selectedRow?.isSystem),
                      sources: externalIdSources,
                      labels: {
                        labelEn: tc('labelEn'),
                        labelFr: tc('labelFr'),
                        descriptionEn: tc('descriptionEn'),
                        descriptionFr: tc('descriptionFr'),
                        permissionsTitle: t('permissionsTitle'),
                        permissionsHelp: t('permissionsHelp'),
                        externalIds: tc('externalIds'),
                        externalIdsHelp: tc('externalIdsHelp'),
                        active: tc('active'),
                        selectAll: t('selectAll'),
                        clearAll: t('clearAll'),
                        editor: {
                          key: tc('key'),
                          value: tc('value'),
                          addRow: tc('addRow'),
                          removeRow: tc('removeRow'),
                        },
                      },
                    }).schema
                  }
                  uiSchema={
                    buildRoleSchema({
                      catalog: catalogQuery.data?.permissions ?? [],
                      lockActive: Boolean(selectedRow?.isSystem),
                      sources: externalIdSources,
                      labels: {
                        labelEn: tc('labelEn'),
                        labelFr: tc('labelFr'),
                        descriptionEn: tc('descriptionEn'),
                        descriptionFr: tc('descriptionFr'),
                        permissionsTitle: t('permissionsTitle'),
                        permissionsHelp: t('permissionsHelp'),
                        externalIds: tc('externalIds'),
                        externalIdsHelp: tc('externalIdsHelp'),
                        active: tc('active'),
                        selectAll: t('selectAll'),
                        clearAll: t('clearAll'),
                        editor: {
                          key: tc('key'),
                          value: tc('value'),
                          addRow: tc('addRow'),
                          removeRow: tc('removeRow'),
                        },
                      },
                    }).uiSchema
                  }
                  formData={form}
                  widgets={roleWidgets}
                  onChange={(d) => setForm(d as RoleFormData)}
                  onSubmit={save}
                  disabled={createMutation.isPending || updateMutation.isPending}
                />

                {saveError && (
                  <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive text-sm">
                    {saveError}
                  </div>
                )}
              </DrawerBody>

              <DrawerFooter className="flex justify-end gap-2 border-border border-t px-5 py-3">
                <Button variant="secondary" onClick={closeDrawer}>
                  {tc('cancel')}
                </Button>
                <Button
                  onClick={() => formRef.current?.submit()}
                  disabled={
                    createMutation.isPending ||
                    updateMutation.isPending ||
                    !form.labelEn ||
                    // VeloExpense: French only while it is switched on.
                    (FRENCH_ON && !form.labelFr)
                  }
                >
                  {tc('save')}
                </Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function rowToForm(row: RoleRow): RoleFormData {
  const label = (row.label ?? {}) as Record<string, string>;
  const desc = (row.description ?? {}) as Record<string, string>;
  const ext = (row.externalIds ?? {}) as Record<string, string>;
  return {
    labelEn: label.en ?? '',
    labelFr: label['fr-CA'] ?? '',
    descriptionEn: desc.en ?? '',
    descriptionFr: desc['fr-CA'] ?? '',
    externalIds: ext,
    active: row.active,
    permissions: [...row.permissions],
  };
}

// Bespoke ActionsDropdown / ExportDropdown / ColumnsGear helpers
// removed — the toolbar above now composes from the design-system
// primitives (DataTableToolbar + ExportMenu + TableSettingsButton +
// inline include-inactive Checkbox + SelectionCounter).

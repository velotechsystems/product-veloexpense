'use client';

/**
 * Expense-category admin — standard directory chrome (FilterPillBar +
 * DataTableToolbar + DataTable, status pills, bulk deactivate/reactivate,
 * edit-on-name-column) matching the lookup-table pages, but bespoke because
 * ExpenseCategory carries fields the generic `AdminLookupPage` RJSF form can't
 * render: an emoji picker (the full Unicode library), a pill color, a GL account
 * (number · resolved name), ITC recoverability rates, a PST-recoverable flag,
 * and a sort order. Those all live in the right-side create/edit drawer.
 *
 * The "Add category" primary action is pushed into the global top bar (the same
 * spot the People directory uses); there's no in-page title.
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
  EmojiPicker,
  FilterPillBar,
  Input,
  RowActionsMenu,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TableSettingsButton,
} from '@expenseos/design-system';
import { getLocalized } from '@expenseos/i18n';
import { ENABLED_LOCALES, type Locale } from '@expenseos/i18n/locales';
import {
  IconEdit,
  IconPlus,
  IconRestore,
  IconUserOff,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { useTopBarSlots } from '@/app/(app)/TopBar';
import {
  type FacetOption,
  type FieldKind,
  type FilterOp,
  newClauseId,
  TableExportMenu,
  useFilterChromeLabels,
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
import { GlAccountCombobox } from '@/components/pickers/EntityPickers';
import { categoryPillStyle } from '@/lib/categoryColor';
import { trpc } from '@/lib/trpc/client';
import { refusalDataOf, refusalText } from '@/lib/trpc/refusal';
import type { AppRouter } from '@/server/routers/_app';

type ListOutput = inferRouterOutputs<AppRouter>['expenseCategories']['list'];
type Category = ListOutput['categories'][number];
/** VeloExpense: whether admins are asked for a French name (`ENABLED_LOCALES`, 7 Oct). */
const FRENCH_ON = ENABLED_LOCALES.includes('fr-CA');
/*
 * VeloExpense: ExpenseOS's NetSuite expense-category column and override (FR-6) are not
 * ported — VeloExpense codes to its own chart of accounts and has no NetSuite category
 * mirror (see server/routers/expenseCategories.ts). Their code is left out here: the
 * column and its cell view, the state badges, the drawer's override picker, and the
 * `nsCategoryId` form field. Nothing else on the screen read them.
 */
type ColumnId =
  | 'name'
  | 'type'
  | 'attendees'
  | 'tip'
  | 'color'
  | 'gl'
  | 'itc'
  | 'status';

/**
 * What kind of line a category produces. One control instead of the two booleans the
 * columns store, because `isMileage` + `acceptsTip` together is incoherent — a mileage
 * amount is derived from distance, so there is no typed figure for a tip to sit beside.
 */
type CategoryKind = 'standard' | 'standard-with-tip' | 'mileage';
const KINDS: CategoryKind[] = ['standard', 'standard-with-tip', 'mileage'];

/** The two stored booleans, read back as the single kind they encode. */
function kindOf(c: { isMileage: boolean; acceptsTip: boolean }): CategoryKind {
  return c.isMileage ? 'mileage' : c.acceptsTip ? 'standard-with-tip' : 'standard';
}

interface FormState {
  labelEn: string;
  labelFr: string;
  color: string;
  icon: string;
  glAccountId: string | null;
  itcGstHstRate: number;
  itcQstRate: number;
  pstRecoverable: boolean;
  requiresAttendees: boolean;
  kind: CategoryKind;
  active: boolean;
}

const EMPTY: FormState = {
  labelEn: '',
  labelFr: '',
  color: '#2563eb',
  icon: '',
  glAccountId: null,
  itcGstHstRate: 100,
  itcQstRate: 100,
  pstRecoverable: false,
  requiresAttendees: false,
  kind: 'standard',
  active: true,
};

function toForm(c: Category): FormState {
  const label = (c.label ?? {}) as Record<string, string>;
  return {
    labelEn: label.en ?? '',
    labelFr: label['fr-CA'] ?? '',
    color: c.color ?? '#2563eb',
    icon: c.icon ?? '',
    glAccountId: c.glAccountId ?? null,
    itcGstHstRate: c.itcGstHstRate,
    itcQstRate: c.itcQstRate,
    pstRecoverable: c.pstRecoverable,
    requiresAttendees: c.requiresAttendees,
    kind: c.isMileage ? 'mileage' : c.acceptsTip ? 'standard-with-tip' : 'standard',
    active: c.active,
  };
}

/** Match a single filter clause against a cell's text. Enum fields (status)
 *  only ever produce equals/doesNotEqual; text fields unlock the rest. */
function matchClause(hay: string, op: FilterOp, needle: string): boolean {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  switch (op) {
    case 'equals':
      return h === n;
    case 'doesNotEqual':
      return h !== n;
    case 'contains':
      return h.includes(n);
    case 'doesNotContain':
      return !h.includes(n);
    case 'startsWith':
      return h.startsWith(n);
    case 'endsWith':
      return h.endsWith(n);
    case 'isEmpty':
      return h.trim() === '';
    case 'isNotEmpty':
      return h.trim() !== '';
    default:
      return true; // isAnyOf / isNoneOf don't apply to these single-value fields
  }
}

export function ExpenseCategoriesAdmin({ canWrite }: { canWrite: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('admin.expenseCategories');
  // Filter-pill chrome copy: this package's pills take no next-intl dependency.
  const chromeLabels = useFilterChromeLabels();
  const tc = useTranslations('admin.common');
  /** Root translator: a refusal's key is a full `refusals.*` path (lib/trpc/refusal.ts). */
  const tRoot = useTranslations();
  const locale = useLocale() as Locale;
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const query = trpc.expenseCategories.list.useQuery();
  const invalidate = () => utils.expenseCategories.list.invalidate();
  const create = trpc.expenseCategories.create.useMutation({ onSuccess: invalidate });
  const update = trpc.expenseCategories.update.useMutation({ onSuccess: invalidate });
  const reorder = trpc.expenseCategories.reorder.useMutation({ onSuccess: invalidate });

  const [editing, setEditing] = useState<Category | null>(null);
  /** Line items already filed against the category being edited. Non-zero freezes the
   *  mileage side of `kind` — see the server's guard, which is the real enforcement. */
  const filedCount = editing?._count?.lineItems ?? 0;
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  /** Why the last save was refused, already in the reader's language. Cleared by the next
   *  edit, the next Save and closing the drawer. */
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((c: Category | null) => {
    setEditing(c);
    setCreating(c === null);
    setForm(c ? toForm(c) : EMPTY);
  }, []);
  const close = () => {
    setEditing(null);
    setCreating(false);
    setError(null);
  };
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  // VeloExpense: the French name is asked for only while French is switched on
  // (`ENABLED_LOCALES`, 7 Oct). An existing French name is kept as it was.
  const valid =
    form.labelEn.trim() &&
    (!FRENCH_ON || form.labelFr.trim()) &&
    /^#[0-9a-fA-F]{6}$/.test(form.color);
  const saving = create.isPending || update.isPending;

  async function save() {
    const payload = {
      label: {
        en: form.labelEn.trim(),
        // VeloExpense: omitted, rather than sent empty, while French is off and unnamed.
        ...(form.labelFr.trim() ? { 'fr-CA': form.labelFr.trim() } : {}),
      },
      color: form.color,
      icon: form.icon.trim() || null,
      glAccountId: form.glAccountId,
      itcGstHstRate: form.itcGstHstRate,
      itcQstRate: form.itcQstRate,
      pstRecoverable: form.pstRecoverable,
      requiresAttendees: form.requiresAttendees,
      kind: form.kind,
      active: form.active,
    };
    setError(null);
    if (creating) await create.mutateAsync(payload);
    else if (editing) {
      try {
        await update.mutateAsync({ id: editing.id, ...payload });
      } catch (e) {
        // A refusal says why in the reader's language; anything else gets the generic
        // sentence, so no English server text reaches the drawer. It stays open to fix.
        setError(refusalDataOf(e) ? refusalText(tRoot, e, t('saveFailed')) : t('saveFailed'));
        return;
      }
    }
    close();
  }

  const toggleActive = useCallback(
    async (c: Category) => {
      const msgKey = c.active ? 'confirmDeactivate' : 'confirmReactivate';
      if (!window.confirm(tc(msgKey, { name: getLocalized(c.label, locale) ?? c.id }))) return;
      await update.mutateAsync({ id: c.id, active: !c.active });
    },
    [tc, locale, update],
  );

  // ── Columns ────────────────────────────────────────────────────
  const columns: ColumnDef<Category, ColumnId>[] = useMemo(() => {
    const yesNo = (v: boolean) => (v ? tc('yes') : tc('no'));
    // Filter clauses compare against fieldText's output, so the VALUES are the raw
    // booleans as strings while the labels are what a reader sees.
    const BOOL_OPTIONS = [
      { value: 'true', label: tc('yes') },
      { value: 'false', label: tc('no') },
    ];
    const cols: ColumnDef<Category, ColumnId>[] = [
      {
        id: 'name',
        label: t('colName'),
        defaultWidth: 300,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (c) => getLocalized(c.label, locale) ?? c.id,
        cell: (c) => (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-base leading-none">{c.icon || '🏷️'}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {getLocalized(c.label, locale) ?? c.id}
            </span>
            {/* The three flags that change what the LINE EDITOR offers, shown where
                somebody looking for them would look. Mileage swaps the amount field
                for distance × rate + the route picker; tip adds the tip field;
                attendees demands a guest list before the line can be filed. With none
                surfaced, all three features read as missing.

                Attendees was the one flag with no badge, and it is the one with the
                sharpest consequence for a submitter — a category that will refuse the
                line until they have named who was at the dinner. It is a peer of the
                other two, so it gets the same outline variant rather than a louder one. */}
            {c.isMileage && (
              <Badge variant="outline" className="shrink-0 border text-[10px]">
                {t('isMileageBadge')}
              </Badge>
            )}
            {c.acceptsTip && (
              <Badge variant="outline" className="shrink-0 border text-[10px]">
                {t('acceptsTipBadge')}
              </Badge>
            )}
            {c.requiresAttendees && (
              <Badge variant="outline" className="shrink-0 border text-[10px]">
                {t('requiresAttendeesBadge')}
              </Badge>
            )}
            {canWrite && (
              <RowActionsMenu
                ariaLabel={tc('actions')}
                actions={[
                  {
                    id: 'edit',
                    icon: <IconEdit size={14} />,
                    label: tc('edit'),
                    onClick: () => open(c),
                  },
                  { divider: true as const },
                  {
                    id: 'toggleActive',
                    icon: c.active ? <IconUserOff size={14} /> : <IconRestore size={14} />,
                    label: c.active ? tc('deactivate') : tc('reactivate'),
                    onClick: () => void toggleActive(c),
                    destructive: c.active,
                    disabled: update.isPending,
                  },
                ]}
              />
            )}
          </div>
        ),
      },
      // The flags that were previously only visible as badges, as real columns so a
      // list can be sorted, filtered and exported by them. Hidden by default (seeded in
      // columnVisibility below) — the badges already say it at a glance, so these are
      // for narrowing and export rather than everyday reading.
      {
        id: 'type',
        label: t('colKind'),
        defaultWidth: 160,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) })),
        },
        exportValue: (c) => t(`kinds.${kindOf(c)}`),
        cell: (c) => <span className="text-foreground text-sm">{t(`kinds.${kindOf(c)}`)}</span>,
      },
      {
        id: 'attendees',
        label: t('colRequiresAttendees'),
        defaultWidth: 140,
        sortable: true,
        filterable: { kind: 'enum', options: BOOL_OPTIONS },
        exportValue: (c) => yesNo(c.requiresAttendees),
        cell: (c) => <span className="text-foreground text-sm">{yesNo(c.requiresAttendees)}</span>,
      },
      {
        id: 'tip',
        label: t('colAcceptsTip'),
        defaultWidth: 130,
        sortable: true,
        filterable: { kind: 'enum', options: BOOL_OPTIONS },
        exportValue: (c) => yesNo(c.acceptsTip),
        cell: (c) => <span className="text-foreground text-sm">{yesNo(c.acceptsTip)}</span>,
      },
      {
        id: 'color',
        label: t('colColor'),
        defaultWidth: 140,
        exportValue: (c) => c.color ?? '—',
        cell: (c) => (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-4 w-4 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: c.color ?? 'transparent' }}
              aria-hidden
            />
            <span className="text-muted-foreground text-xs tabular-nums">{c.color ?? '—'}</span>
          </div>
        ),
      },
      {
        id: 'gl',
        label: t('colGlAccount'),
        defaultWidth: 240,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (c) =>
          c.glAccountNumber
            ? `${c.glAccountNumber}${c.glAccountName ? ` · ${c.glAccountName}` : ''}`
            : '—',
        cell: (c) =>
          c.glAccountNumber ? (
            <span className="text-foreground">
              <span className="tabular-nums">{c.glAccountNumber}</span>
              {c.glAccountName ? (
                <span className="text-muted-foreground"> · {c.glAccountName}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'itc',
        label: t('colItc'),
        defaultWidth: 200,
        exportValue: (c) =>
          `${c.itcGstHstRate}% / ${c.itcQstRate}%${c.pstRecoverable ? ` · ${t('pstShort')}` : ''}`,
        cell: (c) => (
          <span className="text-muted-foreground tabular-nums">
            {c.itcGstHstRate}% / {c.itcQstRate}%{c.pstRecoverable ? ` · ${t('pstShort')}` : ''}
          </span>
        ),
      },
      {
        id: 'status',
        label: tc('status'),
        defaultWidth: 120,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: 'active', label: tc('active') },
            { value: 'inactive', label: tc('inactive') },
          ],
        },
        exportValue: (c) => (c.active ? tc('active') : tc('inactive')),
        cell: (c) => (
          <Badge variant={c.active ? 'success' : 'secondary'}>
            {c.active ? tc('active') : tc('inactive')}
          </Badge>
        ),
      },
    ];
    return cols;
  }, [t, tc, locale, canWrite, update.isPending, open, toggleActive]);

  // ── Table state — seed a Status=Active pill so inactive rows hide by default.
  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {
      pinnedColumns: { left: ['name'], right: [] },
      // Off by default, on via the gear menu. The name column already badges mileage
      // and tip, so showing all three as columns too is noise until someone wants to
      // sort or export by them.
      columnVisibility: { type: false, attendees: false, tip: false },
      filters: [{ id: newClauseId(), field: 'status', op: 'equals', value: 'active' }],
    }),
  );

  // Status pill → active/inactive/both (mirrors the lookup pages).
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
        return 'both';
      }
    }
    if (wantActive && wantInactive) return 'both';
    if (wantActive) return 'active';
    if (wantInactive) return 'inactive';
    return 'both';
  }, [tableState.filters]);

  // Cell text for filtering / sort key derivation.
  const fieldText = useCallback(
    (c: Category, field: ColumnId): string => {
      switch (field) {
        case 'name':
          return getLocalized(c.label, locale) ?? c.id;
        case 'gl':
          return `${c.glAccountNumber ?? ''} ${c.glAccountName ?? ''}`.trim();
        case 'status':
          return c.active ? 'active' : 'inactive';
        case 'type':
          return kindOf(c);
        case 'attendees':
          return String(c.requiresAttendees);
        case 'tip':
          return String(c.acceptsTip);
        case 'color':
          return c.color ?? '';
        default:
          return '';
      }
    },
    [locale],
  );

  // Row pipeline: status predicate → remaining filter clauses → sort. The
  // DataTable renders rows as given (it owns display chrome, not filtering).
  const rows = useMemo(() => {
    let list = (query.data?.categories ?? []).slice();
    if (statusFilter !== 'both') {
      list = list.filter((c) => (statusFilter === 'active' ? c.active : !c.active));
    }
    for (const clause of tableState.filters) {
      if (clause.field === 'status') continue; // handled above
      list = list.filter((c) =>
        matchClause(fieldText(c, clause.field), clause.op, String(clause.value ?? '')),
      );
    }
    if (tableState.sort) {
      const { field, dir } = tableState.sort;
      const mul = dir === 'asc' ? 1 : -1;
      list = list.sort(
        (a, b) =>
          fieldText(a, field as ColumnId).localeCompare(fieldText(b, field as ColumnId), locale, {
            numeric: true,
          }) * mul,
      );
    }
    return list;
  }, [query.data, statusFilter, tableState.filters, tableState.sort, fieldText, locale]);

  // ── TopBar: "Add category" in the global top bar (People-page pattern).
  useTopBarSlots(
    () => ({
      right: canWrite ? (
        <Button size="sm" onClick={() => open(null)}>
          <IconPlus size={14} className="mr-1" />
          {t('add')}
        </Button>
      ) : null,
    }),
    [canWrite, t],
  );

  // ── Filter-pill wiring ─────────────────────────────────────────
  const filterableColumns = useMemo(() => columns.filter((c) => c.filterable), [columns]);
  const filterFields = useMemo(() => filterableColumns.map((c) => c.id), [filterableColumns]);
  const filterLabels = useMemo(
    () =>
      Object.fromEntries(filterableColumns.map((c) => [c.id, c.label])) as Record<ColumnId, string>,
    [filterableColumns],
  );
  const filterKinds = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.kind ?? 'text']),
      ) as Record<ColumnId, FieldKind>,
    [filterableColumns],
  );
  const filterOptions = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.options ?? []]),
      ) as Record<ColumnId, FacetOption[]>,
    [filterableColumns],
  );

  const updateClauseOp = (id: string, op: FilterOp) =>
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) =>
        c.id === id ? { ...c, op, value: VALUELESS_OPS.has(op) ? '' : c.value } : c,
      ),
    }));
  const updateClauseValue = (id: string, value: string) =>
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) => (c.id === id ? { ...c, value } : c)),
    }));
  const removeClause = (id: string) =>
    setTableState((s) => ({ ...s, filters: s.filters.filter((c) => c.id !== id) }));
  const addClause = (field: ColumnId, op: FilterOp, value: string) =>
    setTableState((s) => ({
      ...s,
      filters: [...s.filters, { id: newClauseId(), field, op, value }],
    }));
  const clearClauses = () => setTableState((s) => ({ ...s, filters: [] }));

  const resetTable = () =>
    setTableState((s) => ({
      ...s,
      columnOrder: columns.map((c) => c.id),
      columnVisibility: {},
      columnWidths: {},
      density: 'normal',
    }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
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
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<Category, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="expense-categories"
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                onReset={resetTable}
                labels={tableLabels.settings}
              />
            </>
          }
        />

        {/* Orders its own rows — the table must not re-sort them. */}
        <DataTable<Category, ColumnId>
          sortMode="external"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={canWrite ? (row) => open(row) : undefined}
          activeRowId={editing?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{t('empty')}</div>}
          // Drag-to-reorder persists the manual display order (sortOrder).
          // Only while the table is in its natural order — a column sort would
          // otherwise be captured as the new manual order.
          rowDnd={
            canWrite && !tableState.sort
              ? { onReorder: (ids) => reorder.mutate({ ids }) }
              : undefined
          }
        />
      </div>
      {canWrite && <p className="px-1 text-muted-foreground text-xs">{t('reorderHint')}</p>}

      <Drawer open={creating || editing !== null} onOpenChange={(o) => !o && close()}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{creating ? t('add') : t('editTitle')}</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="space-y-4">
            {error && (
              <p
                role="alert"
                className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm"
              >
                {error}
              </p>
            )}
            <FieldRow label={t('labelEn')}>
              <Input value={form.labelEn} onChange={(e) => set('labelEn', e.target.value)} />
            </FieldRow>
            {FRENCH_ON && (
              <FieldRow label={t('labelFr')}>
                <Input value={form.labelFr} onChange={(e) => set('labelFr', e.target.value)} />
              </FieldRow>
            )}
            <FieldRow label={t('color')}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={t('color')}
                  value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#2563eb'}
                  onChange={(e) => set('color', e.target.value)}
                  className="h-9 w-10 cursor-pointer rounded border border-input bg-background"
                />
                <Input
                  value={form.color}
                  onChange={(e) => set('color', e.target.value)}
                  className="w-32"
                />
                <Badge
                  variant="outline"
                  className="border"
                  style={categoryPillStyle({ id: 'preview', color: form.color })}
                >
                  {form.icon ? `${form.icon} ` : ''}
                  {form.labelEn || t('preview')}
                </Badge>
              </div>
            </FieldRow>
            <FieldRow label={t('icon')}>
              <EmojiPicker
                value={form.icon}
                onSelect={(e) => set('icon', e)}
                onClear={() => set('icon', '')}
                triggerLabel={t('icon')}
                searchPlaceholder={t('emojiSearch')}
                emptyLabel={t('emojiEmpty')}
                clearLabel={t('iconClear')}
                categoryLabels={{
                  0: t('emojiCategories.smileys'),
                  1: t('emojiCategories.people'),
                  3: t('emojiCategories.animals'),
                  4: t('emojiCategories.food'),
                  5: t('emojiCategories.travel'),
                  6: t('emojiCategories.activities'),
                  7: t('emojiCategories.objects'),
                  8: t('emojiCategories.symbols'),
                  9: t('emojiCategories.flags'),
                }}
              />
            </FieldRow>
            <FieldRow label={t('glAccount')}>
              {/* Picked from the synced chart, not typed. A hand-entered number that
                  is not in the chart only failed at NetSuite push time — after the
                  report was approved. */}
              <GlAccountCombobox
                value={form.glAccountId}
                onValueChange={(v) => set('glAccountId', v)}
                placeholder={t('glAccountNone')}
              />
            </FieldRow>
            <div className="grid grid-cols-2 gap-3">
              <FieldRow label={t('itcGstHst')}>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.itcGstHstRate}
                  onChange={(e) => set('itcGstHstRate', Number(e.target.value))}
                />
              </FieldRow>
              <FieldRow label={t('itcQst')}>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.itcQstRate}
                  onChange={(e) => set('itcQstRate', Number(e.target.value))}
                />
              </FieldRow>
            </div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-2 text-sm">
              {/* VeloExpense: named by aria-label — Base UI's checkbox is a span its <label> does not name (f10). */}
              <Checkbox
                aria-label={t('pstRecoverable')}
                checked={form.pstRecoverable}
                onCheckedChange={(v) => set('pstRecoverable', v === true)}
              />
              {t('pstRecoverable')}
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-2 text-sm">
              {/* VeloExpense: named by aria-label, as above (f10). */}
              <Checkbox
                aria-label={t('requiresAttendees')}
                checked={form.requiresAttendees}
                onCheckedChange={(v) => set('requiresAttendees', v === true)}
              />
              {t('requiresAttendees')}
            </label>
            {/*
              Kind — a dropdown, matching Travel categories.
              
              It was a row of three toggle buttons, which read as three independent
              switches rather than as one choice with three answers; the same field on
              Travel categories is a Select, and two admin pages spelling the same kind of
              decision two different ways is a thing a reader has to learn twice.

              Editable freely on a NEW category. On an existing one, crossing the mileage
              boundary re-defines how every filed line derived its amount, so the server
              refuses it once line items exist — the OPTION that crosses is disabled rather
              than the whole control, which keeps the other choices reachable and says
              exactly which one is not. The server check is still the one that counts.
            */}
            {/* A plain wrapper, not `FieldRow`. That helper renders a `<label>`, and a
                `<label>` wrapped around a Select claims the accessible name of every control
                inside it — so each option would answer to the field's name rather than to
                its own, and a screen reader would read three identically-named choices. */}
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t('kind')}</span>
              <Select value={form.kind} onValueChange={(v) => v && set('kind', v as CategoryKind)}>
                <SelectTrigger>
                  {/* VeloExpense kit: Radix's SelectValue renders the chosen item's own text,
                      which is this same label; ExpenseOS's Base UI one needed a render
                      function for it. */}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => {
                    const crossesMileage = (k === 'mileage') !== (form.kind === 'mileage');
                    return (
                      <SelectItem
                        key={k}
                        value={k}
                        disabled={Boolean(editing) && filedCount > 0 && crossesMileage}
                      >
                        {t(`kinds.${k}`)}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="mt-1 text-muted-foreground text-xs">{t(`kindHelp.${form.kind}`)}</p>
              {Boolean(editing) && filedCount > 0 && (
                <p className="mt-1 text-muted-foreground text-xs">
                  {t('kindLockedHelp', { count: filedCount })}
                </p>
              )}
            </div>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-2 text-sm">
              {/* VeloExpense: named by aria-label, as above (f10). */}
              <Checkbox
                aria-label={tc('active')}
                checked={form.active}
                onCheckedChange={(v) => set('active', v === true)}
              />
              {tc('active')}
            </label>
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={close} disabled={saving}>
              {tc('cancel')}
            </Button>
            <Button onClick={save} disabled={!valid || saving}>
              {saving ? tc('saving') : tc('save')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

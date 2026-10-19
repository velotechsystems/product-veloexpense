'use client';

/**
 * Travel-category admin — the standard directory chrome (FilterPillBar +
 * DataTableToolbar + DataTable, status pills, drag-to-reorder, edit drawer),
 * bespoke for the same reason `ExpenseCategoriesAdmin` is: the generic
 * `AdminLookupPage` RJSF form cannot render an emoji picker, a pill color, or an
 * entity picker, and `TravelCategory` has neither the `externalIds` nor the
 * `description` its `BaseLookupRow` requires.
 *
 * Two columns carry most of the meaning, and both exist because the alternative was
 * invisible state:
 *
 *   · **Type** is which editor block a budget line in this category opens. Without
 *     it on the page, an admin has no way to see why picking "Airfare" produces a
 *     flight search and picking "Parking" produces an amount box.
 *   · **Maps to** is the expense category this rolls up into. A blank one is not an
 *     error — the trip still estimates — but it is the reason that line will never
 *     appear in budget-vs-actual, so the column says so rather than leaving somebody
 *     to discover it from a variance report that is quietly short.
 */
import {
  Badge,
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
import type { Locale } from '@expenseos/i18n/locales';
import { IconEdit, IconPlus, IconRestore, IconUserOff } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
// VeloExpense (w6-02): no [locale] segment.
import { useTopBarSlots } from '@/app/(app)/TopBar';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { TableExportMenu, useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { GlAccountCombobox } from '@/components/pickers/EntityPickers';
import { categoryPillStyle } from '@/lib/categoryColor';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
import type { AppRouter } from '@/server/routers/_app';

type Category = inferRouterOutputs<AppRouter>['travelCategories']['list'][number];
type ColumnId = 'name' | 'kind' | 'mapsTo' | 'gl' | 'color' | 'status';

const LINE_KINDS = [
  'STANDARD',
  'AIRFARE',
  'LODGING',
  'DEPARTMENT_MEAL',
  'CAR_RENTAL',
  'GROUND',
] as const;
type LineKind = (typeof LINE_KINDS)[number];

interface FormState {
  labelEn: string;
  labelFr: string;
  icon: string;
  color: string;
  lineKind: LineKind;
  expenseCategoryId: string | null;
  glAccountId: string | null;
  active: boolean;
}

const EMPTY: FormState = {
  labelEn: '',
  labelFr: '',
  icon: '',
  color: '#2563eb',
  lineKind: 'STANDARD',
  expenseCategoryId: null,
  glAccountId: null,
  active: true,
};

function toForm(c: Category): FormState {
  const label = (c.label ?? {}) as Record<string, string>;
  return {
    labelEn: label.en ?? '',
    labelFr: label['fr-CA'] ?? '',
    icon: c.icon ?? '',
    color: c.color ?? '#2563eb',
    lineKind: c.lineKind as LineKind,
    expenseCategoryId: c.expenseCategoryId ?? null,
    glAccountId: c.glAccountId ?? null,
    active: c.active,
  };
}

export function TravelCategoriesAdmin({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('admin.travelCategories');
  const tc = useTranslations('admin.common');
  const refusalText = useRefusalText(); // VeloExpense (w6-02): see the save's catch.
  const locale = useLocale() as Locale;
  const toolbarLabels = useToolbarLabels();
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const query = trpc.travelCategories.list.useQuery();
  const options = trpc.travelCategories.expenseCategoryOptions.useQuery();
  const invalidate = () => utils.travelCategories.list.invalidate();
  const create = trpc.travelCategories.create.useMutation({ onSuccess: invalidate });
  const update = trpc.travelCategories.update.useMutation({ onSuccess: invalidate });
  const reorder = trpc.travelCategories.reorder.useMutation({ onSuccess: invalidate });

  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  /** Budget lines already estimated against the category being edited. Non-zero
   *  freezes `lineKind` — the server's guard is the real enforcement; this only stops
   *  the form offering a change it is about to be refused. */
  const estimatedCount = editing?._count?.budgetLines ?? 0;

  const open = useCallback((c: Category | null) => {
    setError(null);
    setEditing(c);
    setCreating(c === null);
    setForm(c ? toForm(c) : EMPTY);
  }, []);
  const close = () => {
    setEditing(null);
    setCreating(false);
  };
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const valid = form.labelEn.trim() && form.labelFr.trim() && /^#[0-9a-fA-F]{6}$/.test(form.color);
  const saving = create.isPending || update.isPending;

  async function save() {
    setError(null);
    const payload = {
      label: { en: form.labelEn.trim(), 'fr-CA': form.labelFr.trim() },
      icon: form.icon.trim() || null,
      color: form.color,
      lineKind: form.lineKind,
      expenseCategoryId: form.expenseCategoryId,
      glAccountId: form.glAccountId,
      active: form.active,
    };
    try {
      if (creating) await create.mutateAsync(payload);
      else if (editing) await update.mutateAsync({ id: editing.id, ...payload });
      close();
    } catch (e) {
      // Kept OPEN on failure. The server refuses a type change on a category that
      // already has lines, and closing the drawer would discard everything typed
      // alongside a message nobody had time to read.
      // VeloExpense (w6-02): through `useRefusalText` (lib/trpc/refusal.ts) — a catalogued
      // refusal in the reader's language, else the server's own sentence (the type-change
      // refusal ExpenseOS shows here), else the generic one — never whatever was thrown
      // (check:i18n), as the Role Builder does.
      setError(refusalText(e, tc('unknownError')));
    }
  }

  const toggleActive = useCallback(
    async (c: Category) => {
      const msgKey = c.active ? 'confirmDeactivate' : 'confirmReactivate';
      if (!window.confirm(tc(msgKey, { name: getLocalized(c.label, locale) ?? c.id }))) return;
      await update.mutateAsync({ id: c.id, active: !c.active });
    },
    [tc, locale, update],
  );

  const expenseLabelById = useMemo(
    () => new Map((options.data?.items ?? []).map((o) => [o.id, o])),
    [options.data],
  );

  const columns: ColumnDef<Category, ColumnId>[] = useMemo(() => {
    const cols: ColumnDef<Category, ColumnId>[] = [
      {
        id: 'name',
        label: t('colName'),
        defaultWidth: 280,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (c) => getLocalized(c.label, locale) ?? c.id,
        cell: (c) => (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-base leading-none">{c.icon || '🧭'}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {getLocalized(c.label, locale) ?? c.id}
            </span>
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
      {
        id: 'kind',
        label: t('colKind'),
        defaultWidth: 170,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: LINE_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) })),
        },
        exportValue: (c) => t(`kinds.${c.lineKind as LineKind}`),
        cell: (c) => <Badge variant="secondary">{t(`kinds.${c.lineKind as LineKind}`)}</Badge>,
      },
      {
        id: 'mapsTo',
        label: t('colMapsTo'),
        defaultWidth: 220,
        filterable: { kind: 'text' },
        exportValue: (c) =>
          c.expenseCategory ? (getLocalized(c.expenseCategory.label, locale) ?? '') : '',
        cell: (c) =>
          c.expenseCategory ? (
            /**
             * NOT `truncate`. On a `<span>` — `display:inline` — its `overflow:hidden`
             * and `text-overflow:ellipsis` do not apply and its `white-space:nowrap`
             * does, so the only thing it achieved here was to stop the text wrapping
             * inside its own column while leaving nothing to clip it. The shared
             * DataTable's `<td>` wraps with `break-words` on purpose (it must not clip:
             * cells carry popovers and menus); letting it do that is the fix.
             */
            <span className="text-foreground">{getLocalized(c.expenseCategory.label, locale)}</span>
          ) : (
            // Not an error, and deliberately not styled as one — but it IS why this
            // category can never appear in budget-vs-actual, so it says which.
            <span className="text-muted-foreground text-xs">{t('unmapped')}</span>
          ),
      },
      {
        id: 'gl',
        label: t('colGlAccount'),
        defaultWidth: 200,
        exportValue: (c) => c.effectiveGlAccountNumber ?? '',
        cell: (c) =>
          c.effectiveGlAccountNumber ? (
            // Same as `mapsTo` above: inline `truncate` only forbade the wrap.
            <span className="text-foreground text-xs">
              {c.effectiveGlAccountNumber}
              {c.effectiveGlAccountName ? ` · ${c.effectiveGlAccountName}` : ''}
              {/* Inherited from the mapped expense category, which is the ORDINARY
                  case — showing the number with no provenance made admins set it a
                  second time here, and two places to change it is one too many. */}
              {c.glAccountInherited ? (
                <span className="ml-1 text-muted-foreground">{t('glInherited')}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">{t('glAccountNone')}</span>
          ),
      },
      {
        id: 'color',
        label: t('colColor'),
        defaultWidth: 120,
        cell: (c) => (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs"
            style={categoryPillStyle(c)}
          >
            {c.color ?? '—'}
          </span>
        ),
      },
      {
        id: 'status',
        label: tc('status'),
        defaultWidth: 120,
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
  }, [t, tc, locale, canWrite, open, toggleActive, update.isPending]);

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );
  const pillBar = useFilterPillBarWiring<Category, ColumnId>(columns, tableState, setTableState);

  /** Client-side: this is a fifteen-row reference table, not a corpus. */
  const rows = useMemo(() => {
    let out = query.data ?? [];
    for (const c of tableState.filters) {
      const text = (get: (r: Category) => string) => {
        const needle = c.value.toLowerCase();
        const h = (r: Category) => get(r).toLowerCase();
        if (c.op === 'contains') out = out.filter((r) => h(r).includes(needle));
        else if (c.op === 'doesNotContain') out = out.filter((r) => !h(r).includes(needle));
        else if (c.op === 'equals') out = out.filter((r) => h(r) === needle);
        else if (c.op === 'doesNotEqual') out = out.filter((r) => h(r) !== needle);
        else if (c.op === 'startsWith') out = out.filter((r) => h(r).startsWith(needle));
        else if (c.op === 'endsWith') out = out.filter((r) => h(r).endsWith(needle));
        else if (c.op === 'isEmpty') out = out.filter((r) => get(r).trim() === '');
        else if (c.op === 'isNotEmpty') out = out.filter((r) => get(r).trim() !== '');
      };
      if (c.field === 'name') text((r) => getLocalized(r.label, locale) ?? r.id);
      else if (c.field === 'mapsTo')
        text((r) =>
          r.expenseCategory ? (getLocalized(r.expenseCategory.label, locale) ?? '') : '',
        );
      else if (c.field === 'kind') {
        if (c.op === 'equals') out = out.filter((r) => r.lineKind === c.value);
        else if (c.op === 'doesNotEqual') out = out.filter((r) => r.lineKind !== c.value);
      } else if (c.field === 'status') {
        const wantActive = c.value === 'active';
        if (c.op === 'equals') out = out.filter((r) => r.active === wantActive);
        else if (c.op === 'doesNotEqual') out = out.filter((r) => r.active !== wantActive);
      }
    }
    return out;
  }, [query.data, tableState.filters, locale]);

  useTopBarSlots(
    () => ({
      right: canWrite ? (
        <Button size="sm" onClick={() => open(null)}>
          <IconPlus size={14} className="mr-1" />
          {t('add')}
        </Button>
      ) : null,
    }),
    [canWrite, t, open],
  );

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
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<Category, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="travel-categories"
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

        <DataTable<Category, ColumnId>
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
          // Only while the table is in its natural order: a column sort would
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
            <FieldRow label={t('labelFr')}>
              <Input value={form.labelFr} onChange={(e) => set('labelFr', e.target.value)} />
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

            <FieldRow label={t('color')}>
              <div className="flex items-center gap-2">
                <Input
                  value={form.color}
                  onChange={(e) => set('color', e.target.value)}
                  className="max-w-[10rem] font-mono"
                />
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-xs"
                  style={categoryPillStyle({ id: editing?.id ?? 'new', color: form.color })}
                >
                  {form.labelEn || t('preview')}
                </span>
              </div>
            </FieldRow>

            {/* The type. Frozen once anything has been estimated against the category:
                every existing line carries a payload shaped for the old block, and the
                new one has no field to read it out of. */}
            <FieldRow label={t('kind')}>
              <Select
                value={form.lineKind}
                onValueChange={(v) => v && set('lineKind', v as LineKind)}
                disabled={!creating && estimatedCount > 0}
              >
                <SelectTrigger>
                  {/* VeloExpense (w6-02): the kit's Radix <SelectValue> renders the chosen
                      item's own label. */}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`kinds.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-muted-foreground text-xs">{t(`kindHelp.${form.lineKind}`)}</p>
              {!creating && estimatedCount > 0 && (
                <p className="mt-1 text-warning text-xs">
                  {t('kindLockedHelp', { count: estimatedCount })}
                </p>
              )}
            </FieldRow>

            <FieldRow label={t('mapsTo')}>
              <Combobox
                items={(options.data?.items ?? []).map((o) => ({
                  value: o.id,
                  label: `${o.icon ? `${o.icon} ` : ''}${getLocalized(o.label, locale) ?? o.id}`,
                }))}
                value={form.expenseCategoryId}
                onValueChange={(v) => set('expenseCategoryId', v ?? null)}
                placeholder={t('mapsToNone')}
              />
              <p className="mt-1 text-muted-foreground text-xs">{t('mapsToHelp')}</p>
            </FieldRow>

            <FieldRow label={t('glAccount')}>
              <GlAccountCombobox
                value={form.glAccountId}
                onValueChange={(v) => set('glAccountId', v)}
              />
              <p className="mt-1 text-muted-foreground text-xs">
                {form.expenseCategoryId
                  ? t('glAccountInheritsHelp', {
                      category:
                        getLocalized(expenseLabelById.get(form.expenseCategoryId)?.label, locale) ??
                        '',
                    })
                  : t('glAccountHelp')}
              </p>
            </FieldRow>

            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is the control (child) */}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.active} onCheckedChange={(v) => set('active', v === true)} />
              {tc('active')}
            </label>
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={close}>
              {tc('cancel')}
            </Button>
            <Button disabled={!valid || saving} onClick={() => void save()}>
              {tc('save')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-medium text-foreground text-xs">{label}</div>
      {children}
    </div>
  );
}

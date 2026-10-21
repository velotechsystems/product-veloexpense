// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; the t() functions and memoized option lists are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/mileage-rates — the per-country mileage reimbursement rates.
 *
 * The router (`policies.mileageRate`) and the resolver have existed since A7;
 * there was simply no way to see or edit the rates, so a mileage expense in a
 * country nobody had seeded failed with "No mileage rate configured" and no
 * recourse. This is that surface.
 *
 * Standard listing shell: FilterPillBar + Toolbar + DataTable + right Drawer.
 *
 * The rate is stored as minor units per unit of distance (72 = $0.72/km) and shown
 * and edited as a decimal, because that's how every published rate is quoted.
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
  Field as FormField,
  IconEdit,
  IconPlus,
  Input,
  Radio,
  RadioGroup,
  RowActionsMenu,
  TableSettingsButton,
} from '@expenseos/design-system';
import { IconEye, IconFileImport, IconPlayerStop, IconTrash } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
import { useTopBarSlots } from '@/app/(app)/TopBar';
import { Field, Section } from '@/components/admin/AdminLookupPage';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { TableExportMenu, useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { CountryCombobox, CountryLabel } from '@/components/pickers/CountryDisplay';
import { GlAccountCombobox, UserCombobox } from '@/components/pickers/EntityPickers';
import { trpc } from '@/lib/trpc/client';
import { MileageBalanceImportDrawer } from './MileageBalanceImport';

type MileageUnit = 'KM' | 'MI';

interface Tier {
  id: string;
  /** Inclusive lower bound of the band, in the rule's unit. */
  fromDistance: string;
  /** Minor units per unit of distance. */
  rateMinor: string;
}

interface Subject {
  userId: string;
  user: { firstName: string | null; lastName: string | null; email: string };
}

interface RateRow {
  id: string;
  country: string;
  unit: MileageUnit;
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
  supersededById: string | null;
  glAccountId: string | null;
  tiers: Tier[];
  subjects: Subject[];
}

type ColumnId = 'country' | 'unit' | 'rate' | 'scope' | 'from' | 'to' | 'status';
/** No 'edit': a rule in force is never edited in place. It's superseded by a new
 *  one, which is what keeps "what did we pay in March" answerable. */
type DrawerMode = 'closed' | 'view' | 'create';

interface TierDraft {
  /** Lower bound as typed, in the rule's unit. */
  from: string;
  /** Rate as typed, e.g. "0.75". */
  rate: string;
}

interface FormData {
  country: string;
  unit: MileageUnit;
  effectiveFrom: string;
  glAccountId: string | null;
  subjectUserIds: string[];
  /**
   * Names for the people already on the form, by id.
   *
   * The picker only learns a name for somebody chosen in THIS session, so a form
   * pre-filled from another rule would list bare uuids — and "who does this rule
   * cover" is exactly what you check before saving a replacement.
   */
  subjectLabels: Record<string, string>;
  tiers: TierDraft[];
}

const EMPTY_FORM: FormData = {
  country: '',
  unit: 'KM',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  glAccountId: null,
  subjectUserIds: [],
  subjectLabels: {},
  // A rule always has a band starting at 0 — that one isn't removable.
  tiers: [{ from: '0', rate: '' }],
};

/** `72` → `"0.72"`. The currency is implicit (the country's), so this is a plain
 *  2-decimal conversion rather than a currency-aware format. */
export function minorToRate(minor: string): string {
  const n = Number(minor);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : '';
}

/** `"0.72"` → `72`. Returns null when the input isn't a usable positive rate. */
export function rateToMinor(rate: string): number | null {
  const n = Number(rate.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

const day = (d: string | Date | null): string => (d ? new Date(d).toISOString().slice(0, 10) : '');

const personName = (u: Subject['user']): string =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

/**
 * One band, spelled out: "0 – 5,000 km · $0.72/km", or "5,000 km and above ·
 * $0.66/km" for the last one.
 *
 * An open-ended top band has no upper number, so it says so rather than showing a
 * blank or an invented ceiling. The bands are stored ascending, so a band's end is
 * simply the next band's start.
 */
export function bandText(
  tier: Tier,
  rule: { tiers: Tier[]; unit: MileageUnit },
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const unit = t(`unitShort.${rule.unit}`);
  const index = rule.tiers.findIndex(
    (x) => x.fromDistance === tier.fromDistance && x.rateMinor === tier.rateMinor,
  );
  const next = index >= 0 ? rule.tiers[index + 1] : undefined;
  const rate = `${minorToRate(tier.rateMinor)}/${unit}`;
  const from = Number(tier.fromDistance).toLocaleString();
  if (!next) {
    // A single band covers everything, so "0 and above" would be noise.
    if (rule.tiers.length === 1) return rate;
    return `${t('bandAndAbove', { from, unit })} · ${rate}`;
  }
  return `${t('bandRange', { from, to: Number(next.fromDistance).toLocaleString(), unit })} · ${rate}`;
}

/** "0.75" for a flat rule, "0.75 → 0.71 over 3 bands" for a tiered one. */
export function summarizeTiers(tiers: Tier[]): string {
  if (tiers.length === 0) return '—';
  const first = minorToRate(tiers[0].rateMinor);
  if (tiers.length === 1) return first;
  return `${first} → ${minorToRate(tiers[tiers.length - 1].rateMinor)}`;
}

/** Open-ended, or covering today, means this is the rate in force. */
export function isCurrent(row: RateRow, now = new Date()): boolean {
  const from = new Date(row.effectiveFrom);
  if (from > now) return false;
  if (!row.effectiveTo) return true;
  return new Date(row.effectiveTo) >= now;
}

export function MileageRatesAdmin({ canEdit }: { canEdit: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const tc = useTranslations('admin.common');
  const t = useTranslations('admin.mileageRates');
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const query = trpc.policies.mileageRate.list.useQuery();
  const allRows = (query.data ?? []) as unknown as RateRow[];

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed');
  const [selected, setSelected] = useState<RateRow | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  /** The year-to-date (Concur) import drawer — separate from the rule drawer. */
  const [importOpen, setImportOpen] = useState(false);

  const invalidate = () => utils.policies.mileageRate.list.invalidate();
  const onErr = (e: { message: string }) => setError(e.message);

  const createMut = trpc.policies.mileageRate.create.useMutation({
    onSuccess: () => {
      invalidate();
      setDrawerMode('closed');
    },
    onError: onErr,
  });
  const retireMut = trpc.policies.mileageRate.retire.useMutation({
    onSuccess: invalidate,
    onError: onErr,
  });
  const deleteMut = trpc.policies.mileageRate.delete.useMutation({
    onSuccess: invalidate,
    onError: onErr,
  });

  const openView = (row: RateRow) => {
    setSelected(row);
    setError(null);
    setDrawerMode('view');
  };
  const openCreate = () => {
    setSelected(null);
    setError(null);
    setForm(EMPTY_FORM);
    setDrawerMode('create');
  };

  /** Pre-fill a new rule from an existing one — the usual way a rate changes is
   *  "same scope, same bands, new numbers from January". */
  const openSupersede = (row: RateRow) => {
    setSelected(null);
    setError(null);
    setForm({
      country: row.country,
      unit: row.unit,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      glAccountId: row.glAccountId,
      subjectUserIds: row.subjects.map((sub) => sub.userId),
      subjectLabels: Object.fromEntries(
        row.subjects.map((sub) => [sub.userId, personName(sub.user)]),
      ),
      tiers: row.tiers.map((tier) => ({
        from: tier.fromDistance,
        rate: minorToRate(tier.rateMinor),
      })),
    });
    setDrawerMode('create');
  };

  const retireRow = (row: RateRow) => {
    const on = window.prompt(t('retirePrompt', { country: row.country }), day(new Date()));
    if (!on) return;
    retireMut.mutate({ id: row.id, effectiveTo: on });
  };

  const removeRow = (row: RateRow) => {
    if (!window.confirm(t('confirmDelete', { country: row.country }))) return;
    deleteMut.mutate({ id: row.id });
  };

  const columns: ColumnDef<RateRow, ColumnId>[] = useMemo(
    () => [
      {
        id: 'country',
        label: t('colCountry'),
        defaultWidth: 210,
        sortable: true,
        filterable: { kind: 'text' },
        hideable: false,
        exportValue: (r) => r.country,
        cell: (r) => (
          <div className="flex w-full items-center gap-2">
            <CountryLabel code={r.country} />
            <span className="flex-1" />
            <RowActionsMenu
              ariaLabel={tc('rowActions')}
              actions={[
                {
                  id: 'view',
                  icon: <IconEye size={14} />,
                  label: tc('view'),
                  onClick: () => openView(r),
                },
                ...(canEdit
                  ? [
                      {
                        id: 'supersede',
                        icon: <IconEdit size={14} />,
                        label: t('supersede'),
                        // A rule in force is replaced, never edited — that's what
                        // keeps a past claim's rate reproducible.
                        disabled: r.supersededById !== null,
                        onClick: () => openSupersede(r),
                      },
                      {
                        id: 'retire',
                        icon: <IconPlayerStop size={14} />,
                        label: t('retire'),
                        disabled: r.supersededById !== null || r.effectiveTo !== null,
                        onClick: () => retireRow(r),
                      },
                      { divider: true as const },
                      {
                        id: 'delete',
                        icon: <IconTrash size={14} />,
                        label: tc('delete'),
                        destructive: true,
                        onClick: () => removeRow(r),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ),
      },
      {
        id: 'rate',
        label: t('colRate'),
        // Room for a band per line. A tiered rule read as "0.72 → 0.66" before,
        // which says the numbers but not where either one applies — and where the
        // band changes IS the rule.
        defaultWidth: 260,
        exportValue: (r) => r.tiers.map((x) => bandText(x, r, t)).join('; '),
        cell: (r) => (
          <ul className="flex min-w-0 flex-col gap-0.5 py-0.5">
            {r.tiers.map((tier) => (
              <li
                key={`${tier.fromDistance}-${tier.rateMinor}`}
                className="truncate text-foreground text-xs tabular-nums"
              >
                {bandText(tier, r, t)}
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: 'scope',
        label: t('colScope'),
        defaultWidth: 200,
        exportValue: (r) =>
          r.subjects.length === 0
            ? t('scopeDefault')
            : r.subjects.map((sub) => personName(sub.user)).join('; '),
        cell: (r) =>
          r.subjects.length === 0 ? (
            <span className="text-muted-foreground text-sm">{t('scopeDefault')}</span>
          ) : (
            <span
              className="truncate text-foreground text-sm"
              title={r.subjects.map((sub) => personName(sub.user)).join(', ')}
            >
              {r.subjects.length === 1
                ? personName(r.subjects[0].user)
                : t('scopePeople', { count: r.subjects.length })}
            </span>
          ),
      },
      {
        id: 'unit',
        label: t('colUnit'),
        defaultWidth: 110,
        filterable: {
          kind: 'enum',
          options: (['KM', 'MI'] as const).map((u) => ({ value: u, label: t(`unit.${u}`) })),
        },
        exportValue: (r) => r.unit,
        cell: (r) => <span className="text-muted-foreground text-sm">{t(`unit.${r.unit}`)}</span>,
      },
      {
        id: 'from',
        label: t('colFrom'),
        defaultWidth: 140,
        sortable: true,
        exportValue: (r) => day(r.effectiveFrom),
        cell: (r) => <span className="text-foreground text-sm">{day(r.effectiveFrom)}</span>,
      },
      {
        id: 'to',
        label: t('colTo'),
        defaultWidth: 140,
        exportValue: (r) => day(r.effectiveTo) || t('openEnded'),
        cell: (r) => (
          <span className="text-muted-foreground text-sm">
            {day(r.effectiveTo) || t('openEnded')}
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
            { value: 'current', label: t('current') },
            { value: 'inactive', label: t('notCurrent') },
          ],
        },
        exportValue: (r) => (isCurrent(r) ? t('current') : t('notCurrent')),
        cell: (r) => (
          <Badge variant={isCurrent(r) ? 'success' : 'secondary'}>
            {isCurrent(r) ? t('current') : t('notCurrent')}
          </Badge>
        ),
      },
    ],
    [t, tc, canEdit],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  const rows = useMemo(() => {
    // ~a handful of rows; filtering client-side is right here.
    let filtered = allRows;
    for (const c of tableState.filters) {
      const needle = c.value.toLowerCase();
      if (c.field === 'country' && c.op === 'contains') {
        filtered = filtered.filter((r) => r.country.toLowerCase().includes(needle));
      } else if (c.field === 'unit' && c.op === 'equals') {
        filtered = filtered.filter((r) => r.unit === c.value);
      } else if (c.field === 'status' && c.op === 'equals') {
        const wantCurrent = c.value === 'current';
        filtered = filtered.filter((r) => isCurrent(r) === wantCurrent);
      }
    }
    return filtered;
  }, [allRows, tableState.filters]);

  useTopBarSlots(
    () => ({
      right: canEdit ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <IconFileImport size={14} className="mr-1" />
            {t('importYtd')}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <IconPlus size={14} className="mr-1" />
            {t('addRate')}
          </Button>
        </div>
      ) : null,
    }),
    [canEdit, t],
  );

  const onSave = () => {
    setError(null);
    const country = form.country.trim().toUpperCase();
    if (country.length !== 2) {
      setError(t('countryInvalid'));
      return;
    }
    if (!form.effectiveFrom) {
      setError(t('fromRequired'));
      return;
    }
    const tiers: { fromDistance: number; rateMinor: string }[] = [];
    for (const [i, tier] of form.tiers.entries()) {
      const minor = rateToMinor(tier.rate);
      if (minor == null) {
        setError(t('rateInvalid'));
        return;
      }
      const from = Number(tier.from.trim().replace(',', '.'));
      if (!Number.isFinite(from) || from < 0) {
        setError(t('bandInvalid'));
        return;
      }
      // The bands only mean anything read in order, so a later one starting
      // below its predecessor is rejected rather than silently sorted.
      if (i > 0 && from <= Number(form.tiers[i - 1].from)) {
        setError(t('bandOutOfOrder'));
        return;
      }
      tiers.push({ fromDistance: from, rateMinor: String(minor) });
    }
    createMut.mutate({
      country,
      unit: form.unit,
      effectiveFrom: form.effectiveFrom,
      glAccountId: form.glAccountId,
      subjectUserIds: form.subjectUserIds,
      tiers,
    });
  };

  const saving = createMut.isPending;
  const pillBar = useFilterPillBarWiring<RateRow, ColumnId>(columns, tableState, setTableState);

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

      {error && drawerMode === 'closed' && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<RateRow, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="mileage-rates"
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

        <DataTable<RateRow, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={openView}
          activeRowId={selected?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{t('empty')}</div>}
          selectable={false}
          disableInfiniteScroll
        />
      </div>
      <p className="px-1 text-muted-foreground text-xs">{t('hint')}</p>

      <Drawer
        open={drawerMode !== 'closed'}
        onOpenChange={(next) => {
          if (!next) setDrawerMode('closed');
        }}
      >
        <DrawerContent width={520} resizable storageKey="admin.mileageRates">
          <DrawerHeader>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="truncate">
                {drawerMode === 'create' ? t('addTitle') : (selected?.country ?? '')}
              </DrawerTitle>
            </div>
            {drawerMode === 'view' && canEdit && selected && !selected.supersededById && (
              <Button variant="outline" size="sm" onClick={() => openSupersede(selected)}>
                <IconEdit size={14} className="mr-1" />
                {t('supersede')}
              </Button>
            )}
          </DrawerHeader>

          {drawerMode === 'view' && selected ? (
            <DrawerBody className="space-y-6">
              <Section title={tc('details')}>
                <Field label={t('colCountry')}>{selected.country}</Field>
                <Field label={t('colUnit')}>{t(`unit.${selected.unit}`)}</Field>
                <Field label={t('colFrom')}>{day(selected.effectiveFrom)}</Field>
                <Field label={t('colTo')}>{day(selected.effectiveTo) || t('openEnded')}</Field>
                <Field label={tc('status')}>
                  <Badge variant={isCurrent(selected) ? 'success' : 'secondary'}>
                    {isCurrent(selected) ? t('current') : t('notCurrent')}
                  </Badge>
                </Field>
                {selected.supersededById && (
                  <Field label={t('supersededLabel')}>{t('supersededYes')}</Field>
                )}
              </Section>

              <Section title={t('bandsTitle')} hint={t('bandsHint')}>
                <ul className="space-y-1">
                  {selected.tiers.map((tier, i) => {
                    const next = selected.tiers[i + 1];
                    return (
                      <li key={tier.id} className="flex items-baseline justify-between text-sm">
                        <span className="text-muted-foreground">
                          {next
                            ? t('bandRange', {
                                from: tier.fromDistance,
                                to: next.fromDistance,
                                unit: t(`unitShort.${selected.unit}`),
                              })
                            : t('bandOpen', {
                                from: tier.fromDistance,
                                unit: t(`unitShort.${selected.unit}`),
                              })}
                        </span>
                        <span className="font-medium text-foreground tabular-nums">
                          {minorToRate(tier.rateMinor)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Section>

              <Section title={t('colScope')}>
                {selected.subjects.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('scopeDefaultHelp')}</p>
                ) : (
                  <ul className="space-y-0.5 text-sm">
                    {selected.subjects.map((sub) => (
                      <li key={sub.userId} className="text-foreground">
                        {personName(sub.user)}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </DrawerBody>
          ) : (
            <>
              <DrawerBody className="space-y-4">
                {error && <p className="text-destructive text-sm">{error}</p>}
                <div className="grid grid-cols-2 gap-4">
                  <FormField htmlFor="mr-country" label={t('colCountry')} required>
                    <CountryCombobox
                      id="mr-country"
                      value={form.country || null}
                      onValueChange={(v) => setForm({ ...form, country: v ?? '' })}
                      placeholder={t('countryPlaceholder')}
                    />
                  </FormField>
                  <FormField htmlFor="mr-from" label={t('colFrom')} required>
                    <Input
                      id="mr-from"
                      type="date"
                      value={form.effectiveFrom}
                      onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
                    />
                  </FormField>
                </div>
                <FormField label={t('colUnit')} required>
                  <RadioGroup
                    value={form.unit}
                    onValueChange={(v) => setForm({ ...form, unit: v as MileageUnit })}
                    className="flex gap-4"
                  >
                    {(['KM', 'MI'] as const).map((u) => (
                      <label
                        key={u}
                        htmlFor={`mr-unit-${u}`}
                        className="flex cursor-pointer items-center gap-2 text-foreground text-sm"
                      >
                        {/* VeloExpense: named by aria-label — Base UI's radio is a span
                            that the wrapping <label> does not name (as on job levels). */}
                        <Radio id={`mr-unit-${u}`} value={u} aria-label={t(`unit.${u}`)} />
                        {t(`unit.${u}`)}
                      </label>
                    ))}
                  </RadioGroup>
                </FormField>
                {/* No end date: a rule ends by being superseded, or by being
                    retired from the row menu. */}
                <FormField
                  htmlFor="mr-gl"
                  label={t('glAccount')}
                  optional
                  description={t('glAccountHelp')}
                >
                  <GlAccountCombobox
                    id="mr-gl"
                    value={form.glAccountId}
                    onValueChange={(v) => setForm({ ...form, glAccountId: v })}
                    placeholder={t('glAccountNone')}
                  />
                </FormField>

                <FormField label={t('colScope')} description={t('scopeHelp')}>
                  <SubjectPicker
                    value={form.subjectUserIds}
                    knownLabels={form.subjectLabels}
                    onChange={(ids) => setForm({ ...form, subjectUserIds: ids })}
                    addLabel={t('addPerson')}
                    removeLabel={tc('remove')}
                    emptyLabel={t('scopeDefaultHelp')}
                  />
                </FormField>

                <FormField label={t('bandsTitle')} required description={t('bandsHint')}>
                  <div className="space-y-2">
                    {form.tiers.map((tier, i) => (
                      // A band is a row of the rule, so it gets the same bordered
                      // box an expense-report line item gets — the shape already
                      // means "one item in a list you can add to and remove from".
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: bands are positional; there is no stable id before save
                        key={i}
                        className="flex items-end gap-2 rounded-md border border-border p-2"
                      >
                        <div className="flex-1">
                          <span className="mb-1 block text-muted-foreground text-xs">
                            {t('bandFrom', { unit: t(`unitShort.${form.unit}`) })}
                          </span>
                          <Input
                            inputMode="decimal"
                            aria-label={t('bandFrom', { unit: t(`unitShort.${form.unit}`) })}
                            // The opening band always starts at 0; letting it be
                            // edited is the one way to leave distance unpriced.
                            disabled={i === 0}
                            value={tier.from}
                            onChange={(e) => {
                              const tiers = [...form.tiers];
                              tiers[i] = { ...tiers[i], from: e.target.value };
                              setForm({ ...form, tiers });
                            }}
                          />
                        </div>
                        <div className="flex-1">
                          <span className="mb-1 block text-muted-foreground text-xs">
                            {t('rateLabel')}
                          </span>
                          <Input
                            inputMode="decimal"
                            placeholder="0.72"
                            aria-label={`${t('rateLabel')} ${i + 1}`}
                            value={tier.rate}
                            onChange={(e) => {
                              const tiers = [...form.tiers];
                              tiers[i] = { ...tiers[i], rate: e.target.value };
                              setForm({ ...form, tiers });
                            }}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('removeBand')}
                          disabled={i === 0}
                          onClick={() =>
                            setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i) })
                          }
                        >
                          <IconTrash size={14} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setForm({ ...form, tiers: [...form.tiers, { from: '', rate: '' }] })
                      }
                    >
                      <IconPlus size={14} className="mr-1" />
                      {t('addBand')}
                    </Button>
                  </div>
                </FormField>
              </DrawerBody>
              <DrawerFooter>
                <Button variant="ghost" onClick={() => setDrawerMode('closed')} disabled={saving}>
                  {tc('cancel')}
                </Button>
                <Button onClick={onSave} disabled={saving}>
                  {saving
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

      {canEdit && <MileageBalanceImportDrawer open={importOpen} onOpenChange={setImportOpen} />}
    </div>
  );
}

// ── Subject picker ─────────────────────────────────────────────────

/**
 * The people a car-allowance rule covers. Empty means "the country default",
 * which is the common case, so the list starts empty and adding the first person
 * is what turns the rule into an allowance.
 */
function SubjectPicker({
  value,
  knownLabels,
  onChange,
  addLabel,
  removeLabel,
  emptyLabel,
}: {
  value: string[];
  /** Names carried in by a pre-filled form; see FormData.subjectLabels. */
  knownLabels: Record<string, string>;
  onChange: (ids: string[]) => void;
  addLabel: string;
  removeLabel: string;
  emptyLabel: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {value.map((id) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate text-foreground">
                {labels[id] ?? knownLabels[id] ?? id}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={removeLabel}
                onClick={() => onChange(value.filter((x) => x !== id))}
              >
                <IconTrash size={13} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <UserCombobox
        value={pending}
        onValueChange={(id, item) => {
          if (!id || value.includes(id)) return;
          // Remember the label so the chip reads as a name rather than a uuid —
          // the picker only resolves the one it currently holds.
          if (item?.label) setLabels((m) => ({ ...m, [id]: item.label }));
          onChange([...value, id]);
          setPending(null);
        }}
        placeholder={addLabel}
      />
    </div>
  );
}

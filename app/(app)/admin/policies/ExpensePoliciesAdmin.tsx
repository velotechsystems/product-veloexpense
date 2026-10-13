'use client';

import {
  Button,
  DataTableToolbar,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  SchemaForm,
  type SchemaFormHandle,
  TableSettingsButton,
} from '@expenseos/design-system';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { IconCheck } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import { formatMinor, majorToMinor, minorToMajorInput, pickText } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';

/**
 * Per-category policy editor. Each row is one ExpenseCategory; clicking
 * a row opens the edit drawer, which mutates the joined ExpensePolicy
 * via RJSF. Money is surfaced as dollars in the form (not cents) — we
 * convert at the boundary, since admins think in dollars.
 *
 * Renders through the shared listing stack (DataTable + DataTableToolbar +
 * FilterPillBar + row-click drawer) per the listing standard. The list is a
 * fixed, sortOrder-driven set of ~12 categories, so the only filterable
 * column is the category name; per-column sort/selection are left off.
 *
 * Ported from ExpenseOS (550b2945) with the `expensePolicy` router (w4-02c, d65).
 * VeloExpense: the limits are labelled and converted in the organization's policy
 * currency (`policies.expensePolicy.currency`), where ExpenseOS assumes CAD (its TODO
 * below). Nothing enforces these limits until the cutover (w4-02d).
 */

interface PolicyRow {
  category: {
    id: string;
    label: Record<string, string>;
    icon: string | null;
    glAccount: string | null;
  };
  policy: {
    categoryId: string;
    receiptRequired: boolean;
    approvalRequired: boolean;
    perTransactionLimitMinor: string | null;
    dailyLimitMinor: string | null;
    monthlyLimitMinor: string | null;
    annualLimitMinor: string | null;
    notes: string | null;
  } | null;
}

interface PolicyFormData {
  receiptRequired: boolean;
  approvalRequired: boolean;
  /** Dollars (or null for "no limit"). */
  perTransactionLimit: number | null;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  annualLimit: number | null;
  notes: string | null;
}

type ColumnId =
  | 'category'
  | 'receipt'
  | 'approval'
  | 'perTransaction'
  | 'daily'
  | 'monthly'
  | 'annual';

const EMPTY_FORM: PolicyFormData = {
  receiptRequired: true,
  approvalRequired: true,
  perTransactionLimit: null,
  dailyLimit: null,
  monthlyLimit: null,
  annualLimit: null,
  notes: null,
};

// The org policy currency. Mirrors the SystemFlag default; the admin page
// doesn't yet let you change it (Phase 3 surfaces this control). All policy
// limits are amounts in this currency.
// TODO(currency): thread the real org policy currency rather than assuming CAD.
// VeloExpense: threaded — each helper takes the policy currency, CAD (ExpenseOS's
// assumption) only when none is given, and the screen passes the organization's.
const POLICY_CURRENCY = 'CAD';

/** A policy limit (minor-unit string) → "CAD 50.00": the policy-currency code
 *  prefix + an exponent-correct amount (formatMinor renders no symbol here, so
 *  the code keeps the currency label the limits table always showed). */
function fmtLimit(minor: string | null, locale: string, currency: string = POLICY_CURRENCY): string {
  const limitCurrency = { code: currency } as const;
  return minor === null
    ? formatMinor(null, limitCurrency, locale)
    : `${currency} ${formatMinor(BigInt(minor), limitCurrency, locale)}`;
}

/** Minor-unit string → major-unit number for the edit form, exponent-aware via
 *  the shared money helpers (no hardcoded ÷100). `null`/blank → null. */
export function minorStringToDollars(
  v: string | null,
  currency: string = POLICY_CURRENCY,
): number | null {
  if (!v) return null;
  return Number(minorToMajorInput(BigInt(v), currency));
}

/** Major-unit form number → minor-unit string for the mutation boundary,
 *  exponent-aware via the shared money helpers (no hardcoded ×100). */
export function dollarsToMinorString(
  v: number | null | undefined,
  locale: string,
  currency: string = POLICY_CURRENCY,
): string | null {
  if (v == null || Number.isNaN(v)) return null;
  return (majorToMinor(v, currency, locale) ?? 0n).toString();
}

export function policyToForm(
  p: PolicyRow['policy'],
  currency: string = POLICY_CURRENCY,
): PolicyFormData {
  if (!p) return EMPTY_FORM;
  return {
    receiptRequired: p.receiptRequired,
    approvalRequired: p.approvalRequired,
    perTransactionLimit: minorStringToDollars(p.perTransactionLimitMinor, currency),
    dailyLimit: minorStringToDollars(p.dailyLimitMinor, currency),
    monthlyLimit: minorStringToDollars(p.monthlyLimitMinor, currency),
    annualLimit: minorStringToDollars(p.annualLimitMinor, currency),
    notes: p.notes,
  };
}

function buildPolicySchema(t: (k: string) => string): { schema: RJSFSchema; uiSchema: UiSchema } {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      receiptRequired: { type: 'boolean', title: t('receiptRequired') },
      approvalRequired: { type: 'boolean', title: t('approvalRequired') },
      perTransactionLimit: {
        type: ['number', 'null'],
        title: t('perTransactionLimit'),
        description: t('perTransactionLimitHelp'),
        minimum: 0,
      },
      dailyLimit: { type: ['number', 'null'], title: t('dailyLimit'), minimum: 0 },
      monthlyLimit: { type: ['number', 'null'], title: t('monthlyLimit'), minimum: 0 },
      annualLimit: { type: ['number', 'null'], title: t('annualLimit'), minimum: 0 },
      notes: { type: ['string', 'null'], title: t('notes') },
    },
  };
  const uiSchema: UiSchema = { notes: { 'ui:widget': 'textarea' } };
  return { schema, uiSchema };
}

/** Boolean policy flag → success check / muted em-dash, with an accessible
 *  label so screen readers announce the state (the column header gives context). */
function BoolFlag({ on }: { on: boolean | undefined }) {
  const t = useTranslations('admin.policies');
  return on ? (
    <IconCheck size={16} className="text-success" role="img" aria-label={t('flagYes')} />
  ) : (
    <span role="img" aria-label={t('flagNo')} className="text-muted-foreground">
      —
    </span>
  );
}

export function ExpensePoliciesAdmin({ canWrite }: { canWrite: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('admin.policies');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const tableLabels = useTableLabels();
  const query = trpc.policies.expensePolicy.byCategory.useQuery();
  // VeloExpense: the organization's policy currency; CAD until it has loaded.
  const currency = trpc.policies.expensePolicy.currency.useQuery().data?.code ?? POLICY_CURRENCY;
  const upsert = trpc.policies.expensePolicy.upsert.useMutation({
    onSuccess: () => query.refetch(),
  });

  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const formRef = useRef<SchemaFormHandle>(null);
  const { schema, uiSchema } = useMemo(() => buildPolicySchema((k) => t(`fields.${k}`)), [t]);
  const formData = useMemo(
    () => policyToForm(editing?.policy ?? null, currency),
    [editing, currency],
  );

  const rows = useMemo(() => query.data ?? [], [query.data]);

  const columns = useMemo<ColumnDef<PolicyRow, ColumnId>[]>(
    () => [
      {
        id: 'category',
        label: t('cols.category'),
        defaultWidth: 220,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (row) => (
          <span>
            <span className="mr-2">{row.category.icon ?? ''}</span>
            {pickText(row.category.label, locale)}
          </span>
        ),
      },
      {
        id: 'receipt',
        label: t('cols.receipt'),
        defaultWidth: 100,
        cell: (row) => <BoolFlag on={row.policy?.receiptRequired} />,
      },
      {
        id: 'approval',
        label: t('cols.approval'),
        defaultWidth: 100,
        cell: (row) => <BoolFlag on={row.policy?.approvalRequired} />,
      },
      {
        id: 'perTransaction',
        label: t('cols.perTransaction'),
        defaultWidth: 140,
        cell: (row) => (
          <span className="block text-right tabular-nums">
            {fmtLimit(row.policy?.perTransactionLimitMinor ?? null, locale, currency)}
          </span>
        ),
      },
      {
        id: 'daily',
        label: t('cols.daily'),
        defaultWidth: 130,
        cell: (row) => (
          <span className="block text-right tabular-nums">
            {fmtLimit(row.policy?.dailyLimitMinor ?? null, locale, currency)}
          </span>
        ),
      },
      {
        id: 'monthly',
        label: t('cols.monthly'),
        defaultWidth: 130,
        cell: (row) => (
          <span className="block text-right tabular-nums">
            {fmtLimit(row.policy?.monthlyLimitMinor ?? null, locale, currency)}
          </span>
        ),
      },
      {
        id: 'annual',
        label: t('cols.annual'),
        defaultWidth: 130,
        cell: (row) => (
          <span className="block text-right tabular-nums">
            {fmtLimit(row.policy?.annualLimitMinor ?? null, locale, currency)}
          </span>
        ),
      },
    ],
    [t, locale, currency],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );
  const pillBar = useFilterPillBarWiring<PolicyRow, ColumnId>(columns, tableState, setTableState);

  // Client-side filter (≈12 rows) — only the category name is filterable.
  const filteredRows = useMemo(() => {
    const categoryClauses = tableState.filters.filter((c) => c.field === 'category');
    let out = rows;
    for (const c of categoryClauses) {
      const v = c.value.toLowerCase();
      const name = (r: PolicyRow) => pickText(r.category.label, locale).toLowerCase();
      if (c.op === 'contains') out = out.filter((r) => name(r).includes(v));
      else if (c.op === 'doesNotContain') out = out.filter((r) => !name(r).includes(v));
      else if (c.op === 'equals') out = out.filter((r) => name(r) === v);
      else if (c.op === 'doesNotEqual') out = out.filter((r) => name(r) !== v);
      else if (c.op === 'startsWith') out = out.filter((r) => name(r).startsWith(v));
      else if (c.op === 'endsWith') out = out.filter((r) => name(r).endsWith(v));
    }
    return out;
  }, [rows, tableState.filters, locale]);

  // Convert dollars→minor at the boundary, upsert, then close the drawer.
  const onSave = async (data: PolicyFormData) => {
    if (!editing) return;
    await upsert.mutateAsync({
      categoryId: editing.category.id,
      patch: {
        receiptRequired: data.receiptRequired,
        approvalRequired: data.approvalRequired,
        perTransactionLimitMinor: dollarsToMinorString(data.perTransactionLimit, locale, currency),
        dailyLimitMinor: dollarsToMinorString(data.dailyLimit, locale, currency),
        monthlyLimitMinor: dollarsToMinorString(data.monthlyLimit, locale, currency),
        annualLimitMinor: dollarsToMinorString(data.annualLimit, locale, currency),
        notes: data.notes,
      },
    });
    setEditing(null);
  };

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
          loading={query.isLoading}
          rightSlot={
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
          }
        />
        <DataTable<PolicyRow, ColumnId>
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.category.id}
          loading={query.isLoading}
          totalCount={filteredRows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={canWrite ? (row) => setEditing(row) : undefined}
          activeRowId={editing?.category.id ?? null}
          labels={tableLabels}
          disableInfiniteScroll
          renderEmpty={() => <span className="text-muted-foreground text-sm">{tc('loading')}</span>}
        />
      </div>

      <Drawer open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DrawerContent resizable storageKey="admin.policies">
          <DrawerHeader>
            <DrawerTitle>{editing ? pickText(editing.category.label, locale) : ''}</DrawerTitle>
            <DrawerDescription>{t('drawerDescription')}</DrawerDescription>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-6">
            <SchemaForm<PolicyFormData>
              ref={formRef}
              schema={schema}
              uiSchema={uiSchema}
              formData={formData}
              onSubmit={onSave}
              disabled={!canWrite || upsert.isPending}
            >
              <span />
            </SchemaForm>
          </div>
          <DrawerFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={() => formRef.current?.submit()}
              disabled={!canWrite || upsert.isPending}
            >
              {upsert.isPending ? tc('saving') : tc('save')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

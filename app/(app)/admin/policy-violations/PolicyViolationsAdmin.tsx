// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; t()/helper closures are render-stable.
/* eslint-disable react-hooks/exhaustive-deps -- VeloExpense: the same exemption as the Biome line above, for ESLint. */
'use client';

/**
 * /admin/policy-violations — the policy-violation register (exceptions view).
 * Lists every violation raised at validation time across reports; a manager can
 * acknowledge a WARNING/INFO with a note (reusing policyRule.resolveViolation).
 * A BLOCK is never acknowledgeable — it must be fixed on the report. Toolbar +
 * FilterPillBar + DataTable + acknowledge drawer, per the listing UX standard.
 *
 * Ported from ExpenseOS (550b2945) with `policyRule.violations` / `resolveViolation`
 * (w4-02e, d63). VeloExpense: the drawer restates the resolved sentence rather than the
 * stored key (below); the rows carry no travel subject yet (the router's note).
 */
import {
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
  RowActionsMenu,
  TableSettingsButton,
  Textarea,
} from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import { IconCheck } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { pickLabel } from '@/components/admin/AdminLookupPage';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { violationValues } from '@/components/policy/violations';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';

type Row = inferRouterOutputs<AppRouter>['policies']['policyRule']['violations'][number];
type ColumnId =
  | 'report'
  | 'submitter'
  | 'kind'
  | 'severity'
  | 'message'
  | 'category'
  | 'status'
  | 'created';

export function PolicyViolationsAdmin({ canManage }: { canManage: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('policyRules');
  const locale = useLocale() as Locale;
  const tExpenses = useTranslations('expenses');
  /** The rule kind's human name, falling back to the code when a new kind has no label yet. */
  const kindLabel = (code: string) => (t.has(`kind.${code}`) ? t(`kind.${code}`) : code);
  /** A violation message: prose if the engine wrote prose, otherwise the resolved key. */
  /**
   * The sentence for a violation, with its numbers in it.
   *
   * The VALUES are not optional decoration: six of these labels carry an ICU
   * placeholder ("Receipt expected over {threshold}"), and resolving the key without
   * them prints the braces verbatim — which is how this column came to show "Receipt
   * required over {threshold}" to admins. `violationValues` is the same helper both
   * workbench call sites use; this screen was the third copy of the pattern and the
   * only one that never got it.
   *
   * The try/catch matches the workbench's, and for its reason: next-intl throws
   * FORMATTING_ERROR when a placeholder has no value, and this runs inside a `useMemo`
   * during render, so an unguarded throw takes the whole register down. A violation
   * whose payload is missing should render its own key — visibly wrong, and fixable —
   * rather than deny access to the page.
   */
  const msgLabel = (row: Pick<Row, 'message' | 'data' | 'severity'>) => {
    const key = `policy.labels.${row.message}`;
    if (!tExpenses.has(key)) return row.message;
    try {
      return tExpenses(key, violationValues(row, locale) as never);
    } catch {
      return row.message;
    }
  };
  const tableLabels = useTableLabels();
  const utils = trpc.useUtils();

  const list = trpc.policies.policyRule.violations.useQuery();
  const rows = useMemo(() => list.data ?? [], [list.data]);

  const [editing, setEditing] = useState<{ row: Row; note: string } | null>(null);
  const resolve = trpc.policies.policyRule.resolveViolation.useMutation({
    onSuccess: () => utils.policies.policyRule.violations.invalidate(),
  });

  const fmtDate = (d: string | Date | null): string =>
    d
      ? new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

  const columns = useMemo<ColumnDef<Row, ColumnId>[]>(
    () => [
      {
        // The subject, which is a report OR a travel request now. Kept under the id
        // `report` so a saved view or a stored column layout from before travel
        // violations existed still resolves.
        id: 'report',
        label: t('viol.col.subject'),
        defaultWidth: 200,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (r) => (
          <div className="flex flex-col">
            <span className="font-mono text-foreground text-xs">{r.subjectNumber}</span>
            <span className="text-muted-foreground text-xs">{r.subjectTitle}</span>
          </div>
        ),
      },
      {
        id: 'submitter',
        label: t('viol.col.submitter'),
        defaultWidth: 160,
        cell: (r) => <span className="text-foreground text-sm">{r.submitterName}</span>,
      },
      {
        id: 'kind',
        label: t('viol.col.kind'),
        defaultWidth: 150,
        /**
         * The rule's NAME, not its enum. This column rendered `TIP_PERCENTAGE` and
         * `RECEIPT_THRESHOLD` verbatim (GA readiness report F26 / F27), which reads as
         * debug output and — with two `RECEIPT_THRESHOLD` rules configured at different
         * amounts — made two different rules indistinguishable.
         */
        cell: (r) => <span className="text-muted-foreground text-sm">{kindLabel(r.kind)}</span>,
      },
      {
        id: 'severity',
        label: t('viol.col.severity'),
        defaultWidth: 110,
        cell: (r) => {
          const cls =
            r.severity === 'BLOCK'
              ? 'text-destructive'
              : r.severity === 'WARNING'
                ? 'text-warning'
                : 'text-muted-foreground';
          return (
            <span className={`font-medium text-sm ${cls}`}>{t(`severity.${r.severity}`)}</span>
          );
        },
      },
      {
        id: 'message',
        label: t('viol.col.message'),
        defaultWidth: 220,
        /**
         * `PolicyViolation.message` is documented as pre-localized, and for rules whose
         * engine emits prose it is. For the rest it holds the message KEY, so this column
         * showed `receiptThresholdBlock` and `currencyMismatch` raw — in BOTH locales,
         * which is what gave the report its "raw i18n keys" finding (F27). The workbench
         * already resolves these through `policy.labels.*`; this does the same, and falls
         * back to the stored text when the engine did write prose.
         */
        /**
         * NOT `truncate`. On a `<span>` — `display:inline` — its `overflow:hidden` and
         * `text-overflow:ellipsis` do not apply while its `white-space:nowrap` does, so
         * all it achieved was to stop the sentence wrapping inside its own column and
         * leave nothing to clip it. These are the longest strings in the register, and
         * they ran into the column beside them. The shared DataTable's `<td>` wraps with
         * `break-words` on purpose.
         */
        cell: (r) => <span className="text-foreground text-sm">{msgLabel(r)}</span>,
      },
      {
        id: 'category',
        label: t('viol.col.category'),
        defaultWidth: 150,
        cell: (r) => (
          <span className="text-muted-foreground text-sm">
            {r.categoryLabel ? pickLabel(r.categoryLabel, locale) : '—'}
          </span>
        ),
      },
      {
        id: 'status',
        label: t('viol.col.status'),
        defaultWidth: 130,
        cell: (r) =>
          r.resolvedAt ? (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <IconCheck size={13} /> {t('viol.status.resolved')}
            </span>
          ) : (
            <span className="text-foreground text-sm">{t('viol.status.open')}</span>
          ),
      },
      {
        id: 'created',
        label: t('viol.col.created'),
        defaultWidth: 130,
        cell: (r) => <span className="text-muted-foreground text-xs">{fmtDate(r.createdAt)}</span>,
      },
    ],
    [t, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    // The actions column has to be in the seeded column order or the table never
    // renders it. A row click reaches the same drawer, so nothing was unreachable —
    // but a declared affordance that never appears is still a bug.
    createDataTableState([...columns, { id: 'actions' }] as never, {}),
  );

  const filteredRows = useMemo(() => {
    let out = rows;
    for (const c of tableState.filters) {
      if (c.field === 'report' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter(
          (r) =>
            r.subjectNumber.toLowerCase().includes(n) ||
            (r.subjectTitle ?? '').toLowerCase().includes(n),
        );
      }
    }
    return out;
  }, [rows, tableState.filters]);

  const pillBar = useFilterPillBarWiring<Row, ColumnId>(columns, tableState, setTableState);

  const rowActions = (r: Row) =>
    canManage && r.severity !== 'BLOCK'
      ? [
          {
            id: 'resolve',
            icon: <IconCheck size={14} />,
            label: t('viol.resolve'),
            onClick: () => setEditing({ row: r, note: r.resolveNote ?? '' }),
          },
        ]
      : [];

  const columnsWithActions = useMemo<ColumnDef<Row, ColumnId | 'actions'>[]>(
    () => [
      ...(columns as ColumnDef<Row, ColumnId | 'actions'>[]),
      {
        id: 'actions',
        label: '',
        defaultWidth: 60,
        hideable: false,
        draggable: false,
        resizable: false,
        pinnable: false,
        cell: (r) => {
          const actions = rowActions(r);
          return actions.length ? (
            <div className="flex justify-end">
              <RowActionsMenu ariaLabel={t('viol.actions')} actions={actions} />
            </div>
          ) : null;
        },
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
        <DataTable<Row, ColumnId | 'actions'>
          columns={columnsWithActions}
          rows={filteredRows}
          rowKey={(r) => r.id}
          totalCount={filteredRows.length}
          state={tableState as DataTableState<ColumnId | 'actions'>}
          onStateChange={setTableState as never}
          onRowClick={(r) =>
            canManage && r.severity !== 'BLOCK' && setEditing({ row: r, note: r.resolveNote ?? '' })
          }
          loading={list.isLoading}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('viol.emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('viol.emptyBody')}</div>
            </div>
          )}
        />
      </div>

      {editing && (
        <Drawer open onOpenChange={(o) => !o && setEditing(null)}>
          <DrawerContent width={480}>
            <DrawerHeader>
              <DrawerTitle>{t('viol.resolveTitle')}</DrawerTitle>
            </DrawerHeader>
            <DrawerBody className="space-y-3">
              {/* VeloExpense: the resolved sentence, as in the Issue column. ExpenseOS printed
                  `message` raw here, which since the engine stores KEYS is the key itself
                  ("receiptThreshold"), on the one screen whose job is to say what is being
                  acknowledged. */}
              <p className="text-muted-foreground text-sm">
                {t(`severity.${editing.row.severity}`)}: {msgLabel(editing.row)}
              </p>
              <p className="text-[11px] text-muted-foreground">{t('viol.resolveHint')}</p>
              <FormField htmlFor="viol-note" label={t('viol.resolve')}>
                <Textarea
                  id="viol-note"
                  rows={3}
                  value={editing.note}
                  placeholder={t('viol.resolvePlaceholder')}
                  onChange={(e) => setEditing((s) => (s ? { ...s, note: e.target.value } : s))}
                />
              </FormField>
            </DrawerBody>
            <DrawerFooter>
              {editing.row.resolvedAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mr-auto text-destructive"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate(
                      { id: editing.row.id, note: null },
                      { onSuccess: () => setEditing(null) },
                    )
                  }
                >
                  {t('viol.clear')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
              <Button
                size="sm"
                disabled={resolve.isPending || !editing.note.trim()}
                onClick={() =>
                  resolve.mutate(
                    { id: editing.row.id, note: editing.note.trim() },
                    { onSuccess: () => setEditing(null) },
                  )
                }
              >
                {t('viol.resolve')}
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      )}
    </div>
  );
}

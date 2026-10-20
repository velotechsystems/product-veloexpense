'use client';

/**
 * /admin/api-keys — the API request log.
 *
 * Without this, "was this key being probed?" is a question you answer with SQL. The rows
 * exist either way; this is what makes them worth having.
 *
 * Two filtering layers, on purpose, and the split is not arbitrary:
 *
 *   · **Server-side** on outcome, key and age — the fields a security question STARTS from,
 *     and the ones that decide which rows exist at all. The table grows without bound, so
 *     narrowing has to happen before rows are shipped to a browser.
 *   · **Client-side** free-text refinement over the returned window, via the standard
 *     FilterPillBar, once the population is already narrow.
 *
 * The count line always says how big the real match was, not just how many rows are on
 * screen. A log view that shows 500 of 40,000 without saying so reads as complete, and that
 * is the one way this screen could actively mislead somebody.
 *
 * Ported from ExpenseOS `apps/web/src/app/[locale]/(app)/admin/api-keys/ApiKeyRequestsAdmin.tsx` (1e682dd6), w6-04 (d88).
 */

import {
  Badge,
  DataTableToolbar,
  FilterPillBar,
  TableSettingsButton,
} from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { TableExportMenu, useTableLabels, useToolbarLabels } from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { trpc } from '@/lib/trpc/client';

type ColumnId =
  | 'createdAt'
  | 'outcome'
  | 'key'
  | 'operation'
  | 'tool'
  | 'actor'
  | 'ip'
  | 'count'
  | 'duration';

interface Row {
  id: string;
  createdAt: Date;
  outcome: string;
  apiKeyId: string | null;
  prefixTried: string | null;
  apiKey: { id: string; name: string; kind: string } | null;
  operation: string;
  toolName: string | null;
  scopeRequired: string | null;
  actingUserId: string | null;
  ip: string | null;
  count: number;
  windowStart: Date | null;
  durationMs: number | null;
  statusCode: number | null;
}

const AGE_OPTIONS = [1, 7, 30, 90] as const;

export function ApiKeyRequestsAdmin() {
  const t = useTranslations('apiKeys.log');
  const tableLabels = useTableLabels();
  const toolbarLabels = useToolbarLabels();

  const [outcome, setOutcome] = useState<string>('');
  const [sinceDays, setSinceDays] = useState<number>(7);

  const outcomes = trpc.apiKeys.requestOutcomes.useQuery();
  const query = trpc.apiKeys.requests.useQuery({
    outcome: outcome || null,
    sinceDays,
    limit: 500,
  });

  const columns: ColumnDef<Row, ColumnId>[] = useMemo(
    () => [
      {
        id: 'createdAt',
        label: t('when'),
        defaultWidth: 150,
        sortable: true,
        hideable: false,
        exportValue: (r) => r.createdAt.toISOString(),
        cell: (r) => (
          <span className="text-muted-foreground text-xs">{r.createdAt.toLocaleString()}</span>
        ),
      },
      {
        id: 'outcome',
        label: t('outcome'),
        defaultWidth: 150,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.outcome,
        cell: (r) => (
          <Badge variant={r.outcome === 'OK' ? 'secondary' : 'destructive'}>{r.outcome}</Badge>
        ),
      },
      {
        id: 'key',
        label: t('key'),
        defaultWidth: 190,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.apiKey?.name ?? r.prefixTried ?? '',
        cell: (r) =>
          r.apiKey ? (
            <span className="text-foreground text-sm">{r.apiKey.name}</span>
          ) : (
            // No key matched. The prefix that was presented is the only identity such a row
            // has, and it is what makes a sweep legible.
            <span className="font-mono text-muted-foreground text-xs">
              {r.prefixTried ? t('unknownPrefix', { prefix: r.prefixTried }) : t('noKey')}
            </span>
          ),
      },
      {
        id: 'operation',
        label: t('operation'),
        defaultWidth: 130,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.operation,
        cell: (r) => <span className="font-mono text-foreground text-xs">{r.operation}</span>,
      },
      {
        id: 'tool',
        label: t('tool'),
        defaultWidth: 190,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.toolName ?? '',
        cell: (r) => (
          <span className="font-mono text-muted-foreground text-xs">
            {r.toolName ?? '—'}
            {r.scopeRequired && (
              <span className="block text-[10px]">{t('needed', { scope: r.scopeRequired })}</span>
            )}
          </span>
        ),
      },
      {
        id: 'actor',
        label: t('actor'),
        defaultWidth: 130,
        filterable: { kind: 'text' },
        exportValue: (r) => r.actingUserId ?? '',
        cell: (r) => (
          <span className="font-mono text-muted-foreground text-xs">
            {r.actingUserId ? r.actingUserId.slice(0, 8) : '—'}
          </span>
        ),
      },
      {
        id: 'ip',
        label: t('address'),
        defaultWidth: 140,
        sortable: true,
        filterable: { kind: 'text' },
        exportValue: (r) => r.ip ?? '',
        cell: (r) => <span className="font-mono text-foreground text-xs">{r.ip ?? '—'}</span>,
      },
      {
        id: 'count',
        label: t('attempts'),
        defaultWidth: 100,
        sortable: true,
        exportValue: (r) => String(r.count),
        cell: (r) =>
          // A count above 1 only ever appears on a coalesced row — i.e. a sweep. Worth
          // making loud rather than rendering as a quiet number in a column.
          r.count > 1 ? (
            <Badge variant="destructive">{t('attemptsInMinute', { count: r.count })}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">1</span>
          ),
      },
      {
        id: 'duration',
        label: t('duration'),
        defaultWidth: 100,
        sortable: true,
        exportValue: (r) => (r.durationMs == null ? '' : String(r.durationMs)),
        cell: (r) => (
          <span className="text-muted-foreground text-xs">
            {r.durationMs == null ? '—' : `${r.durationMs}ms`}
          </span>
        ),
      },
    ],
    [t],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  const rows = useMemo<Row[]>(() => {
    const source = (query.data?.rows ?? []) as unknown as Row[];
    // Free-text refinement within the window the server already narrowed.
    const clauses = tableState.filters.filter((c) => typeof c.value === 'string' && c.value);
    if (clauses.length === 0) return source;
    const valueFor = (row: Row, field: string): string => {
      switch (field) {
        case 'outcome':
          return row.outcome;
        case 'key':
          return row.apiKey?.name ?? row.prefixTried ?? '';
        case 'operation':
          return row.operation;
        case 'tool':
          return `${row.toolName ?? ''} ${row.scopeRequired ?? ''}`;
        case 'actor':
          return row.actingUserId ?? '';
        case 'ip':
          return row.ip ?? '';
        default:
          return '';
      }
    };
    return source.filter((row) =>
      clauses.every((c) =>
        valueFor(row, String(c.field)).toLowerCase().includes(String(c.value).toLowerCase()),
      ),
    );
  }, [query.data, tableState.filters]);

  const pillBar = useFilterPillBarWiring<Row, ColumnId>(columns, tableState, setTableState);
  const total = query.data?.totalCount ?? 0;
  const windowed = total > (query.data?.rows.length ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3">
        <label htmlFor="log-outcome" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('outcome')}</span>
          <select
            id="log-outcome"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="">{t('allOutcomes')}</option>
            {outcomes.data?.map((o) => (
              <option key={o.outcome} value={o.outcome}>
                {o.outcome} ({o.count})
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="log-age" className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('age')}</span>
          <select
            id="log-age"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={String(sinceDays)}
            onChange={(e) => setSinceDays(Number(e.target.value))}
          >
            {AGE_OPTIONS.map((d) => (
              <option key={d} value={String(d)}>
                {t('lastDays', { days: d })}
              </option>
            ))}
          </select>
        </label>

        <p className="ml-auto text-muted-foreground text-xs">
          {windowed
            ? t('windowed', { shown: query.data?.rows.length ?? 0, total })
            : t('matched', { total })}
        </p>
      </div>

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

        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={0}
          resultCount={rows.length}
          loading={query.isLoading}
          rightSlot={
            <>
              <TableExportMenu<Row, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="api-key-requests"
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
                onReset={() => setTableState((s) => ({ ...s, columnVisibility: {} }))}
                labels={tableLabels.settings}
              />
            </>
          }
        />

        <DataTable<Row, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          totalCount={rows.length}
          state={tableState}
          onStateChange={setTableState}
          labels={tableLabels}
          selectable={false}
          renderEmpty={() => <div className="font-medium text-foreground">{t('empty')}</div>}
        />
      </div>
    </div>
  );
}

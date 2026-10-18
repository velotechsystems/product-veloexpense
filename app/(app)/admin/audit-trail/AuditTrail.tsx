// biome-ignore-all lint/correctness/useExhaustiveDependencies: admin row handlers are component-scoped; the t() functions and memoized facet options are render-stable.
'use client';

/**
 * /admin/audit-trail — the tamper-evident log, made readable.
 *
 * Three things live here:
 *   1. the filtered, cursor-paginated trail;
 *   2. **chain integrity verification** — re-walks the hash chain and names the
 *      first row that doesn't reconcile;
 *   3. the retention window (SOX floor of 7 years).
 *
 * The log is append-only, so there are no row actions beyond inspecting an
 * entry. What an admin can do is prove nothing was edited — which is the whole
 * point of the surface, so the verify control is in the header, not buried.
 *
 * w5-06 — ported from ExpenseOS `app/[locale]/(app)/admin/audit-trail/AuditTrail.tsx`
 * (1e682dd6). VeloExpense, each marked below: rows are VeloExpense's per-tenant
 * `audit_entry` chain (server/routers/audit.ts); an entry may have no expiry (VeloExpense's
 * writer stamps none — retention is the purge); and the retention window is the tenant's own
 * (w5-07, d82).
 */
import {
  Alert,
  AlertDescription,
  Button,
  DataTableToolbar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  FilterPillBar,
  Field as FormField,
  Input,
  resolveDateFilter,
  StatCard,
  TableSettingsButton,
} from '@expenseos/design-system';
import { IconClockHour4, IconDatabase, IconShieldCheck, IconShieldX } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useTopBarSlots } from '@/app/(app)/TopBar';
import { Field, Section } from '@/components/admin/AdminLookupPage';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import {
  type FieldKind,
  TableExportMenu,
  useDebouncedValue,
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
} from '@/components/data-view/DataTable';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import type { AuditFilter } from '@/server/routers/audit';

type Outputs = inferRouterOutputs<AppRouter>;
type AuditRow = Outputs['audit']['list']['items'][number];
type VerifyResult = Outputs['audit']['verify'];

type ColumnId =
  | 'occurredAt'
  /** Not a column — the pill-bar-only date field (see `filterFields`). */
  | 'date'
  | 'actor'
  | 'action'
  | 'entityType'
  | 'entityId'
  | 'ipAddress'
  | 'hash';

/** Default verify window. A full walk of a seven-year log is a table scan; 90
 *  days is what an admin actually wants to check after an incident, and the
 *  window still proves integrity at its own boundary. */
const VERIFY_WINDOWS = [30, 90, 365] as const;

function fmtTs(value: Date | string): string {
  return new Date(value).toLocaleString();
}

export function AuditTrail({
  canVerify,
  canConfigure,
}: {
  canVerify: boolean;
  canConfigure: boolean;
}) {
  const toolbarLabels = useToolbarLabels();
  const ta = useTranslations('admin.auditTrail');
  const tableLabels = useTableLabels();

  const stats = trpc.audit.stats.useQuery();
  const facets = trpc.audit.facets.useQuery();

  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [verifyResult, setVerifyResult] = useState<(VerifyResult & { days: number }) | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyDays, setVerifyDays] = useState<number>(90);

  const verify = trpc.audit.verify.useMutation({
    onSuccess: (r) => {
      setVerifyResult({ ...r, days: verifyDays });
      setVerifyError(null);
    },
    onError: (e) => {
      setVerifyResult(null);
      setVerifyError(e.message);
    },
  });

  const actionOptions = useMemo(
    () => (facets.data?.actions ?? []).map((a) => ({ value: a, label: a })),
    [facets.data],
  );
  const entityTypeOptions = useMemo(
    () => (facets.data?.entityTypes ?? []).map((e) => ({ value: e, label: e })),
    [facets.data],
  );

  const columns: ColumnDef<AuditRow, ColumnId>[] = useMemo(
    () => [
      {
        id: 'occurredAt',
        label: ta('colWhen'),
        defaultWidth: 190,
        hideable: false,
        exportValue: (r) => new Date(r.occurredAt).toISOString(),
        cell: (r) => <span className="text-foreground text-sm">{fmtTs(r.occurredAt)}</span>,
      },
      {
        id: 'actor',
        label: ta('colActor'),
        defaultWidth: 210,
        filterable: { kind: 'text' },
        exportValue: (r) => r.actorName,
        cell: (r) => (
          <div className="min-w-0">
            <div className="truncate text-foreground text-sm">{r.actorName}</div>
            {r.actorRoleLabel && (
              <div className="truncate text-muted-foreground text-xs">{r.actorRoleLabel}</div>
            )}
          </div>
        ),
      },
      {
        id: 'action',
        label: ta('colAction'),
        defaultWidth: 280,
        filterable: { kind: 'enum', options: actionOptions },
        exportValue: (r) => r.action,
        cell: (r) => (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs">
            {r.action}
          </span>
        ),
      },
      {
        id: 'entityType',
        label: ta('colEntity'),
        defaultWidth: 150,
        filterable: { kind: 'enum', options: entityTypeOptions },
        exportValue: (r) => r.entityType ?? '',
        cell: (r) => <span className="text-muted-foreground text-sm">{r.entityType ?? '—'}</span>,
      },
      {
        id: 'entityId',
        label: ta('colEntityId'),
        defaultWidth: 300,
        filterable: { kind: 'text' },
        exportValue: (r) => r.entityId ?? '',
        cell: (r) => (
          <span className="truncate font-mono text-muted-foreground text-xs">
            {r.entityId ?? '—'}
          </span>
        ),
      },
      {
        id: 'ipAddress',
        label: ta('colIp'),
        defaultWidth: 140,
        filterable: { kind: 'text' },
        exportValue: (r) => r.ipAddress ?? '',
        cell: (r) => (
          <span className="font-mono text-muted-foreground text-xs">{r.ipAddress ?? '—'}</span>
        ),
      },
      {
        id: 'hash',
        label: ta('colHash'),
        defaultWidth: 130,
        exportValue: (r) => r.entryHash,
        cell: (r) => (
          <span
            className="font-mono text-muted-foreground text-xs"
            title={r.entryHash}
          >{`${r.entryHash.slice(0, 12)}…`}</span>
        ),
      },
    ],
    [ta, actionOptions, entityTypeOptions],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  // Filters resolve server-side: the log is unbounded, so client-side filtering
  // would only ever filter the page you happen to have loaded.
  const debounced = useDebouncedValue(tableState.filters, 300);
  const queryFilters = useMemo<AuditFilter[]>(() => {
    const now = new Date();
    const out: AuditFilter[] = [];
    for (const c of debounced) {
      if (c.field === 'date') {
        // Relative presets and absolute comparisons resolve here, where the
        // browser timezone is known; the server only ever sees absolute bounds.
        const w = resolveDateFilter(c.op, c.value, now);
        if (w.gte) out.push({ field: 'date', op: 'after', value: w.gte.toISOString() });
        if (w.lt) out.push({ field: 'date', op: 'before', value: w.lt.toISOString() });
        continue;
      }
      if (
        c.op === 'contains' ||
        c.op === 'equals' ||
        c.op === 'doesNotEqual' ||
        c.op === 'startsWith'
      ) {
        out.push({
          field: c.field as 'actor' | 'action' | 'entityType' | 'entityId' | 'ipAddress',
          op: c.op,
          value: c.value,
        });
      }
    }
    return out;
  }, [debounced]);

  const list = trpc.audit.list.useInfiniteQuery(
    { filters: queryFilters.length > 0 ? queryFilters : undefined },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  useTopBarSlots(
    () => ({
      right: canVerify ? (
        <div className="flex items-center gap-2">
          {VERIFY_WINDOWS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === verifyDays ? 'default' : 'outline'}
              disabled={verify.isPending}
              onClick={() => {
                setVerifyDays(d);
                verify.mutate({ lastDays: d });
              }}
            >
              <IconShieldCheck size={14} className="mr-1" />
              {ta('verifyDays', { days: d })}
            </Button>
          ))}
        </div>
      ) : null,
    }),
    [canVerify, verifyDays, verify.isPending, ta],
  );

  const pillBar = useFilterPillBarWiring<AuditRow, ColumnId>(columns, tableState, setTableState);
  // `occurredAt` carries the rich date editor (relative presets + absolute
  // comparisons) that a column-header filter can't host, so the field is added
  // to the pill bar directly — same shape as the transactions list.
  const filterFields = useMemo<ColumnId[]>(
    () => ['date', ...pillBar.filterFields],
    [pillBar.filterFields],
  );
  const filterLabels = { ...pillBar.filterLabels, date: ta('colWhen') };
  const filterKinds = { ...pillBar.filterKinds, date: 'date' as FieldKind };
  const filterOptions = { ...pillBar.filterOptions, date: [] };
  const s = stats.data;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label={ta('statEntries')}
          value={s ? s.total.toLocaleString() : '—'}
          icon={IconDatabase}
          loading={stats.isLoading}
        />
        <StatCard
          label={ta('statWindow')}
          value={s?.oldestAt ? new Date(s.oldestAt).toLocaleDateString() : '—'}
          secondaryValue={s?.newestAt ? fmtTs(s.newestAt) : undefined}
          icon={IconClockHour4}
          loading={stats.isLoading}
        />
        <StatCard
          label={ta('statRetention')}
          value={s ? ta('years', { years: s.retentionYears }) : '—'}
          secondaryValue={
            // VeloExpense: a watermark from before 0075 has no count or run time, so it
            // names the entry it purged through instead.
            s?.lastPurge
              ? s.lastPurge.runAt && s.lastPurge.purgedCount != null
                ? ta('lastPurge', {
                    count: s.lastPurge.purgedCount,
                    date: new Date(s.lastPurge.runAt).toLocaleDateString(),
                  })
                : ta('purgedThrough', { sequence: s.lastPurge.purgedThroughSequence })
              : ta('neverPurged')
          }
          icon={IconShieldCheck}
          loading={stats.isLoading}
        />
      </div>

      {verifyError && (
        <Alert variant="destructive">
          <AlertDescription>{verifyError}</AlertDescription>
        </Alert>
      )}
      {verifyResult && (
        <Alert variant={verifyResult.ok ? 'success' : 'destructive'}>
          <AlertDescription>
            {verifyResult.ok ? (
              <>
                {ta('verifyOk', { scanned: verifyResult.scanned, days: verifyResult.days })}
                {verifyResult.purgeAware ? ` ${ta('verifyPurgeAware')}` : ''}
              </>
            ) : (
              <span className="flex items-center gap-1.5">
                <IconShieldX size={15} />
                {ta('verifyFailed', {
                  reason: ta(
                    verifyResult.reason === 'entry-hash-mismatch'
                      ? 'reasonEntryHash'
                      : 'reasonPrevHash',
                  ),
                  id: verifyResult.at.id,
                  scanned: verifyResult.scanned,
                })}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {canConfigure && <RetentionCard />}

      <div className="rounded-md border border-border bg-card">
        <FilterPillBar<ColumnId>
          labels={pillBar.chromeLabels}
          filters={pillBar.filters}
          fields={filterFields}
          fieldLabels={filterLabels}
          fieldKinds={filterKinds}
          options={filterOptions}
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
          loading={list.isLoading}
          rightSlot={
            <>
              {/* Exports what's loaded, not the whole log — a seven-year export
                  belongs in a scheduled job, not a browser download. */}
              <TableExportMenu<AuditRow, ColumnId>
                columns={columns}
                rows={rows}
                state={tableState}
                filename="audit-trail"
              />
              <TableSettingsButton<ColumnId, string>
                columnOrder={columns.map((c) => c.id)}
                columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
                onVisibilityChange={(v) => setTableState((st) => ({ ...st, columnVisibility: v }))}
                columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
                density={tableState.density}
                onDensityChange={(d) => setTableState((st) => ({ ...st, density: d }))}
                onReset={() =>
                  setTableState((st) => ({
                    ...st,
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

        <DataTable<AuditRow, ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          totalCount={rows.length}
          hasNextPage={list.hasNextPage ?? false}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={list.fetchNextPage}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={setSelected}
          activeRowId={selected?.id ?? null}
          labels={tableLabels}
          renderEmpty={() => <div className="font-medium text-foreground">{ta('empty')}</div>}
          selectable={false}
        />
      </div>

      <Drawer
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      >
        <DrawerContent width={620} resizable storageKey="admin.auditTrail">
          {selected && (
            <>
              <DrawerHeader>
                <div className="min-w-0 flex-1">
                  <DrawerTitle className="truncate font-mono">{selected.action}</DrawerTitle>
                  <div className="mt-0.5 text-muted-foreground text-xs">
                    {fmtTs(selected.occurredAt)}
                  </div>
                </div>
              </DrawerHeader>
              <DrawerBody className="space-y-6">
                <Section title={ta('sectionWho')}>
                  <Field label={ta('colActor')}>{selected.actorName}</Field>
                  <Field label={ta('roleAtTime')}>{selected.actorRoleLabel ?? '—'}</Field>
                  <Field label={ta('colIp')}>{selected.ipAddress ?? '—'}</Field>
                  <Field label={ta('userAgent')}>
                    <span className="break-all text-xs">{selected.userAgent ?? '—'}</span>
                  </Field>
                  <Field label={ta('requestId')}>
                    <span className="font-mono text-xs">{selected.requestId ?? '—'}</span>
                  </Field>
                </Section>
                <Section title={ta('sectionWhat')}>
                  <Field label={ta('colEntity')}>{selected.entityType ?? '—'}</Field>
                  <Field label={ta('colEntityId')}>
                    <span className="break-all font-mono text-xs">{selected.entityId ?? '—'}</span>
                  </Field>
                  <Field label={ta('details')}>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                      {JSON.stringify(selected.details ?? {}, null, 2)}
                    </pre>
                  </Field>
                </Section>
                <Section title={ta('sectionChain')}>
                  {/* Shown because it's the evidence: an auditor can re-derive
                      the hash from the fields above and compare. */}
                  <Field label={ta('prevHash')}>
                    <span className="break-all font-mono text-xs">{selected.prevHash ?? '—'}</span>
                  </Field>
                  <Field label={ta('entryHash')}>
                    <span className="break-all font-mono text-xs">{selected.entryHash}</span>
                  </Field>
                  {/* VeloExpense: VeloExpense's writer stamps no expiry (retention is the
                      purge), so an entry may have none. */}
                  <Field label={ta('expiresAt')}>
                    {selected.expiresAt ? fmtTs(selected.expiresAt) : '—'}
                  </Field>
                </Section>
              </DrawerBody>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

// ── Retention ──────────────────────────────────────────────────────

function RetentionCard() {
  const ta = useTranslations('admin.auditTrail');
  const tc = useTranslations('admin.common');
  const utils = trpc.useUtils();
  const current = trpc.audit.retention.useQuery();
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const save = trpc.audit.setRetention.useMutation({
    onSuccess: () => {
      utils.audit.retention.invalidate();
      utils.audit.stats.invalidate();
      setSavedAt(new Date());
      setError(null);
    },
    onError: (e) => setError(e.message),
  });

  const value = draft !== '' ? draft : String(current.data?.years ?? '');

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField
          htmlFor="audit-retention"
          label={ta('retentionLabel')}
          description={ta('retentionHelp')}
        >
          <Input
            id="audit-retention"
            type="number"
            min={7}
            max={50}
            className="w-28"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
        </FormField>
        <Button
          size="sm"
          disabled={save.isPending || value === '' || Number(value) === current.data?.years}
          onClick={() => {
            const years = Number(value);
            if (!Number.isInteger(years)) {
              setError(ta('retentionInvalid'));
              return;
            }
            save.mutate({ years });
          }}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        {savedAt && (
          <span className="text-muted-foreground text-xs">
            {tc('savedAt', { time: savedAt.toLocaleTimeString() })}
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-destructive text-sm">{error}</p>}
      {current.data?.isDefault && (
        <p className="mt-2 text-muted-foreground text-xs">{ta('retentionDefault')}</p>
      )}
    </div>
  );
}

'use client';

/**
 * /expenses/approvals — the approver's expense-report inbox, wired to
 * `expenseApprovals.myTasks` (pending tasks assigned to, or claimable by, the
 * caller). Clicking a row opens the read-only ApproverReportDrawer where the
 * report is reviewed and Approved / Rejected / Returned. AP reimbursers also
 * reach a report from here to mark it reimbursed. Mirrors the VCC request
 * queue's shape and the ExpenseReportsList table conventions.
 *
 * Ported from ExpenseOS (550b2945) in place of VeloExpense's own /approvals (w4-05/w4-07,
 * d71); its saved views since w4-08. VeloExpense, marked below: a report from before
 * numbering has no number; reimbursing stays on VeloExpense's own screen (d71,
 * ApproverReportDrawer).
 */
import {
  CARDS_ONLY,
  cls,
  DataTableToolbar,
  FilterPillBar,
  StatusBadge,
  TABLE_ONLY,
  TableSettingsButton,
  useIsCompact,
} from '@expenseos/design-system';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableMobileConfig,
  type DataTableState,
  type FieldKind,
  FilterSheet,
  newClauseId,
  SortSheet,
  sortSheetOptions,
  useListViews,
  useSortSheetLabels,
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import { displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useDeepLink } from '@/lib/useDeepLink';
import type { AppRouter } from '@/server/routers/_app';
import { statusBadgeProps } from '../_shared';
import { ApproverReportDrawer } from './ApproverReportDrawer';

type PendingItem = inferRouterOutputs<AppRouter>['expenseApprovals']['myTasks']['items'][number];
type DecidedItem = inferRouterOutputs<AppRouter>['expenseApprovals']['myDecided']['items'][number];
type TeamItem = inferRouterOutputs<AppRouter>['expenseApprovals']['myTeam']['items'][number];
type Person = { firstName: string | null; lastName: string | null; email: string };
/** Common row shape every view feeds the table. `decision`/`decidedAt` are set
 *  in the "decided by me" view, `label` only in the pending view, and `with`
 *  only in the team view. */
type TaskItem = {
  taskId: string;
  label?: string | null;
  decision?: string;
  decidedAt?: Date | string | null;
  /** Team view: who holds the report now, or who last decided it. */
  with?: { person: Person | null; decision?: string } | null;
  report: PendingItem['report'];
};
type ColumnId =
  | 'report'
  | 'submitter'
  | 'status'
  | 'submitted'
  | 'total'
  | 'decided'
  | 'with'
  /** Filter-only: no cell shows it, and it chooses the QUERY rather than narrowing a
   *  result. Deliberately absent from `ALL_COLUMN_IDS` so no column is seeded for it. */
  | 'queue';
/** Every column any view can show — the seeded column order (see below). */
const ALL_COLUMN_IDS: ColumnId[] = [
  'report',
  'submitter',
  'status',
  'submitted',
  'total',
  'with',
  'decided',
];
type InboxView = 'pending' | 'decided' | 'team';

/**
 * WHICH QUEUE, as a filter clause rather than as a row of buttons.
 *
 * The three queues were three toggle buttons sitting above the filter bar, which made the
 * approver's most-used control the one thing on the page that could not be saved, pinned as
 * their default, or combined with a filter and kept. Folding it into the bar makes
 * "everything waiting on me from Dana" a view somebody can name.
 *
 * It is genuinely a different QUERY per queue — `myTasks`, `myDecided`, `myTeam` — not a
 * narrowing of one dataset, so the clause is read here and turned into the query choice
 * rather than applied to loaded rows.
 */
const QUEUE_FIELD: ColumnId = 'queue';
const QUEUES: InboxView[] = ['pending', 'decided', 'team'];

export function ExpenseApprovalsInbox({ canReimburse }: { canReimburse: boolean }) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('expenses');
  const locale = useLocale();
  const tableLabels = useTableLabels();
  /**
   * The sort sheet's own copy, passed explicitly.
   *
   * `<SortSheet>` (and `<FilterSheet>`) default every label to English INSIDE
   * the design system, as literals. `check-used-keys` cannot see a literal —
   * there is no key for it to look for — so a page that mounts either sheet
   * without its bag ships English chrome to a French reader and no gate in the
   * repo says a word. That is exactly how the filter-pill chrome shipped in
   * English (F43). The filter bags come off `pillBar` (`chromeLabels` /
   * `sheetLabels`); this is the one the sort sheet needs, and
   * `ExpenseApprovalsInbox.test.tsx` fails if either sheet falls back.
   */
  const sortSheetLabels = useSortSheetLabels();
  /** Which tree `<DataTable>` will mount. The sheets are the CARD tree's sort
   *  and filter affordances, so they are mounted on the same answer rather
   *  than on a second, possibly-disagreeing media query. */
  const compact = useIsCompact();
  const utils = trpc.useUtils();

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    /**
     * Seeded with EVERY column, not the ones the current view happens to show.
     *
     * The seed is computed once, on mount, in the pending view — so seeding it from
     * `columns` left `with` and `decided` permanently out of the column order, and the
     * table renders only ordered columns. The whole point of those two views (who
     * holds the report, what I decided) was invisible. A column in the order with no
     * definition is skipped, so listing all of them is safe.
     */
    createDataTableState(ALL_COLUMN_IDS.map((id) => ({ id })) as never, {
      // The queue the inbox opens on, as a pill the approver can see and change.
      filters: [{ id: newClauseId(), field: QUEUE_FIELD, op: 'equals', value: 'pending' }],
    }),
  );

  /**
   * Pending (default) · "decided by me" (the decision history the pending inbox drops —
   * A2/A3) · "my team" (every report from a direct report, whoever the workflow routed it
   * to — the manager keeps sight of it regardless).
   *
   * Read off the bar rather than held in its own state, so a saved view carries it. A
   * clause naming a queue nobody recognises falls back to pending rather than fetching
   * nothing.
   */
  const view: InboxView = useMemo(() => {
    const clause = tableState.filters.find((c) => c.field === QUEUE_FIELD);
    const picked = clause?.value as InboxView | undefined;
    return picked && QUEUES.includes(picked) ? picked : 'pending';
  }, [tableState.filters]);
  const tasks = trpc.expenseApprovals.myTasks.useQuery(undefined, {
    enabled: view === 'pending',
  });
  const decided = trpc.expenseApprovals.myDecided.useQuery(undefined, {
    enabled: view === 'decided',
  });
  const team = trpc.expenseApprovals.myTeam.useQuery(undefined, { enabled: view === 'team' });
  const activeQuery = view === 'pending' ? tasks : view === 'decided' ? decided : team;
  const items = useMemo<TaskItem[]>(() => {
    if (view === 'pending') return tasks.data?.items ?? [];
    if (view === 'decided') return (decided.data?.items as DecidedItem[] | undefined) ?? [];
    // Team rows have no task of their own — key them by report id.
    return ((team.data?.items as TeamItem[] | undefined) ?? []).map((it) => ({
      taskId: it.report.id,
      report: it.report,
      with: it.pendingWith
        ? { person: it.pendingWith }
        : it.lastDecision
          ? { person: it.lastDecision.by, decision: it.lastDecision.decision }
          : null,
    }));
  }, [view, tasks.data, decided.data, team.data]);
  const [openTask, setOpenTask] = useState<{
    reportId: string;
    taskId?: string;
    isAck?: boolean;
  } | null>(null);

  const refresh = () => {
    utils.expenseApprovals.myTasks.invalidate();
    utils.expenseApprovals.myDecided.invalidate();
    utils.expenseApprovals.myTeam.invalidate();
    utils.expenses.list.invalidate();
  };

  // Deep-open: a notification links here with `?report=<id>`. Open the report's
  // review drawer, attaching the viewer's pending task on it (if any) so the
  // decide actions light up; then strip the param so closing doesn't re-open it.
  const reportLink = useDeepLink('report');
  useEffect(() => {
    if (!reportLink.id || !reportLink.key || reportLink.wasSeen(reportLink.key)) return;
    reportLink.markSeen(reportLink.key);
    // The drawer opens on the id whether or not the row is in the loaded queue —
    // only the task (and so the decide buttons) comes from the match. A report
    // newer than the cached list still opens; its actions light up on the next
    // refetch rather than the click doing nothing.
    const match = items.find((it) => it.report.id === reportLink.id);
    setOpenTask({
      reportId: reportLink.id,
      taskId: match?.taskId,
      isAck: match?.label === 'acknowledge',
    });
    reportLink.clear();
  }, [reportLink, items]);

  const columns = useMemo<ColumnDef<TaskItem, ColumnId>[]>(
    () => [
      {
        id: 'report',
        label: t('columns.report'),
        defaultWidth: 320,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground text-sm">{row.report.title}</div>
            <div className="font-mono text-muted-foreground text-xs">{row.report.number}</div>
          </div>
        ),
      },
      {
        id: 'submitter',
        label: t('approvals.submitter'),
        defaultWidth: 200,
        filterable: { kind: 'text' },
        cell: (row) => (
          <span className="text-foreground text-sm">{displayName(row.report.submitter)}</span>
        ),
      },
      {
        id: 'status',
        label: t('columns.status'),
        defaultWidth: 130,
        cell: (row) => <StatusBadge {...statusBadgeProps(row.report.status, t, 'Submitted')} />,
      },
      {
        id: 'submitted',
        label: t('approvals.submitted'),
        defaultWidth: 130,
        cell: (row) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {row.report.submittedAt
              ? new Date(row.report.submittedAt).toLocaleDateString(locale, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : '—'}
          </span>
        ),
      },
      {
        id: 'total',
        label: t('columns.total'),
        defaultWidth: 140,
        cell: (row) => (
          <span className="block text-right text-foreground text-sm tabular-nums">
            {formatMinor(Number(row.report.totalMinor), row.report.currency, locale)}
          </span>
        ),
      },
      // Team view only: where the report sits now, or who last decided it.
      ...(view === 'team'
        ? ([
            {
              id: 'with',
              label: t('approvals.withColumn'),
              defaultWidth: 200,
              cell: (row: TaskItem) => {
                if (!row.with?.person) {
                  return <span className="text-muted-foreground text-sm">—</span>;
                }
                const who = displayName(row.with.person);
                return (
                  <span className="text-foreground text-sm">
                    {row.with.decision
                      ? t(`approvals.decidedByName.${row.with.decision.toLowerCase()}`, {
                          name: who,
                        })
                      : t('approvals.awaitingName', { name: who })}
                  </span>
                );
              },
            },
          ] as ColumnDef<TaskItem, ColumnId>[])
        : []),
      // "Decided by me" view only: the approver's own decision + when.
      ...(view === 'decided'
        ? ([
            {
              id: 'decided',
              label: t('approvals.decidedColumn'),
              defaultWidth: 180,
              cell: (row: TaskItem) => (
                <span className="text-muted-foreground text-sm tabular-nums">
                  {row.decision ? t(`approvals.decision.${row.decision.toLowerCase()}`) : '—'}
                  {row.decidedAt
                    ? ` · ${new Date(row.decidedAt).toLocaleDateString(locale, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}`
                    : ''}
                </span>
              ),
            },
          ] as ColumnDef<TaskItem, ColumnId>[])
        : []),
    ],
    [t, locale, view],
  );

  // Bulk approve: the toolbar group action over the table's row selection.
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const decideBulk = trpc.expenseApprovals.decideBulk.useMutation({
    onSuccess: (res) => {
      const parts: string[] = [];
      if (res.approved.length)
        parts.push(t('approvals.bulkApproved', { count: res.approved.length }));
      if (res.skipped.length) parts.push(t('approvals.bulkSkipped', { count: res.skipped.length }));
      setBulkMessage(parts.join(' ') || null);
      setTableState((s) => ({ ...s, selectedIds: new Set() }));
      refresh();
    },
  });
  const selectedTaskIds = useMemo(() => [...tableState.selectedIds], [tableState.selectedIds]);
  // Clear the last bulk-result note once the approver starts a fresh selection.
  useEffect(() => {
    if (selectedTaskIds.length > 0) setBulkMessage(null);
  }, [selectedTaskIds.length]);

  const filteredRows = useMemo(() => {
    let out = items;
    for (const c of tableState.filters) {
      // The queue picked which QUERY ran; re-applying it here would compare it against a
      // row's text and drop every row.
      if (c.field === QUEUE_FIELD) continue;
      if (c.field === 'report' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter(
          (r) =>
            r.report.title.toLowerCase().includes(n) ||
            // VeloExpense: a report from before numbering has no number.
            (r.report.number ?? '').toLowerCase().includes(n),
        );
      }
      if (c.field === 'submitter' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter((r) => displayName(r.report.submitter).toLowerCase().includes(n));
      }
    }
    return out;
  }, [items, tableState.filters]);

  /**
   * The approver's queue as a stacked card list below 768px.
   *
   * Adopted from `/expenses` (`ExpenseReportsList.tsx`) rather than invented:
   * the column widths this table declares sum to roughly 920px, which is
   * nearly three phone viewports, and without a card config
   * `DataTable`'s `compact` never fires and the full desktop `<table>` renders
   * uncloaked at every width.
   *
   * `title: 'report'` is the identity (title + number) and `badge: 'status'`
   * the state — both exempt from column visibility by design, because a card
   * with neither is not a card. `subtitle: 'submitter'` is the approver's
   * first triage question ("whose is this?"), and it gives the card the
   * "Q3 travel — Ada Lovelace" shape the card renderer's own anatomy note
   * describes. The subtitle is NOT exempt from the visibility intersection;
   * hiding Submitter in the gear menu hides it here too.
   *
   * `fields` is VIEW-DEPENDENT, mirroring `columns` above: `with` exists only
   * in the team view and `decided` only in the decided view, so naming them
   * unconditionally would name a column that view has no definition for.
   * `total` is on every card because the amount is the other half of triage;
   * the third slot is whatever that queue is FOR — when it was filed (pending),
   * what I decided (decided), who is holding it (team).
   *
   * NO `rowActions`, and that is a decision rather than an omission. Tapping
   * the card already opens `ApproverReportDrawer`, which is where the policy
   * violations and the missing-receipt state are. A kebab offering a quick
   * Approve from the card would let somebody decide a financial approval
   * without ever seeing either — a review bypass dressed as a convenience.
   * The desktop table has no per-row menu for the same reason; don't add one
   * here to "close the gap".
   *
   * NO `selectable`. `<DataTable selectable={view === 'pending'}>` below gives
   * the pending queue selection, but the card checkbox is a SECOND, separate
   * opt-in and it stays off: `DataTableToolbar`'s bulk-approve trigger is not
   * laid out for 360px, and ticking rows nothing can act on is worse than not
   * ticking them. Bulk approve is therefore unreachable on a phone, named
   * rather than silently dropped. The mechanism to close it later already
   * exists (`DataTableCards`' 44x44 checkbox slot, `DataTableToolbar`'s own
   * wrap) — it is a bounded fast-follow, not a redesign.
   */
  const mobile = useMemo<DataTableMobileConfig<TaskItem, ColumnId>>(
    () => ({
      title: 'report',
      subtitle: 'submitter',
      badge: 'status',
      fields:
        view === 'team'
          ? ['total', 'with']
          : view === 'decided'
            ? ['total', 'decided']
            : ['total', 'submitted'],
    }),
    [view],
  );

  /**
   * The columns a reader can actually see, in the order they are shown.
   *
   * `sortSheetOptions` deliberately does not apply visibility itself — that is
   * a page decision — and this page's answer is the same one the card fields
   * give: a column hidden in the gear menu is hidden everywhere, so the sort
   * sheet does not offer it either.
   */
  const visibleColumns = useMemo(
    () =>
      tableState.columnOrder
        .map((id) => columns.find((c) => c.id === id))
        .filter(
          (c): c is ColumnDef<TaskItem, ColumnId> =>
            c !== undefined && tableState.columnVisibility[c.id] !== false,
        ),
    [columns, tableState.columnOrder, tableState.columnVisibility],
  );

  /**
   * What the sort sheet offers — `resolveSortField` mapped over those columns,
   * which is the SAME resolver the column header calls.
   *
   * On this page that list is currently EMPTY, and deliberately so: no column
   * in `columns` declares `sortable`, so the desktop header offers no sort
   * either. The sheet says so in the reader's own language
   * (`table.mobile.sortEmpty`) rather than listing a field that would move an
   * indicator and reorder nothing — which is F04 by another route. Built from
   * the resolver rather than from `sortable: true` so that the day a column
   * here gains sorting, both surfaces gain it together.
   */
  const sortOptions = useMemo(
    () => sortSheetOptions(visibleColumns, filteredRows),
    [visibleColumns, filteredRows],
  );

  const pillBar = useFilterPillBarWiring<TaskItem, ColumnId>(columns, tableState, setTableState);

  /**
   * `queue` is injected into the bar rather than declared on a column, because it is not
   * one: no cell shows it, and it chooses the query rather than narrowing its result.
   */
  const filterFields = useMemo(
    () => [QUEUE_FIELD, ...pillBar.filterFields.filter((f) => f !== QUEUE_FIELD)] as ColumnId[],
    [pillBar.filterFields],
  );
  const filterLabels = { ...pillBar.filterLabels, [QUEUE_FIELD]: t('approvals.queue') };
  const filterKinds = { ...pillBar.filterKinds, [QUEUE_FIELD]: 'enum' as FieldKind };
  const filterOptions = {
    ...pillBar.filterOptions,
    [QUEUE_FIELD]: QUEUES.map((q) => ({
      value: q,
      label: t(`approvals.view${q[0].toUpperCase()}${q.slice(1)}` as 'approvals.viewPending'),
    })),
  };

  const savedViews = useListViews<ColumnId>({
    resource: 'approvals',
    systemViews: useMemo(
      () =>
        QUEUES.map((q) => ({
          kind: 'system' as const,
          id: `sys:${q}`,
          name: t(`approvals.view${q[0].toUpperCase()}${q.slice(1)}` as 'approvals.viewPending'),
          filters: [
            { id: `sv-${q}`, field: QUEUE_FIELD as ColumnId, op: 'equals' as const, value: q },
          ],
        })),
      [t],
    ),
    columnIds: ALL_COLUMN_IDS,
    tableState,
    setTableState,
    labels: {
      namePrompt: t('approvals.viewNamePrompt'),
      nameDefault: t('approvals.viewNameDefault'),
      renamePrompt: t('approvals.viewRenamePrompt'),
      deleteConfirm: (name) => t('approvals.viewDeleteConfirm', { name }),
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* The pill bar is a horizontal strip, and below `md` there is no
          horizontal room for it — least of all here, where it also carries the
          saved-views dropdown. Hidden rather than reflowed, because the same
          blocks already have a compact frame: the bottom sheet below, which
          hosts `<FilterBlock>` unchanged. Same clause array, same callbacks,
          so the `queue` clause the whole page reads its query off means
          exactly what it means here. */}
      <div className={cls('rounded-md border border-border bg-card', TABLE_ONLY)}>
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
          untitledViewLabel={t('approvals.viewUntitled')}
          savedViews={savedViews}
        />
      </div>

      {/*
        Sort and filter, reachable by thumb.

        Cards have no column headers, so the two affordances the table hangs
        off a `<th>` — the sort arrow and the filter editor — have nowhere to
        live. These are where they go. Both triggers are the design system's
        `size="lg"` (44px) tier.

        THIS is how the queue is switched on a phone. The pill bar above —
        which carries both the `queue` pill and the saved-views dropdown the
        desktop switches with — is cloaked below `md`, and the sheet takes the
        SAME `filterFields` / `filterLabels` / `filterKinds` / `filterOptions`
        maps with `queue` prepended. No second mechanism, no second clause
        array: `view` is still read off `tableState.filters`, so picking a
        queue in the sheet changes which QUERY runs exactly as the pill does.

        Mounted HERE, on the page, and not inside `<DataTable>`'s compact
        branch, for the reason `ExpenseReportsList` gives: `DataTable` has
        `state.filters` but none of the clause plumbing, and mounting inside
        the table would mean a second copy of it plus two label bags threaded
        through `DataTableLabels` as OPTIONAL fields with English defaults —
        precisely the invisible-to-the-gate seam that shipped F43.
      */}
      {compact && (
        <div
          /* Named so the browser suite can measure exactly this row, and
             distinct from `/expenses`' `expenses-mobile-controls` so a failure
             names the right page. `scripts/check-e2e-ids.mjs` checks this id
             still exists once a spec references it. */
          id="approvals-mobile-controls"
          className={cls('flex items-center gap-2', CARDS_ONLY)}
        >
          <FilterSheet<ColumnId>
            /* Both bags, because the sheet renders both: `labels` is the pill
               chrome it shares verbatim with the bar, `sheetLabels` is the
               frame that only exists below `md`. Neither is optional here —
               see `sortSheetLabels` at the top of this component. */
            labels={pillBar.chromeLabels}
            sheetLabels={pillBar.sheetLabels}
            /* The SAME array the bar is given, and the same one `view` and
               `filteredRows` read. The trigger counts clause GROUPS off it,
               never clauses. */
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
          />
          <SortSheet
            options={sortOptions}
            value={tableState.sort}
            onChange={(next) => setTableState((s) => ({ ...s, sort: next }))}
            labels={sortSheetLabels}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={selectedTaskIds.length}
          resultCount={filteredRows.length}
          loading={activeQuery.isLoading}
          bulkActionsDisabled={decideBulk.isPending}
          bulkActions={
            view === 'pending'
              ? [
                  {
                    id: 'approve',
                    label: t('approvals.approveSelected', { count: selectedTaskIds.length }),
                    onSelect: () => decideBulk.mutate({ taskIds: selectedTaskIds }),
                  },
                ]
              : []
          }
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
        {/**
         * The queue is longer than one load will materialize, said plainly.
         *
         * A system-degradation disclosure, not a prod: same muted band as the bulk
         * result above it, no colour, no icon, no count-up. What it owes the reader
         * is the fact that the list is a prefix and the reason it will fill in —
         * dressing that as urgency would be manufacturing obligation out of our own
         * capacity limit, which is exactly backwards.
         */}
        {view === 'pending' && tasks.data?.capped && (
          <div className="border-border border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
            {t('approvals.cappedNotice', { count: tasks.data.cappedAt })}
          </div>
        )}
        {bulkMessage && (
          <div className="border-border border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">
            {bulkMessage}
          </div>
        )}
        <DataTable<TaskItem, ColumnId>
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.taskId}
          mobile={mobile}
          totalCount={filteredRows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={(row) =>
            setOpenTask({
              reportId: row.report.id,
              // Team rows are keyed by report id, not by a task the caller owns
              // — passing it through would light up the decide actions on a
              // report that isn't theirs to decide.
              taskId: view === 'team' ? undefined : row.taskId,
              isAck: row.label === 'acknowledge',
            })
          }
          activeRowId={openTask?.taskId ?? null}
          loading={activeQuery.isLoading}
          labels={tableLabels}
          selectable={view === 'pending'}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">
                {t(
                  view === 'pending'
                    ? 'approvals.emptyTitle'
                    : view === 'decided'
                      ? 'approvals.decidedEmptyTitle'
                      : 'approvals.teamEmptyTitle',
                )}
              </div>
              <div className="mt-1 text-muted-foreground text-sm">
                {t(
                  view === 'pending'
                    ? 'approvals.emptyBody'
                    : view === 'decided'
                      ? 'approvals.decidedEmptyBody'
                      : 'approvals.teamEmptyBody',
                )}
              </div>
            </div>
          )}
        />
      </div>

      {openTask && (
        <ApproverReportDrawer
          reportId={openTask.reportId}
          taskId={openTask.taskId}
          isAcknowledge={openTask.isAck}
          canReimburse={canReimburse}
          onClose={() => setOpenTask(null)}
          onDecided={() => {
            setOpenTask(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

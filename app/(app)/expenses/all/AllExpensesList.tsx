'use client';

/**
 * /expenses/all — AP's cross-report expense view.
 *
 * "Which expenses are missing a receipt" is a question about expenses, not reports, and
 * answering it by opening thirty reports one at a time is the workflow this replaces.
 * "Request receipts" is a group action over the selection — the on-demand counterpart to
 * the daily `expense.receiptChase` job.
 *
 * ── Filtering ───────────────────────────────────────────────────────────────
 *
 * The page used to carry its own strip of controls above the table: a `Missing receipt`
 * toggle button, two bare `<input type="date">` boxes, and a Clear button — beside a
 * FilterPillBar that could filter on submitter, report, merchant and category but NOT on
 * the date, which is the column AP narrows by first. Two filter UIs, one of which could not
 * be saved, shared, or read back from a view.
 *
 * Now there is one. `date` and `receipt` are pill-bar fields like the rest, so a filter on
 * them can be saved as a view alongside everything else, and `Missing receipt` is a system
 * view rather than a button. Both resolve SERVER-side — they are query arguments, not a
 * post-filter over the loaded page, because this list is paged and filtering a page after
 * the fact would silently answer "which expenses are missing a receipt" with "of the two
 * hundred I happen to have loaded, these".
 *
 * ── The opening default ─────────────────────────────────────────────────────
 *
 * The list opens on AP's work queue: the last NINETY days, and the three statuses that are
 * still in flight — SUBMITTED, APPROVED, RETURNED. Twelve months of every status is not
 * wrong to look at; it is wrong to OPEN on. A year of settled REIMBURSED history is what
 * the reader had to narrow past before asking their real first question, every session.
 *
 * Both are PRE-FILLED CLAUSES, not hidden floors: two pills on the bar, saying what they
 * are doing, widened or removed like any other. A pinned saved view replaces them outright
 * — the reader has said what their default is — and `All time` clears both.
 *
 * The two clauses do NOT make the same promise, and the difference is the one thing on this
 * page a future reader is most likely to mistake for a bug. `date` is answered by the
 * server, so it is complete; `status` is answered here, over the rows already fetched, so
 * it is not. That is a deliberate, accepted exception to the paragraph above rather than an
 * oversight — the reasoning and its ceiling are written out on `defaultFilters`.
 *
 * Standard listing shell: FilterPillBar (with the saved-views dropdown) + DataTable +
 * toolbar.
 *
 * ── VeloExpense ─────────────────────────────────────────────────────────────
 *
 * Ported from ExpenseOS (550b2945). Differences, each marked `VeloExpense:` below:
 *   · no saved views: the dropdown and `useSavedViews` arrive with the saved-views port in
 *     Wave 4 (d15, kept for this screen on 10 Oct). The opening default is unchanged — the
 *     ninety-day window and the three in-flight statuses are pills on the bar — and
 *     `Missing receipt` is the receipt pill rather than a system view;
 *   · an expense may have no date, and a report from before numbering has no number.
 */

import {
  DataTableToolbar,
  FilterPillBar,
  resolveDateFilter,
  StatusBadge,
  TableSettingsButton,
} from '@expenseos/design-system';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableState,
  type FieldKind,
  type FilterClause,
  newClauseId,
  TableExportMenu,
  useDebouncedValue,
  // VeloExpense: no `useSavedViews` (or its `SystemView` / `PersistedViewState`) until
  // Wave 4 — see the header.
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import { Link, useRouter } from '@/i18n/navigation';
import { currencyExponent, displayName, formatMinor, pickText } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { REPORT_STATUSES, statusBadgeProps } from '../_shared';

type Row = inferRouterOutputs<AppRouter>['expenseApprovals']['expenses']['items'][number];
/** VeloExpense: when an expense happened, for sorting — an undated one as the oldest. */
const dateMs = (r: Row): number => (r.date ? new Date(r.date).getTime() : 0);
/** The two answers the `receipt` filter can carry. Values, not labels: they survive a
 *  saved view and a locale change, which a translated string would not. */
const RECEIPT_MISSING = 'missing';
const RECEIPT_ATTACHED = 'attached';

/**
 * Fields the SERVER narrows on. The client-side pass must skip them — see `filteredRows`.
 *
 * `status` is deliberately NOT one of them, even though the list now opens with three
 * status clauses on the bar. `expenseApprovals.expenses` takes a single optional status and
 * this default is a union of three; widening that input is a backend change that is out of
 * scope here. So status filters client-side, and `defaultFilters` records what that costs.
 */
const SERVER_FILTERED = new Set<string>(['date', 'receipt']);

type ColumnId =
  | 'date'
  | 'submitter'
  | 'report'
  | 'status'
  | 'merchant'
  | 'category'
  | 'receipt'
  | 'amount';

/** The statuses the list opens on: what is still IN FLIGHT. An allowlist — see
 *  `defaultFilters` for why it is named positively and what that costs. */
const DEFAULT_STATUSES = ['SUBMITTED', 'APPROVED', 'RETURNED'] as const;

/**
 * The opening status clauses — one `equals` per allowlisted status, which the pill bar
 * groups into one pill reading "Status is Submitted or Approved or Returned".
 *
 * Shared by `defaultFilters` and the `sys:default` view so the two cannot drift: clicking
 * the view the list already opens on must not silently widen or narrow it.
 *
 * The CLAUSE IDS are the seam, which is why this takes a generator rather than being a
 * frozen array. `defaultFilters` mints fresh ids with `newClauseId()`; the system view uses
 * stable literals alongside `sv-all-date`, matching how every other system view here is
 * written. One shared array would have to lie about one of them.
 *
 * VeloExpense: only `defaultFilters` uses it until the system views arrive (Wave 4); kept
 * as ExpenseOS's so `sys:default` has its seam when they do.
 */
const statusClauses = (idFor: (status: string) => string): FilterClause<ColumnId>[] =>
  DEFAULT_STATUSES.map((status) => ({
    id: idFor(status),
    field: 'status',
    op: 'equals',
    value: status,
  }));

export function AllExpensesList() {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('expenses');
  const locale = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();
  const tableLabels = useTableLabels();

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // VeloExpense: no `activeViewId` until saved views (Wave 4).
  const label = useCallback((l: unknown) => pickText(l, locale) || '—', [locale]);

  /**
   * Where a row goes: the workbench, opened on the line that was clicked.
   *
   * The table paints every row with `cursor-pointer`, so the whole list already
   * *looked* clickable — it just wasn't wired, and the only live target was the
   * report-number link, a ~70px sliver of a full-width row. Anywhere else was a
   * click that did nothing, which reads as a broken page rather than a link you
   * missed.
   *
   * Same destination as that link, deliberately: `?expense=` so the workbench
   * lands on this charge instead of the report's first line.
   */
  const openExpense = useCallback(
    (r: Row) => router.push(`/expenses/${r.report.id}?expense=${r.id}`),
    [router],
  );

  const chase = trpc.expenseApprovals.chaseReceipts.useMutation({
    onSuccess: (r) => {
      setError(null);
      setNotice(
        r.reports === 0
          ? t('allExpenses.chaseNone')
          : t('allExpenses.chaseSent', { expenses: r.expenses, reports: r.reports }),
      );
      setTableState((s) => ({ ...s, selectedIds: new Set() }));
      utils.expenseApprovals.expenses.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const columns = useMemo<ColumnDef<Row, ColumnId>[]>(
    () => [
      {
        id: 'date',
        label: t('columns.date'),
        defaultWidth: 110,
        sortable: true,
        // VeloExpense: an expense may have no date yet — a dash, and an empty cell exported.
        cell: (r) => (
          <span className="tabular-nums">
            {r.date ? new Date(r.date).toLocaleDateString(locale) : '—'}
          </span>
        ),
        exportValue: (r) => (r.date ? new Date(r.date).toLocaleDateString(locale) : ''),
        exportDate: (r) => (r.date ? new Date(r.date) : null),
      },
      {
        id: 'submitter',
        label: t('approvals.submitter'),
        defaultWidth: 170,
        sortable: true,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-foreground">{displayName(r.report.submitter)}</span>,
        exportValue: (r) => displayName(r.report.submitter),
      },
      {
        id: 'report',
        label: t('columns.report'),
        defaultWidth: 150,
        sortable: true,
        filterable: { kind: 'text' },
        /**
         * The report number was plain text, so a screen whose entire job is "find the
         * charge somebody is asking about" could not be used to go and look at it —
         * you read the number here and typed it into the reports list.
         *
         * Kept as a real anchor even now that the whole row navigates: it is the
         * visible promise that the number leads somewhere, and it is what makes
         * middle-click / cmd-click open the claim in its own tab, which is how AP
         * works a chase list.
         */
        cell: (r) => (
          <Link
            href={`/expenses/${r.report.id}?expense=${r.id}`}
            className="font-mono text-primary text-xs underline-offset-2 hover:underline"
          >
            {/* VeloExpense: a report from before numbering has no number. */}
            {r.report.number ?? '—'}
          </Link>
        ),
        exportValue: (r) => r.report.number ?? '',
      },
      {
        id: 'status',
        label: t('columns.status'),
        defaultWidth: 130,
        sortable: true,
        /**
         * Status was the one column AP reads on every row and could not narrow by — the
         * pill bar offered submitter, report, merchant and category, and not the field
         * that says whether a charge is still moving.
         *
         * DRAFT is deliberately absent. The server never returns a draft report's
         * expenses, so a `Draft` option is a control whose only possible answer is an
         * empty list, with nothing on screen to explain why. Labels come from the same
         * `expenses.status.*` keys the badge and the CSV export use, so the pill, the
         * filter and the file cannot end up saying three different things (F43).
         */
        filterable: {
          kind: 'enum',
          options: REPORT_STATUSES.filter((s) => s !== 'DRAFT').map((s) => ({
            value: s,
            label: t(`status.${s.toLowerCase()}`),
          })),
        },
        cell: (r) => <StatusBadge {...statusBadgeProps(r.report.status, t, 'Submitted')} />,
        exportValue: (r) => t(`status.${r.report.status.toLowerCase()}`),
      },
      {
        id: 'merchant',
        label: t('columns.merchant'),
        defaultWidth: 170,
        sortable: true,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-muted-foreground">{r.merchant ?? '—'}</span>,
        exportValue: (r) => r.merchant ?? '',
      },
      {
        id: 'category',
        label: t('columns.category'),
        defaultWidth: 160,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-muted-foreground">{label(r.categoryLabel)}</span>,
        // The dash is a rendering, not a value — same split the merchant column above
        // makes. Exported, it becomes a category called "—" that sorts among the real
        // ones and defeats a filter for "uncategorised".
        exportValue: (r) => pickText(r.categoryLabel, locale),
      },
      {
        id: 'receipt',
        label: t('allExpenses.receiptColumn'),
        defaultWidth: 130,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: [
            { value: RECEIPT_MISSING, label: t('allExpenses.missing') },
            { value: RECEIPT_ATTACHED, label: t('allExpenses.hasReceipt') },
          ],
        },
        cell: (r) =>
          r.receiptCount > 0 ? (
            <span className="text-muted-foreground text-xs">
              {t('allExpenses.receiptCount', { count: r.receiptCount })}
            </span>
          ) : (
            // The reason this page exists — make it impossible to miss.
            <span className="font-medium text-destructive text-xs">{t('allExpenses.missing')}</span>
          ),
        exportValue: (r) =>
          r.receiptCount > 0 ? String(r.receiptCount) : t('allExpenses.missing'),
      },
      {
        id: 'amount',
        label: t('columns.amount'),
        defaultWidth: 130,
        sortable: true,
        cell: (r) => (
          <span className="block text-right tabular-nums">
            {formatMinor(Number(r.amountMinor), r.currency, locale)}
          </span>
        ),
        exportValue: (r) => formatMinor(Number(r.amountMinor), r.currency, locale),
        exportNumber: (r) => Number(r.amountMinor) / 10 ** currencyExponent(r.currency.code),
      },
    ],
    [t, locale, label],
  );

  /**
   * The clauses the list opens with. An ALLOWLIST, deliberately.
   *
   * Ninety days, and three statuses named POSITIVELY rather than two exclusions: the
   * operator asked for the queue to hold what is IN FLIGHT, and "not rejected, not
   * reimbursed" describes that only by accident of today's enum. The cost is that a status
   * added to `ExpenseReportStatus` later is invisible here until somebody adds it to
   * `DEFAULT_STATUSES`, and nothing will fail to say so: the list will simply not show
   * those expenses and the pill bar will look correct. That is the trade taken.
   *
   * CLAUSES, not hidden floors. Both render as pills on the bar like any other, so the list
   * says what it is doing and the reader can widen or remove either — as opposed to a
   * default buried in the query, where "why is this expense not in the list" has no answer
   * on screen. A pinned saved view replaces them: the reader has said what their default is.
   *
   * ── Why `status` filters here and `date` does not ──
   *
   * The file header's rule — this list is paged, so post-filtering the loaded page is
   * dishonest — stands, and `date` and `receipt` obey it. `status` is the exception, taken
   * knowingly:
   *
   *   · `date` resolves SERVER-side. It is a completeness guarantee: every matching row is
   *     reachable by paging.
   *   · `status` resolves CLIENT-side, over the rows already fetched. `expenseApprovals
   *     .expenses` takes a single optional status, not a set, and widening it is a backend
   *     change ruled out of scope. So the reader sees a filter of a PREFIX, not a prefix of
   *     the filter.
   *
   * That truncation HIDES ITSELF, which is exactly why it is written down rather than left
   * to be discovered. Report status correlates with age — recent expenses sit in
   * SUBMITTED / APPROVED / RETURNED and older ones drain to REIMBURSED — and the sort is
   * date-descending, so the client filter's yield is highest on page one and falls
   * thereafter. The first page looks the most complete this list will ever look.
   *
   * `AllExpensesList.test.tsx` pins the limitation in "filters the statuses over the rows it
   * has, not over the ones it has not fetched". That test is the record that the gap was
   * CHOSEN and not missed: do not "fix" it by moving `status` into `queryArgs`.
   */
  const defaultFilters = useMemo(
    () => [
      { id: newClauseId(), field: 'date' as ColumnId, op: 'within' as const, value: 'last90' },
      ...statusClauses(() => newClauseId()),
    ],
    [],
  );
  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, { filters: defaultFilters }),
  );
  const pillBar = useFilterPillBarWiring<Row, ColumnId>(columns, tableState, setTableState);

  /**
   * `date` is injected into the pill bar directly rather than as a `filterable` column.
   *
   * A column's own `filterable.kind` is `'enum' | 'text'` — the column-header editor cannot
   * host the date editor's relative presets and absolute comparisons. The same reason the
   * transactions list injects its `date` field here.
   *
   * It leads the list because it is what AP narrows by first, and because the page opens
   * with a date clause already on the bar.
   */
  const filterFields = useMemo<ColumnId[]>(
    () => ['date', ...pillBar.filterFields.filter((f) => f !== 'date')],
    [pillBar.filterFields],
  );
  const filterLabels = { ...pillBar.filterLabels, date: t('columns.date') };
  const filterKinds = { ...pillBar.filterKinds, date: 'date' as FieldKind };
  const filterOptions = { ...pillBar.filterOptions, date: [] };

  /**
   * `date` and `receipt` are answered by the SERVER, not by filtering the loaded page.
   *
   * This list is paged. Post-filtering what happens to be loaded would answer "which
   * expenses are missing a receipt" with "of the two hundred I have, these" — and the
   * whole point of the page is that the answer is complete.
   *
   * The date clause resolves client-side, where the browser's timezone is known, into the
   * absolute bounds the server filters on. `to` is INCLUSIVE server-side while
   * `resolveDateFilter` returns an exclusive `lt`, so the boundary is stepped back by a
   * millisecond rather than by a day.
   *
   * `status` is read here by nothing, on purpose, even though the list opens with three
   * status clauses. The endpoint takes one optional status and the default is a union of
   * three; the accepted consequence is spelled out on `defaultFilters`. Adding a `status`
   * branch to this loop would send only the last clause and silently narrow the list to one
   * status — which is worse than the client filter, not better.
   */
  const debouncedFilters = useDebouncedValue(tableState.filters, 300);
  const queryArgs = useMemo(() => {
    const now = new Date();
    let from: Date | undefined;
    let to: Date | undefined;
    let missingReceipt: boolean | undefined;
    for (const c of debouncedFilters) {
      if (c.field === 'date') {
        const w = resolveDateFilter(c.op, c.value, now);
        if (w.gte) from = w.gte;
        if (w.lt) to = new Date(w.lt.getTime() - 1);
      } else if (c.field === 'receipt') {
        // Only `equals` narrows; `doesNotEqual` on a two-value enum is the other value,
        // and anything else is a clause the reader has not finished writing.
        if (c.op === 'equals') missingReceipt = c.value === RECEIPT_MISSING;
        else if (c.op === 'doesNotEqual') missingReceipt = c.value !== RECEIPT_MISSING;
      }
    }
    return { from, to, missingReceipt };
  }, [debouncedFilters]);

  /**
   * Paged, not capped.
   *
   * This took 200 rows and stopped, with no way to ask for more and nothing on screen saying
   * it had truncated (GA readiness report F19). On a list AP works from, silently hiding
   * expenses is worse than anywhere else in the product.
   */
  const query = trpc.expenseApprovals.expenses.useInfiniteQuery(queryArgs, {
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(
    // `pages?.` as well as `data?.`: a cached response from before this became an infinite
    // query has no `pages`, and reading through it would crash the list rather than show an
    // empty one.
    () => query.data?.pages?.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  const fieldText = useCallback(
    (r: Row, field: ColumnId): string => {
      switch (field) {
        case 'submitter':
          return displayName(r.report.submitter);
        case 'report':
          // VeloExpense: a report from before numbering has no number.
          return r.report.number ?? '';
        case 'merchant':
          return r.merchant ?? '';
        case 'category':
          return label(r.categoryLabel);
        // The ENUM, never the translated badge label: a saved view that stored "Approved"
        // would stop matching the moment its owner switched to fr-CA.
        case 'status':
          return r.report.status;
        default:
          return '';
      }
    },
    [label],
  );

  /**
   * Clauses are grouped by FIELD: AND across fields, but several `equals` clauses on ONE
   * field OR together.
   *
   * That is what the bar has always DRAWN. `FilterPillBar` groups same-field, same-operator
   * clauses into a single block and renders a literal "or" between the value chips — so the
   * reader sees the sentence "Status is Submitted or Approved". This matcher narrowed
   * SUCCESSIVELY, though, so the second chip intersected with the first, no row can be two
   * statuses at once, and the list went blank. Every filterable field here was affected, not
   * just `status`: merchant, category, report and submitter all emptied the list the moment
   * somebody added a second value to a pill.
   *
   * The same shape already lives in `RoleBuilder` and `NetSuiteReferenceList`, and it is the
   * rule `clausesToServerFilters` encodes for the server side. This file was the outlier.
   *
   * Negative operators stay ANDed within the field. ORing them would read "not Canoe OR not
   * Air Canada", which matches every row — the reader's exclusion would silently stop
   * excluding.
   */
  const filteredRows = useMemo(() => {
    // `date` and `receipt` were already applied by the QUERY. Running them again here
    // would filter on `fieldText`, which has no text for either — so every row would
    // fail the comparison and the list would come back empty the moment somebody used
    // the very filters this page is for.
    // VeloExpense: the clause type named outright rather than `typeof tableState.filters`,
    // which ESLint's exhaustive-deps reads as a use of `tableState` (Biome does not).
    const byField = new Map<ColumnId, FilterClause<ColumnId>[]>();
    for (const c of tableState.filters) {
      if (SERVER_FILTERED.has(c.field)) continue;
      const list = byField.get(c.field) ?? [];
      list.push(c);
      byField.set(c.field, list);
    }
    let out = rows.slice();
    for (const [field, clauses] of byField) {
      const equals = clauses.filter((c) => c.op === 'equals');
      const others = clauses.filter((c) => c.op !== 'equals');
      out = out.filter((r) => {
        const v = fieldText(r, field).toLowerCase();
        // OR across the field's `equals` clauses — the union the pill's "or" promises.
        if (equals.length > 0 && !equals.some((c) => v === String(c.value ?? '').toLowerCase()))
          return false;
        // AND across everything else.
        for (const c of others) {
          const needle = String(c.value ?? '').toLowerCase();
          if (c.op === 'doesNotEqual' && v === needle) return false;
          if (c.op === 'contains' && !v.includes(needle)) return false;
          if (c.op === 'doesNotContain' && v.includes(needle)) return false;
          if (c.op === 'startsWith' && !v.startsWith(needle)) return false;
          if (c.op === 'endsWith' && !v.endsWith(needle)) return false;
        }
        return true;
      });
    }
    if (tableState.sort) {
      const { field, dir } = tableState.sort;
      const mul = dir === 'asc' ? 1 : -1;
      out = out.sort((a, b) => {
        if (field === 'amount') {
          const d = BigInt(a.amountMinor) - BigInt(b.amountMinor);
          return (d > 0n ? 1 : d < 0n ? -1 : 0) * mul;
        }
        if (field === 'date')
          // VeloExpense: an undated expense sorts as the oldest, as the server pages it last.
          return (dateMs(a) - dateMs(b)) * mul;
        if (field === 'receipt') return (a.receiptCount - b.receiptCount) * mul;
        if (field === 'status') return a.report.status.localeCompare(b.report.status) * mul;
        return (
          fieldText(a, field as ColumnId).localeCompare(fieldText(b, field as ColumnId), locale) *
          mul
        );
      });
    }
    return out;
  }, [rows, tableState.filters, tableState.sort, fieldText, locale]);

  const selectedIds = useMemo(() => [...tableState.selectedIds], [tableState.selectedIds]);
  // Only receiptless rows can be chased; asking for a receipt that exists is a
  // confusing message to receive.
  const chaseableIds = useMemo(
    () => selectedIds.filter((id) => rows.find((r) => r.id === id)?.receiptCount === 0),
    [selectedIds, rows],
  );

  // ─── Saved views ──────────────────────────────────────────────
  // VeloExpense: ExpenseOS's system views (`sys:default`, `sys:missing-receipt`,
  // `sys:all-time`), its user views and the pinned-view default arrive with saved views in
  // Wave 4 (see the header). The opening default above is unchanged, and the receipt pill
  // answers what `Missing receipt` did.

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="rounded bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</p>
      )}
      {notice && (
        <p className="rounded bg-success/10 px-3 py-2 text-foreground text-sm">{notice}</p>
      )}

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
          // VeloExpense: no `untitledViewLabel` / `savedViews` until Wave 4 (see the header).
        />
      </div>

      <div className="flex flex-col overflow-hidden rounded-md border border-border bg-card">
        <DataTableToolbar
          {...toolbarLabels}
          selectedCount={selectedIds.length}
          resultCount={filteredRows.length}
          loading={query.isLoading}
          bulkActionsDisabled={chase.isPending}
          bulkActions={[
            {
              id: 'chase',
              // Counts the CHASEABLE subset, not the raw selection — a
              // selection of rows that all have receipts offers nothing.
              label: t('allExpenses.requestReceipts', { count: chaseableIds.length }),
              onSelect: () =>
                chaseableIds.length > 0
                  ? chase.mutate({ expenseIds: chaseableIds })
                  : setNotice(t('allExpenses.chaseNone')),
            },
          ]}
          rightSlot={
            <div className="flex items-center gap-1">
              <TableExportMenu<Row, ColumnId>
                columns={columns}
                rows={filteredRows}
                filename="all-expenses"
                state={tableState}
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
            </div>
          }
        />
        {/* Orders its own rows — the table must not re-sort them. */}
        <DataTable<Row, ColumnId>
          sortMode="external"
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.id}
          totalCount={filteredRows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={openExpense}
          loading={query.isLoading}
          labels={tableLabels}
          selectable
          // Fetch the next page as the reader reaches the end, rather than stopping at 200
          // rows with nothing on screen saying so.
          hasNextPage={query.hasNextPage ?? false}
          onLoadMore={query.fetchNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          /**
           * Windowed. This list is unbounded now, and painting every row of a year's expenses
           * into one DOM list is what F19 was about on the display side as much as the query
           * side.
           */
          virtualizeRows
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('allExpenses.emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('allExpenses.emptyBody')}</div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

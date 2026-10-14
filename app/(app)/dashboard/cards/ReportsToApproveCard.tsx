'use client';

import { Badge, Button, SectionCard, SectionEmpty } from '@expenseos/design-system';
import { IconChecks } from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableMobileConfig,
  type DataTableState,
  useTableLabels,
} from '@/components/data-view';
import { Link } from '@/i18n/navigation';
import { displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';

/** How many rows the card draws. Five is a glance; the sixth is a listing. */
const PREVIEW_ROWS = 5;

/**
 * Four columns, and the fifth was cut on purpose: the inbox shows a STATUS column, and
 * every row in a pending queue is by definition awaiting the reader — a column of five
 * identical "Submitted" badges is noise occupying the width the money needs.
 */
const COLUMN_ORDER = ['report', 'submitter', 'total', 'submitted'] as const;
type ColumnId = (typeof COLUMN_ORDER)[number];

/** One item of `expenseApprovals.myTasks` — a pending task plus its subject report. The
 *  same inference the inbox uses, so the two cannot drift apart on the row's shape. */
type Task = inferRouterOutputs<AppRouter>['expenseApprovals']['myTasks']['items'][number];

/**
 * What a queued report becomes below the compact breakpoint. Naming `title` here IS the
 * opt-in: `layout` stays `'auto'`, and `DataTable` reaches its card tree only because
 * `mobile.title` is set (`DataTable.tsx:159-160`).
 *
 * `ExpenseApprovalsInbox.tsx:398-407` IS THE PRECEDENT FOR THE SLOT SHAPE — the same queue,
 * one screen deeper — and this is its pending-view shape with the badge dropped. Title
 * `report`, subtitle `submitter`, fields `total` and `submitted`. It is NOT the precedent
 * for the pins below; see that paragraph.
 *
 * THE SUBMITTER IS THE SUBTITLE, NOT A FIELD ROW. It is an attribution under the report's
 * name, which is how the inbox already reads it and what the slot's own doc comment names
 * as its example; as a `<dt>`/`<dd>` pair it would be one more labelled row competing with
 * the money.
 *
 * NO `badge`, AND THAT IS THE DECISION A REVIEWER IS MOST LIKELY TO WANT TO REVERSE. This
 * card has no status COLUMN to put in the slot — it was cut on purpose, because every row
 * in a pending queue is by definition awaiting the reader and five identical "Submitted"
 * pills are noise. The money is the obvious candidate and it is the wrong one: a badge is
 * where a reader looks for STATE, and a total is not a state. Putting it there would also
 * give the highest-stakes figure on the page the loudest slot on the card, in a list that
 * routinely holds several submitters' currencies at once (F54). It stays a field row, in
 * its own currency with its ISO code, exactly as the table prints it.
 *
 * BOTH FIELDS ARE PINNED `hideable: false` at their columns, AND THIS IS WHERE THE CARD
 * PARTS COMPANY WITH THE INBOX ON PURPOSE. The inbox pins only `report` (`:217` is its
 * sole `hideable: false`) and leaves `submitter` and `total` hideable — and it is the one
 * with a live Hide menu, because it passes no `plainHeaders`. This card pins them anyway
 * because a five-row preview has no second place to recover the fact from: the inbox's
 * reader who hides a column still has the inbox's filters, views and drawer to get it
 * back, and a reader here has the row link and nothing else. That divergence is the plan's
 * Round-2 arbitration, not an inference from the inbox — `MyExpenseReportsCard` declines
 * to pin from the mirror-image argument, and both are deliberate.
 *
 * `fields` is intersected with `state.columnVisibility` at render, and on this route that
 * map is provably `{}` — `createDataTableState(…, {})` seeds it empty and `plainHeaders`
 * switches off the only control that writes it (`DataTable.tsx:1049` passes
 * `chrome={!plainHeaders}`), so the pins change nothing today.
 *
 * NO `rowActions`, and the inbox's reasoning carries verbatim: a kebab offering a quick
 * Approve would let somebody decide a financial approval without ever opening the report,
 * which is a review bypass dressed as a convenience. This card cannot even do that much —
 * it imports no drawer — so its one affordance is the row link, and that is the intent.
 *
 * MODULE-LEVEL LITERAL, NOT AN INLINE OBJECT — `DataTableCards` memoises the field
 * intersection on `mobile.fields` identity, and a config rebuilt per render defeats it.
 */
const MOBILE: DataTableMobileConfig<Task, ColumnId> = {
  title: 'report',
  subtitle: 'submitter',
  fields: ['total', 'submitted'],
};

/**
 * "Reports to approve" — what is waiting on the reader's decision, on the page they land on.
 *
 * SIBLING OF `MyExpenseReportsCard` AND `MyTravelRequestsCard`, deliberately down to the
 * prop list: bare `DataTable` with `plainHeaders` / `sortMode="external"` /
 * `disableInfiniteScroll`, no toolbar, no filter pill bar, and NO `onRowClick` —
 * `DataTable` puts that handler on a `<tr>` with no `tabIndex`, no `onKeyDown` and no
 * `role`, which is a WCAG 2.1.1 failure this card routes around rather than fixes. The
 * row's target is a real `<a>` in the primary cell, wrapping BOTH lines so each row's link
 * is named by its report instead of five links all called "View". Read
 * `MyExpenseReportsCard`'s docstring for the full account; it is not repeated here.
 *
 * IT DOES NOT IMPORT `ApproverReportDrawer`. That drawer carries the approval module's
 * whole mutation graph — decide, return, reimburse, receipt review — and the landing page
 * must stay cheap. Rows link to `/expenses/approvals?report=<id>`, which the inbox already
 * reads through `useDeepLink('report')` and opens the review drawer on. One destination,
 * one drawer, and the card ships none of it.
 *
 * THE GATE IS THE PAGE'S, AND IT IS DELIBERATELY NARROW. `selectDashboardCards` mounts
 * this on `P.expense.report.approve` plus the expense-management module — narrower than
 * `/expenses/approvals`, which also admits `reimburse` and `readAll`. A reimburse-only AP
 * clerk therefore has an inbox and no dashboard card: the card is about work waiting on
 * YOUR DECISION, and an AP clerk's queue is not that. Intended, not an oversight.
 *
 * THE QUERY IS THE INBOX'S QUERY, ON PURPOSE. `useQuery()` with no argument is exactly
 * what `ExpenseApprovalsInbox` passes, so the two share one react-query cache entry — the
 * click through from this card into the inbox finds the queue already warm, and the
 * `myTasks.invalidate()` that every decide / return / bulk-approve action already fires
 * refreshes this card too. A dashboard-only argument would be a different cache key: a
 * second round trip on the way in, and a card that keeps showing a report the reader just
 * approved in another tab.
 */
export function ReportsToApproveCard() {
  const t = useTranslations('dashboard.cards.approvals');
  const tCommon = useTranslations('common');
  /** One binding for the whole `expenses` namespace: the four column headings are the
   *  inbox's own words, so the card and the page it links to cannot drift apart. */
  const tExpenses = useTranslations('expenses');
  const locale = useLocale();
  const tableLabels = useTableLabels();

  const tasks = trpc.expenseApprovals.myTasks.useQuery();

  /**
   * The queue as REPORTS, oldest first — two decisions, both of them explicit.
   *
   * DEDUPE ON REPORT ID, IN THE CARD AND NOT IN THE PROCEDURE. A report under a parallel
   * gate can carry two of the caller's pending tasks at once, and in the inbox that is
   * correct: two decidable tasks are two things to decide, each with its own row and its
   * own buttons. This card has no buttons — its row is a link to a report — so the same
   * report twice is the same link twice. Narrowing `myTasks` itself would fix the card by
   * breaking the inbox, so the dedupe lives here, where the report (not the task) is the
   * unit being rendered.
   *
   * SORT EXPLICITLY BY `submittedAt`, ASCENDING. `myTasks` concatenates `assigned` then
   * `claimable` (`expenseApprovals.ts:320-323`), so `items` is ordered WITHIN each half
   * and not across them — the arrival order of a five-row preview would otherwise be an
   * accident of that concatenation. `submittedAt` is the approver's own question, "how
   * long has this been waiting on me", and ascending puts the longest wait at the top:
   * the five rows are then the five most overdue, not five arbitrary ones. It matches the
   * `createdAt: 'asc'` the procedure's own two queries use. Nulls sort LAST — a report
   * with no submission timestamp cannot be ranked by how long it has waited, and guessing
   * it is the oldest would push it above reports that genuinely are.
   *
   * `sortMode="external"` on the table below is what keeps this decision the one that
   * holds: the default (`'client'`) would silently re-sort these rows.
   */
  const queue = useMemo(() => {
    const byReport = new Map<string, Task>();
    for (const task of tasks.data?.items ?? []) {
      if (!byReport.has(task.report.id)) byReport.set(task.report.id, task);
    }
    return [...byReport.values()].sort((a, b) => {
      const at = a.report.submittedAt ? new Date(a.report.submittedAt).getTime() : null;
      const bt = b.report.submittedAt ? new Date(b.report.submittedAt).getTime() : null;
      if (at === null) return bt === null ? 0 : 1;
      if (bt === null) return -1;
      return at - bt;
    });
  }, [tasks.data?.items]);

  const rows = useMemo(() => queue.slice(0, PREVIEW_ROWS), [queue]);

  const columns = useMemo<ColumnDef<Task, ColumnId>[]>(
    () => [
      {
        id: 'report',
        label: tExpenses('columns.report'),
        defaultWidth: 260,
        hideable: false,
        cell: (row) => (
          <Link
            href={`/expenses/approvals?report=${row.report.id}`}
            className="flex min-w-0 flex-col hover:underline focus-visible:underline"
          >
            <span className="truncate font-semibold text-foreground text-sm">
              {row.report.title}
            </span>
            <span className="truncate text-muted-foreground text-xs">{row.report.number}</span>
          </Link>
        ),
      },
      {
        /** WHOSE report, not whose task. The reader is the approver on every row, so the
         *  only name worth a column is the one they are deciding about. */
        id: 'submitter',
        label: tExpenses('approvals.submitter'),
        defaultWidth: 180,
        /* FUTURE-TOOLBAR DEFENCE, INERT TODAY: nothing on this route can hide a column
           (`plainHeaders` switches the header menu off wholesale), so `columnVisibility`
           stays `{}` and this changes nothing now. `subtitle` is NOT exempt from that
           intersection — only `title` and `badge` are (`DataTableCards.tsx:229-243`) — so
           the day a toolbar arrives, an approver who tidied the desktop table would
           otherwise get a phone queue of reports with nobody attached to them. */
        hideable: false,
        cell: (row) => (
          <span className="truncate text-foreground text-sm">
            {displayName(row.report.submitter)}
          </span>
        ),
      },
      {
        /** The ISO code, not the glyph. This card is the one place on the page that holds
         *  reports from SEVERAL submitters at once, so two currencies in five rows is the
         *  normal case rather than the edge one — and CAD and USD both print `$` (F54). */
        id: 'total',
        label: tExpenses('columns.total'),
        defaultWidth: 140,
        /* FUTURE-TOOLBAR DEFENCE, INERT TODAY, for the same mechanism as `submitter`
           above. The amount is the one fact this card carries that the header deliberately
           refuses to sum, so a card that could lose it would leave an approver a queue with
           no figure on it anywhere. */
        hideable: false,
        cell: (row) => (
          <span className="text-foreground text-sm tabular-nums">
            {formatMinor(BigInt(row.report.totalMinor), row.report.currency, locale, {
              withCode: true,
            })}
          </span>
        ),
      },
      {
        id: 'submitted',
        label: tExpenses('approvals.submitted'),
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
    ],
    [tExpenses, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(COLUMN_ORDER.map((id) => ({ id })) as never, {}),
  );

  return (
    <SectionCard
      headingLevel={2}
      title={t('title')}
      headerRight={
        tasks.isError || tasks.isPending ? undefined : (
          <Header count={queue.length} capped={tasks.data?.capped ?? false} />
        )
      }
      loading={tasks.isPending}
      loadingLabel={t('loading')}
      skeletonRows={PREVIEW_ROWS}
      error={
        tasks.isError
          ? {
              message: tCommon('panelUnavailable'),
              action: (
                <Button size="sm" variant="secondary" onClick={() => void tasks.refetch()}>
                  {tCommon('retry')}
                </Button>
              ),
            }
          : null
      }
      /* OPTIONAL, and passed from the non-empty branch only. A "view all" underneath an
         empty section links the reader into a listing they were just told is empty.

         `min-h-11` PINS A FLOOR THAT IS CURRENTLY MET ONLY BY COINCIDENCE. This link
         already reaches 44px and so is not a violation today — but every pixel of that
         height is bought by `py-3` on `text-sm`, and a future type-scale or padding change
         drops it under WCAG 2.2 SC 2.5.5 with nothing to report it. SILENTLY is the
         operative word, and it is the reason to spend a class here: a control declaring no
         floor has no `::after`, so `e2e/tap-targets.mobile.spec.ts` reads
         `floored.vertical === false` and its floor lane SKIPS the control. The drift would
         not go red, it would go unmeasured.

         `min-h-11` is a real painted minimum height, NOT the coarse-pointer slop that the
         `einc-tap-slop` recipe grants — the floor has to hold with a mouse too, since this
         is not an under-sized control being given a bigger hit region. It sits BESIDE
         `py-3` rather than instead of it: `min-height` only ever raises the used height, so
         at today's type scale it resolves to the same 44px and nothing moves on screen. */
      footer={
        rows.length > 0 ? (
          <Link
            href="/expenses/approvals"
            className="block min-h-11 px-5 py-3 text-center font-medium text-primary text-sm hover:underline"
          >
            {t('viewAll')}
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        /**
         * AN EMPTY CARD, NOT AN ABSENT ONE. An approver with nothing pending still gets
         * the section. An absent card is indistinguishable from absent permission, a
         * failed query, or a bug: an approver used to three cards who sees two concludes
         * the page is broken, not that they are caught up. So the card states the good
         * news instead of vanishing — and states it with NO call to action, because there
         * is nothing to do about being finished. The icon is a tick, not a crossed-out
         * inbox: this is the state the reader wants to be in.
         */
        <SectionEmpty
          icon={<IconChecks size={36} className="text-muted-foreground" />}
          message={t('empty')}
          hint={t('emptyHint')}
        />
      ) : (
        <DataTable<Task, ColumnId>
          columns={columns}
          rows={rows}
          /* The REPORT's id, not the task's: the rows were deduped on it above, so it is
             the key that is now unique — and it stays stable if a second parallel task on
             the same report appears or is decided. */
          rowKey={(row) => row.report.id}
          state={tableState}
          onStateChange={setTableState}
          labels={tableLabels}
          mobile={MOBILE}
          plainHeaders
          sortMode="external"
          disableInfiniteScroll
        />
      )}
    </SectionCard>
  );
}

/**
 * The header badge: HOW MANY, and nothing else.
 *
 * NO MONEY HERE, EVER — this is the one hard rule on this card. Both sibling cards carry a
 * total beside their count, and this one deliberately does not: the approvals header is the
 * highest-stakes number on the page ("how much is waiting on my signature"), and adding
 * minor units across the currencies of several submitters is precisely GA readiness report
 * F54. `myTasks` does return a home-currency rollup, and the "dominant currency + excluded
 * count" treatment the other cards use would still be wrong here, because it UNDERSTATES A
 * LIABILITY FIGURE — an approver reading a number smaller than what they are actually
 * holding. A count is a claim the card can make truthfully in every currency mix there is.
 *
 * THE COUNT IS OF REPORTS, DERIVED FROM THE DEDUPED QUEUE — not `data.count`, which counts
 * TASKS. Both are computed over the same materialized array, so neither is more accurate
 * than the other; the difference is only which unit the card is speaking in. Every visible
 * thing in this card is a report — the rows, the column headed "Report", the word in the
 * message — so a header counting tasks would disagree with the list beneath it whenever a
 * parallel gate put two of the reader's tasks on one report. The card is internally
 * consistent instead. (The "Waiting for you" tile that used to sit further down this page
 * rendered the TASK count under no unit at all, so the two numbers could differ by one in
 * that rare case. The tile is gone, and this is the only count of that queue the reader
 * now sees.)
 *
 * WHEN THE POOL WAS CAPPED THE NUMBER IS A FLOOR. `myTasks` materializes at most
 * `APPROVAL_POOL_CAP` tasks per pool and says so with `capped`, and its own contract asks
 * the UI to say so "rather than presenting a truncated number as if it were the answer".
 * Two literal messages, not one with a computed key — `check-used-keys` skips template
 * literals, so a computed key ships as a MISSING_MESSAGE at render.
 *
 * THIS IS NOW THE ONLY HEADER BADGE ON THE PAGE, AND THAT IS THE RULE RATHER THAN AN
 * OVERSIGHT. Both sibling cards used to carry a count-and-total badge; neither does any
 * more. The one that survived is the one whose header carries an OBLIGATION — "how many
 * decisions are queued on me" is the actionable fact, and the reader needs it before
 * deciding whether to open anything at all. The other two answered "what are my things
 * doing", where the header only restated the listing directly underneath it. Recorded as D8
 * in the dashboard ADR; read that entry before either adding badges back to those two or
 * removing this one in the name of consistency.
 */
function Header({ count, capped }: { count: number; capped: boolean }) {
  const t = useTranslations('dashboard.cards.approvals');
  if (count === 0) return null;

  return (
    <Badge variant={capped ? 'warning' : 'secondary'}>
      {capped ? t('countCapped', { count }) : t('count', { count })}
    </Badge>
  );
}

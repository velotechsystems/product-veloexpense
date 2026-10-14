'use client';

import { Button, SectionCard, SectionEmpty, StatusBadge } from '@expenseos/design-system';
import { IconReceiptOff } from '@tabler/icons-react';
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
import { formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import type { AppRouter } from '@/server/routers/_app';
import { statusBadgeProps } from '../../expenses/_shared';

/** How many rows the card draws. Five is a glance; the sixth is a listing. */
const PREVIEW_ROWS = 5;

/**
 * Four columns, and the fifth was cut on purpose: `expenses.list` also carries an expense
 * COUNT per report, and nobody triages by line count. On a five-row card it would be the
 * fifth of five, pushing the columns that matter into a horizontal scroll.
 *
 * THIS CONSTANT IS THE RENDERED COLUMN ORDER, AND IT IS THE ONLY THING THAT SETS IT.
 * `createDataTableState` reads `columnOrder` off the array it is handed, and what it is
 * handed below is `COLUMN_ORDER.map((id) => ({ id }))` — the real `columns` array is never
 * passed to it. So reordering `columns` alone changes nothing on screen, and reordering
 * this alone changes everything. The two are nevertheless kept in the SAME order, so a
 * reader of this file need not hold two orders in their head to know what the table looks
 * like. `MyExpenseReportsCard.test.tsx` asserts the rendered header order, because until
 * that test was written nothing in the product did.
 *
 * STATUS IS LAST, matching the travel card's `destination · dates · budget · status`. The
 * two "my things" cards stack on the landing page, and a reader scanning down them finds
 * the same kind of column in the same place on both.
 */
const COLUMN_ORDER = ['report', 'total', 'updated', 'status'] as const;
type ColumnId = (typeof COLUMN_ORDER)[number];

/** One row of `expenses.list` — the same `inferRouterOutputs` idiom `ReportsToApproveCard`
 *  uses for its own rows, so this card and `/expenses` cannot drift apart on the row's
 *  shape. It is at module scope only because `MOBILE` below is. */
type Report = inferRouterOutputs<AppRouter>['expenses']['list'][number];

/**
 * What a report becomes below the compact breakpoint, where the card list replaces the
 * table. Naming `title` here IS the opt-in: `layout` stays `'auto'`, and `DataTable`
 * reaches its card tree only because `mobile.title` is set (`DataTable.tsx:159-160`).
 *
 * THE SAME SET `/expenses` ALREADY SHIPS (`ExpenseReportsList.tsx:635-639`) — title
 * `report`, badge `status`, fields `total` and `updated`. This card is a five-row preview
 * of that very listing, so a reader who triages on one and then on the other finds the same
 * four facts in the same slots; a second editorial choice here would be a difference with
 * no reason behind it. No `rowActions`: that page's config carries some and this card has
 * none, because its only affordance is the row link.
 *
 * NO NEW PIN, AND THAT IS THE DECISION RATHER THAN THE OMISSION. `report` is already
 * `hideable: false`, which is what keeps the identity slot fillable. `total` and `updated`
 * stay hideable, exactly as `/expenses` ships them — the page that DOES mount a gear menu
 * leaves the same two unpinned, and pinning them harder on a card that cannot open one
 * would be this file inventing a rule its own precedent does not follow.
 *
 * `fields` IS INTERSECTED WITH `state.columnVisibility` at render, and on this route that
 * map is provably `{}`: `createDataTableState(…, {})` seeds it empty, and the only writer
 * of it is the column header's Hide item, which `plainHeaders` switches off wholesale
 * (`DataTable.tsx:1049` passes `chrome={!plainHeaders}`). Nothing in this tree can empty a
 * field row.
 *
 * MODULE-LEVEL LITERAL, NOT AN INLINE OBJECT. `DataTableCards` memoises the intersection on
 * `mobile.fields` identity; a config rebuilt per render hands it a new array every commit
 * and the memo never holds.
 */
const MOBILE: DataTableMobileConfig<Report, ColumnId> = {
  title: 'report',
  badge: 'status',
  fields: ['total', 'updated'],
};

/**
 * "My expense reports" — the reader's five most recent reports, on the page they land on.
 *
 * THE RENDERER IS `DataTable`, BARE. No toolbar, no filter pill bar, no saved views, no
 * search. `docs/design/listing-standard.md:3` bans a hand-rolled `<table>`, a bespoke
 * search `<Input>` and a one-off `<Select>` filter; this card hand-rolls none of those —
 * it mounts the one list renderer the standard names and surrounds it with no chrome at
 * all. `virtual-cards/import/CardImport.tsx` is the same shape and is already recorded as
 * exempt. Building the grid out of divs instead would be the precise thing `:3` forbids.
 *
 * THREE PROPS ARE LOAD-BEARING:
 *   - `sortMode="external"` — the default is `'client'`, which would silently re-sort the
 *     five rows the server already ordered by `updatedAt desc`.
 *   - `plainHeaders` — the sort / filter / menu / resize affordances reserve padding in
 *     every header and read as clutter on a five-row card that offers none of them.
 *   - `disableInfiniteScroll` — there is no next page here; the sentinel would ask for one.
 *
 * NO `onRowClick`, NOW OR LATER. `DataTable` puts its row `onClick` on the `<tr>` with no
 * `tabIndex`, no `onKeyDown` and no `role` — a WCAG 2.1.1 failure, and one this card
 * routes around rather than fixes. The row's target is a real `<a>` in the primary cell,
 * which the keyboard reaches, Enter follows, and the browser can open in a new tab. The
 * anchor wraps BOTH lines of that cell on purpose: it gives every row's link an accessible
 * name that names the report, instead of five links all called "View".
 *
 * THE HEADER CARRIES NO BADGE — NO COUNT, NO TOTAL — AND THAT IS THE RULE FOR THIS PAGE.
 * This card used to print "63 reports · Total CAD 99,000.00" beside its title, from
 * `expenses.summaryOwn`. It is gone, and so is the travel card's. The approvals card's
 * badge STAYS, and the asymmetry is the point rather than an oversight:
 *
 *   THE ONE CARD WHOSE HEADER CARRIES AN OBLIGATION KEEPS ITS HEADER; THE TWO THAT
 *   CARRIED A SELF-SUMMARY LOST THEIRS.
 *
 * "Reports to approve" answers "how many decisions are queued on me", and the count IS the
 * actionable fact — the reader needs it before deciding whether to open anything. This card
 * and the travel card answer "what are my things doing", where the header only restated a
 * listing that is already on screen and one click from its full form. Recorded as D8 in the
 * dashboard ADR; before changing either treatment, read that entry, because three sibling
 * cards on one page with two header treatments looks like a bug until the rule is known.
 *
 * WHAT WENT WITH IT, deliberately: the badge was the card's only home-currency figure and
 * its only "no exchange rate" caveat, and they left together. Every row below prints
 * `formatMinor(…, row.currency, { withCode: true })` — each row in ITS OWN currency, with
 * the ISO code — so nothing left on this card can be wrong about currency, and a surviving
 * warning would be a warning about a number that is no longer on screen (F54).
 *
 * `expenses.summaryOwn` STILL EXISTS AND HAS NO UI CALLER AT ALL — INTENDED, NOT ORPHANED.
 * Do not delete it as dead code. `/expenses` still builds its four stat tiles off
 * `list.data` (`ExpenseReportsList.tsx:347-373`), which is `take: 50`, so those tiles count
 * what fit rather than what exists — the exact defect `summaryOwn` was written to fix, on a
 * page that is still broken. Wiring it there needs a shape change (`groupBy: ['status',
 * 'currencyId']`) and is a separate piece of work; until then `landingAggregates.db.test.ts`
 * keeps the procedure compiling, asserted and permission-gated.
 */
export function MyExpenseReportsCard() {
  const t = useTranslations('dashboard.cards.expenses');
  const tCommon = useTranslations('common');
  /** One binding for the whole `expenses` namespace: the four column headers are the
   *  listing's own words, so the card and the page it links to cannot drift apart, and
   *  `statusBadgeProps` needs the same binding to resolve `status.*`. */
  const tExpenses = useTranslations('expenses');
  const locale = useLocale();
  const tableLabels = useTableLabels();

  /**
   * `useQuery()` with NO argument, deliberately — and it stays that way now that nothing
   * else on this page issues the query. `{ limit: PREVIEW_ROWS }` would fork the cache key
   * from the one `/expenses` uses: this card would fetch 5 rows, and the click through to
   * the listing would then fetch 50 more from cold, behind a loading state on a screen
   * that is warm today. That is 55 rows across two screens instead of 50, plus a round
   * trip and a spinner. The procedure orders by `updatedAt desc`, so the first five are
   * the five most recent whether the cap is 5 or 50.
   */
  const reports = trpc.expenses.list.useQuery();

  const rows = useMemo(() => (reports.data ?? []).slice(0, PREVIEW_ROWS), [reports.data]);

  const columns = useMemo<ColumnDef<(typeof rows)[number], ColumnId>[]>(
    () => [
      {
        id: 'report',
        label: tExpenses('columns.report'),
        defaultWidth: 260,
        hideable: false,
        cell: (row) => (
          <Link
            href={`/expenses/${row.id}`}
            className="flex min-w-0 flex-col hover:underline focus-visible:underline"
          >
            <span className="truncate font-semibold text-foreground text-sm">{row.title}</span>
            <span className="truncate text-muted-foreground text-xs">{row.number}</span>
          </Link>
        ),
      },
      {
        /** The ISO code, not the glyph: CAD and USD both print `$`, and a card that mixes
         *  two currencies under one symbol tells the reader nothing (F54). */
        id: 'total',
        label: tExpenses('columns.total'),
        defaultWidth: 140,
        cell: (row) => (
          <span className="text-foreground text-sm tabular-nums">
            {formatMinor(BigInt(row.totalMinor), row.currency, locale, { withCode: true })}
          </span>
        ),
      },
      {
        id: 'updated',
        label: tExpenses('columns.updated'),
        defaultWidth: 130,
        cell: (row) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {new Date(row.updatedAt).toLocaleDateString(locale, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        ),
      },
      {
        id: 'status',
        // Sized against the FR-CA header ("Statut") AND the longest FR-CA value
        // ("Remboursé"), not the EN one — the pill must not wrap in either locale.
        label: tExpenses('columns.status'),
        defaultWidth: 130,
        cell: (row) => <StatusBadge {...statusBadgeProps(row.status, tExpenses)} />,
      },
    ],
    [tExpenses, locale],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(COLUMN_ORDER.map((id) => ({ id })) as never, {}),
  );

  /**
   * ONE QUERY, ONE VERDICT — and dropping the second one improved both faces rather than
   * merely simplifying them. While the header badge read `expenses.summaryOwn`, `failed`
   * and `pending` were the OR of two independent requests: the skeleton stayed up until the
   * SLOWER of the two resolved, and an aggregate that failed on its own blanked a card
   * whose rows had arrived and were fine, replacing them with `panelUnavailable` and a
   * Retry. Now the rows are the whole card: the skeleton clears when the rows arrive, and
   * the card fails only when the thing it draws is missing.
   */
  const failed = reports.isError;
  const pending = reports.isPending;

  return (
    <SectionCard
      headingLevel={2}
      title={t('title')}
      loading={pending}
      loadingLabel={t('loading')}
      skeletonRows={PREVIEW_ROWS}
      error={
        failed
          ? {
              message: tCommon('panelUnavailable'),
              action: (
                <Button size="sm" variant="secondary" onClick={() => void reports.refetch()}>
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
            href="/expenses"
            className="block min-h-11 px-5 py-3 text-center font-medium text-primary text-sm hover:underline"
          >
            {t('viewAll')}
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <SectionEmpty
          icon={<IconReceiptOff size={36} className="text-muted-foreground" />}
          message={t('empty')}
          hint={t('emptyHint')}
        />
      ) : (
        <DataTable<(typeof rows)[number], ColumnId>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
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

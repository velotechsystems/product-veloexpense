'use client';

import { Badge, Button, SectionCard, SectionEmpty } from '@expenseos/design-system';
import { IconPlaneOff } from '@tabler/icons-react';
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
import { STATUS_VARIANT, travelBudgetMinor } from '../../travel/_shared';

/** How many rows the card draws. Five is a glance; the sixth is a listing. */
const PREVIEW_ROWS = 5;

/**
 * Four columns, and the fifth was cut on purpose: `listOwn` returns the READER'S OWN
 * requests, so a traveller column would print the same name in all five cells.
 *
 * THIS CONSTANT IS THE RENDERED COLUMN ORDER, AND IT IS THE ONLY THING THAT SETS IT — the
 * real `columns` array below is never handed to `createDataTableState`; `COLUMN_ORDER` is.
 * The two are kept in the same order regardless, and `MyTravelRequestsCard.test.tsx` now
 * asserts the rendered header order. That guard matters here as much as on the sibling
 * card: this order is the one `MyExpenseReportsCard` was reordered to MATCH — status last —
 * so a silent change here un-aligns two cards that stack on the same page.
 */
const COLUMN_ORDER = ['destination', 'dates', 'budget', 'status'] as const;
type ColumnId = (typeof COLUMN_ORDER)[number];

/** One row of `travelRequests.listOwn`. `/travel` names this same type `TravelRequestItem`
 *  and exports it from `TravelRequestDrawer.tsx`; this card infers its own instead, because
 *  importing from that module — even as a type — is the thing this file's docstring says it
 *  does not do, and a type-only import is one refactor away from a value one. */
type TravelRequest = inferRouterOutputs<AppRouter>['travelRequests']['listOwn']['items'][number];

/**
 * What a trip becomes below the compact breakpoint. Naming `title` here IS the opt-in:
 * `layout` stays `'auto'`, and `DataTable` reaches its card tree only because `mobile.title`
 * is set (`DataTable.tsx:159-160`).
 *
 * `/travel`'s `MOBILE_MINE` IS THE PRECEDENT AND THIS IS IT, MINUS ONE FIELD. Same title
 * (the destination, not the number — a phone list reading TRV-000041 / TRV-000042 is a list
 * of nothing), same badge (status, in a slot the gear menu cannot empty, still rendered as
 * the column's own `<Badge>` so it is text and not colour-only signalling, SC 1.4.1), same
 * first two fields. The third field is `number` over there and is absent here because THIS
 * CARD HAS NO `number` COLUMN: the number is the second line inside the destination cell,
 * so it is already on the card, carried by the title slot.
 *
 * `fields` IS INTERSECTED WITH `state.columnVisibility` at render, and on this route that
 * map is provably `{}` — see the sibling card's note for the mechanism. `dates` is pinned
 * anyway, and `budget` is not; the pin's reasoning is at the column.
 *
 * MODULE-LEVEL LITERAL, NOT AN INLINE OBJECT — `DataTableCards` memoises the intersection on
 * `mobile.fields` identity, and a config rebuilt per render defeats that memo.
 */
const MOBILE: DataTableMobileConfig<TravelRequest, ColumnId> = {
  title: 'destination',
  badge: 'status',
  fields: ['dates', 'budget'],
};

/**
 * "My travel requests" — the reader's five most recent trips, on the page they land on.
 *
 * SIBLING OF `MyExpenseReportsCard`, deliberately down to the prop list: bare `DataTable`
 * with `plainHeaders` / `sortMode="external"` / `disableInfiniteScroll`, no toolbar, no
 * filter pill bar, and NO `onRowClick` — `DataTable` puts that handler on a `<tr>` with no
 * `tabIndex`, no `onKeyDown` and no `role`, which is a WCAG 2.1.1 failure this card routes
 * around rather than fixes. The row's target is a real `<a>` in the primary cell, wrapping
 * BOTH lines so each row's link is named by its destination and its number instead of five
 * links all called "View". Read that file's docstring for the full account; it is not
 * repeated here.
 *
 * IT DOES NOT IMPORT `TravelRequestDrawer`. The drawer carries the travel module's whole
 * mutation graph — submit, approve, reprice, line editing — and the landing page must stay
 * cheap. Rows link to `/travel?request=<id>` and `/travel` opens the drawer; that link
 * works because `TravelRequests.tsx` reads the param, which it did not until this change.
 * The two constants it does take from the module are its CONTRACT, not its implementation:
 * a status→variant map and the rule for which figure is a trip's budget, both from
 * `travel/_shared.ts`, so this card and `/travel` cannot disagree about the colour of an
 * approved trip or about what one costs.
 *
 * THE MODULE GATE IS THE PAGE'S, NOT THIS COMPONENT'S. Every travel procedure sits behind
 * `moduleActive('travel')`, which THROWS `FORBIDDEN` rather than returning empty, so a card
 * mounted on a travel-off workspace would paint an error panel on the landing page. The
 * page mounts this only when `selectDashboardCards` says `showTravel`.
 *
 * THE HEADER CARRIES NO BADGE — NO COUNT, NO MONEY. It used to carry both, from
 * `travelRequests.summaryOwn`, including the word that said whether the figure was
 * *requested*, *approved* or a mixed *budget*. Removing that was asked for and confirmed
 * knowing what it said: the figure it qualified is gone with it, and every row below prints
 * `formatMinor(…, row.currency, { withCode: true })` — its OWN currency, with the ISO code
 * — so no claim is left on this card for a caveat to qualify (F54). `MyExpenseReportsCard`'s
 * docstring carries the full rule for the page, including why `ReportsToApproveCard` keeps
 * its badge when these two lost theirs (D8 in the dashboard ADR). Read it there rather than
 * assuming this card was simply missed.
 *
 * `travelRequests.summaryOwn` IS STILL LIVE and must not be deleted with the badge:
 * `TravelRequests.tsx:59` calls it for `/travel`'s own header and invalidates it at `:70`
 * after every mutation. Unlike `expenses.summaryOwn`, it never lost its caller — it only
 * lost this one.
 */
export function MyTravelRequestsCard() {
  const t = useTranslations('dashboard.cards.travel');
  const tCommon = useTranslations('common');
  /** One binding for the whole `travel` namespace: the column headings and the status
   *  labels are the listing's own words, so the card and the page it links to cannot
   *  drift apart. */
  const tTravel = useTranslations('travel');
  const locale = useLocale();
  const tableLabels = useTableLabels();

  /**
   * `useQuery()` with NO argument, matching `/travel`'s own call: navigating from a row to
   * the list then reuses this cache entry instead of refetching. The procedure orders by
   * `createdAt desc`, so the first five are the five most recent whether the cap is 5 or
   * the 500 the procedure applies.
   */
  const requests = trpc.travelRequests.listOwn.useQuery();

  const rows = useMemo(
    () => (requests.data?.items ?? []).slice(0, PREVIEW_ROWS),
    [requests.data?.items],
  );

  /**
   * Dates through `formatRange`, not two formatted dates with a dash between them.
   * `Intl` collapses the shared parts in the reader's own idiom ("1–4 Sept 2026", "1 au
   * 4 septembre 2026") and puts the separator where the locale puts it — a hand-built
   * `{a} – {b}` is both wider than the column and wrong in one of the two locales.
   *
   * UTC, matching how the server budgets the trip and how `/travel` renders it: a
   * departure rendered in the reader's zone shifts a day for anyone west of Greenwich,
   * and a trip that reads as starting a day early is a support ticket.
   */
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    [locale],
  );

  const columns = useMemo<ColumnDef<(typeof rows)[number], ColumnId>[]>(
    () => [
      {
        id: 'destination',
        label: tTravel('columns.destination'),
        defaultWidth: 240,
        hideable: false,
        cell: (row) => (
          <Link
            href={`/travel?request=${row.id}`}
            className="flex min-w-0 flex-col hover:underline focus-visible:underline"
          >
            <span className="truncate font-semibold text-foreground text-sm">
              {row.destinationLabel}
            </span>
            <span className="truncate text-muted-foreground text-xs">{row.number}</span>
          </Link>
        ),
      },
      {
        id: 'dates',
        label: tTravel('columns.dates'),
        defaultWidth: 170,
        /* FUTURE-TOOLBAR DEFENCE, INERT TODAY: nothing on this route can hide a column
           (`plainHeaders` switches the header menu off wholesale), so `columnVisibility`
           stays `{}` and this changes nothing now — but `dates` is a card FIELD, and the
           day a toolbar arrives a reader who tidied the desktop table would otherwise
           arrive on a phone to a card saying where a trip goes and never when. Matches
           `/travel`, which pins the same column for the same reason. `budget` is left
           hideable: it is the one of the two whose absence leaves the card unambiguous. */
        hideable: false,
        cell: (row) => (
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatTripDates(dateFmt, row.departDate, row.returnDate)}
          </span>
        ),
      },
      {
        /** The ISO code, not the glyph: CAD and USD both print `$`, and a card that can
         *  hold two currencies at once tells the reader nothing without it (F54). */
        id: 'budget',
        label: tTravel('columns.budget'),
        defaultWidth: 140,
        cell: (row) => (
          <span className="text-foreground text-sm tabular-nums">
            {formatMinor(travelBudgetMinor(row), row.currency, locale, { withCode: true })}
          </span>
        ),
      },
      {
        // Sized against the FR-CA header ("Statut") AND its longest value ("Brouillon"),
        // not the EN one — the pill must not wrap in either locale.
        id: 'status',
        label: tTravel('columns.status'),
        defaultWidth: 130,
        cell: (row) => (
          <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>
            {tTravel(`status.${row.status}` as 'status.DRAFT')}
          </Badge>
        ),
      },
    ],
    [tTravel, locale, dateFmt],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(COLUMN_ORDER.map((id) => ({ id })) as never, {}),
  );

  /**
   * ONE QUERY, ONE VERDICT — the same improvement the sibling card records, for the same
   * reason. While the header badge read `travelRequests.summaryOwn`, `failed` and `pending`
   * were the OR of two independent requests: the skeleton stayed up until the SLOWER of the
   * two resolved, and an aggregate failing on its own replaced a perfectly good set of rows
   * with `panelUnavailable` and a Retry. Now the rows are the whole card.
   */
  const failed = requests.isError;
  const pending = requests.isPending;

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
                <Button size="sm" variant="secondary" onClick={() => void requests.refetch()}>
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
            href="/travel"
            className="block min-h-11 px-5 py-3 text-center font-medium text-primary text-sm hover:underline"
          >
            {t('viewAll')}
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <SectionEmpty
          icon={<IconPlaneOff size={36} className="text-muted-foreground" />}
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

/**
 * A trip's dates, as one locale-formatted range.
 *
 * A request may be filed before its dates are settled, so either end can be missing:
 * with no departure there is nothing to say, and with no return the trip is a single
 * date rather than a range that runs to nowhere.
 */
function formatTripDates(
  fmt: Intl.DateTimeFormat,
  depart: Date | string | null,
  ret: Date | string | null,
): string {
  if (!depart) return '…';
  const from = new Date(depart);
  if (!ret) return fmt.format(from);
  return fmt.formatRange(from, new Date(ret));
}

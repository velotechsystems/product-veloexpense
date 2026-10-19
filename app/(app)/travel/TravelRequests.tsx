'use client';

/**
 * /travel — my trips, the ones waiting on me, and my team's.
 *
 * Same three-section shape as the card-request page, for the same reason: a request
 * you must act on and a request you are merely watching are different jobs, and one
 * undifferentiated table makes the reader do the sorting. A request renders in
 * exactly one section — anything actionable is dropped from oversight.
 */

import {
  Badge,
  Button,
  DataTableToolbar,
  FilterPillBar,
  TableSettingsButton,
} from '@expenseos/design-system';
import { IconPlus } from '@tabler/icons-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableMobileConfig,
  type DataTableState,
  TableExportMenu,
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import { displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useDeepLink } from '@/lib/useDeepLink';
import { setTopBarSlot } from '../TopBar';
import { STATUS_VARIANT, STATUSES, travelBudgetMinor } from './_shared';
import { NewTravelRequestDrawer } from './NewTravelRequestDrawer';
import { TravelRequestDrawer, type TravelRequestItem } from './TravelRequestDrawer';

type ColumnId = 'number' | 'traveller' | 'destination' | 'dates' | 'budget' | 'status';
type T = ReturnType<typeof useTranslations>;

/**
 * What a trip looks like on a phone — the card the three sections collapse to
 * below `md`. This is the opt-in: `layout` stays `'auto'`, and `DataTable`
 * reaches its card tree ONLY because `mobile.title` is named here.
 *
 * WHY THE DESTINATION IS THE TITLE, and not the number the table puts first.
 * The title is the card's accessible name and its only navigation affordance,
 * so it has to be the string a person uses to recognise the row. "Lisbon,
 * Portugal" is that string; "TRV-000042" is a lookup key, and a phone list
 * titled TRV-000041 / TRV-000042 / TRV-000043 is a list of nothing. The
 * number is not lost — it is the last field row, where a reader quoting it to
 * finance still finds it, and it cannot be hidden away because its column is
 * `hideable: false`.
 *
 * WHY STATUS IS `badge` AND NOT A FIELD. `fields` is intersected with the
 * reader's live `columnVisibility` at render; `title` and `badge` ignore it.
 * Status is the thing most readers open this page FOR, so it goes in a slot
 * the gear menu cannot empty. The badge also keeps the column's own `<Badge>`
 * renderer — text, not a coloured dot — so it does not become colour-only
 * signalling (SC 1.4.1).
 *
 * The three field rows are ordered the way a trip is triaged: when, how much,
 * and only then which one. Every one of the six columns lands somewhere, so
 * nothing is dropped on the way to the card.
 *
 * AND TWO OF THE THREE CANNOT BE EMPTIED BY THAT INTERSECTION. `dates` joins
 * `number` as `hideable: false` at the column, so a reader who tidied the
 * desktop table cannot arrive on a phone to a card that says where a trip goes
 * and never when. `budget` stays hideable: it is the one of the three whose
 * absence leaves the card unambiguous.
 */
const MOBILE_MINE: DataTableMobileConfig<TravelRequestItem, ColumnId> = {
  title: 'destination',
  badge: 'status',
  fields: ['dates', 'budget', 'number'],
};

/**
 * The same card with the traveller on it, for the two sections that are about
 * somebody else's trip.
 *
 * Spread rather than a second literal, deliberately: an approver's card and a
 * traveller's card differ by exactly one line, and two independent literals is
 * how they stop differing by exactly one line a year from now.
 *
 * The traveller is the `subtitle` — the slot whose doc comment names
 * "submitter" as its example — rather than a fourth field. Two reasons. It
 * keeps `fields` at the three the type's comment asks for without evicting
 * the dates, the budget or the number; and a name reads as an attribution
 * under the destination, whereas as a `<dt>/<dd>` pair it would be one more
 * labelled row competing with the money.
 *
 * `subtitle` IS INTERSECTED WITH `columnVisibility` TOO (`DataTableCards.tsx:241`),
 * exactly as `fields` is — the slot is not a way around the gear menu. That is
 * why the `traveller` COLUMN is `hideable: false`: without it, a reader who hid
 * the traveller on the desktop table would get an approvals queue of trips with
 * nobody attached to them. Note this is a different claim from the one the card
 * config itself makes: `MOBILE_MINE` OMITS the traveller because on the
 * submitter's own list the name is the same on every row, and that stays true.
 * Pinning the column decides whether the slot CAN be filled; the config decides
 * whether it IS.
 */
const MOBILE_WITH_TRAVELLER: DataTableMobileConfig<TravelRequestItem, ColumnId> = {
  ...MOBILE_MINE,
  subtitle: 'traveller',
};

export function TravelRequests() {
  const t = useTranslations('travel');
  const locale = useLocale();
  const utils = trpc.useUtils();

  const mine = trpc.travelRequests.listOwn.useQuery();
  /**
   * The "my trips" header count, read from a server aggregate rather than from
   * `mine.data.items.length`.
   *
   * `listOwn` is capped at 500 rows now (it was unbounded, which is how counting its
   * array happened to be truthful). A count taken from a capped array reports what fit,
   * not what exists — so the number comes from the aggregate, which counts in Postgres
   * and never materialises a row. For a traveller under the cap nothing changes; past
   * it, the header is right for the first time.
   */
  const mineSummary = trpc.travelRequests.summaryOwn.useQuery();
  const myTasks = trpc.travelRequests.myTasks.useQuery();
  const oversight = trpc.travelRequests.listOversight.useQuery();

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<{ request: TravelRequestItem; taskId?: string } | null>(
    null,
  );

  const invalidateAll = () => {
    utils.travelRequests.listOwn.invalidate();
    utils.travelRequests.summaryOwn.invalidate();
    utils.travelRequests.myTasks.invalidate();
    utils.travelRequests.listOversight.invalidate();
  };

  /**
   * The `right` slot — ONE element, whose LABEL is what changes at `lg`, not the control.
   *
   * This is `DelegationsManager.tsx:200-270`'s shape, applied here because this route is
   * the same problem one size worse. `TopBar.tsx`'s ration on the slot is at most one
   * icon-only control; a text label is over it. At 360px the route title and this slot
   * share 238px of a 328px header content box, and nothing in the top bar clips — so the
   * failure is not truncation, it is this row laying out at its full width and painting
   * over the title. Both halves are longer here than on `/delegations`:
   *
   *   route              title (FR-CA)          button (FR-CA)
   *   /delegations       Délégations (11)       Nouvelle délégation (19)     -> overflowed
   *   /travel            Demandes de voyage (18) Nouvelle demande de voyage (26)
   *
   * `max-lg:sr-only` on the label, not `sr-only lg:not-sr-only`: `not-sr-only` sets
   * `white-space: normal` and would let the desktop label wrap where the Button base's
   * `whitespace-nowrap` says it cannot. The label stays in the accessibility tree at every
   * width, so the control never becomes an unlabelled icon in either locale and its
   * accessible name does not change with the viewport.
   *
   * ONE ELEMENT. NEVER TWO BRANCHES. A labelled button `max-lg:hidden` beside an icon
   * button `lg:hidden` puts BOTH in the accessibility tree under jsdom, which loads no
   * stylesheet. On `/delegations` that shape is caught by a singular `getByRole` in the
   * page's own suite. HERE IT IS CAUGHT BY "the control the top bar publishes" in
   * `TravelRequests.test.tsx`. Both page suites `vi.mock('../TopBar')`, so this JSX is never
   * mounted by the page under test — but the mock is a `vi.fn()` and a `vi.fn()` RECORDS its
   * arguments, so the suite takes the `right` slot back out of the recorded calls and renders
   * that element on its own. The assertions are `/delegations`' three
   * (`DelegationsManager.test.tsx:414`, `:450`, `:465`): exactly one published control,
   * `max-lg:sr-only` on a label element inside it, and the square below-`lg` box carrying
   * exactly one slop class.
   *
   * The slop class comes from the cva (`size="sm"` carries `einc-tap-slop`) and is
   * deliberately absent from `className`: `cn`/`twMerge` has no conflict map for the
   * hand-written slop classes, so adding `-both` here would not replace the cva's one —
   * both would survive and source order in `globals.css` would decide the hit box.
   * Vertical-only is also the right axis: this lands beside `NotificationBell`'s
   * `-both` trigger in a `gap-1.5` zone, and two controls each reaching 6px into a 6px
   * gutter overlap. It ships 32 x 44, the same as every other `icon-sm`-class call site.
   *
   * `max-lg:mr-0` on the glyph because an `sr-only` label is `position: absolute` and so
   * not a flex item — the 6px `mr-1.5` that spaces the pair on desktop would otherwise
   * push the glyph off-centre in a 32px box.
   */
  useEffect(() => {
    setTopBarSlot(
      'right',
      <Button
        size="sm"
        onClick={() => setCreating(true)}
        className="max-lg:h-8 max-lg:w-8 max-lg:px-0"
      >
        <IconPlus size={15} className="mr-1.5 max-lg:mr-0" />
        <span className="max-lg:sr-only">{t('new')}</span>
      </Button>,
    );
    return () => setTopBarSlot('right', null);
  }, [t]);

  const taskItems = (myTasks.data?.items ?? []).filter(
    (it): it is { taskId: string; label: string; request: TravelRequestItem } => it.request != null,
  );
  const queueRows = taskItems.map((it) => it.request);
  const taskByRequestId = new Map(taskItems.map((it) => [it.request.id, it.taskId]));

  // A request I must act on belongs in the queue, not in oversight. Rendering it in
  // both would double every count on the page.
  const oversightRows = (oversight.data?.items ?? []).filter((r) => !taskByRequestId.has(r.id));

  /**
   * `/travel?request=<id>&n=<nonce>` — opening the trip a notification is about, and
   * the target of every row on the dashboard's travel card.
   *
   * THIS PAGE USED NOT TO READ ANY PARAM, and `subjectLinks.ts` recorded that in
   * writing as the reason travel notifications carried no id: a query string nothing
   * reads is a link that promises to open the trip and lands on the list. Both halves
   * changed together — the entry there and the hook here — because either one alone is
   * the broken state the note was warning about.
   *
   * `{ uuid: true }` IS THE GUARD, and a malformed id reads as ABSENT: the page renders
   * its three sections and opens nothing, exactly as if no link had been followed. No
   * distinct "bad id" face, and no distinct "not yours" face either — a request this
   * reader cannot see is simply not in any of the three lists below, so an id belonging
   * to somebody else's trip is indistinguishable from one that never existed. That is
   * the point: telling the two apart would confirm the record exists to someone who
   * cannot read it.
   *
   * IT MATCHES AGAINST THE LOADED LISTS ONLY — no by-id fetch. Those three queries are
   * exactly the set of requests this reader may open (own, awaiting my decision, my
   * team's and my past decisions), which is the same reach the detail page allows, so a
   * fetch could only ever answer FORBIDDEN for anything they miss. Not asking is both
   * cheaper and quieter than asking and swallowing the answer.
   */
  const deepLink = useDeepLink('request', { uuid: true });
  const deepId = deepLink.id;
  const openKey = deepLink.key;
  // Resolved during render, not inside the effect, so the effect depends on VALUES
  // rather than on a `.find` over three arrays that are rebuilt every render.
  const deepHit =
    deepId != null
      ? ([...(mine.data?.items ?? []), ...queueRows, ...oversightRows].find(
          (r) => r.id === deepId,
        ) ?? null)
      : null;
  const deepTaskId = deepHit ? taskByRequestId.get(deepHit.id) : undefined;

  useEffect(() => {
    // `wasSeen` is keyed on (id, nonce), so a refetch re-render does not reopen a drawer
    // the reader just closed, while a SECOND notification about the same trip does.
    if (!deepId || !openKey || !deepHit || deepLink.wasSeen(openKey)) return;
    deepLink.markSeen(openKey);
    deepLink.clear();
    setSelected({ request: deepHit, taskId: deepTaskId });
  }, [deepId, openKey, deepHit, deepTaskId, deepLink]);

  // The drawer holds a row captured at click time; re-read it from the live queries
  // so an action taken inside it (quote, reprice) is reflected without reopening.
  const selectedLive = selected
    ? ([...(mine.data?.items ?? []), ...queueRows, ...oversightRows].find(
        (r) => r.id === selected.request.id,
      ) ?? selected.request)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('sections.mine')} count={mineSummary.data?.count}>
        <RequestTable
          t={t}
          locale={locale}
          rows={mine.data?.items ?? []}
          loading={mine.isLoading}
          emptyText={t('empty')}
          mobile={MOBILE_MINE}
          onRowClick={(r) => setSelected({ request: r })}
        />
      </Section>

      <Section title={t('sections.approvals')} count={queueRows.length}>
        <RequestTable
          t={t}
          locale={locale}
          rows={queueRows}
          loading={myTasks.isLoading}
          emptyText={t('emptyApprovals')}
          showTraveller
          mobile={MOBILE_WITH_TRAVELLER}
          onRowClick={(r) => setSelected({ request: r, taskId: taskByRequestId.get(r.id) })}
        />
      </Section>

      {oversightRows.length > 0 && (
        <Section title={t('sections.oversight')} count={oversightRows.length}>
          <RequestTable
            t={t}
            locale={locale}
            rows={oversightRows}
            loading={oversight.isLoading}
            emptyText={t('emptyOversight')}
            showTraveller
            mobile={MOBILE_WITH_TRAVELLER}
            onRowClick={(r) => setSelected({ request: r })}
          />
        </Section>
      )}

      {creating && (
        <NewTravelRequestDrawer onClose={() => setCreating(false)} onCreated={invalidateAll} />
      )}
      {selectedLive && (
        <TravelRequestDrawer
          request={selectedLive}
          taskId={selected?.taskId}
          onClose={() => setSelected(null)}
          onChanged={invalidateAll}
        />
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  /** Kept for the section header even though the toolbar reports one too: the header
   *  count is for a collapsed glance at three sections, the toolbar's is for the
   *  filtered set inside one of them, and they legitimately differ once a pill is on —
   *  and, for "my trips", whenever the caller has more requests than `listOwn` returns,
   *  because this one is the server's count of the whole set. */
  count?: number;
  children: React.ReactNode;
}) {
  const toolbarLabels = useToolbarLabels();
  return (
    // `shrink-0` is load-bearing: as a flex-column child a section would otherwise
    // be squeezed to fit the viewport, and `overflow-hidden` then clips its table to
    // nothing.
    <div className="flex shrink-0 flex-col overflow-hidden rounded-md border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-border border-b px-4 py-2.5">
        <h2 className="font-medium text-foreground text-sm">{title}</h2>
        {count !== undefined && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {toolbarLabels.resultLabel(count)}
          </span>
        )}
      </div>
      <div className="flex max-h-[60vh] min-h-0 flex-col">{children}</div>
    </div>
  );
}

function RequestTable({
  t,
  locale,
  rows,
  loading,
  emptyText,
  showTraveller,
  mobile,
  onRowClick,
}: {
  t: T;
  locale: string;
  rows: TravelRequestItem[];
  loading: boolean;
  emptyText: string;
  showTraveller?: boolean;
  /** The card this section collapses to below `md`. Required, with no default,
   *  because the two shapes are not interchangeable — a section that names
   *  somebody else's trip has to say whose, and a default would let a new
   *  section ship the wrong one silently. */
  mobile: DataTableMobileConfig<TravelRequestItem, ColumnId>;
  onRowClick: (r: TravelRequestItem) => void;
}) {
  const tableLabels = useTableLabels();
  const toolbarLabels = useToolbarLabels();

  const columns = useMemo<ColumnDef<TravelRequestItem, ColumnId>[]>(() => {
    // UTC, matching how the server budgets the trip: rendering a departure in the
    // reader's zone shifts it a day for anyone west of Greenwich, and a trip that
    // reads as starting a day earlier than it was approved for is a support ticket.
    const fmt = (d: string | Date | null) =>
      d ? new Date(d).toLocaleDateString(locale, { timeZone: 'UTC' }) : '…';

    const cols: ColumnDef<TravelRequestItem, ColumnId>[] = [
      {
        id: 'number',
        label: t('columns.number'),
        defaultWidth: 120,
        hideable: false,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-foreground tabular-nums">{r.number}</span>,
      },
    ];
    if (showTraveller) {
      cols.push({
        id: 'traveller',
        label: t('columns.traveller'),
        defaultWidth: 160,
        /**
         * PINNED FOR THE PHONE CARD, NOT FOR THE DESKTOP TABLE, and it costs the desktop
         * table a capability on purpose. `DataTableCards` intersects `subtitle` with the
         * reader's live `columnVisibility` exactly as it does `fields`
         * (`DataTableCards.tsx:241`, `:265`), so hiding this column on the desktop table
         * would take the traveller's name off the approval cards too — leaving an approver a
         * queue of trips with no one attached to them, which is the one thing
         * `MOBILE_WITH_TRAVELLER` exists to put there.
         */
        hideable: false,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-foreground">{displayName(r.submitter)}</span>,
      });
    }
    cols.push(
      {
        id: 'destination',
        label: t('columns.destination'),
        defaultWidth: 240,
        filterable: { kind: 'text' },
        cell: (r) => <span className="text-foreground">{r.destinationLabel}</span>,
      },
      {
        id: 'dates',
        label: t('columns.dates'),
        defaultWidth: 180,
        /** Pinned for the same reason as `traveller`: it is a card FIELD, and `fields` is
         *  intersected with `columnVisibility` (`DataTableCards.tsx:265`), so hiding the
         *  column on the desktop table would leave a phone card that says where a trip goes
         *  and never when. `budget` is deliberately left hideable — it is the one of the
         *  three a reader can lose without the card becoming ambiguous. */
        hideable: false,
        cell: (r) => (
          <span className="text-muted-foreground text-xs">
            {fmt(r.departDate)} – {fmt(r.returnDate)}
          </span>
        ),
      },
      {
        id: 'budget',
        label: t('columns.budget'),
        defaultWidth: 140,
        sortable: true,
        cell: (r) => (
          <span className="block text-right text-foreground tabular-nums">
            {formatMinor(Number(travelBudgetMinor(r)), r.currency, locale)}
          </span>
        ),
        exportValue: (r) => Number(travelBudgetMinor(r)) / 100,
      },
      {
        id: 'status',
        label: t('columns.status'),
        defaultWidth: 140,
        filterable: {
          kind: 'enum',
          options: STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
        },
        cell: (r) => (
          <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{t(`status.${r.status}`)}</Badge>
        ),
      },
    );
    return cols;
  }, [t, locale, showTraveller]);

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );
  const pillBar = useFilterPillBarWiring<TravelRequestItem, ColumnId>(
    columns,
    tableState,
    setTableState,
  );

  // Client-side: these are one user's rows, not a corpus.
  const filteredRows = useMemo(() => {
    let out = rows;
    const text = (field: ColumnId, get: (r: TravelRequestItem) => string) => {
      for (const c of tableState.filters.filter((f) => f.field === field)) {
        const v = c.value.toLowerCase();
        const g = (r: TravelRequestItem) => get(r).toLowerCase();
        if (c.op === 'contains') out = out.filter((r) => g(r).includes(v));
        else if (c.op === 'doesNotContain') out = out.filter((r) => !g(r).includes(v));
        else if (c.op === 'equals') out = out.filter((r) => g(r) === v);
        else if (c.op === 'doesNotEqual') out = out.filter((r) => g(r) !== v);
        else if (c.op === 'startsWith') out = out.filter((r) => g(r).startsWith(v));
        else if (c.op === 'endsWith') out = out.filter((r) => g(r).endsWith(v));
      }
    };
    text('number', (r) => r.number);
    text('traveller', (r) => displayName(r.submitter));
    text('destination', (r) => r.destinationLabel);
    for (const c of tableState.filters.filter((f) => f.field === 'status')) {
      if (c.op === 'equals') out = out.filter((r) => r.status === c.value);
      else if (c.op === 'doesNotEqual') out = out.filter((r) => r.status !== c.value);
    }
    const sort = tableState.sort;
    if (sort?.field === 'budget') {
      out = [...out].sort((a, b) => {
        const x = travelBudgetMinor(a);
        const y = travelBudgetMinor(b);
        const d = x < y ? -1 : x > y ? 1 : 0;
        return sort.dir === 'desc' ? -d : d;
      });
    }
    return out;
  }, [rows, tableState.filters, tableState.sort]);

  const resetTable = () =>
    setTableState((s) => ({
      ...s,
      columnOrder: columns.map((c) => c.id),
      columnVisibility: {},
      columnWidths: {},
      density: 'normal',
    }));

  return (
    <>
      <div className="border-border border-b">
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
      {/**
       * The toolbar `docs/design/listing-standard.md` requires, and which this page has
       * never had — no column settings, no density, no export, despite `exportValue`
       * already being declared on the budget column. The conformance table listed every
       * other managed listing as conforming; this one was simply missed.
       */}
      <DataTableToolbar
        {...toolbarLabels}
        resultCount={filteredRows.length}
        loading={loading}
        rightSlot={
          <>
            <TableExportMenu<TravelRequestItem, ColumnId>
              columns={columns}
              rows={filteredRows}
              state={tableState}
              filename="travel-requests"
            />
            <TableSettingsButton<ColumnId, string>
              columnOrder={columns.map((c) => c.id)}
              columnVisibility={tableState.columnVisibility as Record<ColumnId, boolean>}
              onVisibilityChange={(v) => setTableState((s) => ({ ...s, columnVisibility: v }))}
              columnLabelFor={(c) => columns.find((col) => col.id === c)?.label ?? c}
              density={tableState.density}
              onDensityChange={(d) => setTableState((s) => ({ ...s, density: d }))}
              onReset={resetTable}
              labels={tableLabels.settings}
            />
          </>
        }
      />

      {/* Orders its own rows — the table must not re-sort them. */}
      <DataTable<TravelRequestItem, ColumnId>
        sortMode="external"
        columns={columns}
        rows={filteredRows}
        rowKey={(r) => r.id}
        mobile={mobile}
        loading={loading}
        totalCount={filteredRows.length}
        state={tableState}
        onStateChange={setTableState}
        onRowClick={onRowClick}
        labels={tableLabels}
        disableInfiniteScroll
        renderEmpty={() => <span className="text-muted-foreground text-sm">{emptyText}</span>}
      />
    </>
  );
}

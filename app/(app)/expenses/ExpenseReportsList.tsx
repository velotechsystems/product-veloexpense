'use client';

/**
 * /expenses — the employee's expense-report list, wired to `expenses.list`.
 * One row per report with a status filter, search, and a stat-card summary.
 * Clicking a row (or "View") opens the detail/editor drawer. "New report"
 * opens a small dialog to name the report + pick its currency, then opens the
 * drawer. Mirrors the VirtualCardsList pattern.
 */
import {
  Alert,
  AlertDescription,
  Button,
  CARDS_ONLY,
  Combobox,
  cls,
  DataTableToolbar,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FilterPillBar,
  Input,
  type RowAction,
  RowActionsMenu,
  StatCard,
  StatusBadge,
  TABLE_ONLY,
  TableSettingsButton,
  useIsCompact,
} from '@expenseos/design-system';
import {
  IconCamera,
  IconEye,
  IconPaperclip,
  IconPlus,
  IconReceipt,
  IconTrash,
} from '@tabler/icons-react';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFilterPillBarWiring } from '@/components/admin/useFilterPillBarWiring';
import { ReceiptFileInput } from '@/components/attachments/ReceiptFileInput';
import {
  FilterSheet,
  SortSheet,
  TableExportMenu,
  useSortSheetLabels,
  useTableLabels,
  useToolbarLabels,
} from '@/components/data-view';
import {
  type ColumnDef,
  createDataTableState,
  DataTable,
  type DataTableMobileConfig,
  type DataTableState,
  sortSheetOptions,
} from '@/components/data-view/DataTable';
import { useRouter } from '@/i18n/navigation';
import { displayName, formatMinor } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';
import { useRefusalText } from '@/lib/trpc/refusal';
import { useCoarsePointer } from '@/lib/useCoarsePointer';
import { useDeepLink } from '@/lib/useDeepLink';
import type { AppRouter } from '@/server/routers/_app';
import { setTopBarSlot } from '../TopBar';
import { localeLabel, REPORT_STATUSES, statusBadgeProps } from './_shared';

type ReportRow = inferRouterOutputs<AppRouter>['expenses']['list'][number];
type ColumnId = 'report' | 'status' | 'expenses' | 'total' | 'updated';

/**
 * The reports-list picker chip — today's treatment, character for character.
 *
 * At a fine pointer this is the whole treatment and nothing below it is used:
 * one bordered chip reading "Upload receipt", exactly as this row has always
 * carried it.
 */
const UPLOAD_CHIP =
  'inline-flex cursor-pointer items-center gap-1 rounded-md border border-input px-2.5 py-1.5 font-medium text-sm hover:bg-muted';

/**
 * One control of the coarse-pointer pair: a 32px square holding a 20px icon and
 * no text.
 *
 * ICON-ONLY HERE IS ARITHMETIC, NOT TASTE. At 360px the header's `px-4` leaves
 * 328px, and this row already carries a ~133px "Upload receipt" chip plus a
 * ~125px "New report" button against roughly 200px of page box — which is the
 * overflow `TopBar.tsx:263-330` documents at length and hands to its own
 * ticket. Two labelled chips would make that worse; two 32px squares plus
 * `gap-3` is ~76px against today's ~133px, so the pair leaves this row about
 * 57px NARROWER than it found it, and that holds in FR-CA where "Téléverser un
 * reçu" is the wider string.
 *
 * 32px rather than 44px, and `hitSlop` is left at its default `true` in
 * consequence. The zone is a fixed `h-8` and these squares align against the
 * shell's own 32px bell, so a real 44px box would overflow 6px into the
 * header's `pt-[14px]`/`pb-3` — nothing clips there, by design — and would
 * still sit visibly taller than the bell beside it. The 44px target comes from
 * `ReceiptFileInput`'s invisible ring instead, which grows the tap area without
 * moving anything painted. The ring is declared at 7px and reaches 6px past the
 * paint, and the difference is THIS element's `border`: the `::after` insets
 * from the padding box, so the square below is 30px to the ring and 32px to the
 * eye. Change the border here and the ring stops spanning 44 — the derivation
 * is on `RECEIPT_HIT_SLOP`.
 *
 * Buying the 44 with a ring rather than with a real box is the opposite call
 * from the other three, and this is the only site that makes it: sites 2 and
 * 3's rows are not
 * height-constrained, and site 4's `h-12` bar has room for a 44px box inside
 * 48px, so all three take a real `pointer-coarse:min-h-11` resize and pass
 * `hitSlop={false}`. A fixed row height is not what decides it — whether 44px
 * fits is.
 *
 * `gap-1`, `px-2.5 py-1.5`, `font-medium` and `text-sm` all come off: Tailwind's
 * `sr-only` is absolutely positioned and so contributes nothing to a flex gap,
 * the square replaces the padding, and there is no visible text left to weight
 * or to size. `justify-center` goes on because a 20px icon in a 32px box has to
 * be told to centre. So does `shrink-0`, and that one is load-bearing rather
 * than tidy: the width arithmetic above is only true of a square that cannot be
 * compressed, and the top bar's page box is the zone's designated `min-w-0`
 * yielder — without it a 32px box is free to squeeze and clip its own icon at
 * exactly the width the pair was sized for.
 */
const UPLOAD_CHIP_ICON =
  'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input hover:bg-muted';

/**
 * Both controls of the pair, while an upload runs. Coarse pointer only — see
 * `captureBusy` below for why.
 *
 * `disabled` on the inputs stops being sufficient the moment there are two: a
 * person who taps the one they did NOT start the upload with gets silence and
 * nothing to explain it. `pointer-events-none` is what swallows that tap and
 * `opacity-50` is what explains it; `aria-disabled` on the label says the same
 * thing to a screen reader, and both accessible names relabel to the drawer's
 * existing "Uploading…" rather than translating the word again. No spinner —
 * this codebase has no `animate-spin` and no `prefers-reduced-motion` handling
 * anywhere, so motion here would open an obligation P04 has no business paying.
 */
const UPLOAD_CHIP_ICON_BUSY = `${UPLOAD_CHIP_ICON} pointer-events-none opacity-50`;

/**
 * Site 1 of P04's four receipt-upload entry points, and the only one published
 * into shared chrome rather than rendered in place.
 *
 * WHY THIS IS A COMPONENT AND NOT JSX INLINED IN THE EFFECT BELOW — the one
 * structural point of this adoption. That effect does not render the slot, it
 * HANDS an element to the top bar, so anything the effect reads is frozen into
 * that element at publish time and refreshed only when the effect's
 * dependencies change. Reading the pointer in `ExpenseReportsList`'s own body
 * would therefore have to add that boolean to the dependency array, and it
 * would still be a snapshot: the element the top bar holds would keep the
 * pointer answer it was built with while the device changed underneath it, and
 * the test helper that pulls the last published element out of the
 * `setTopBarSlot` mock and renders it in isolation could never exercise the
 * coarse branch at all, because the branch would have been decided before that
 * test's stub existed.
 *
 * So every pointer read at this site happens INSIDE the element that gets
 * mounted — here, and in `ReceiptFileInput`. The effect's dependency array
 * stays `[t, canCreate, uploadBusy, uploadReceipts]`, which is exactly the four
 * values it closes over, and the pointer is answered afresh on every render of
 * the mounted slot, wherever it is mounted.
 *
 * `useTranslations` is called here rather than the page's `t` being passed down
 * as a prop, for the same reason `ReceiptFileInput` takes resolved strings:
 * `packages/i18n/scripts/check-used-keys.mjs` collects literal keys per
 * translator binding in the file and deliberately skips a translator that
 * arrives as an argument, so a prop would drop these three keys out of the CI
 * coverage gate. Its own binding keeps them in.
 */
function TopBarReceiptUpload({
  busy,
  onFiles,
}: {
  busy: boolean;
  onFiles: (files: FileList) => void;
}) {
  const t = useTranslations('expenses');
  const coarsePointer = useCoarsePointer();
  /**
   * An upload is running AND there are two controls to silence.
   *
   * Gated on the pointer rather than on `busy` alone, which is the whole point:
   * at a fine pointer the busy state stays exactly what it has always been —
   * `disabled` on the one input and the label untouched. The dimming and the
   * relabel exist to answer "why did nothing happen when I tapped the other
   * one", and on a desktop there is no other one.
   */
  const captureBusy = coarsePointer && busy;
  /** One icon-only control's classes — the same for the camera and the picker. */
  const iconChip = captureBusy ? UPLOAD_CHIP_ICON_BUSY : UPLOAD_CHIP_ICON;
  return (
    <ReceiptFileInput
      /**
       * Multi-file, and it stays. This entry point turns ONE batch into one
       * report holding one expense per file, which is the whole shape of
       * receipt-first entry; the camera never carries the attribute, because
       * `capture="environment"` returns a single image per invocation whatever
       * `multiple` says.
       */
      multiple
      disabled={busy}
      className={coarsePointer ? iconChip : UPLOAD_CHIP}
      aria-disabled={captureBusy || undefined}
      camera={{
        className: iconChip,
        'aria-disabled': captureBusy || undefined,
        children: (
          <>
            <IconCamera size={20} aria-hidden="true" />
            {/*
              The control's accessible name, and the only place it comes from:
              one string, one translation, and voice control ("tap Take photo")
              matches what a sighted user is told the icon means. NOT
              `aria-label` — on a `<label>` element it does nothing useful, and
              on the input it would shadow the visible text at the two labelled
              sites.
            */}
            <span className="sr-only">
              {captureBusy ? t('drawer.uploading') : t('capture.takePhoto')}
            </span>
          </>
        ),
      }}
      /**
       * `uploadReceipts` copies the list with `Array.from` before its first
       * `await`, which it has to: the primitive resets the input's value
       * straight after this returns and that empties the very `FileList` handed
       * over here.
       */
      onFiles={onFiles}
    >
      {coarsePointer ? (
        <>
          <IconPaperclip size={20} aria-hidden="true" />
          <span className="sr-only">
            {captureBusy ? t('drawer.uploading') : t('capture.chooseFile')}
          </span>
        </>
      ) : (
        /**
         * A desktop keeps the labelled chip it has always had, wording
         * included. "Choose file" arrives only once the camera is beside it, so
         * that the pair reads as two SOURCES rather than one source and one
         * outcome — a lone control is not a choice between sources, and that
         * wording alone would be answering a question nobody asked.
         */
        <>
          <IconPaperclip size={14} />
          {t('list.uploadReceipt')}
        </>
      )}
    </ReceiptFileInput>
  );
}

export function ExpenseReportsList({
  canCreate,
  canDelete,
}: {
  canCreate: boolean;
  canDelete: boolean;
}) {
  const toolbarLabels = useToolbarLabels();
  const t = useTranslations('expenses');
  const tableLabels = useTableLabels();
  /**
   * Copy for the mobile sort sheet, from the catalog.
   *
   * `<SortSheet>` and `<FilterSheet>` both default every string to English
   * inside the design system, and those defaults are literals the
   * `check-used-keys` gate cannot see — not being catalog keys, there is
   * nothing for it to look for. That is the exact blind spot that shipped the
   * filter-pill chrome in English to French readers (GA readiness F43). So
   * both bags are passed explicitly here, and
   * `ExpenseReportsList.test.tsx` fails if either sheet falls back.
   */
  const sortSheetLabels = useSortSheetLabels();
  /** Which tree `<DataTable>` will mount. The sheets are the card tree's sort
   *  and filter affordances, so they are mounted on the same answer rather
   *  than on a second, possibly-disagreeing media query. */
  const compact = useIsCompact();
  const locale = useLocale();
  /**
   * The LOCALE-AWARE router (`@/i18n/navigation`), not `next/navigation`.
   *
   * Every `router.push` below is written unprefixed (`/expenses/<id>`), and
   * `routing.ts` sets `localeDetection: false` — so a bare push is not resolved
   * back to the locale the reader is in by any cookie or header; the middleware
   * sends it to `defaultLocale`. A reader on `/fr-CA/expenses` who opened a
   * report, followed a `?report=` deep link, or uploaded a receipt was dropped
   * onto `/en/expenses/<id>` and silently lost French mid-flow.
   */
  const router = useRouter();
  const utils = trpc.useUtils();

  const list = trpc.expenses.list.useQuery();
  const reports = useMemo(() => list.data ?? [], [list.data]);
  const [creating, setCreating] = useState(false);

  const openReport = useCallback((id: string) => router.push(`/expenses/${id}`), [router]);

  // Deep-link: a notification links here with `?report=<id>`. Navigate straight
  // to that report's workbench.
  const reportLink = useDeepLink('report');
  useEffect(() => {
    if (!reportLink.id || !reportLink.key || reportLink.wasSeen(reportLink.key)) return;
    reportLink.markSeen(reportLink.key);
    router.push(`/expenses/${reportLink.id}`);
  }, [reportLink, router]);

  const remove = trpc.expenses.deleteReport.useMutation({
    onSuccess: () => utils.expenses.list.invalidate(),
  });

  const deleteReport = useCallback((id: string) => remove.mutate({ reportId: id }), [remove]);

  // Receipt-first entry: one upload batch becomes one "Untitled report" holding
  // one expense per file, each with its receipt filed and queued for extraction.
  // Upload again and you get another report — so the user separates them by
  // uploading separately, rather than the system guessing what belongs together.
  const startFromReceipts = trpc.expenses.startFromReceipts.useMutation();
  const uploadUrl = trpc.expenses.receiptUploadUrl.useMutation();
  const receiptCreate = trpc.expenses.receiptCreate.useMutation();
  const startExtraction = trpc.expenses.startExtraction.useMutation();
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const refusalText = useRefusalText();
  const uploadReceipts = useCallback(
    async (files: FileList) => {
      setUploadBusy(true);
      setUploadError(null);
      const list = Array.from(files);
      try {
        // One call: the report and all its expenses, with the title localized
        // here and the currency defaulting to the submitter's home currency.
        const { reportId, expenseIds } = await startFromReceipts.mutateAsync({
          count: list.length,
          title: t('list.untitledReport'),
        });

        // Upload each file against its own expense. A single failure doesn't
        // abandon the rest — the report exists either way, and an expense whose
        // upload failed is visible and re-uploadable in the workbench.
        const receiptIds: string[] = [];
        let failed = 0;
        for (const [i, file] of list.entries()) {
          const expenseId = expenseIds[i];
          if (!expenseId) break;
          try {
            const contentType = file.type || 'application/octet-stream';
            const { url, headers, key } = await uploadUrl.mutateAsync({
              expenseId,
              filename: file.name,
              contentType,
              // The link is bound to this exact length, so it must be the body PUT below.
              sizeBytes: file.size,
            });
            const put = await fetch(url, { method: 'PUT', headers, body: file });
            if (!put.ok) throw new Error(`upload failed (${put.status})`);
            const { id } = await receiptCreate.mutateAsync({
              expenseId,
              key,
              filename: file.name,
              contentType,
              sizeBytes: file.size,
              // Deferred so the whole batch goes to `startExtraction` at once —
              // above the threshold that routes through the cheaper Batch API.
              deferExtraction: true,
            });
            receiptIds.push(id);
          } catch {
            failed += 1;
          }
        }
        if (receiptIds.length > 0) await startExtraction.mutateAsync({ receiptIds });
        if (failed > 0) setUploadError(t('list.uploadPartial', { failed }));
        router.push(`/expenses/${reportId}`);
      } catch (err) {
        setUploadError(refusalText(err, t('list.uploadFailed')));
        setUploadBusy(false);
      }
    },
    [startFromReceipts, uploadUrl, receiptCreate, startExtraction, router, t, refusalText],
  );

  /**
   * "Upload receipt" + "New report" live in the top bar's right slot. Upload
   * creates the report + scans the receipt; New report opens the create dialog.
   *
   * The dependency array is UNCHANGED by P04 and that is deliberate — see
   * `TopBarReceiptUpload` above. This effect publishes an element rather than
   * rendering one, so the pointer is read inside the published component and
   * never here; these four values are exactly what the effect closes over.
   */
  useEffect(() => {
    setTopBarSlot(
      'right',
      /*
       * `pointer-coarse:gap-3`, and it is a requirement rather than a taste.
       * `ReceiptFileInput`'s file comment sets out both halves: two of its 6px
       * hit-slops collide at this row's 8px gap and the later sibling wins the
       * tap, so "Choose file" would silently steal taps aimed at "Take photo";
       * and a slopped control needs >=6px of clearance past its ring from any
       * neighbour, which "New report" only gets at 12px. The gap is widened on
       * the ROW rather than around the pair for that second reason — a nested
       * `gap-3` wrapper would fix the pair and leave the button 2px from the
       * ring. Coarse-scoped because the pair only exists there, so the desktop
       * row's spacing is untouched.
       */
      <div className="flex items-center gap-2 pointer-coarse:gap-3">
        {canCreate && (
          <TopBarReceiptUpload busy={uploadBusy} onFiles={(files) => void uploadReceipts(files)} />
        )}
        {/**
         * "New report", icon-only below `lg` — the SIXTH adoption of a shape `/delegations`
         * (`DelegationsManager.tsx:261`), `/travel` (`TravelRequests.tsx:190`) and
         * `/virtual-cards` (`VirtualCardsList.tsx:194-201`) already ship on `origin/main`,
         * and which `/virtual-cards/requests` and `/budgets` adopted earlier on this branch.
         * Copied, not reinvented.
         *
         * Below `lg` the top bar's ration is ONE icon-only control beside the route title,
         * and at a coarse pointer this row already publishes THREE — "Take photo",
         * "Choose file" and this one. The label is not dropped, only hidden from sight:
         * `max-lg:sr-only` keeps it in the accessibility tree at every width, so the
         * accessible name never changes with the viewport and the control never becomes an
         * unlabelled icon in either locale. No `aria-label` and no `title` — the label
         * element IS the accessible name, and either would be a second name competing with
         * it. The name is load-bearing beyond this file: `e2e/expense-lifecycle.spec.ts`
         * and `e2e/tap-targets.mobile.spec.ts` both match on "New report".
         *
         * ONE ELEMENT. NEVER TWO BRANCHES. A labelled button `max-lg:hidden` beside an icon
         * button `lg:hidden` is the shape most responsive top-bar controls take and it is
         * wrong here: jsdom loads no stylesheet, so both would sit in the accessibility
         * tree and a screen-reader user would meet the control twice. The detector is
         * `ExpenseReportsList.test.tsx`'s explicit `toHaveLength(1)` under "the control the
         * top bar publishes"; the pre-existing `getByText('list.newReport')` assertions on
         * this route would ALSO go red on a pair, so unlike `/virtual-cards/requests` this
         * route is not relying on the new case alone.
         *
         * `max-lg:sr-only`, not `sr-only lg:not-sr-only`: `not-sr-only` sets
         * `white-space: normal`, which overrides the Button base's `whitespace-nowrap` and
         * would let the DESKTOP label wrap where today it cannot.
         *
         * `max-lg:mr-0` on the glyph because an `sr-only` label is `position: absolute` and
         * so not a flex item — neither the base's `gap-2` nor the 6px `mr-1.5` has anything
         * left to space, and the `mr-1.5` would push the glyph off-centre in a 32px box.
         *
         * The `max-lg:` prefixes are load-bearing on all three size classes. Unprefixed,
         * `twMerge` merges `h-8 w-8 px-0` against the `size="sm"` cva's `h-9 px-3` at every
         * width and the control shrinks on DESKTOP too, with jsdom blind to it.
         *
         * THE ROW'S `pointer-coarse:gap-3` IS UNCHANGED BY THIS RESHAPE, AND THAT IS THE
         * ANSWER RATHER THAN AN OMISSION. CSS flex `gap` is a fixed distance between
         * adjacent items' box edges and is independent of either item's own width, so
         * narrowing this control moves its LEFT edge right and leaves the 12px seam — and
         * the 12 − 6 = 6px of clearance past the receipt chip's ring that
         * `ReceiptFileInput`'s file comment asks for — exactly where it was. The row gets
         * narrower overall; the seam does not. Do not "improve" the gap for this change.
         *
         * The slop class is the `size="sm"` cva variant's vertical-only `einc-tap-slop`,
         * and nothing here adds a second one. **Do not add `einc-tap-slop-both`.**
         * `cn`/`twMerge` has no conflict map for these two — they are hand-written CSS in
         * `globals.css`, not Tailwind utilities — so `-both` would not REPLACE the cva's
         * class, both would land and stylesheet source order would decide the hit box. It
         * also has a second cost unique to this row: horizontal reach here would put this
         * control's hit region into the same strip as the receipt chip's own 6px ring, and
         * the census cannot report that, because the chip is not a candidate. It ships
         * 32 × 44 — the vertical floor bought by the cva, the horizontal half unmet. That
         * shortfall is NEW, made here, and it is recorded in `docs/design/pwa.md` under
         * "Tap targets" with TWO container remedies, since this control sits in two
         * containers. `e2e/tap-targets.mobile.spec.ts`'s `/expenses` lane asserts it
         * two-sided and was rewritten in the same change.
         *
         * Both `canCreate` conditionals stay as they are, and `className` goes on the
         * `Button` rather than on a wrapper: a wrapper would have to live outside the
         * conditional, and the control would stop being absent for a reader without
         * `canCreate` — it would become an empty box the row still lays out and gaps.
         *
         * VeloExpense: the kit's `size="sm"` Button carries no `einc-tap-slop` (f07: ExpenseOS's
         * 44px phone target is a kit-level decision still open), so the one vertical-only
         * class ExpenseOS's cva adds is added here instead — the same single class.
         */}
        {canCreate && (
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            className="einc-tap-slop max-lg:h-8 max-lg:w-8 max-lg:px-0"
          >
            <IconPlus size={15} className="mr-1.5 max-lg:mr-0" />
            <span className="max-lg:sr-only">{t('list.newReport')}</span>
          </Button>
        )}
      </div>,
    );
    return () => setTopBarSlot('right', null);
  }, [t, canCreate, uploadBusy, uploadReceipts]);

  /**
   * The row's actions, in ONE place, for two surfaces.
   *
   * They used to be an array literal inside the `report` column's `cell`.
   * That works on a desktop, where the kebab sits at the right edge of the
   * identity cell, and fails twice on a card: the card's title slot would
   * carry a 24px trigger (against this epic's 44px floor) AND the card's own
   * kebab beside it, two menus offering the same two items. Lifting them here
   * lets `mobile.rowActions` hand the identical array to
   * `<RowActionsMenu triggerSize="touch">` — one definition, two frames.
   *
   * The conditions travel with them: delete is offered only to somebody who
   * may delete, and only on a DRAFT. A card must not offer an action the
   * table withholds.
   */
  const reportActions = useCallback(
    (row: ReportRow): RowAction[] => [
      {
        id: 'view',
        icon: <IconEye size={14} />,
        label: t('actions.view'),
        onClick: () => openReport(row.id),
      },
      ...(canDelete && row.status === 'DRAFT'
        ? [
            { divider: true as const },
            {
              id: 'delete',
              icon: <IconTrash size={14} />,
              label: t('actions.delete'),
              destructive: true,
              onClick: () => deleteReport(row.id),
            },
          ]
        : []),
    ],
    [t, canDelete, openReport, deleteReport],
  );

  const columns: ColumnDef<ReportRow, ColumnId>[] = useMemo(
    () => [
      {
        id: 'report',
        label: t('columns.report'),
        defaultWidth: 340,
        sortable: true,
        filterable: { kind: 'text' },
        hideable: false,
        exportValue: (row) => `${row.title} (${row.number})`,
        cell: (row, ctx) => (
          <div className="flex w-full items-center gap-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground text-sm">{row.title}</div>
              <div className="font-mono text-muted-foreground text-xs">{row.number}</div>
            </div>
            {/* The table's kebab, and only the table's. In a card this same
                cell is the TITLE slot, where a nested 24px menu would fight
                the card for the tap and sit beside the card's own 44px one.
                `mobile.rowActions` below carries the identical actions there.
                See `CellContext.compact`. */}
            {!ctx.compact && (
              <RowActionsMenu ariaLabel={t('actions.menu')} actions={reportActions(row)} />
            )}
          </div>
        ),
      },
      {
        id: 'status',
        label: t('columns.status'),
        defaultWidth: 130,
        sortable: true,
        filterable: {
          kind: 'enum',
          options: REPORT_STATUSES.map((s) => ({
            value: s,
            label: t(`status.${s.toLowerCase()}`),
          })),
        },
        exportValue: (row) =>
          row.pendingWith
            ? t('list.awaitingName', { name: displayName(row.pendingWith) })
            : t(`status.${row.status.toLowerCase()}`),
        // "Submitted" alone doesn't say whether a report is moving or stuck, so
        // name the approver holding it while it's out.
        cell: (row) => (
          <div className="min-w-0">
            <StatusBadge {...statusBadgeProps(row.status, t)} />
            {row.pendingWith && (
              <div className="truncate text-muted-foreground text-xs">
                {t('list.awaitingName', { name: displayName(row.pendingWith) })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'expenses',
        label: t('columns.expenses'),
        defaultWidth: 100,
        exportValue: (row) => row.expenseCount,
        cell: (row) => (
          <span className="text-muted-foreground text-sm tabular-nums">{row.expenseCount}</span>
        ),
      },
      {
        /**
         * The ISO code, not the glyph. CAD and USD both render `$`, so a USD report and a
         * CAD one printed identically and nothing distinguished them (GA readiness report
         * F54). A report in another currency also carries its equivalent in the reader's
         * own currency underneath — which is the "read a USD report in CAD" the audit
         * asked for, at the point where a reader is comparing reports (F52).
         */
        id: 'total',
        label: t('columns.total'),
        defaultWidth: 160,
        exportValue: (row) =>
          formatMinor(Number(row.totalMinor), row.currency, locale, { withCode: true }),
        exportNumber: (row) => Number(row.totalMinor),
        cell: (row) => (
          <span className="flex flex-col text-sm tabular-nums">
            <span className="text-foreground">
              {formatMinor(Number(row.totalMinor), row.currency, locale, { withCode: true })}
            </span>
            {/* A response from before this field existed (a cached page across a deploy)
                reads as "no second line", never as NaN. */}
            {!!row.homeCurrency && row.currency.code !== row.homeCurrency && (
              <span className="text-muted-foreground text-xs">
                {row.homeTotalMinor === null
                  ? t('columns.totalNoRate', { currency: row.homeCurrency })
                  : `≈ ${formatMinor(
                      Number(row.homeTotalMinor),
                      { code: row.homeCurrency },
                      locale,
                      { withCode: true },
                    )}`}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'updated',
        label: t('columns.updated'),
        defaultWidth: 130,
        exportValue: (row) =>
          new Date(row.updatedAt).toLocaleDateString(locale, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
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
    ],
    [t, locale, reportActions],
  );

  const [tableState, setTableState] = useState<DataTableState<ColumnId>>(() =>
    createDataTableState(columns as never, {}),
  );

  const filteredRows = useMemo(() => {
    let out = reports;
    for (const c of tableState.filters) {
      if (c.field === 'status' && c.op === 'equals') {
        out = out.filter((r) => r.status === c.value);
      }
      if (c.field === 'report' && c.op === 'contains') {
        const n = c.value.toLowerCase();
        out = out.filter(
          // VeloExpense: a report from before numbering has no number.
          (r) => r.title.toLowerCase().includes(n) || (r.number ?? '').toLowerCase().includes(n),
        );
      }
    }
    return out;
  }, [reports, tableState.filters]);

  const pillBar = useFilterPillBarWiring<ReportRow, ColumnId>(columns, tableState, setTableState);

  /**
   * What a report looks like as a card.
   *
   * Title / badge / two fields, and nothing else. `report` is the identity
   * (title + number) and `status` the state, so both are exempt from column
   * visibility by design — a card with neither is not a card. The two field
   * rows are `total` and `updated`, which are the columns a reader triages
   * by; `expenses` (a line count) is the one left out, for the same reason
   * the dashboard preview leaves it out — nobody triages by line count.
   *
   * `fields` is INTERSECTED with `columnVisibility` by the card renderer, so
   * hiding Total in the gear menu hides it here too. That is a pure read: no
   * card path writes `visibleColumns`, `columnWidths` or `density` back.
   *
   * NO `selectable`. `<DataTable selectable={false}>` below means this page
   * has no selection at all, and even when it gains some, the card checkbox
   * is a second, separate opt-in — a bulk-action bar laid out for 360px is
   * P05/P07's, and ticking rows nothing can act on is worse than not ticking
   * them.
   */
  const mobile = useMemo<DataTableMobileConfig<ReportRow, ColumnId>>(
    () => ({
      title: 'report',
      badge: 'status',
      fields: ['total', 'updated'],
      rowActions: reportActions,
    }),
    [reportActions],
  );

  /**
   * The columns a reader can actually see, in the order they are shown.
   *
   * `sortSheetOptions` deliberately does not apply visibility itself — that
   * is a page decision — and this page's answer is the same one the card
   * fields give: a column hidden in the gear menu is hidden everywhere, so
   * the sort sheet does not offer it either.
   */
  const visibleColumns = useMemo(
    () =>
      tableState.columnOrder
        .map((id) => columns.find((c) => c.id === id))
        .filter(
          (c): c is ColumnDef<ReportRow, ColumnId> =>
            c !== undefined && tableState.columnVisibility[c.id] !== false,
        ),
    [columns, tableState.columnOrder, tableState.columnVisibility],
  );

  /**
   * What the sort sheet offers — `resolveSortField` mapped over those
   * columns, which is the SAME resolver the column header calls.
   *
   * Built from the resolver rather than from `sortable: true` so the sheet
   * cannot offer a field the header would have withheld: whether a column
   * sorts depends on the rows, not on the declaration, and a sheet that
   * disagreed would be F04 again by another route — a control that moves an
   * indicator and reorders nothing.
   */
  const sortOptions = useMemo(
    () => sortSheetOptions(visibleColumns, filteredRows),
    [visibleColumns, filteredRows],
  );

  const stats = useMemo(() => {
    const by = (s: string) => reports.filter((r) => r.status === s);
    /**
     * The open balance, in ONE currency.
     *
     * This used to sum `totalMinor` raw across every submitted and approved report and
     * print a generic `$` in front of the result — so a USD report and a CAD one were
     * added together as though cents were cents, and the glyph they share meant nothing on
     * screen disclosed it (GA readiness report F54). The server now converts each total
     * into the reader's own currency; a report no rate can value is LEFT OUT and counted,
     * rather than folded in at the wrong scale.
     */
    const open = reports.filter((r) => r.status === 'SUBMITTED' || r.status === 'APPROVED');
    const homeCurrency = reports[0]?.homeCurrency ?? 'CAD';
    const openBalanceMinor = open.reduce((acc, r) => acc + Number(r.homeTotalMinor ?? 0), 0);
    const excluded = open.filter((r) => r.homeTotalMinor === null).length;
    return {
      drafts: by('DRAFT').length,
      awaiting: by('SUBMITTED').length,
      approved: by('APPROVED').length,
      reimbursed: by('REIMBURSED').length,
      openBalance: formatMinor(openBalanceMinor, { code: homeCurrency }, locale, {
        withCode: true,
      }),
      openExcluded: excluded,
    };
  }, [reports, locale]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* A failed upload used to just stop, leaving the user to wonder where the
          receipts went. */}
      {uploadError && (
        <Alert variant="destructive">
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('stats.drafts')} value={stats.drafts} icon={IconReceipt} />
        <StatCard label={t('stats.awaitingApproval')} value={stats.awaiting} variant="warning" />
        <StatCard label={t('stats.approved')} value={stats.approved} variant="success" />
        <StatCard
          label={t('stats.totalOpen')}
          value={stats.openBalance}
          secondaryValue={
            stats.openExcluded > 0
              ? t('stats.openExcluded', { count: stats.openExcluded })
              : `${t('stats.reimbursed')}: ${stats.reimbursed}`
          }
        />
      </div>

      {/* The pill bar is a horizontal strip, and below `md` there is no
          horizontal room for it. Hidden rather than reflowed, because the
          same blocks already have a compact frame — the bottom sheet below,
          which hosts `<FilterBlock>` unchanged. Same clause array, same
          callbacks, so the `or` inside a block and the `and` between blocks
          mean exactly what they mean here. */}
      <div className={cls('rounded-md border border-border bg-card', TABLE_ONLY)}>
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

      {/*
        Sort and filter, reachable by thumb.

        Cards have no column headers, so the two affordances the table hangs
        off a `<th>` — the sort arrow and the filter editor — have nowhere to
        live. These are where they go. Both triggers are the design system's
        `size="lg"` (44px) tier.

        Mounted HERE, on the page, and not inside `<DataTable>`'s compact
        branch. `DataTable` has `state.filters` but none of the clause
        plumbing: `useFilterPillBarWiring` owns add / update-op /
        update-value / remove / clear (with `nextOpValue`'s op-change rules),
        and this page owns the filtering itself in `filteredRows`. Mounting
        inside the table would mean a second copy of that plumbing, plus two
        new label bags threaded through `DataTableLabels` as OPTIONAL fields
        with English defaults — which is precisely the invisible-to-the-gate
        seam that shipped F43 — plus a filter/sort row appearing unbidden
        inside the three bare `<DataTable>`s the dashboard mounts in narrow
        preview cards, which deliberately carry no chrome at all.
      */}
      {compact && (
        <div
          /* Named so the browser suite can measure exactly this row. The 44px
             sweep in `e2e/datatable-mobile.spec.ts` is scoped to the cards and
             to this container — the toolbar's export and settings buttons are
             T04's shared control-size gap, and failing them here would report
             somebody else's finding as this phase's. `scripts/check-e2e-ids.mjs`
             checks this id still exists. */
          id="expenses-mobile-controls"
          className={cls('flex items-center gap-2', CARDS_ONLY)}
        >
          <FilterSheet<ColumnId>
            /* Both bags, because the sheet renders both: `labels` is the pill
               chrome it shares verbatim with the bar, `sheetLabels` is the
               frame that only exists below `md`. Neither is optional here —
               see `sortSheetLabels` at the top of this component. */
            labels={pillBar.chromeLabels}
            sheetLabels={pillBar.sheetLabels}
            /* The SAME array the bar is given. The trigger counts clause
               GROUPS off it, never clauses, so "Status is Draft or Submitted"
               reads as one filter and not two. */
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
          selectedCount={tableState.selectedIds.size}
          resultCount={filteredRows.length}
          loading={list.isLoading}
          rightSlot={
            <>
              <TableExportMenu<ReportRow, ColumnId>
                columns={columns}
                rows={filteredRows}
                state={tableState}
                filename="expense-reports"
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
            </>
          }
        />
        <DataTable<ReportRow, ColumnId>
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.id}
          mobile={mobile}
          totalCount={filteredRows.length}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={(row) => openReport(row.id)}
          loading={list.isLoading}
          labels={tableLabels}
          renderEmpty={() => (
            <div>
              <div className="font-medium text-foreground">{t('list.emptyTitle')}</div>
              <div className="mt-1 text-muted-foreground text-sm">{t('list.emptyBody')}</div>
            </div>
          )}
          selectable={false}
        />
      </div>

      {creating && (
        <NewReportDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            utils.expenses.list.invalidate();
            openReport(id);
          }}
        />
      )}
    </div>
  );
}

/** Create dialog — names the report + picks its currency (currency is fixed at
 *  create; expenses inherit it). Only mints a report on confirm, so cancelling
 *  never leaves an orphan draft. */
export function NewReportDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (reportId: string) => void;
}) {
  const t = useTranslations('expenses');
  const locale = useLocale();
  const currencies = trpc.expenses.currencies.useQuery();
  const create = trpc.expenses.create.useMutation({ onSuccess: (r) => onCreated(r.id) });

  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState<string | null>('CAD');

  /**
   * Mirrors `expenses.create`'s `z.string().min(1).max(200)`.
   *
   * Kept as a constant rather than a `maxLength` on the input, deliberately: `maxLength`
   * truncates a pasted title silently, and somebody who pastes a long name and gets a
   * short one back has been told nothing either. Saying it is over the limit — and which
   * limit — leaves them able to fix it.
   */
  const TITLE_MAX = 200;
  const tooLong = title.trim().length > TITLE_MAX;

  const items = (currencies.data ?? []).map((c) => ({
    value: c.code,
    label: `${c.code} · ${localeLabel(c.label, locale)}`,
  }));

  const canSave = title.trim().length > 0 && !tooLong && !!currency && !create.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('createDialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: control nested as children */}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('createDialog.reportTitle')}</span>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('createDialog.reportTitlePlaceholder')}
            />
            {tooLong && (
              <span className="text-destructive text-xs">
                {t('createDialog.titleTooLong', { max: TITLE_MAX })}
              </span>
            )}
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: control nested as children */}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('createDialog.currency')}</span>
            <Combobox
              items={items}
              value={currency}
              onValueChange={setCurrency}
              placeholder={t('createDialog.currencyPlaceholder')}
            />
          </label>
          {/* Any refusal the server makes that the form did not anticipate. Without
              this the dialog absorbs it: the mutation fails, nothing changes on
              screen, and the only report of it is in the network tab. */}
          {create.error && (
            <span className="text-destructive text-xs">{t('createDialog.createFailed')}</span>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('addLine.cancel')}
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              if (title.trim() && currency) create.mutate({ title: title.trim(), currency });
            }}
          >
            {t('createDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

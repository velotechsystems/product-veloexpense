'use client';

/**
 * `<DataTableCards>` — the compact half of `<DataTable>`.
 *
 * NOT a second component. It is one branch of `DataTable()`, split into
 * its own file only because two full render trees in one 1000-line module
 * is unreadable. It is deliberately absent from `./index.ts` and from
 * `../index.ts`: there is still exactly one public component, one
 * `DataTableState`, and one place (`DataTable()`) that decides which tree
 * mounts. A page that imports this directly has bypassed that decision.
 *
 * ── Not a restyled table ────────────────────────────────────────────
 *
 * The markup is `<ul>` / `<li>`, never a `<table>` with `display: block`
 * rows. That shortcut looks identical and is not: several assistive
 * technologies drop row and cell semantics the moment a table's display
 * type stops being tabular, and the user is left with an unstructured pile
 * of text where the table used to announce "row 3 of 40, column Amount".
 * A list is a smaller promise, kept.
 *
 * Each `<li>` is named by its title node via `aria-labelledby`, so the
 * announced name is "Q3 travel — Ada Lovelace", not the concatenation of
 * every value the card happens to show.
 *
 * ── Two rules inherited from the branch ─────────────────────────────
 *
 *   - It READS `state` and never writes it, with exactly one exception:
 *     `onToggleSelect`, a single-purpose callback for row selection. The
 *     card path must never push `columnVisibility`, `columnWidths` or
 *     `density` back — a phone must not be able to rewrite the desktop
 *     layout of a saved view. That is why there is no `onStateChange`
 *     prop, and why a narrow callback is the only write seam. If you find
 *     yourself wanting the whole setter here, that is a design
 *     conversation, not a refactor.
 *   - It holds no `useState` of its own. Crossing 768px remounts this
 *     tree, so any state kept here would silently reset on rotate. Refs
 *     are fine — they are re-attached by the same commit that remounts.
 *
 *     THIS is the one place the "remounts on rotate" claim is true, and it
 *     is true because this is a separate component that really is unmounted.
 *     It does NOT generalise to `DataTable`'s own state: the branch there is
 *     an early return, `DataTable` stays mounted, and its hooks survive the
 *     flip. That difference is why `editingCell` and `rowDragOrder` need an
 *     explicit cancel up there rather than being reset for free — see the
 *     block above the branch in `DataTable.tsx`.
 */

import {
  Checkbox,
  cls,
  ROW_STATE_CLASSES,
  RowActionsMenu,
  rowStateOf,
} from '@expenseos/design-system';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { Fragment, isValidElement, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { devWarnCards } from './devWarnCards';
import type { RowGroup } from './groupRows';
import type {
  CellContext,
  ColumnDef,
  DataTableLabels,
  DataTableMobileConfig,
  DataTableState,
} from './types';

export interface DataTableCardsProps<Row, ColumnId extends string = string> {
  /** Cloak class from the caller (`CARDS_ONLY`). Suppresses the
   *  pre-hydration flash only — see `tokens/breakpoints.ts`. */
  className?: string;
  /**
   * The card list's scroll container, owned by `DataTable` and attached
   * here.
   *
   * It lives up there rather than here because the infinite-scroll sentinel
   * is built up there too (see `sentinel`), and the observer needs the
   * element as its `root`. See the `overflow-y-auto` note on the wrapper
   * for why the card list scrolls itself at all.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  columns: ColumnDef<Row, ColumnId>[];
  /** Already sorted / reordered by the shared region of `DataTable()`.
   *  `readonly` because that is what the shared region hands over — the
   *  card tree is downstream of the ordering, never a second place that
   *  reorders. */
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Read-only. See the note above — no `onStateChange` by design. */
  state: DataTableState<ColumnId>;
  mobile?: DataTableMobileConfig<Row, ColumnId>;
  onRowClick?: (row: Row) => void;
  activeRowId?: string | null;
  /** First page still in flight. Same flag the table branch uses to choose
   *  its loading face. */
  loading?: boolean;
  /** Consumer's empty template, honoured exactly as the table honours it —
   *  the two branches must not disagree about what "no rows" looks like. */
  renderEmpty?: () => ReactNode;
  labels: DataTableLabels;
  /**
   * Render the selection checkbox slot.
   *
   * Resolved by `DataTable` as `selectable && mobile.selectable` — see the
   * note on `DataTableMobileConfig.selectable`. Off for every page today.
   */
  selectable?: boolean;
  rowSelectable?: (row: Row) => boolean;
  /** The one write seam. Toggles a single row id in `state.selectedIds`. */
  onToggleSelect?: (id: string) => void;
  /**
   * The row partition, when `state.groupBy` is active. Built by `DataTable`
   * from `./groupRows` — the SAME call the table's `<GroupHeaderRow>`s are
   * drawn from, handed over rather than re-derived, so the two surfaces
   * cannot disagree about which rows are in which group.
   *
   * Undefined or empty means ungrouped, which is the flat `<ul>` below.
   */
  groups?: readonly RowGroup<Row>[];
  /** Formats the right-aligned per-group count. Same prop the table passes to
   *  `<GroupHeaderRow>`; English fallback is the bare number, as there. */
  groupCountLabel?: (count: number) => string;
  /**
   * The SECOND write seam, and the last one.
   *
   * Collapsing a group writes `state.collapsedGroups`, which is the one piece
   * of grouped-view state a reader can change from a card list. It is allowed
   * here — where `columnVisibility` / `columnWidths` / `density` are not —
   * because it is not desktop LAYOUT: it is ephemeral, it is not part of
   * `PersistedViewState` (checked — saved views carry filters, visibleColumns,
   * sort, density and groupBy, and no collapse set), so a phone cannot write
   * it into anybody's saved view.
   *
   * Omitting it makes the headers inert rather than absent, which is the
   * wrong trade in the one case that matters: a group collapsed on a desktop
   * stays collapsed across the breakpoint, and with no way to expand it the
   * reader is left looking at a header over rows they cannot reach.
   */
  onToggleGroupCollapsed?: (key: string) => void;
  /**
   * The infinite-scroll sentinel, built by `DataTable` and placed by us.
   *
   * Passed as an element rather than as six more props because the sentinel
   * needs `scrollRef` as its `IntersectionObserver` root and `DataTable`
   * already owns both the ref and every pagination prop. What the card tree
   * contributes is the one thing it knows and `DataTable` does not: WHERE in
   * the compact DOM the sentinel has to sit for that root to observe it —
   * inside the scroll container, after the list.
   */
  sentinel?: ReactNode;
}

/** Tailwind's `h-11 w-11` — the 44×44 CSS-pixel minimum tap target
 *  (WCAG 2.2 SC 2.5.8 asks 24×24; 44 is the platform guidance both Apple
 *  and Material publish, and it is the number this epic committed to). */
const TAP_BOX = 'flex h-11 w-11 shrink-0 items-center justify-center';

export function DataTableCards<Row, ColumnId extends string = string>(
  props: DataTableCardsProps<Row, ColumnId>,
) {
  const {
    className,
    scrollRef,
    columns,
    rows,
    rowKey,
    state,
    mobile,
    onRowClick,
    activeRowId = null,
    loading = false,
    renderEmpty,
    labels,
    selectable = false,
    rowSelectable,
    onToggleSelect,
    groups,
    groupCountLabel,
    onToggleGroupCollapsed,
    sentinel,
  } = props;

  /**
   * The root the dev scan reads. Typed `HTMLElement` and attached by callback
   * because it lands on the `<ul>` when ungrouped and on the wrapper around
   * the group `<section>`s when grouped — one root either way, so
   * `devWarnCards` sees every card slot on screen exactly once.
   */
  const listRef = useRef<HTMLElement | null>(null);
  /** What `devWarnCards` has already said, for the life of this mount. */
  const warnedOnce = useRef<Set<string>>(new Set());
  const liveRef = useRef<HTMLParagraphElement | null>(null);
  const announcedCount = useRef<number | null>(null);

  const columnById = useMemo(() => {
    const m = new Map<string, ColumnDef<Row, ColumnId>>();
    for (const c of columns) m.set(c.id, c);
    return m;
  }, [columns]);

  // The headline column. `mobile.title` ignores column visibility on
  // purpose (a card always has an identity); with no `mobile` config at
  // all we fall back to the first column the user can currently see, so a
  // page that reaches card mode without configuring one still renders
  // something recognisable rather than a stack of blank rectangles.
  //
  // The fallback runs on an UNRESOLVABLE id too, not only on a missing one.
  // `mobile.title` is checked against the `ColumnId` union, but the union is
  // not the live `columns` array: a page that builds its columns behind a
  // permission or a feature flag can name a title that is typed fine and is
  // simply not there this render. A `??` chain would short-circuit on the
  // defined-but-missing id and leave `titleCol` undefined — which is worse
  // than no config at all, because `hasCardConfig` is still true, so the
  // card branch mounts and every card gets an empty title span that its
  // `aria-labelledby` then points at. A card with no accessible name is
  // unreachable by name for a screen reader, so the miss falls through to
  // the same chain the unconfigured page uses and `devWarnCards` names the
  // id that did not resolve.
  const configuredTitleCol = mobile?.title !== undefined ? columnById.get(mobile.title) : undefined;
  const unresolvedTitleId =
    mobile?.title !== undefined && configuredTitleCol === undefined ? mobile.title : undefined;
  const titleId =
    configuredTitleCol?.id ??
    state.columnOrder.find((id) => state.columnVisibility[id] !== false) ??
    columns[0]?.id;
  const titleCol = titleId ? columnById.get(titleId) : undefined;
  const badgeCol = mobile?.badge ? columnById.get(mobile.badge) : undefined;

  /**
   * The subtitle is NOT exempt from the visibility intersection.
   *
   * Exactly two slots ignore `columnVisibility` — `title` and `badge` — and
   * the reason is narrow: a card must never come back empty of identity or
   * of state. A subtitle is neither. It is a second detail line, which is
   * the same category as a field row, so it obeys the same rule: hide the
   * column on the desktop and it is gone on the phone too. Exempting it
   * "because it is in the header" would mean hiding a column does not hide
   * it, and that gets reported as a leak rather than as a layout bug.
   */
  const subtitleVisible =
    mobile?.subtitle !== undefined && state.columnVisibility[mobile.subtitle] !== false;
  const subtitleCol =
    subtitleVisible && mobile?.subtitle ? columnById.get(mobile.subtitle) : undefined;

  /**
   * The card's field rows: `mobile.fields` INTERSECTED with the user's live
   * column visibility.
   *
   * A column the person deliberately hid on the desktop stays hidden on the
   * phone. The alternative — cards ignoring visibility because "a card is a
   * different surface" — means hiding a column does not hide it, which is
   * the sort of thing that gets reported as a leak rather than as a layout
   * bug. `title` and `badge` are the two exceptions and they are handled
   * above: identity and state are not optional, and a card that came back
   * empty of both would be unusable.
   *
   * This is a PURE READ. Nothing here writes `columnVisibility` back.
   *
   * Zero surviving fields is an accepted outcome, not an error: hide every
   * configured field and you get a card with a title and a badge and no
   * detail rows. That renders cleanly. We do NOT synthesise a substitute
   * row — the person asked for those columns to be gone.
   */
  const fieldIds = useMemo(
    () => (mobile?.fields ?? []).filter((id) => state.columnVisibility[id] !== false),
    [mobile?.fields, state.columnVisibility],
  );

  /**
   * Announce the result count into a polite live region.
   *
   * ── Why the region lives with the LIST and not with the filter sheet ──
   *
   * The count changes because a filter changed, and on a phone the count is
   * off-screen behind the sheet — so the announcement is the only feedback
   * the filter worked (SC 4.1.3). It is tempting to put the region in the
   * sheet, next to the control that caused the change. It does not work:
   * a live region has to be in the DOM BEFORE its text changes or the
   * change is not announced, and the sheet is mounted and unmounted around
   * every interaction. Worse, applying a filter usually closes the sheet,
   * so the region would be unmounting at the exact moment it had something
   * to say. The list is the thing whose count changed and it is mounted for
   * as long as card mode is, so the region belongs here.
   *
   * The text is written imperatively into an already-mounted node rather
   * than rendered from state — partly because this tree holds no state by
   * rule, and partly because it is the technique that actually works: a
   * region whose text is swapped in place is announced, a region that
   * appears alongside its text often is not.
   *
   * The first commit is recorded and NOT announced. Landing on a list is
   * not an update, and a page that opened by reading its own row count
   * aloud would be noise before the person had done anything.
   */
  useEffect(() => {
    if (loading) return;
    const count = rows.length;
    if (announcedCount.current === null) {
      announcedCount.current = count;
      return;
    }
    if (announcedCount.current === count) return;
    announcedCount.current = count;
    const node = liveRef.current;
    if (node) node.textContent = (labels.cards?.resultCount ?? defaultResultCount)(count);
  }, [rows.length, loading, labels.cards?.resultCount]);

  // Dev-only mechanical checks. See `devWarnCards.ts` — nothing here
  // changes what renders, and the whole thing compiles out in production.
  const configuredFieldCount = mobile?.fields.length ?? 0;
  // No dependency array on purpose. The scan reads the DOM, so its real input
  // is "whatever this commit rendered" — the rows, the surviving field ids,
  // and every cell's own branching. Listing those as deps would be a guess
  // that goes stale the first time a cell renders conditionally, and
  // `useExhaustiveDependencies` is right that an effect reading none of them
  // has no business naming them. Every commit costs one `querySelectorAll` in
  // dev and nothing in production, where `devWarnCards` returns on line one.
  useEffect(() => {
    devWarnCards(listRef.current, {
      configuredFieldCount,
      unresolvedTitleId,
      seen: warnedOnce.current,
    });
  });

  const hasRows = rows.length > 0;

  const grouped = (groups?.length ?? 0) > 0;

  /**
   * One card. Shared verbatim by the flat list and the grouped one — a group
   * is a different frame around the same card, never a second card renderer.
   *
   * `rowIndex` is passed in rather than derived, so it stays monotonic across
   * groups exactly as it does in the table's grouped render.
   */
  const renderCard = (row: Row, rowIndex: number) => {
    const id = rowKey(row);
    const isSelected = state.selectedIds.has(id);
    const isActive = activeRowId === id;
    // `compact: true` is the frame hint — see `CellContext.compact`. A cell
    // that embeds a control beside its value (the identity column's kebab)
    // drops it here, because the card renders its own 44px one below.
    const ctx: CellContext = { rowIndex, depth: 0, isSelected, isActive, compact: true };
    // The card reuses the table's row-state tokens rather than
    // inventing a compact palette: `leadingCell` because the whole
    // card IS the leading edge here, so it carries both the state
    // fill and the 3px accent bar the table puts on its first cell.
    const stateClasses = ROW_STATE_CLASSES[rowStateOf({ isSelected, isActive })];
    const titleDomId = `dt-card-title-${id}`;
    const actions = mobile?.rowActions?.(row) ?? [];

    return (
      <li
        key={id}
        id={`data-card-${id}`}
        /* The scroll anchor's handle. `DataTable` records the row key
           of the topmost visible row before a breakpoint flip and
           looks it up again in whichever tree mounted next, so BOTH
           trees have to expose the key under the same attribute — the
           `id` prefixes differ (`data-card-` here, `data-row-` on the
           table) precisely so the two never collide, which makes them
           useless as a shared selector. See `useScrollAnchor`. */
        data-dt-row-key={id}
        // Named by the title node alone. The default computation
        // for a labelled-by-nothing listitem is "everything inside
        // it", which on a card is five values run together.
        aria-labelledby={titleDomId}
        className={cls(
          'group rounded-md border border-border transition-colors',
          stateClasses.leadingCell,
        )}
      >
        <div className="flex items-start gap-1 p-2">
          {selectable && onToggleSelect && (
            // 44×44 slot. The DS `Checkbox` inside is 16×16 and
            // that is a known epic-wide gap (T04 owns the shared
            // fix); reserving the box now means the card anatomy
            // does not move when the control grows into it.
            <div className={TAP_BOX}>
              <Checkbox
                checked={isSelected}
                disabled={rowSelectable ? !rowSelectable(row) : false}
                onCheckedChange={() => onToggleSelect(id)}
                aria-label={labels.cards?.selectRow ?? 'Select row'}
              />
            </div>
          )}

          <div className="min-w-0 flex-1">
            {/*
              Title and badge share a wrapping row.

              `flex-wrap` with a generous `basis` on the title is the
              whole mechanism for "at 360 the badge drops to its own
              line rather than compressing the title": the title asks
              for 14rem before it will share a line, so on a narrow
              phone the badge has nowhere to go but down, and on a
              wider compact viewport (a tablet in portrait) the two
              sit side by side. A media query would have had to guess
              a width; this reacts to the width there actually is.
            */}
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
              {onRowClick ? (
                <button
                  type="button"
                  onClick={() => onRowClick(row)}
                  // `min-h-11`: with a one-line title the text is
                  // 20px tall, well under the tap minimum, and the
                  // title is the card's only navigation affordance.
                  className="flex min-h-11 min-w-0 flex-1 basis-56 cursor-pointer items-center text-left"
                >
                  <span
                    id={titleDomId}
                    data-dt-card-slot="title"
                    data-dt-column-id={titleId}
                    className="line-clamp-2 font-medium text-foreground text-sm"
                  >
                    {titleCol?.cell(row, ctx)}
                  </span>
                </button>
              ) : (
                /*
                  No `onRowClick`, so this card renders no row-open button and
                  the title slot IS the card's tap target — whatever the title
                  column rendered is the only way into the row.

                  AN ELEMENT CHILD IS THE ORDINARY CASE HERE, NOT THE
                  EXCEPTION. `grep -rn "mobile={" apps/web/src` finds exactly
                  three production callers of this arm — the three `/dashboard`
                  cards — and all three return a
                  `<Link className="flex min-w-0 flex-col …">` from their title
                  `cell`. Every other production `mobile` caller passes
                  `onRowClick` and takes the sibling arm above. So the element
                  branch carries 100% of the traffic on this route, and the
                  `line-clamp-2` text wrapper below currently has no caller at
                  all: it is the fallback for a title column whose `cell`
                  returns a string.

                  Which means the 44px floor has to land on the column's own
                  node, not on this span. The previous `py-2` made THIS span
                  52px tall and left the caller's <a> at its natural 36: a
                  padded parent does not grow its child, and a tap target is
                  the child's box, not the whitespace around it. So the span
                  becomes a 44px-floored flex container whose single child is
                  stretched to that floor. The caller's <a> inherits the tap
                  target and this file never names `a`.

                  Two elements, never one class. `line-clamp-N` compiles to
                  `display:-webkit-box`, which cannot share an element with
                  `display:flex` — the later declaration simply wins. So the
                  clamp moves inside, and only for a plain-text title: wrapping
                  an ELEMENT would put a `-webkit-box` between the flex
                  container and the node that needs stretching, and the 36px
                  would come straight back. An element child therefore renders
                  unwrapped as the sole flex child. It trades the two-line
                  clamp for the floor; a column that needs both clamps inside
                  its own `cell`, where it also knows how many lines it wants.
                  `DataTableMobileConfig.title`'s own doc in `./types.ts` is
                  where a caller choosing a title column reads that contract.

                  `my-auto` IS ON THE TEXT WRAPPER ONLY, and the centring claim
                  is scoped to that branch. Auto cross-axis margins beat
                  `stretch`, so plain text sits centred in the 44px box, the
                  way `py-2` used to centre it and the way the badge slot
                  beside it centres its own content. An ELEMENT child gets no
                  equivalent: it is stretched to the floor and lays its own
                  lines out from the top, so a one-line title leaves slack
                  below it. That is inherent to the mechanism — `items-center`
                  would defeat the stretch that produces the floor — and it is
                  the accepted trade here, not an oversight.
                */
                <span
                  id={titleDomId}
                  data-dt-card-slot="title"
                  data-dt-column-id={titleId}
                  className="flex min-h-11 min-w-0 flex-1 basis-56 items-stretch font-medium text-foreground text-sm"
                >
                  {(() => {
                    const titleNode = titleCol?.cell(row, ctx);
                    return isValidElement(titleNode) ? (
                      titleNode
                    ) : (
                      <span className="my-auto line-clamp-2 min-w-0 flex-1">{titleNode}</span>
                    );
                  })()}
                </span>
              )}

              {badgeCol && (
                // Whatever the column already renders — which is a
                // badge, because that is what a status column
                // renders in the table. It stays a badge and never
                // degrades to a coloured dot: colour as the only
                // carrier of meaning fails SC 1.4.1.
                <span
                  data-dt-card-slot="badge"
                  data-dt-column-id={mobile?.badge}
                  className="flex min-h-11 shrink-0 items-center"
                >
                  {badgeCol.cell(row, ctx)}
                </span>
              )}
            </div>

            {subtitleCol && (
              <p
                data-dt-card-slot="subtitle"
                data-dt-column-id={mobile?.subtitle}
                className="line-clamp-1 text-muted-foreground text-sm"
              >
                {subtitleCol.cell(row, ctx)}
              </p>
            )}

            {fieldIds.length > 0 && (
              // <dl>, not a two-column div grid: the column's own
              // label IS the term for the value beside it, and the
              // pairing is what lets a screen reader read "Amount,
              // $1,500" instead of two unrelated strings. Direct
              // dt/dd children (no wrapper divs) keep axe's
              // definition-list rule happy; the grid does the
              // visual pairing.
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
                {fieldIds.map((fid) => {
                  const def = columnById.get(fid);
                  if (!def) return null;
                  return (
                    <Fragment key={fid}>
                      <dt className="text-muted-foreground">{def.label}</dt>
                      <dd
                        data-dt-card-slot="field"
                        data-dt-column-id={fid}
                        className="min-w-0 text-foreground"
                      >
                        {def.cell(row, ctx)}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
            )}
          </div>

          {actions.length > 0 && (
            /*
              No `TAP_BOX` wrapper here, and its absence is the point.

              Phase 3 reserved a 44×44 slot around a 24×24 trigger and
              left a note that `triggerSize` is what would make the box
              more than a promise. This is that: `triggerSize="touch"`
              puts `h-11 w-11` on the BUTTON, so the hit area is the 44
              px, not a div drawn around a 24px one. Keeping the wrapper
              as well would nest two 44px boxes and invite the next
              reader to assume the outer one is load-bearing — it never
              was. The checkbox above still needs its slot, because the
              DS `Checkbox` is genuinely 16×16 and T04 owns that fix.

              Deliberately NOT a parallel kebab built here — two
              row-action menus would drift.
            */
            <RowActionsMenu
              actions={actions}
              ariaLabel={labels.cards?.rowActions ?? 'Row actions'}
              triggerSize="touch"
            />
          )}
        </div>
      </li>
    );
  };

  return (
    /**
     * The card list scrolls ITSELF, exactly as `<Scroll2D>` does for the
     * table.
     *
     * Not a free choice: every list page wraps the table in
     * `flex min-h-0 flex-1 flex-col overflow-hidden`, so a card list that
     * relied on document scroll would be clipped at the fold with no way to
     * reach row four. Matching the table's `min-h-0 flex-1` + its own
     * overflow keeps one shell working for both trees, and it gives the
     * infinite-scroll sentinel a real element to be rooted at instead of
     * the viewport it is not laid out against.
     *
     * `overscroll-contain` stops a flick at the end of the list from
     * chaining into the page behind it, which on iOS is the difference
     * between "the list ended" and "the app bounced".
     */
    <div
      ref={scrollRef}
      className={cls('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
    >
      {/* `role="status"` on a <p>, not an <output>: this carries a row-count
          update, not the result of a calculation the user typed. Visually
          hidden — the count is already on screen for anyone who can see it. */}
      <p ref={liveRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />

      {loading && !hasRows ? (
        <CardsLoading label={labels.loading ?? 'Loading…'} />
      ) : !hasRows ? (
        <div className="p-6 text-center">
          {renderEmpty ? renderEmpty() : <span className="text-muted-foreground">No results.</span>}
        </div>
      ) : grouped ? (
        /*
         * Grouped: one <section> per group, each with its own <ul>.
         *
         * NOT one flat <ul> with header <li>s wedged between the cards. A
         * group header is not a list item, and smuggling it in as one makes
         * every "list, N items" count wrong by the number of groups — the
         * summary the whole card design leans on. Separate lists give each
         * group its own accurate count instead, and the <section>'s
         * `aria-label` names it, so a reader arriving mid-list is told which
         * group they are in.
         */
        <div
          ref={(el) => {
            listRef.current = el;
          }}
          className="space-y-2 p-2"
        >
          {(() => {
            // Absolute across groups, matching the table's grouped render, so
            // a `cell` that stripes on parity looks the same in both trees.
            let rowIndex = -1;
            return (groups ?? []).map((group) => (
              <section key={group.key} aria-label={group.label}>
                {/* Sticky against the card list's OWN scroll container (the
                    wrapper above), not the page — the list scrolls itself, so
                    `top-0` is the top of the list and not the top of a
                    viewport it is not laid out against. `-mx-2 px-2` spans the
                    padding the list keeps around its cards, so the bar reads
                    as a divider rather than as a floating chip. */}
                <div className="sticky top-0 z-10 -mx-2 mb-2 border-border border-y bg-muted px-2">
                  <button
                    type="button"
                    onClick={
                      onToggleGroupCollapsed ? () => onToggleGroupCollapsed(group.key) : undefined
                    }
                    disabled={!onToggleGroupCollapsed}
                    aria-expanded={!group.collapsed}
                    // The whole bar is the target: `min-h-11 w-full`. A 16px
                    // chevron with a 44px box drawn round it satisfies nothing
                    // — phase 4 settled that for the kebab and it holds here.
                    className="flex min-h-11 w-full items-center gap-2 text-left"
                  >
                    {group.collapsed ? (
                      <IconChevronRight size={16} aria-hidden="true" className="shrink-0" />
                    ) : (
                      <IconChevronDown size={16} aria-hidden="true" className="shrink-0" />
                    )}
                    <span className="truncate font-semibold text-foreground text-sm">
                      {group.label}
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                      {groupCountLabel
                        ? groupCountLabel(group.rows.length)
                        : `${group.rows.length}`}
                    </span>
                  </button>
                </div>
                {/* A collapsed group keeps its header and drops its list —
                    the header alone documents that the group exists, exactly
                    as the table's collapsed group does. */}
                {!group.collapsed && (
                  <ul
                    // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics under list-style:none
                    role="list"
                    className="list-none space-y-2"
                  >
                    {group.rows.map((row) => {
                      rowIndex += 1;
                      return renderCard(row, rowIndex);
                    })}
                  </ul>
                )}
              </section>
            ));
          })()}
        </div>
      ) : (
        // `list-none` is not cosmetic here — cards are not bulleted — and
        // Safari/VoiceOver drops the implicit `list` role from any <ul> whose
        // list-style is none. Without the explicit role the card list is
        // announced as a run of unrelated groups, and the "list, 12 items"
        // summary the whole card design leans on disappears. That is why the
        // role below carries the repo's FIRST suppression of this rule; the
        // phase-2 handoff note predicted this exact trade and sanctioned it.
        <ul
          ref={(el) => {
            listRef.current = el;
          }}
          // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics under list-style:none
          role="list"
          className="list-none space-y-2 p-2"
        >
          {rows.map((row, rowIndex) => renderCard(row, rowIndex))}
        </ul>
      )}

      {sentinel}
    </div>
  );
}

/** Default text for the polite result-count announcement. Plain English on
 *  purpose — the catalog keys are phase 6's, and this is the prop seam they
 *  thread through (`labels.cards.resultCount`). */
function defaultResultCount(count: number): string {
  return count === 1 ? '1 result' : `${count} results`;
}

/**
 * Loading face, re-hosted out of the table's `<td colSpan>`.
 *
 * The table shows a single centred line of text because a table has a
 * header to anchor the eye. A card list has nothing until the first card
 * arrives, so three inert placeholders hold the shape — they are
 * `aria-hidden` because a screen reader gains nothing from three empty
 * rectangles, and the label underneath is the accessible half.
 */
function CardsLoading({ label }: { label: string }) {
  return (
    <div className="p-2">
      <div aria-hidden className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-md border border-border bg-muted/40" />
        ))}
      </div>
      <p className="p-4 text-center text-muted-foreground">{label}</p>
    </div>
  );
}

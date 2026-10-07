'use client';

/**
 * DataTableToolbar — the canonical strip above a data table.
 *
 * The layout is a RULE, not a set of slots to fill as you please: a toolbar
 * that reshuffles per page makes every list feel like a different product.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [3 selected ▾]  …leftSlot…              12 results  [⇩] [⚙]      │
 *   └──────────────────────────────────────────────────────────────────┘
 *     └─ bulk actions, flush left, over              └─ rightSlot: view
 *        the select-all checkbox column     └─ count,    controls
 *                                             immediately left of them
 *
 * Three things the toolbar owns so no caller can differ:
 *
 *   1. **Bulk actions sit flush left**, lining up with the select-all checkbox
 *      in the header row below — the checkbox and the thing it enables read as
 *      one control.
 *   2. **They are absent, not disabled, with nothing selected.** A permanently
 *      greyed button is noise on every list you open; it appears the moment a
 *      selection exists.
 *   3. **The trigger counts the selection** ("3 selected"), so the count lives
 *      on the control it applies to rather than in prose beside it.
 *
 * The row count reads "12 results" — no entity noun, since the page already
 * says what it lists. It sits at the right, immediately left of the view
 * controls, because "how many are there" belongs with "how do I look at them",
 * not with "what can I do to them".
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { type BulkAction, BulkActionsMenu } from './BulkActionsMenu';

export interface DataTableToolbarProps {
  /** Rows currently selected. Drives whether the bulk-actions trigger exists
   *  at all, and the number it shows. */
  selectedCount?: number;
  /** Bulk actions for the current selection. Rendered flush left, and only
   *  while something is selected. */
  bulkActions?: BulkAction[];
  /** Overrides the trigger copy. Defaults to `` (n) => `${n} selected` ``;
   *  pass the host app's i18n string. */
  bulkActionsLabel?: (n: number) => string;
  /** Force-disable the trigger while an outer mutation is pending. */
  bulkActionsDisabled?: boolean;
  /** Rows in the list after filtering. Rendered at the right as "N results". */
  resultCount?: number;
  /** Overrides the count copy. Defaults to `` (n) => `${n} results` ``. */
  resultLabel?: (n: number) => string;
  /** Show the loading placeholder in place of the count. */
  loading?: boolean;
  /** Overrides the loading placeholder. Defaults to "Loading…". */
  loadingLabel?: string;
  /** A select-all control, when the list puts one in the toolbar rather than
   *  in a header row. Rendered first, with the bulk-actions trigger directly
   *  after it — the checkbox and what it enables belong together. */
  selectAllSlot?: ReactNode;
  /** Anything else belonging on the left — a scope chip, a notice. It follows
   *  the select-all and the bulk actions. */
  leftSlot?: ReactNode;
  /** View-affecting controls: export, columns, density. The count is placed
   *  immediately to their left. */
  rightSlot?: ReactNode;
  /** Border below the toolbar (default true). Turn off when the toolbar sits
   *  in a card that already separates itself from the table below. */
  divider?: boolean;
  className?: string;
}

export function DataTableToolbar({
  selectedCount = 0,
  bulkActions,
  bulkActionsLabel = (n) => `${n} selected`,
  bulkActionsDisabled,
  resultCount,
  resultLabel = (n) => `${n} results`,
  loading,
  loadingLabel = 'Loading…',
  selectAllSlot,
  leftSlot,
  rightSlot,
  divider = true,
  className,
}: DataTableToolbarProps) {
  const showBulk = !!bulkActions?.length && selectedCount > 0;
  const showCount = !loading && typeof resultCount === 'number';

  return (
    <>
      {/*
       * `max-lg:flex-wrap` on this row and on both of its groups — the toolbar WRAPS below
       * `lg`, and it does not scroll. Above `lg` nothing here changes at all.
       *
       * ── What it fixes, with the numbers ──────────────────────────────────────────────
       *
       * At 360px the toolbar has a 302px content box (326px border box inside the listing
       * card, less `px-3`). Measured on `/users` before this class existed:
       *
       *   · **fr-CA overflowed.** The trailing group wanted 314px+, was handed 302px, and
       *     could not compress the rest of the way: `scrollWidth` 339 against a
       *     `clientWidth` of 326 — 13px of the settings trigger laid out past the card's
       *     own edge. Same 13px on `/admin/audit-trail`, `/admin/expense-categories` and
       *     `/admin/job-levels`; 9px on `/expenses/all`.
       *   · **EN did not overflow, and was still wrong.** It stayed inside the box by
       *     SHRINKING the settings trigger from its natural 136.1px to 111.8px. A squeezed
       *     control is not a fitted one — it is the same defect one step before it becomes
       *     visible, and it is the state every EN screenshot of this toolbar was taken in.
       *
       * After: `scrollWidth === clientWidth` at 360 and at 390, in both locales, on every
       * route measured, and both triggers are laid out at their natural width.
       *
       * ── Why wrap and not scroll ──────────────────────────────────────────────────────
       *
       * The ticket asked for the toolbar to "overflow horizontally instead of clipping".
       * For THIS component that wording is superseded, on three grounds rather than a
       * preference:
       *
       *  1. **"Stop clipping" has no edit site here.** This file carries no `overflow-*` at
       *     all, on any box. Nothing was being clipped; a row was being laid out past its
       *     own content box, which is the opposite failure.
       *  2. **A scroll container would silently cut what callers mount.** `leftSlot` and
       *     `rightSlot` are filled by roughly thirty pages, and what goes in them is menus
       *     and popovers — `TableExportMenu` and `TableSettingsButton` among them. An
       *     `overflow-x-*` here establishes a clipping box for every unportalled overlay
       *     inside it, and the failure is silent: the panel opens and is cut, on all of
       *     those pages at once. `TopBar.tsx` refuses `overflow-*` on its own zones for
       *     exactly this reason.
       *  3. **Scrolling would defeat the rule this file exists to state.** The header
       *     comment above says the toolbar OWNS where the count and the view controls sit,
       *     so that no list differs from another. Putting them behind a horizontal gesture
       *     nobody is told about makes them conditional on discovering the gesture, which
       *     is not a layout rule — it is the absence of one.
       *
       * ── Why all three rows and not just this one ─────────────────────────────────────
       *
       * A flex line only ever breaks BETWEEN items, so each `flex-wrap` buys a different
       * break:
       *
       *   · **Here** it lets the trailing group leave the leading group's line. Note this
       *     row alone cannot be the whole fix: the leading group is `flex-1` with
       *     `min-w-0`, so its flex base size is 0 and it never forces the break — the break
       *     comes from the trailing group's own content exceeding what is left.
       *   · **On the two groups** it lets a group break internally instead of shrinking its
       *     children. That is the half that stops the 136.1px → 111.8px squeeze above; the
       *     settings trigger takes its own line rather than being compressed onto a shared
       *     one.
       *
       * ── Two consequences, stated rather than discovered ──────────────────────────────
       *
       *   · **`justify-between` packs a lone wrapped line at the START.** So below `lg`,
       *     once the row breaks, the count and the view controls read left-aligned rather
       *     than right-aligned. Their ORDER and their adjacency — "how many" beside "how do
       *     I look at them" — are unchanged, which is what rule 3 above actually claims.
       *   · **An empty leading group still costs a line.** It is rendered unconditionally,
       *     so with nothing selected and no `leftSlot` it takes a zero-height first line and
       *     the row keeps its 12px `gap-3` above the content: +12px of toolbar height below
       *     `lg` on a list with no selection. Measured, accepted, and cheaper than the
       *     conditional render it would take to avoid — which would also move the leading
       *     cluster's DOM position depending on state.
       *
       * Pinned as classes in `DataTableToolbar.test.tsx`, because this is a design-system
       * change with no semver gate: it reaches every consumer on the next build.
       */}
      <div
        className={cn(
          'flex min-h-10 items-center justify-between gap-3 px-3 py-2 max-lg:flex-wrap',
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 max-lg:flex-wrap">
          {selectAllSlot}
          {showBulk && (
            <BulkActionsMenu
              selectedCount={selectedCount}
              actions={bulkActions as BulkAction[]}
              label={bulkActionsLabel(selectedCount)}
              disabled={bulkActionsDisabled}
            />
          )}
          {leftSlot}
        </div>
        {(showCount || loading || rightSlot) && (
          <div className="flex items-center gap-2 max-lg:flex-wrap">
            {loading && <span className="text-muted-foreground text-sm">{loadingLabel}</span>}
            {showCount && (
              <span className="text-muted-foreground text-sm tabular-nums">
                {resultLabel(resultCount as number)}
              </span>
            )}
            {rightSlot}
          </div>
        )}
      </div>
      {divider ? <div className="h-px bg-border" /> : null}
    </>
  );
}

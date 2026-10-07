/**
 * Dev-only sanity checks for the card tree.
 *
 * Not a lint rule and not a runtime guard: nothing here changes what
 * renders. Both checks describe a class of mistake that is invisible on a
 * desktop review — the reviewer is looking at the TABLE, where the same
 * `ColumnDef.cell` is fine — and only misbehaves on a phone. A warning at
 * the moment the card mounts puts the message in front of the person who
 * can still fix it cheaply.
 *
 * ── Why a DOM scan and not a type ───────────────────────────────────
 *
 * The thing we want to know is "did this column's `cell` render something
 * interactive", and `cell` returns `ReactNode`. There is no type that can
 * answer that: the cell may branch on the row, on a permission, on a
 * feature flag. Reading the rendered DOM after commit is the only place
 * the answer actually exists. It is, as the design note put it, a
 * mechanical check rather than a judgement call — so it is a `console.warn`
 * naming the column, not an error, and never a behaviour change.
 */

/**
 * What counts as "interactive" inside a card slot.
 *
 * Deliberately the same list the row-click guard in `DataTable` uses to
 * decide a click was NOT a row click, minus the form controls a cell has no
 * business rendering anyway. `a[href]` rather than `a`: a bare anchor with
 * no href is a styling hook, not a control.
 */
const INTERACTIVE_SELECTOR = 'button, a[href], input, select, [role="button"], [role="menuitem"]';

/**
 * The editorial ceiling on `mobile.fields`.
 *
 * `DataTableMobileConfig.fields` is typed `ColumnId[]` and not a 1–3 tuple
 * on purpose (see the long note on that field): a tuple rejects every
 * computed field list, and it would be a bound the type cannot honour
 * anyway because the rendered rows are the configured list INTERSECTED with
 * live column visibility. That note ends by saying the limit belongs
 * "where it can be — a dev-only warning at render". This is that warning.
 */
const MAX_FIELDS = 3;

/** Key used to mark the field-count warning as already said. Not a column
 *  id, and `mobile.fields` cannot contain a `#` — column ids are TS
 *  identifiers from a union — so it cannot collide with one. */
const FIELD_COUNT_KEY = '#field-count';

/** Same trick for the unresolved-title warning, and keyed on the offending
 *  id so a page whose column list changes behind a permission still gets the
 *  message for the SECOND id it got wrong. `#` cannot appear in a column id
 *  for the same reason as above. */
const TITLE_KEY_PREFIX = '#title:';

export interface DevWarnCardsOptions {
  /** How many field ids the consumer CONFIGURED, before the visibility
   *  intersection. The configured count is the one worth warning about —
   *  the rendered count can legitimately be anything from 0 to that. */
  configuredFieldCount: number;
  /**
   * `mobile.title` when it names a column that is not in `columns`.
   *
   * The one config miss the card tree cannot absorb quietly. `badge`,
   * `subtitle` and `fields` all degrade to "that slot is not drawn"; a title
   * that resolves to nothing would take the card's accessible NAME with it,
   * because `aria-labelledby` points at the title node. So `DataTableCards`
   * falls back to the first visible column instead — and the card the
   * reviewer then sees is headed by a column they did not choose, with
   * nothing on screen saying why. This is that "why".
   *
   * Undefined when the title resolved, which is every correctly configured
   * page.
   */
  unresolvedTitleId?: string;
  /**
   * What has already been said, for the lifetime of this card list.
   *
   * Owned by the caller as a ref, because "say it once" has to outlive a
   * single commit and this function is called on every one of them. A card
   * list re-commits for reasons that have nothing to do with its content —
   * the sticky-layout measurement pass alone does it — and a warning that
   * repeated on each of those would read as a growing problem rather than
   * as one message. Cleared naturally when the tree remounts, which is
   * correct: a new mount deserves the message again.
   */
  seen: Set<string>;
}

/**
 * Scan one mounted card list and warn about content that will not work
 * under a thumb.
 *
 * `root` is the `<ul>`; pass `null` (the ref before attach, or a list that
 * rendered its empty face) and only the config-shape check runs. Safe to
 * call on every commit — it returns immediately in production, and says
 * each thing at most once per mount.
 */
export function devWarnCards(root: ParentNode | null, options: DevWarnCardsOptions): void {
  if (process.env.NODE_ENV === 'production') return;
  const { configuredFieldCount, unresolvedTitleId, seen } = options;

  if (unresolvedTitleId !== undefined && !seen.has(TITLE_KEY_PREFIX + unresolvedTitleId)) {
    seen.add(TITLE_KEY_PREFIX + unresolvedTitleId);
    console.warn(
      `[DataTable] mobile.title names column "${unresolvedTitleId}", which is not in ` +
        "this table's `columns`. The card is falling back to the first visible column " +
        'for its headline, so every card is titled by a column nobody chose. Name a ' +
        'column that is actually built — a title built behind a permission or a feature ' +
        'flag has to be absent from mobile.title on the same render it is absent from ' +
        'columns.',
    );
  }

  if (configuredFieldCount > MAX_FIELDS && !seen.has(FIELD_COUNT_KEY)) {
    seen.add(FIELD_COUNT_KEY);
    console.warn(
      `[DataTable] mobile.fields lists ${configuredFieldCount} columns; keep it to ` +
        `${MAX_FIELDS}. Past that a card stops being scannable and becomes a table with ` +
        'extra steps.',
    );
  }

  if (!root) return;

  /**
   * One warning per offending COLUMN, not one per offending card.
   *
   * A cell that renders a button renders it on every row, so an unguarded
   * loop would emit the same message three hundred times on a long list and
   * bury everything else in the console. The column id is the unit of
   * repair, so it is also the unit of reporting.
   */
  for (const slot of Array.from(root.querySelectorAll<HTMLElement>('[data-dt-card-slot]'))) {
    const columnId = slot.dataset.dtColumnId ?? '(unknown column)';
    if (seen.has(columnId)) continue;
    const interactive = slot.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR);
    if (interactive.length === 0) continue;

    /**
     * The one interactive slot that is not a mistake: a title that IS the link.
     *
     * A card with no `onRowClick` renders no row-open button, so the only way
     * into the row is whatever the title column drew — and a page that does
     * that draws an `<a>`. `DataTableCards` floors that anchor at 44px (see the
     * `items-stretch` note on the title span), so it is the card's tap target
     * rather than a control smuggled into a value. Warning about it would be
     * telling the author to remove the only navigation the card has.
     *
     * Read off the DOM rather than passed in. The alternative was a new field
     * on `DevWarnCardsOptions` saying "this render took the no-onRowClick arm",
     * which every call site would have to keep in sync with a JSX branch in
     * another file; the arm is already legible in the tree it produced, so the
     * scan infers it and the options interface stays as it was.
     *
     * Four conditions, and each one is a case that still warns:
     *
     *   - the TITLE slot, because a field, subtitle or badge that renders a
     *     link is the original mistake and gets nothing from this exemption —
     *     those slots have no 44px floor;
     *   - NOT inside a `<button>`, which is how the `onRowClick` arm is told
     *     apart: there the slot sits inside the card's own row-open button, and
     *     a link nested in that button is precisely what this warning is for;
     *   - EXACTLY one control, because two links in one title are two tap
     *     targets sharing one 44px box and only one of them can be the card's;
     *   - and an anchor, because a `<button>` in the title of a click-less card
     *     is an action rather than navigation, and an action belongs in
     *     `mobile.rowActions` where the card gives it its own 44px trigger.
     */
    if (
      slot.dataset.dtCardSlot === 'title' &&
      !slot.closest('button') &&
      interactive.length === 1 &&
      interactive[0]?.tagName === 'A'
    ) {
      continue;
    }

    seen.add(columnId);
    console.warn(
      `[DataTable] card ${slot.dataset.dtCardSlot ?? 'field'} column "${columnId}" renders ` +
        'interactive content (a button, link, or input) inside the card. A card slot is a ' +
        'value, not a control: nested controls fight the card for the tap, and none of them ' +
        'are sized for a thumb. Move the action into mobile.rowActions.',
    );
  }
}

/**
 * Row-state tokens for data tables — the canonical, design-system-owned
 * visual treatment for the three states every list page exposes:
 *
 *   - `default`   — at rest, hover lifts to muted/40.
 *
 *   - `selected`  — the row is CHECKBOX-checked (bulk-action target).
 *                   Multiple rows can be in this state at once. The
 *                   entire row uses a SOFTER primary tint
 *                   (`--color-row-selected`) plus a 3px brand-orange
 *                   left-edge accent on the leading cell. The soft
 *                   fill says "these rows are batched" without
 *                   competing with whichever single row the user is
 *                   currently focused on.
 *
 *   - `active`    — exactly ONE row at a time is "active" — the row
 *                   currently open in a detail / edit drawer. It
 *                   uses a STRONGER primary tint (`--color-row-active`)
 *                   plus the SAME 3px brand-orange left-edge accent.
 *                   The stronger fill is the affordance: "this is
 *                   the row I'm looking at right now" — it visibly
 *                   stands out even inside a larger selection.
 *
 *   The two states share the left-edge accent so the leading cell
 *   reads as a coherent affordance across both; the fill intensity
 *   is what tells them apart.
 *
 * `selected` and `active` can both be true on the same row (a row in
 * the drawer that's also in the bulk-checkbox set). `active` wins
 * visually — `rowStateOf({ isSelected, isActive })` returns `active`
 * when both are true so the focused row keeps its accent bar.
 *
 * Three slots per state. Each one targets a different DOM node:
 *   - `row`         — the `<tr>` itself.
 *   - `cell`        — sticky `<td>`s that need OPAQUE backgrounds so
 *                     they occlude scrolling content underneath
 *                     (browsers don't render translucent backgrounds
 *                     correctly on `position: sticky` cells stacked
 *                     above other content).
 *   - `leadingCell` — the leftmost sticky cell. For `active` it
 *                     ADDS the 3px inset left-edge accent; for
 *                     `selected` it is identical to `cell` (no
 *                     accent on the bulk state — see above).
 *
 * Callers compose these via the `cls(...)` helper next to whatever
 * else they need for that node (padding density, borders, etc.).
 */

export type RowState = 'default' | 'selected' | 'active';

/** Resolve the row's visual state from selection / activity booleans.
 *  `active` wins over `selected` — see file header. */
export function rowStateOf({
  isSelected,
  isActive,
}: {
  isSelected: boolean;
  isActive: boolean;
}): RowState {
  if (isActive) return 'active';
  if (isSelected) return 'selected';
  return 'default';
}

export interface RowStateClasses {
  /** Applied to the `<tr>` element. Intentionally carries NO
   *  background. The background lives on every `<td>` so the leading
   *  (sticky) cell and the body cells are rendered the same way and
   *  can't visually diverge under any combination of stickiness,
   *  hover, or transition. */
  row: string;
  /** Applied to EVERY `<td>` in the row — sticky or not. Carries
   *  the background + hover behavior. Sticky cells get this same
   *  class for occlusion during horizontal scroll. */
  cell: string;
  /** Applied to the LEADING `<td>` (the checkbox column or the
   *  first sticky column when there's no checkbox). Same background
   *  + hover behavior as `cell` PLUS the 3px inset left-edge accent
   *  for `selected` / `active`. */
  leadingCell: string;
}

export const ROW_STATE_CLASSES: Record<RowState, RowStateClasses> = {
  default: {
    row: '',
    cell: 'bg-card group-hover:bg-row-hover',
    leadingCell: 'bg-card group-hover:bg-row-hover',
  },
  selected: {
    // SOLID `--color-row-selected` (= primary 15% pre-composited over
    // white). MUST be a solid color, not `bg-primary/15`: translucent
    // alpha layers compound between the <tr> and any sticky <td>,
    // making the leading cell visibly darker. Solid layers don't
    // compound. The background lives on EVERY cell (not on the row)
    // so there's no inherited-vs-own-bg asymmetry between body cells
    // and the leading cell.
    row: '',
    cell: 'bg-row-selected',
    leadingCell: 'bg-row-selected shadow-[inset_3px_0_0_var(--color-primary)]',
  },
  active: {
    row: '',
    cell: 'bg-row-active',
    leadingCell: 'bg-row-active shadow-[inset_3px_0_0_var(--color-primary)]',
  },
};

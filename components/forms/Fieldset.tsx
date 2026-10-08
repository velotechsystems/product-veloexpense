'use client';

/**
 * Fieldset — the canonical "group of related fields" anatomy.
 *
 * Wraps a group of Fields with a title, optional description, optional
 * help "?" tooltip, optional group-level errors, and an optional
 * collapsible affordance. Renders as a real HTML `<fieldset>` with a
 * screen-reader-only `<legend>` so the group gets a proper accessible
 * name; the visual title is a regular header row so we keep full
 * control of layout (chevron, tooltip, header-right `actions` slot).
 *
 * Two variants:
 *   - `card` (default) — bordered, padded container. Used for nested
 *     objects in schema forms and for any hand-built grouping.
 *   - `flat` — no border, no padding. Used when the group should
 *     blend into the surrounding form (e.g. the root form, a section
 *     inside a Drawer that already has chrome).
 *
 * Group-level errors render directly below the legend, using the same
 * anatomy as Field errors (alert icon + destructive text), so a group
 * with validation problems reads the same as a single field with
 * problems.
 *
 * Layout notes:
 *   - Title row's y-position is invariant: the help "?" tooltip and
 *     header `actions` are absolutely positioned at the top-right
 *     corner of the fieldset, so taller action buttons never push the
 *     title (or anything below it) down. The title row only contains
 *     the chevron + title.
 *   - Internal vertical rhythm is uniform: legend → description →
 *     errors → body all share the same gap.
 *   - When collapsed, the description optionally remains visible
 *     (`showDescriptionWhenCollapsed`) — useful when the description
 *     is the user's primary cue for whether to expand.
 */

import { type ReactNode, useId, useState } from 'react';
import { IconAlertCircle, IconChevronDown, IconChevronRight, IconHelpCircle } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { DescriptionText } from '@/components/ui/description-text';
import { Tooltip } from './Tooltip';

export interface FieldsetProps {
  /** Visible group title. Optional — array-of-objects items typically
   *  have no title and just inherit the bordered card visual. */
  title?: ReactNode;
  /** Static helper text rendered directly below the title. */
  description?: ReactNode;
  /** Hover help shown via a "?" icon next to the title. */
  tooltip?: ReactNode;
  /** Render a "(required)" marker on the title. */
  required?: boolean;
  /** Group-level validation messages — same anatomy as Field errors. */
  errors?: string[];
  /** When true, the title row becomes a button that toggles a chevron
   *  and shows/hides the group body. Use for long forms ("Advanced
   *  options") where collapsing reduces visual weight. */
  collapsible?: boolean;
  /** Initial collapsed state when `collapsible`. Defaults to false
   *  (group is expanded on mount). */
  defaultCollapsed?: boolean;
  /** When collapsible + collapsed, also hide the description (keep
   *  only the legend / title row visible). Defaults to false: the
   *  description stays visible because it usually tells the user
   *  whether to expand. */
  hideDescriptionWhenCollapsed?: boolean;
  /** Visual variant. `card` adds a rounded border + padding; `flat`
   *  removes both. Defaults to `card`. */
  variant?: 'card' | 'flat';
  /** Header-right slot, rendered in the top-right corner of the
   *  fieldset. Use for contextual actions like a remove "X" on
   *  array-of-objects items or a header-level menu / button.
   *  Absolutely positioned so taller action buttons never push the
   *  title row down. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Fieldset({
  title,
  description,
  tooltip,
  required,
  errors,
  collapsible,
  defaultCollapsed,
  hideDescriptionWhenCollapsed,
  variant = 'card',
  actions,
  className,
  children,
}: FieldsetProps) {
  const [collapsed, setCollapsed] = useState(Boolean(defaultCollapsed));
  const legendId = useId();
  const bodyId = useId();
  const hasErrors = Array.isArray(errors) && errors.length > 0;
  const showDescription = description && !(collapsed && hideDescriptionWhenCollapsed);

  const titleWithMarker = title ? (
    <>
      <span>{title}</span>
      {required ? (
        <span className="ml-1 font-normal text-destructive text-xs">(required)</span>
      ) : null}
    </>
  ) : null;

  // Title row: chevron + title + (required) + help "?" tooltip — all
  // inline. The help icon sits right after the title text rather than
  // in the corner; putting it in the corner collided with the
  // action-cluster space and made tooltip + actions read as two
  // unrelated controls. Now the help "?" is clearly tied to the
  // title.
  //
  // The row renders ONLY when there's a title. When `actions` are
  // present without a title (array-of-objects items), the row is
  // skipped entirely and the body gets top padding instead so it
  // doesn't bleed up under the absolutely-positioned action cluster.
  const titleRow = title ? (
    <div className="flex min-w-0 items-center gap-2 font-semibold text-foreground text-sm">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((c) => !c)}
          className="-mx-1 flex items-center gap-1.5 rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
          <span id={legendId}>{titleWithMarker}</span>
        </button>
      ) : (
        <span id={legendId}>{titleWithMarker}</span>
      )}
      {tooltip ? (
        <Tooltip content={tooltip}>
          <IconHelpCircle size={16} aria-label="More information" />
        </Tooltip>
      ) : null}
    </div>
  ) : null;

  // Right cluster carries ONLY actions now (help "?" moved inline with
  // the title above). Absolutely positioned so taller action buttons
  // never grow the title row's height.
  const rightCluster = actions ? (
    <div
      className={cn(
        'absolute flex shrink-0 items-center gap-1',
        variant === 'card' ? 'top-1.5 right-1.5' : 'top-0 right-0',
      )}
    >
      {actions}
    </div>
  ) : null;

  const errorsBlock = hasErrors ? (
    <ul className="space-y-1">
      {errors.map((e) => (
        <li key={e} className="flex items-start gap-1.5 text-destructive text-xs">
          <IconAlertCircle size={14} className="mt-px shrink-0" aria-hidden />
          <span>{e}</span>
        </li>
      ))}
    </ul>
  ) : null;

  // The "header" cluster (legend + description + errors) uses tighter
  // 8px rhythm — they're three rows describing the same group, so they
  // read as a single block. The body is offset by a full 16px so the
  // first field clearly starts a new section.
  const hasHeader = Boolean(title) || showDescription || hasErrors;
  // When `actions` are present without a title, the body needs top
  // padding to clear the absolutely-positioned action cluster (the
  // array-of-objects item case). With a title, the title row already
  // occupies that band so no extra offset is needed.
  const needsActionGutter = Boolean(actions) && !title && !hasHeader;
  return (
    <fieldset
      // Browsers default <fieldset> to a thin border + a legend that
      // floats above it. Reset everything so we can compose the visual
      // ourselves. Real accessibility comes from <legend> below.
      aria-labelledby={title ? legendId : undefined}
      className={cn(
        // `mx-0` only — leaving `margin-top` free so a parent's
        // `space-y-*` (e.g. SchemaForm's `space-y-4`) can push sibling
        // Fieldsets apart. Using `m-0` here zeroed that margin and
        // glued cards together.
        'relative mx-0 min-w-0 border-0 p-0',
        variant === 'card' && 'rounded-md border border-border bg-card p-4',
        className,
      )}
    >
      {/* The legend stays in the DOM (for the accessible name) but is
          visually hidden — the styled header row above is what users see. */}
      {title ? <legend className="sr-only">{title}</legend> : null}
      {rightCluster}
      {hasHeader && (
        <div className="space-y-2">
          {titleRow}
          {/* Description + group-level errors live OUTSIDE the collapsible
              body so they remain visible when collapsed by default —
              collapsing should never hide validation problems, and the
              description usually tells the user whether to expand. */}
          {showDescription ? <DescriptionText>{description}</DescriptionText> : null}
          {errorsBlock}
        </div>
      )}
      {!collapsed ? (
        // Uniform `space-y-4` rhythm — same gap at every nesting
        // level (root, Fieldset body, array items). The `mx-0` reset
        // on the fieldset element above lets that parent margin
        // actually apply to sibling Fieldsets without being zeroed.
        <div
          id={bodyId}
          className={cn(
            'space-y-4',
            hasHeader && 'mt-4',
            // Reserve a band at the top for the floating action cluster
            // when there's no title row above to occupy that space.
            needsActionGutter && 'pt-4',
          )}
        >
          {children}
        </div>
      ) : null}
    </fieldset>
  );
}

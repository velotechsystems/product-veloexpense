'use client';

/**
 * Field — the single canonical field anatomy for ExpenseOS forms.
 *
 * Both form systems render through this: the RJSF <SchemaForm> templates and
 * any hand-built form. Keeping the anatomy in one place is how the two
 * converge.
 *
 * Anatomy (top to bottom):
 *   label (+ "(required)"/"(optional)") + tooltip "?" icon
 *   description        — static helper, directly below the label
 *   control            — the input/select/checkbox/etc. (children)
 *   hint               — dynamic guidance, optionally named (e.g.
 *                        "Password requirements:" + a live checklist)
 *   errors             — one line per message, each with an alert icon,
 *                        spanning the field width
 *
 * Booleans and array items pass `hideLabel` (their label lives elsewhere).
 */

import { Tooltip as TooltipPrimitive } from '@base-ui-components/react/tooltip';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import { IconAlertCircle, IconHelpCircle } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { DescriptionText } from '@/components/ui/description-text';
import { Label } from '@/components/ui/label';
import { Tooltip } from '../Tooltip';

/**
 * Inline-mode description tooltip — uses base-ui Tooltip directly with
 * `render` so the trigger attaches to the existing label element
 * without adding visible chrome. Fires on hover over the label only —
 * the control cell is left untouched so any inner tooltips (e.g. on
 * individual radio options) own their own hover region. Delay matches
 * the standard Tooltip (0ms) so it feels consistent with the help "?".
 */
function InlineDescriptionTip({
  description,
  children,
}: {
  description: ReactNode;
  children: ReactElement;
}) {
  return (
    <TooltipPrimitive.Provider delay={0} closeDelay={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger render={children as ReactElement<Record<string, unknown>>} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            side="bottom"
            sideOffset={6}
            positionMethod="fixed"
            className="z-[70]"
          >
            <TooltipPrimitive.Popup
              className={cn(
                'z-[70] max-w-xs rounded-md border border-input bg-popover px-2.5 py-1.5 text-popover-foreground text-xs leading-relaxed shadow-md',
                'data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:animate-out data-[open]:animate-in',
              )}
            >
              {description}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * `<AlignedFields>` opts a group of inline Fields into a *shared* label
 * column — every label inside the wrapper resolves to the same width, so
 * the controls form a clean second column across all fields. Without this
 * wrapper, an inline Field sizes its label to its own content (each row is
 * independent of its siblings).
 *
 * Naming: `aligned` describes the visual outcome (labels aligned in one
 * column). Use `<AlignedFields>` for "settings"-style forms with many
 * short labels where eye-flow benefits from a shared gutter. Use plain
 * `<Field inline>` (no wrapper) when fields stand alone — e.g. inside a
 * row of independent controls.
 */
const AlignedFieldsContext = createContext(false);

export function AlignedFields({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <AlignedFieldsContext.Provider value={true}>
      <div
        className={cn(
          'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2',
          className,
        )}
      >
        {children}
      </div>
    </AlignedFieldsContext.Provider>
  );
}

export interface FieldProps {
  /** id of the control, for label association. */
  htmlFor?: string;
  label?: ReactNode;
  required?: boolean;
  /** Render a "(optional)" marker. Mutually exclusive with `required`. */
  optional?: boolean;
  /** Hover help shown via a "?" icon next to the label. */
  tooltip?: ReactNode;
  /** Static helper text, rendered directly below the label. */
  description?: ReactNode;
  /** Dynamic guidance below the control (e.g. a live password-policy checklist). */
  hint?: ReactNode;
  /** Optional heading for the hint block, e.g. "Password requirements:". */
  hintLabel?: ReactNode;
  /** Validation messages — one line each, with an alert icon. */
  errors?: string[];
  /** Suppress the visible label (booleans / array items render it elsewhere). */
  hideLabel?: boolean;
  /**
   * Lay the label horizontally next to the control instead of stacked above.
   * The help "?" icon stays inline next to the label, description is
   * suppressed, and errors / hints render below the control only (aligned
   * with the control's column).
   */
  inline?: boolean;
  /**
   * Where the control sits relative to the label in stacked layout:
   *   - 'block' (default) — label above, control below.
   *   - 'inline-leading'  — control first, label text on the same row.
   *     Used for boolean checkboxes and similar leading-control patterns
   *     where the label reads as a question the control answers.
   *
   * Description, tooltip, errors, and hints stay in their normal slots
   * below the row. Only meaningful in stacked layout — when `inline` is
   * set, the label/control split is governed by the inline-form columns
   * and this prop has no effect.
   */
  controlPosition?: 'block' | 'inline-leading';
  children: ReactNode;
}

export function Field({
  htmlFor,
  label,
  required,
  optional,
  tooltip,
  description,
  hint,
  hintLabel,
  errors,
  hideLabel,
  inline,
  controlPosition = 'block',
  children,
}: FieldProps) {
  const showLabel = !hideLabel && Boolean(label);
  const hasErrors = Array.isArray(errors) && errors.length > 0;
  // The help "?" icon only renders when there's ALSO a description.
  // The tooltip is anatomy that elaborates on the description; without
  // a description, the affordance has nothing to layer on, so we hide
  // it. Callers can still set `tooltip` standalone if they really want
  // it — the icon just won't appear unless description is also set.
  const showTooltipIcon = Boolean(tooltip) && Boolean(description);
  // Read at the top so the hook order stays stable regardless of which
  // layout branch we take. Defaults to `false` outside the provider.
  const aligned = useContext(AlignedFieldsContext);

  // Label + (required)/(optional) marker + inline tooltip "?" — shared by
  // both layouts. In stacked mode the tooltip is right-pinned via the
  // surrounding row; in inline mode the tooltip stays directly next to the
  // label text.
  // Help "?" pins to the right edge of the label cell in both layouts.
  // In stacked mode the label row spans the field's full width, so the
  // icon lands at the right edge of the field. In aligned-inline mode
  // the label cell width is the shared label-column width (sized to the
  // widest label across the form), so the icon lands at the right edge
  // of that column — consistent across rows regardless of which label
  // text is shortest.
  const labelBlock = showLabel ? (
    // `w-full` lets `justify-between` actually push the help icon to the
    // cell's right edge — without it, the flex container shrinks to its
    // content width and the icon sits glued to the label text.
    <div className="flex w-full items-center justify-between gap-2">
      <Label
        htmlFor={htmlFor}
        // `leading-4` (16px line-height) makes the label's vertical metrics
        // match the standard 16px controls (Checkbox / Radio), so an inline
        // row with `items-center` aligns the control's center with the
        // label text's center. The default `leading-none` gives a 14px
        // line-box that drifts ~2-3px out of alignment with 16px controls.
        className={cn('block', inline && 'leading-4')}
      >
        {label}
        {required ? (
          <span className="ml-1 font-normal text-destructive text-xs">(required)</span>
        ) : optional ? (
          <span className="ml-1 font-normal text-muted-foreground text-xs">(optional)</span>
        ) : null}
      </Label>
      {showTooltipIcon ? (
        <Tooltip content={tooltip}>
          <IconHelpCircle size={20} aria-label="More information" />
        </Tooltip>
      ) : null}
    </div>
  ) : null;

  const errorsBlock = hasErrors ? (
    <ul className="w-full space-y-1">
      {errors.map((e) => (
        <li key={e} className="flex items-start gap-1.5 text-destructive text-xs">
          <IconAlertCircle size={14} className="mt-px shrink-0" aria-hidden />
          <span>{e}</span>
        </li>
      ))}
    </ul>
  ) : null;

  const hintBlock = hint ? (
    <div className="space-y-1 pt-1.5">
      {hintLabel ? <p className="font-medium text-foreground text-xs">{hintLabel}</p> : null}
      {hint}
    </div>
  ) : null;

  // Inline layout: label sits left of the control on the same row; the
  // help tooltip ("?") stays next to the label. `description` in inline
  // mode does NOT render as static text under the control — instead it
  // becomes a hover tooltip attached to the label element only. The
  // control cell is intentionally NOT wrapped so per-control tooltips
  // (e.g. per-option tooltips on a radio group) keep ownership of their
  // hover region without the field-level description bleeding through.
  // Errors + hints still render below the control as a separate row.
  if (inline) {
    // Inside `<AlignedFields>`, the parent owns the grid columns — render
    // a fragment so this Field's label + control land directly in the
    // parent grid and align with siblings. Standalone (no wrapper) Field
    // wraps itself in a one-row grid so it sizes its own column.
    //
    // The description tooltip attaches only to the Label element — NOT
    // to the help "?" icon's region and NOT to the control cell. The
    // "?" icon fires its own help tooltip; the control cell is left
    // plain so any inner tooltips (e.g. per-option radio tooltips)
    // remain the only thing that fires when the pointer enters them.
    // `min-h-10` on both cells gives every inline field the same row
    // height as a text input (h-10 = 40px). `items-center` centers each
    // cell's content vertically in the 40px row.
    const labelInner = showLabel ? (
      <Label htmlFor={htmlFor} className={cn('block', 'leading-4')}>
        {label}
        {required ? (
          <span className="ml-1 font-normal text-destructive text-xs">(required)</span>
        ) : optional ? (
          <span className="ml-1 font-normal text-muted-foreground text-xs">(optional)</span>
        ) : null}
      </Label>
    ) : (
      <span />
    );
    const labelWithDesc = description ? (
      <InlineDescriptionTip description={description}>{labelInner}</InlineDescriptionTip>
    ) : (
      labelInner
    );
    const labelCell = (
      <div className="flex min-h-10 w-full items-center justify-between gap-2">
        {labelWithDesc}
        {tooltip ? (
          <Tooltip content={tooltip}>
            <IconHelpCircle size={20} aria-label="More information" />
          </Tooltip>
        ) : null}
      </div>
    );
    // Control cell stays plain — the description tooltip lives on the
    // label only. Wrapping the control too would steal hover events from
    // anything the caller renders inside (e.g. per-option tooltips on a
    // radio group, or any interactive widget with its own hover affordance).
    // `w-full` makes children that opt into the full track width (Input,
    // Select, etc.) actually expand to the grid column instead of
    // shrinking to their intrinsic width inside the flex container.
    const controlCell = <div className="flex min-h-10 w-full min-w-0 items-center">{children}</div>;
    const body = (
      <>
        {labelCell}
        {controlCell}
        {(errorsBlock || hintBlock) && (
          <>
            <div />
            <div className="space-y-1.5">
              {errorsBlock}
              {hintBlock}
            </div>
          </>
        )}
      </>
    );
    if (aligned) return body;
    return (
      <div className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        {body}
      </div>
    );
  }

  // Stacked layout with leading control: control comes first, label
  // text follows on the same row. The "label cell" still owns the help
  // "?" icon so it sits at the end of the row. Description / errors /
  // hints stay in their normal slots below. Used for single-checkbox
  // booleans (and any similar "[box] question text" pattern).
  if (controlPosition === 'inline-leading') {
    const leadingLabel = showLabel ? (
      <Label htmlFor={htmlFor} className="font-normal leading-4">
        {label}
        {required ? (
          <span className="ml-1 font-normal text-destructive text-xs">(required)</span>
        ) : optional ? (
          <span className="ml-1 font-normal text-muted-foreground text-xs">(optional)</span>
        ) : null}
      </Label>
    ) : null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {children}
          {leadingLabel}
          {showTooltipIcon ? (
            <Tooltip content={tooltip}>
              <IconHelpCircle size={18} aria-label="More information" />
            </Tooltip>
          ) : null}
        </div>
        {/* Description / errors / hint indent past the leading control
            so they align under the label text (not the box). `pl-6` =
            16px control + 8px gap = the natural x-position of the label
            text in the row above. */}
        {description ? (
          <div className="pl-6">
            <DescriptionText>{description}</DescriptionText>
          </div>
        ) : null}
        {errorsBlock ? <div className="pl-6">{errorsBlock}</div> : null}
        {hintBlock ? <div className="pl-6">{hintBlock}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {labelBlock}
      {/* Description sits directly below the label, above the control. */}
      {description ? <DescriptionText>{description}</DescriptionText> : null}
      {children}
      {/* Errors go immediately below the control. */}
      {errorsBlock}
      {/* Hints come after errors, with extra space so they're not glued. */}
      {hintBlock}
    </div>
  );
}

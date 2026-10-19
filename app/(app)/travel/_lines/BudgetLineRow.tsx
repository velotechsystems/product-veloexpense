'use client';

/**
 * The two rows every budget item shows, whatever its kind and wherever it is being
 * written — a saved request's drawer or the create form.
 *
 *     [ category (2/3) ][ amount (1/3) ]  🗑
 *     [ notes                          ]
 *
 * ## Why it is one component
 *
 * It was three copies of the same markup, and they had already drifted. The create form
 * wrapped each control in its own `Field`, which renders a label block of its own — so the
 * "Category" label sat six pixels above "Amount", and the two controls with it. Measured in
 * a browser: category at y=612, amount at y=618. Two `Field`s side by side cannot be relied
 * on to line up, because each sizes its own label area.
 *
 * One label ROW above one control ROW, sharing the same flex proportions, makes the
 * alignment structural: the label is over its control because it is the same column, not
 * because the two happened to compute the same height.
 *
 * ## The trash sits OUTSIDE both rows
 *
 * It used to be the third item in row 1, which pushed the amount's right edge ~48px short
 * of the notes box below it — a ragged edge down the side of every budget item. Outside,
 * the category, the amount and the notes all end on the same line and the delete
 * affordance reads as belonging to the whole item, which is what it deletes.
 */

import { Button, Input } from '@expenseos/design-system';
// VeloExpense (w6-02): the vendored kit does not re-export `IconTrash`; it is Tabler's icon.
import { IconTrash } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import type { ReactNode, Ref } from 'react';

export function BudgetLineRow({
  /** The category cell — a picker while the item is a draft, its name once it is saved. */
  category,
  amount,
  /** What sits directly under the amount and before the notes: the derivation the figure
   *  came from, and the warning when the figure no longer matches it. Under the AMOUNT
   *  because that is what they are about — a caption after the notes would read as being
   *  about the notes. */
  caption,
  notes,
  /** The kind's own fields, under the notes and with no rule between them: a separator
   *  would say the fare search is a different thing from the line, and it is the line. */
  children,
  onRemove,
  removeLabel,
  removeDisabled,
  showLabels,
}: {
  category: ReactNode;
  amount: ReactNode;
  caption?: ReactNode;
  notes: ReactNode;
  children?: ReactNode;
  onRemove?: () => void;
  removeLabel: string;
  removeDisabled?: boolean;
  /** Label the two columns. The create form does, because the row is the first thing a
   *  traveller meets there; a saved item's own name and figure need no caption. */
  showLabels?: boolean;
}) {
  const t = useTranslations('travel');
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col">
        {showLabels && (
          // The same proportions as the control row below, so a label is over its control
          // by construction rather than by coincidence.
          <div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-[2]">{t('detail.plannedCategory')}</span>
            <span className="min-w-0 flex-1">{t('detail.plannedAmount')}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-[2] items-center gap-2">{category}</div>
          <div className="min-w-0 flex-1">{amount}</div>
        </div>
        {caption}
        <div className="mt-2">{notes}</div>
        {children}
      </div>
      {onRemove && (
        <Button
          size="sm"
          variant="ghost"
          // `mt-0.5` rather than centred: the button belongs to the item, and lining it up
          // with the first row is what says so on an item that has grown four fields tall.
          className="mt-0.5 shrink-0"
          aria-label={removeLabel}
          disabled={removeDisabled}
          onClick={onRemove}
        >
          <IconTrash className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * The notes field, identical wherever the row is rendered.
 *
 * `required` is the override case. The server refuses a typed figure that replaces a
 * policy-derived one unless the line says why, and the field is where it has to be said —
 * so while the amount differs from the derivation the field announces itself as required,
 * reports itself invalid until something is written, and says in a sentence what it is
 * waiting for. Mirrored from the server rule, not a substitute for it.
 */
export function BudgetLineNotes({
  ref,
  value,
  disabled,
  required,
  onChange,
  onBlur,
}: {
  /** So a refused override can hand focus to the field that unblocks it. */
  ref?: Ref<HTMLInputElement>;
  value: string;
  disabled?: boolean;
  /** True while an override is pending and nothing explains it yet. */
  required?: boolean;
  onChange: (v: string) => void;
  onBlur?: () => void;
}) {
  const t = useTranslations('travel');
  const missing = required === true && !value.trim();
  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={ref}
        aria-label={t('line.notes')}
        aria-required={required === true || undefined}
        aria-invalid={missing || undefined}
        maxLength={2000}
        placeholder={t('line.notesPlaceholder')}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {missing && (
        <p className="text-amber-700 text-xs dark:text-amber-500">
          {t('line.noteRequiredForOverride')}
        </p>
      )}
    </div>
  );
}

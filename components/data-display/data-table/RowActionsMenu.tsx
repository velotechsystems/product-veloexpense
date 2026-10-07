'use client';

import { IconDotsVertical } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cls } from './helpers';
import { MenuDivider, MenuItem } from './Menu';

/**
 * A single action shown in a row's kebab menu.
 *
 * - `divider: true` renders a horizontal rule and ignores every other
 *   field — useful for grouping items like "View / Edit | Deactivate".
 * - `destructive: true` paints the row in destructive colours (red on
 *   hover) without changing default styling.
 */
export type RowAction =
  | { divider: true }
  | {
      id: string;
      icon: ReactNode;
      label: string;
      onClick: () => void;
      destructive?: boolean;
      disabled?: boolean;
    };

/**
 * How large the kebab trigger's own box is.
 *
 * `'sm'` is the historical 24x24 and stays the DEFAULT, so not one of the
 * existing call sites moves: inside a table row the kebab shares a 36-52px
 * cell with text, and growing it to 44 there would force every row taller
 * than its density setting asks for. A table row is also not a touch
 * surface in practice — the compact tree is what a phone gets.
 *
 * `'touch'` is 44x44, the tap-target minimum this epic committed to (WCAG
 * 2.2 SC 2.5.8 asks 24x24 as its floor; 44 is what Apple's HIG and
 * Material both publish, and it is the number the mobile epic settled on).
 * It exists because the card tree puts the kebab on a phone, alone at the
 * right edge of a card, as the only way to reach a row's actions.
 */
export type RowActionsTriggerSize = 'sm' | 'touch';

/**
 * Box and glyph, kept together because they are one decision.
 *
 * THE GLYPH GROWS WITH THE BOX, and that is the deliberate half. It would
 * have been cheaper to leave the icon at 14 and just widen the hit area,
 * and it would have been the wrong kind of cheap: people aim at the mark
 * they can see, not at the invisible rectangle around it. A 14px kebab
 * floating in a 44px box reads as decoration, the extra 30px of real
 * target never gets used, and the control tests as compliant while still
 * being missed — the same failure as a 44px box wrapping a 24px trigger,
 * just from the other direction.
 *
 * 18, not 24 (Material's icon-in-a-48dp-target figure): the mark here is a
 * vertical column of three dots, so its visual weight is its HEIGHT, and
 * 24px of dots crowds the top-right corner of a 360px card against a title
 * set in 14px. 18 reads as a control at arm's length and still sits inside
 * the card's type scale.
 */
const TRIGGER_SIZE: Record<RowActionsTriggerSize, { box: string; icon: number }> = {
  sm: { box: 'h-6 w-6', icon: 14 },
  touch: { box: 'h-11 w-11', icon: 18 },
};

/**
 * Kebab trigger + popover that lists per-row actions. Actions are
 * supplied by the caller via the `actions` prop. Clicking any item
 * closes the popover automatically.
 */
export function RowActionsMenu({
  actions,
  ariaLabel,
  footer,
  triggerSize = 'sm',
}: {
  actions: RowAction[];
  ariaLabel: string;
  /** Optional small text below the action list (e.g. "Coming soon"). */
  footer?: ReactNode;
  /**
   * Size of the kebab's own box. Defaults to `'sm'` (24x24) so every
   * existing table call site renders exactly as before; the card tree
   * passes `'touch'` (44x44). See `TRIGGER_SIZE`.
   */
  triggerSize?: RowActionsTriggerSize;
}) {
  const [open, setOpen] = useState(false);
  const size = TRIGGER_SIZE[triggerSize];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cls(
          'inline-flex shrink-0 items-center justify-center rounded text-foreground hover:bg-muted',
          size.box,
        )}
      >
        <IconDotsVertical size={size.icon} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-56 p-1">
        <div className="space-y-0.5">
          {actions.map((a, i) => {
            if ('divider' in a) {
              // biome-ignore lint/suspicious/noArrayIndexKey: dividers carry no identity
              return <MenuDivider key={`d-${i}`} />;
            }
            return (
              <MenuItem
                key={a.id}
                icon={a.icon}
                destructive={a.destructive}
                // Forwarded so a disabled action looks disabled and reports as
                // such; without it the item read as clickable and no-oped.
                disabled={a.disabled}
                onClick={() => {
                  if (a.disabled) return;
                  setOpen(false);
                  a.onClick();
                }}
              >
                {a.label}
              </MenuItem>
            );
          })}
        </div>
        {footer && (
          <div className="mt-1 border-border border-t px-2 pt-1 text-[10px] text-muted-foreground">
            {footer}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

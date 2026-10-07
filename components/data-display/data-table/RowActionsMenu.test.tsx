import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RowAction } from './RowActionsMenu';
import { RowActionsMenu } from './RowActionsMenu';

/**
 * The kebab's TRIGGER, which is the only part of this component the mobile
 * epic changed.
 *
 * Why the assertions below are on classes rather than on measured pixels:
 * jsdom has no layout engine, so `getBoundingClientRect()` returns zeroes
 * for everything and a test that asked "is this 44px?" would pass on a 6px
 * button. The class IS the size here — `h-11 w-11` is Tailwind's 2.75rem —
 * so pinning the class pins the only thing that decides the number. A real
 * measurement belongs in the visual/e2e layer, not here.
 *
 * This is NOT the cloak-class exception QA barred: that rule is about
 * `CARDS_ONLY` / `TABLE_ONLY`, which are inert in jsdom and describe a
 * mechanism (pre-hydration hiding) rather than an outcome. A tap target's
 * size is the outcome.
 */

const ACTIONS: RowAction[] = [
  { id: 'open', icon: null, label: 'Open', onClick: () => {} },
  { divider: true },
  { id: 'archive', icon: null, label: 'Archive', onClick: () => {}, destructive: true },
];

describe('<RowActionsMenu> trigger size', () => {
  it('is 24x24 by default — no existing table call site moves', () => {
    render(<RowActionsMenu actions={ACTIONS} ariaLabel="Row actions" />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger).toHaveClass('h-6', 'w-6');
    expect(trigger).not.toHaveClass('h-11');
  });

  it('is 24x24 when the caller asks for it explicitly', () => {
    render(<RowActionsMenu actions={ACTIONS} ariaLabel="Row actions" triggerSize="sm" />);
    expect(screen.getByRole('button', { name: 'Row actions' })).toHaveClass('h-6', 'w-6');
  });

  it('is 44x44 under triggerSize="touch" — the tap-target minimum, on the trigger itself', () => {
    // The point of the prop. A 44px WRAPPER around a 24px button satisfies
    // nothing: the hit area is the button. So the class has to land here.
    render(<RowActionsMenu actions={ACTIONS} ariaLabel="Row actions" triggerSize="touch" />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger).toHaveClass('h-11', 'w-11');
    expect(trigger).not.toHaveClass('h-6', 'w-6');
  });

  it('grows the glyph with the box, so the visible mark matches the target', () => {
    // People aim at the mark, not at the rectangle. A 14px kebab adrift in a
    // 44px box is compliant and still gets missed — see TRIGGER_SIZE's note.
    const { container: small } = render(
      <RowActionsMenu actions={ACTIONS} ariaLabel="Small" triggerSize="sm" />,
    );
    const { container: touch } = render(
      <RowActionsMenu actions={ACTIONS} ariaLabel="Touch" triggerSize="touch" />,
    );
    // Tabler renders `size` onto the <svg>'s width/height attributes.
    expect(small.querySelector('svg')).toHaveAttribute('width', '14');
    expect(touch.querySelector('svg')).toHaveAttribute('width', '18');
  });

  it('keeps its accessible name and its behaviour at either size', () => {
    const onClick = vi.fn();
    render(
      <RowActionsMenu
        actions={[{ id: 'open', icon: null, label: 'Open', onClick }]}
        ariaLabel="Actions for Ada"
        triggerSize="touch"
      />,
    );
    // The name comes from `ariaLabel`, not from the glyph — the trigger has
    // no text, so without it the button announces as "button".
    const trigger = screen.getByRole('button', { name: 'Actions for Ada' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByText('Open'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

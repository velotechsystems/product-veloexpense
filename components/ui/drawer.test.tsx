import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Drawer, DrawerBody, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

/**
 * `side` — the one thing the mobile epic added to `Drawer`, plus the two
 * pre-existing behaviours it must not have disturbed.
 *
 * Assertions are on classes and on the inline style rather than on measured
 * pixels: jsdom has no layout engine, so every `getBoundingClientRect()` is
 * zeroes and a test asking "is this pinned to the bottom?" would pass on a
 * drawer pinned to the right. The class is the position here.
 *
 * The inline-style assertions are not stylistic nit-picking. An inline style
 * beats a class, so a bottom sheet that still received `width: 480px` would
 * lose its `w-full` and sit in a 480px column in the corner of a 360px
 * phone — visibly wrong, and invisible to any class-only assertion.
 */

function renderDrawer(
  props: Record<string, unknown> = {},
  rootProps: Record<string, unknown> = {},
) {
  return render(
    <Drawer defaultOpen {...rootProps}>
      <DrawerContent {...props}>
        <DrawerHeader>
          <DrawerTitle>Panel</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>body</DrawerBody>
      </DrawerContent>
    </Drawer>,
  );
}

describe('side="right" — the default, and every drawer that already existed', () => {
  it('pins to the right edge at full height', () => {
    renderDrawer();
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveClass('top-0', 'right-0', 'h-full', 'border-l');
    expect(panel).not.toHaveClass('bottom-0');
  });

  it('keeps its inline pixel width', () => {
    renderDrawer();
    expect(screen.getByRole('dialog')).toHaveStyle({ width: '480px' });
  });

  it('still honours an explicit width', () => {
    renderDrawer({ width: 600 });
    expect(screen.getByRole('dialog')).toHaveStyle({ width: '600px' });
  });

  it('still offers the resize handle', () => {
    renderDrawer({ resizable: true });
    expect(screen.getByLabelText('Resize drawer')).toBeInTheDocument();
  });
});

describe('side="bottom" — the phone sheet', () => {
  it('spans the bottom edge with rounded top corners', () => {
    renderDrawer({ side: 'bottom' });
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveClass('inset-x-0', 'bottom-0', 'w-full', 'rounded-t-2xl', 'border-t');
    expect(panel).not.toHaveClass('right-0', 'h-full');
  });

  it('is capped short of the viewport top, in dvh', () => {
    // `dvh`, not `vh`: on a phone `vh` is measured against a viewport the
    // browser chrome is covering part of, so a `vh` cap leaves the top of
    // the sheet under the URL bar.
    renderDrawer({ side: 'bottom' });
    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-4rem)]');
  });

  it('clears the home indicator', () => {
    renderDrawer({ side: 'bottom' });
    expect(screen.getByRole('dialog')).toHaveClass('pb-[env(safe-area-inset-bottom)]');
  });

  it('takes NO inline width — `w-full` has to win', () => {
    renderDrawer({ side: 'bottom' });
    expect(screen.getByRole('dialog').style.width).toBe('');
  });

  it('ignores `width` even when a caller passes one', () => {
    renderDrawer({ side: 'bottom', width: 600 });
    expect(screen.getByRole('dialog').style.width).toBe('');
  });

  it('drops the resize handle — it drags horizontally and nothing here is', () => {
    renderDrawer({ side: 'bottom', resizable: true });
    expect(screen.queryByLabelText('Resize drawer')).not.toBeInTheDocument();
  });

  it('still passes a caller className through', () => {
    renderDrawer({ side: 'bottom', className: 'test-hook' });
    expect(screen.getByRole('dialog')).toHaveClass('test-hook');
  });
});

describe('dismissal — unchanged by `side`', () => {
  it('ignores Esc by default, so a half-filled form survives a stray key', async () => {
    renderDrawer({ side: 'bottom' });
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Esc when the caller asks for it', async () => {
    // What the filter and sort sheets pass. Nothing there is a draft, so
    // trapping the reader over their own list buys nothing.
    renderDrawer({ side: 'bottom' }, { dismissible: true });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the close button', () => {
  it('is there by default', () => {
    renderDrawer();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('can be withheld — the sheets do, because 24px is not a tap target', () => {
    renderDrawer({ side: 'bottom', hideCloseButton: true });
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });
});

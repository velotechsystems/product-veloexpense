import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The top-bar entry point.
 *
 * Two decisions live in these twenty lines, and both are about what happens on pages where
 * nobody is going to use the assistant at all:
 *
 *   · **The panel mounts only once opened, and stays mounted after.** It is the only
 *     surface in the app that holds an open HTTP stream, and a component rendered on every
 *     page ought not to be doing that before anybody has asked it anything. But unmounting
 *     on close would throw away the conversation — reopening has to land somebody back in
 *     the thread they were in, which is the whole point of persisting them.
 * Whether the button appears at all is the TOP BAR's decision, not this component's — it
 * renders the launcher only where the `assistant` module is active, and `TopBar.test.tsx`
 * covers that gate. Everything below assumes it is on screen.
 */

const h = vi.hoisted(() => ({ mounts: 0, lastOpen: undefined as boolean | undefined }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/components/assistant/AssistantPanel', () => ({
  AssistantPanel: ({ open }: { open: boolean }) => {
    h.lastOpen = open;
    return <div data-testid="panel">{open ? 'open' : 'closed'}</div>;
  },
}));

import { AssistantLauncher } from './AssistantLauncher';

beforeEach(() => {
  h.mounts = 0;
  h.lastOpen = undefined;
});

describe('before anybody presses it', () => {
  it('renders the button but not the panel', async () => {
    /** No panel means no open stream on a page somebody is only passing through. */
    render(<AssistantLauncher />);
    expect(screen.getByRole('button', { name: 'open' })).toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('says it is closed to assistive technology', async () => {
    render(<AssistantLauncher />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('how it looks', () => {
  it('wears the brand orange, not the muted grey of the controls beside it', () => {
    /** The design system's `primary` is the brand orange; its hover steps to the dark shade. */
    render(<AssistantLauncher />);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('text-primary', 'hover:text-brand-orange-dark');
    expect(button).not.toHaveClass('text-muted-foreground');
  });
});

describe('opening and closing', () => {
  it('mounts the panel on the first press', async () => {
    const user = userEvent.setup();
    render(<AssistantLauncher />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('panel')).toHaveTextContent('open');
  });

  it('re-labels itself, so the button says what pressing it will do', async () => {
    const user = userEvent.setup();
    render(<AssistantLauncher />);
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByRole('button', { name: 'close' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the panel mounted after closing, so the thread survives', async () => {
    /**
     * Unmounting would discard the conversation and the next press would start a new one.
     * Closed-but-mounted is what lets somebody shut the panel, read the report it was
     * telling them about, and carry on where they left off.
     */
    const user = userEvent.setup();
    render(<AssistantLauncher />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    expect(screen.getByTestId('panel')).toHaveTextContent('closed');
    expect(h.lastOpen).toBe(false);
  });

  it('reopens the same panel rather than a second one', async () => {
    const user = userEvent.setup();
    render(<AssistantLauncher />);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button'));
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
    expect(h.lastOpen).toBe(true);
  });
});

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The one-time token display, shared by both key surfaces.
 *
 * Three properties are asserted here rather than in either consumer's suite, because they
 * are properties of the SHARED component and duplicating them would let the two surfaces
 * drift apart while both suites stayed green — which is the thing sharing this component
 * was meant to prevent.
 *
 *   · **It is not a form control.** The token used to render in a `<Textarea>`, where a
 *     browser spellchecker may transmit it and a password manager may offer to vault it.
 *   · **Focus lands on the value.** With `user-select: all` on it, that puts a keyboard
 *     user one Ctrl+C away from the secret.
 *   · **A failed copy says so.** The old call was unguarded: in a non-secure context the
 *     promise rejects inside an async `onClick`, "Copied" never arrives, and the user gets
 *     silence at the one moment the token is recoverable.
 */

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (k: string) => `${ns}.${k}`;
    t.has = () => false;
    return t;
  },
}));

import { TokenReveal } from './TokenReveal';

const TOKEN = 'eos_live_9f2a.SECRET';
const token = () => screen.getByText(TOKEN);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TokenReveal', () => {
  it('renders the token outside any form control', () => {
    /**
     * `queryByDisplayValue` is the assertion that matters: it matches inputs, textareas and
     * selects and nothing else, so its absence is exactly "the secret is not in a form
     * control". Checking for a `<code>` tag alone would still pass with a hidden input
     * beside it.
     */
    render(<TokenReveal token={TOKEN} />);
    expect(token()).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
    expect(token().tagName).toBe('CODE');
  });

  it('makes the whole value selectable in one gesture', () => {
    // `user-select: all` is what replaces a textarea's click-and-drag.
    render(<TokenReveal token={TOKEN} />);
    expect(token()).toHaveClass('select-all');
  });

  it('puts focus on the token itself, not merely near it', () => {
    render(<TokenReveal token={TOKEN} />);
    expect(token()).toHaveFocus();
  });

  it('does not add a tab stop for everybody else', () => {
    // Programmatically focusable, not in the tab order — nobody tabs into a `<code>`.
    render(<TokenReveal token={TOKEN} />);
    expect(token()).toHaveAttribute('tabindex', '-1');
  });

  it('copies it, and says it copied', async () => {
    const user = userEvent.setup();
    render(<TokenReveal token={TOKEN} />);
    await user.click(screen.getByRole('button', { name: 'apiKeys.copy' }));
    expect(await navigator.clipboard.readText()).toBe(TOKEN);
    expect(screen.getByRole('button', { name: 'apiKeys.copied' })).toBeInTheDocument();
  });

  it('says so out loud when the clipboard refuses', async () => {
    /**
     * The regression this pins: an unguarded `await navigator.clipboard.writeText(...)`
     * inside an async `onClick`. It rejects in a non-secure context or with permission
     * denied, `setCopied(true)` never runs, and the button just sits there saying "Copy".
     */
    const user = userEvent.setup();
    render(<TokenReveal token={TOKEN} />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    await user.click(screen.getByRole('button', { name: 'apiKeys.copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('apiKeys.copyFailed');
    expect(screen.getByRole('button', { name: 'apiKeys.copy' })).toBeInTheDocument();
  });

  it('survives a clipboard that is not there at all', async () => {
    /**
     * Outside a secure context `navigator.clipboard` is undefined, so the failure is a
     * synchronous TypeError rather than a rejected promise. A `.catch()` on the promise
     * would not have caught it; the try/catch does.
     */
    const user = userEvent.setup();
    render(<TokenReveal token={TOKEN} />);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
    await user.click(screen.getByRole('button', { name: 'apiKeys.copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('apiKeys.copyFailed');
  });

  it('re-arms for a second secret without being remounted', async () => {
    /**
     * Regenerating twice without leaving the page hands the same component a new token. It
     * needs the focus move and a reset "Copied" label as much as the first one did — a
     * mount-only effect would have given it neither.
     */
    const user = userEvent.setup();
    const { rerender } = render(<TokenReveal token={TOKEN} />);
    await user.click(screen.getByRole('button', { name: 'apiKeys.copy' }));
    expect(screen.getByRole('button', { name: 'apiKeys.copied' })).toBeInTheDocument();

    rerender(<TokenReveal token="eos_live_0000.SECOND" />);
    expect(screen.getByRole('button', { name: 'apiKeys.copy' })).toBeInTheDocument();
    expect(screen.getByText('eos_live_0000.SECOND')).toHaveFocus();
  });
});

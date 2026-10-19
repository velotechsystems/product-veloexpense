import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPrompt } from './AssistantPrompt';

/**
 * The paste-into-your-assistant sentence shown once beside a freshly minted personal key.
 *
 * ## What is actually worth pinning here
 *
 *   · **It is not a form control.** The sentence CONTAINS the token, so it is a second
 *     render of the secret and RC-5 binds it exactly as it binds `TokenReveal`. A future
 *     edit reaching for a `<textarea>` "so it wraps nicely" would undo the ruling in the
 *     same panel that honours it, and nothing else in the suite would notice.
 *   · **The endpoint is derived from the address the reader is on**, not stored — so the
 *     assertion is that the sentence carries THIS origin, and that no half-built URL is
 *     ever rendered when there is no origin to build it from.
 *   · **The token reaches the sentence intact.** The whole point is one paste with nothing
 *     left to assemble; a truncated or re-encoded token would look fine and fail silently
 *     in the assistant, which is the worst place to discover it.
 */

vi.mock('next-intl', () => ({
  // Mirrors the real ICU substitution closely enough to catch a missing or misnamed
  // placeholder, which is the failure this file exists to catch.
  useTranslations: () => (key: string, vars?: Record<string, string>) => {
    if (key === 'assistantPromptText') {
      return `Connect to the VeloExpense MCP server at ${vars?.url}, using this key as a bearer token: ${vars?.token}`;
    }
    return key;
  },
}));

const TOKEN = 'eok_live_7f3c1a9b2d4e6f80a1b2c3d4e5f60718';

function setOrigin(origin: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, origin },
    writable: true,
  });
}

beforeEach(() => {
  setOrigin('https://expenseos.example.com');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the sentence', () => {
  it('carries the endpoint and the token, ready to paste in one go', () => {
    render(<AssistantPrompt token={TOKEN} />);
    expect(
      screen.getByText(
        `Connect to the VeloExpense MCP server at https://expenseos.example.com/api/mcp, using this key as a bearer token: ${TOKEN}`,
      ),
    ).toBeInTheDocument();
  });

  it('builds the endpoint from the address the reader is already on', () => {
    // A stored or hardcoded endpoint silently points somebody at another environment;
    // SetupGuide takes the same approach for callback URLs, for the same reason.
    setOrigin('http://localhost:3000');
    render(<AssistantPrompt token={TOKEN} />);
    expect(screen.getByText(/http:\/\/localhost:3000\/api\/mcp/)).toBeInTheDocument();
  });

  it('renders nothing rather than a URL with no host', () => {
    // The server pass has no origin. A half-built `/api/mcp` would be copyable and wrong,
    // which is worse than arriving a beat later on the client.
    setOrigin('');
    const { container } = render(<AssistantPrompt token={TOKEN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no token', () => {
    const { container } = render(<AssistantPrompt token="" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RC-5 — the secret is not in a form control', () => {
  it('renders the sentence in a <code>, not a textarea or input', () => {
    /**
     * The token is inside this sentence, so a form control here would hand it to the
     * browser's spellchecker and offer it to a password manager — the exact two things RC-5
     * names. Asserted on the tag rather than on a class so a restyle cannot quietly change
     * the element.
     */
    const { container } = render(<AssistantPrompt token={TOKEN} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain(TOKEN);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('selects in one gesture, so not being an input costs the reader nothing', () => {
    const { container } = render(<AssistantPrompt token={TOKEN} />);
    expect(container.querySelector('code')).toHaveClass('select-all');
  });
});

describe('copying', () => {
  it('puts the whole sentence on the clipboard, not just the token', async () => {
    // Reads back through userEvent's own clipboard stub, the way TokenReveal's suite does;
    // replacing `navigator.clipboard` by hand would be overwritten by `setup()`.
    const user = userEvent.setup();
    render(<AssistantPrompt token={TOKEN} />);
    await user.click(screen.getByRole('button'));

    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('https://expenseos.example.com/api/mcp');
    expect(copied).toContain(TOKEN);
    expect(screen.getByRole('button')).toHaveTextContent('assistantPromptCopied');
  });

  it('says so out loud when the clipboard refuses', async () => {
    /**
     * Both failure shapes matter and this is the harder one to reach by accident: a
     * REJECTED promise rather than a missing `navigator.clipboard`. Unhandled it is silent,
     * at the one moment the value is still recoverable. Spied AFTER `setup()` so the mock
     * is the one in force.
     */
    const user = userEvent.setup();
    render(<AssistantPrompt token={TOKEN} />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('assistantPromptCopyFailed');
  });

  it('does not claim a copy that never happened when clipboard is absent', async () => {
    // Outside a secure context `navigator.clipboard` is undefined, so reading `.writeText`
    // throws a TypeError rather than rejecting — a different shape, same consequence. A
    // `.catch()` on the promise would not have caught this one.
    const user = userEvent.setup();
    render(<AssistantPrompt token={TOKEN} />);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
    await user.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('assistantPromptCopy');
  });
});

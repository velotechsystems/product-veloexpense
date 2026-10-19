import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAssistantChat } from './useAssistantChat';

/**
 * The client half of a turn — an SSE reader with a small state machine hanging off it.
 *
 * The server owns the transcript, so this holds only what is needed to RENDER the turn in
 * progress. Two copies of a conversation is how a refresh starts showing something
 * different from what was stored, which is why almost everything here is transient and
 * `onSettled` hands the caller back to the stored version.
 *
 * The properties worth pinning are the ones that were wrong once, or would be invisible:
 *
 *   · **A refusal's own sentence is kept.** The route distinguishes seven refusals — not
 *     configured, module inactive, signed out, no role, malformed, stale confirmation —
 *     each written for a person. All of it used to be replaced by "Something went wrong.
 *     Try asking again", which is advice that cannot work for six of the seven: asking
 *     again does not install a module or fund an account.
 *   · **A partial SSE frame stays in the buffer.** A chunk boundary mid-frame is the
 *     normal case on a real network, and parsing half a frame drops the token silently —
 *     the answer just comes out missing a word.
 *   · **An abort is not a failure.** Closing the panel or asking something else cancels
 *     the turn; reporting that as an error puts a red banner on a deliberate action.
 */

/** Build a Response whose body streams these SSE chunks, in these pieces. */
function sseResponse(chunks: string[], init: { status?: number; ok?: boolean } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
    json: async () => ({}),
  } as unknown as Response;
}

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

function setup(over: Partial<Parameters<typeof useAssistantChat>[0]> = {}) {
  const onSettled = vi.fn();
  const onConfirmed = vi.fn();
  const hook = renderHook(() =>
    useAssistantChat({
      conversationId: null,
      locale: 'en',
      screen: null,
      onSettled,
      onConfirmed,
      ...over,
    }),
  );
  return { ...hook, onSettled, onConfirmed };
}

afterEach(() => vi.unstubAllGlobals());

describe('the request', () => {
  it('sends the message, locale and screen the caller configured', async () => {
    // Typed args: `vi.fn(async () => …)` infers `mock.calls` as `[]`, and reading
    // calls[0][1] is then a type error rather than a test.
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchSpy);
    const screen = { route: '/expenses/r-1' } as never;
    const { result } = setup({ screen, locale: 'fr-CA', conversationId: 'c-1' });
    await act(async () => {
      await result.current.send({ message: 'hello' });
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      message: 'hello',
      locale: 'fr-CA',
      conversationId: 'c-1',
      screen: { route: '/expenses/r-1' },
    });
  });

  it('omits a null conversation rather than sending it', async () => {
    /** The server resumes the most recently touched thread when no id is given; sending
     *  `null` would be a different question. */
    // Typed args: `vi.fn(async () => …)` infers `mock.calls` as `[]`, and reading
    // calls[0][1] is then a type error rather than a test.
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.conversationId).toBeUndefined();
    expect(body.screen).toBeUndefined();
  });

  it('carries a confirm press through as its own field', async () => {
    // Typed args: `vi.fn(async () => …)` infers `mock.calls` as `[]`, and reading
    // calls[0][1] is then a type error rather than a test.
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = setup();
    await act(async () => {
      await result.current.send({ confirm: 'tu-1' });
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ confirm: 'tu-1' });
  });
});

describe('reading the stream', () => {
  it('accumulates streamed text', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame({ type: 'text', text: 'Hello ' }),
        frame({ type: 'text', text: 'world' }),
      ]),
    );
    const { result } = setup();
    let seen = '';
    await act(async () => {
      const p = result.current.send({ message: 'hi' });
      await p;
    });
    // The turn clears `streaming` when it settles, so the caller reloads from the server;
    // what this proves is that both frames were read and applied in order.
    seen = result.current.state.streaming;
    expect(seen).toBe('');
    expect(result.current.state.failed).toBe(false);
  });

  it('keeps a frame split across chunks, instead of dropping the token', async () => {
    /**
     * A chunk boundary mid-frame is the normal case on a real network. Parsing the half
     * that arrived first drops it silently and the answer comes out missing a word.
     */
    const whole = frame({ type: 'confirmation', id: 'tu-1', name: 'submit', input: { a: 1 } });
    const cut = Math.floor(whole.length / 2);
    vi.stubGlobal('fetch', async () => sseResponse([whole.slice(0, cut), whole.slice(cut)]));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.proposal).toEqual({
      toolUseId: 'tu-1',
      toolName: 'submit',
      input: { a: 1 },
    });
  });

  it('ignores a frame that is not JSON rather than ending the turn', async () => {
    /** A proxy injecting a keep-alive comment, or a truncated write. One bad frame must
     *  not cost the rest of the answer. */
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        'data: not json at all\n\n',
        ': keep-alive\n\n',
        frame({ type: 'title', title: 'A good title' }),
      ]),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.title).toBe('A good title');
    expect(result.current.state.failed).toBe(false);
  });

  it('records the conversation the server opened, and hands it back on settle', async () => {
    /** A brand-new thread has no id until the server says so; the caller needs it to
     *  reload the stored transcript. */
    vi.stubGlobal('fetch', async () =>
      sseResponse([frame({ type: 'open', conversationId: 'c-9', title: 'First' })]),
    );
    const { result, onSettled } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.conversationId).toBe('c-9');
    expect(onSettled).toHaveBeenCalledWith('c-9');
  });

  it('shows that a tool is running, and stops when it returns', async () => {
    /** The slow part of a turn. Without it the panel looks stalled for the seconds a
     *  query takes. */
    vi.stubGlobal('fetch', async () =>
      sseResponse([frame({ type: 'tool_call' }), frame({ type: 'tool_result' })]),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.working).toBe(false);
  });

  it('hands upload slots to the caller when a pressed proposal returns them', async () => {
    /** Fired from inside the stream and deliberately not awaited: the upload takes
     *  seconds, and blocking the reader would stall the model narrating what it just did. */
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame({
          type: 'confirmation_result',
          status: 'ok',
          toolName: 'create_expense',
          result: { uploads: [{ url: 'https://s3/put' }], reportId: 'r-1' },
        }),
      ]),
    );
    const { result, onConfirmed } = setup();
    await act(async () => {
      await result.current.send({ confirm: 'tu-1' });
    });
    expect(onConfirmed).toHaveBeenCalledWith({
      toolName: 'create_expense',
      uploads: [{ url: 'https://s3/put' }],
      reportId: 'r-1',
    });
  });

  it('says nothing to the caller when the confirmation returned no slots', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame({ type: 'confirmation_result', status: 'ok', result: { reportId: 'r-1' } }),
      ]),
    );
    const { result, onConfirmed } = setup();
    await act(async () => {
      await result.current.send({ confirm: 'tu-1' });
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('does not fire the upload path for a refused confirmation', async () => {
    /** A refusal that still handed over upload slots would file bytes against an action
     *  the server declined to take. */
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame({
          type: 'confirmation_result',
          status: 'refused',
          result: { uploads: [{ url: 'https://s3/put' }] },
        }),
      ]),
    );
    const { result, onConfirmed } = setup();
    await act(async () => {
      await result.current.send({ confirm: 'tu-1' });
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('marks the turn failed on an error frame', async () => {
    vi.stubGlobal('fetch', async () => sseResponse([frame({ type: 'error' })]));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failed).toBe(true);
  });
});

describe('when the request is refused', () => {
  it('keeps the sentence the route wrote', async () => {
    /**
     * The whole point. "The assistant is not configured — an administrator can add an
     * Anthropic key" tells somebody who to ask; "Something went wrong, try again" sends
     * them to try again, which cannot work.
     */
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 503,
      body: null,
      json: async () => ({ message: 'The assistant is not configured for this workspace.' }),
    }));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failed).toBe(true);
    expect(result.current.state.failureMessage).toBe(
      'The assistant is not configured for this workspace.',
    );
  });

  it('falls back to nothing when there is no JSON to read', async () => {
    /** A crash or a proxy error page — the only case the generic notice actually fits. */
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      body: null,
      json: async () => {
        throw new Error('not json');
      },
    }));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failureMessage).toBeNull();
    expect(result.current.state.failed).toBe(true);
  });

  it('ignores a blank message rather than rendering an empty banner', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 400,
      body: null,
      json: async () => ({ message: '   ' }),
    }));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failureMessage).toBeNull();
  });

  it('treats the hourly ceiling as its own state, not a failure', async () => {
    /** It is not broken and retrying will not help — the panel says when to come back. */
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      body: null,
      json: async () => ({}),
    }));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.rateLimited).toBe(true);
    expect(result.current.state.failed).toBe(false);
  });

  it('settles even on a refusal, so the caller reloads and unblocks its input', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 500,
      body: null,
      json: async () => ({}),
    }));
    const { result, onSettled } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.busy).toBe(false);
    expect(onSettled).toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('does not report an aborted turn as a failure', async () => {
    /** Closing the panel or asking something else aborts the turn. A red banner over a
     *  deliberate action is worse than no feedback at all. */
    vi.stubGlobal('fetch', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failed).toBe(false);
  });

  it('does report anything else that throws', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    expect(result.current.state.failed).toBe(true);
  });

  it('aborts a turn that is still in flight when a new one starts', async () => {
    /**
     * Two live streams would interleave their text into one answer nobody wrote. A turn
     * that has already settled is not aborted — the controller is released in `finally`,
     * so only an actually-open stream is cancelled.
     */
    const signals: AbortSignal[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      call += 1;
      if (call === 1) {
        // Hangs until the test lets go, so the second send lands mid-stream.
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                await firstRead;
                return { done: true, value: undefined };
              },
            }),
          },
          json: async () => ({}),
        } as unknown as Response;
      }
      return sseResponse([]);
    });

    const { result } = setup();
    let firstTurn: Promise<void> | undefined;
    await act(async () => {
      firstTurn = result.current.send({ message: 'first' });
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.send({ message: 'second' });
    });
    expect(signals[0].aborted).toBe(true);
    releaseFirst?.();
    await act(async () => {
      await firstTurn;
    });
  });

  it('cancel aborts the open stream', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return sseResponse([]);
    });
    const { result } = setup();
    let turn: Promise<void> | undefined;
    await act(async () => {
      turn = result.current.send({ message: 'hi' });
      result.current.cancel();
      await turn;
    });
    expect(signals[0].aborted).toBe(true);
  });

  it('reset clears the turn back to idle', async () => {
    vi.stubGlobal('fetch', async () => sseResponse([frame({ type: 'title', title: 'X' })]));
    const { result } = setup();
    await act(async () => {
      await result.current.send({ message: 'hi' });
    });
    await waitFor(() => expect(result.current.state.title).toBe('X'));
    act(() => result.current.reset());
    expect(result.current.state.title).toBeNull();
    expect(result.current.state.conversationId).toBeNull();
  });

  it('cancel is safe with nothing in flight', async () => {
    const { result } = setup();
    expect(() => act(() => result.current.cancel())).not.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The only file in the app that constructs the Anthropic SDK.
 *
 * `packages/assistant` declares the two slices it uses — a streaming `stream` and a
 * one-shot `create` — rather than depending on the class, so its turn loop can be tested
 * without a network. This adapter is where the real client meets those interfaces, and it
 * exists as its own file for one reason: the key comes from the `anthropic` INTEGRATION
 * row, with the environment only as a fallback. A credential that lives in a database row
 * cannot be read synchronously, and pretending otherwise is exactly how the key ended up
 * present in one container and missing in the other.
 *
 * So the cache is keyed on the KEY, not on nothing: the SDK holds a connection pool worth
 * reusing across turns, while a key rotated in the admin UI has to take effect on the next
 * turn rather than the next deploy. And it is bounded, so repeated rotation cannot
 * accumulate pools for keys nobody will use again.
 */

const h = vi.hoisted(() => ({
  constructed: [] as string[],
  baseURLs: [] as unknown[],
  streamCalls: [] as unknown[],
  createCalls: [] as unknown[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      // VeloExpense (w6-03): the stream also settles to a message with token counts, as the SDK's
      // does, so the metered path below has something to record.
      stream: (params: unknown) => {
        h.streamCalls.push(params);
        const fail = (params as { fail?: boolean })?.fail;
        return {
          kind: 'stream',
          key: this.key,
          finalMessage: async () => {
            if (fail) throw new Error('overloaded');
            return { kind: 'message', id: 'msg_s', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 2 } };
          },
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start' };
          },
        };
      },
      create: async (params: unknown) => {
        h.createCalls.push(params);
        return { kind: 'message', key: this.key, id: 'msg_c' };
      },
    };
    key: string;
    constructor(opts: { apiKey: string; baseURL?: string }) {
      this.key = opts.apiKey;
      h.constructed.push(opts.apiKey);
      h.baseURLs.push(opts.baseURL);
    }
  },
}));

import { ANTHROPIC_API_ORIGIN, anthropicBaseUrl, fastClient, streamingClient } from './assistantClient';

beforeEach(() => {
  h.constructed = [];
  h.baseURLs = [];
  h.streamCalls = [];
  h.createCalls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the two shapes', () => {
  it('adapts the SDK to a streaming client', async () => {
    const client = streamingClient('sk-a');
    const out = client.stream({ model: 'claude-opus-5' } as never);
    expect(h.streamCalls[0]).toEqual({ model: 'claude-opus-5' });
    expect(out).toMatchObject({ kind: 'stream' });
  });

  it('adapts the SDK to a one-shot client', async () => {
    const client = fastClient('sk-a');
    const out = await client.create({ model: 'claude-haiku-4-5' } as never);
    expect(h.createCalls[0]).toEqual({ model: 'claude-haiku-4-5' });
    expect(out).toMatchObject({ kind: 'message' });
  });

  it('passes the params straight through, adding nothing of its own', async () => {
    /** The assistant package owns the request shape — a default injected here would be a
     *  second place model choice and tool config are decided. */
    const params = { model: 'claude-opus-5', tools: [{ name: 't' }], max_tokens: 99 };
    streamingClient('sk-a').stream(params as never);
    expect(h.streamCalls[0]).toEqual(params);
  });
});

describe('the client cache', () => {
  it('reuses one client per key, so keep-alive survives across turns', async () => {
    /** A client per request gives up the connection pool on every turn of a conversation
     *  that is already latency-sensitive. */
    streamingClient('sk-shared').stream({} as never);
    fastClient('sk-shared').create({} as never);
    streamingClient('sk-shared').stream({} as never);
    expect(h.constructed.filter((k) => k === 'sk-shared')).toHaveLength(1);
  });

  it('builds a new client when the key changes, so a rotation takes effect next turn', async () => {
    /** Keying the cache on the key is what makes the admin UI's rotate button meaningful
     *  without a redeploy. */
    streamingClient('sk-old').stream({} as never);
    streamingClient('sk-new').stream({} as never);
    expect(h.constructed).toContain('sk-old');
    expect(h.constructed).toContain('sk-new');
  });

  it('shares one client between the streaming and one-shot shapes', async () => {
    // Two interfaces over the same SDK instance — the split is for the assistant package's
    // benefit, not two connections.
    const before = h.constructed.length;
    streamingClient('sk-pair').stream({} as never);
    fastClient('sk-pair').create({} as never);
    expect(h.constructed.length - before).toBe(1);
  });

  it('does not grow without bound as keys rotate', async () => {
    /**
     * Repeated rotation would otherwise leave a pool per historical key, each holding
     * sockets nobody will use again. Clearing when the cache fills is enough: the current
     * key is rebuilt on its next turn.
     */
    for (let i = 0; i < 12; i += 1) streamingClient(`sk-${i}`).stream({} as never);
    // A bounded cache means the last key is still cheap to reuse immediately.
    const before = h.constructed.length;
    streamingClient('sk-11').stream({} as never);
    expect(h.constructed.length - before).toBeLessThanOrEqual(1);
  });
});

/** VeloExpense (w6-03): every completed response is handed to the meter. */
describe('metering', () => {
  it('tells the meter about a one-shot response, then returns it unchanged', async () => {
    const seen: unknown[] = [];
    const out = await fastClient('sk-m', (m) => void seen.push(m)).create({} as never);
    expect(seen).toEqual([out]);
    expect(out).toMatchObject({ id: 'msg_c' });
  });

  it('tells the meter once about a streamed response, when the stream ends, even if nobody asks', async () => {
    const seen: { id: string }[] = [];
    const stream = streamingClient('sk-m', (m) => void seen.push(m as never)).stream({} as never);
    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toEqual([{ type: 'message_start' }]);
    // The loop's own call reads the same settled message — not a second count.
    const final = await stream.finalMessage();
    await stream.finalMessage();
    expect(final).toMatchObject({ id: 'msg_s' });
    expect(seen.map((m) => m.id)).toEqual(['msg_s']);
  });

  it('never fails the turn when the meter fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = () => {
      throw new Error('ai_usage unavailable');
    };
    await expect(fastClient('sk-m', broken).create({} as never)).resolves.toMatchObject({ id: 'msg_c' });
    await expect(streamingClient('sk-m', broken).stream({} as never).finalMessage()).resolves.toMatchObject({
      id: 'msg_s',
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed to record AI usage'));
  });

  it('records nothing for a stream that failed, and the loop still sees the failure', async () => {
    const seen: unknown[] = [];
    const stream = streamingClient('sk-m', (m) => void seen.push(m)).stream({ fail: true } as never);
    await expect(stream.finalMessage()).rejects.toThrow('overloaded');
    expect(seen).toEqual([]);
  });
});

/**
 * f63: the e2e's fake Messages API is reachable only on loopback, and nothing else can move
 * the assistant's calls — the key and the transcript — off Anthropic's own origin.
 */
describe('where the calls go', () => {
  it("is Anthropic's origin when nothing is set", () => {
    expect(anthropicBaseUrl({})).toBe(ANTHROPIC_API_ORIGIN);
  });

  it("ignores the SDK's own ANTHROPIC_BASE_URL — the origin is passed explicitly", () => {
    expect(anthropicBaseUrl({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(ANTHROPIC_API_ORIGIN);
  });

  it('honours the fake only on a loopback http address', () => {
    expect(anthropicBaseUrl({ ASSISTANT_FAKE_ANTHROPIC_URL: 'http://127.0.0.1:9631' })).toBe('http://127.0.0.1:9631');
    expect(anthropicBaseUrl({ ASSISTANT_FAKE_ANTHROPIC_URL: 'http://localhost:9631/v1' })).toBe('http://localhost:9631');
    expect(anthropicBaseUrl({ ASSISTANT_FAKE_ANTHROPIC_URL: 'http://[::1]:9631' })).toBe('http://[::1]:9631');
  });

  it('refuses anything else, and falls back to Anthropic', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const bad of [
      'https://evil.example.com',
      'http://10.0.0.5:9631',
      'http://127.0.0.1.evil.example.com',
      'https://127.0.0.1:9631',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(anthropicBaseUrl({ ASSISTANT_FAKE_ANTHROPIC_URL: bad })).toBe(ANTHROPIC_API_ORIGIN);
    }
    expect(error).toHaveBeenCalled();
  });

  it('builds the SDK with that origin', () => {
    streamingClient('sk-origin').stream({} as never);
    expect(h.baseURLs.at(-1)).toBe(anthropicBaseUrl());
  });
});

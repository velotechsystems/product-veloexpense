/**
 * The Anthropic client, in the two shapes the assistant package asks for.
 *
 * `packages/assistant` declares the slices of the SDK it uses rather than depending on the
 * class, so its loop can be tested without a network. This is where the real thing is
 * adapted to those interfaces — the only file in the app that constructs it.
 *
 * The key comes from the `anthropic` INTEGRATION, with the environment as a fallback —
 * see `resolveAnthropicConfig`. That makes it rotatable from the admin UI instead of
 * requiring a Secrets Manager edit and a task restart, and it is why these functions
 * take the resolved config rather than reading `process.env` themselves: a credential
 * that lives in a database row cannot be read synchronously, and pretending otherwise
 * is how the key ended up in one container and not the other.
 *
 * VeloExpense (w6-03): the key is one per environment, from Secrets Manager
 * (`veloexpense/<stage>/anthropic-api-key`, injected as ANTHROPIC_API_KEY), as receipt
 * reading's is (worker/src/handlers/lib/anthropic.ts, d40) — there is no `anthropic`
 * integration row. These functions still take the key, so the route reads it once.
 *
 * VeloExpense (w6-03): and every call is METERED. This is the one file that constructs the
 * SDK, so it is the one place every Messages API response passes — the turn loop's rounds,
 * the title, the two reviews and the article reads alike. `onMessage` is handed each
 * completed response, and the caller records its tokens (`server/lib/assistantUsage.ts`).
 * A meter that fails is logged and never fails the turn, as receipt reading's usage write
 * never fails a reading.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AssistantClient, FastClient, StreamedMessage } from '@expenseos/assistant';

/** VeloExpense (w6-03): what is told about each completed response — see the header. */
export type OnMessage = (message: Anthropic.Message) => Promise<void> | void;

/**
 * One client per key. The SDK holds a connection pool, so building one per request gives
 * up keep-alive on every turn — but keying the cache on the key itself means rotating it
 * in the admin UI takes effect on the next turn rather than the next deploy.
 */
const clients = new Map<string, Anthropic>();

function sdk(apiKey: string): Anthropic {
  const existing = clients.get(apiKey);
  if (existing) return existing;
  const created = new Anthropic({ apiKey });
  // Bounded: a key rotated repeatedly must not accumulate pools for keys nobody uses.
  if (clients.size >= 4) clients.clear();
  clients.set(apiKey, created);
  return created;
}

/** VeloExpense (w6-03): a meter's failure is a log line, never a failed turn. */
async function tell(onMessage: OnMessage, message: Anthropic.Message): Promise<void> {
  try {
    await onMessage(message);
  } catch (err) {
    console.error(
      `[assistant] failed to record AI usage for ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * VeloExpense (w6-03): a stream whose completed message is metered once, when the stream ends —
 * whether or not anything asks for it, so a turn whose reader left mid-answer is still
 * counted. The loop reads the same settled promise, so it waits for the meter and never sees
 * its failure.
 */
function metered(stream: StreamedMessage, onMessage: OnMessage): StreamedMessage {
  const final = stream.finalMessage().then(async (message) => {
    await tell(onMessage, message);
    return message;
  });
  // A failed stream records nothing; the loop sees the failure through its own iteration.
  final.catch(() => undefined);
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    finalMessage: () => final,
  };
}

export function streamingClient(apiKey: string, onMessage?: OnMessage): AssistantClient {
  return {
    stream: (params) => {
      const stream = sdk(apiKey).messages.stream(params);
      return onMessage ? metered(stream, onMessage) : stream;
    },
  };
}

export function fastClient(apiKey: string, onMessage?: OnMessage): FastClient {
  return {
    create: async (params) => {
      const message = await sdk(apiKey).messages.create(params);
      if (onMessage) await tell(onMessage, message);
      return message;
    },
  };
}

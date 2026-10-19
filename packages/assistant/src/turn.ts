/**
 * One turn of the conversation.
 *
 * The loop is deliberately small, because everything that decides whether it is safe was
 * decided elsewhere: which tools exist and what each may reach (@expenseos/mcp-server), who
 * the caller is and what running a tool means (the injected executor, which calls the real
 * tRPC procedure with the person's own context). What is left here is sequencing — call the
 * model, run the reads it asked for, stop at anything that changes something.
 *
 * It is an async generator rather than a function returning a result, for two reasons that
 * are really one: the UI needs tokens as they arrive, and the caller needs each completed
 * message as it completes so it can persist it. A turn that crashed halfway through and lost
 * its tool results would leave a transcript that cannot be replayed.
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  type ExecOutcome,
  type Executor,
  jsonSafeReplacer,
  type ToolSpec,
  untrustedEnvelope,
} from '@expenseos/mcp-server';
import { requiresConfirmation } from './confirm';
import { toApiMessages } from './history';
import { CONFIRMATION_TTL_MS, MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS } from './models';
import { confirmationBlock, type StoredMessage } from './pending';

/** The slice of the SDK this loop uses, named so a test can supply one without a network. */
export interface StreamedMessage extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

export interface AssistantClient {
  stream(params: Anthropic.MessageStreamParams): StreamedMessage;
}

/**
 * What a turn emits.
 *
 * `message` is the one the caller must act on: it carries a completed message to persist, in
 * order. The rest is progress for the UI, and dropping any of it loses nothing but polish.
 */
export type TurnEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_result'; readonly id: string; readonly ok: boolean }
  | {
      readonly type: 'confirmation';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'message'; readonly role: 'user' | 'assistant'; readonly content: unknown[] }
  | { readonly type: 'stopped'; readonly reason: StopReason };

export type StopReason =
  | 'end_turn'
  | 'confirmation_required'
  | 'tool_round_limit'
  | 'max_tokens'
  | 'refusal';

export interface TurnInput {
  readonly client: AssistantClient;
  readonly model: string;
  readonly system: Anthropic.TextBlockParam[];
  /** Definitions for exactly the tools this caller may use — already filtered upstream. */
  readonly tools: readonly Anthropic.Tool[];
  /** The specs behind those definitions, for `kind` and for the executor. */
  readonly specs: readonly ToolSpec[];
  /** The transcript so far, INCLUDING the message that starts this turn. */
  readonly history: readonly StoredMessage[];
  readonly execute: Executor;
  readonly now: () => Date;
  readonly maxToolRounds?: number;
  readonly confirmationTtlMs?: number;
}

const isToolUse = (block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock =>
  block.type === 'tool_use';

/**
 * Run tools and answer the model, stopping at the first thing that would change something.
 *
 * The ordering rule inside a single assistant message matters and is easy to get wrong: a
 * message can ask for several tools at once, and the API requires every one of them to be
 * answered in the next message. So reads are executed and answered normally, mutations are
 * answered with a confirmation marker, and only THEN does the turn stop. Stopping without
 * answering the reads would leave a transcript the API rejects on the next turn.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const maxRounds = input.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const ttl = input.confirmationTtlMs ?? CONFIRMATION_TTL_MS;
  const specByName = new Map(input.specs.map((s) => [s.name, s]));
  const transcript: StoredMessage[] = [...input.history];

  for (let round = 0; ; round++) {
    const stream = input.client.stream({
      model: input.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: input.system,
      // Adaptive rather than a token budget: this model family rejects `budget_tokens`, and
      // the questions here vary from "where is the submit button" to a tax derivation. Let
      // it spend what the question needs.
      thinking: { type: 'adaptive' },
      tools: input.tools as Anthropic.ToolUnion[],
      messages: toApiMessages(transcript),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    const content = message.content as unknown[];
    yield { type: 'message', role: 'assistant', content };
    transcript.push({
      id: `turn-${round}`,
      role: 'assistant',
      content,
      createdAt: input.now(),
    });

    const calls = message.content.filter(isToolUse);
    if (calls.length === 0) {
      yield { type: 'stopped', reason: message.stop_reason === 'refusal' ? 'refusal' : 'end_turn' };
      return;
    }

    const results: unknown[] = [];
    let awaitingPress = false;

    for (const call of calls) {
      const spec = specByName.get(call.name);

      if (!spec) {
        // The model named a tool it was not given. Answer it — an unanswered call breaks the
        // next request — and tell it plainly, so it corrects instead of retrying.
        results.push(errorResult(call.id, `No such tool: ${call.name}.`));
        yield { type: 'tool_result', id: call.id, ok: false };
        continue;
      }

      // Through `requiresConfirmation`, not by re-testing `kind` here. The predicate is
      // exported and separately tested, and this was the only gate that ran — so a change
      // to the predicate proved nothing and a reader auditing it was auditing dead code.
      // Found by mutating it: the browser test went green with the "gate" switched off.
      if (requiresConfirmation(spec)) {
        results.push(
          confirmationBlock({
            toolUseId: call.id,
            toolName: call.name,
            toolInput: call.input,
            expiresAt: new Date(input.now().getTime() + ttl),
          }),
        );
        yield { type: 'confirmation', id: call.id, name: call.name, input: call.input };
        awaitingPress = true;
        continue;
      }

      yield { type: 'tool_call', id: call.id, name: call.name };
      const outcome = await input.execute(spec, call.input);
      results.push(toolResult(call.id, outcome));
      yield { type: 'tool_result', id: call.id, ok: outcome.status === 'ok' };
    }

    yield { type: 'message', role: 'user', content: results };
    transcript.push({
      id: `turn-${round}-results`,
      role: 'user',
      content: results,
      createdAt: input.now(),
    });

    if (awaitingPress) {
      yield { type: 'stopped', reason: 'confirmation_required' };
      return;
    }

    if (round >= maxRounds) {
      yield { type: 'stopped', reason: 'tool_round_limit' };
      return;
    }
  }
}

function errorResult(toolUseId: string, message: string) {
  return { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true };
}

/**
 * Answer one tool call.
 *
 * Successful results are wrapped in the untrusted-data envelope — the same one the MCP
 * endpoint uses, for the same reason. Everything a read returns is user-authored somewhere:
 * merchant names, descriptions, comment bodies, text that arrived by email. Marking the
 * boundary does not make injection impossible; it makes the model's job unambiguous, and it
 * is the only mitigation available that does not damage legitimate content.
 *
 * Refusals are passed through as errors with the procedure's own message, because "you don't
 * have permission to approve that" is something the model should say, not something it
 * should retry.
 */
/**
 * `JSON.stringify` replacer for the types Prisma returns and JSON has no notion of.
 *
 * **BigInt is the one that mattered.** Money lives in minor units as `BigInt` throughout
 * this codebase, so every tool that returns an amount — cards and their spend limits,
 * budgets, expenses, transactions — produced a result `JSON.stringify` refuses outright:
 *
 *     TypeError: Do not know how to serialize a BigInt
 *
 * Thrown from here, inside `runTurn`, so it killed the whole turn rather than failing one
 * tool. `list_virtual_cards` could therefore NEVER succeed — every attempt ended as
 * "Something went wrong. Try asking again.", which reads as a model or network problem and
 * sent people looking at approval gating and permissions instead.
 *
 * Serialised as a decimal STRING, which is how minor units already cross every other wire
 * in the app (`amountMinor.toString()` in the routers). A number would be worse than the
 * throw: amounts beyond 2^53 would round silently, and the model would quote a total that
 * is off by cents with no indication anything happened.
 */
function toolResult(toolUseId: string, outcome: ExecOutcome) {
  if (outcome.status === 'ok') {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: JSON.stringify(untrustedEnvelope(outcome.result), jsonSafeReplacer),
    };
  }
  return errorResult(toolUseId, `${outcome.code}: ${outcome.message}`);
}

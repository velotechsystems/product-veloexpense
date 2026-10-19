/**
 * The two mechanical jobs around the edges of a turn, both done by the fast model.
 *
 * Naming a conversation and noticing that a turn went badly are judgement calls where being
 * wrong is cosmetic: a mediocre title is a mediocre title, and a mis-flagged turn costs
 * somebody thirty seconds in a review queue. Neither touches a number, which is the line
 * that decides what the fast model is allowed to do.
 *
 * Both see the question and the ANSWER TEXT ONLY — never tool results. Partly cost, mostly
 * that there is no reason to hand report totals and approver names to a second model to
 * decide whether a sentence was on topic.
 */

import type Anthropic from '@anthropic-ai/sdk';

/** The non-streaming slice of the SDK, so a test can supply one without a network. */
export interface FastClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/** Why a turn is worth a human's attention. Mirrors `AssistantFeedback.flag`. */
export type TurnFlag = 'OFF_TOPIC' | 'NO_ANSWER_FOUND' | 'UNSUPPORTED_CLAIM';

const FLAG_TOOL: Anthropic.Tool = {
  name: 'record_review',
  description: 'Record how this exchange went.',
  input_schema: {
    type: 'object',
    properties: {
      flag: {
        type: ['string', 'null'],
        enum: ['OFF_TOPIC', 'NO_ANSWER_FOUND', null],
        description:
          // VeloExpense (w6-03): the product's name in every prompt string in this file.
          'OFF_TOPIC when the question was not about VeloExpense or the expense, travel and ' +
          'tax domain it covers. NO_ANSWER_FOUND when the question was in scope but the ' +
          'answer did not actually answer it — a refusal, a deflection, or an admission of ' +
          'not knowing. Null when the answer addressed the question.',
      },
    },
    required: ['flag'],
  },
};

const TITLE_TOOL: Anthropic.Tool = {
  name: 'record_title',
  description: 'Record a short title for this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Five words or fewer, in the language the person wrote in, naming what they ' +
          'asked about. No trailing punctuation, no quotes, not a sentence.',
      },
    },
    required: ['title'],
  },
};

function forcedToolInput(message: Anthropic.Message, name: string): Record<string, unknown> | null {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === name) {
      return block.input as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Name a conversation from its first exchange.
 *
 * Returns null rather than throwing when anything goes wrong. A conversation with no title
 * shows as "New conversation" and is entirely usable; a turn that failed because the titling
 * call failed would be an outage caused by a cosmetic feature.
 */
export async function proposeTitle(
  client: FastClient,
  model: string,
  exchange: { question: string; answer: string },
): Promise<string | null> {
  try {
    const message = await client.create({
      model,
      max_tokens: 128,
      tools: [TITLE_TOOL],
      tool_choice: { type: 'tool', name: 'record_title' },
      messages: [
        {
          role: 'user',
          content:
            'Title this VeloExpense help conversation.\n\n' +
            `Question: ${exchange.question}\n\nAnswer: ${exchange.answer}`,
        },
      ],
    });
    const title = forcedToolInput(message, 'record_title')?.title;
    if (typeof title !== 'string') return null;
    const trimmed = title.trim().slice(0, 80);
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a turn belongs in the review queue.
 *
 * This is the runtime half of the scope-lock decision: rather than gate every question
 * through a classifier that would refuse legitimate ones — "what is an ITC?" is exactly the
 * kind of question a learning centre should answer and exactly the kind a topic classifier
 * rejects — the assistant answers, and turns that went badly are recorded afterwards.
 *
 * Which means this function's output is **evidence, not enforcement**. Nothing is blocked by
 * it. That is what makes a wrong answer here cheap, and it is why the bias below is toward
 * flagging nothing when unsure.
 */
export async function reviewTurn(
  client: FastClient,
  model: string,
  exchange: { question: string; answer: string },
): Promise<TurnFlag | null> {
  try {
    const message = await client.create({
      model,
      max_tokens: 128,
      tools: [FLAG_TOOL],
      tool_choice: { type: 'tool', name: 'record_review' },
      messages: [
        {
          role: 'user',
          content:
            'Review this exchange from the VeloExpense assistant. Flag only what is clearly ' +
            'one of the two cases; when in doubt, flag nothing.\n\n' +
            `Question: ${exchange.question}\n\nAnswer: ${exchange.answer}`,
        },
      ],
    });
    const flag = forcedToolInput(message, 'record_review')?.flag;
    return flag === 'OFF_TOPIC' || flag === 'NO_ANSWER_FOUND' ? flag : null;
  } catch {
    return null;
  }
}

const GROUNDING_TOOL: Anthropic.Tool = {
  name: 'record_grounding',
  description: 'Record whether the answer stayed within the guidance it was given.',
  input_schema: {
    type: 'object',
    properties: {
      unsupported: {
        type: 'boolean',
        description:
          'True only when the answer describes how VeloExpense BEHAVES — a procedure, a rule, a ' +
          'setting, where something lives in the interface — and the guidance provided does not ' +
          'say it. False for everything else, including: general background about expenses, ' +
          'travel or tax that is true independently of this product; anything the answer ' +
          'attributes to a tool result rather than to guidance; an answer that says it does not ' +
          'know; and wording that differs from the guidance while saying the same thing.',
      },
      claim: {
        type: 'string',
        description:
          'When unsupported is true, the single sentence from the answer that the guidance does ' +
          'not support. Quote it. Empty string otherwise.',
      },
    },
    required: ['unsupported', 'claim'],
  },
};

/**
 * Did the answer stay inside the guidance it was given?
 *
 * This is what makes a GATED pipeline safe. Because the model decides whether to search rather
 * than being forced to, it can answer a product question from its own priors — and that failure
 * looks exactly like success: fluent, confident, and about a product that behaves differently.
 * Nothing at generation time catches it, because the turn streams as it is written.
 *
 * So this catches rather than prevents, and the distinction is deliberate. `runTurn` yields text
 * deltas straight to the browser; buffering an answer to validate it first would trade every
 * turn's responsiveness for a check that is wrong sometimes. Instead the answer ships and the
 * suspect ones land in the review queue with the sentence quoted, which is where a human can
 * decide whether the guidance was wrong, missing, or fine.
 *
 * **It judges product claims only.** The prompt deliberately permits explaining what an input tax
 * credit is from general knowledge — that is a question a learning centre should answer, not a
 * grounding failure. Flagging it would fill the queue with correct answers and teach whoever
 * reads it to ignore the flag.
 *
 * Returns null on any failure, and on "supported". Same contract as everything else here:
 * evidence, never enforcement, and never able to fail a turn.
 */
export async function checkGrounding(
  client: FastClient,
  model: string,
  exchange: { question: string; answer: string; guidance: string },
): Promise<{ claim: string } | null> {
  // No guidance was retrieved, so there is nothing to be grounded IN. Whether the model should
  // have searched is a different question, and answering it here would flag every legitimate
  // "how do I" answered from the capability catalog.
  if (!exchange.guidance.trim()) return null;
  try {
    const message = await client.create({
      model,
      max_tokens: 256,
      tools: [GROUNDING_TOOL],
      tool_choice: { type: 'tool', name: 'record_grounding' },
      messages: [
        {
          role: 'user',
          content:
            'Check whether this answer stayed within the guidance it was given. Only flag a ' +
            'claim about how VeloExpense behaves that the guidance does not support. When in ' +
            'doubt, do not flag.\n\n' +
            `Guidance provided:\n${exchange.guidance}\n\n---\n\n` +
            `Question: ${exchange.question}\n\nAnswer: ${exchange.answer}`,
        },
      ],
    });
    const input = forcedToolInput(message, 'record_grounding');
    if (input?.unsupported !== true) return null;
    const claim = typeof input.claim === 'string' ? input.claim.trim() : '';
    return { claim: claim.slice(0, 500) };
  } catch {
    return null;
  }
}

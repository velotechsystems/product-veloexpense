/**
 * Reading candidate articles, one fast-model call each, in parallel.
 *
 * **Extraction, not summarisation**, and three reasons converge on it:
 *
 *   1. **Cost.** The fast model's OUTPUT is priced the same as the main model's INPUT, so the
 *      length of what comes back is the only thing deciding whether this stage is cheaper than
 *      handing the main model the raw articles. Break-even is around 40% of the article.
 *      Quoting the passages that bear on the question lands under that; retelling the whole
 *      article does not.
 *   2. **Translation.** A French answer is written from this text. Passing the ORIGINAL wording
 *      through means the main model translates the source; passing a paraphrase means it
 *      translates a paraphrase, and every such step is another place "input tax credit" can
 *      become *crédit d'impôt* — an income-tax credit, which is a different thing.
 *   3. **The line the fast model does not cross.** Summarising a policy rule is deciding what
 *      the rule means. Quoting the sentence that states it is mechanical.
 *
 * **Each call sees its siblings' titles.** Map-reduce otherwise loses the compound question:
 * "can I claim a meal on a per-diem day?" needs the per-diem article AND the meals article, and
 * a call seeing one article alone reasonably judges the other's subject irrelevant and drops the
 * passage that connected them. Knowing what else is being read is what lets it keep that
 * passage.
 *
 * **Best-effort.** Some calls fail; the rest still answer. Failing a turn because one of eight
 * extractions timed out is the wrong trade, and it matches the contract everywhere else in this
 * codebase.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Article } from './types';

/** The non-streaming slice of the SDK, so a test can supply one without a network. */
export interface FastClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_passages',
  description: 'Record the passages of this article that bear on what the person needs.',
  input_schema: {
    type: 'object',
    properties: {
      passages: {
        type: 'string',
        description:
          'The sentences from the article that bear on the need, QUOTED VERBATIM and in the ' +
          'order they appear. Keep every figure, rate and defined term exactly as written — ' +
          'somebody will be told this, possibly in another language, and a reworded rate is a ' +
          'wrong rate. Join separated passages with a blank line. Do not summarise, do not ' +
          'explain, do not add anything the article does not say. Empty string if nothing in ' +
          'this article bears on the need — a confident nothing is more useful than a stretch.',
      },
    },
    required: ['passages'],
  },
};

/** What one article contributed. `passages` is empty when the article turned out not to help. */
export interface Extract {
  readonly slug: string;
  readonly title: string;
  readonly passages: string;
}

/** How much of one article a single call may quote back. */
const MAX_OUTPUT_TOKENS = 600;

function forcedToolInput(message: Anthropic.Message, name: string): Record<string, unknown> | null {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === name) {
      return block.input as Record<string, unknown>;
    }
  }
  return null;
}

function prompt(article: Article, intent: string, siblings: readonly string[]): string {
  const others = siblings.filter((t) => t !== article.title);
  return [
    `What the person needs: ${intent}`,
    others.length > 0
      ? `Other articles being read alongside this one, so you can keep a passage that connects to one of them:\n${others.map((t) => `- ${t}`).join('\n')}`
      : null,
    `Article: ${article.title}\n\n${article.body}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/**
 * Extract from one article. Returns an empty `passages` on any failure.
 *
 * Never throws: this runs inside a fan-out where one bad article must not take the answer with
 * it, and an empty contribution is indistinguishable from an article that had nothing to offer —
 * which is the correct reading either way.
 */
export async function extractFromArticle(
  client: FastClient,
  model: string,
  input: { article: Article; intent: string; siblings: readonly string[] },
): Promise<Extract> {
  const empty = { slug: input.article.slug, title: input.article.title, passages: '' };
  try {
    const message = await client.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'record_passages' },
      messages: [{ role: 'user', content: prompt(input.article, input.intent, input.siblings) }],
    });
    const passages = forcedToolInput(message, 'record_passages')?.passages;
    if (typeof passages !== 'string') return empty;
    return { ...empty, passages: passages.trim() };
  } catch {
    return empty;
  }
}

/**
 * Read every candidate concurrently.
 *
 * Concurrent because it is what makes reading eight articles affordable in TIME — the wall clock
 * is one call, not eight. Nobody notices a cent; everybody notices four seconds.
 *
 * Articles that contributed nothing are dropped, so the caller cannot mistake "read and
 * irrelevant" for "here is something".
 */
export async function extractFromArticles(
  client: FastClient,
  model: string,
  input: { articles: readonly Article[]; intent: string },
): Promise<Extract[]> {
  if (input.articles.length === 0) return [];
  const siblings = input.articles.map((a) => a.title);
  const results = await Promise.all(
    input.articles.map((article) =>
      extractFromArticle(client, model, { article, intent: input.intent, siblings }),
    ),
  );
  return results.filter((r) => r.passages.length > 0);
}

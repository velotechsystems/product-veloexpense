/**
 * Recovering the authored guidance a turn was actually given.
 *
 * The grounding check needs to compare the answer against what the model *saw* — not against a
 * fresh search, which would be a different search and would judge the answer for missing
 * guidance it was never handed.
 *
 * It is read from the turn's own blocks rather than from a `TurnEvent`, because the event stream
 * deliberately carries no tool-result payload: those results go to the browser, and a tool result
 * is record content. The blocks are already in hand where messages are persisted, so nothing new
 * has to be exposed to get at them.
 *
 * The correlation is two-step, because a tool result names only the call it answers: find the
 * `tool_use` ids belonging to the search tool, then keep the `tool_result` blocks pointing at
 * them. Anything else — a report read, a card list — is skipped, which is the point: an answer
 * grounded in somebody's actual expense data is not making an unsupported claim about the
 * product.
 */

/** The tool whose results are authored guidance. Mirrors the registry entry by name. */
const SEARCH_TOOL = 'search_help_articles';

interface Block {
  readonly type?: string;
  readonly id?: string;
  readonly name?: string;
  readonly tool_use_id?: string;
  readonly content?: unknown;
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Flatten a tool result's content to text, whichever shape it arrived in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

/**
 * The guidance from one turn's messages, oldest first.
 *
 * Returns an empty string when the turn never searched — which the caller must treat as "nothing
 * to be grounded in" rather than as a failure, since plenty of legitimate answers come from the
 * capability catalog or a tool instead.
 */
export function collectGuidance(messages: readonly { readonly content: unknown }[]): string {
  const searchCallIds = new Set<string>();
  const found: string[] = [];

  for (const message of messages) {
    for (const block of blocks(message.content)) {
      if (block.type === 'tool_use' && block.name === SEARCH_TOOL && block.id) {
        searchCallIds.add(block.id);
        continue;
      }
      if (
        block.type === 'tool_result' &&
        block.tool_use_id &&
        searchCallIds.has(block.tool_use_id)
      ) {
        const text = resultText(block.content).trim();
        if (text) found.push(text);
      }
    }
  }

  return found.join('\n\n');
}

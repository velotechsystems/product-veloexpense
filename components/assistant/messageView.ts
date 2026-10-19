import { readMarker } from '@expenseos/assistant';

/**
 * Stored transcript blocks → what a person should see.
 *
 * The transcript is stored verbatim for the model's benefit: thinking blocks, tool calls,
 * tool results, and our confirmation markers. Almost none of that is worth showing, and some
 * of it must NOT be — a tool result is raw record data, and dumping it into the panel would
 * both look like noise and put fields on screen that the answer deliberately summarised.
 *
 * So this is a filter with an allowlist, not a renderer with exclusions: anything unrecognised
 * is dropped rather than displayed as-is.
 */

export type MessageView =
  | { kind: 'text'; key: string; text: string }
  | {
      kind: 'proposal';
      key: string;
      toolUseId: string;
      toolName: string;
      status: 'confirmation_required' | 'confirmed' | 'declined' | 'expired';
      failed: boolean;
    };

/** True when a settled proposal's stored result is a refusal rather than a result. */
function refused(result: unknown): boolean {
  return typeof result === 'string' && /^[A-Z_]+:/.test(result);
}

export function viewsOf(content: unknown): MessageView[] {
  if (!Array.isArray(content)) return [];
  const views: MessageView[] = [];

  content.forEach((block, index) => {
    const marker = readMarker(block);
    if (marker) {
      views.push({
        kind: 'proposal',
        // Position within the message IS the identity here: a stored message is immutable
        // once written, so its blocks never reorder and none is ever inserted between two
        // others. Only a marker's status changes, and that is not identity.
        key: `p${index}`,
        toolUseId: (block as { tool_use_id: string }).tool_use_id,
        toolName: marker.tool,
        status: marker.status,
        // A confirmed proposal whose result is a refusal is not a success, and showing a
        // tick against it would tell somebody an action happened that did not.
        failed: marker.status === 'confirmed' && refused(marker.result),
      });
      return;
    }
    const typed = block as { type?: string; text?: string };
    if (typed?.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
      views.push({ kind: 'text', key: `t${index}`, text: typed.text });
    }
  });
  return views;
}

/** Does this stored message have anything worth rendering at all? */
export function isVisible(content: unknown): boolean {
  return viewsOf(content).length > 0;
}

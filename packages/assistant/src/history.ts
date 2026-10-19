/**
 * Turning stored rows into a request the API will accept.
 *
 * The transcript is stored as it happened, one row per message, which is the right shape for
 * a database and the wrong shape for the Messages API twice over. The API requires roles to
 * alternate, and it requires every `tool_use` to be answered by a `tool_result` in the very
 * next message. A transcript can violate both honestly — a turn that stopped for a
 * confirmation ends on a user message, and a request that died between two writes leaves a
 * call unanswered.
 *
 * Both repairs happen here, on the way out, and neither rewrites what was stored. A stored
 * row is what happened; this is what we are allowed to ask about it.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { type ConfirmationMarker, readMarker, type StoredMessage } from './pending';

type Role = 'user' | 'assistant';

const isRole = (role: string): role is Role => role === 'user' || role === 'assistant';

function toolUseIds(content: readonly unknown[]): string[] {
  return content
    .filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        (b as { type?: string })?.type === 'tool_use',
    )
    .map((b) => b.id);
}

function answeredIds(content: readonly unknown[]): Set<string> {
  return new Set(
    content
      .filter((b): b is { type: 'tool_result'; tool_use_id: string } => {
        return (b as { type?: string })?.type === 'tool_result';
      })
      .map((b) => b.tool_use_id),
  );
}

/**
 * The answer given to a call that never completed.
 *
 * Shaped like a settled confirmation so the model reads it the same way it reads a declined
 * proposal: something was asked for, and it did not happen.
 */
function abandonedBlock(toolUseId: string) {
  const marker: ConfirmationMarker = {
    _expenseos: 'confirmation',
    status: 'declined',
    tool: 'unknown',
    input: null,
    inputHash: '',
    expiresAt: new Date(0).toISOString(),
    result: 'This call did not complete and was not performed.',
  };
  return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(marker) };
}

/**
 * Every stored message, as messages the API will accept.
 *
 * Consecutive same-role rows are merged rather than dropped: their content is concatenated,
 * so a turn that ended on tool results followed by the person typing again arrives as one
 * user message containing both. Merging preserves everything; dropping or reordering would
 * change what the model is told happened.
 *
 * Unanswered `tool_use` blocks are answered with an abandoned-confirmation marker. The model
 * needs to see that the call did not complete — if it saw nothing it would have no way to
 * distinguish "this never ran" from "this ran and I forgot", and the second reading is the
 * one that produces a confident claim that a report was submitted.
 */
export function toApiMessages(stored: readonly StoredMessage[]): Anthropic.MessageParam[] {
  const rows = stored
    .filter((m) => isRole(m.role))
    .map((m) => ({
      role: m.role as Role,
      content: (Array.isArray(m.content) ? m.content : []) as unknown[],
    }))
    .filter((m) => m.content.length > 0);

  const merged: { role: Role; content: unknown[] }[] = [];
  for (const row of rows) {
    const last = merged.at(-1);
    if (last && last.role === row.role) last.content.push(...row.content);
    else merged.push({ role: row.role, content: [...row.content] });
  }

  const repaired: { role: Role; content: unknown[] }[] = [];
  for (let i = 0; i < merged.length; i++) {
    const row = merged[i];
    repaired.push(row);
    if (row.role !== 'assistant') continue;

    const calls = toolUseIds(row.content);
    if (calls.length === 0) continue;

    const next = merged[i + 1];
    const answered = next?.role === 'user' ? answeredIds(next.content) : new Set<string>();
    const missing = calls.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;

    const fillers = missing.map(abandonedBlock);
    if (next?.role === 'user') next.content.unshift(...fillers);
    else repaired.push({ role: 'user', content: fillers });
  }

  return repaired.map((row) => ({
    role: row.role,
    content: row.content as Anthropic.ContentBlockParam[],
  }));
}

/**
 * Is the last thing in this transcript a proposal still waiting on a press?
 *
 * Used to decide whether a new message from the person abandons it. Somebody who types
 * something else instead of pressing has moved on, and leaving the proposal live would let a
 * press land minutes later against a conversation that has gone somewhere else.
 */
export function hasLiveProposal(stored: readonly StoredMessage[]): boolean {
  for (let i = stored.length - 1; i >= 0; i--) {
    const content = stored[i].content;
    for (const block of Array.isArray(content) ? content : []) {
      const marker = readMarker(block);
      if (marker) return marker.status === 'confirmation_required';
    }
  }
  return false;
}

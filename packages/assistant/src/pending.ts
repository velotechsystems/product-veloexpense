/**
 * A proposed mutation, and where it lives.
 *
 * It lives in the transcript. When the model calls a mutating tool the loop does not execute
 * it — it writes a tool result saying "this needs a press", and that stored block IS the
 * pending action. There is no side table, and the reason is not economy of schema:
 *
 *   · **The input cannot be tampered with**, because the server reads it from the stored
 *     `tool_use` block. The browser sends a block id and nothing else, so there is no field
 *     in the request that could name a different report.
 *   · **Single use falls out of the data.** Confirming rewrites the marker's status. A second
 *     press finds a marker that no longer says `confirmation_required` and is refused —
 *     without a status column anybody has to remember to set.
 *   · **The model's next turn sees the truth.** It reads the same transcript, so a declined
 *     or expired proposal is visibly not done, and it cannot narrate an action that never
 *     happened.
 *
 * The marker is rewritten in place when it settles. That is not in tension with storing
 * content verbatim: the rule there is about never RECONSTRUCTING blocks the model produced
 * (thinking blocks must replay unchanged). This block is one we authored, and updating it is
 * how the transcript stays true.
 */

import { jsonSafeReplacer } from '@expenseos/mcp-server';
import { hashToolInput, type PendingAction, rejectConfirmation } from './confirm';

/** The marker we write into a `tool_result` in place of executing. */
export interface ConfirmationMarker {
  /** Namespaced so detection is a comparison, never a guess about a JSON shape. */
  readonly _expenseos: 'confirmation';
  readonly status: 'confirmation_required' | 'confirmed' | 'declined' | 'expired';
  readonly tool: string;
  readonly input: unknown;
  readonly inputHash: string;
  readonly expiresAt: string;
  /** The tool outcome, once it has one. */
  readonly result?: unknown;
  readonly settledAt?: string;
}

/** A message row, as much of one as this module needs. */
export interface StoredMessage {
  readonly id: string;
  readonly role: string;
  readonly content: unknown;
  readonly createdAt: Date;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

function blocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function isToolUse(block: unknown): block is ToolUseBlock {
  const b = block as Partial<ToolUseBlock> | null;
  return Boolean(b && b.type === 'tool_use' && typeof b.id === 'string');
}

function isToolResult(block: unknown): block is ToolResultBlock {
  const b = block as Partial<ToolResultBlock> | null;
  return Boolean(b && b.type === 'tool_result' && typeof b.tool_use_id === 'string');
}

/**
 * Read our marker out of a stored block.
 *
 * Returns null for anything that is not one, including malformed JSON. A block we cannot
 * parse is treated as "not a pending confirmation" rather than as an error, because the
 * consequence of the two readings is asymmetric: refusing to confirm something unreadable
 * costs a click, while treating something unreadable as pressable is how a press lands on
 * a proposal nobody can see.
 */
export function readMarker(block: unknown): ConfirmationMarker | null {
  if (!isToolResult(block) || typeof block.content !== 'string') return null;
  try {
    const parsed = JSON.parse(block.content) as Partial<ConfirmationMarker>;
    return parsed?._expenseos === 'confirmation' ? (parsed as ConfirmationMarker) : null;
  } catch {
    return null;
  }
}

/** Build the `tool_result` that stands in for executing a mutation. */
export function confirmationBlock(input: {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  expiresAt: Date;
}): ToolResultBlock {
  const marker: ConfirmationMarker = {
    _expenseos: 'confirmation',
    status: 'confirmation_required',
    tool: input.toolName,
    input: input.toolInput,
    inputHash: hashToolInput(input.toolName, input.toolInput),
    expiresAt: input.expiresAt.toISOString(),
  };
  return {
    type: 'tool_result',
    tool_use_id: input.toolUseId,
    // Not `is_error`. Needing a press is not a failure, and marking it as one teaches the
    // model to apologise for the gate that is working as designed.
    content: JSON.stringify(marker),
  };
}

/** A proposal found in the transcript, with everything a confirmation check needs. */
export interface PendingConfirmation {
  /** The message row holding the marker — the row an update has to rewrite. */
  readonly messageId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  /** Read from the stored `tool_use`, never from a request. */
  readonly input: unknown;
  readonly inputHash: string;
  readonly expiresAt: Date;
}

/**
 * The one proposal a person could still press, if there is one.
 *
 * Scanned newest first and stopping at the first marker of any status, because only the most
 * recent proposal is live: an older `confirmation_required` sitting behind a settled one
 * means the conversation moved on without it, and offering it again would resurrect a
 * decision the person already walked away from.
 */
export function pendingConfirmation(
  messages: readonly StoredMessage[],
  now: Date,
): PendingConfirmation | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    for (const block of blocks(message.content)) {
      const marker = readMarker(block);
      if (!marker || !isToolResult(block)) continue;
      if (marker.status !== 'confirmation_required') return null;

      const expiresAt = new Date(marker.expiresAt);
      if (expiresAt.getTime() <= now.getTime()) return null;

      // The proposed input comes from the assistant's own `tool_use`, not from the marker,
      // so a marker rewritten by anything other than this code cannot change what executes.
      const source = messages
        .flatMap((m) => blocks(m.content))
        .find((b): b is ToolUseBlock => isToolUse(b) && b.id === block.tool_use_id);
      if (!source) return null;

      return {
        messageId: message.id,
        toolUseId: block.tool_use_id,
        toolName: source.name,
        input: source.input,
        inputHash: marker.inputHash,
        expiresAt,
      };
    }
  }
  return null;
}

/**
 * May this press be honoured?
 *
 * Delegates to the same check the MCP side uses, built from the stored row. `input_changed`
 * is unreachable through the HTTP surface by construction — the client never sends input —
 * and is kept because it is the check that would catch a bug here, not a caller.
 */
export function rejectPress(
  pending: PendingConfirmation,
  attempt: { toolUseId: string; now: Date },
) {
  if (pending.toolUseId !== attempt.toolUseId) return { kind: 'input_changed' as const };
  const action: PendingAction = {
    userId: 'owner',
    toolName: pending.toolName,
    inputHash: pending.inputHash,
    status: 'PENDING',
    expiresAt: pending.expiresAt,
  };
  return rejectConfirmation(action, {
    userId: 'owner',
    toolName: pending.toolName,
    input: pending.input,
    now: attempt.now,
  });
}

/**
 * Rewrite a message's blocks, settling one marker. Pure — the caller persists the result.
 *
 * Serialised with the same replacer `runTurn` answers reads with, because `result` is the
 * tool's own payload and money in it is a `BigInt` (`requestedLimitMinor`,
 * `spendLimitMinor`). A plain `JSON.stringify` throws on one — and this runs AFTER the tool
 * executed, so the throw landed in the worst place it could: the card request existed, the
 * request 500'd, and the marker stayed `confirmation_required` with a live Confirm button
 * over an action that had already happened.
 */
export function settleMarker(
  content: unknown,
  toolUseId: string,
  settlement: { status: 'confirmed' | 'declined' | 'expired'; result?: unknown; at: Date },
): unknown[] {
  return blocks(content).map((block) => {
    const marker = readMarker(block);
    if (!marker || !isToolResult(block) || block.tool_use_id !== toolUseId) return block;
    const settled: ConfirmationMarker = {
      ...marker,
      status: settlement.status,
      result: settlement.result,
      settledAt: settlement.at.toISOString(),
    };
    return { ...block, content: JSON.stringify(settled, jsonSafeReplacer) };
  });
}

/**
 * The server side of a chat turn: which conversation, what the model may see, and what
 * happens when somebody presses confirm.
 *
 * Kept out of the route handler because the route's job is the wire — everything here is
 * decisions, and decisions want tests that do not involve an HTTP stream.
 */

import type { ModuleFact } from '@expenseos/assistant';
import {
  buildSystemPrompt,
  hasLiveProposal,
  pendingConfirmation,
  rejectPress,
  type ScreenContext,
  type StoredMessage,
  settleMarker,
} from '@expenseos/assistant';
import type { PrismaClient } from '@expenseos/db';
import type { Locale } from '@expenseos/i18n';
import {
  type CallerCapabilities,
  forSurface,
  TOOLS,
  toolByName,
  visibleTools,
} from '@expenseos/mcp-server';
import { activeModuleSlugs } from '@expenseos/platform';
import { makeExecutor } from '@/server/lib/mcpExecutor';
import type { Context } from '@/server/trpc';

type Db = PrismaClient;

/**
 * The conversation to continue.
 *
 * With no id, the most recently touched open conversation is resumed rather than a new one
 * started — closing the panel and opening it tomorrow has to land somebody back in the thread
 * they were in, which is the whole point of persisting them.
 */
export async function resolveConversation(
  db: Db,
  userId: string,
  conversationId?: string | null,
): Promise<{ id: string; title: string | null }> {
  if (conversationId) {
    const owned = await db.assistantConversation.findFirst({
      where: { id: conversationId, userId, archivedAt: null },
      select: { id: true, title: true },
    });
    // Someone else's conversation and a deleted one are the same answer, so an id cannot be
    // probed for existence.
    if (!owned) throw new Error('NOT_FOUND');
    return owned;
  }
  const latest = await db.assistantConversation.findFirst({
    where: { userId, archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true },
  });
  if (latest) return latest;
  return db.assistantConversation.create({
    data: { userId },
    select: { id: true, title: true },
  });
}

/** Every message in the conversation, oldest first — the transcript the loop replays. */
export async function loadTranscript(db: Db, conversationId: string): Promise<StoredMessage[]> {
  const rows = await db.assistantMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true },
  });
  return rows as StoredMessage[];
}

/**
 * Append a message, and mark the conversation as touched.
 *
 * The second half is not incidental. `@updatedAt` fires when the conversation ROW changes,
 * and writing a child message is not that — so without this, resume order would freeze at
 * creation time and the idle-retention prune would delete threads people are actively using.
 */
export async function persistMessage(
  db: Db,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown,
): Promise<StoredMessage> {
  const [row] = await db.$transaction([
    db.assistantMessage.create({
      data: { conversationId, role, content: content as never },
      select: { id: true, role: true, content: true, createdAt: true },
    }),
    db.assistantConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);
  return row as StoredMessage;
}

/**
 * Settle a proposal the person walked away from.
 *
 * Typing something else instead of pressing is an answer. Leaving the proposal live would let
 * a press land minutes later, against a conversation that has moved on — and the model would
 * be replaying a transcript in which an action is still pending that nobody intends.
 */
export async function abandonLiveProposal(
  db: Db,
  messages: readonly StoredMessage[],
  now: Date,
): Promise<boolean> {
  if (!hasLiveProposal(messages)) return false;
  const pending = pendingConfirmation(messages, now);
  if (!pending) return false;
  const row = messages.find((m) => m.id === pending.messageId);
  if (!row) return false;
  await db.assistantMessage.update({
    where: { id: pending.messageId },
    data: {
      content: settleMarker(row.content, pending.toolUseId, {
        status: 'declined',
        result: 'The person did not confirm this, and asked something else instead.',
        at: now,
      }) as never,
    },
  });
  return true;
}

export type ConfirmOutcome =
  | { status: 'ok'; toolName: string; result: unknown }
  | { status: 'refused'; reason: string };

/**
 * Execute a proposal a human pressed.
 *
 * The input comes from the stored `tool_use` block, never from the request — the caller sends
 * a block id and nothing else, so there is no field here that could name a different report.
 * `rejectPress` then re-checks that the press is for the live proposal and that it has not
 * expired.
 */
export async function confirmProposal(input: {
  db: Db;
  ctx: Context;
  messages: readonly StoredMessage[];
  toolUseId: string;
  decline: boolean;
  now: Date;
  /**
   * Who is reading the result.
   *
   * A confirmed mutation's payload is written into the transcript and read back by the model
   * on the next turn, so it needs its money formatted for exactly the same reason a read
   * does — and in the same language as the rest of the conversation.
   */
  locale: Locale;
}): Promise<ConfirmOutcome> {
  const pending = pendingConfirmation(input.messages, input.now);
  if (!pending) return { status: 'refused', reason: 'no_pending' };

  const rejection = rejectPress(pending, { toolUseId: input.toolUseId, now: input.now });
  if (rejection) return { status: 'refused', reason: rejection.kind };

  const row = input.messages.find((m) => m.id === pending.messageId);
  if (!row) return { status: 'refused', reason: 'no_pending' };

  const settle = async (status: 'confirmed' | 'declined', result: unknown) => {
    await input.db.assistantMessage.update({
      where: { id: pending.messageId },
      data: {
        content: settleMarker(row.content, pending.toolUseId, {
          status,
          result,
          at: input.now,
        }) as never,
      },
    });
  };

  if (input.decline) {
    await settle('declined', 'The person declined this action.');
    return { status: 'ok', toolName: pending.toolName, result: 'declined' };
  }

  const spec = toolByName(pending.toolName);
  if (!spec) return { status: 'refused', reason: 'unknown_tool' };

  const outcome = await makeExecutor(input.ctx, input.locale)(spec, pending.input);
  // Both outcomes are written to the transcript. A refusal the model cannot see is a refusal
  // it will narrate as a success on the next turn.
  await settle(
    'confirmed',
    outcome.status === 'ok' ? outcome.result : `${outcome.code}: ${outcome.message}`,
  );
  return outcome.status === 'ok'
    ? { status: 'ok', toolName: pending.toolName, result: outcome.result }
    : { status: 'refused', reason: outcome.code };
}

/** What this caller can do — permissions from RBAC, modules from the installation table. */
export async function capabilitiesFor(
  db: Db,
  permissions: readonly string[],
): Promise<CallerCapabilities> {
  const modules = await activeModuleSlugs(db);
  return { permissions, activeModules: [...modules] };
}

/** Module facts for the prompt and the empty state, in the shape the catalog takes. */
export function moduleFactsFrom(
  descriptors: readonly {
    slug: string;
    name: { en: string; 'fr-CA': string };
    description: { en: string; 'fr-CA': string };
  }[],
  activeSlugs: readonly string[],
): ModuleFact[] {
  return descriptors.map((d) => ({
    slug: d.slug,
    name: d.name,
    description: d.description,
    active: activeSlugs.includes(d.slug),
  }));
}

/** Build the system prompt for a turn. */
export function systemPromptFor(input: {
  caps: CallerCapabilities;
  modules: ModuleFact[];
  locale: 'en' | 'fr-CA';
  actorName: string;
  screen: ScreenContext | null;
  now: Date;
}) {
  return buildSystemPrompt({
    // Chat-surface tools only: the capability catalog in the prompt must describe the same
    // list the model was actually given, or it proposes a tool it does not have.
    specs: forSurface(TOOLS, 'chat'),
    capabilities: input.caps,
    modules: input.modules,
    locale: input.locale,
    actorName: input.actorName,
    screen: input.screen,
    now: input.now,
  });
}

/** The specs behind the tools this caller may use — the loop needs these for `kind`. */
export function toolsFor(caps: CallerCapabilities) {
  return visibleTools(TOOLS, caps, 'chat');
}

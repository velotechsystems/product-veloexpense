import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server side of a chat turn: which conversation, and what happens when somebody
 * presses confirm.
 *
 * The confirm path is the security-relevant one, and its design is one sentence: **the
 * input comes from the stored `tool_use` block, never from the request.** The caller sends
 * a block id and nothing else, so there is no field in the request that could name a
 * different report. Everything else here follows from two more:
 *
 *   · **A proposal somebody walked away from is settled, not left live.** Typing something
 *     else instead of pressing IS an answer. A live proposal would let a press land minutes
 *     later against a conversation that has moved on, and the model would keep replaying a
 *     transcript in which an action is still pending that nobody intends.
 *   · **A refusal is written to the transcript.** A refusal the model cannot see is a
 *     refusal it narrates as a success on the next turn.
 *
 * And `persistMessage` touches the conversation row deliberately: `@updatedAt` fires when
 * the ROW changes, and writing a child message is not that — without it, resume order
 * freezes at creation time and the idle-retention prune deletes threads people are using.
 */

const h = vi.hoisted(() => ({
  live: true,
  pending: null as Record<string, unknown> | null,
  rejection: null as { kind: string } | null,
  spec: { name: 'submit_expense_report' } as unknown,
  execOutcome: { status: 'ok', result: { id: 'r-1' } } as Record<string, unknown>,
  execCalls: [] as Array<{ spec: unknown; input: unknown }>,
  settleCalls: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  activeModules: ['expense-management'] as string[],
  promptArgs: null as Record<string, unknown> | null,
  visible: ['a'] as unknown[],
}));

vi.mock('@expenseos/assistant', () => ({
  buildSystemPrompt: (args: Record<string, unknown>) => {
    h.promptArgs = args;
    return 'PROMPT';
  },
  hasLiveProposal: () => h.live,
  pendingConfirmation: () => h.pending,
  rejectPress: () => h.rejection,
  settleMarker: (content: unknown, toolUseId: string, settle: Record<string, unknown>) => {
    h.settleCalls.push({ content, toolUseId, ...settle });
    return { settled: settle.status };
  },
}));
vi.mock('@expenseos/mcp-server', () => ({
  TOOLS: ['tool-a', 'tool-b'],
  forSurface: (tools: unknown[], surface: string) => [`${surface}:${tools.length}`],
  toolByName: () => h.spec,
  visibleTools: () => h.visible,
}));
vi.mock('@expenseos/platform', () => ({ activeModuleSlugs: async () => h.activeModules }));
vi.mock('@/server/lib/mcpExecutor', () => ({
  makeExecutor: () => async (spec: unknown, input: unknown) => {
    h.execCalls.push({ spec, input });
    return h.execOutcome;
  },
}));

import {
  abandonLiveProposal,
  capabilitiesFor,
  confirmProposal,
  loadTranscript,
  moduleFactsFrom,
  persistMessage,
  resolveConversation,
  systemPromptFor,
  toolsFor,
} from './assistantSession';

const NOW = new Date('2026-08-24T12:00:00Z');

function makeDb(over: Record<string, unknown> = {}) {
  return {
    assistantConversation: {
      findFirst: vi.fn(async (_a: unknown) => null as unknown),
      create: vi.fn(async (_a: unknown) => ({ id: 'new-1', title: null })),
      update: vi.fn(async (_a: unknown) => ({})),
    },
    assistantMessage: {
      findMany: vi.fn(async (_a: unknown) => [] as unknown[]),
      create: vi.fn(async (_a: unknown) => ({ id: 'm-1' })),
      update: vi.fn(async (a: Record<string, unknown>) => {
        h.updates.push(a);
        return {};
      }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    ...over,
  };
}

beforeEach(() => {
  h.live = true;
  h.pending = null;
  h.rejection = null;
  h.spec = { name: 'submit_expense_report' };
  h.execOutcome = { status: 'ok', result: { id: 'r-1' } };
  h.execCalls = [];
  h.settleCalls = [];
  h.updates = [];
  h.activeModules = ['expense-management'];
  h.promptArgs = null;
  h.visible = ['a'];
});

describe('resolving the conversation', () => {
  it('resumes the most recently touched thread when no id is given', async () => {
    /** Closing the panel and opening it tomorrow has to land somebody back in the thread
     *  they were in — that is the whole point of persisting them. */
    const db = makeDb();
    db.assistantConversation.findFirst.mockResolvedValue({ id: 'c-9', title: 'Last week' });
    expect(await resolveConversation(db as never, 'u-1')).toEqual({
      id: 'c-9',
      title: 'Last week',
    });
    expect(
      (db.assistantConversation.findFirst.mock.calls[0][0] as { orderBy: unknown }).orderBy,
    ).toEqual({ updatedAt: 'desc' });
  });

  it('starts a new one only when the person has none open', async () => {
    const db = makeDb();
    expect(await resolveConversation(db as never, 'u-1')).toEqual({ id: 'new-1', title: null });
    expect(db.assistantConversation.create).toHaveBeenCalled();
  });

  it('never resumes an archived thread', async () => {
    const db = makeDb();
    await resolveConversation(db as never, 'u-1');
    expect(
      (db.assistantConversation.findFirst.mock.calls[0][0] as { where: unknown }).where,
    ).toMatchObject({ userId: 'u-1', archivedAt: null });
  });

  it('returns the named conversation when the caller owns it', async () => {
    const db = makeDb();
    db.assistantConversation.findFirst.mockResolvedValue({ id: 'c-1', title: 'Mine' });
    expect(await resolveConversation(db as never, 'u-1', 'c-1')).toMatchObject({ id: 'c-1' });
  });

  it('scopes a named conversation to its owner', async () => {
    const db = makeDb();
    db.assistantConversation.findFirst.mockResolvedValue({ id: 'c-1', title: 'Mine' });
    await resolveConversation(db as never, 'u-1', 'c-1');
    expect(
      (db.assistantConversation.findFirst.mock.calls[0][0] as { where: unknown }).where,
    ).toMatchObject({ id: 'c-1', userId: 'u-1', archivedAt: null });
  });

  it('gives one answer for somebody else’s thread and a deleted one', async () => {
    /** Two different errors would let an id be probed for existence — and a transcript is
     *  exactly the thing you would probe for. */
    const db = makeDb();
    await expect(resolveConversation(db as never, 'u-1', 'someone-elses')).rejects.toThrow(
      'NOT_FOUND',
    );
  });
});

describe('the transcript', () => {
  it('reads oldest first, which is the order the loop replays', async () => {
    const db = makeDb();
    await loadTranscript(db as never, 'c-1');
    expect((db.assistantMessage.findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy).toEqual(
      { createdAt: 'asc' },
    );
  });

  it('scopes to the conversation', async () => {
    const db = makeDb();
    await loadTranscript(db as never, 'c-1');
    expect((db.assistantMessage.findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({
      conversationId: 'c-1',
    });
  });
});

describe('persisting a message', () => {
  it('writes the message and touches the conversation in one transaction', async () => {
    /**
     * `@updatedAt` fires when the conversation ROW changes, and writing a child message is
     * not that. Without the touch, resume order freezes at creation time and the
     * idle-retention prune deletes threads people are actively using.
     */
    const db = makeDb();
    await persistMessage(db as never, 'c-1', 'user', { text: 'hi' });
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.assistantMessage.create).toHaveBeenCalled();
    expect(db.assistantConversation.update).toHaveBeenCalled();
  });

  it('touches the conversation the message belongs to', async () => {
    const db = makeDb();
    await persistMessage(db as never, 'c-1', 'assistant', {});
    expect((db.assistantConversation.update.mock.calls[0][0] as { where: unknown }).where).toEqual({
      id: 'c-1',
    });
  });
});

describe('abandoning a proposal', () => {
  it('settles a live proposal the person typed past', async () => {
    /** Typing something else IS an answer. Left live, a press could land minutes later
     *  against a conversation that has moved on. */
    h.pending = { messageId: 'm-1', toolUseId: 'tu-1', toolName: 'submit_expense_report' };
    const db = makeDb();
    db.assistantMessage.findMany.mockResolvedValue([]);
    const settled = await abandonLiveProposal(
      db as never,
      [{ id: 'm-1', role: 'assistant', content: {}, createdAt: NOW }] as never,
      NOW,
    );
    expect(settled).toBe(true);
    expect(h.settleCalls[0]).toMatchObject({ status: 'declined', toolUseId: 'tu-1' });
  });

  it('says why in the transcript, so the model does not re-propose it', async () => {
    h.pending = { messageId: 'm-1', toolUseId: 'tu-1', toolName: 'x' };
    const db = makeDb();
    await abandonLiveProposal(
      db as never,
      [{ id: 'm-1', role: 'assistant', content: {}, createdAt: NOW }] as never,
      NOW,
    );
    expect(String(h.settleCalls[0].result)).toContain('did not confirm');
  });

  it('does nothing when there is no live proposal', async () => {
    h.live = false;
    const db = makeDb();
    expect(await abandonLiveProposal(db as never, [] as never, NOW)).toBe(false);
    expect(db.assistantMessage.update).not.toHaveBeenCalled();
  });

  it('does nothing when the proposal has already expired', async () => {
    // `pendingConfirmation` applies the expiry; nothing to settle means nothing to write.
    h.pending = null;
    const db = makeDb();
    expect(await abandonLiveProposal(db as never, [] as never, NOW)).toBe(false);
  });

  it('does nothing when the message it points at is gone', async () => {
    h.pending = { messageId: 'missing', toolUseId: 'tu-1', toolName: 'x' };
    const db = makeDb();
    expect(await abandonLiveProposal(db as never, [] as never, NOW)).toBe(false);
    expect(db.assistantMessage.update).not.toHaveBeenCalled();
  });
});

describe('confirming a proposal', () => {
  const messages = [{ id: 'm-1', role: 'assistant', content: {}, createdAt: NOW }] as never;
  const confirm = (over: Record<string, unknown> = {}) =>
    confirmProposal({
      db: makeDb() as never,
      ctx: { rbac: { id: 'u-1' } } as never,
      messages,
      toolUseId: 'tu-1',
      decline: false,
      now: NOW,
      locale: 'en',
      ...over,
    });

  beforeEach(() => {
    h.pending = {
      messageId: 'm-1',
      toolUseId: 'tu-1',
      toolName: 'submit_expense_report',
      input: { reportId: 'r-1' },
    };
  });

  it('executes with the input from the STORED block, not from the request', async () => {
    /**
     * The whole security property. The caller sends a block id and nothing else, so there
     * is no field in the request that could name a different report.
     */
    await confirm();
    expect(h.execCalls[0].input).toEqual({ reportId: 'r-1' });
  });

  it('runs the tool the stored proposal named', async () => {
    await confirm();
    expect(h.execCalls[0].spec).toBe(h.spec);
  });

  it('writes the result into the transcript as confirmed', async () => {
    await confirm();
    expect(h.settleCalls[0]).toMatchObject({ status: 'confirmed', result: { id: 'r-1' } });
  });

  it('reports the outcome to the caller', async () => {
    expect(await confirm()).toEqual({
      status: 'ok',
      toolName: 'submit_expense_report',
      result: { id: 'r-1' },
    });
  });

  it('writes a REFUSAL into the transcript too', async () => {
    /** A refusal the model cannot see is a refusal it narrates as a success on the next
     *  turn — and the person is then told something happened that did not. */
    h.execOutcome = { status: 'error', code: 'FORBIDDEN', message: 'Not your report.' };
    const out = await confirm();
    expect(h.settleCalls[0]).toMatchObject({
      status: 'confirmed',
      result: 'FORBIDDEN: Not your report.',
    });
    expect(out).toEqual({ status: 'refused', reason: 'FORBIDDEN' });
  });

  it('settles a decline without executing anything', async () => {
    await expect(confirm({ decline: true })).resolves.toEqual({
      status: 'ok',
      toolName: 'submit_expense_report',
      result: 'declined',
    });
    expect(h.execCalls).toHaveLength(0);
    expect(h.settleCalls[0]).toMatchObject({ status: 'declined' });
  });

  it('refuses when nothing is pending', async () => {
    h.pending = null;
    expect(await confirm()).toEqual({ status: 'refused', reason: 'no_pending' });
    expect(h.execCalls).toHaveLength(0);
  });

  it('refuses a press for a different or expired proposal, with the reason', async () => {
    /** `rejectPress` is what makes a stale button in an old panel harmless: the id has to
     *  match the LIVE proposal, and it has to still be live. */
    h.rejection = { kind: 'expired' };
    expect(await confirm()).toEqual({ status: 'refused', reason: 'expired' });
    expect(h.execCalls).toHaveLength(0);
  });

  it('refuses when the stored message has vanished', async () => {
    h.pending = { messageId: 'gone', toolUseId: 'tu-1', toolName: 'x', input: {} };
    expect(await confirm()).toEqual({ status: 'refused', reason: 'no_pending' });
  });

  it('refuses a tool the registry no longer has', async () => {
    /** A proposal from before a deploy that removed the tool. Executing "the closest
     *  thing" is not an option anybody asked for. */
    h.spec = null;
    expect(await confirm()).toEqual({ status: 'refused', reason: 'unknown_tool' });
    expect(h.execCalls).toHaveLength(0);
  });
});

describe('capabilities and the prompt', () => {
  it('takes permissions from the caller and modules from the installation table', async () => {
    /** Two different sources of truth on purpose: what somebody may do is RBAC's answer,
     *  what this tenant HAS is the platform's. */
    h.activeModules = ['vcc', 'expense-management'];
    expect(await capabilitiesFor(makeDb() as never, ['a.b.c'])).toEqual({
      permissions: ['a.b.c'],
      activeModules: ['vcc', 'expense-management'],
    });
  });

  it('marks each module active or not, keeping every descriptor', async () => {
    /** The empty state names the modules that are OFF as well — "you don't have this" is
     *  the answer to half the questions people ask the assistant. */
    const facts = moduleFactsFrom(
      [
        {
          slug: 'vcc',
          name: { en: 'Cards', 'fr-CA': 'Cartes' },
          description: { en: 'd', 'fr-CA': 'd' },
        },
        {
          slug: 'travel',
          name: { en: 'Travel', 'fr-CA': 'Voyage' },
          description: { en: 'd', 'fr-CA': 'd' },
        },
      ],
      ['vcc'],
    );
    expect(facts.map((f) => [f.slug, f.active])).toEqual([
      ['vcc', true],
      ['travel', false],
    ]);
  });

  it('describes only the chat-surface tools in the prompt', async () => {
    /**
     * The capability catalog in the prompt has to describe the same list the model was
     * actually given, or it proposes a tool it does not have — and the person reads a
     * confident sentence about something that cannot happen.
     */
    systemPromptFor({
      caps: { permissions: [], activeModules: [] },
      modules: [],
      locale: 'en',
      actorName: 'Ada',
      screen: null,
      now: NOW,
    });
    expect(h.promptArgs?.specs).toEqual(['chat:2']);
  });

  it('passes the screen context and the clock through', async () => {
    /** "This report" means the one on screen, and "last month" needs a now. */
    const screen = { route: '/expenses/r-1' } as never;
    systemPromptFor({
      caps: { permissions: [], activeModules: [] },
      modules: [],
      locale: 'fr-CA',
      actorName: 'Ada',
      screen,
      now: NOW,
    });
    expect(h.promptArgs).toMatchObject({ screen, now: NOW, locale: 'fr-CA', actorName: 'Ada' });
  });

  it('hands the loop the tools this caller may actually use', async () => {
    expect(toolsFor({ permissions: [], activeModules: [] })).toEqual(['a']);
  });
});

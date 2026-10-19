// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveAnthropicConfig: vi.fn(),
  isModuleActive: vi.fn(),
  throttle: vi.fn(),
  resolveRbacUser: vi.fn(),
  resolveConversation: vi.fn(),
  loadTranscript: vi.fn(),
  abandonLiveProposal: vi.fn(),
  persistMessage: vi.fn(),
  confirmProposal: vi.fn(),
  capabilitiesFor: vi.fn(),
  systemPromptFor: vi.fn(),
  moduleFactsFrom: vi.fn(),
  toolsFor: vi.fn(),
  runWithDelegation: vi.fn(),
  runTurn: vi.fn(),
  proposeTitle: vi.fn(),
  reviewTurn: vi.fn(),
  checkGrounding: vi.fn(),
  collectGuidance: vi.fn(),
  resolveModels: vi.fn(),
  attachmentNotice: vi.fn(),
  makeExecutor: vi.fn(),
  conversationUpdate: vi.fn(),
  feedbackCreate: vi.fn(),
  // VeloExpense (w6-03): the member as `resolveTenantMember` reads it, the tenant scopes, and
  // the meter.
  memberSession: vi.fn(),
  resolveTenantMember: vi.fn(),
  withTenantDb: vi.fn(),
  withTenantStatements: vi.fn(),
  meterTurn: vi.fn(),
  streamingClient: vi.fn(),
  fastClient: vi.fn(),
}));

vi.mock('@expenseos/assistant', () => ({
  ASSISTANT_MODULE_SLUG: 'assistant',
  MAX_ATTACHMENTS_PER_TURN: 5,
  attachmentNotice: h.attachmentNotice,
  checkGrounding: h.checkGrounding,
  collectGuidance: h.collectGuidance,
  proposeTitle: h.proposeTitle,
  resolveModels: h.resolveModels,
  reviewTurn: h.reviewTurn,
  runTurn: h.runTurn,
}));
vi.mock('@expenseos/audit', () => ({ runWithDelegation: h.runWithDelegation }));
// VeloExpense (w6-03): `db` is the tenant-scoped client in lib/db/prisma, not @expenseos/db's.
vi.mock('@expenseos/db', () => ({ resolveAnthropicConfig: h.resolveAnthropicConfig }));
vi.mock('@/lib/db/prisma', () => ({
  db: {
    assistantConversation: { update: h.conversationUpdate },
    assistantFeedback: { create: h.feedbackCreate },
  },
  withTenantDb: h.withTenantDb,
  withTenantStatements: h.withTenantStatements,
}));
vi.mock('@expenseos/mcp-server', async (importOriginal) => ({
  // The real replacer, not a stand-in: the BigInt test below is about what the route
  // actually ships, and a stub here would only prove the stub.
  jsonSafeReplacer: (await importOriginal<typeof import('@expenseos/mcp-server')>())
    .jsonSafeReplacer,
  TOOLS: [],
  toolDefinitionsFor: () => [],
}));
vi.mock('@expenseos/platform', () => ({ isModuleActive: h.isModuleActive }));
// VeloExpense (w6-03): `@/auth` names the caller's email and tenant; the member — id, name, role,
// permissions — is `resolveTenantMember`'s, as the tRPC `tenant` middleware reads it. The
// mock answers with `memberSession` and `resolveRbacUser`, so ExpenseOS's cases still steer
// the name and the role through those.
vi.mock('@/auth', () => ({ auth: h.auth }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));
vi.mock('@/server/trpc', () => ({ resolveTenantMember: h.resolveTenantMember }));
vi.mock('@/server/lib/assistantUsage', () => ({ meterTurn: h.meterTurn }));
vi.mock('@/server/lib/assistantClient', () => ({
  fastClient: h.fastClient,
  streamingClient: h.streamingClient,
}));
vi.mock('@/server/lib/assistantSession', () => ({
  abandonLiveProposal: h.abandonLiveProposal,
  capabilitiesFor: h.capabilitiesFor,
  confirmProposal: h.confirmProposal,
  loadTranscript: h.loadTranscript,
  moduleFactsFrom: h.moduleFactsFrom,
  persistMessage: h.persistMessage,
  resolveConversation: h.resolveConversation,
  systemPromptFor: h.systemPromptFor,
  toolsFor: h.toolsFor,
}));
vi.mock('@/server/lib/mcpExecutor', () => ({ makeExecutor: h.makeExecutor }));
vi.mock('@/server/lib/rateLimit', () => ({ throttle: h.throttle }));
vi.mock('@/server/platform/catalog', () => ({ MODULE_DESCRIPTORS: [] }));

import { POST } from './route';

/**
 * The chat endpoint — one turn, streamed.
 *
 * A thin transport, so almost nothing here is about the model. What it owns is ORDER, and
 * two orderings are load-bearing in ways no downstream test can observe:
 *
 *   · **Settle before record.** A new message from somebody with a proposal open is them
 *     walking away from it. The decline has to be written BEFORE their message, or the
 *     transcript reads as though they asked a follow-up while an action was still pending —
 *     and a transcript is what the audit trail replays.
 *   · **Persist as it streams.** A turn that dies halfway must leave something replayable.
 *     Persisting at the end instead would lose a tool call whose answer never arrived.
 *
 * The other thing it owns is the shape of failure. Every refusal is `{ message }` JSON with
 * a real status, because the panel parses that body to say something useful; and once the
 * stream has opened, nothing may throw — a 200 that dies mid-body cannot become a 500, so
 * errors have to arrive as an SSE event instead.
 */

const SESSION = { user: { id: 'u-1', roleId: 'r-1', roleLabel: 'Admin', name: 'Dana' } };
/** VeloExpense (w6-03): what the session token carries — the email and the tenant. */
const ORG = '22222222-2222-4222-8222-222222222222';
const AUTH = { user: { email: 'dana@company.example', organizationId: ORG } };
const METER = () => undefined;
const CONV = { id: '11111111-1111-4111-8111-111111111111', title: null };

/** Drive the response body and return the decoded SSE events, in order. */
async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
}

const post = (body: unknown) =>
  POST(new Request('http://x/api/assistant/chat', { method: 'POST', body: JSON.stringify(body) }));

/** A turn that says one thing and stops. */
function turnOf(...evts: Record<string, unknown>[]) {
  return async function* () {
    for (const e of evts) yield e;
  };
}

/**
 * A turn that dies as soon as it is iterated.
 *
 * Written as a bare async iterable rather than a generator: a generator whose body only
 * throws contains no `yield`, which is a lint error and, more to the point, reads as a
 * mistake. This says what it is.
 */
const turnThrowing = (message: string) => () => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }),
});

const SAID_HELLO = [
  { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  { type: 'text', text: 'hi' },
];

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.auth.mockResolvedValue(AUTH);
  h.memberSession.mockReturnValue(SESSION);
  h.resolveTenantMember.mockImplementation(async () => ({
    session: h.memberSession(),
    rbac: await h.resolveRbacUser(),
  }));
  h.withTenantDb.mockImplementation((_org: string, fn: (tx: unknown) => unknown) => fn({}));
  h.withTenantStatements.mockImplementation((_org: string, fn: () => unknown) => fn());
  h.meterTurn.mockReturnValue(METER);
  h.streamingClient.mockReturnValue({ __brand: 'stream' });
  h.fastClient.mockReturnValue({ __brand: 'fast' });
  h.resolveAnthropicConfig.mockResolvedValue({ apiKey: 'k', assistantModel: null });
  h.isModuleActive.mockResolvedValue(true);
  h.throttle.mockResolvedValue({ allowed: true });
  h.resolveRbacUser.mockResolvedValue({ permissions: ['x'] });
  h.resolveConversation.mockResolvedValue(CONV);
  h.loadTranscript.mockResolvedValue([]);
  h.capabilitiesFor.mockResolvedValue({ activeModules: new Set(['assistant']) });
  h.systemPromptFor.mockReturnValue('SYSTEM');
  h.moduleFactsFrom.mockReturnValue([]);
  h.toolsFor.mockReturnValue([]);
  h.resolveModels.mockReturnValue({ model: 'claude-opus-5', fastModel: 'claude-haiku-4-5' });
  h.persistMessage.mockResolvedValue({ id: 'm-1' });
  h.abandonLiveProposal.mockResolvedValue(undefined);
  h.runWithDelegation.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  h.runTurn.mockImplementation(turnOf(...SAID_HELLO));
  h.proposeTitle.mockResolvedValue(null);
  h.reviewTurn.mockResolvedValue(null);
  h.checkGrounding.mockResolvedValue(null);
  h.collectGuidance.mockReturnValue([]);
  h.attachmentNotice.mockReturnValue('Attached: receipt.pdf');
  h.conversationUpdate.mockResolvedValue({});
  h.feedbackCreate.mockResolvedValue({});
});

describe('the gates, in the order they run', () => {
  it('401s an anonymous caller', async () => {
    h.auth.mockResolvedValue(null);
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ message: 'Sign in first.' });
  });

  it('401s a session with no tenant', async () => {
    /** VeloExpense (w6-03): ExpenseOS 401s a session with no role id. Here the session names
     *  the TENANT and the role is read from the database, so the unscopable session is one
     *  with no organization. */
    h.auth.mockResolvedValue({ user: { email: 'dana@company.example' } });
    expect((await post({ message: 'hi' })).status).toBe(401);
    expect(h.resolveTenantMember).not.toHaveBeenCalled();
  });

  it('403s somebody the tenant refuses, with its own reason', async () => {
    /** VeloExpense (w6-03): not a member, deactivated, access turned off, or another tenant's
     *  address — `resolveTenantMember`'s refusals, as every tRPC call makes them. */
    const { TRPCError } = await import('@trpc/server');
    h.resolveTenantMember.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'This account has been deactivated.' }),
    );
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ message: 'This account has been deactivated.' });
    expect(h.throttle).not.toHaveBeenCalled();
  });

  it('resolves the member in the session’s tenant, and runs the turn there', async () => {
    /** VeloExpense (w6-03): tenant isolation — the tenant is the session's, never the body's. */
    await post({ message: 'hi' });
    expect(h.withTenantDb.mock.calls[0]?.[0]).toBe(ORG);
    expect(h.resolveTenantMember).toHaveBeenCalledWith(
      expect.anything(),
      { email: 'dana@company.example', organizationId: ORG },
      null,
    );
    expect(h.withTenantStatements.mock.calls[0]?.[0]).toBe(ORG);
  });

  it('503s when the deployment has no credential', async () => {
    /** Deliberately distinct from the 404 below: nothing to offer, versus an
     *  organisation that chose not to have it. */
    h.resolveAnthropicConfig.mockResolvedValue(null);
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ message: 'The assistant is not configured.' });
  });

  it('404s when the module is not active', async () => {
    h.isModuleActive.mockResolvedValue(false);
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('checks the credential before the module, so a missing key is not reported as uninstalled', async () => {
    h.resolveAnthropicConfig.mockResolvedValue(null);
    await post({ message: 'hi' });
    expect(h.isModuleActive).not.toHaveBeenCalled();
  });

  it('400s a malformed body', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ message: 'Malformed request.' });
  });

  it('400s a body that fails the schema', async () => {
    expect((await post({ message: '' })).status).toBe(400);
  });

  it('400s a turn that carries nothing at all', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      message: 'Send a message, or confirm or decline a pending action.',
    });
  });

  it('accepts attachments with no words as a turn', async () => {
    /** Dropping three receipts in without typing is a request; making somebody write
     *  "here" first would be pedantry. */
    const res = await post({
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    });
    expect(res.status).toBe(200);
  });

  it('429s past the hourly ceiling, with a retry-after', async () => {
    h.throttle.mockResolvedValue({ allowed: false, retryAfterSec: 900 });
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
  });

  it('throttles per person, not globally', async () => {
    await post({ message: 'hi' });
    expect(h.throttle).toHaveBeenCalledWith('assistant:u-1', { max: 40, windowSec: 3600 });
  });

  it('403s when no role resolves for the account', async () => {
    h.resolveRbacUser.mockResolvedValue(null);
    expect((await post({ message: 'hi' })).status).toBe(403);
  });

  it('404s a conversation that is not the caller’s', async () => {
    /** `resolveConversation` scopes by user, so this is also the cross-tenant refusal —
     *  and it must read as "no such conversation", never as a permission error that
     *  confirms one exists. */
    h.resolveConversation.mockRejectedValue(new Error('not found'));
    const res = await post({ conversationId: CONV.id, message: 'hi' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ message: 'No such conversation.' });
  });

  it('refuses before spending the rate limit on an unauthenticated call', async () => {
    h.auth.mockResolvedValue(null);
    await post({ message: 'hi' });
    expect(h.throttle).not.toHaveBeenCalled();
  });
});

describe('settling an open proposal before recording the next message', () => {
  it('abandons a live proposal when a new message arrives', async () => {
    await post({ message: 'actually never mind' });
    expect(h.abandonLiveProposal).toHaveBeenCalled();
  });

  it('abandons it BEFORE the message is written', async () => {
    /**
     * The whole point. Reversed, the transcript says they asked a follow-up while an
     * action was still pending — and the transcript is what the audit trail replays.
     */
    const order: string[] = [];
    h.abandonLiveProposal.mockImplementation(async () => void order.push('abandon'));
    h.persistMessage.mockImplementation(async () => {
      order.push('persist');
      return { id: 'm-1' };
    });
    await post({ message: 'hi' });
    expect(order.slice(0, 2)).toEqual(['abandon', 'persist']);
  });

  it('does not abandon anything when the person is confirming', async () => {
    h.confirmProposal.mockResolvedValue({ status: 'done' });
    await post({ confirm: 'tu-1' });
    expect(h.abandonLiveProposal).not.toHaveBeenCalled();
  });

  it('writes the message the person actually typed', async () => {
    await post({ message: 'show my open reports' });
    expect(h.persistMessage).toHaveBeenCalledWith(expect.anything(), CONV.id, 'user', [
      { type: 'text', text: 'show my open reports' },
    ]);
  });

  it('keeps the attachment notice as a separate block from their words', async () => {
    /** What they typed stays what they typed, and the file list is visibly ours. */
    await post({
      message: 'these please',
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    });
    expect(h.persistMessage.mock.calls[0]?.[3]).toEqual([
      { type: 'text', text: 'these please' },
      { type: 'text', text: 'Attached: receipt.pdf' },
    ]);
  });

  it('sends the notice alone for a wordless attachment turn', async () => {
    /** The API rejects an empty text block, so there must be no empty first element. */
    await post({
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    });
    expect(h.persistMessage.mock.calls[0]?.[3]).toEqual([
      { type: 'text', text: 'Attached: receipt.pdf' },
    ]);
  });

  it('reloads the transcript so the turn sees the message just written', async () => {
    await post({ message: 'hi' });
    expect(h.loadTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('confirming or declining a pending action', () => {
  beforeEach(() => {
    h.confirmProposal.mockResolvedValue({ status: 'done', summary: 'Report submitted' });
  });

  it('confirms the pressed proposal', async () => {
    await post({ confirm: 'tu-9' });
    expect(h.confirmProposal).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'tu-9', decline: false }),
    );
  });

  it('declines the turned-down one', async () => {
    await post({ decline: 'tu-9' });
    expect(h.confirmProposal).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'tu-9', decline: true }),
    );
  });

  it('runs the mutation inside the delegation scope', async () => {
    /**
     * This is what puts "a model drafted it" INSIDE the audit hash, without any
     * `withAudit` call site knowing this endpoint exists. Losing the wrapper produces
     * audit rows that look like the person did it by hand.
     */
    await post({ confirm: 'tu-9' });
    expect(h.runWithDelegation).toHaveBeenCalledWith(
      { viaAssistant: { conversationId: CONV.id, toolUseId: 'tu-9' } },
      expect.any(Function),
    );
  });

  it('409s a proposal that is no longer pending', async () => {
    /** Two tabs, or a double press. Answering 200 would tell the person an action ran
     *  when the first press already ran it. */
    h.confirmProposal.mockResolvedValue({ status: 'refused', reason: 'no_pending' });
    const res = await post({ confirm: 'tu-9' });
    expect(res.status).toBe(409);
  });

  it('streams a refusal that is NOT no_pending rather than failing the request', async () => {
    h.confirmProposal.mockResolvedValue({ status: 'refused', reason: 'forbidden' });
    const res = await post({ confirm: 'tu-9' });
    expect(res.status).toBe(200);
    const evts = await events(res);
    expect(evts.find((e) => e.type === 'confirmation_result')).toMatchObject({
      status: 'refused',
      reason: 'forbidden',
    });
  });

  it('reports the outcome as the first thing after the stream opens', async () => {
    const evts = await events(await post({ confirm: 'tu-9' }));
    expect(evts[0].type).toBe('open');
    expect(evts[1]).toMatchObject({ type: 'confirmation_result', status: 'done' });
  });

  it('does not send a confirmation_result on an ordinary message turn', async () => {
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.some((e) => e.type === 'confirmation_result')).toBe(false);
  });

  it('serialises a BigInt in the confirmed result rather than going silent', async () => {
    /**
     * A confirmed mutation's result is the tool's own payload, and money in it is a BigInt
     * (`requestedLimitMinor`). `send` treats every enqueue failure as "the reader left", so a
     * serialisation throw did not surface as an error: it flipped `gone`, and the stream
     * ended after `open` with no result, no reply and no `done` — and never closed.
     */
    h.confirmProposal.mockResolvedValue({
      status: 'ok',
      toolName: 'request_virtual_card',
      result: { id: 'vcr-1', requestedLimitMinor: 50000n },
    });
    const evts = await events(await post({ confirm: 'tu-9' }));
    expect(evts.find((e) => e.type === 'confirmation_result')).toMatchObject({
      status: 'ok',
      result: { id: 'vcr-1', requestedLimitMinor: '50000' },
    });
    expect(evts.at(-1)?.type).toBe('done');
  });
});

describe('the stream', () => {
  it('is served as SSE', async () => {
    const res = await post({ message: 'hi' });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  });

  it('forbids a proxy transforming it', async () => {
    /** Without no-transform an intermediary may buffer the whole stream and deliver it
     *  at the end, which looks exactly like the model being slow. */
    const res = await post({ message: 'hi' });
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
  });

  it('opens by naming the conversation, so the client can resume it', async () => {
    const evts = await events(await post({ message: 'hi' }));
    expect(evts[0]).toEqual({ type: 'open', conversationId: CONV.id, title: null });
  });

  it('ends with done', async () => {
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.at(-1)).toEqual({ type: 'done' });
  });

  it('forwards the model’s text', async () => {
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.find((e) => e.type === 'text')).toEqual({ type: 'text', text: 'hi' });
  });

  it('never forwards the raw message blocks', async () => {
    /** `message` events are the persistence signal, not client-facing — forwarding them
     *  would duplicate every answer in the panel. */
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.some((e) => e.type === 'message')).toBe(false);
  });
});

describe('persisting as it streams', () => {
  it('writes each message the turn produces', async () => {
    await events(await post({ message: 'hi' }));
    expect(h.persistMessage).toHaveBeenCalledWith(expect.anything(), CONV.id, 'assistant', [
      { type: 'text', text: 'hi' },
    ]);
  });

  it('writes a tool result even when the turn dies before answering', async () => {
    /**
     * The reason persistence is inline rather than at the end. A turn that dies halfway
     * must leave a replayable transcript, not a tool call with no answer.
     */
    h.runTurn.mockImplementation(async function* () {
      yield { type: 'message', role: 'user', content: [{ type: 'tool_result', id: 't1' }] };
      throw new Error('upstream closed');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await events(await post({ message: 'hi' }));
    expect(h.persistMessage).toHaveBeenCalledWith(expect.anything(), CONV.id, 'user', [
      { type: 'tool_result', id: 't1' },
    ]);
    err.mockRestore();
  });
});

describe('when the turn fails', () => {
  it('sends an error event rather than dying mid-body', async () => {
    /** The response is already a 200 by then — it cannot become a 500, so the only way
     *  to tell the client is in-band. */
    h.runTurn.mockImplementation(turnThrowing('rate limited upstream'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.some((e) => e.type === 'error')).toBe(true);
    err.mockRestore();
  });

  it('never puts the model’s own message in the stream', async () => {
    /**
     * An upstream error can carry request details, and a stack trace in a chat
     * transcript is a support ticket nobody can act on.
     */
    h.runTurn.mockImplementation(turnThrowing('invalid x-api-key sk-ant-secret'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = await (await post({ message: 'hi' })).text();
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).not.toContain('invalid x-api-key');
    err.mockRestore();
  });

  it('still closes the stream cleanly', async () => {
    h.runTurn.mockImplementation(turnThrowing('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.at(-1)).toEqual({ type: 'done' });
    err.mockRestore();
  });

  it('logs a classified one-liner, because the log is the only place this is diagnosable', async () => {
    /** "turn failed: [object Object]" is what this replaces. */
    h.runTurn.mockImplementation(turnThrowing('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await events(await post({ message: 'hi' }));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[assistant.chat] turn failed:'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('reason='));
    err.mockRestore();
  });

  it('names WHY, so the panel can say something better than "try again"', async () => {
    /**
     * The whole point of the change. `{ type: 'error' }` with nothing else rendered as
     * "Something went wrong. Try asking again." for every failure — advice that cannot
     * work for most of them.
     */
    h.runTurn.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(
            Object.assign(new Error('overloaded'), {
              status: 529,
              error: { type: 'overloaded_error' },
            }),
          ),
      }),
    }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      reason: 'overloaded',
    });
    err.mockRestore();
  });

  it('says unknown rather than guessing, for an error it cannot classify', async () => {
    h.runTurn.mockImplementation(turnThrowing('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evts = await events(await post({ message: 'hi' }));
    expect(evts.find((e) => e.type === 'error')).toEqual({ type: 'error', reason: 'unknown' });
    err.mockRestore();
  });

  it('still never puts the upstream message in the stream', async () => {
    h.runTurn.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(
            Object.assign(new Error('invalid x-api-key sk-ant-secret'), {
              status: 401,
              error: { type: 'authentication_error', message: 'sk-ant-secret' },
            }),
          ),
      }),
    }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = await (await post({ message: 'hi' })).text();
    expect(raw).not.toContain('sk-ant-secret');
    expect(raw).toContain('"reason":"credential"');
    err.mockRestore();
  });
});

describe('naming the conversation', () => {
  it('proposes a title for a first turn', async () => {
    h.proposeTitle.mockResolvedValue('Open reports');
    const evts = await events(await post({ message: 'show my reports' }));
    expect(h.conversationUpdate).toHaveBeenCalledWith({
      where: { id: CONV.id },
      data: { title: 'Open reports' },
    });
    expect(evts.find((e) => e.type === 'title')).toEqual({ type: 'title', title: 'Open reports' });
  });

  it('leaves an already-named conversation alone', async () => {
    /** Renaming on every turn would make the sidebar shuffle under somebody's cursor. */
    h.resolveConversation.mockResolvedValue({ ...CONV, title: 'Existing' });
    await events(await post({ message: 'hi' }));
    expect(h.proposeTitle).not.toHaveBeenCalled();
  });

  it('says nothing when the fast model declines to name it', async () => {
    h.proposeTitle.mockResolvedValue(null);
    const evts = await events(await post({ message: 'hi' }));
    expect(h.conversationUpdate).not.toHaveBeenCalled();
    expect(evts.some((e) => e.type === 'title')).toBe(false);
  });

  it('does not name a turn that produced no answer', async () => {
    h.runTurn.mockImplementation(turnOf());
    await events(await post({ message: 'hi' }));
    expect(h.proposeTitle).not.toHaveBeenCalled();
  });

  it('does not name a confirm-only turn, which has no question', async () => {
    h.confirmProposal.mockResolvedValue({ status: 'done' });
    await events(await post({ confirm: 'tu-1' }));
    expect(h.proposeTitle).not.toHaveBeenCalled();
  });
});

describe('the review queue nobody is asked to fill', () => {
  it('records a flagged turn', async () => {
    h.reviewTurn.mockResolvedValue('OFF_TOPIC');
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ flag: 'OFF_TOPIC', messageId: 'm-1', userId: 'u-1' }),
    });
  });

  it('records nothing for a turn that passed both checks', async () => {
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate).not.toHaveBeenCalled();
  });

  it('lets an ungrounded claim outrank an off-topic flag', async () => {
    /**
     * An answer that invented product behaviour is a worse finding than one that was
     * merely off topic, and only one flag is stored — so the ordering is the finding.
     */
    h.reviewTurn.mockResolvedValue('OFF_TOPIC');
    h.checkGrounding.mockResolvedValue({ claim: 'ExpenseOS auto-approves under $50.' });
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate.mock.calls[0]?.[0].data.flag).toBe('UNSUPPORTED_CLAIM');
  });

  it('quotes the unsupported sentence for the reviewer', async () => {
    /** So somebody triaging sees WHAT was unsupported without reopening the turn and
     *  rereading it against the guidance themselves. */
    h.checkGrounding.mockResolvedValue({ claim: 'ExpenseOS auto-approves under $50.' });
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate.mock.calls[0]?.[0].data.comment).toBe(
      'ExpenseOS auto-approves under $50.',
    );
  });

  it('stores no comment for a plain flag', async () => {
    h.reviewTurn.mockResolvedValue('OFF_TOPIC');
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate.mock.calls[0]?.[0].data).not.toHaveProperty('comment');
  });

  it('checks grounding against the guidance THIS turn was handed', async () => {
    /**
     * Re-running the search would check a different search, and could flag an answer
     * for missing guidance it was never given.
     */
    h.collectGuidance.mockReturnValue(['kb-article-1']);
    await events(await post({ message: 'hi' }));
    expect(h.collectGuidance).toHaveBeenCalledWith([{ content: [{ type: 'text', text: 'hi' }] }]);
    expect(h.checkGrounding.mock.calls[0]?.[2].guidance).toEqual(['kb-article-1']);
  });

  it('records nothing when the turn produced no assistant message to attach it to', async () => {
    h.runTurn.mockImplementation(turnOf({ type: 'text', text: 'hi' }));
    h.reviewTurn.mockResolvedValue('OFF_TOPIC');
    await events(await post({ message: 'hi' }));
    expect(h.feedbackCreate).not.toHaveBeenCalled();
  });
});

describe('which model runs', () => {
  it('lets the installation override the environment', async () => {
    /** So pinning a model is an admin action rather than a redeploy. */
    h.resolveAnthropicConfig.mockResolvedValue({
      apiKey: 'k',
      assistantModel: 'claude-opus-5',
      assistantFastModel: 'claude-haiku-4-5',
    });
    await post({ message: 'hi' });
    expect(h.resolveModels).toHaveBeenCalledWith(
      expect.objectContaining({
        ASSISTANT_MODEL: 'claude-opus-5',
        ASSISTANT_FAST_MODEL: 'claude-haiku-4-5',
      }),
    );
  });

  it('leaves the environment alone when the installation pins nothing', async () => {
    await post({ message: 'hi' });
    const env = h.resolveModels.mock.calls[0]?.[0];
    expect(env).not.toHaveProperty('ASSISTANT_MODEL');
  });
});

describe('what the model is told', () => {
  it('passes the screen the person is looking at', async () => {
    await post({ message: 'what is this', screen: { route: '/expenses/rep-1' } });
    expect(h.systemPromptFor.mock.calls[0]?.[0].screen).toEqual({ route: '/expenses/rep-1' });
  });

  it('passes null when they are nowhere in particular', async () => {
    await post({ message: 'hi' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].screen).toBeNull();
  });

  it('names the person', async () => {
    await post({ message: 'hi' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].actorName).toBe('Dana');
  });

  it('falls back to the email when there is no name', async () => {
    // VeloExpense (w6-03): the member's session, not the token's.
    h.memberSession.mockReturnValue({ user: { id: 'u-1', roleId: 'r-1', email: 'dana@e.inc' } });
    await post({ message: 'hi' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].actorName).toBe('dana@e.inc');
  });

  it('passes an empty name rather than undefined when it has neither', async () => {
    // VeloExpense (w6-03): the member's session, not the token's.
    h.memberSession.mockReturnValue({ user: { id: 'u-1', roleId: 'r-1' } });
    await post({ message: 'hi' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].actorName).toBe('');
  });

  it('answers in the requested locale', async () => {
    await post({ message: 'bonjour', locale: 'fr-CA' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].locale).toBe('fr-CA');
  });

  it('defaults to English', async () => {
    await post({ message: 'hi' });
    expect(h.systemPromptFor.mock.calls[0]?.[0].locale).toBe('en');
  });

  it('scopes the tools to what this person may actually do', async () => {
    /** The model is handed capabilities, not the full tool set — an assistant that can
     *  see a tool it may not run will propose it and be refused at execution. */
    await post({ message: 'hi' });
    expect(h.toolsFor).toHaveBeenCalledWith({ activeModules: new Set(['assistant']) });
    expect(h.capabilitiesFor).toHaveBeenCalledWith(expect.anything(), ['x']);
  });
});

/**
 * NOT covered here, deliberately: the departed reader.
 *
 * Closing the panel mid-answer closes the stream controller, and every later `enqueue`
 * throws `Invalid state: Controller is already closed`. That throw landed in the turn's own
 * catch, which then wrote `{ type: 'error' }` down the same dead stream and threw again — so
 * an ordinary "I closed the drawer" logged as `turn failed: reason=unknown name=TypeError`,
 * indistinguishable from a real failure. Two of three such lines under investigation turned
 * out to be exactly that.
 *
 * `route.ts` now guards both the enqueue and the final `close()`. It is verified against a
 * live server — the stack above came out of `next dev`, and the guard removes it — and NOT
 * asserted here, because it cannot be: `reader.cancel()` under undici does not put the
 * controller into the state that throws, so a test written against it passes identically
 * with the guard removed. Checked, both ways, rather than assumed; a test that cannot fail
 * is worse than none, because it claims the opposite.
 */

/** VeloExpense (w6-03): who runs the tools, and what every model call is metered against. */
describe('the tenant and the meter', () => {
  it('gives the tool executor the caller, so each tool runs the tRPC tenant middleware', async () => {
    await post({ message: 'hi' });
    const ctx = h.makeExecutor.mock.calls[0]?.[0];
    expect(ctx.caller).toEqual({ email: 'dana@company.example', organizationId: ORG });
    expect(ctx.session).toBe(SESSION);
  });

  it('meters every model call against the tenant and the person asking', async () => {
    h.proposeTitle.mockResolvedValue('A title');
    await events(await post({ message: 'hi' }));
    expect(h.meterTurn).toHaveBeenCalledWith({ organizationId: ORG, actorUserId: 'u-1' });
    // The answer's stream, the title, the review and the grounding check — all metered.
    expect(h.streamingClient).toHaveBeenCalledWith('k', METER);
    expect(h.fastClient.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of h.fastClient.mock.calls) expect(call).toEqual(['k', METER]);
  });

  it('writes each message and its conversation touch in one tenant transaction', async () => {
    await events(await post({ message: 'hi' }));
    // The user's message and the assistant's: each inside withTenantDb for this tenant.
    const scoped = h.withTenantDb.mock.calls.filter(([org]) => org === ORG);
    expect(scoped.length).toBeGreaterThanOrEqual(3);
    expect(h.persistMessage).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-03): ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { confirmationBlock, readMarker } from '@expenseos/assistant';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * The conversation side of a turn: which thread you land in, and what a press actually does.
 *
 * The confirmation tests are the ones that matter. A press is the only place the assistant
 * changes anything, and every refusal below is a distinct way it could be made to change
 * something it was not asked to.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 *
 * VeloExpense (w6-03): ExpenseOS's `assistantSession.db.test.ts` (1e682dd6) on VeloExpense's
 * harness — its own tenant and two fictional people, every statement under RLS. The harness's
 * `db` runs each call in its own tenant transaction, as the chat route does
 * (`withTenantStatements`); ExpenseOS's array `$transaction` is awaited in order over it. The
 * refusal case presses through the REAL tRPC path: a context carrying the caller, so the
 * `tenant` middleware resolves the member from the database, as the route's executor does.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('assistant session (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let lib: typeof import('./assistantSession');
  let aliceId: string;
  let bobId: string;
  const conversationIds: string[] = [];

  const T0 = new Date('2026-08-19T12:00:00Z');

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'assistant-session',
      name: 'Assistant Session',
      people: [
        { email: 'alice@assistant-session.test', name: 'Alice' },
        { email: 'bob@assistant-session.test', name: 'Bob' },
      ],
    });
    // VeloExpense: the harness's statement-at-a-time `db`, with ExpenseOS's array form.
    db = new Proxy(h.db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return (arg: unknown) =>
            Array.isArray(arg) ? Promise.all(arg) : target.$transaction(arg);
        }
        return target[prop];
      },
    });
    lib = await import('./assistantSession');
    aliceId = h.people[1].id;
    bobId = h.people[2].id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const newConversation = async (userId = aliceId) => {
    const c = await db.assistantConversation.create({ data: { userId }, select: { id: true } });
    conversationIds.push(c.id);
    return c.id;
  };

  /** A conversation whose last turn proposed a mutation and is waiting on a press. */
  const withProposal = async (
    opts: { toolUseId?: string; expiresAt?: Date; input?: unknown } = {},
  ) => {
    const conversationId = await newConversation();
    const toolUseId = opts.toolUseId ?? 'tu-1';
    const input = opts.input ?? { reportId: '00000000-0000-7000-8000-000000000001' };
    await db.assistantMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'submit_expense_report', input }],
      },
    });
    await db.assistantMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: [
          confirmationBlock({
            toolUseId,
            toolName: 'submit_expense_report',
            toolInput: input,
            expiresAt: opts.expiresAt ?? new Date(T0.getTime() + 900_000),
          }),
        ],
      },
    });
    return { conversationId, toolUseId };
  };

  const markerOf = async (conversationId: string, toolUseId: string) => {
    const rows = await lib.loadTranscript(db, conversationId);
    for (const row of rows) {
      for (const block of Array.isArray(row.content) ? row.content : []) {
        const marker = readMarker(block);
        if (marker && (block as { tool_use_id?: string }).tool_use_id === toolUseId) return marker;
      }
    }
    return null;
  };

  describe('resolveConversation', () => {
    it('resumes the thread you were last in rather than starting a new one', async () => {
      // Closing the panel and opening it tomorrow has to land somebody back where they were;
      // otherwise persisting conversations buys nothing.
      const older = await newConversation();
      await new Promise((r) => setTimeout(r, 5));
      const newer = await newConversation();
      const resolved = await lib.resolveConversation(db, aliceId);
      expect(resolved.id).toBe(newer);
      expect(resolved.id).not.toBe(older);
    });

    it('refuses somebody else’s conversation the same way it refuses a missing one', async () => {
      const mine = await newConversation(aliceId);
      await expect(lib.resolveConversation(db, bobId, mine)).rejects.toThrow('NOT_FOUND');
    });

    it('skips an archived thread instead of resuming it', async () => {
      const archived = await newConversation();
      await db.assistantConversation.update({
        where: { id: archived },
        data: { archivedAt: new Date() },
      });
      const resolved = await lib.resolveConversation(db, aliceId);
      expect(resolved.id).not.toBe(archived);
      conversationIds.push(resolved.id);
    });
  });

  it('touches the conversation when a message is appended', async () => {
    // `@updatedAt` fires on a change to the conversation ROW, and writing a child message is
    // not that. Without the explicit touch, resume order freezes at creation and the
    // idle-retention prune deletes threads people are still using.
    const conversationId = await newConversation();
    const before = await db.assistantConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { updatedAt: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    await lib.persistMessage(db, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    const after = await db.assistantConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { updatedAt: true },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  describe('a proposal somebody walked away from', () => {
    it('is declined when they ask something else instead', async () => {
      // Leaving it live would let a press land minutes later on a conversation that moved on.
      const { conversationId, toolUseId } = await withProposal();
      const transcript = await lib.loadTranscript(db, conversationId);
      expect(await lib.abandonLiveProposal(db, transcript, T0)).toBe(true);
      expect((await markerOf(conversationId, toolUseId))?.status).toBe('declined');
    });

    it('is a no-op when nothing is pending', async () => {
      const conversationId = await newConversation();
      await lib.persistMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
      const transcript = await lib.loadTranscript(db, conversationId);
      expect(await lib.abandonLiveProposal(db, transcript, T0)).toBe(false);
    });
  });

  describe('confirmProposal', () => {
    const ctx = () => ({}) as never;

    it('refuses a press for a call the transcript never proposed', async () => {
      const { conversationId } = await withProposal();
      const transcript = await lib.loadTranscript(db, conversationId);
      const out = await lib.confirmProposal({
        db,
        ctx: ctx(),
        messages: transcript,
        toolUseId: 'tu-other',
        decline: false,
        now: T0,
        locale: 'en',
      });
      expect(out).toEqual({ status: 'refused', reason: 'input_changed' });
    });

    it('refuses a press that arrives after the proposal expired', async () => {
      // An approval is a decision about a moment. A transcript left open over lunch must not
      // still carry a live press against a report that has changed since.
      const { conversationId, toolUseId } = await withProposal({
        expiresAt: new Date(T0.getTime() - 1000),
      });
      const transcript = await lib.loadTranscript(db, conversationId);
      const out = await lib.confirmProposal({
        db,
        ctx: ctx(),
        messages: transcript,
        toolUseId,
        decline: false,
        now: T0,
        locale: 'en',
      });
      expect(out.status).toBe('refused');
    });

    it('refuses a second press on a proposal already settled', async () => {
      // Single use, and it falls out of the data rather than out of a column somebody has to
      // remember to set. Without it, one press submits a report and then submits it again.
      const { conversationId, toolUseId } = await withProposal();
      const first = await lib.loadTranscript(db, conversationId);
      await lib.confirmProposal({
        db,
        ctx: ctx(),
        messages: first,
        toolUseId,
        decline: true,
        now: T0,
        locale: 'en',
      });
      const second = await lib.loadTranscript(db, conversationId);
      const out = await lib.confirmProposal({
        db,
        ctx: ctx(),
        messages: second,
        toolUseId,
        decline: false,
        now: T0,
        locale: 'en',
      });
      expect(out).toEqual({ status: 'refused', reason: 'no_pending' });
    });

    it('records a decline in the transcript so the model cannot narrate it as done', async () => {
      const { conversationId, toolUseId } = await withProposal();
      const transcript = await lib.loadTranscript(db, conversationId);
      const out = await lib.confirmProposal({
        db,
        ctx: ctx(),
        messages: transcript,
        toolUseId,
        decline: true,
        now: T0,
        locale: 'en',
      });
      expect(out).toMatchObject({ status: 'ok', result: 'declined' });
      const marker = await markerOf(conversationId, toolUseId);
      expect(marker?.status).toBe('declined');
      expect(marker?.input).toEqual({ reportId: '00000000-0000-7000-8000-000000000001' });
    });

    it('writes a refusal into the transcript rather than swallowing it', async () => {
      // A refusal the model cannot see is one it will narrate as a success next turn. The
      // report id here is real-shaped and belongs to nobody, so the procedure refuses.
      const { conversationId, toolUseId } = await withProposal();
      const transcript = await lib.loadTranscript(db, conversationId);
      // VeloExpense (w6-03): the context the chat route builds — the caller, so the procedure runs
      // the `tenant` middleware and reads Alice's role and permissions from the database.
      const { db: tenantDb } = await import('@/lib/db/prisma');
      const out = await lib.confirmProposal({
        db,
        ctx: {
          db: tenantDb,
          session: null,
          rbac: null,
          caller: { email: h.people[1].email, organizationId: h.orgId },
        } as never,
        messages: transcript,
        toolUseId,
        decline: false,
        now: T0,
        locale: 'en',
      });
      expect(out.status).toBe('refused');
      const marker = await markerOf(conversationId, toolUseId);
      expect(marker?.status).toBe('confirmed');
      expect(String(marker?.result)).toMatch(/[A-Z_]+:/);
    });
  });
});

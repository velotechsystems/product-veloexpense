// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense (w6-03): ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * Conversation persistence.
 *
 * A transcript carries whatever the tools returned — report totals, approver names, budget
 * positions — so it inherits the sensitivity of everything the assistant can see. The tests
 * that matter here are therefore the refusals: another person's conversation must be
 * indistinguishable from one that does not exist.
 *
 * Gated on DATABASE_URL; the hermetic run skips it.
 *
 * VeloExpense (w6-03): ExpenseOS's `assistant.db.test.ts` (1e682dd6) on VeloExpense's harness —
 * the suite's own tenant and people, every call under RLS — instead of ExpenseOS's shared
 * test client and whichever two users it finds. The harness truncates the tenants, so there
 * is no per-row cleanup. Added: the knowledge pipeline's metering (`ai_usage`).
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/**
 * VeloExpense (w6-03): the SDK, so an article read answers without a network — the real
 * `assistantClient`, and its metering, still run. Each call answers with token counts.
 */
const sdk = vi.hoisted(() => ({ calls: 0, probe: null as null | (() => unknown), seen: [] as unknown[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async () => {
        sdk.calls += 1;
        // f63: what the procedure's scope looks like while the model is being waited on.
        if (sdk.probe) sdk.seen.push(sdk.probe());
        return {
          id: `msg_db_${sdk.calls}`,
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 900, output_tokens: 40 },
          content: [
            { type: 'tool_use', id: 'tu', name: 'record_passages', input: { passages: 'A quoted passage.' } },
          ],
        };
      },
    };
  },
}));

describe.skipIf(!process.env.DATABASE_URL)('assistant persistence (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let caller: (userId: string) => any;
  let reviewer: (userId: string) => any;
  let aliceId: string;
  let bobId: string;
  const conversationIds: string[] = [];

  const seedTurn = async (conversationId: string, role: 'user' | 'assistant', text: string) => {
    const row = await db.assistantMessage.create({
      data: { conversationId, role, content: [{ type: 'text', text }] },
    });
    return row.id;
  };

  beforeAll(async () => {
    // VeloExpense (w6-03): the harness's tenant and two people (fictional), not the first two users.
    h = await createTenantHarness({
      slug: 'assistant',
      name: 'Assistant',
      people: [
        { email: 'alice@assistant.test', name: 'Alice' },
        { email: 'bob@assistant.test', name: 'Bob' },
      ],
    });
    db = h.db;
    const { assistantRouter } = await import('./assistant');
    caller = (userId) => h.makeCaller([], userId, assistantRouter);
    // A reviewer holds `admin.help.manage` and nothing else; the queue must not need more.
    reviewer = (userId) => h.makeCaller([P.admin.help.manage], userId, assistantRouter);
    aliceId = h.people[1].id;
    bobId = h.people[2].id;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });

  const newConversation = async (userId = aliceId) => {
    const c = await caller(userId).create();
    conversationIds.push(c.id);
    return c;
  };

  it('creates a conversation owned by the caller', async () => {
    const c = await newConversation();
    expect(c.title).toBeNull();
    const rows = await caller(aliceId).conversations();
    expect(rows.some((r: any) => r.id === c.id)).toBe(true);
  });

  it('never shows one person another person’s conversations', async () => {
    const c = await newConversation(aliceId);
    const bobsList = await caller(bobId).conversations();
    expect(bobsList.some((r: any) => r.id === c.id)).toBe(false);
  });

  it('refuses to read a conversation that is not yours, as NOT_FOUND', async () => {
    // Indistinguishable from "does not exist", so the endpoint cannot be used to discover
    // which ids are real.
    const c = await newConversation(aliceId);
    await expect(caller(bobId).messages({ conversationId: c.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      caller(bobId).rename({ conversationId: c.id, title: 'mine now' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller(bobId).archive({ conversationId: c.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns messages oldest first, verbatim', async () => {
    // Content is stored as the block array, not extracted text: thinking blocks must replay
    // unchanged, and rebuilding them is what the API rejects.
    const c = await newConversation();
    await seedTurn(c.id, 'user', 'first');
    await seedTurn(c.id, 'assistant', 'second');
    const rows = await caller(aliceId).messages({ conversationId: c.id });
    expect(rows.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[0].content).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('hides an archived conversation without deleting its transcript', async () => {
    const c = await newConversation();
    await seedTurn(c.id, 'user', 'kept');
    await caller(aliceId).archive({ conversationId: c.id });
    expect((await caller(aliceId).conversations()).some((r: any) => r.id === c.id)).toBe(false);
    expect(await db.assistantMessage.count({ where: { conversationId: c.id } })).toBe(1);
  });

  describe('rating', () => {
    it('records a 1–5 rating on an assistant turn', async () => {
      const c = await newConversation();
      const messageId = await seedTurn(c.id, 'assistant', 'an answer');
      const out = await caller(aliceId).rate({ messageId, rating: 4, comment: 'close enough' });
      expect(out.rating).toBe(4);
      const row = await db.assistantFeedback.findUnique({ where: { id: out.id } });
      expect(row.status).toBe('PENDING');
      expect(row.userId).toBe(aliceId);
    });

    it('replaces a rating rather than appending a second opinion', async () => {
      // Somebody who scores a 2, reads more carefully and scores a 4 has changed their mind.
      // Counting both would report a satisfaction figure nobody holds.
      const c = await newConversation();
      const messageId = await seedTurn(c.id, 'assistant', 'an answer');
      await caller(aliceId).rate({ messageId, rating: 2 });
      await caller(aliceId).rate({ messageId, rating: 4 });
      const rows = await db.assistantFeedback.findMany({ where: { messageId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].rating).toBe(4);
    });

    it('puts a changed rating back in the queue', async () => {
      const c = await newConversation();
      const messageId = await seedTurn(c.id, 'assistant', 'an answer');
      const first = await caller(aliceId).rate({ messageId, rating: 5 });
      await db.assistantFeedback.update({
        where: { id: first.id },
        data: { status: 'REVIEWED', reviewedAt: new Date() },
      });
      await caller(aliceId).rate({ messageId, rating: 1 });
      const row = await db.assistantFeedback.findUnique({ where: { id: first.id } });
      expect(row.status).toBe('PENDING');
      expect(row.reviewedAt).toBeNull();
    });

    it('refuses to rate a user turn', async () => {
      // Rating your own question is meaningless.
      const c = await newConversation();
      const messageId = await seedTurn(c.id, 'user', 'a question');
      await expect(caller(aliceId).rate({ messageId, rating: 5 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses to rate somebody else’s turn', async () => {
      const c = await newConversation(aliceId);
      const messageId = await seedTurn(c.id, 'assistant', 'an answer');
      await expect(caller(bobId).rate({ messageId, rating: 5 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('leaves an assistant-raised flag alone when a human rates the same turn', async () => {
      // The two are different signals: a flag says the assistant knew it missed, a rating
      // says what the person thought. Collapsing them loses the half that populates the
      // queue when nobody bothers to rate.
      const c = await newConversation();
      const messageId = await seedTurn(c.id, 'assistant', 'an answer');
      await db.assistantFeedback.create({
        data: {
          conversationId: c.id,
          messageId,
          userId: aliceId,
          flag: 'NO_ANSWER_FOUND',
        },
      });
      await caller(aliceId).rate({ messageId, rating: 3 });
      const rows = await db.assistantFeedback.findMany({ where: { messageId } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r: any) => r.flag === 'NO_ANSWER_FOUND')).toHaveLength(1);
      expect(rows.filter((r: any) => r.rating === 3)).toHaveLength(1);
    });
  });

  describe('the review queue', () => {
    /** A rated turn belonging to `userId`, returned as its feedback row id. */
    const seedRating = async (userId: string, rating: number, comment?: string) => {
      const convo = await newConversation(userId);
      await seedTurn(convo.id, 'user', 'why is my GST zero?');
      const answerId = await seedTurn(convo.id, 'assistant', 'Because the category has no ITC.');
      await caller(userId).rate({ messageId: answerId, rating, ...(comment ? { comment } : {}) });
      const row = await db.assistantFeedback.findFirstOrThrow({
        where: { messageId: answerId },
        select: { id: true },
      });
      return { feedbackId: row.id, conversationId: convo.id, answerId };
    };

    it('refuses a caller without admin.help.manage', async () => {
      // The queue names people and quotes their questions; an employee has no claim on it.
      await expect(caller(aliceId).reviewQueue({})).rejects.toThrow(/help.manage|FORBIDDEN/i);
    });

    it('lists a rating with the person and the conversation behind it', async () => {
      const { feedbackId } = await seedRating(aliceId, 2, 'that was not the right number');
      const { rows, totalCount } = await reviewer(bobId).reviewQueue({ status: 'PENDING' });
      const hit = rows.find((r: any) => r.id === feedbackId);
      expect(hit).toBeTruthy();
      expect(hit.rating).toBe(2);
      expect(hit.comment).toBe('that was not the right number');
      // A pattern of one person's questions going unanswered is itself the finding.
      expect(hit.user?.email).toBeTruthy();
      expect(totalCount).toBeGreaterThan(0);
    });

    it('separates human ratings from the assistant flagging itself', async () => {
      const { feedbackId } = await seedRating(aliceId, 3);
      const convo = await newConversation(aliceId);
      const answerId = await seedTurn(convo.id, 'assistant', 'I only cover VeloExpense.');
      const flagged = await db.assistantFeedback.create({
        data: {
          conversationId: convo.id,
          messageId: answerId,
          userId: aliceId,
          flag: 'OFF_TOPIC',
        },
        select: { id: true },
      });

      // `RATING` selects the rows with no flag — the ones a person scored.
      const rated = await reviewer(bobId).reviewQueue({ flag: 'RATING' });
      expect(rated.rows.some((r: any) => r.id === feedbackId)).toBe(true);
      expect(rated.rows.some((r: any) => r.id === flagged.id)).toBe(false);

      const offTopic = await reviewer(bobId).reviewQueue({ flag: 'OFF_TOPIC' });
      expect(offTopic.rows.some((r: any) => r.id === flagged.id)).toBe(true);
      expect(offTopic.rows.every((r: any) => r.flag === 'OFF_TOPIC')).toBe(true);
    });

    it('returns the question and the answer, and no tool results', async () => {
      const convo = await newConversation(aliceId);
      await seedTurn(convo.id, 'user', 'what is my October total?');
      // A real turn carries the tool exchange too. None of it may reach this screen.
      await db.assistantMessage.create({
        data: {
          conversationId: convo.id,
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"secretTotal":123456}' }],
        },
      });
      const answer = await db.assistantMessage.create({
        data: {
          conversationId: convo.id,
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal reasoning nobody should read' },
            { type: 'text', text: 'Your October total is $1,234.56.' },
          ],
        },
        select: { id: true },
      });
      const feedback = await db.assistantFeedback.create({
        data: {
          conversationId: convo.id,
          messageId: answer.id,
          userId: aliceId,
          flag: 'NO_ANSWER_FOUND',
        },
        select: { id: true },
      });

      const turn = await reviewer(bobId).reviewTurn({ feedbackId: feedback.id });
      expect(turn.answer).toBe('Your October total is $1,234.56.');
      // Holding admin.help.manage is not a claim on somebody's report totals.
      expect(JSON.stringify(turn)).not.toContain('secretTotal');
      expect(JSON.stringify(turn)).not.toContain('internal reasoning');
    });

    it('records a decision with who made it and when', async () => {
      const { feedbackId } = await seedRating(aliceId, 1);
      await reviewer(bobId).reviewDecide({ feedbackId, status: 'PROMOTED' });
      const row = await db.assistantFeedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: { status: true, reviewedAt: true, reviewedBy: true },
      });
      expect(row.status).toBe('PROMOTED');
      expect(row.reviewedBy).toBe(bobId);
      expect(row.reviewedAt).toBeTruthy();
      // Promotion is a claim about intent — nothing is written to a corpus by pressing it.
      expect(await reviewer(bobId).reviewQueue({ status: 'PENDING' })).toEqual(
        expect.objectContaining({
          rows: expect.not.arrayContaining([expect.objectContaining({ id: feedbackId })]),
        }),
      );
    });

    it('puts a re-rated turn back in the queue after it was reviewed', async () => {
      // Somebody who scored 2, then read more carefully and scored 4, has changed their mind —
      // and a reviewer who already dismissed the 2 needs to see it again.
      const { feedbackId, answerId } = await seedRating(aliceId, 2);
      await reviewer(bobId).reviewDecide({ feedbackId, status: 'DISMISSED' });
      await caller(aliceId).rate({ messageId: answerId, rating: 4 });
      const row = await db.assistantFeedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: { status: true, rating: true, reviewedAt: true },
      });
      expect(row.status).toBe('PENDING');
      expect(row.rating).toBe(4);
      expect(row.reviewedAt).toBeNull();
    });

    it('refuses a decision on a row that is gone', async () => {
      await expect(
        reviewer(bobId).reviewDecide({
          feedbackId: '00000000-0000-7000-8000-00000000dead',
          status: 'REVIEWED',
        }),
      ).rejects.toThrow(/NOT_FOUND/i);
    });
  });

  describe('feedback integrity', () => {
    it('refuses a feedback row naming a user who does not exist', async () => {
      // AssistantFeedback.userId was the only `userId` in the schema with no foreign key, so a
      // bug or a bad backfill could point it at nobody and the database would not object. The
      // column stays denormalised (that is what lets the queue filter by person) — this pins
      // the constraint that makes it point somewhere real.
      const convo = await newConversation(aliceId);
      const messageId = await seedTurn(convo.id, 'assistant', 'an answer');
      await expect(
        db.assistantFeedback.create({
          data: {
            conversationId: convo.id,
            messageId,
            userId: '00000000-0000-7000-8000-00000000dead',
            status: 'PENDING',
          },
        }),
      ).rejects.toThrow();
    });

    it('takes the feedback with the conversation, which is how a user delete reaches it', async () => {
      // CASCADE on userId matches the route these rows already disappear by, so declaring it
      // added enforcement rather than behaviour. This is that route.
      const convo = await newConversation(aliceId);
      const messageId = await seedTurn(convo.id, 'assistant', 'an answer');
      const row = await db.assistantFeedback.create({
        data: { conversationId: convo.id, messageId, userId: aliceId, flag: 'OFF_TOPIC' },
        select: { id: true },
      });
      await db.assistantConversation.delete({ where: { id: convo.id } });
      expect(await db.assistantFeedback.findUnique({ where: { id: row.id } })).toBeNull();
    });
  });

  describe('the knowledge pipeline', () => {
    it('returns nothing, and says so, when no article matches', async () => {
      // "Nothing matched" and "matched but nothing relevant" are different facts. `found` reports
      // the first so the model can say it has no guidance rather than describing the product from
      // memory — which is the failure mode the whole gated design is arranged to avoid.
      const out = await caller(aliceId).searchArticles({
        terms: ['zzzznomatch', 'qqqqnothing'],
        intent: 'something no article covers',
      });
      expect(out.found).toBe(0);
      expect(out.extracts).toEqual([]);
      expect(out.searched).toEqual(['zzzznomatch', 'qqqqnothing']);
    });

    it('refuses an empty term list rather than searching for everything', async () => {
      await expect(
        caller(aliceId).searchArticles({ terms: [], intent: 'anything' }),
      ).rejects.toThrow();
    });

    it('caps the candidate list', async () => {
      await expect(
        caller(aliceId).searchArticles({ terms: ['expense'], intent: 'x', limit: 50 }),
      ).rejects.toThrow();
    });

    // VeloExpense (w6-03): each article read is a Messages API call, metered as AI credits.
    it('records every article read as metered assistant usage, against the caller', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
      try {
        await h.admin.query('DELETE FROM ai_usage WHERE organization_id = $1', [h.orgId]);
        const before = sdk.calls;
        const out = await caller(aliceId).searchArticles({
          terms: ['receipt', 'receipts'],
          intent: 'How do I email a receipt in?',
          limit: 3,
        });
        expect(out.found).toBeGreaterThan(0);
        expect(out.extracts.length).toBeGreaterThan(0);
        const reads = sdk.calls - before;
        expect(reads).toBe(out.found);

        const rows = (
          await h.admin.query(
            `SELECT organization_id, feature, model, input_tokens, output_tokens, metered,
                    actor_user_id, request_id, receipt_id, reported_at
               FROM ai_usage WHERE organization_id = $1 ORDER BY request_id`,
            [h.orgId],
          )
        ).rows;
        expect(rows).toHaveLength(reads);
        for (const r of rows) {
          expect(r).toMatchObject({
            feature: 'assistant',
            model: 'claude-haiku-4-5',
            input_tokens: 900,
            output_tokens: 40,
            metered: true,
            actor_user_id: aliceId,
            receipt_id: null,
            reported_at: null,
          });
          expect(r.request_id).toMatch(/^msg_db_/);
        }
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    // f63: through the REAL tenant middleware (the harness's caller wraps every call in one
    // transaction of its own, so it cannot show this). The article reads are network calls;
    // while they run, no tenant transaction may be open — the procedure is statement-at-a-time.
    it('holds no tenant transaction open while the model reads the articles (f63)', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
      const { inTenantTransaction, currentTenantId, db: realDb } = await import('@/lib/db/prisma');
      const { createCallerFactory } = await import('@/server/trpc');
      const { assistantRouter } = await import('./assistant');
      sdk.seen = [];
      sdk.probe = () => ({ inTransaction: inTenantTransaction(), tenant: currentTenantId() });
      try {
        await h.admin.query('DELETE FROM ai_usage WHERE organization_id = $1', [h.orgId]);
        const real = createCallerFactory(assistantRouter)({
          session: null,
          db: realDb,
          rbac: null,
          caller: { email: 'alice@assistant.test', organizationId: h.orgId },
        } as never);
        const out = await real.searchArticles({ terms: ['receipt', 'receipts'], intent: 'How do I email a receipt in?', limit: 3 });
        expect(out.found).toBeGreaterThan(0);
        expect(sdk.seen.length).toBe(out.found);
        // Still scoped to the caller's tenant (every statement is), but not in a transaction.
        for (const s of sdk.seen) expect(s).toEqual({ inTransaction: false, tenant: h.orgId });
        // And the reads were still metered, against the caller, in the one short write after.
        const rows = (
          await h.admin.query(
            'SELECT actor_user_id, metered FROM ai_usage WHERE organization_id = $1',
            [h.orgId],
          )
        ).rows;
        expect(rows).toHaveLength(out.found);
        for (const r of rows) expect(r).toEqual({ actor_user_id: aliceId, metered: true });
      } finally {
        sdk.probe = null;
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it('statement-at-a-time still asks who the caller is: a stranger is refused (f63)', async () => {
      const { db: realDb } = await import('@/lib/db/prisma');
      const { createCallerFactory } = await import('@/server/trpc');
      const { assistantRouter } = await import('./assistant');
      const stranger = createCallerFactory(assistantRouter)({
        session: null,
        db: realDb,
        rbac: null,
        caller: { email: 'nobody@elsewhere.test', organizationId: h.orgId },
      } as never);
      await expect(stranger.searchArticles({ terms: ['receipt'], intent: 'x' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('reads nothing, and records nothing, with no key configured', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        await h.admin.query('DELETE FROM ai_usage WHERE organization_id = $1', [h.orgId]);
        const before = sdk.calls;
        const out = await caller(aliceId).searchArticles({ terms: ['receipt'], intent: 'x' });
        expect(out).toEqual({ extracts: [], searched: ['receipt'], found: 0 });
        expect(sdk.calls).toBe(before);
        const n = (await h.admin.query('SELECT count(*)::int AS n FROM ai_usage WHERE organization_id = $1', [h.orgId])).rows[0].n;
        expect(n).toBe(0);
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
    });
  });
});

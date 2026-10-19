/**
 * Conversation persistence and feedback capture.
 *
 * The reasoning loop is not here — this is the store beneath it, and it ships first because
 * everything else in Phase 4 writes to it.
 *
 * Every conversation belongs to exactly one person and is readable only by them. A transcript
 * carries whatever the tools returned — report totals, approver names, budget positions — so
 * it inherits the sensitivity of everything the assistant can see. That is why there is no
 * sharing here, and why `ownConversation` is called before every read.
 */

import {
  ASSISTANT_MODULE_SLUG,
  articleBySlug,
  extractFromArticles,
  resolveModels,
  searchArticles,
  suggestedCapabilities,
} from '@expenseos/assistant';
import { anthropicConfigured, resolveAnthropicConfig } from '@expenseos/db';
import { forSurface, TOOLS } from '@expenseos/mcp-server';
import { activeModuleSlugs, isModuleActive } from '@expenseos/platform';
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { TenantDb } from '@/lib/db/prisma';
import { fastClient } from '@/server/lib/assistantClient';
import { usageCollector } from '@/server/lib/assistantUsage';
import { protectedProcedure, router, withPermission } from '@/server/trpc';

/** Ensure the conversation exists AND belongs to the caller. */
// VeloExpense (w6-03): the tenant transaction's client (`ctx.db`), not ExpenseOS's global `db`.
async function ownConversation(db: TenantDb, id: string, userId: string) {
  const convo = await db.assistantConversation.findFirst({
    where: { id, userId, archivedAt: null },
    select: { id: true },
  });
  // Deliberately not distinguishing "no such conversation" from "not yours": both are
  // NOT_FOUND, so the endpoint cannot be used to discover which ids exist.
  if (!convo) throw new TRPCError({ code: 'NOT_FOUND' });
  return convo;
}

/**
 * The prose out of a stored content-block array.
 *
 * Text blocks only. A stored message also carries `tool_use` inputs, `tool_result` payloads and
 * thinking blocks; the first two are record content a reviewer has no claim on, and the third is
 * not an answer. Concatenated in order, because a turn can emit several text blocks around its
 * tool calls and reading only the first loses half the answer.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        Boolean(b) &&
        typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: string }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

export const assistantRouter = router({
  /** The caller's conversations, most recently active first. */
  /**
   * Everything the panel needs to open, in one round trip.
   *
   * Availability is answered here rather than by letting the panel try and fail: a chat that
   * opens and then errors on the first message is worse than one that was never offered.
   *
   * The two reasons are REPORTED SEPARATELY, and that is a correction. They used to collapse
   * into one answer on the reasoning that "a person can act on neither" — which was wrong
   * twice over. An administrator can absolutely act on a missing API key; and the single
   * message that survived told them to install the module, so the one configuration problem
   * they could fix was described as the one they had already fixed. Somebody with the module
   * installed was sent back to install it again.
   *
   * Neither reason is sensitive: both are deployment state, and the panel already named one
   * of them.
   */
  session: protectedProcedure.query(async ({ ctx }) => {
    const moduleOn = await isModuleActive(ctx.db, ASSISTANT_MODULE_SLUG);
    if (!moduleOn) {
      return {
        available: false as const,
        reason: 'MODULE_OFF' as const,
        conversation: null,
        suggestions: [] as string[],
      };
    }
    // The credential now comes from the `anthropic` integration, with the environment as
    // a fallback. Since the assistant module declares `requiresIntegrations: ['anthropic']`
    // this should be unreachable — the module cannot be activated without an active
    // installation. It stays because a deployment that predates that declaration can have
    // the module on and no installation, and because a key can be emptied in the admin UI
    // without deactivating anything.
    if (!(await anthropicConfigured(ctx.db))) {
      return {
        available: false as const,
        reason: 'NOT_CONFIGURED' as const,
        conversation: null,
        suggestions: [] as string[],
      };
    }
    const [conversation, modules] = await Promise.all([
      // The thread they were last in — closing the panel and opening it tomorrow lands them
      // back where they were, which is the point of persisting these at all.
      ctx.db.assistantConversation.findFirst({
        where: { userId: ctx.rbac.id, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true },
      }),
      activeModuleSlugs(ctx.db),
    ]);
    return {
      available: true as const,
      conversation,
      // Openers derived from the tools this person can actually use, so an empty panel
      // cannot offer something their role forbids.
      suggestions: suggestedCapabilities(forSurface(TOOLS, 'chat'), {
        permissions: ctx.rbac.permissions,
        activeModules: [...modules],
      }),
    };
  }),

  conversations: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.assistantConversation.findMany({
      where: { userId: ctx.rbac.id, archivedAt: null },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }),

  /** One conversation's messages, oldest first, with any feedback already given. */
  messages: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await ownConversation(ctx.db, input.conversationId, ctx.rbac.id);
      return ctx.db.assistantMessage.findMany({
        where: { conversationId: input.conversationId },
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          feedback: { select: { id: true, rating: true, flag: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
    }),

  create: protectedProcedure.mutation(async ({ ctx }) => {
    return ctx.db.assistantConversation.create({
      data: { userId: ctx.rbac.id },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }),

  rename: protectedProcedure
    .input(
      z.object({ conversationId: z.string().uuid(), title: z.string().trim().min(1).max(200) }),
    )
    .mutation(async ({ ctx, input }) => {
      await ownConversation(ctx.db, input.conversationId, ctx.rbac.id);
      return ctx.db.assistantConversation.update({
        where: { id: input.conversationId },
        data: { title: input.title },
        select: { id: true, title: true },
      });
    }),

  archive: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ownConversation(ctx.db, input.conversationId, ctx.rbac.id);
      return ctx.db.assistantConversation.update({
        where: { id: input.conversationId },
        data: { archivedAt: new Date() },
        select: { id: true },
      });
    }),

  /**
   * Rate an assistant turn, 1–5.
   *
   * Re-rating replaces the previous score rather than appending: somebody who scores a 2,
   * reads more carefully and scores a 4 has changed their mind, not given two opinions — and
   * a queue that counted both would report a satisfaction figure nobody holds.
   */
  rate: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const message = await ctx.db.assistantMessage.findFirst({
        where: {
          id: input.messageId,
          role: 'assistant',
          conversation: { userId: ctx.rbac.id },
        },
        select: { id: true, conversationId: true },
      });
      // Only an assistant turn can be rated, and only in your own conversation. Rating your
      // own question is meaningless; rating somebody else's is a disclosure.
      if (!message) throw new TRPCError({ code: 'NOT_FOUND' });

      const existing = await ctx.db.assistantFeedback.findFirst({
        where: { messageId: message.id, userId: ctx.rbac.id, flag: null },
        select: { id: true },
      });

      if (existing) {
        return ctx.db.assistantFeedback.update({
          where: { id: existing.id },
          data: {
            rating: input.rating,
            comment: input.comment ?? null,
            // A changed rating is new information: it goes back in the queue.
            status: 'PENDING',
            reviewedAt: null,
            reviewedBy: null,
          },
          select: { id: true, rating: true },
        });
      }

      return ctx.db.assistantFeedback.create({
        data: {
          conversationId: message.conversationId,
          messageId: message.id,
          userId: ctx.rbac.id,
          rating: input.rating,
          comment: input.comment ?? null,
        },
        select: { id: true, rating: true },
      });
    }),

  /**
   * The review queue — every rating and every flag the assistant raised about itself.
   *
   * These rows have been accumulating since C0 with nothing reading them, which is the worst
   * state for a feedback loop to be in: it looks like it is working. The queue is what turns
   * "the assistant answered badly" from a thing somebody mentions into a thing somebody fixes.
   *
   * **Server-side filtering on status and flag**, because the table grows with every turn and
   * the population has to be narrowed before rows reach a browser. The count reports the real
   * match, not the window — a queue that shows 200 of 5,000 without saying so reads as empty
   * when it is not.
   */
  reviewQueue: withPermission(P.admin.help.manage)
    .input(
      z.object({
        /** PENDING by default: the queue is a worklist, not an archive. */
        status: z.enum(['PENDING', 'REVIEWED', 'PROMOTED', 'DISMISSED']).nullable().optional(),
        /** OFF_TOPIC / NO_ANSWER_FOUND, or 'RATING' for the human-scored rows. */
        flag: z.string().max(32).nullable().optional(),
        limit: z.number().int().min(1).max(500).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.flag === 'RATING' ? { flag: null } : input.flag ? { flag: input.flag } : {}),
      };
      const [rows, totalCount, statusCounts] = await Promise.all([
        ctx.db.assistantFeedback.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          select: {
            id: true,
            rating: true,
            comment: true,
            flag: true,
            status: true,
            createdAt: true,
            reviewedAt: true,
            conversationId: true,
            messageId: true,
            userId: true,
            conversation: { select: { title: true } },
            // The person is named because a reviewer has to be able to follow up, and because
            // a pattern of one person's questions going unanswered is itself the finding.
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        }),
        ctx.db.assistantFeedback.count({ where }),
        ctx.db.assistantFeedback.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);

      return {
        rows,
        totalCount,
        statusCounts: statusCounts.map((s) => ({ status: s.status, count: s._count._all })),
      };
    }),

  /**
   * The turn behind one queue row: the question, the answer, and nothing else.
   *
   * **Tool results are excluded**, and that is not an oversight. A transcript carries whatever
   * the tools returned — somebody's report totals, an approver's name, a budget position — and
   * a reviewer holding `admin.help.manage` has no claim on any of it. What they need to judge
   * an answer is the question and the prose, which is exactly what `review.ts` already limits
   * the fast model to.
   */
  reviewTurn: withPermission(P.admin.help.manage)
    .input(z.object({ feedbackId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const feedback = await ctx.db.assistantFeedback.findUnique({
        where: { id: input.feedbackId },
        select: { conversationId: true, messageId: true },
      });
      if (!feedback) throw new TRPCError({ code: 'NOT_FOUND' });

      const answer = await ctx.db.assistantMessage.findUnique({
        where: { id: feedback.messageId },
        select: { id: true, createdAt: true, content: true },
      });
      if (!answer) throw new TRPCError({ code: 'NOT_FOUND' });

      // The question is the newest user message before the answer.
      const question = await ctx.db.assistantMessage.findFirst({
        where: {
          conversationId: feedback.conversationId,
          role: 'user',
          createdAt: { lt: answer.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        select: { content: true },
      });

      return { question: textOf(question?.content), answer: textOf(answer.content) };
    }),

  /**
   * Record what a reviewer decided.
   *
   * PROMOTED means "this belongs in the knowledge base" and is a claim about intent, not an
   * action: nothing is written to a corpus here, because promotion is a human act with a diff.
   * An auto-promoted wrong answer gets retrieved, reinforced and cited, and it compounds
   * silently — which is the whole reason this table has a status column rather than a boolean.
   */
  reviewDecide: withPermission(P.admin.help.manage)
    .input(
      z.object({
        feedbackId: z.string().uuid(),
        status: z.enum(['REVIEWED', 'PROMOTED', 'DISMISSED']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // updateMany rather than update: it reports 0 for a row that vanished instead of
      // throwing a Prisma error the UI would have to translate.
      const { count } = await ctx.db.assistantFeedback.updateMany({
        where: { id: input.feedbackId },
        data: {
          status: input.status,
          reviewedAt: new Date(),
          reviewedBy: ctx.rbac.id,
        },
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      return { ok: true as const };
    }),

  /**
   * Find guidance and read it — the knowledge pipeline behind one tool call.
   *
   * Three stages, and the shape of them is the design:
   *
   *   1. **Search the English corpus** with the terms the model supplied. It restated the need in
   *      English before calling, which is why there is no French index, no `unaccent` and no
   *      index-time translation anywhere in this feature: the corpus is English, the query is
   *      English, and only the ANSWER is in the person's language.
   *   2. **Read every candidate concurrently**, one fast-model call each, quoting the passages
   *      that bear on the need. Recall over precision is deliberate — an extra candidate costs a
   *      cheap call, a missed one costs the answer.
   *   3. **Return what was found**, per article, with slugs so the answer can cite them.
   *
   * Module-gated at the search, so an article about cards is invisible to a workspace with no
   * cards. `found` is reported separately from `extracts` because "nothing matched" and "matched
   * but nothing relevant" are different facts, and the model should be able to say which.
   */
  searchArticles: protectedProcedure
    .input(
      z.object({
        /** English search terms. Several surface forms help — the index has no stemmer. */
        terms: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
        /** One-sentence English restatement of what the person needs, for the extraction pass. */
        intent: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(10).default(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const anthropic = await resolveAnthropicConfig(ctx.db);
      if (!anthropic) return { extracts: [], searched: input.terms, found: 0 };
      const activeModules = [...(await activeModuleSlugs(ctx.db))];

      const hits = searchArticles(input.terms, { activeModules, limit: input.limit });
      if (hits.length === 0) return { extracts: [], searched: input.terms, found: 0 };

      // Re-resolved through the module gate rather than trusted from the hit: the search already
      // filtered, and doing it again costs nothing while removing any path where a slug reaches
      // the reader without passing it.
      const articles = hits
        .map((h) => articleBySlug(h.slug, activeModules))
        .filter((a): a is NonNullable<typeof a> => a !== null);

      const fastModel = resolveModels({
        ...process.env,
        ...(anthropic.assistantFastModel
          ? { ASSISTANT_FAST_MODEL: anthropic.assistantFastModel }
          : {}),
      }).fastModel;
      // VeloExpense (w6-03): every article read is a metered call (server/lib/assistantUsage.ts),
      // recorded once they have all returned, on this procedure's transaction.
      const usage = usageCollector(ctx.rbac.id);
      const extracts = await extractFromArticles(fastClient(anthropic.apiKey, usage.onMessage), fastModel, {
        articles,
        intent: input.intent,
      });
      await usage.flush(ctx.db);

      return { extracts, searched: input.terms, found: hits.length };
    }),
});

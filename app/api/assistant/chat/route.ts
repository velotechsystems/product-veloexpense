/**
 * The in-app chat endpoint — one turn, streamed.
 *
 * A thin transport, like `/api/mcp`. What it owns is the order things happen in:
 *
 *   auth → module + key → throttle → conversation → settle or record → run → persist → stream
 *
 * Two of those are load-bearing and easy to get backwards. **Settling before recording**: a
 * new message from somebody who had a proposal open is them walking away from it, and the
 * decline has to be written before their message, or the transcript says they asked a
 * follow-up while an action was still pending. **Persisting as the turn streams**: a turn
 * that dies halfway must leave a replayable transcript, not a tool call with no answer.
 *
 * VeloExpense (w6-03), the plumbing:
 *
 *   · **Who is asking** is read as every VeloExpense request reads it — the session names the
 *     tenant, and `resolveTenantMember` (the tRPC `tenant` middleware's own function) checks
 *     the host and reads the person's row, role and permissions from the database.
 *   · **No transaction is held while the model streams.** A turn runs for as long as the
 *     model and its tools take; a tenant transaction (30 s, one pooled connection) cannot sit
 *     open across it. So the turn runs statement-at-a-time in the caller's tenant
 *     (`withTenantStatements`): each read and write is its own tenant transaction, under RLS,
 *     and `persistMessage`'s message-plus-touch pair is one (`withTenantDb`).
 *   · **A tool call is a tRPC call.** The executor's context carries the caller, so every
 *     procedure a tool names runs the `tenant` middleware — its own tenant transaction, the
 *     member re-read, a refusal rolled back — exactly as a click does.
 *   · **Every model call is metered** as the `assistant` AI feature (server/lib/assistantUsage.ts).
 *   · The key is the environment's (`resolveAnthropicConfig`, d40), and the assistant is
 *     CORE (`server/platform/modules.ts`), so the module check always passes.
 */

import {
  ASSISTANT_MODULE_SLUG,
  attachmentNotice,
  checkGrounding,
  collectGuidance,
  MAX_ATTACHMENTS_PER_TURN,
  proposeTitle,
  resolveModels,
  reviewTurn,
  runTurn,
} from '@expenseos/assistant';
import { runWithDelegation } from '@expenseos/audit';
import { resolveAnthropicConfig } from '@expenseos/db';
import { jsonSafeReplacer, TOOLS, toolDefinitionsFor } from '@expenseos/mcp-server';
import { isModuleActive } from '@expenseos/platform';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { db, withTenantDb, withTenantStatements } from '@/lib/db/prisma';
import { hostTenantSlug } from '@/lib/tenant/request';
import { fastClient, streamingClient } from '@/server/lib/assistantClient';
import { classifyTurnFailure, describeTurnFailure } from '@/server/lib/assistantError';
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
} from '@/server/lib/assistantSession';
import { meterTurn } from '@/server/lib/assistantUsage';
import { makeExecutor } from '@/server/lib/mcpExecutor';
import { throttle } from '@/server/lib/rateLimit';
import { MODULE_DESCRIPTORS } from '@/server/platform/catalog';
import { type Context, resolveTenantMember } from '@/server/trpc';

export const dynamic = 'force-dynamic';

/**
 * Turns per hour, per person.
 *
 * Not an abuse control — the caller is an authenticated employee. It is a ceiling on a cost
 * nothing else in the product carries: every other action costs a query, and a turn costs a
 * model call plus whatever tools it decides to run.
 */
const TURNS_PER_HOUR = 40;

const bodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000).optional(),
  /** The `tool_use` id of a proposal being pressed. */
  confirm: z.string().min(1).optional(),
  /** The `tool_use` id of a proposal being turned down. */
  decline: z.string().min(1).optional(),
  screen: z
    .object({
      route: z.string().max(200),
      entityIds: z.record(z.string(), z.string().max(100)).optional(),
    })
    .optional(),
  /**
   * Files the person attached — described, never sent. The bytes go straight from their
   * browser to S3 after the press, so nothing here is large and nothing here is content.
   */
  attachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(120),
        sizeBytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(MAX_ATTACHMENTS_PER_TURN)
    .optional(),
  locale: z.enum(['en', 'fr-CA']).optional(),
});

const problem = (status: number, message: string) => Response.json({ message }, { status });

export async function POST(request: Request) {
  // VeloExpense (w6-03): the caller, as `createTRPCContext` reads one — the session's email and
  // tenant — then the member, as the `tenant` middleware resolves one: the host checked
  // against the tenant, the person's row, role and permissions read from the DATABASE (a token
  // outlives a demotion or a deactivation). ExpenseOS reads id and role off the session.
  const authSession = await auth();
  const email = authSession?.user?.email ?? null;
  const organizationId =
    (authSession?.user as { organizationId?: string } | undefined)?.organizationId ?? null;
  if (!email || !organizationId) return problem(401, 'Sign in first.');
  const caller = { email, organizationId };
  let member: Awaited<ReturnType<typeof resolveTenantMember>>;
  try {
    const hostSlug = await hostTenantSlug();
    member = await withTenantDb(organizationId, (tx) => resolveTenantMember(tx, caller, hostSlug));
  } catch (err) {
    // Not a member, deactivated, access off, or another tenant's address.
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') return problem(403, err.message);
    throw err;
  }
  const { session, rbac } = member;
  const userId = session.user.id;
  // VeloExpense (w6-03): everything from here runs in the caller's tenant, one statement at a
  // time — see the header.
  return withTenantStatements(organizationId, () =>
    turn({ request, session, rbac, caller, userId, organizationId }),
  );
}

/** VeloExpense (w6-03): ExpenseOS's `POST` from the credential check on, in the caller's tenant. */
async function turn({
  request,
  session,
  rbac: resolvedRbac,
  caller,
  userId,
  organizationId,
}: {
  request: Request;
  session: Awaited<ReturnType<typeof resolveTenantMember>>['session'];
  rbac: Awaited<ReturnType<typeof resolveTenantMember>>['rbac'];
  caller: { email: string; organizationId: string };
  userId: string;
  organizationId: string;
}): Promise<Response> {
  // Two different kinds of "not available", kept apart on purpose: a deployment with no
  // credential has nothing to offer, and an organisation that has not installed the module
  // has chosen not to have it. The credential comes from the `anthropic` integration, with
  // the environment as a fallback.
  // VeloExpense (w6-03): the environment only (d40), and the module is CORE, so here the
  // second check always passes; it stays so the order and the answers match ExpenseOS's.
  const anthropic = await resolveAnthropicConfig(db);
  if (!anthropic) return problem(503, 'The assistant is not configured.');
  if (!(await isModuleActive(db, ASSISTANT_MODULE_SLUG))) {
    return problem(404, 'The assistant module is not active.');
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return problem(400, 'Malformed request.');
  }
  // Attachments alone are a turn: dropping three receipts in without a word is a request,
  // and making somebody type "here" first would be pedantry.
  if (!body.message && !body.attachments?.length && !body.confirm && !body.decline) {
    return problem(400, 'Send a message, or confirm or decline a pending action.');
  }

  const limit = await throttle(`assistant:${userId}`, { max: TURNS_PER_HOUR, windowSec: 3600 });
  if (!limit.allowed) {
    return Response.json(
      { message: 'You have reached the hourly limit for assistant messages.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } },
    );
  }

  // VeloExpense (w6-03): resolved above, with the member.
  const rbac = resolvedRbac;
  if (!rbac) return problem(403, 'No role is resolved for this account.');

  let conversation: { id: string; title: string | null };
  try {
    conversation = await resolveConversation(db, userId, body.conversationId);
  } catch {
    return problem(404, 'No such conversation.');
  }

  const now = new Date();
  // Resolved before the confirm branch, not after it: the panel's own locale from
  // `useLocale()`, and the confirmed mutation below needs it too, so an amount in the chat
  // reads the same as the amount on the page behind it.
  const locale = body.locale ?? 'en';
  // VeloExpense (w6-03): `caller` too, so each procedure a tool names runs the `tenant`
  // middleware — its own transaction, the member re-read — as `createTRPCContext` arranges.
  const ctx = { session, db, rbac, caller } as unknown as Context;
  // VeloExpense (w6-03): every Messages API call this turn makes is metered.
  const meter = meterTurn({ organizationId, actorUserId: userId });
  let transcript = await loadTranscript(db, conversation.id);
  let confirmation: Awaited<ReturnType<typeof confirmProposal>> | null = null;

  if (body.confirm || body.decline) {
    const toolUseId = (body.confirm ?? body.decline) as string;
    // The mutation runs inside the delegation scope, so the audit row it writes records that
    // a model drafted it — inside the hash, without any `withAudit` call site knowing this
    // endpoint exists.
    confirmation = await runWithDelegation(
      { viaAssistant: { conversationId: conversation.id, toolUseId } },
      () =>
        confirmProposal({
          db,
          ctx,
          messages: transcript,
          toolUseId,
          decline: Boolean(body.decline),
          now,
          locale,
        }),
    );
    if (confirmation.status === 'refused' && confirmation.reason === 'no_pending') {
      return problem(409, 'That action is no longer awaiting confirmation.');
    }
    transcript = await loadTranscript(db, conversation.id);
  } else if (body.message || body.attachments?.length) {
    await abandonLiveProposal(db, transcript, now);
    // The notice is a second text block rather than appended to their words: what they typed
    // stays what they typed, and the file list is visibly ours. An empty text block is
    // rejected by the API, so a wordless attachment turn carries the notice alone.
    // VeloExpense (w6-03): the message and the conversation's touch, as one tenant transaction.
    await withTenantDb(organizationId, () =>
      persistMessage(db, conversation.id, 'user', [
        ...(body.message ? [{ type: 'text', text: body.message }] : []),
        ...(body.attachments?.length
          ? [{ type: 'text', text: attachmentNotice(body.attachments, body.locale ?? 'en') }]
          : []),
      ]),
    );
    transcript = await loadTranscript(db, conversation.id);
  }

  const caps = await capabilitiesFor(db, rbac.permissions);
  // The installation's overrides win over the environment's, so pinning a model is an
  // admin action rather than a redeploy.
  const models = resolveModels({
    ...process.env,
    ...(anthropic.assistantModel ? { ASSISTANT_MODEL: anthropic.assistantModel } : {}),
    ...(anthropic.assistantFastModel ? { ASSISTANT_FAST_MODEL: anthropic.assistantFastModel } : {}),
  });
  const system = systemPromptFor({
    caps,
    modules: moduleFactsFrom(MODULE_DESCRIPTORS, caps.activeModules),
    locale,
    actorName: session.user.name || session.user.email || '',
    screen: body.screen ?? null,
    now,
  });

  const conversationId = conversation.id;
  const hadTitle = Boolean(conversation.title);
  const question = body.message ?? '';
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * Somebody closing the panel is not a failure.
       *
       * When the reader goes away the controller closes under us, and every later
       * `enqueue` throws `Invalid state: Controller is already closed`. That throw landed
       * in the turn's own catch, which then tried to `send({ type: 'error' })` down the
       * same dead stream and threw again — so a person closing the drawer mid-answer
       * logged as `turn failed: reason=unknown name=TypeError`, indistinguishable in
       * CloudWatch from a genuine failure. It cost a real diagnosis once already.
       *
       * `gone` also stops the work: there is nobody to tell, and continuing to spend model
       * calls on an answer nobody will read is the other half of the waste.
       *
       * Serialised OUTSIDE that guard, and with the replacer every tool payload already
       * crosses the wire with: a `confirmation_result` carries the tool's own result, and
       * money in it is a `BigInt`. When the stringify sat inside the try, its throw was read
       * as "the reader left" — the stream went quiet after `open`, never sent `done`, and
       * never closed. A payload this code cannot serialise is a bug here, and should fail
       * loudly rather than impersonate a closed panel.
       */
      let gone = false;
      const send = (event: Record<string, unknown>) => {
        if (gone) return;
        const frame = encoder.encode(`data: ${JSON.stringify(event, jsonSafeReplacer)}\n\n`);
        try {
          controller.enqueue(frame);
        } catch {
          gone = true;
        }
      };

      send({ type: 'open', conversationId, title: conversation.title });
      if (confirmation) send({ type: 'confirmation_result', ...confirmation });

      let answer = '';
      let lastAssistantMessageId: string | null = null;
      /**
       * Every block this turn produced, so the guidance it was given can be recovered afterwards.
       *
       * Recovered from the turn's own blocks rather than re-searched: re-running the search to
       * check the answer would check a DIFFERENT search, and could flag an answer for missing
       * guidance it was never handed.
       */
      const turnBlocks: { content: unknown }[] = [];

      try {
        for await (const event of runTurn({
          client: streamingClient(anthropic.apiKey, meter),
          model: models.model,
          system,
          tools: toolDefinitionsFor(TOOLS, caps, 'chat') as never,
          specs: toolsFor(caps),
          history: transcript,
          execute: makeExecutor(ctx, locale),
          now: () => new Date(),
        })) {
          if (event.type === 'message') {
            turnBlocks.push({ content: event.content });
            const row = await withTenantDb(organizationId, () =>
              persistMessage(db, conversationId, event.role, event.content),
            );
            if (event.role === 'assistant') lastAssistantMessageId = row.id;
            continue;
          }
          if (event.type === 'text') answer += event.text;
          send(event);
        }
      } catch (error) {
        // The model's own message is never surfaced: it can carry request details, and a
        // stack trace in a chat transcript is a support ticket nobody can act on. What
        // goes out is a REASON from a closed set — the client owns the sentence, so it is
        // also in the right language — and the log gets the status and API type, because
        // it is the only place this is diagnosable at all.
        console.error(`[assistant.chat] turn failed: ${describeTurnFailure(error)}`);
        send({ type: 'error', reason: classifyTurnFailure(error) });
      }

      // Naming and reviewing the turn are the fast model's jobs, and neither is allowed to
      // fail the turn — both already swallow their own errors and return null.
      if (question && answer) {
        if (!hadTitle) {
          const title = await proposeTitle(fastClient(anthropic.apiKey, meter), models.fastModel, {
            question,
            answer,
          });
          if (title) {
            await db.assistantConversation.update({
              where: { id: conversationId },
              data: { title },
            });
            send({ type: 'title', title });
          }
        }
        // Two independent checks, and only one of them can be answered by the answer text alone.
        // Grounding needs the guidance too, so it runs on its own and wins when both fire: an
        // answer that invented product behaviour is a worse finding than one that was off topic.
        const [flag, ungrounded] = await Promise.all([
          reviewTurn(fastClient(anthropic.apiKey, meter), models.fastModel, { question, answer }),
          checkGrounding(fastClient(anthropic.apiKey, meter), models.fastModel, {
            question,
            answer,
            guidance: collectGuidance(turnBlocks),
          }),
        ]);
        const recorded = ungrounded ? 'UNSUPPORTED_CLAIM' : flag;
        if (recorded && lastAssistantMessageId) {
          // Not shown to the person. This is the queue that tells whoever maintains the
          // knowledge base which questions the product answered badly — and it fills up
          // whether or not anybody bothers to rate a turn.
          await db.assistantFeedback.create({
            data: {
              conversationId,
              messageId: lastAssistantMessageId,
              userId,
              flag: recorded,
              // The quoted sentence, so a reviewer sees WHAT was unsupported without reopening
              // the turn and rereading it against the guidance themselves.
              ...(ungrounded ? { comment: ungrounded.claim } : {}),
            },
          });
        }
      }

      send({ type: 'done' });
      // Closing an already-closed controller throws for the same reason `send` did.
      if (!gone) {
        try {
          controller.close();
        } catch {
          // The reader left between the last event and this line. Nothing to do.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // Without no-transform a proxy may buffer the whole stream and deliver it at the end,
      // which looks exactly like the model being slow.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

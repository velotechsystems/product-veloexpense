/**
 * VeloExpense (w6-03): the assistant's AI metering — one `ai_usage` row per Messages API call.
 *
 * Not from ExpenseOS, which meters nothing. The same table, rate table and `recordUsage` as
 * receipt reading (lib/ai/usage.ts, d43), with two differences that are the point:
 *
 *   · the feature is `assistant`, which is METERED — its rows are the ones the platform
 *     bills as AI credits. Receipt reading's are included in every plan and never are.
 *   · the actor is the person who asked, so a tenant's usage can be read per person.
 *
 * Nothing here refuses a call. The assistant is always on, and like receipt reading it runs
 * past any allowance; the platform owns the allowance and bills the overage.
 *
 * Two shapes, because a call is made in two kinds of place:
 *
 *   · `meterTurn` — the chat route, which holds no transaction while the model streams, so
 *     each call's row is written in a tenant transaction of its own as the call completes.
 *   · `usageCollector` — a tRPC procedure (`assistant.searchArticles`), which runs inside
 *     the request's tenant transaction and calls the model concurrently. Rows written from
 *     concurrent calls onto one transaction could not each have a savepoint, so they are
 *     collected and written together afterwards, under one savepoint: a failed usage write
 *     rolls back to it and never undoes the procedure.
 *
 * Token counts come from the response's own `usage`, and the request id is the response's
 * message id, so a row can be matched to Anthropic's own record of the call.
 */

import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { recordUsage, usageOf } from '@/lib/ai/usage';
import { type TenantDb, withTenantDb } from '@/lib/db/prisma';
import type { OnMessage } from '@/server/lib/assistantClient';

function rowFor(message: Anthropic.Message, actorUserId: string | null) {
  const usage = usageOf(message);
  if (!usage) return null;
  return {
    feature: 'assistant' as const,
    model: message.model,
    ...usage,
    requestId: typeof message.id === 'string' && message.id ? message.id : randomUUID(),
    actorUserId,
  };
}

/** For the chat route: each completed call is recorded at once, in its own tenant transaction. */
export function meterTurn(input: { organizationId: string; actorUserId: string }): OnMessage {
  return async (message) => {
    const row = rowFor(message, input.actorUserId);
    if (!row) return;
    await withTenantDb(input.organizationId, (tx) => recordUsage(tx, row));
  };
}

/** For a procedure: collect while the calls run, then `flush` on the procedure's transaction. */
export function usageCollector(actorUserId: string): {
  onMessage: OnMessage;
  flush: (db: TenantDb) => Promise<void>;
} {
  const messages: Anthropic.Message[] = [];
  return {
    onMessage: (message) => {
      messages.push(message);
    },
    flush: async (db) => {
      const rows = messages.map((m) => rowFor(m, actorUserId)).filter((r) => r !== null);
      if (rows.length === 0) return;
      await db.$executeRaw`SAVEPOINT assistant_usage`;
      try {
        for (const row of rows) await recordUsage(db, row);
        await db.$executeRaw`RELEASE SAVEPOINT assistant_usage`;
      } catch (err) {
        await db.$executeRaw`ROLLBACK TO SAVEPOINT assistant_usage`;
        console.error(
          `[assistant] failed to record AI usage for ${rows.length} call(s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

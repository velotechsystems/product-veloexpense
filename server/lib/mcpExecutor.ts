/**
 * Running a tool call.
 *
 * The rule this file exists to keep: **a tool never touches Prisma directly.** It names a
 * tRPC path, and the call goes through the real procedure with the acting person's own
 * context — so `withPermission`, `moduleActive`, the per-record access resolvers,
 * `withAudit`, the policy engine and the approval engine all run exactly as they do for a
 * click. There is no second definition of who may do what, because there is no second code
 * path.
 *
 * @expenseos/mcp-server owns the registry and the protocol and takes this as an injected
 * `Executor`, which is what keeps that package free of the database and the framework.
 */

import { randomUUID } from 'node:crypto';
import type { Locale } from '@expenseos/i18n';
import type { ExecOutcome, ToolSpec } from '@expenseos/mcp-server';
import { TRPCError } from '@trpc/server';
import { withMoneyDisplay } from '@/server/lib/toolMoney';
import { type Context, createCallerFactory } from '@/server/trpc';

/**
 * The root router is imported lazily, and it stays that way.
 *
 * Nothing in `appRouter` reaches this file today, so a top-level import would work — until
 * a future router does, at which point the cycle fails during `next build` page-data
 * collection as "Cannot access 'X' before initialization", naming neither file. That has
 * already happened once on this feature. The deferral costs nothing here because every
 * call site is async.
 */
async function getCaller(ctx: Context) {
  const { appRouter } = await import('@/server/routers/_app');
  return createCallerFactory(appRouter)(ctx);
}

/**
 * Walk the caller to the procedure a tool names.
 *
 * Only the LAST segment is type-checked. A tRPC caller returns proxies for the intermediate
 * routers and those report as `function`, not `object` — a `typeof === 'object'` guard here
 * rejects every path and reads at the call site as "that tool does not exist".
 */
function resolveProcedure(
  caller: unknown,
  path: string,
): ((input: unknown) => Promise<unknown>) | null {
  let node: unknown = caller;
  for (const segment of path.split('.')) {
    if (node == null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'function' ? (node as (input: unknown) => Promise<unknown>) : null;
}

/** Turn a thrown tRPC error into an outcome the model can read and adapt to. */
function toErrorOutcome(err: unknown): ExecOutcome {
  if (err instanceof TRPCError) {
    return { status: 'error', code: err.code, message: err.message };
  }
  // Anything else is a bug, not a refusal. Never hand the model a stack trace or a driver
  // message — it would end up in a transcript, and possibly in a support ticket.
  return { status: 'error', code: 'INTERNAL_SERVER_ERROR', message: 'The action failed.' };
}

/**
 * Build the executor the protocol layer calls.
 *
 * `locale` is a required argument, not an option with a default. It is the one thing here
 * the procedure cannot tell us — a tRPC resolver returns minor units and knows nothing
 * about who is reading them — and defaulting it would mean every French-Canadian reader
 * silently got English figures, where `10 799,00 $` renders as `$10,799.00` and the group
 * separator moves the apparent magnitude by three orders of magnitude. Making it required
 * means a new surface cannot forget it: the build fails instead.
 */
/**
 * Arguments the CALLER owns, filled in here rather than asked of the model.
 *
 * A Google Places `sessionToken` groups the keystrokes of one autocomplete session into a
 * single billable lookup. It is a fact about how the caller is querying, not a decision
 * anybody makes about the trip — so putting it in a tool schema would ask a model to
 * invent a uuid, and an invented uuid is either a rejected call or a meaningless billing
 * group. Leaving it out entirely is what actually happened: `search_travel_destinations`
 * shipped without it and answered BAD_REQUEST for every query, so the assistant could not
 * resolve a city and correctly refused to hand-build one.
 *
 * A fresh token per call is the right semantics here as well as the simplest: the
 * assistant makes one-shot searches rather than typing a character at a time.
 *
 * Filled at THIS boundary for the same reason `withMoneyDisplay` is — one place, rather
 * than a rule every future tool has to remember.
 */
const SERVER_SUPPLIED: Record<string, () => Record<string, unknown>> = {
  'travelRequests.searchDestinations': () => ({ sessionToken: randomUUID() }),
};

export function makeExecutor(ctx: Context, locale: Locale) {
  return async (spec: ToolSpec, input: unknown): Promise<ExecOutcome> => {
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        code: 'BAD_REQUEST',
        message: `Invalid input for ${spec.name}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      };
    }
    const args = { ...(parsed.data as object), ...(SERVER_SUPPLIED[spec.path]?.() ?? {}) };
    const procedure = resolveProcedure(await getCaller(ctx), spec.path);
    if (!procedure) {
      return { status: 'error', code: 'NOT_FOUND', message: `No procedure at ${spec.path}.` };
    }
    try {
      // Formatted HERE rather than in any procedure, because the defect was systemic: no
      // tool formatted money, so every tool that returns an amount handed the model bare
      // minor units. One boundary, ~25 tools fixed, and the raw values are all still there.
      //
      // A mileage route needs nothing here: the procedure already serves only the keys a
      // route may be stored with (`storedRoute` in `server/lib/mileageRouteView.ts`).
      return { status: 'ok', result: withMoneyDisplay(await procedure(args), locale) };
    } catch (err) {
      return toErrorOutcome(err);
    }
  };
}

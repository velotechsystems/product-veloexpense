import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Running a tool call.
 *
 * The rule this file exists to keep: **a tool never touches Prisma directly.** It names a
 * tRPC path and the call goes through the real procedure with the acting person's own
 * context, so `withPermission`, `moduleActive`, the access resolvers, `withAudit`, the
 * policy engine and the approval engine all run exactly as they do for a click. There is no
 * second definition of who may do what because there is no second code path — and these
 * tests are mostly about the ways that could quietly stop being true.
 *
 * Two of them have already happened on this feature:
 *
 *   · The root router is imported LAZILY. A top-level import works until some future
 *     router reaches back into this file, at which point `next build`'s page-data
 *     collection fails with "Cannot access 'X' before initialization" and names neither
 *     file.
 *   · Only the LAST path segment is type-checked. A tRPC caller returns proxies for the
 *     intermediate routers and those report as `function`, so a `typeof === 'object'`
 *     guard rejects every path — which reads at the call site as "that tool does not
 *     exist" for every tool at once.
 */

const h = vi.hoisted(() => ({
  caller: {} as Record<string, unknown>,
  contexts: [] as unknown[],
  importedRouter: 0,
}));

vi.mock('@/server/trpc', () => ({
  createCallerFactory: () => (ctx: unknown) => {
    h.contexts.push(ctx);
    return h.caller;
  },
}));
vi.mock('@/server/routers/_app', () => {
  h.importedRouter += 1;
  return { appRouter: {} };
});

import { TRPCError } from '@trpc/server';
import { makeExecutor } from './mcpExecutor';

/**
 * How many times the root router had been imported by the time this file finished loading.
 *
 * Read here, at module scope, because that is the only moment it can be read: the mock
 * factory runs on the first import of `_app` and its result is cached forever after, so a
 * counter checked inside a test would already have moved.
 */
const routerImportsAtLoad = h.importedRouter;

const ok = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
const spec = (over: Record<string, unknown> = {}) =>
  ({
    name: 'submit_expense_report',
    path: 'expenses.submitReport',
    input: ok,
    ...over,
  }) as never;

beforeEach(() => {
  h.caller = {};
  h.contexts = [];
});

describe('reaching the procedure', () => {
  it('calls the real tRPC procedure with the validated input', async () => {
    /** The whole authorization story: the procedure runs its own guards, so a tool cannot
     *  be a way around them. */
    const called: unknown[] = [];
    h.caller = {
      expenses: {
        submitReport: async (input: unknown) => {
          called.push(input);
          return { id: 'r-1' };
        },
      },
    };
    const exec = makeExecutor({ user: 'ctx' } as never, 'en');
    expect(await exec(spec(), { reportId: 'r-1' })).toEqual({
      status: 'ok',
      result: { id: 'r-1' },
    });
    expect(called[0]).toEqual({ reportId: 'r-1' });
  });

  it('fills in the arguments the caller owns rather than asking the model for them', async () => {
    /**
     * `travelRequests.searchDestinations` requires a Google Places `sessionToken`. It
     * groups the keystrokes of one autocomplete session into a single billable lookup —
     * a fact about how we are querying, not a decision anybody makes about the trip.
     *
     * The tool shipped without it and answered BAD_REQUEST for every query, so the
     * assistant could not resolve a city; it then correctly refused to hand-build one and
     * told the traveller to use the Travel page. Found by asking a real model for a trip,
     * not by any unit test — including this file, which is why the case is now here.
     */
    const called: unknown[] = [];
    h.caller = {
      travelRequests: {
        searchDestinations: async (input: unknown) => {
          called.push(input);
          return { available: true, items: [], error: null };
        },
      },
    };
    const exec = makeExecutor({ user: 'ctx' } as never, 'en');
    const out = await exec(
      spec({ name: 'search_travel_destinations', path: 'travelRequests.searchDestinations' }),
      { query: 'Toronto' },
    );
    expect(out.status).toBe('ok');
    const arg = called[0] as { query: string; sessionToken?: string };
    expect(arg.query).toBe('Toronto');
    expect(arg.sessionToken, 'the procedure requires one and the model never sees it').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('adds nothing to a tool that does not need it', async () => {
    // Narrow on purpose: one path, not a blanket that quietly reshapes every call.
    const called: unknown[] = [];
    h.caller = {
      expenses: {
        submitReport: async (i: unknown) => {
          called.push(i);
          return { id: 'r-1' };
        },
      },
    };
    const exec = makeExecutor({ user: 'ctx' } as never, 'en');
    await exec(spec(), { reportId: 'r-1' });
    expect(called[0]).toEqual({ reportId: 'r-1' });
  });

  it('builds the caller with the acting person’s own context', async () => {
    /** Not a service context. Everything downstream — permissions, record scoping, the
     *  audit actor — is derived from it. */
    h.caller = { expenses: { submitReport: async () => ({}) } };
    const ctx = { rbac: { id: 'u-1' } };
    await makeExecutor(ctx as never, 'en')(spec(), {});
    expect(h.contexts[0]).toBe(ctx);
  });

  it('walks a nested path, whose intermediate segments are router proxies', async () => {
    /**
     * The bug worth naming: intermediate nodes report as `function`, so a guard demanding
     * `object` on the way down rejects every path — and every tool then reports as
     * missing at once.
     */
    h.caller = {
      virtualCards: { transactions: { code: async () => ({ ok: true }) } },
    };
    const exec = makeExecutor({} as never, 'en');
    const out = await exec(spec({ path: 'virtualCards.transactions.code' }), {});
    expect(out).toEqual({ status: 'ok', result: { ok: true } });
  });

  it('reports a path that resolves to nothing', async () => {
    const exec = makeExecutor({} as never, 'en');
    expect(await exec(spec({ path: 'nope.missing' }), {})).toEqual({
      status: 'error',
      code: 'NOT_FOUND',
      message: 'No procedure at nope.missing.',
    });
  });

  it('reports a path that lands on a router rather than a procedure', async () => {
    /** `expenses` alone is not callable. Saying NOT_FOUND is better than a TypeError the
     *  model cannot interpret. */
    h.caller = { expenses: { submitReport: async () => ({}) } };
    const exec = makeExecutor({} as never, 'en');
    expect(await exec(spec({ path: 'expenses' }), {})).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('survives a path passing through a null node', async () => {
    h.caller = { expenses: null };
    const exec = makeExecutor({} as never, 'en');
    expect(await exec(spec({ path: 'expenses.submitReport' }), {})).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('imports the root router lazily, at call time', async () => {
    /**
     * A top-level import works until a router reaches back into this file, and then
     * `next build` fails with "Cannot access 'X' before initialization", naming neither
     * file. It has happened once already on this feature.
     */
    expect(routerImportsAtLoad).toBe(0);
    h.caller = { expenses: { submitReport: async () => ({}) } };
    await makeExecutor({} as never, 'en')(spec(), {});
    expect(h.importedRouter).toBeGreaterThan(0);
  });
});

describe('input validation', () => {
  it('refuses input the tool’s schema rejects, naming the fields', async () => {
    /** The model reads this and retries. "Invalid input" alone produces the same wrong
     *  call again. */
    const failing = {
      safeParse: () => ({
        success: false as const,
        error: {
          issues: [
            { path: ['amount'], message: 'must be a number' },
            { path: ['report', 'id'], message: 'is required' },
          ],
        },
      }),
    };
    const exec = makeExecutor({} as never, 'en');
    const out = await exec(spec({ input: failing }), {});
    expect(out).toMatchObject({ status: 'error', code: 'BAD_REQUEST' });
    expect((out as { message: string }).message).toContain('submit_expense_report');
    expect((out as { message: string }).message).toContain('amount must be a number');
    expect((out as { message: string }).message).toContain('report.id is required');
  });

  it('does not reach the procedure at all when input is invalid', async () => {
    const spy = vi.fn(async () => ({}));
    h.caller = { expenses: { submitReport: spy } };
    const failing = {
      safeParse: () => ({ success: false as const, error: { issues: [] } }),
    };
    await makeExecutor({} as never, 'en')(spec({ input: failing }), {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the PARSED data on, not the raw input', async () => {
    /** Coercions and defaults from the schema are part of the contract the procedure was
     *  written against. */
    const coercing = {
      safeParse: () => ({ success: true as const, data: { amount: 100 } }),
    };
    const seen: unknown[] = [];
    h.caller = {
      expenses: {
        submitReport: async (input: unknown) => {
          seen.push(input);
          return {};
        },
      },
    };
    await makeExecutor({} as never, 'en')(spec({ input: coercing }), { amount: '100' });
    expect(seen[0]).toEqual({ amount: 100 });
  });
});

describe('when the procedure throws', () => {
  it('passes a tRPC refusal through with its code and message', async () => {
    /** A refusal is information: FORBIDDEN, or "that report is already submitted", is what
     *  lets the model do something else instead of repeating itself. */
    h.caller = {
      expenses: {
        submitReport: async () => {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your report.' });
        },
      },
    };
    expect(await makeExecutor({} as never, 'en')(spec(), {})).toEqual({
      status: 'error',
      code: 'FORBIDDEN',
      message: 'Not your report.',
    });
  });

  it('hides anything that is not a refusal behind a flat message', async () => {
    /**
     * A stack trace or a driver message would end up in a transcript, and possibly in a
     * support ticket. A bug is not something to describe to the model in detail.
     */
    h.caller = {
      expenses: {
        submitReport: async () => {
          throw new Error('connect ECONNREFUSED 10.0.1.5:5432');
        },
      },
    };
    const out = await makeExecutor({} as never, 'en')(spec(), {});
    expect(out).toEqual({
      status: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The action failed.',
    });
    expect(JSON.stringify(out)).not.toContain('10.0.1.5');
  });

  it('never rejects — the outcome is always something the model can read', async () => {
    h.caller = {
      expenses: {
        submitReport: async () => {
          throw 'a bare string';
        },
      },
    };
    await expect(makeExecutor({} as never, 'en')(spec(), {})).resolves.toMatchObject({
      status: 'error',
    });
  });
});

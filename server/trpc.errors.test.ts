import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * What a server error is allowed to say to the person who caused it.
 *
 * Two things reached the screen verbatim on DEV (GA readiness report F05, blocker B8):
 * a full `Invalid prisma.expenseLineItem.update() invocation … out of range for type
 * bigint`, naming the ORM, the model and the column type; and a raw Zod issue array
 * rendered as JSON. Both are information disclosure, and neither is usable by the reader.
 *
 * The line this suite defends is between an error a resolver wrote ON PURPOSE and one
 * that escaped. Deliberate refusals are how every guard in this codebase speaks to the
 * user — "Add at least one expense before submitting." — and laundering those into
 * "something went wrong" would be a worse product than the leak.
 */

// VeloExpense: the session comes from `@/auth` (ExpenseOS: `@/server/auth`). next-auth's
// runtime cannot load under vitest, so it is mocked here exactly as ExpenseOS mocks its own.
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@expenseos/rbac/server', () => ({ resolveRbacUser: vi.fn() }));

const { publicProcedure, router } = await import('./trpc');
const { REFUSAL_KEYS, refusal } = await import('./refusal');
const { fetchRequestHandler } = await import('@trpc/server/adapters/fetch');

/**
 * Through the REAL HTTP boundary, because that is the only place `errorFormatter` runs.
 *
 * A server-side `createCaller` rethrows the raw `TRPCError` untouched and never reaches
 * the formatter — so a test written against a caller would have asserted nothing about
 * what a browser actually receives, and passed regardless of the fix.
 */
async function errorFrom(path: string, input?: unknown) {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(`http://test/api/trpc/${path}${qs}`),
    router: appRouter,
    createContext: () => ({ session: null, db: {}, rbac: null }) as never,
  });
  // superjson wraps the payload as `{ error: { json: … } }`; without a transformer it is
  // `{ error: … }` directly. Read both, so this asserts on the message the browser gets
  // rather than on a serialization detail.
  type Shape = { message?: string; data?: { refusal?: unknown } };
  const body = (await res.json()) as { error: Shape & { json?: Shape } };
  const shape = body.error.json ?? body.error;
  return { message: shape.message ?? '', refusal: shape.data?.refusal ?? null };
}

const appRouter = router({
  prismaLeak: publicProcedure.query(() => {
    throw new Error(
      'Invalid `prisma.expenseLineItem.update()` invocation: Value out of range for the ' +
        'type: value "100000000000000000" is out of range for type bigint',
    );
  }),
  deliberate: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Add at least one expense before submitting.',
    });
  }),
  validated: publicProcedure.input(z.object({ sizeBytes: z.number().min(1) })).query(() => 'ok'),
  /** A guard written the way dozens in this codebase are: a code, and no message. */
  codeOnly: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }),
  /** A refusal that also names the catalog key the browser should render. */
  translatable: publicProcedure.query(() => {
    throw refusal('BAD_REQUEST', REFUSAL_KEYS.fxRateOutOfBounds, 'Rate must be…', {
      max: 1_000_000,
    });
  }),
});

/**
 * VeloExpense: ExpenseOS imports the real `ReportTotalFrozenError` from `@expenseos/db`. That
 * class arrives with the expense core (Wave 2). The middleware under test recognises it by
 * `name`, not `instanceof` — ExpenseOS's own rule, because mocked module boundaries split
 * constructors — so a stand-in with the same name and message shape tests the same mapping.
 * Replace it with the real import when `reportTotal` is ported.
 */
class ReportTotalFrozenError extends Error {
  override readonly name = 'ReportTotalFrozenError' as const;
  constructor(
    readonly reportId: string,
    readonly status: string,
    readonly syncStatus: string | null,
  ) {
    super(
      `The report total cannot be recomputed: the report is ${status}. Once decided, ` +
        'its amounts are what was approved, rejected or paid.',
    );
  }
}

afterEach(() => vi.restoreAllMocks());

describe('what a server error tells the user', () => {
  it('never repeats an ORM message, however it was thrown', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await errorFrom('prismaLeak');

    const shown = err.message;
    expect(shown).not.toMatch(/prisma/i);
    expect(shown).not.toMatch(/bigint/i);
    expect(shown).not.toMatch(/expenseLineItem/);
    expect(shown).toMatch(/went wrong/i);

    // …and the detail is not lost, it is just not public.
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[1] ?? '')).toMatch(/prisma/i);
  });

  it('leaves a refusal a resolver wrote on purpose exactly as written', async () => {
    const err = await errorFrom('deliberate');
    const shown = err.message;
    expect(shown).toBe('Add at least one expense before submitting.');
  });

  it('does not answer a guard with the bare word FORBIDDEN', async () => {
    /**
     * GA audit v2, V2-14. Submitting another employee's draft produced a red banner
     * containing exactly one word: FORBIDDEN.
     *
     * That is not a message anybody wrote. `TRPCError` defaults `message` to the CODE
     * when none is given, and dozens of guards in this codebase are written
     * `throw new TRPCError({ code: 'NOT_FOUND' })` — so every one of them renders its
     * own status word at the user. `safeMessage` waves them through because it cannot
     * tell "a refusal somebody phrased" from "the code, echoed".
     *
     * It is also untranslatable: an HTTP status word never enters the message catalogue,
     * so a French user sees the English token no matter how much translation work is
     * done (V2-23). Fixing the class is the only version of the fix that closes that.
     */
    const err = await errorFrom('codeOnly');
    expect(err.message).not.toBe('FORBIDDEN');
    // Something a reader can act on, and long enough to be a sentence rather than a token.
    expect(err.message.length).toBeGreaterThan('FORBIDDEN'.length);
    expect(err.message).toMatch(/permission|allowed/i);
  });

  it('says nothing about what was "sent" — that is transport vocabulary', async () => {
    /**
     * "Some of the values sent were not valid" (V2-04). `sent` describes the request,
     * which is the app's business and not the reader's; they filled in a form.
     */
    const err = await errorFrom('validated', { sizeBytes: 0 });
    expect(err.message).not.toMatch(/\bsent\b/i);
  });

  it('hands the browser the catalog key of a translatable refusal, beside the message', async () => {
    /**
     * The message is kept — it is what the log shows and what an older surface renders —
     * and `data.refusal` is added, which is what a translated surface renders instead.
     */
    const err = await errorFrom('translatable');
    expect(err.message).toBe('Rate must be…');
    expect(err.refusal).toEqual({ key: 'refusals.fx.rateOutOfBounds', params: { max: 1_000_000 } });
  });

  it('marks every other error as carrying no refusal, explicitly', async () => {
    // `null`, not absent: a client can test `data.refusal` without a type guard.
    const err = await errorFrom('deliberate');
    expect(err.refusal).toBeNull();
  });

  it('replaces a raw Zod payload with something a person can act on', async () => {
    const err = await errorFrom('validated', { sizeBytes: 0 });
    const shown = err.message;
    // The reported symptom: `[{"origin":"number","code":"too_small",…}]` on screen.
    expect(shown).not.toMatch(/\[?\{"/);
    expect(shown).not.toMatch(/too_small/);
    expect(shown).toMatch(/not valid/i);
  });
});

describe('a frozen report total', () => {
  /**
   * `recomputeReportTotal` (packages/db) throws a typed `ReportTotalFrozenError` when a
   * decided or NetSuite-posted report's total would be rewritten. The package cannot
   * speak tRPC. Left unmapped, that refusal would arrive as INTERNAL_SERVER_ERROR: logged
   * as a crash and shown as "something went wrong", when it is a precondition the reader
   * can act on. The base procedure translates it, so every router gets it for free.
   */
  it("is PRECONDITION_FAILED with the guard's own words, not a 500", async () => {
    const { createCallerFactory } = await import('./trpc');
    const frozenRouter = router({
      recompute: publicProcedure.mutation(() => {
        throw new ReportTotalFrozenError('r-1', 'APPROVED', null);
      }),
    });
    const caller = createCallerFactory(frozenRouter)({
      session: null,
      db: {},
      rbac: null,
    } as never);
    const err = await caller.recompute().catch((e: unknown) => e as TRPCError);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((err as TRPCError).message).toMatch(/APPROVED/);
    expect((err as TRPCError).cause).toBeInstanceOf(ReportTotalFrozenError);
  });

  it('reaches the browser as the same message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frozenRouter = router({
      recompute: publicProcedure.query(() => {
        throw new ReportTotalFrozenError('r-1', 'REIMBURSED', null);
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://test/api/trpc/recompute'),
      router: frozenRouter,
      createContext: () => ({ session: null, db: {}, rbac: null }) as never,
    });
    const body = (await res.json()) as {
      error: { message?: string; json?: { message?: string; data?: { code?: string } } };
    };
    expect(body.error.json?.data?.code ?? '').toBe('PRECONDITION_FAILED');
    expect(body.error.json?.message ?? body.error.message).toMatch(/REIMBURSED/);
    // Not a crash: nothing was logged as an unhandled error.
    expect(spy).not.toHaveBeenCalled();
  });
});
